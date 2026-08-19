#!/usr/bin/env node
// `/voice-on` and `/voice-off` end up here. Usage: node scripts/gate.mjs on|off|status [id]
//
// The session id comes from CLAUDE_CODE_SESSION_ID, which Claude Code exports into every
// command shell. Without it there is nothing to key the state to, and rather than guess we say
// so and point at the environment escape.

import { isOn, readState, sessionFile, setOn } from "../src/gate.mjs";

const action = (process.argv[2] || "status").toLowerCase();
const id = process.argv[3] || process.env.CLAUDE_CODE_SESSION_ID || "";

if (!id) {
  process.stdout.write(
    "No session id (CLAUDE_CODE_SESSION_ID is not set), so the voice loop cannot be switched\n" +
      "for this session. Export VOICE_ALWAYS=1 to keep it on everywhere instead.\n",
  );
  process.exit(1);
}

if (action === "on" || action === "off") {
  const want = action === "on";
  if (!setOn(id, want)) {
    process.stdout.write(`Could not write ${sessionFile(id)} — the voice loop is unchanged.\n`);
    process.exit(1);
  }
}

const on = isOn(id);
const state = readState(id);
process.stdout.write(
  `voice: ${on ? "on" : "off"} for this session (${id})\n` +
    `state: ${sessionFile(id)}${state ? "" : " (none yet — off is the default)"}\n` +
    (process.env.VOICE_DISABLE === "1" ? "note: VOICE_DISABLE=1 is set, which forces it off\n" : "") +
    (process.env.VOICE_ALWAYS === "1" ? "note: VOICE_ALWAYS=1 is set, which forces it on\n" : ""),
);
