// Env-driven configuration. Every knob has a safe default so the text-mode loop runs
// with zero setup; only voice mode requires OPENAI_API_KEY + sox.

import { loadEnvFile } from "./env.mjs";

// Persisted settings (plugin-root/.env) fill in anything not exported in the shell.
loadEnvFile();

const bool = (v) => v === "1" || v === "true" || v === "yes";

// VOICE_LANG is a human-readable name (it steers the agent's spoken output); the transcriber
// wants an ISO-639-1 code. Map the languages worth naming; anything else = auto-detect.
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
  // "voice" (real audio via sox + OpenAI Realtime) or "text" (terminal stdin, no deps).
  mode: process.env.VOICE_MODE === "text" ? "text" : "voice",

  // OpenAI Realtime. Model lineup drifts — override VOICE_REALTIME_MODEL as needed.
  apiKey: process.env.OPENAI_API_KEY || "",
  model: process.env.VOICE_REALTIME_MODEL || "gpt-realtime-2.1-mini",
  voice: process.env.VOICE_NAME || "alloy",

  // Turn-end detection. "server_vad" (fixed silence window) is the more predictable default
  // for a half-duplex speaker setup; "semantic_vad" waits for semantic completion.
  vad: process.env.VOICE_VAD === "semantic_vad" ? "semantic_vad" : "server_vad",

  // server_vad: how much trailing silence (ms) counts as "you're done talking". At 700ms an
  // ordinary mid-sentence pause ended the turn and the agent started answering over the top of
  // you — the "mi ha interrotto mentre rispondevo". Lower = snappier, higher = more patient.
  silenceMs: Number(process.env.VOICE_SILENCE_MS) || 900,

  // server_vad: how loud audio must be to count as speech (0-1). It was raised to 0.65 to stop
  // room noise starting turns — but a high threshold also means the VAD only notices you a
  // syllable late, and everything before that is thrown away: "la terza" arrived as "Certa".
  // Back to the API default, because a false turn is now cheap (an empty transcript is
  // rejected) while a clipped answer is expensive (the agent acts on half a word).
  vadThreshold: (() => {
    const n = Number(process.env.VOICE_VAD_THRESHOLD);
    return n > 0 && n < 1 ? n : 0.5;
  })(),

  // server_vad: how much audio from BEFORE the VAD triggered is kept. The API default (300ms)
  // is not enough for a short answer that starts with a soft syllable.
  prefixPaddingMs: Number(process.env.VOICE_PREFIX_PADDING_MS) || 500,

  // How long someone must keep talking before it counts as interrupting the agent, rather
  // than as a cough, a key press or a door. Below this the agent keeps its sentence; at 0 the
  // old behaviour returns, where any VAD blip chopped playback in half.
  bargeInMs: Number(process.env.VOICE_BARGE_IN_MS) || 350,

  // Language the agent speaks in. Default English regardless of what you speak.
  lang: process.env.VOICE_LANG || "English",

  // ISO-639-1 code for the same language, used as a hint for INPUT transcription. Without it
  // the transcriber guesses per utterance and mangles short non-English turns (an Italian
  // sentence came back as "Let's come italiano"), which then misleads the agent. Unknown
  // language names simply yield null = no hint (auto-detect, previous behaviour).
  langCode: LANG_CODES[(process.env.VOICE_LANG || "English").trim().toLowerCase()] || null,

  // Transcription model for the user's audio. Only affects the transcript the agent reads.
  // The mini model mangled short Italian answers ("la terza" -> "Certa."), and since the
  // transcript is now what a decision is checked against, its accuracy decides whether the
  // right option gets picked. The full model costs more per minute of a call that lasts
  // seconds.
  transcribeModel: process.env.VOICE_TRANSCRIBE_MODEL || "gpt-4o-transcribe",

  // Input noise reduction — improves transcription with a noisy mic. "near_field" (headset
  // / laptop mic), "far_field" (room mic), or "off". Default near_field.
  noise:
    process.env.VOICE_NOISE === "off"
      ? null
      : process.env.VOICE_NOISE === "far_field"
        ? "far_field"
        : "near_field",

  // Where the audio actually happens. Only "browser" exists today: the page's own echo
  // canceller is what makes barge-in work on open speakers. A headless "sox" implementation
  // is the obvious next slot (spec §4).
  audio: process.env.VOICE_AUDIO || "browser",

  // Half-duplex by DEFAULT on sox (idiot-proof on speakers): the mic is muted while the agent
  // talks so its voice can't echo back into the mic and make it interrupt/repeat itself.
  // With the browser backend there IS echo cancellation, so the default flips: muting the mic
  // there would throw away the barge-in that backend exists to provide. Either way
  // VOICE_HALF_DUPLEX=1/0 forces it.
  halfDuplex:
    process.env.VOICE_HALF_DUPLEX === "0"
      ? false
      : process.env.VOICE_HALF_DUPLEX === "1"
        ? true
        : process.env.VOICE_AUDIO !== "browser",

  // Half-duplex only: how long after the agent's audio stops before the mic re-opens (covers
  // the speaker's playback tail).
  // (measured from the END of playback, not from the last chunk received) — covers the room's
  // echo tail on laptop speakers.
  micReopenMs: Number(process.env.VOICE_MIC_REOPEN_MS) || 600,

  // How long to sit in the passive "beep, then listen" gate before giving up and returning
  // {kind:"end"} without ever opening a Realtime session. This is what keeps the agent from
  // talking to an empty room when you're away from the desk. 0 disables the gate (the old
  // behaviour: the call starts the moment Claude stops).
  waitMs: process.env.VOICE_WAIT_MS === undefined ? 30000 : Number(process.env.VOICE_WAIT_MS) || 0,

  // While the gate waits, a soft tick at this interval keeps saying "Claude is waiting" — one
  // beep at the start is a sound you had to be present for; a pulse is a state you can walk
  // back into. 0 = just the opening cue.
  waitTickMs: process.env.VOICE_WAIT_TICK_MS === undefined ? 1500 : Number(process.env.VOICE_WAIT_TICK_MS) || 0,

  // Volume of that tick (0-1). Deliberately far below the opening cue: it repeats for up to
  // half a minute, in a room where you may be doing something else.
  waitTickVolume: (() => {
    const n = Number(process.env.VOICE_WAIT_TICK_VOLUME);
    return n > 0 && n <= 1 ? n : 0.08;
  })(),

  // How long after one of our own cues the gate keeps ignoring the mic. On laptop speakers the
  // tone is picked up by the microphone and reads as speech — without this the gate hears
  // itself beep and opens a call nobody asked for.
  cueEchoMs: Number(process.env.VOICE_CUE_ECHO_MS) || 350,

  // Mic level (RMS %, 0-100) that counts as "the user is talking" in that gate. Room tone is
  // well under 1%; a voice at laptop distance is in the teens. Raise it in a noisy room.
  wakeLevel: Number(process.env.VOICE_WAKE_LEVEL) || 3,

  // Wake word. Empty (the default) keeps the old behaviour: any voice loud enough opens the
  // call. Set it to a name — "Claudio", or "vai Claudio", or several separated by commas —
  // and the level gate becomes the cheap first stage only: what it captures is transcribed
  // LOCALLY by whisper.cpp and the call opens only if the name is in it. Nothing leaves the
  // machine and there is no per-noise API cost. Needs `npm run setup:wake`.
  wakeWord: (process.env.VOICE_WAKE_WORD || "").trim(),

  // Where the local recogniser lives. setup:wake writes both into .env.
  whisperBin: process.env.VOICE_WHISPER_BIN || "whisper-cli",
  whisperModel: process.env.VOICE_WHISPER_MODEL || "",

  // How much speech that gate needs before it opens the call. A single short word ("vai",
  // "go") is barely 200 ms, so anything higher makes you repeat yourself; raise it only if
  // door slams and coughs keep opening calls.
  wakeMs: Number(process.env.VOICE_WAKE_MS) || 180,

  // If Claude comes back with another question this soon after the last call ended, skip the
  // gate and open the mic straight away: you're clearly still in the conversation, and having
  // to say "yes I'm here" between every exchange is what makes a voice loop unusable.
  followupMs:
    process.env.VOICE_FOLLOWUP_MS === undefined ? 15000 : Number(process.env.VOICE_FOLLOWUP_MS) || 0,

  // Playback speed of the agent's voice (0.25-1.5). The prompt tells it to be brief and it
  // still ran 13s — and while it talks the mic is dead, so length is not a style issue but the
  // thing that keeps you from answering. Speeding up the delivery shortens that window without
  // ever cutting a sentence in half, which capping output tokens would.
  speed: (() => {
    const n = Number(process.env.VOICE_SPEED);
    return n >= 0.25 && n <= 1.5 ? n : 1.15;
  })(),

  // Half-duplex only: the mic starts muted for this long, covering the gap between "connected"
  // and the first audio of the opening turn (there is nothing playing yet, so playback timing
  // can't protect it).
  openingGraceMs: Number(process.env.VOICE_OPENING_GRACE_MS) || 3000,

  // How much speech the API must have committed before a reported decision is believed. Kept
  // low on purpose: "la prima" is barely half a second, and rejecting a real answer is as bad
  // as accepting a fake one. The transcript check below is what actually filters noise; this
  // only stops a decision built on a click or a cough.
  minAnswerMs: Number(process.env.VOICE_MIN_ANSWER_MS) || 250,

  // How long to wait for the transcript of the user's turn before judging a reported decision.
  // The model calls submit_decision ~0.2s after the turn is committed and the transcript lands
  // ~0.4s after, so without this wait the decision is judged blind — that is how a turn that
  // transcribed as Korean, in an Italian call, became "open a pull request".
  transcriptWaitMs: Number(process.env.VOICE_TRANSCRIPT_WAIT_MS) || 1500,

  // Short cue tone when the agent stops talking and the mic re-opens. On speakers the mic is
  // dead while the agent speaks, so without a sound the user has no way to know when it's
  // their turn — they answer into a muted mic and think it's broken. Set VOICE_TURN_BEEP=0
  // to silence it.
  turnBeep: process.env.VOICE_TURN_BEEP === "0" ? false : true,

  // Wall-clock ceiling for a single voice session; on timeout we resolve {kind:"end"}
  // so the tool call never hangs forever.
  timeoutMs: Number(process.env.VOICE_TIMEOUT_MS) || 120000,

  // --- OpenRouter pipeline -------------------------------------------------------------
  // One key covers transcription, synthesis and reasoning. That is the entire reason this
  // provider was chosen over three better-at-one-thing ones.
  openrouterKey: process.env.OPENROUTER_API_KEY || "",
  baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",

  // Which implementation fills each slot. The registry in modules.mjs turns these names into
  // dynamic imports, so a future local engine is a value here and nothing else.
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

  // A runaway conversation is a runaway bill. After this many exchanges the call closes and
  // Claude gets {kind:"end"} — it can always ask again.
  maxTurns: Number(process.env.VOICE_MAX_TURNS) || 8,

  // Utterance capture. Trailing silence that ends a turn, the floor below which a "turn" is
  // a cough, and the ceiling that stops a stuck mic from uploading a minute of a room.
  recordSilenceMs: Number(process.env.VOICE_RECORD_SILENCE_MS) || 800,
  recordMinMs: Number(process.env.VOICE_RECORD_MIN_MS) || 250,
  recordMaxMs: Number(process.env.VOICE_RECORD_MAX_MS) || 30000,

  // Level (RMS %) that counts as somebody talking, for both utterance start and barge-in.
  speechLevel: Number(process.env.VOICE_SPEECH_LEVEL) || 3,

  // What to say when a turn came back empty. It is spoken, so it stays short.
  retryLine: process.env.VOICE_RETRY_LINE || "Non ho sentito. Puoi ripetere?",

  // "1" disables the Stop-hook nudge (read directly in the hook too, as its own process).
  disabled: bool(process.env.VOICE_DISABLE),
};

// Fail loudly only when the voice path actually needs the key.
export function requireApiKey() {
  if (!config.apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Set it, or run with VOICE_MODE=text to use the terminal fallback.",
    );
  }
}

// Same idea as requireApiKey, for the only key the new pipeline needs. Split out so the
// error names the variable the user actually has to set.
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
