import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecorder } from "../src/audio/browser.mjs";
import { beepPcm } from "../src/pcm.mjs";

// A fake mic: hand it chunks and it delivers them on the next tick, like the bridge does.
function fakeMic(chunks) {
  return (onChunk) => {
    let i = 0;
    const timer = setInterval(() => {
      if (i >= chunks.length) return;
      onChunk(chunks[i++]);
    }, 1);
    return { stop: () => clearInterval(timer) };
  };
}

const SILENCE = Buffer.alloc(480 * 2); // 20 ms
const SPEECH = beepPcm({ ms: 20, volume: 0.5 });
const times = (n, chunk) => Array.from({ length: n }, () => chunk);

test("a recording ends after the configured trailing silence", async () => {
  // 10 chunks of speech (200 ms), then 50 of silence (1000 ms) — past the 800 ms cutoff.
  const mic = fakeMic([...times(10, SPEECH), ...times(50, SILENCE)]);
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 800, minMs: 100, maxMs: 5000, level: 3 });

  assert.ok(pcm.length > 0, "the speech is kept");
  assert.ok(pcm.length < (10 + 50) * SILENCE.length, "the trailing silence is not");
});

test("silence alone returns nothing rather than uploading a quiet room", async () => {
  const mic = fakeMic(times(60, SILENCE));
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 300, minMs: 100, maxMs: 800, level: 3 });
  assert.equal(pcm.length, 0);
});

test("a stuck microphone is cut off at maxMs", async () => {
  const mic = fakeMic(times(1000, SPEECH));
  const rec = createRecorder({ startMic: mic });

  const t0 = Date.now();
  const pcm = await rec.record({ silenceMs: 800, minMs: 100, maxMs: 300, level: 3 });

  assert.ok(Date.now() - t0 < 2000, "it returns, and soon");
  assert.ok(pcm.length > 0);
});

test("an answer that never starts gives up early instead of hanging", async () => {
  // What actually happened: a stray noise cut the voice off mid-sentence, nobody was talking,
  // and the recorder sat there for the whole 30 s ceiling. Half a minute of a page doing
  // nothing reads as a crash, not as patience.
  const mic = fakeMic(times(200, SILENCE)); // 4 s of room
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 800, minMs: 100, maxMs: 30000, onsetMs: 600, level: 3 });

  assert.equal(pcm.length, 0);
});

test("the onset timer only runs until somebody starts, not during their pauses", async () => {
  // Someone who starts talking gets the full silenceMs to pause and carry on, even when the
  // pause is longer than the onset budget.
  const mic = fakeMic([...times(10, SPEECH), ...times(40, SILENCE), ...times(10, SPEECH), ...times(50, SILENCE)]);
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 1000, minMs: 100, maxMs: 30000, onsetMs: 200, level: 3 });

  assert.ok(pcm.length > 20 * SPEECH.length, "both halves of the sentence are kept");
});

test("a weak syllable mid-sentence does not end the turn", async () => {
  // The transcript that exposed this was cut mid-clause: "Anche in questo caso non hai
  // concluso perché si". One threshold answered both "have they started" and "are they still
  // going", and an unstressed syllable dips under the first one.
  const WEAK = beepPcm({ ms: 20, volume: 0.05 }); // audible, well under the start threshold
  const mic = fakeMic([
    ...times(5, SPEECH),
    ...times(30, WEAK), // 600 ms of quiet speech — past the 400 ms silence window
    ...times(5, SPEECH),
    ...times(40, SILENCE),
  ]);
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 400, minMs: 100, maxMs: 30000, level: 3, holdLevel: 1 });

  assert.ok(pcm.length >= 40 * SPEECH.length, "the whole sentence is kept, dip included");
});

test("the hold level does not let room tone hold a turn open forever", async () => {
  const mic = fakeMic([...times(5, SPEECH), ...times(100, SILENCE)]);
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 400, minMs: 100, maxMs: 30000, level: 3, holdLevel: 1 });

  assert.ok(pcm.length < 30 * SILENCE.length, "true silence still closes the turn");
});

test("a cough shorter than minMs is not an utterance", async () => {
  const mic = fakeMic([SPEECH, ...times(40, SILENCE)]);
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 200, minMs: 250, maxMs: 2000, level: 3 });
  assert.equal(pcm.length, 0);
});
