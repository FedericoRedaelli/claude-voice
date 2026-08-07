// The speaker's jitter cushion: what stops the agent from going silent mid-word when a burst
// of audio arrives late, and then catching up in a rush.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createJitterBuffer } from "../src/jitter.mjs";

const ms = (n) => Buffer.alloc(n * 48); // PCM16 @ 24 kHz = 48 bytes per ms

test("holds audio back until the cushion is full, then writes through", () => {
  const j = createJitterBuffer({ jitterMs: 250 });
  assert.equal(j.push(ms(100)), null, "still filling");
  assert.equal(j.push(ms(100)), null);
  assert.equal(j.primed, false);

  const out = j.push(ms(100));
  assert.equal(out.length, ms(300).length, "the whole cushion goes out at once");
  assert.equal(j.primed, true);

  // Past the cushion every chunk plays immediately: the head start is what covers a stall.
  const next = ms(60);
  assert.equal(j.push(next), next);
});

test("a reply shorter than the cushion is still played", () => {
  // Two words and a full stop — without drain() this would sit in the buffer forever, which
  // reads as the agent simply not answering.
  const j = createJitterBuffer({ jitterMs: 250 });
  assert.equal(j.push(ms(80)), null);
  assert.equal(j.drain().length, ms(80).length);
  assert.equal(j.drain(), null, "nothing left");
});

test("each turn gets its own cushion", () => {
  const j = createJitterBuffer({ jitterMs: 100 });
  j.push(ms(120)); // primed
  assert.equal(j.primed, true);
  j.reset();
  assert.equal(j.primed, false, "the gap between turns is not a stall to ride out");
  assert.equal(j.push(ms(50)), null);
});

test("jitterMs 0 disables it entirely", () => {
  const j = createJitterBuffer({ jitterMs: 0 });
  const b = ms(20);
  assert.equal(j.push(b), b);
  assert.equal(j.drain(), null);
});
