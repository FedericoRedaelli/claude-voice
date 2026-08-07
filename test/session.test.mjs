// End-to-end runs of runVoiceSession with a fake microphone, speaker and Realtime session:
// the real gate, the real mute logic, the real decision mapping, none of the real hardware.
//
// Each test is one of the failures the user actually hit in a live call.

// NOTE: config.mjs reads the environment at import time, and static ESM imports are evaluated
// before any statement in this file — so the module under test is imported dynamically, below,
// after these are set. Making them static silently gives you the production defaults (a 30s
// gate) and every test times out.
process.env.VOICE_NO_ENV_FILE = "1"; // never let a local .env decide a test outcome
process.env.OPENAI_API_KEY = "test-key";
process.env.VOICE_HALF_DUPLEX = "1";
process.env.VOICE_DEBUG = "0";
process.env.VOICE_WAIT_MS = "0"; // gate covered in gate.test.mjs
process.env.VOICE_FOLLOWUP_MS = "0";
process.env.VOICE_MIC_REOPEN_MS = "100";
process.env.VOICE_OPENING_GRACE_MS = "100";
process.env.VOICE_MIN_ANSWER_MS = "600";
process.env.VOICE_LANG = "Italian"; // so a Korean transcript is detectably wrong
process.env.VOICE_TRANSCRIPT_WAIT_MS = "800";
process.env.VOICE_SILENCE_MS = "100"; // trailing silence the fake VAD window includes
process.env.VOICE_TIMEOUT_MS = "8000";

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeRealtime, fakeSpeaker, fakeMic, pcm, until } from "./fakes.mjs";

const { runVoiceSession } = await import("../src/realtime.mjs");

const OPTIONS = ["Rifare da zero", "Migliorare quella esistente", "Farne una seconda"];
const MESSAGE = "Ho finito il refactor del login.";

// Wire a run up. `script` drives the model side once the session is connected.
function run(script, { options = OPTIONS, spoken = "" } = {}) {
  const speaker = fakeSpeaker();
  const mic = fakeMic();
  const ctl = fakeRealtime({ onConnect: (c) => queueMicrotask(() => script(c, { speaker, mic })) });
  const decision = runVoiceSession({
    message: MESSAGE,
    options,
    spoken,
    deps: {
      createSession: ctl.createSession,
      createSpeaker: () => speaker,
      startMic: mic,
      beepPcm: ({ ms = 100 } = {}) => pcm(ms, 10),
    },
  });
  return { decision, ctl, speaker, mic };
}

// How much of what the mic captured actually reached the API.
// Milliseconds of the user's VOICE that reached the API. A muted mic still streams silence, so
// this counts content, not bytes.
const sentMs = (ctl) => ctl.voicedMs();

test("clean run: agent speaks, user answers by position, the right option goes back", async () => {
  const { decision, ctl, mic } = run(async (c) => {
    c.event("session.updated"); // triggers the opening turn
    c.speak(400); // 0.4s of agent speech

    // The user talks over the tail — on speakers this is echo, so it must NOT reach the API.
    mic.feed(pcm(60, 40));
    assert.equal(sentMs(c), 0, "mic must be shut while the agent talks");

    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    await c.userTurn(900, "la prima");
    // The model reports the position; the text it attaches is WRONG on purpose — this is the
    // exact bug the user hit ("ho detto la prima, ha fatto la terza").
    c.submit({ kind: "choice", value: OPTIONS[2], optionIndex: 1 });
  });

  assert.deepEqual(await decision, { kind: "choice", value: "Rifare da zero" });
});

test("the agent cannot decide on its own before the user answers", async () => {
  const replies = [];
  const { decision, ctl, mic } = run(async (c) => {
    c.event("session.updated");
    c.speak(300);

    // Straight after its own question, with the user still silent.
    replies.push(await c.submit({ kind: "choice", value: OPTIONS[1], optionIndex: 2 }));

    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    // A cough: committed by VAD, but far too short to be an answer.
    await c.userTurn(150, "");
    replies.push(await c.submit({ kind: "choice", value: OPTIONS[1], optionIndex: 2 }));

    // Now a real answer.
    await c.userTurn(900, "la terza");
    replies.push(await c.submit({ kind: "choice", value: OPTIONS[2], optionIndex: 3 }));
  });

  assert.deepEqual(await decision, { kind: "choice", value: OPTIONS[2] });
  assert.match(replies[0], /^Rejected: the user has not said anything yet/);
  assert.match(replies[1], /^Rejected: you only heard a fragment/);
  assert.equal(replies[2], "Reported to Claude.");
});

