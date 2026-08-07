// The "beep, then wait for you to talk" gate, and the follow-up window that switches it off
// mid-conversation. Separate file because the follow-up window is module state that survives
// between calls — the tests below run in order and depend on that.

process.env.VOICE_NO_ENV_FILE = "1"; // never let a local .env decide a test outcome
process.env.OPENAI_API_KEY = "test-key";
process.env.VOICE_HALF_DUPLEX = "1";
process.env.VOICE_DEBUG = "0";
process.env.VOICE_WAIT_MS = "300";
process.env.VOICE_FOLLOWUP_MS = "5000";
process.env.VOICE_MIC_REOPEN_MS = "50";
process.env.VOICE_OPENING_GRACE_MS = "50";
process.env.VOICE_SILENCE_MS = "100";
process.env.VOICE_TIMEOUT_MS = "5000";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeRealtime, fakeSpeaker, fakeMic, pcm } from "./fakes.mjs";

const { runVoiceSession } = await import("../src/realtime.mjs");

const OPTIONS = ["uno", "due"];

// `spoke` decides what the (faked) passive listener reports.
function call(spoke, script = null) {
  const speaker = fakeSpeaker();
  const mic = fakeMic();
  const gateCalls = [];
  const ctl = fakeRealtime({
    onConnect: (c) => queueMicrotask(() => script?.(c, { speaker, mic })),
  });
  const decision = runVoiceSession({
    message: "Domanda.",
    options: OPTIONS,
    deps: {
      createSession: ctl.createSession,
      createSpeaker: () => speaker,
      startMic: mic,
      beepPcm: ({ ms = 100 } = {}) => pcm(ms, 10),
      waitForSpeech: async (args) => {
        gateCalls.push(args);
        return spoke;
      },
    },
  });
  return { decision, ctl, speaker, gateCalls };
}

test("nobody is at the desk: it beeps, waits, and never opens a paid session", async () => {
  const { decision, ctl, speaker, gateCalls } = call(false);
  assert.deepEqual(await decision, { kind: "end" });
  assert.equal(gateCalls.length, 1, "the gate ran");
  assert.equal(gateCalls[0].waitMs, 300);
  assert.equal(ctl.handleSubmit, null, "no Realtime session was ever created");
  assert.ok(speaker.state.writes.length >= 1, "but the user did get a beep");
});

test("you answer the beep: the call opens", async () => {
  const { decision, ctl, gateCalls } = call(true, async (c) => {
    c.event("session.updated");
    c.speak(150);
    await new Promise((r) => setTimeout(r, 300));
    await c.userTurn(900, "uno");
    c.submit({ kind: "choice", value: "uno", optionIndex: 1 });
  });
  assert.deepEqual(await decision, { kind: "choice", value: "uno" });
  assert.equal(gateCalls.length, 1);
});

test("a follow-up question right after skips the gate entirely", async () => {
  // Runs within VOICE_FOLLOWUP_MS of the call above finishing: you are still in the
  // conversation, so being asked to announce yourself again is what makes this unusable.
  const { decision, gateCalls } = call(false, async (c) => {
    c.event("session.updated");
    c.speak(100);
    await new Promise((r) => setTimeout(r, 250));
    await c.userTurn(900, "due");
    c.submit({ kind: "choice", value: "due", optionIndex: 2 });
  });
  assert.deepEqual(await decision, { kind: "choice", value: "due" });
  assert.equal(gateCalls.length, 0, "the gate was skipped — note `spoke` was false");
});
