// Env-driven configuration. Every knob has a safe default so the text-mode loop runs with
// zero setup; only voice mode needs OPENROUTER_API_KEY and a browser.

import { loadEnvFile } from "./env.mjs";

// Persisted settings (plugin-root/.env) fill in anything not exported in the shell.
loadEnvFile();

const bool = (v) => v === "1" || v === "true" || v === "yes";

// VOICE_LANG is a human-readable name (it steers the spoken output); the transcriber wants an
// ISO-639-1 code. Map the languages worth naming; anything else = auto-detect.
const LANG_CODES = {
  english: "en",
  italian: "it",
  italiano: "it",
  spanish: "es",
  español: "es",
  french: "fr",
  français: "fr",
  german: "de",
  deutsch: "de",
  portuguese: "pt",
  português: "pt",
  dutch: "nl",
  japanese: "ja",
  chinese: "zh",
};

export const config = {
  // "voice" (the browser page plus the three models) or "text" (terminal stdin, no deps).
  mode: process.env.VOICE_MODE === "text" ? "text" : "voice",

  // One key covers transcription, synthesis and reasoning. That is the entire reason this
  // provider was chosen over three better-at-one-thing ones.
  openrouterKey: process.env.OPENROUTER_API_KEY || "",
  baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",

  // Which implementation fills each slot. The registry in modules.mjs turns these names into
  // dynamic imports, so a future local engine is a value here and nothing else.
  //
  // Only "browser" exists for audio today: the page's own echo canceller is what makes
  // barge-in work on open speakers. A headless implementation is the obvious next slot.
  audio: process.env.VOICE_AUDIO || "browser",
  tts: process.env.VOICE_TTS || "openrouter",
  stt: process.env.VOICE_STT || "openrouter",
  brain: process.env.VOICE_BRAIN || "openrouter",

  ttsModel: process.env.VOICE_TTS_MODEL || "microsoft/mai-voice-2-flash",
  // MAI-Voice-2-Flash ships four voices and none of them is Italian (verified: it-IT-* is a
  // 502). The model is multilingual, so Harper reads Italian with an English accent. If that
  // grates, VOICE_TTS_MODEL points at a model with a native Italian voice — same key, same
  // interface.
  ttsVoice: process.env.VOICE_TTS_VOICE || "en-US-Harper:MAI-Voice-2",
  sttModel: process.env.VOICE_STT_MODEL || "openai/whisper-large-v3-turbo",
  // The 120b, not the 20b, and the reason is one sentence long: on "fai la prima ma prima
  // mostrami il diff" — an option named, with a condition the options do not cover — the 20b
  // answers `choice` three times out of three, and once the second reading agreed with it,
  // which is the path that reaches Claude as a decision the user never made. The 120b answers
  // `message` three out of three. On the plain cases they tie. See scripts/brain-bakeoff.mjs.
  //
  // It is not a trade: routing latency measured the same (287 ms median for both), input costs
  // the same, and the output is a thirty-token JSON object, so the higher output rate works out
  // to a few millionths of a dollar per call.
  brainModel: process.env.VOICE_BRAIN_MODEL || "openai/gpt-oss-120b",

  // How OpenRouter picks which provider serves the brain. Left to itself it spreads the same
  // model across providers that differ by more than an order of magnitude — measured on
  // gpt-oss-20b, which was the default then: 0.3-0.5 s on the fastest, 3-6 s typical, and one
  // turn that took 20.6 s. In a
  // conversation that gap is the difference between an answer and an awkward silence, so we
  // ask for throughput by name. Set VOICE_BRAIN_SORT="" to hand the choice back.
  brainSort: process.env.VOICE_BRAIN_SORT === undefined ? "throughput" : process.env.VOICE_BRAIN_SORT,

  // Pin the brain to named providers instead (comma-separated slugs, e.g. "amazon-bedrock").
  // Overrides the sort. Empty = let the sort decide.
  //
  // Advertised throughput is the wrong number to pick on: our answer is a thirty-token JSON
  // object, so the time is prefill and queueing, not generation. Measured on this model,
  // Amazon Bedrock at 295 TPS answered in 499 ms median and Groq at 160 TPS in 264 ms.
  brainProviders: (process.env.VOICE_BRAIN_PROVIDER || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // Ask the brain for a JSON object rather than free text. Not a formality: GPT-OSS splits its
  // output into a reasoning channel and a final one, and without this the final channel came
  // back EMPTY 4 times in 10 with the reasoning plainly holding the answer. Some providers
  // (Amazon Bedrock among them) do not support it, and OpenRouter answers "No endpoints found"
  // rather than ignoring it — which is when you set VOICE_BRAIN_JSON=0 and accept the empties.
  brainJson: process.env.VOICE_BRAIN_JSON !== "0",

  // Language the voice speaks in. Default English regardless of what you speak.
  lang: process.env.VOICE_LANG || "English",

  // ISO-639-1 code for the same language, used as a hint for transcription. Without it the
  // transcriber guesses per utterance and mangles short non-English turns — an Italian "la
  // terza" came back as "Certa" — which then decides which option Claude acts on. Unknown
  // language names yield null = auto-detect.
  langCode: LANG_CODES[(process.env.VOICE_LANG || "English").trim().toLowerCase()] || null,

  // A runaway conversation is a runaway bill. After this many exchanges the call closes and
  // Claude gets {kind:"end"} — it can always ask again.
  //
  // 8 was sized for a call that answers one question and decides. Asking for detail is now the
  // expected path, and a real "explain that better / and the third one? / why" costs three
  // exchanges before anybody has decided anything.
  maxTurns: Number(process.env.VOICE_MAX_TURNS) || 12,

  // Utterance capture, all in audio time. Trailing silence that ends a turn, the floor below
  // which a "turn" is a cough, and the ceiling that stops a stuck mic from uploading a minute
  // of a room.
  // 800 cut a real sentence in half at an ordinary comma. A pause you take while thinking is
  // longer than one you take between words, and the two are indistinguishable from the level
  // alone — so the window has to cover the thinking pause.
  recordSilenceMs: Number(process.env.VOICE_RECORD_SILENCE_MS) || 1300,
  recordMinMs: Number(process.env.VOICE_RECORD_MIN_MS) || 250,
  recordMaxMs: Number(process.env.VOICE_RECORD_MAX_MS) || 30000,

  // Level (RMS %) that counts as somebody talking, once we are already listening for an
  // answer. Room tone is well under 1; a voice at laptop distance is in the teens.
  speechLevel: Number(process.env.VOICE_SPEECH_LEVEL) || 3,

  // The level that counts as "still talking" once you have started. Lower than the one above
  // on purpose: an unstressed syllable dips well below the level that opened the turn, and
  // treating that dip as silence is what cut a sentence in half.
  holdLevel: Number(process.env.VOICE_HOLD_LEVEL) || 1.5,

  // Give up on an answer that never starts. Without this a turn nobody speaks into hangs for
  // the whole recordMaxMs — half a minute of the page apparently doing nothing, which reads as
  // a crash. Reached: the call asks again.
  recordOnsetMs: Number(process.env.VOICE_RECORD_ONSET_MS) || 8000,

  // Barge-in listens to the room WHILE the voice is talking, so that you can cut it off. It is
  // off by default because it kept cutting ITSELF off: the browser's echo canceller is meant
  // to subtract what the page is playing from what the microphone hears, and when it does not
  // fully manage that, the voice clears its own playback partway through a sentence. Raising
  // the threshold to something only a real voice reaches did not end it.
  //
  // The feature is worth little — the sentences are two seconds long — and the failure is
  // worth a lot: you lose the question you were being asked. VOICE_BARGE_IN=1 turns it on.
  // The gap between "you stopped talking" and "the voice answers" is transcription plus the
  // brain: two network calls, measured between 1 and 6 seconds. Silence there reads as a hang —
  // the page looks identical to one whose server has died. A quiet pulse says the machine is
  // working, and it is generated rather than a file: nothing to ship, and two numbers tune it
  // instead of a re-recording.
  thinkSound: process.env.VOICE_THINK_SOUND !== "0",
  // The three one-shot cues — the call opening, the pulse while it waits, the call closing.
  // 0 falls back to the synthesised tones the page has always had, which is also what happens
  // by itself if a sound file will not load.
  sfxSound: process.env.VOICE_SFX !== "0",
  sfxVolume: process.env.VOICE_SFX_VOLUME === undefined ? 0.6 : Number(process.env.VOICE_SFX_VOLUME) || 0,
  // Low on purpose: audible under nothing, forgettable under speech. Loud enough to notice is
  // loud enough to be told to turn off.
  thinkVolume:
    process.env.VOICE_THINK_VOLUME === undefined ? 0.05 : Number(process.env.VOICE_THINK_VOLUME) || 0,

  bargeIn: process.env.VOICE_BARGE_IN === "1",
  bargeInLevel: Number(process.env.VOICE_BARGE_IN_LEVEL) || 12,
  bargeInMs: Number(process.env.VOICE_BARGE_IN_MS) || 600,

  // How long the page keeps the button armed before giving up and returning {kind:"end"}
  // without ever opening the call. This is what keeps the voice from talking to an empty
  // room when you are away from the desk.
  //
  // Three minutes, not thirty seconds: the whole point is that you can be away from the desk,
  // and a window you have to be sitting at the keyboard to catch defeats it. Nothing is paid
  // for while it waits, so the only cost of waiting longer is the cue.
  waitMs: process.env.VOICE_WAIT_MS === undefined ? 180000 : Number(process.env.VOICE_WAIT_MS) || 0,

  // While it waits, a soft tick at this interval keeps saying "Claude is waiting". One beep at
  // the start is a sound you had to be present for; a pulse is a state you can walk back into.
  // 0 leaves just the opening cue.
  waitTickMs: process.env.VOICE_WAIT_TICK_MS === undefined ? 5000 : Number(process.env.VOICE_WAIT_TICK_MS) || 0,

  // Volume of that tick (0-1), deliberately far below the opening cue: it repeats for minutes,
  // in a room where you are doing something else.
  waitTickVolume: (() => {
    const n = Number(process.env.VOICE_WAIT_TICK_VOLUME);
    return n > 0 && n <= 1 ? n : 0.06;
  })(),

  // What to say when a turn came back empty, or in an alphabet nobody spoke. Both are read
  // out loud, so they stay short. They are the only two lines in the pipeline the models do
  // not write, so they do NOT follow VOICE_LANG — set them in .env when you change it.
  // (They were Italian by default while VOICE_LANG defaulted to English: a leftover from when
  // this was a single-user project, and the one place the loop spoke the wrong language.)
  retryLine: process.env.VOICE_RETRY_LINE || "Sorry, I didn't catch that. Can you repeat?",
  // What to say when the transcript and the brain name different options. Acting on either
  // would be a guess, and this is the guess the whole project exists to stop.
  confirmLine:
    process.env.VOICE_CONFIRM_LINE || "I'm not sure which one you picked. Which is it?",

  // Playback speed of the voice (0.25-1.5). While it talks you are waiting, so length is not
  // a style issue but the thing standing between you and answering.
  speed: (() => {
    const n = Number(process.env.VOICE_SPEED);
    return n >= 0.25 && n <= 1.5 ? n : 1.15;
  })(),

  // Wall-clock ceiling for a single voice session; on timeout we resolve {kind:"end"} so the
  // tool call never hangs forever.
  timeoutMs: Number(process.env.VOICE_TIMEOUT_MS) || 120000,

  // "1" runs every call in a fresh child process, so editing the code does not need Claude
  // Code restarted to take effect. Costs a node startup and a tab reconnection per call.
  dev: bool(process.env.VOICE_DEV),

  // "1" disables the Stop-hook nudge (read directly in the hook too, as its own process).
  disabled: bool(process.env.VOICE_DISABLE),
};

// Fail loudly only when the voice path actually needs the key. Split into a factory so the
// error can be tested without a machine that happens to have no key.
export function makeRequireKey(cfg) {
  return () => {
    if (!cfg.openrouterKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Set it in .env, or run with VOICE_MODE=text to use " +
          "the terminal fallback.",
      );
    }
  };
}

export const requireOpenRouterKey = makeRequireKey(config);