test("a noisy room does not interrupt the agent or open a turn by itself", async () => {
  const { decision, ctl, mic, speaker } = run(async (c) => {
    c.event("session.updated");
    c.speak(500);

    // Room noise for the whole time the agent is speaking: keyboard, fan, someone talking.
    for (let i = 0; i < 20; i++) {
      mic.feed(pcm(25, 55));
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(sentMs(c), 0, "not one byte of noise reached the API while the agent spoke");
    // ...but the stream itself never stopped: silence keeps the server's VAD able to close a
    // turn instead of holding it open across the agent's whole reply.
    assert.ok(c.audioSent.length >= 15, "the muted mic still streams silence");
    // The API's own VAD fired anyway (leakage) — half-duplex must ignore it.
    c.emit("audio_interrupted");
    assert.equal(speaker.state.killed, 0, "the agent's audio must never be flushed mid-sentence");

    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    await c.userTurn(900, "vai con la seconda");
    c.submit({ kind: "choice", value: OPTIONS[1], optionIndex: 2 });
  });

  assert.deepEqual(await decision, { kind: "choice", value: OPTIONS[1] });
});

test("a decision reported before the transcript waits for it, and dies if it's noise", async () => {
  // Straight from a real call: the user's turn transcribed as "정답." in an Italian session —
  // the transcriber inventing words out of room noise — and the agent reported option 2 off it,
  // 0.2s BEFORE that transcript even existed.
  const replies = [];
  const { decision, ctl, mic } = run(async (c) => {
    c.event("session.updated");
    c.speak(200);
    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });

    await c.userTurn(900, "정답.", { transcriptDelayMs: 200 });
    replies.push(await c.submit({ kind: "choice", value: "", optionIndex: 2 }));

    await c.userTurn(900, "la seconda", { transcriptDelayMs: 200 });
    replies.push(await c.submit({ kind: "choice", value: "", optionIndex: 2 }));
  });

  assert.deepEqual(await decision, { kind: "choice", value: OPTIONS[1] });
  assert.match(replies[0], /^Rejected: what you heard did not transcribe as it/);
  assert.equal(replies[1], "Reported to Claude.");
});

test("a turn the API could not transcribe at all is not an answer", async () => {
  const replies = [];
  const { decision, ctl, mic } = run(async (c) => {
    c.event("session.updated");
    c.speak(200);
    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    await c.userTurn(900, "", { transcriptDelayMs: 150 });
    replies.push(await c.submit({ kind: "choice", value: "", optionIndex: 3 }));
    await c.userTurn(900, "la terza", { transcriptDelayMs: 150 });
    replies.push(await c.submit({ kind: "choice", value: "", optionIndex: 3 }));
  });
  assert.deepEqual(await decision, { kind: "choice", value: OPTIONS[2] });
  assert.match(replies[0], /^Rejected: what you heard did not transcribe/);
});

test("you say the third, the model reports the second: nothing is sent to Claude", async () => {
  // The whole reason this project got rebuilt. Two independent sources — what you said, and
  // what the model claims you chose — disagree, so neither is acted on.
  const replies = [];
  const { decision, ctl, mic } = run(async (c) => {
    c.event("session.updated");
    c.speak(200);
    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    await c.userTurn(900, "Sì, dicevo la terza", { transcriptDelayMs: 200 });
    replies.push(await c.submit({ kind: "choice", value: OPTIONS[1], optionIndex: 2 }));

    // It asks, you confirm, and now both agree.
    await c.userTurn(900, "sì, la terza", { transcriptDelayMs: 200 });
    replies.push(await c.submit({ kind: "choice", value: OPTIONS[2], optionIndex: 3 }));
  });

  assert.deepEqual(await decision, { kind: "choice", value: OPTIONS[2] });
  assert.match(replies[0], /the user said option 3, you reported option 2/);
  assert.match(replies[0], /confirm/, "and it is told to read option 3 back, not to guess");
  assert.equal(replies[1], "Reported to Claude.");
});

