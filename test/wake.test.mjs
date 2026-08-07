// The wake word, without whisper: the recogniser is injected, so what these tests pin down is
// everything around it — what counts as a name, what audio gets handed over, and what happens
// to the noise that isn't a name.

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  matchesWake,
  normalizeText,
  resampleTo16k,
  wavFromPcm,
  waitForWakeWord,
  MIC_RATE,
  WHISPER_RATE,
} from "../src/wake.mjs";
import { fakeMic, pcm } from "./fakes.mjs";

test("normalizing throws away case, accents and punctuation, not letters", () => {
  assert.equal(normalizeText("Vai, Claudio!"), "vai claudio");
  assert.equal(normalizeText("perché è così"), "perche e cosi");
  // The regression this guards: a broken escape once ate the consonants too.
  assert.equal(normalizeText("Claudio"), "claudio");
});

test("a name is matched through the way a small model mishears it", () => {
  for (const said of ["vai claudio", "Vai Claudio!", "vai claudia", "ok vai cloudio adesso"])
    assert.ok(matchesWake(said, "vai claudio"), `"${said}" should wake`);
});

test("things that are not the name do not wake it", () => {
  for (const said of ["che ore sono", "ciao", "", "va bene", "aiuto"])
    assert.ok(!matchesWake(said, "vai claudio"), `"${said}" must not wake`);
});

test("several names can be configured, comma separated", () => {
  assert.ok(matchesWake("ehi claude", "claudio, claude"));
  assert.ok(matchesWake("claudio", "claudio, claude"));
  assert.ok(!matchesWake("ehi siri", "claudio, claude"));
});

test("a short name gets no fuzzy slack, or everything would match it", () => {
  // At three letters an edit budget of 2 turns "vai" into a match for almost any word.
  assert.ok(matchesWake("vai", "vai"));
  assert.ok(!matchesWake("mai", "vai") && !matchesWake("hai", "vai"));
});

test("no wake word configured means nothing wakes it", () => {
  assert.ok(!matchesWake("claudio", ""));
  assert.ok(!matchesWake("claudio", []));
});

test("resampling lands on 16 kHz and keeps the audio's length in time", () => {
  const oneSecond = pcm(1000, 30); // 24 kHz
  const out = resampleTo16k(oneSecond);
  assert.equal(out.length / 2, WHISPER_RATE, "one second in, one second out");
  assert.equal(oneSecond.length / 2, MIC_RATE);
});

test("the wav header describes the audio it wraps", () => {
  const wav = wavFromPcm(Buffer.alloc(1600), WHISPER_RATE);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(24), 16000, "whisper only accepts 16 kHz");
  assert.equal(wav.readUInt16LE(34), 16, "PCM16");
  assert.equal(wav.readUInt32LE(40), 1600, "data length matches");
});

// --- the listening loop --------------------------------------------------------------------

// Feed audio in small chunks, the way a real mic delivers it.
async function feed(mic, ms, level, step = 40) {
  for (let sent = 0; sent < ms; sent += step) {
    mic.feed(pcm(step, level));
    await new Promise((r) => setTimeout(r, 1));
  }
}

test("the call opens when the name is said, and the recogniser gets the audio", async () => {
  const mic = fakeMic();
  const seen = [];
  const woke = waitForWakeWord({
    waitMs: 3000,
    words: "claudio",
    level: 3,
    speechMs: 100,
    utteranceSilenceMs: 150,
    startMic: mic,
    recognize: async (buf) => {
      seen.push(buf);
      return "claudio";
    },
  });
  await feed(mic, 400, 40); // someone speaks
  await feed(mic, 300, 0); // then stops
  assert.equal(await woke, true);
  assert.equal(seen.length, 1, "one utterance, read once");
  assert.ok(seen[0].length > 0);
});

test("noise that isn't the name is discarded and the wait continues", async () => {
  const mic = fakeMic();
  const heard = [];
  const woke = waitForWakeWord({
    waitMs: 4000,
    words: "claudio",
    level: 3,
    speechMs: 100,
    utteranceSilenceMs: 150,
    startMic: mic,
    recognize: async () => (heard.length === 0 ? (heard.push(1), "che ore sono") : "claudio"),
    onHeard: (h) => heard.push(h.matched),
  });
  await feed(mic, 400, 40); // the room, not you
  await feed(mic, 300, 0);
  await new Promise((r) => setTimeout(r, 60));
  await feed(mic, 400, 40); // now you
  await feed(mic, 300, 0);
  assert.equal(await woke, true, "the second utterance opens it");
  assert.ok(heard.includes(false), "the first was judged and rejected, not ignored");
});

