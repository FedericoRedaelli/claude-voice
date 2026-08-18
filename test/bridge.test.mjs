// The websocket protocol, with a real socket.
//
// WHY THIS FILE EXISTS: call.mjs is testable with four fakes and no ports, and that is right —
// it must not know what a socket is. But browser.mjs IS the socket, and testing it without one
// means not testing it. Four defects shipped from this file in a single afternoon and the
// suite caught none of them, because everything it covered — the recorder, the pure functions —
// is the part that needs no port.
//
// The cost is kept to what it has to be: port 0, so the OS picks a free one and nothing
// collides; 127.0.0.1; an injected token, so the file the running session depends on is never
// touched; and every socket closed in the teardown.
//
// One consequence to know before you debug the wrong thing: these are the only tests in the
// suite that need a socket at all, so a sandbox that blocks loopback fails all eleven of them
// at once while the other ninety pass. That reads like a real regression and is not one.

import assert from "node:assert/strict";
import { test } from "node:test";
import WebSocket from "ws";
import { createBridge } from "../src/audio/browser.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";

// A bridge on a free port, and a guarantee it is gone afterwards even when the test throws.
async function withBridge(fn) {
  const bridge = createBridge({ port: 0, host: "127.0.0.1", token: TOKEN });
  await bridge.listen();
  const clients = [];
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port()}/ws?t=${TOKEN}`);
    clients.push(ws);
    const seen = [];
    const waiters = [];
    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? { t: "audio", bytes: data.length } : JSON.parse(String(data));
      seen.push(msg);
      for (const w of waiters.splice(0)) w(msg);
    });
    // Resolves with the first message of this type, past or future. Waiting only on future ones
    // is a race the fast messages win: `ask` can arrive before the test starts listening.
    const next = (t, ms = 2000) =>
      new Promise((resolve, reject) => {
        const found = seen.find((m) => m.t === t);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`no "${t}" within ${ms} ms`)), ms);
        waiters.push(function self(m) {
          if (m.t === t) {
            clearTimeout(timer);
            resolve(m);
          } else waiters.push(self);
        });
      });
    await new Promise((resolve) => ws.once("open", resolve));
    return { ws, seen, next, send: (o) => ws.send(JSON.stringify(o)) };
  };
  try {
    await fn({ bridge, connect });
  } finally {
    for (const c of clients) c.terminate();
    await bridge.close();
  }
}

// THE bug: the `drained` handler deleted the waiter, then settle() ran
// `if (drainWaiters.delete(id))`, got false, and never resolved. The call hung forever the
// moment it finished speaking — silently, because the timeout log was inside the same guard.
test("drain resolves when the page reports the audio has been heard", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    const drained = bridge.drain(2000);
    const ask = await tab.next("drain");
    tab.send({ t: "drained", id: ask.id });
    await drained; // hangs, and the test times out, if resolve() is skipped
  });
});

test("drain resolves when the tab goes away instead of answering", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    const drained = bridge.drain(5000);
    await tab.next("drain");
    tab.ws.terminate();
    await drained;
  });
});

// A long sentence must not be cut off just because it is long: every progress report from the
// page pushes the deadline back. Without the heartbeat the wait is a guess about duration.
test("a page that keeps reporting progress is not timed out", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    const drained = bridge.drain(300, { stallMs: 300 });
    const { id } = await tab.next("drain");
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 120));
      tab.send({ t: "draining", id, leftMs: 400 });
    }
    tab.send({ t: "drained", id });
    await drained;
  });
});

// The other half of the same rule: a tab that stops answering must not hold a call open.
test("a page that stops answering is given up on", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    const started = Date.now();
    await bridge.drain(200, { stallMs: 200 });
    assert.ok(Date.now() - started < 2000, "it gave up rather than waiting for a dead tab");
    assert.ok(tab.ws.readyState <= 1);
  });
});

// A tab can attach in the MIDDLE of a call: a reload, a laptop waking up, the page's own
// two-second retry. Everything it needs to answer was sent before it got there, so without a
// replay it comes back blank — no options, the button dead — and the call waits three minutes
// for an answer the user has no way to give.
test("a tab attaching mid-call is caught up on the question and the button", async () => {
  await withBridge(async ({ bridge, connect }) => {
    bridge.ask({ spoken: "Procedo?", options: ["Uno", "Due"] });
    const armed = bridge.waitForStart(5000);

    const late = await connect();
    const ask = await late.next("ask");
    assert.deepEqual(ask.options, ["Uno", "Due"]);
    assert.equal((await late.next("armed")).on, true);

    bridge.abandonStart();
    assert.equal(await armed, false);
  });
});

// And the mirror: replaying a question from a call that is over produces a page that looks
// alive and answers to nobody. Clicking it does nothing, which is indistinguishable from broken.
test("a question is not replayed once the call has been answered", async () => {
  await withBridge(async ({ bridge, connect }) => {
    bridge.ask({ spoken: "Procedo?", options: ["Uno", "Due"] });
    bridge.report({ decision: { kind: "choice", value: "Uno" } });

    const late = await connect();
    await late.next("hello");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(late.seen.some((m) => m.t === "ask"), false, "a dead question was replayed");
  });
});

test("a wait that ends with nobody pressing also clears the question", async () => {
  await withBridge(async ({ bridge, connect }) => {
    bridge.ask({ spoken: "Procedo?", options: ["Uno"] });
    assert.equal(await bridge.waitForStart(50), false);

    const late = await connect();
    await late.next("hello");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(late.seen.some((m) => m.t === "ask"), false);
  });
});

test("a click on the page comes back as the option index", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    const picked = bridge.waitForPick();
    tab.send({ t: "pick", index: 1 });
    assert.equal(await picked, 1);
  });
});

// Every call arms a fresh question. A resolver left behind by a call that is over would be
// woken by the next click and answer a question nobody asked.
test("a listener from a finished call is not woken by the next click", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    let stale = false;
    bridge.waitForPick().then(() => (stale = true));

    bridge.forgetPicks();
    const fresh = bridge.waitForPick();
    tab.send({ t: "pick", index: 0 });

    assert.equal(await fresh, 0);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(stale, false, "the old call's listener answered a click meant for the new one");
  });
});

// Last tab wins, and the loser has to be TOLD: every page retries every two seconds, so a
// loser that is not told just reconnects, and three tabs take turns evicting each other forever.
test("a second tab takes over and the first is told so", async () => {
  await withBridge(async ({ connect }) => {
    const first = await connect();
    await first.next("hello");
    const second = await connect();
    await second.next("hello");
    assert.equal((await first.next("superseded")).t, "superseded");
  });
});

test("a socket with the wrong token never becomes a tab", async () => {
  await withBridge(async ({ bridge }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port()}/ws?t=wrong`);
    await new Promise((resolve) => {
      ws.once("error", resolve);
      ws.once("close", resolve);
      ws.once("open", () => resolve(new Error("it opened")));
    });
    assert.equal(bridge.connected(), false);
  });
});

