import assert from "node:assert/strict";
import { test } from "node:test";
import { beepPcm, durationMs, pcmToWav, rmsPct } from "../src/pcm.mjs";

test("pcmToWav puts a 44-byte RIFF header in front of the samples", () => {
  const pcm = Buffer.alloc(480 * 2); // 20 ms at 24 kHz
  const wav = pcmToWav(pcm);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.subarray(36, 40).toString(), "data");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length, "RIFF size is everything after byte 8");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data size is the payload");
});

test("pcmToWav declares mono PCM16 at 24 kHz — the format the whole project speaks", () => {
  const wav = pcmToWav(Buffer.alloc(96));

  assert.equal(wav.readUInt16LE(20), 1, "format 1 = uncompressed PCM");
  assert.equal(wav.readUInt16LE(22), 1, "one channel");
  assert.equal(wav.readUInt32LE(24), 24000, "sample rate");
  assert.equal(wav.readUInt32LE(28), 48000, "byte rate = 24000 * 1 * 2");
  assert.equal(wav.readUInt16LE(32), 2, "block align");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
});

test("pcmToWav round-trips the samples untouched", () => {
  const pcm = Buffer.from([1, 0, 2, 0, 255, 127]);
  assert.deepEqual(pcmToWav(pcm).subarray(44), pcm);
});

test("rmsPct reads silence as zero and a loud tone as a large number", () => {
  assert.equal(rmsPct(Buffer.alloc(960)), 0);
  assert.ok(rmsPct(beepPcm({ ms: 100, volume: 0.9 })) > 20);
});

test("beepPcm produces the requested duration of audio", () => {
  const beep = beepPcm({ ms: 100 });
  assert.equal(beep.length, 0.1 * 48000, "100 ms at 48000 bytes/s");
  assert.equal(durationMs(beep), 100);
});

test("beepPcm prepends silence when asked for a lead-in", () => {
  const beep = beepPcm({ ms: 100, leadMs: 50 });
  assert.equal(durationMs(beep), 150);
  assert.equal(rmsPct(beep.subarray(0, 50 * 48)), 0, "the lead-in is silent");
});
