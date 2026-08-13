// The rules that decide WHAT Claude is told, with no audio, no network and no timers. This
// is the part that kept getting the run wrong — the agent answering for the user, the wrong
// option picked — and a rule you cannot run 200 times in a second is a rule you are only
// guessing about. See test/policy.test.mjs.

// The brain likes to squeeze every answer into `choice`, even when the user asked for
// something the options don't cover ("do the first one but keep the second's naming"). Claude
// then acts on an option the user never picked. So a `choice` only survives if it really maps
// to one of the offered options; anything else is downgraded to a free `message`, which Claude
// reads as an instruction. `end` never carries a value.
export function normalizeDecision({ kind, value, optionIndex }, options = [], log = () => {}) {
  if (kind === "end") return { kind: "end" };
  const text = (value || "").trim();
  if (kind !== "choice") return { kind: "message", value: text };

  // A reported position wins over reported text: it's the one thing the model can't garble.
  if (Number.isInteger(optionIndex) && optionIndex >= 1 && optionIndex <= options.length) {
    return { kind: "choice", value: options[optionIndex - 1] };
  }

  const norm = (s) => s.trim().toLowerCase().replace(/[.!?]+$/, "");
  const exact = options.find((o) => norm(o) === norm(text));
  if (exact) return { kind: "choice", value: exact };
  // "option 2" / "2" — the model sometimes answers with the index we numbered for it.
  const asIndex = Number(text.match(/^(?:option\s*)?(\d+)$/i)?.[1]);
  if (asIndex >= 1 && asIndex <= options.length) return { kind: "choice", value: options[asIndex - 1] };

  log(`choice ${JSON.stringify(text)} matches no option -> reporting as message`);
  return { kind: "message", value: text };
}

// Languages written in the Latin alphabet. When the transcriber returns Korean for an Italian
// session it did not hear words, it hallucinated them out of noise — and a decision then gets
// built on that. `"정답."` came back for a turn the user never meant as an answer.
const LATIN = new Set(["en", "it", "es", "fr", "de", "pt", "nl"]);

// True when a transcript cannot plausibly be what the user said in `langCode`. Deliberately
// crude: it only catches the wrong-script case, which is the one that actually happens.
export function looksGarbled(text, langCode) {
  const t = (text || "").trim();
  if (!t) return true;
  if (!langCode || !LATIN.has(langCode)) return false;
  const letters = [...t].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return true; // punctuation only
  const latin = letters.filter((c) => /\p{Script=Latin}/u.test(c)).length;
  return latin / letters.length < 0.7;
}

// Spoken ways of naming an option by position, in the languages this supports. Only the
// unambiguous ones: "un attimo" is not option one, so "un"/"one" alone stay out.
const ORDINALS = [
  [/\b(prim[ao]|first|primer[ao]|premi[eè]re?|erste[rn]?|primeir[ao])\b/i, 1],
  [/\b(second[ao]|second|segund[ao]|deuxi[eè]me|zweite[rn]?|segundo)\b/i, 2],
  [/\b(terz[ao]|third|tercer[ao]|troisi[eè]me|dritte[rn]?|terceir[ao])\b/i, 3],
  [/\b(quart[ao]|fourth|cuart[ao]|quatri[eè]me|vierte[rn]?)\b/i, 4],
  [/\b(numero\s*1|option\s*1|opzione\s*1)\b/i, 1],
  [/\b(numero\s*2|option\s*2|opzione\s*2)\b/i, 2],
  [/\b(numero\s*3|option\s*3|opzione\s*3)\b/i, 3],
  [/\b(numero\s*4|option\s*4|opzione\s*4)\b/i, 4],
];

// Every position named in the transcript. Nobody answers by naming three options at once, so
// more than one hit means they were weighing them out loud, not choosing.
export function spokenOptionIndexes(text) {
  const t = (text || "").trim();
  if (!t) return [];
  const hits = new Set();
  for (const [re, n] of ORDINALS) if (re.test(t)) hits.add(n);
  return [...hits].sort();
}

