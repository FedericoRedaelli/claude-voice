// Full-duplex barge-in (headphones): interrupting the agent must work, and NOT working must be
// the default for every noise that isn't someone talking. Cutting playback on every VAD blip
// is heard as "it interrupted me while I was answering" and as choppy speech.

process.env.VOICE_NO_ENV_FILE = "1";
process.env.OPENAI_API_KEY = "test-key";
process.env.VOICE_HALF_DUPLEX = "0"; // headphones: the mic stays open
process.env.VOICE_DEBUG = "0";
process.env.VOICE_WAIT_MS = "0";
process.env.VOICE_FOLLOWUP_MS = "0";
process.env.VOICE_BARGE_IN_MS = "150";
process.env.VOICE_SILENCE_MS = "100";
process.env.VOICE_MIN_ANSWER_MS = "1"; // note: 0 would fall back to the production default
process.env.VOICE_TIMEOUT_MS = "8000";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeRealtime, fakeSpeaker, fakeMic, pcm } from "./fakes.mjs";

const { runVoiceSession } = await import("../src/realtime.mjs");

const OPTIONS = ["commit", "apri una pull request", "vai avanti"];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function run(script) {
  // Every speaker the session creates, in order: the first is the one playing, and barge-in
  // replaces it with the next.
  const speakers = [];
  const mic = fakeMic();
  // An assertion that throws inside the script would otherwise vanish into an unhandled
  // rejection and the test would just hang until the timeout, telling you nothing.
  const ctl = fakeRealtime({
    onConnect: (c) =>
      queueMicrotask(() =>
        Promise.resolve(script(c, { speakers, mic })).catch((e) =>
          console.error(`SCRIPT FAILED: ${e.message}`),
        ),
      ),
  });
  const decision = runVoiceSession({
    message: "Fatto il refactor.",
    options: OPTIONS,
    deps: {
      createSession: ctl.createSession,
      // Barge-in replaces the speaker process: keep every one of them so the test can see
      // which was killed and which took over.
      createSpeaker: () => {
        const s = fakeSpeaker();
        speakers.push(s);
        return s;
      },
      startMic: mic,
      beepPcm: ({ ms = 100 } = {}) => pcm(ms, 10),
    },
  });
  return { decision, ctl, speakers, mic };
}

test("a cough does not cut the agent off", async () => {
  const { decision, ctl, speakers } = run(async (c) => {
    c.event("session.updated");
    c.speak(3000); // a long sentence, still playing
    const before = speakers.length;

    // VAD fires and stops again almost at once: a key press, a chair, a cough.
    c.event("input_audio_buffer.speech_started");
    await wait(60);
    c.event("input_audio_buffer.speech_stopped");
    await wait(300); // well past VOICE_BARGE_IN_MS

    assert.equal(speakers.length, before, "no speaker was replaced");
    assert.equal(speakers[0].state.killed, 0, "the agent kept its sentence");

    c.event("input_audio_buffer.committed");
    c.event("conversation.item.input_audio_transcription.completed", { transcript: "la prima" });
    await c.submit({ kind: "choice", value: "commit", optionIndex: 1 });
  });
  assert.deepEqual(await decision, { kind: "choice", value: "commit" });
});

test("someone who keeps talking does cut the agent off, at once", async () => {
  const { decision, ctl, speakers } = run(async (c) => {
    c.event("session.updated");
    c.speak(3000);
    const before = speakers.length;

    c.event("input_audio_buffer.speech_started"); // and they keep going
    await wait(300);

    assert.equal(speakers.length, before + 1, "playback was handed to a fresh speaker");
    assert.equal(speakers[0].state.killed, 1);
    assert.equal(speakers[0].state.immediate, true, "cut, not drained — they are talking NOW");

    c.event("input_audio_buffer.speech_stopped");
    c.event("input_audio_buffer.committed");
    c.event("conversation.item.input_audio_transcription.completed", { transcript: "la seconda" });
    await c.submit({ kind: "choice", value: OPTIONS[1], optionIndex: 2 });
  });
  assert.deepEqual(await decision, { kind: "choice", value: OPTIONS[1] });
});

test("full-duplex keeps sending the mic through while the agent talks", async () => {
  const { decision, ctl, mic } = run(async (c) => {
    c.event("session.updated");
    c.speak(500);
    // The session opens its mic only after connect() resolves.
    while (!mic.mics.length) await wait(5);
    mic.feed(pcm(100, 30));
    c.event("input_audio_buffer.speech_started");
    await wait(200);
    c.event("input_audio_buffer.speech_stopped");
    assert.ok(c.voicedMs() > 0, "no muting on headphones — that is the point of full-duplex");
    c.event("input_audio_buffer.committed");
    c.event("conversation.item.input_audio_transcription.completed", { transcript: "vai avanti" });
    await c.submit({ kind: "choice", value: OPTIONS[2], optionIndex: 3 });
  });
  assert.deepEqual(await decision, { kind: "choice", value: OPTIONS[2] });
});
