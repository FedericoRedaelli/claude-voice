// The browser backend, exercised without a browser: a plain `ws` client stands in for the
// page. What this pins down is the CONTRACT between Node and the tab — mic frames arriving,
// playback frames leaving, drain being answered by the page rather than guessed from byte
// counts, and the mic staying off while nobody is listening. The acoustic echo cancellation
// itself is the browser's job and is not testable from here; everything around it is.

import { strict as assert } from "node:assert";
import test, { after } from "node:test";
import { WebSocket } from "ws";

process.env.VOICE_BROWSER_OPEN = "0"; // never launch a real browser from the test suite
process.env.VOICE_BROWSER_PORT = "8799";

const {
  ensureBrowserAudio,
  browserAudioUrl,
  shutdownBrowserAudio,
  startMic,
  createSpeaker,
} = await import("../src/browser-audio.mjs");

// A stand-in page: speaks the same protocol, keeps what it was sent, answers drain requests.
function fakePage(url) {
  const ws = new WebSocket(url.replace("http://", "ws://").replace("/?", "/ws?"));
  ws.binaryType = "nodebuffer";
  const played = [];
  const control = [];
  let queuedFrames = 0;
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      played.push(Buffer.from(data));
      queuedFrames++;
      return;
    }
    const msg = JSON.parse(String(data));
    control.push(msg);
    if (msg.t === "clear") queuedFrames = 0;
    // The real worklet answers when its queue empties; here that is immediate, which is
    // enough to prove Node waits for the page instead of a timer.
    if (msg.t === "drain") ws.send(JSON.stringify({ t: "drained" }));
  });
  return {
    ws,
    played,
    control,
    queued: () => queuedFrames,
    open: () => new Promise((r) => ws.once("open", r)),
    speak: (buf) => ws.send(buf, { binary: true }),
    lastMic: () => [...control].reverse().find((m) => m.t === "mic"),
  };
}

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const ready = ensureBrowserAudio({ waitMs: 4000 });
// The URL only exists once the server is listening, which ensureBrowserAudio does first.
// Bounded on purpose: a sandbox that refuses to bind a port must fail this file in seconds
// with a readable message, not hang the whole suite forever.
for (let i = 0; i < 300 && !browserAudioUrl(); i++) await settle(10);
assert.ok(
  browserAudioUrl(),
  "the bridge never started listening — if this is a sandbox, it is blocking localhost ports",
);
const page = fakePage(browserAudioUrl());
await page.open();
assert.equal(await ready, true, "a connected tab means the browser backend is usable");

after(() => shutdownBrowserAudio());

test("the page's microphone frames reach startMic", async () => {
  const got = [];
  const mic = startMic((buf) => got.push(buf));
  await settle();
  page.speak(Buffer.from([1, 0, 2, 0, 3, 0]));
  await settle();
  mic.stop();
  assert.equal(got.length, 1);
  assert.deepEqual([...got[0]], [1, 0, 2, 0, 3, 0]);
});

test("the microphone is only on while something is listening", async () => {
  const mic = startMic(() => {});
  await settle();
  assert.equal(page.lastMic().on, true, "a listener turns the page's mic on");
  mic.stop();
  await settle();
  assert.equal(page.lastMic().on, false, "the last listener leaving turns it off again");
});

test("a stopped mic stops delivering, so a finished turn can't be fed stale audio", async () => {
  const got = [];
  const mic = startMic((buf) => got.push(buf));
  await settle();
  mic.stop();
  await settle();
  page.speak(Buffer.from([9, 0]));
  await settle();
  assert.equal(got.length, 0);
});

test("speaker writes reach the page as binary frames", async () => {
  const before = page.played.length;
  const spk = createSpeaker();
  spk.write(Buffer.alloc(480 * 2)); // 20 ms of silence
  await settle();
  assert.equal(page.played.length, before + 1);
  assert.equal(page.played.at(-1).length, 960);
  await spk.stop();
});

