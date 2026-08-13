import assert from "node:assert/strict";
import { test } from "node:test";
import { runCall } from "../src/call.mjs";

const OPTIONS = ["Apri la pull request", "Fai altri test"];

const cfg = {
  waitMs: 30000,
  maxTurns: 8,
  langCode: "it",
  retryLine: "Non ho sentito. Puoi ripetere?",
  confirmLine: "Non sono sicuro di quale hai scelto. Quale?",
};

// Fakes with a memory: every test asserts on what the modules were asked to do, which is the
// only way to tell "it worked" apart from "it returned something".
// `confirmed` is the SECOND reading, the one that never sees the router's verdict. Left unset
// it agrees with whatever the router claimed, so a test about something else is not silently
// about the cross-check; the tests that are about it say what the second reader heard.
function fakes({ armed = true, clicked = true, heard = [], routed = [], confirmed = [] } = {}) {
  let claimed = null;
  const log = { spoken: [], played: 0, reports: [] };
  return {
    log,
    audio: {
      arm: async (view) => {
        log.armed = view;
        return armed;
      },
      waitForButton: async () => clicked,
      play: async () => {
        log.played++;
        return { interrupted: false };
      },
      record: async () => Buffer.alloc(96),
      report: (r) => log.reports.push(r),
      close: async () => {},
    },
    tts: {
      speak: async (text) => {
        log.spoken.push(text);
        return Buffer.alloc(96);
      },
    },
    stt: { transcribe: async () => heard.shift() ?? "" },
    brain: {
      route: async () => {
        const r = routed.shift() ?? { kind: "decide", decision: { kind: "end" } };
        claimed = r?.decision?.optionIndex ?? null;
        return r;
      },
      confirmChoice: async ({ transcript, options }) => {
        log.confirmed = { transcript, options };
        return confirmed.length ? confirmed.shift() : claimed;
      },
    },
  };
}

test("nobody clicks: the call ends without a single paid call", async () => {
  const f = fakes({ clicked: false });
  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  assert.deepEqual(out, { kind: "end" });
  assert.equal(f.log.spoken.length, 0, "no synthesis");
  assert.equal(f.log.played, 0, "no playback");
});

test("no tab at all: the call ends rather than talking to nobody", async () => {
  const f = fakes({ armed: false });
  assert.deepEqual(
    await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg }),
    { kind: "end" },
  );
});

