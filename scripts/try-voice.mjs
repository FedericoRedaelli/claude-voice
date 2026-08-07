#!/usr/bin/env node
// LIVE rehearsal of the voice loop — real microphone, real speaker, real Realtime session,
// but no MCP and no Claude Code. It calls exactly the same runVoiceSession() the plugin uses,
// with a canned "Claude message", and prints the decision that would have gone back to Claude.
//
//   npm run try            # default message + options
//   npm run try -- "Your own message here" "option a" "option b"
//
// Run it in the SAME terminal app you launch Claude Code from, so it uses the same microphone
// permission. If it works here and not in Claude Code, the problem is the MCP wiring, not audio.

import { config } from "../src/config.mjs";
import { runVoiceSession } from "../src/realtime.mjs";

const [msgArg, ...optArgs] = process.argv.slice(2);

const message =
  msgArg ||
  "I finished the login refactor and all tests pass. I can commit it now, open a pull request, " +
    "or keep going with the signup screen.";
const options = optArgs.length ? optArgs : ["commit", "open a pull request", "keep going"];

if (!config.apiKey) {
  console.error("OPENAI_API_KEY is not set (shell or .env). Nothing to do.");
  process.exit(2);
}

// This script exists to be watched, so always narrate what the session is doing.
process.env.VOICE_DEBUG = "1";

console.error("--- claude-voice live rehearsal ---");
console.error(`model=${config.model} voice=${config.voice} lang=${config.lang}` +
  ` transcribe=${config.transcribeModel}${config.langCode ? `/${config.langCode}` : " (auto)"}`);
console.error(`vad=${config.vad} silence=${config.silenceMs}ms halfDuplex=${config.halfDuplex}`);
console.error(`message: ${message}`);
console.error(`options: ${options.join(" | ")}`);
console.error("");
if (config.waitMs > 0) {
  console.error(`First beep = Claude wants you. Nothing is connected yet: just SAY SOMETHING`);
  console.error(`within ${(config.waitMs / 1000).toFixed(0)}s and the call opens (stay quiet and it ends with no session).`);
} else {
  console.error("Gate disabled (VOICE_WAIT_MS=0): the call opens immediately.");
}
console.error("Then the agent speaks first; WAIT for it to finish (the mic is muted while it");
console.error("talks), then answer out loud. Ctrl-C to abort.");
console.error("");

const decision = await runVoiceSession({ message, options });

console.error("");
console.error("--- decision returned to Claude ---");
console.log(JSON.stringify(decision));

// runVoiceSession already drained the speaker before returning; this only stops the Realtime
// websocket from keeping the process alive.
setTimeout(() => process.exit(0), 300).unref?.();