test("remainingMs is derived from the audio handed over, at 24 kHz", async () => {
  const spk = createSpeaker();
  spk.write(Buffer.alloc(48000)); // exactly one second of PCM16 @ 24 kHz
  const left = spk.remainingMs();
  assert.ok(left > 900 && left <= 1000, `expected ~1000 ms of pending audio, got ${left}`);
  assert.ok(spk.playingUntil() > Date.now());
  await spk.stop();
});

test("stop() waits for the page to report the audio was actually heard", async () => {
  const spk = createSpeaker();
  spk.write(Buffer.alloc(48000));
  await spk.stop();
  assert.ok(
    page.control.some((m) => m.t === "drain"),
    "Node must ask the page when playback finished, not estimate it",
  );
  assert.equal(spk.remainingMs(), 0);
});

test("an immediate stop clears the page's queue instead of playing it out", async () => {
  const spk = createSpeaker();
  spk.write(Buffer.alloc(48000));
  await settle();
  assert.ok(page.queued() > 0);
  await spk.stop({ immediate: true });
  await settle();
  assert.equal(page.queued(), 0, "Esc must cut the audio, not wait for it");
});

test("a new turn starts by dropping whatever the previous one left queued", async () => {
  const spk = createSpeaker();
  spk.write(Buffer.alloc(48000));
  await settle();
  const cleared = page.control.filter((m) => m.t === "clear").length;
  createSpeaker();
  await settle();
  assert.equal(page.control.filter((m) => m.t === "clear").length, cleared + 1);
  await spk.stop({ immediate: true });
});

test("the page is not served without the token", async () => {
  const url = new URL(browserAudioUrl());
  const bad = await fetch(`${url.origin}/?t=wrong`);
  assert.equal(bad.status, 403, "any local process can reach 127.0.0.1 — the token is the gate");
  const good = await fetch(browserAudioUrl());
  assert.equal(good.status, 200);
  assert.match(await good.text(), /echoCancellation/, "the page must ask for the browser's AEC");
});

test("a websocket without the token is refused", async () => {
  const url = new URL(browserAudioUrl());
  const ws = new WebSocket(`ws://${url.host}/ws?t=wrong`);
  const outcome = await new Promise((resolve) => {
    ws.once("error", () => resolve("refused"));
    ws.once("open", () => resolve("accepted"));
  });
  assert.equal(outcome, "refused");
});

// --- the page as a control surface ---------------------------------------------------------

test("the page is told the wake word as soon as it connects", async () => {
  const hello = page.control.find((m) => m.t === "hello");
  assert.ok(hello, "a page that cannot read the wake word is a password you must remember");
  assert.ok("wakeWord" in hello);
});

test("the page's button reaches whoever is waiting on the gate", async () => {
  const { onManualStart } = await import("../src/browser-audio.mjs");
  let fired = 0;
  const off = onManualStart(() => fired++);
  page.ws.send(JSON.stringify({ t: "start" }));
  await settle();
  assert.equal(fired, 1, "a wake word that mishears you must not be the only way in");

  off();
  page.ws.send(JSON.stringify({ t: "start" }));
  await settle();
  assert.equal(fired, 1, "an unsubscribed listener stops hearing it");
});

test("the end-of-call report reaches the page", async () => {
  const { reportToPage } = await import("../src/browser-audio.mjs");
  reportToPage({
    decision: { kind: "choice", value: "Rebase su main" },
    heard: "la prima",
    message: "Ho finito il refactor.",
    options: ["Rebase su main", "Merge"],
  });
  await settle();
  const report = page.control.at(-1);
  assert.equal(report.t, "report");
  assert.deepEqual(report.decision, { kind: "choice", value: "Rebase su main" });
  assert.equal(report.heard, "la prima", "what you said is part of the receipt");
});

test("the page shows the wake word and offers a manual start", async () => {
  const html = await (await fetch(browserAudioUrl())).text();
  assert.match(html, /Avvia adesso/, "the always-works control");
  assert.match(html, /Per aprire la chiamata/, "what to say, in words");
  assert.match(html, /Ultima chiamata/, "where the receipt goes");
});