test("silence for the whole wait returns false without ever calling the recogniser", async () => {
  const mic = fakeMic();
  let calls = 0;
  const woke = waitForWakeWord({
    waitMs: 250,
    words: "claudio",
    level: 3,
    speechMs: 100,
    startMic: mic,
    recognize: async () => (calls++, "claudio"),
  });
  await feed(mic, 200, 0); // room tone only
  assert.equal(await woke, false);
  assert.equal(calls, 0, "a quiet room must cost nothing");
});

test("the recording carries the syllable that opened it", async () => {
  // Without a pre-roll whisper is handed the word with its first sound missing, which is
  // exactly the case it cannot recover from on a two-word name.
  const mic = fakeMic();
  let got = null;
  const woke = waitForWakeWord({
    waitMs: 3000,
    words: "claudio",
    level: 3,
    speechMs: 200, // needs 200ms of speech before it starts collecting
    prerollMs: 500,
    utteranceSilenceMs: 150,
    startMic: mic,
    recognize: async (buf) => ((got = buf), "claudio"),
  });
  await feed(mic, 400, 40);
  await feed(mic, 300, 0);
  await woke;
  // 48 bytes per ms: the capture must include the ~200ms that came before the trigger.
  assert.ok(got.length / 48 > 300, `expected the pre-roll to be included, got ${got.length / 48}ms`);
});

test("an abort ends the wait immediately", async () => {
  const mic = fakeMic();
  const ac = new AbortController();
  const woke = waitForWakeWord({
    waitMs: 10000,
    words: "claudio",
    startMic: mic,
    recognize: async () => "claudio",
    signal: ac.signal,
  });
  ac.abort();
  assert.equal(await woke, false);
  assert.ok(mic.mics.every((m) => m.stopped), "the microphone is released on the way out");
});

test("a recogniser that fails does not end the wait", async () => {
  const mic = fakeMic();
  let calls = 0;
  const woke = waitForWakeWord({
    waitMs: 4000,
    words: "claudio",
    level: 3,
    speechMs: 100,
    utteranceSilenceMs: 150,
    startMic: mic,
    // What createWhisperRecognizer returns when the binary is missing or times out.
    recognize: async () => (++calls === 1 ? "" : "claudio"),
  });
  await feed(mic, 400, 40);
  await feed(mic, 300, 0);
  await new Promise((r) => setTimeout(r, 60));
  await feed(mic, 400, 40);
  await feed(mic, 300, 0);
  assert.equal(await woke, true, "a failed read is a miss, not the end of listening");
  assert.equal(calls, 2);
});

// --- what actually gets asked of whisper ---------------------------------------------------

test("the wake words are handed to the decoder as its initial prompt", async () => {
  // Straight from a live run: a real "Claudio" came back as "Vado!" — one shouted word carries
  // no context and the model reshapes it into something commoner. The initial prompt is the
  // lever against that, so it must actually reach the command line.
  const { createWhisperRecognizer } = await import("../src/wake.mjs");
  const recognize = createWhisperRecognizer({
    bin: "/bin/echo", // echoes its arguments, which become the "transcript"
    model: "/dev/null",
    lang: "it",
    words: "Claudio, vai Claudio",
  });
  const args = await recognize(pcm(200, 20));
  assert.match(args, /--prompt Claudio, vai Claudio/);
  assert.match(args, /-l it/);
});

test("with no wake words configured, no prompt is passed", async () => {
  const { createWhisperRecognizer } = await import("../src/wake.mjs");
  const recognize = createWhisperRecognizer({ bin: "/bin/echo", model: "/dev/null" });
  assert.doesNotMatch(await recognize(pcm(200, 20)), /--prompt/);
});

test("a missing model is reported instead of spawning anything", async () => {
  const { createWhisperRecognizer } = await import("../src/wake.mjs");
  const logged = [];
  const recognize = createWhisperRecognizer({ bin: "/bin/echo", model: "", log: (m) => logged.push(m) });
  assert.equal(await recognize(pcm(200, 20)), "");
  assert.match(logged.join(" "), /setup:wake/);
});
