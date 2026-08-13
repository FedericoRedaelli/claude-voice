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

// Everything below this line used to be a second opinion made of regular expressions:
// ordinals in six languages, plus a word-overlap score between what you said and what the
// option said. It is gone, and its absence is the point.
//
// A list of words is a list of the languages somebody thought of. "die zweite Möglichkeit"
// was not on it; neither was any way of picking an option that does not name its position.
// The file that owns the routing model opens by saying exactly this — that routing on words
// in the source code ships a product that only works for the people whose words are in there.
// The check that stood in front of the most expensive decision was doing it anyway.
//
// The second reading now comes from a fresh model call that never sees the first one's
// verdict (brain.confirmChoice). It is in src/brain/openrouter.mjs; call.mjs is where the two
// have to agree.
