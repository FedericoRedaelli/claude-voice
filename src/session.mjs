// Dispatches a stopping-point hand-off to the voice or text path and returns a normalized
// decision: { kind: "choice"|"message"|"end", value?: string }.

import { config } from "./config.mjs";
import { runTextSession } from "./text.mjs";

// `signal` aborts when Claude Code cancels the tool call (the user pressed Esc): the session
// must go silent and return, not keep talking to nobody.
// `spoken` is the opening line Claude wrote for the agent to read verbatim. Text mode ignores
// it on purpose: it prints `message`, which is the full version, and reading a line meant for
// the ear off a screen would just be a worse summary of what is already there.
export async function runSession({ message, options = [], spoken = "", signal }) {
  if (config.mode === "text") {
    return runTextSession({ message, options, signal });
  }
  // Lazy-import the voice path so text mode never loads the SDK or touches sox.
  voiceModule = voiceModule || (await import("./realtime.mjs"));
  return voiceModule.runVoiceSession({ message, options, spoken, signal });
}

let voiceModule = null;

// Server shutdown (SIGTERM/SIGINT, stdin closed): silence any live call. No-op if the voice
// path was never loaded — we must not import the SDK just to shut down.
export function abortActiveSessions(why) {
  voiceModule?.abortActiveVoiceSessions?.(why);
}
