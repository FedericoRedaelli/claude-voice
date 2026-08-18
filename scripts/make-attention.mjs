#!/usr/bin/env node
// Generates public/sounds/attention.wav — the pulse that repeats while the button waits.
//
// The other three sounds were recorded; this one is written, and it is committed rather than
// generated at runtime so the page has one way to load a sound instead of two. The script
// stays because a sound you cannot regenerate is a sound nobody dares to change: run it, hear
// it, move a number, run it again.
//
//   node scripts/make-attention.mjs
//
// The shape it aims for: two notes, up, spaced enough to read as a question rather than an
// alarm. It repeats every few seconds for up to three minutes while you are away from the
// desk, so anything sharp or insistent would be intolerable by the second minute — a rising
// pair at low volume is heard from the next room and forgotten in the same one.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 48000;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sounds", "attention.wav");

// A note with a soft attack and a long decay: a struck bell rather than a switched-on tone.
// The click of a square edge coming out of a laptop speaker is indistinguishable from a fault.
function note({ freq, startMs, ms, gain }) {
  return { freq, start: Math.round((startMs / 1000) * RATE), n: Math.round((ms / 1000) * RATE), gain };
}

const NOTES = [
  note({ freq: 784, startMs: 0, ms: 260, gain: 0.5 }), // G5
  note({ freq: 1175, startMs: 150, ms: 380, gain: 0.42 }), // D6, overlapping — a pair, not two beeps
];

const totalMs = 700;
const samples = Math.round((totalMs / 1000) * RATE);
const mix = new Float32Array(samples);

for (const n of NOTES) {
  for (let i = 0; i < n.n && n.start + i < samples; i++) {
    const t = i / RATE;
    const attack = Math.min(1, i / (RATE * 0.012)); // 12 ms in
    const decay = Math.exp(-t * 6); // and gone
    // A touch of the octave above gives it something to cut through room noise with, without
    // raising the level of the fundamental.
    const body = Math.sin(2 * Math.PI * n.freq * t) + 0.18 * Math.sin(4 * Math.PI * n.freq * t);
    mix[n.start + i] += body * n.gain * attack * decay * 0.5;
  }
}

// 16-bit mono PCM in a canonical WAV header. Mono because it is a cue, not music, and every
// browser decodes this without a codec.
const data = Buffer.alloc(samples * 2);
for (let i = 0; i < samples; i++) {
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))), i * 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16); // PCM chunk size
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32); // block align
header.writeUInt16LE(16, 34); // bits
header.write("data", 36);
header.writeUInt32LE(data.length, 40);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([header, data]));
process.stdout.write(`${OUT} — ${totalMs} ms, ${(header.length + data.length) / 1024 | 0} KB\n`);