test("the opening line is spoken verbatim — no model rewrites it", async () => {
  const f = fakes({
    heard: ["la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  await runCall({ message: "m", options: OPTIONS, spoken: "Ho finito. Procedo?", modules: f, cfg });
  assert.equal(f.log.spoken[0], "Ho finito. Procedo?");
});

test("a picked option comes back as a validated choice", async () => {
  const f = fakes({
    heard: ["la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.deepEqual(out, { kind: "choice", value: "Apri la pull request" });
});

test("a choice that matches no offered option is downgraded, not acted on", async () => {
  const f = fakes({
    heard: ["fai come vuoi"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: "Cancella tutto" } }],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.equal(out.kind, "message", "Claude must never act on an option nobody offered");
});

test("a question keeps the call open and the answer is spoken", async () => {
  const f = fakes({
    heard: ["cosa hai cambiato?", "allora la seconda"],
    routed: [
      { kind: "speak", text: "Ho toccato quattro file." },
      { kind: "decide", decision: { kind: "choice", value: OPTIONS[1], optionIndex: 2 } },
    ],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  assert.deepEqual(f.log.spoken, ["s", "Ho toccato quattro file."]);
  assert.deepEqual(out, { kind: "choice", value: "Fai altri test" });
});

test("silence is asked to repeat, without spending a turn on the model", async () => {
  const f = fakes({
    heard: ["", "la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.deepEqual(f.log.spoken, ["s", "Non ho sentito. Puoi ripetere?"]);
});

test("a transcript in the wrong alphabet is treated as silence, not as an answer", async () => {
  // A real call: an Italian turn came back as Korean and a decision was built on it. It must
  // never reach the brain — that is what makes it look like a considered answer.
  let routeCalls = 0;
  const f = fakes({ heard: ["정답.", "la prima"], confirmed: [1] });
  f.brain.route = async () => {
    routeCalls++;
    return { kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } };
  };

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  assert.equal(routeCalls, 1, "the garbled turn never got routed");
  assert.deepEqual(f.log.spoken, ["s", cfg.retryLine]);
  assert.deepEqual(out, { kind: "choice", value: "Apri la pull request" });
});

test("the two readings disagree about which option: neither wins", async () => {
  // "ho detto la prima e ha fatto la terza": the failure the whole project started from. The
  // router says option 2; the second reading, which never saw that, hears option 1.
  const f = fakes({
    heard: ["la prima", "la prima, dicevo"],
    confirmed: [1, 1],
    routed: [
      { kind: "decide", decision: { kind: "choice", value: OPTIONS[1], optionIndex: 2 } },
      { kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } },
    ],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  assert.deepEqual(f.log.spoken, ["s", cfg.confirmLine], "it asked instead of guessing");
  assert.deepEqual(out, { kind: "choice", value: "Apri la pull request" });
});

test("an empty answer from the brain is asked again, not reported as a decision", async () => {
  const f = fakes({
    heard: ["la prima", "la prima"],
    routed: [
      { kind: "empty" },
      { kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } },
    ],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  assert.deepEqual(f.log.spoken, ["s", cfg.retryLine]);
  assert.deepEqual(out, { kind: "choice", value: "Apri la pull request" });
});

test("a conversation that never lands is closed by the turn ceiling", async () => {
  const f = fakes({
    heard: Array(20).fill("e poi?"),
    routed: Array(20).fill({ kind: "speak", text: "Dimmi." }),
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.deepEqual(out, { kind: "end" });
  assert.ok(f.log.spoken.length <= cfg.maxTurns + 1, "a runaway conversation is a runaway bill");
});

test("the page gets a receipt of what went back to Claude", async () => {
  const f = fakes({
    heard: ["la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  const r = f.log.reports.at(-1);
  assert.equal(r.decision.kind, "choice");
  assert.equal(r.heard, "la prima");
});

test("an aborted call goes quiet and returns end", async () => {
  const ac = new AbortController();
  const f = fakes({ heard: ["la prima"] });
  f.audio.record = async () => {
    ac.abort();
    return Buffer.alloc(96);
  };

  const out = await runCall({
    message: "m",
    options: OPTIONS,
    spoken: "s",
    signal: ac.signal,
    modules: f,
    cfg,
  });
  assert.deepEqual(out, { kind: "end" });
});

test("a call that cannot open tells Claude why, with the URL", async () => {
  // stderr is a log nobody reads. On a headless machine the terminal is the only place the
  // user will ever see the address of the tab, and Claude is the one who writes there.
  const f = fakes({ armed: false });
  f.audio.hint = () => "Open http://127.0.0.1:8787/?t=abc and allow the microphone once.";

  const decision = await runCall({ message: "m", options: OPTIONS, modules: f, cfg });

  assert.equal(decision.kind, "end");
  assert.match(decision.note, /127\.0\.0\.1:8787/);
});

test("an audio backend with no hint still just ends", async () => {
  const decision = await runCall({ message: "m", modules: fakes({ armed: false }), cfg });
  assert.deepEqual(decision, { kind: "end" });
});

// The whole point of the project, in one case. The user declined every option; the brain
// reported a pick anyway. Claude must receive the sentence, not the option.
test("an invented choice becomes the user's own words", async () => {
  const said = "per il momento evitiamo l'injection del prompt, facciamo il resto";
  const f = fakes({
    heard: [said],
    confirmed: [null], // the second reading hears a refusal, not a pick
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.deepEqual(out, { kind: "message", value: said });
  assert.deepEqual(
    f.log.confirmed,
    { transcript: said, options: OPTIONS },
    "the second reader gets the words and the options, and nothing else",
  );
  assert.equal(f.log.spoken.length, 1, "it does not make the user repeat a clear sentence");
});

// The mirror of it: a choice both readings hear goes through untouched.
test("a choice both readings agree on survives", async () => {
  const f = fakes({
    heard: ["facciamo la seconda"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[1], optionIndex: 2 } }],
  });

  assert.deepEqual(await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg }), {
    kind: "choice",
    value: OPTIONS[1],
  });
});

// Asking for detail keeps the call alive: the brain answers from Claude's full text and the
// loop comes back for another turn instead of handing the question to Claude.
test("a clarification is answered out loud, not escalated", async () => {
  const f = fakes({
    heard: ["spiegami meglio la seconda", "va bene, la seconda"],
    routed: [
      { kind: "speak", text: "La seconda rifà i test da capo, senza toccare la prima." },
      { kind: "decide", decision: { kind: "choice", value: OPTIONS[1], optionIndex: 2 } },
    ],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.deepEqual(out, { kind: "choice", value: OPTIONS[1] });
  assert.deepEqual(f.log.spoken, [
    "s",
    "La seconda rifà i test da capo, senza toccare la prima.",
  ]);
});

// A second opinion that cannot be obtained is not a licence to act. Both of these used to be
// impossible to get wrong only because the check was local; now it is a network call.
test("a choice with no second reading available never reaches Claude", async () => {
  const f = fakes({
    heard: ["la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });
  delete f.brain.confirmChoice;

  assert.deepEqual(await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg }), {
    kind: "message",
    value: "la prima",
  });
});

test("a second reading that throws costs a message, not the call", async () => {
  const f = fakes({
    heard: ["la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });
  f.brain.confirmChoice = async () => {
    throw new Error("provider down");
  };

  assert.deepEqual(await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg }), {
    kind: "message",
    value: "la prima",
  });
});

// Nothing in the second reading is spelled in any particular language: it is asked in whatever
// the user speaks, and answers with a number. This is the case the word lists could not do.
test("an option picked in German, named in no source file", async () => {
  const f = fakes({
    heard: ["nimm die zweite Möglichkeit"],
    confirmed: [2],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[1], optionIndex: 2 } }],
  });

  assert.deepEqual(await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg }), {
    kind: "choice",
    value: "Fai altri test",
  });
});