// The page has no configuration of its own, so anything it needs to know rides on the question.
test("the question carries whether the sounds play, and how loud", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    bridge.ask({ spoken: "Apro la PR?", options: ["Sì", "No"] });
    const ask = await tab.next("ask");
    assert.equal(ask.think.on, true);
    assert.ok(ask.think.volume > 0 && ask.think.volume < 0.3, "audible, and impossible to blast");
    assert.equal(ask.sfx.on, true);
    assert.ok(ask.sfx.volume > 0 && ask.sfx.volume <= 1);
  });
});

// The cues are named, not sent as audio: 250 KB of mp3 down the socket on every tick, for a
// sound the page can hold, is the version of this that fails on a slow tunnel.
test("a cue travels as a name and the loop as a switch", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    bridge.sfx("start");
    assert.equal((await tab.next("sfx")).name, "start");
    bridge.sfx("thinking", true);
    // `next` answers with the FIRST message of a type, past or future, so waiting for the
    // second one means waiting for it, not reading the array a millisecond too early.
    const cues = tab.seen.filter((m) => m.t === "sfx");
    while (cues.length < 2) {
      await new Promise((r) => setTimeout(r, 10));
      cues.splice(0, cues.length, ...tab.seen.filter((m) => m.t === "sfx"));
    }
    assert.deepEqual({ name: cues[1].name, on: cues[1].on }, { name: "thinking", on: true });
  });
});

