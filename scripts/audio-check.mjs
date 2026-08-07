#!/usr/bin/env node
// Answers one question: does sox play out of, and record from, the devices you think it does?
//
//   npm run audio                       # system defaults
//   npm run audio -- "AirPods Pro"      # pin BOTH directions to a named device
//   VOICE_OUT_DEVICE="AirPods Pro" VOICE_IN_DEVICE="MacBook Air Microphone" npm run audio
//
// It plays a tone (you should HEAR it) and then records for three seconds (you should SPEAK,
// and see the level move). Either half failing localises the problem to the machine, not to
// the voice loop.

import { spawnSync } from "node:child_process";
import { createSpeaker, startMic, beepPcm, rmsPct } from "../src/audio.mjs";

const pin = process.argv[2];
const out = pin || process.env.VOICE_OUT_DEVICE || "";
const inp = pin || process.env.VOICE_IN_DEVICE || "";

// macOS keeps the device list here; on anything else this just prints nothing useful.
if (process.platform === "darwin") {
  const r = spawnSync("system_profiler", ["SPAudioDataType"], { encoding: "utf8" });
  const names = [...(r.stdout || "").matchAll(/^ {8}([^:\n]+):$/gm)].map((m) => m[1].trim());
  if (names.length) {
    console.error("Audio devices macOS reports:");
    for (const n of names) console.error(`  - ${n}`);
    console.error("Use a name above with VOICE_OUT_DEVICE / VOICE_IN_DEVICE.\n");
  }
}

console.error(`output device: ${out || "(system default)"}`);
console.error(`input  device: ${inp || "(system default)"}\n`);

console.error("Playing a tone — you should HEAR it now.");
const spk = createSpeaker({ device: out });
spk.write(beepPcm({ freq: 660, ms: 300, volume: 0.3 }));
spk.write(beepPcm({ freq: 990, ms: 300, volume: 0.3 }));
await spk.stop();
console.error(spk.remainingMs === undefined ? "" : "Tone finished.\n");

console.error("Now SAY SOMETHING — recording for 3 seconds.");
let peak = 0;
let chunks = 0;
const mic = startMic(
  (buf) => {
    chunks++;
    peak = Math.max(peak, rmsPct(buf));
  },
  { device: inp },
);
await new Promise((r) => setTimeout(r, 3000));
mic.stop();

console.error(`\ncaptured ${chunks} chunks, peak level ${peak.toFixed(1)}%`);
if (!chunks) {
  console.error("NOTHING was captured: sox never opened that input (permission, or wrong name).");
} else if (peak < 3) {
  console.error("Captured silence: the mic is open but hears nothing — wrong device, or muted.");
  console.error("The voice gate needs at least VOICE_WAKE_LEVEL (3%) to open a call.");
} else {
  console.error("Input works. A voice at laptop distance should read 10-25%.");
}
process.exit(0);