test("a mixed answer comes back as an instruction, not as an option", async () => {
  const { decision, ctl, mic } = run(async (c) => {
    c.event("session.updated");
    c.speak(200);
    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    await c.userTurn(1200, "la prima ma tieni i nomi della seconda");
    c.submit({ kind: "message", value: "la prima ma tieni i nomi della seconda" });
  });

  assert.deepEqual(await decision, {
    kind: "message",
    value: "la prima ma tieni i nomi della seconda",
  });
});

test("Esc silences the call at once: no drain, no closing beep", async () => {
  const ac = new AbortController();
  const speaker = fakeSpeaker();
  const mic = fakeMic();
  const ctl = fakeRealtime({
    onConnect: (c) =>
      queueMicrotask(() => {
        c.event("session.updated");
        c.speak(5000); // a long sentence, still playing
        setTimeout(() => ac.abort(), 20);
      }),
  });
  const decision = await runVoiceSession({
    message: MESSAGE,
    options: OPTIONS,
    signal: ac.signal,
    deps: {
      createSession: ctl.createSession,
      createSpeaker: () => speaker,
      startMic: mic,
      beepPcm: ({ ms = 100 } = {}) => pcm(ms, 10),
    },
  });

  assert.deepEqual(decision, { kind: "end" });
  assert.equal(speaker.state.immediate, true, "audio killed, not drained");
  assert.equal(ctl.closed, true, "the Realtime session is closed too");
  assert.equal(mic.mics.every((m) => m.stopped), true, "the mic is released");
});

