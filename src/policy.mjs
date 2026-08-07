// Every rule that decides WHEN the mic is open, WHEN the agent may report a decision, and
// WHAT that decision means — with no audio, no network and no timers of its own.
//
// It lives apart from realtime.mjs on purpose: this is the part that kept getting the run
// wrong (agent talking over the user, agent answering for the user, wrong option picked), and
// a rule you cannot run 200 times in a second is a rule you are only guessing about. Give it
// a `now` and it is fully deterministic — see test/policy.test.mjs.

// The model likes to squeeze every answer into `choice`, even when the user asked for
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
// session it did not hear words, it hallucinated them out of noise — and the agent then reports
// a decision built on that. `"정답."` came back for a turn the user never meant as an answer.
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

// Spoken ways of naming an option by position, in the languages the agent supports. Only the
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

// The position the user named out loud, or null if they didn't name one. When they DID, it is
// the most reliable thing in the whole call — far more so than which option text the model
// decided that meant.
export function spokenOptionIndexes(text) {
  const t = (text || "").trim();
  if (!t) return [];
  const hits = new Set();
  for (const [re, n] of ORDINALS) if (re.test(t)) hits.add(n);
  return [...hits].sort();
}

export function spokenOptionIndex(text) {
  const hits = spokenOptionIndexes(text);
  // "the first or the second?" — they named two, so they named none.
  return hits.length === 1 ? hits[0] : null;
}

// Half-duplex turn taking + the "did the user actually answer?" gate.
//
// `playingUntil` is a function returning the epoch-ms at which the audio written to the
// speaker will have finished being HEARD. The model streams a whole reply in about a second
// while it plays for fifteen, so nothing here may key off the arrival of audio events.
export function createTurnState({
  halfDuplex = true,
  micReopenMs = 600,
  openingGraceMs = 3000,
  // How much speech the API must have committed before a decision is believable. The wrong
  // option was reported off 0.2s of audio — barely the word "la". Below this we make the
  // agent ask again instead of guessing.
  minAnswerMs = 600,
  // Language the user is expected to speak, ISO-639-1 — used to spot a hallucinated transcript.
  langCode = null,
  now = () => Date.now(),
} = {}) {
  let responding = false;
  let transcript = null; // of the latest committed turn; null = not transcribed yet
  const muteUntil = halfDuplex ? now() + openingGraceMs : 0;
  let turns = 0;
  let heardMs = 0;
  // The cue itself is audio, so playing it re-mutes the mic; without arming it once per model
  // turn the cue would retrigger on its own tail, forever.
  let cueArmed = false;

  const state = {
    // --- transport events ---
    responseCreated() {
      responding = true;
      cueArmed = true;
    },
    responseDone() {
      responding = false;
    },
    // The API committed a user turn: it heard a whole utterance, `ms` long. Its transcript
    // arrives separately, a fraction of a second later — and the model regularly calls
    // submit_decision before it does.
    userSpoke(ms = 0) {
      turns++;
      heardMs += ms;
      transcript = null;
    },
    setTranscript(text) {
      transcript = text ?? "";
    },
    get transcript() {
      return transcript;
    },
    get transcribed() {
      return transcript !== null;
    },

    get turns() {
      return turns;
    },
    get heardMs() {
      return heardMs;
    },

    // --- mic gating ---
    muted(playingUntil = 0) {
      if (!halfDuplex) return false;
      const t = now();
      // Mute for the WHOLE model turn: from response.created until response.done AND the
      // audio has finished playing. "Nothing queued right now" does not mean "it stopped
      // talking" — the model streams in bursts, and re-opening in a gap made the agent hear
      // itself, interrupt itself and start over.
      return t < muteUntil || responding || t < playingUntil + micReopenMs;
    },
    // "Your turn" cue: true at most ONCE per model turn, the first time the mic is open after
    // that turn. The user cannot see the terminal, so this beep is the only thing telling them
    // the agent has stopped and is listening.
    //
    // Armed by response.created rather than detected as a muted->open edge: the caller only
    // polls this while the mic is open (it lives past the mute check in the audio loop), so an
    // edge would never be observed. Arming also stops the cue from retriggering on its own
    // tail — the cue is audio, so playing it re-mutes the mic.
    micJustOpened(playingUntil = 0) {
      if (!cueArmed || state.muted(playingUntil)) return false;
      cueArmed = false;
      return true;
    },

    // --- the hard gate in front of submit_decision ---
    // The agent must never report a decision the user did not give. Instructions alone did not
    // hold: it reported an option after 0.2s of audio, and once after none at all.
    canSubmit({ kind, optionIndex } = {}) {
      if (turns === 0) return { ok: false, reason: "the user has not said anything yet" };
      if (heardMs < minAnswerMs)
        return { ok: false, reason: "you only heard a fragment, not an answer" };
      // An empty or wrong-script transcript means the turn was noise the transcriber turned
      // into words. Reporting a decision off it is how "open a pull request" got sent back for
      // a turn that transcribed as "정답." in an Italian call.
      if (transcript !== null && looksGarbled(transcript, langCode))
        return {
          ok: false,
          reason: `what you heard did not transcribe as ${langCode || "speech"} (${JSON.stringify(
            (transcript || "").slice(0, 40),
          )})`,
        };
      // The user named a position and the model reported a different one. This is the failure
      // that started all of this ("ho detto la prima e ha fatto la terza") and it is the one
      // case where we can catch it outright: two independent sources disagree, so neither is
      // acted on — the agent has to ask.
      // Nobody answers by naming three options at once. Two things produce that transcript,
      // and neither is a decision: the user weighing them out loud ("la prima o la seconda?"),
      // or the transcriber echoing back the vocabulary hint we gave it when the audio was too
      // short to make out — which is exactly what came back as
      // "la prima, la seconda, la terza, la quarta, sì, no, aspetta, ripeti." and got reported
      // to Claude as option 2.
      const named = spokenOptionIndexes(transcript);
      if (kind === "choice" && named.length > 1)
        return { ok: false, reason: `you heard ${named.length} different options named, not an answer` };

      const spoken = spokenOptionIndex(transcript);
      if (kind === "choice" && spoken !== null && Number.isInteger(optionIndex) && spoken !== optionIndex)
        return {
          ok: false,
          reason: `the user said option ${spoken}, you reported option ${optionIndex}`,
          spoken,
        };
      return { ok: true };
    },
  };
  return state;
}
