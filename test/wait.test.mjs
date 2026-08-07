// The passive gate's level detector, driven by a fake microphone: what decides whether Claude
// opens a paid call, from a room it can only hear.

process.env.VOICE_NO_ENV_FILE = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForSpeech, rmsPct, beepPcm } from "../src/audio.mjs";
import { pcm, fakeMic } from "./fakes.mjs";

// Feed the gate a chunk every few ms until it settles.
function feeding(mic, chunk, everyMs = 10) {
  const t = setInterval(() => mic.feed(chunk), everyMs);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

test("a voice opens the gate; silence lets it time out", async () => {
  const quiet = fakeMic();
  const stopQuiet = feeding(quiet, pcm(20, 0.5)); // room tone
  assert.equal(await waitForSpeech({ waitMs: 200, level: 3, speechMs: 100, startMic: quiet }), false);
  stopQuiet();

  const talking = fakeMic();
  const stopTalking = feeding(talking, pcm(20, 20));
  assert.equal(await waitForSpeech({ waitMs: 1000, level: 3, speechMs: 100, startMic: talking }), true);
  stopTalking();
});

test("the gate does not open on hearing its own waiting beep", async () => {
  // On laptop speakers the cue is picked up by the mic at full voice level. Without
  // ignoreWhile, Claude beeps, hears the beep, and opens a call to an empty room.
  const mic = fakeMic();
  const beep = beepPcm({ freq: 1180, ms: 70, volume: 0.08 });
  assert.ok(rmsPct(beep) > 3, "the cue really is loud enough to be mistaken for speech");

  let cuePlaying = true;
  const stop = feeding(mic, pcm(20, 15)); // what the mic hears: the cue, leaking back
  const opened = await waitForSpeech({
    waitMs: 300,
    level: 3,
    speechMs: 100,
    startMic: mic,
    ignoreWhile: () => cuePlaying,
  });
  stop();
  assert.equal(opened, false, "our own sound must never count as an answer");

  // The same audio, once the cue is over, is a person talking.
  const mic2 = fakeMic();
  cuePlaying = false;
  const stop2 = feeding(mic2, pcm(20, 15));
  assert.equal(
    await waitForSpeech({
      waitMs: 1000,
      level: 3,
      speechMs: 100,
      startMic: mic2,
      ignoreWhile: () => cuePlaying,
    }),
    true,
  );
  stop2();
});

test("the gate releases the microphone on the way out", async () => {
  const mic = fakeMic();
  const stop = feeding(mic, pcm(20, 0));
  await waitForSpeech({ waitMs: 120, level: 3, speechMs: 100, startMic: mic });
  stop();
  assert.ok(mic.mics.length >= 1);
  assert.equal(mic.mics.every((m) => m.stopped), true, "a mic left open blocks the session's own");
});

test("an abort ends the wait immediately", async () => {
  const ac = new AbortController();
  const mic = fakeMic();
  const stop = feeding(mic, pcm(20, 0));
  setTimeout(() => ac.abort(), 20);
  assert.equal(
    await waitForSpeech({ waitMs: 5000, level: 3, speechMs: 100, startMic: mic, signal: ac.signal }),
    false,
  );
  stop();
});
