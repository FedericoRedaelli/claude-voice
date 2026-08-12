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
  brainModel: process.env.VOICE_BRAIN_MODEL || "openai/gpt-oss-20b",

  // Language the voice speaks in. Default English regardless of what you speak.
  lang: process.env.VOICE_LANG || "English",

  // ISO-639-1 code for the same language, used as a hint for transcription. Without it the
  // transcriber guesses per utterance and mangles short non-English turns — an Italian "la
  // terza" came back as "Certa" — which then decides which option Claude acts on. Unknown
  // language names yield null = auto-detect.
  langCode: LANG_CODES[(process.env.VOICE_LANG || "English").trim().toLowerCase()] || null,

  // A runaway conversation is a runaway bill. After this many exchanges the call closes and
  // Claude gets {kind:"end"} — it can always ask again.
  maxTurns: Number(process.env.VOICE_MAX_TURNS) || 8,

  // Utterance capture, all in audio time. Trailing silence that ends a turn, the floor below
  // which a "turn" is a cough, and the ceiling that stops a stuck mic from uploading a minute
  // of a room.
  recordSilenceMs: Number(process.env.VOICE_RECORD_SILENCE_MS) || 800,
  recordMinMs: Number(process.env.VOICE_RECORD_MIN_MS) || 250,
  recordMaxMs: Number(process.env.VOICE_RECORD_MAX_MS) || 30000,

  // Level (RMS %) that counts as somebody talking, for both utterance start and barge-in.
  // Room tone is well under 1; a voice at laptop distance is in the teens.
  speechLevel: Number(process.env.VOICE_SPEECH_LEVEL) || 3,

  // How long someone must keep talking before it counts as interrupting the voice, rather
  // than as a cough, a key press or a door. At 0 any blip chops playback in half.
  bargeInMs: Number(process.env.VOICE_BARGE_IN_MS) || 350,

  // How long the page keeps the button armed before giving up and returning {kind:"end"}
  // without ever opening the call. This is what keeps the voice from talking to an empty
  // room when you are away from the desk.
  waitMs: process.env.VOICE_WAIT_MS === undefined ? 30000 : Number(process.env.VOICE_WAIT_MS) || 0,

  // What to say when a turn came back empty, or in an alphabet nobody spoke. Both are read
  // out loud, so they stay short.
  retryLine: process.env.VOICE_RETRY_LINE || "Non ho sentito. Puoi ripetere?",
  // What to say when the transcript and the brain name different options. Acting on either
  // would be a guess, and this is the guess the whole project exists to stop.
  confirmLine: process.env.VOICE_CONFIRM_LINE || "Non sono sicuro di quale hai scelto. Quale?",

  // Playback speed of the voice (0.25-1.5). While it talks you are waiting, so length is not
  // a style issue but the thing standing between you and answering.
  speed: (() => {
    const n = Number(process.env.VOICE_SPEED);
    return n >= 0.25 && n <= 1.5 ? n : 1.15;
  })(),

  // Wall-clock ceiling for a single voice session; on timeout we resolve {kind:"end"} so the
  // tool call never hangs forever.
  timeoutMs: Number(process.env.VOICE_TIMEOUT_MS) || 120000,

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