test("the your-turn cue is played exactly once per agent turn", async () => {
  const { decision, ctl, mic, speaker } = run(async (c) => {
    c.event("session.updated");
    const before = speaker.state.writes.length;
    c.speak(300);
    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    // Keep the mic running well past the cue: it must not fire again.
    for (let i = 0; i < 10; i++) {
      mic.feed(pcm(20, 40));
      await new Promise((r) => setTimeout(r, 5));
    }
    const cues = () => speaker.state.writes.slice(before).filter((n) => n === 90 * 48).length;
    assert.equal(cues(), 1);
    await c.userTurn(900, "la seconda");
    c.submit({ kind: "choice", value: OPTIONS[1], optionIndex: 2 });

    // The call is over. The agent's answer to the user goes on playing for a moment, so the
    // mic re-opens once more — but inviting them to speak now is a lie.
    c.speak(80);
    for (let i = 0; i < 15; i++) {
      mic.feed(pcm(20, 40));
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(cues(), 1, "no your-turn cue after a decision was reported");
  });
  await decision;
});

test("the agent is told, in its own instructions, how long it may talk", async () => {
  const { decision, ctl, mic } = run(async (c) => {
    assert.match(c.instructions, /HARD LIMIT/);
    assert.match(c.instructions, /NEVER decide for the user/);
    // Options are numbered for it in the order Claude listed them.
    assert.match(c.instructions, /1\. Rifare da zero[\s\S]*2\. Migliorare quella esistente/);
    assert.equal(c.sessionConfig.audio.input.turnDetection.interrupt_response, false);
    // Faster delivery = a shorter window with the user's mic dead. 1.15 by default.
    assert.equal(c.sessionConfig.audio.output.speed, 1.15);
    // The transcriber is told what the answer is likely to be made of: positions in the
    // session's language, plus Claude's own option names.
    const prompt = c.sessionConfig.audio.input.transcription.prompt;
    assert.match(prompt, /la prima, la seconda, la terza/, "positional answers in Italian");
    for (const o of OPTIONS) assert.ok(prompt.includes(o), `option "${o}" is in the hint`);
    c.event("session.updated");
    c.speak(200);
    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    await c.userTurn(900, "basta");
    c.submit({ kind: "end" });
  });
  assert.deepEqual(await decision, { kind: "end" });
});

// --- the opening line Claude writes itself -------------------------------------------------
//
// The agent composing its own opening is what made the first turn run nine seconds with the
// microphone shut: it re-summarises Claude's whole message and adds its own framing, and on a
// half-duplex setup the user cannot answer until it stops. Handing it the exact line to read
// moves that editorial decision to Claude, which has the context to be brief.

const openingEvent = (ctl) => ctl.sentEvents.find((e) => e?.type === "response.create");

test("a supplied opening is handed over verbatim, as instructions for that turn only", async () => {
  const line = "Ho finito il refactor del login. Uno, rifare da zero; due, migliorare quella esistente; tre, farne una seconda. Quale?";
  const { decision, ctl, mic } = run(
    async (c) => {
      c.event("session.updated");
      c.speak(200);
      await until(() => {
        mic.feed(pcm(20, 40));
        return sentMs(c) > 0;
      });
      await c.userTurn(900, "basta");
      c.submit({ kind: "end" });
    },
    { spoken: line },
  );
  await decision;

  const open = openingEvent(ctl);
  assert.ok(open, "the session still opens by asking for a response");
  assert.ok(open.response?.instructions.includes(line), "the line reaches the model unedited");
  assert.match(open.response.instructions, /word for word/i);
  // Per-response instructions, not a session update: every LATER turn must go back to the
  // normal rules, or the agent would keep repeating this line.
  assert.equal(ctl.sentEvents.filter((e) => e?.type === "session.update").length, 0);
});

test("without a supplied opening the agent composes one, as before", async () => {
  const { decision, ctl, mic } = run(async (c) => {
    c.event("session.updated");
    c.speak(200);
    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    await c.userTurn(900, "basta");
    c.submit({ kind: "end" });
  });
  await decision;

  const open = openingEvent(ctl);
  assert.ok(open, "the opening turn is still requested");
  assert.equal(open.response, undefined, "no per-turn override: the session prompt governs");
});

test("a blank or whitespace-only opening is treated as no opening at all", async () => {
  const { decision, ctl, mic } = run(
    async (c) => {
      c.event("session.updated");
      c.speak(200);
      await until(() => {
        mic.feed(pcm(20, 40));
        return sentMs(c) > 0;
      });
      await c.userTurn(900, "basta");
      c.submit({ kind: "end" });
    },
    { spoken: "   \n  " },
  );
  await decision;
  assert.equal(openingEvent(ctl).response, undefined, "an empty line must not become a turn");
});

// --- the end of a run ----------------------------------------------------------------------
//
// Claude calling talk_to_user with no options is REPORTING, not asking. The rest of the prompt
// is written around choosing between alternatives, and without a counterweight the agent turns
// a summary into a question and refuses to hang up — which, hands-free, means a finished run
// keeps the call open until the timeout.

test("with no options the agent is told this is a report, and that agreement ends the call", async () => {
  const { decision, ctl, mic } = run(
    async (c) => {
      assert.match(c.instructions, /this is a REPORT, not a question/);
      assert.match(c.instructions, /Do not invent options/);
      assert.match(c.instructions, /is kind='end'/);
      c.event("session.updated");
      c.speak(200);
      await until(() => {
        mic.feed(pcm(20, 40));
        return sentMs(c) > 0;
      });
      await c.userTurn(900, "ok va bene");
      c.submit({ kind: "end" });
    },
    { options: [] },
  );
  assert.deepEqual(await decision, { kind: "end" });
});

test("with options offered, the report instructions stay out of the way", async () => {
  const { decision, ctl, mic } = run(async (c) => {
    assert.doesNotMatch(c.instructions, /this is a REPORT/);
    c.event("session.updated");
    c.speak(200);
    await until(() => {
      mic.feed(pcm(20, 40));
      return sentMs(c) > 0;
    });
    await c.userTurn(900, "la prima");
    c.submit({ kind: "choice", value: OPTIONS[0], optionIndex: 1 });
  });
  assert.deepEqual(await decision, { kind: "choice", value: OPTIONS[0] });
});