// The position the user named out loud, or null if they didn't name exactly one. When they
// DID, it is the most reliable thing in the whole call — far more so than which option text
// the model decided that meant.
export function spokenOptionIndex(text) {
  const hits = spokenOptionIndexes(text);
  // "the first or the second?" — they named two, so they named none.
  return hits.length === 1 ? hits[0] : null;
}

// Words that carry meaning, for comparing what was said against what an option says. Short
// tokens are dropped because "di", "la", "e" match everything and would corroborate anything.
const STOP = new Set([
  "della", "delle", "dello", "degli", "quella", "quello", "questa", "questo", "come", "sono",
  "with", "that", "this", "from", "into", "then", "than", "have", "will", "your", "solo",
  "anche", "senza", "sulla", "sullo", "essere", "fare", "cosa", "molto", "dove", "when",
]);

const contentWords = (s) =>
  [...String(s || "").toLowerCase().matchAll(/\p{L}{4,}/gu)].map((m) => m[0]).filter((w) => !STOP.has(w));

// How much of an option's own wording the user actually echoed, 0 to 1. Not fuzzy matching:
// just "did they say any of the words this option is made of".
export function optionEcho(transcript, option) {
  const want = new Set(contentWords(option));
  if (!want.size) return 0;
  const said = new Set(contentWords(transcript));
  let hit = 0;
  for (const w of want) if (said.has(w)) hit++;
  return hit / want.size;
}

// A choice needs POSITIVE evidence, not merely the absence of a contradiction.
//
// choiceDisagreement below only fires when the user named a position and the brain named a
// different one. When the user named NO position it returned null — via libera — and a brain
// that had invented an option got its way. That is not a hypothetical: asked to pick between
// four approaches, the user answered "per il momento direi che evitiamo questa cosa
// dell'injection del prompt, facciamo il resto" — a refusal, naming nothing — and the call
// reported choice 1, the very thing being refused. The user's words were sitting right there
// in the transcript, unused.
//
// So a choice survives only if the transcript names its position, or repeats enough of the
// option's own words to be recognisably about it. Everything else is downgraded to `message`,
// which hands Claude the sentence verbatim and lets it decide — the outcome that would have
// been right in every case we have seen this fail.
//
// Returns null when the choice is corroborated, or a reason to downgrade it.
export function choiceUncorroborated(decision, transcript, options = [], minEcho = 0.34) {
  if (decision?.kind !== "choice") return null;
  const named = spokenOptionIndexes(transcript);
  if (named.length === 1 && named[0] === decision.optionIndex) return null;
  if (named.length) return null; // a real clash — choiceDisagreement owns that case

  const option = Number.isInteger(decision.optionIndex) ? options[decision.optionIndex - 1] : decision.value;
  const echo = optionEcho(transcript, option);
  if (echo >= minEcho) return null;
  return `nothing in what you said names or repeats that option (echo ${echo.toFixed(2)})`;
}

// The last gate in front of a choice: two independent sources have to agree.
//
// The transcript is what the user actually said; `optionIndex` is what the brain decided that
// meant. When the transcript names one position and the brain names a different one, neither
// is acted on — this is the failure the whole project started from ("ho detto la prima e ha
// fatto la terza"), and it is the one case we can catch outright.
//
// Returns null when the choice is safe, or a reason to read back and ask again.
export function choiceDisagreement(decision, transcript) {
  if (decision?.kind !== "choice") return null;
  const named = spokenOptionIndexes(transcript);
  if (named.length > 1) return `you named ${named.length} options, not one`;
  const spoken = named[0] ?? null;
  if (spoken === null || !Number.isInteger(decision.optionIndex)) return null;
  return spoken === decision.optionIndex
    ? null
    : `you said option ${spoken}, the model reported option ${decision.optionIndex}`;
}
