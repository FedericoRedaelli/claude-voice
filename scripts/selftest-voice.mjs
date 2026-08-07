#!/usr/bin/env node
// HEADLESS end-to-end self-test of the REAL runVoiceSession — no microphone, no speaker, no
// sound on your machine. It:
//   1. synthesizes a spoken user answer with macOS `say` -> raw PCM16 24k mono (silent, to a
//      file; nothing is played),
//   2. runs the actual src/realtime.mjs session with MOCK audio deps:
//        - mock speaker  = captures the agent's audio + beeps, and detects when the agent has
//          stopped talking (a silence gap), just like a human ear would;
//        - mock mic      = once the agent goes quiet, feeds the synthesized answer in
//          real-time-paced chunks (+ trailing silence so server VAD ends the turn),
//   3. asserts the model called submit_decision and the decision came back.
//
// This exercises EVERYTHING except the physical sox devices: instructions, turn detection,
// the opening turn, half-duplex mic gating, beeps, submit_decision, and the returned value.
//
// Usage: node scripts/selftest-voice.mjs [answer text] [--expect substring]
//   (reads OPENAI_API_KEY from env or .env; needs network to api.openai.com + `say`,`sox`)

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config.mjs";
import { runVoiceSession } from "../src/realtime.mjs";

const args = process.argv.slice(2);
const expectIdx = args.indexOf("--expect");
const expect = expectIdx >= 0 ? args[expectIdx + 1] : "commit";
const answerText =
  (expectIdx >= 0 ? args.slice(0, expectIdx) : args).join(" ") || "Let's commit it.";

if (!config.apiKey) {
  console.error("No OPENAI_API_KEY (env or .env). Cannot run the live self-test.");
  process.exit(2);
}

// --- 1. synthesize the user's spoken answer to raw PCM16 24k mono (silent) ---
const dir = mkdtempSync(join(tmpdir(), "voice-selftest-"));
const aiff = join(dir, "answer.aiff");
const raw = join(dir, "answer.raw");
console.error(`Synthesizing user answer: "${answerText}"`);
execFileSync("say", ["-o", aiff, answerText]);
execFileSync("sox", [aiff, "-t", "raw", "-b", "16", "-e", "signed-integer", "-r", "24000", "-c", "1", raw]);
const answerPcm = readFileSync(raw);
console.error(`  -> ${answerPcm.length} bytes PCM (${(answerPcm.length / 2 / 24000).toFixed(1)}s)`);

// --- 2. mock audio deps ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agentChunks = [];
let agentBytes = 0;
let micOnChunk = null;
let fed = false; // feed the answer only once
let idleTimer = null;

// The opening beep is ~140ms; the opening SPEECH is seconds. Only treat silence as "your
// turn" once we've heard real speech, so the beep-to-speech gap doesn't trip us early.
const MIN_SPEECH_BYTES = 48000; // ~1.0s of PCM16 @ 24k

// When the agent has been silent for a beat (after real speech), feed the answer.
function armIdleDetector() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (fed || !micOnChunk) return;
    if (agentBytes < MIN_SPEECH_BYTES) return; // only the beep / not enough speech yet
    fed = true;
    console.error("Agent went quiet -> feeding user's spoken answer...");
    const CHUNK = 4800; // 0.1s
    for (let off = 0; off < answerPcm.length; off += CHUNK) {
      const s = answerPcm.subarray(off, off + CHUNK);
      micOnChunk(s);
      await sleep(80);
    }
    const sil = Buffer.alloc(CHUNK);
    for (let i = 0; i < 20; i++) {
      micOnChunk(sil);
      await sleep(80);
    }
    console.error("Answer + trailing silence sent; waiting for submit_decision...");
  }, 1500);
}

const mockSpeaker = () => ({
  write(buf) {
    const b = Buffer.from(buf);
    agentChunks.push(b);
    agentBytes += b.length;
    armIdleDetector();
  },
  stop() {},
});

const mockStartMic = (onChunk) => {
  micOnChunk = onChunk;
  return { stop() { micOnChunk = null; } };
};

// --- 3. run the real session ---
const message =
  "I created two files, index.html and styles.css, for the landing page. Want me to commit them, or keep going?";
const options = ["commit", "keep going"];

console.error(`\nStarting REAL runVoiceSession (model=${config.model}, vad=${config.vad}, halfDuplex=${config.halfDuplex})\n`);
const started = Date.now();
let decision;
try {
  decision = await runVoiceSession({
    message,
    options,
    deps: { startMic: mockStartMic, createSpeaker: mockSpeaker },
  });
} catch (err) {
  console.error("SESSION THREW:", err?.stack ?? err);
  process.exit(1);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.error(`\n--- result (${secs}s) ---`);
console.error(`agent audio captured: ${agentBytes} bytes (${(agentBytes / 2 / 24000).toFixed(1)}s)`);
console.error(`decision: ${JSON.stringify(decision)}`);

// optional: dump agent audio so a human can listen later (never auto-played)
if (process.env.VOICE_DUMP) {
  const out = join(process.cwd(), "selftest-agent.raw");
  writeFileSync(out, Buffer.concat(agentChunks));
  console.error(`agent audio dumped -> ${out} (play: sox -t raw -b 16 -e signed-integer -r 24000 -c 1 ${out} -d)`);
}

const ok =
  decision &&
  decision.kind &&
  decision.kind !== "end" &&
  String(decision.value || "").toLowerCase().includes(expect.toLowerCase());

if (!ok && decision?.kind === "end") {
  console.error(`\nFAIL: got {kind:"end"} — the model never reported a real answer (timeout or misfire).`);
  process.exit(1);
}
if (!ok) {
  console.error(`\nFAIL: decision did not contain expected "${expect}".`);
  process.exit(1);
}
console.error(`\nPASS: answer reported back to Claude, contains "${expect}".`);
process.exit(0);