// The media agent: a second kind of client, on the machine where the browser is. It is how a
// laptop driving a remote box gets its own music paused instead of the server's.
test("a media agent attaches on its own path and is told to pause and resume", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const agent = new WebSocket(`ws://127.0.0.1:${bridge.port()}/media?t=${TOKEN}`);
    const heard = [];
    agent.on("message", (d) => heard.push(JSON.parse(String(d))));
    await new Promise((r) => agent.once("open", r));
    while (bridge.mediaAgents() === 0) await new Promise((r) => setTimeout(r, 10));

    bridge.media("pause");
    bridge.media("resume");
    while (heard.length < 2) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(heard.map((m) => m.action), ["pause", "resume"]);
    assert.equal(heard[0].t, "media");
    agent.terminate();
  });
});

test("a media agent without the token never attaches", async () => {
  await withBridge(async ({ bridge }) => {
    const agent = new WebSocket(`ws://127.0.0.1:${bridge.port()}/media?t=wrong`);
    await new Promise((r) => agent.once("error", r).once("close", r));
    assert.equal(bridge.mediaAgents(), 0);
  });
});

// Silent mode is a property of the TAB: someone who cannot talk now cannot talk for the next
// question either, so the page states it and the server keeps it between calls.
test("the page can switch the voice off, and typed answers still arrive", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    assert.equal(bridge.isSilent(), false);

    tab.send({ t: "silent", on: true });
    while (!bridge.isSilent()) await new Promise((r) => setTimeout(r, 10));

    const typed = bridge.waitForText();
    tab.send({ t: "say", text: "  fai la seconda ma senza test  " });
    assert.equal(await typed, "fai la seconda ma senza test", "trimmed, and nothing else");

    tab.send({ t: "silent", on: false });
    while (bridge.isSilent()) await new Promise((r) => setTimeout(r, 10));
  });
});

test("an empty typed answer is not an answer", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    let woke = false;
    bridge.waitForText().then(() => (woke = true));
    tab.send({ t: "say", text: "   " });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(woke, false, "the call is still waiting for a real one");
  });
});

// Path traversal, on the one server in this project that serves files from disk.
test("the sounds are served, and only the sounds", async () => {
  await withBridge(async ({ bridge }) => {
    const base = `http://127.0.0.1:${bridge.port()}`;
    const ok = await fetch(`${base}/sounds/attention.wav?t=${TOKEN}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "audio/wav");
    assert.ok((await ok.arrayBuffer()).byteLength > 1000);

    assert.equal((await fetch(`${base}/sounds/attention.wav`)).status, 403, "no token, no sound");
    assert.equal((await fetch(`${base}/sounds/../../.env?t=${TOKEN}`)).status, 404);
    assert.equal((await fetch(`${base}/sounds/nope.mp3?t=${TOKEN}`)).status, 404);
  });
});

// A comment is the one message that outlives the call, so it is answered rather than assumed.
test("a comment typed on the page is acknowledged", async () => {
  await withBridge(async ({ bridge, connect }) => {
    const tab = await connect();
    bridge.report({ decision: { kind: "choice", value: "Sì" }, options: ["Sì", "No"] });
    tab.send({ t: "feedback", text: "" });
    const empty = await tab.next("feedbackSaved");
    assert.equal(empty.ok, false, "an empty comment is not a record");
  });
});
