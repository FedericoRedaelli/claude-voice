#!/usr/bin/env node
// Standalone MICROPHONE diagnostic — no OpenAI, no MCP, no speaker output. Records 3 seconds
// from the SAME sox path the plugin uses (`sox -d`, PCM16 mono 24k) and reports the audio
// level. Run it in the SAME terminal you launch Claude Code from, so it shares the same
// microphone permission.
//
//   node scripts/mic-check.mjs
//
// If it reports SILENT while you're talking, the plugin's mic can't hear you either — almost
// always a macOS microphone permission issue for your terminal app (see the hint printed).

import { spawn } from "node:child_process";

const SECS = 3;
const RAW = ["-t", "raw", "-b", "16", "-e", "signed-integer", "-r", "24000", "-c", "1"];

console.error(`Recording ${SECS}s from the default mic (sox -d). TALK NOW...`);

const proc = spawn("sox", ["-q", "-d", ...RAW, "-", "trim", "0", String(SECS)], {
  stdio: ["ignore", "pipe", "pipe"],
});

const chunks = [];
let soxErr = "";
proc.stdout.on("data", (b) => chunks.push(b));
proc.stderr.on("data", (d) => (soxErr += d.toString()));
proc.on("error", (e) => {
  console.error(`\nFAIL: could not run sox: ${e.message}`);
  console.error("Install it: brew install sox");
  process.exit(2);
});

proc.on("close", (code) => {
  const buf = Buffer.concat(chunks);
  if (soxErr.trim()) console.error(`sox said: ${soxErr.trim()}`);
  if (buf.length < 2) {
    console.error(`\nFAIL: sox produced no audio (exit ${code}).`);
    printPermHint();
    process.exit(1);
  }

  const n = Math.floor(buf.length / 2);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  const rms = Math.sqrt(sum / n);
  const rmsPct = ((rms / 32768) * 100).toFixed(1);
  const peakPct = ((peak / 32768) * 100).toFixed(1);

  console.error(`\ncaptured ${(buf.length / 2 / 24000).toFixed(1)}s, RMS ${rmsPct}%  peak ${peakPct}%`);

  if (peak < 200) {
    console.error(`\nSILENT: mic returned near-zero audio.`);
    printPermHint();
    process.exit(1);
  }
  if (rms < 150) {
    console.error(`\nVERY LOW: some signal but very quiet — VAD may never trigger. Check the input`);
    console.error(`device / gain in System Settings > Sound > Input.`);
    process.exit(1);
  }
  console.error(`\nOK: microphone is capturing real audio. The mic path works.`);
  process.exit(0);
});

function printPermHint() {
  console.error(`\nMost likely: your terminal app lacks MICROPHONE permission on macOS.`);
  console.error(`Fix: System Settings > Privacy & Security > Microphone > enable your terminal`);
  console.error(`(Terminal / iTerm / VS Code — whichever you run Claude Code in), then FULLY quit`);
  console.error(`and reopen that app (a restart of the app is required for the permission to apply).`);
}
