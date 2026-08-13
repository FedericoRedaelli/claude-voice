// Audio backend that uses a browser tab as the sound card.
//
// WHY THIS EXISTS: raw local capture has no acoustic echo cancellation, so the agent's own
// voice comes back in through the microphone and reads as the user interrupting. A browser
// has AEC built in — one flag on getUserMedia hands us the same WebRTC echo canceller Google
// Meet uses — so moving capture and playback into a page buys real barge-in on laptop
// speakers, with no headphones.
//
// The models stay in Node. The page is a dumb pair of ears and a mouth: PCM16 mono @ 24 kHz
// over a localhost websocket, in both directions. In particular the API key never leaves this
// process, which it would have to if the page called the provider itself.
//
// This file is the AudioIO implementation of the module registry. Everything it exports past
// createAudio is here because call.mjs, or a test, needs it by name.

import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import {
  SEEN_FILE,
  browserHost,
  browserPort,
  hasDisplay,
  loadOrCreateToken,
  pageUrl,
} from "../bridge-url.mjs";
import { config } from "../config.mjs";
import { beepPcm, durationMs, rmsPct } from "../pcm.mjs";

// Re-exported so the audio backend stays the one place the rest of the code imports from.
export { browserHost, browserPort, hasDisplay, loadOrCreateToken, pageUrl };

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "..", "public", "voice.html");
const log = (m) => process.stderr.write(`[claude-voice] audio/browser: ${m}\n`);

// One bridge per process. The MCP server is long-lived and the tab is meant to outlive a
// single talk_to_user call — reconnecting (and re-asking for microphone permission) on every
// question would be worse than the problem this file solves.
let bridge = null;

// A tab attached: remember when, for the next process to read.
function noteTabSeen(file = SEEN_FILE) {
  try {
    writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    // Losing this only costs an extra tab; it must never cost the call.
  }
}

// Milliseconds since a tab last attached, from any process. Infinity when none ever has.
export function msSinceTabSeen(file = SEEN_FILE) {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

function createBridge({ port = browserPort(), host = browserHost() } = {}) {
  const token = loadOrCreateToken();
  const micListeners = new Set();
  // The page's "Parla" button: the only way into a call. Kept as a listener set rather than a
  // single callback so an abandoned wait can unsubscribe without disarming the next one.
  const startListeners = new Set();
  let socket = null;
  let waiters = [];
  // Keyed by request id, not a plain list: an answer must only settle the question that asked
  // it. As a list, a stray "drained" — the page used to send one on every clear — resolved the
  // NEXT drain instead, so playback reported itself finished the moment it began.
  const drainWaiters = new Map();
  let drainSeq = 0;

  const html = readFileSync(PAGE, "utf8");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/") {
      res.writeHead(404).end("not found");
      return;
    }
    if (url.searchParams.get("t") !== token) {
      res.writeHead(403).end("bad token");
      return;
    }
    // Never cached. The URL and the token survive restarts on purpose, so without this the
    // browser happily serves yesterday's page against today's server — which is exactly what
    // happened: the tab still explained a wake word that had been deleted from the source,
    // and only the websocket messages looked current.
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, must-revalidate",
    });
    res.end(html);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/ws" || url.searchParams.get("t") !== token) {
      sock.destroy();
      return;
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      // Last tab wins: a stale tab left open from a previous run must not keep feeding us a
      // microphone nobody is looking at.
      //
      // The loser has to be TOLD, though, or it just reconnects. Every page retries every two
      // seconds, so with three tabs open on the same URL they take turns evicting each other
      // for as long as they are open — the log reads "tab connected / tab disconnected"
      // forever, and the cue plays into whichever tab is about to lose, which is why nothing
      // came out of the speakers.
      if (socket && socket !== ws) {
        try {
          socket.send(JSON.stringify({ t: "superseded" }));
          socket.close();
        } catch {
          /* ignore */
        }
      }
      socket = ws;
      ws.binaryType = "nodebuffer";
      log("tab connected");
      noteTabSeen();
      send({ t: "hello" });
      sendMicState();
      for (const r of waiters.splice(0)) r(true);

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          for (const cb of micListeners) cb(Buffer.from(data));
          return;
        }
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.t === "drained") {
          const settle = drainWaiters.get(msg.id);
          if (settle) {
            drainWaiters.delete(msg.id);
            settle();
          }
        }
        else if (msg.t === "start") {
          log("start requested from the page");
          for (const cb of [...startListeners]) cb();
        } else if (msg.t === "error") log(`page reported: ${msg.message}`);
        else if (msg.t === "ready") log(`page ready (mic @ ${msg.sampleRate} Hz)`);
      });
      ws.on("close", () => {
        if (socket === ws) socket = null;
        log("tab disconnected");
        // Nobody is going to answer a drain request from a closed tab.
        for (const [id, settle] of [...drainWaiters]) {
          drainWaiters.delete(id);
          settle();
        }
      });
      ws.on("error", (e) => log(`socket error: ${String(e?.message ?? e)}`));
    });
  });

  const send = (obj) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(obj));
  };
  const sendPcm = (buf) => {
    if (socket?.readyState === 1) socket.send(buf, { binary: true });
  };
  // The page only captures while somebody here is listening: an idle tab must not hold a
  // live microphone open.
  const sendMicState = () => send({ t: "mic", on: micListeners.size > 0 });

  const url = () => `http://127.0.0.1:${port}/?t=${token}`;

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });

  return {
    url,
    listen,
    connected: () => socket?.readyState === 1,
    // Resolves true once a tab is on the other end, false if none shows up in time.
    waitForTab(ms) {
      if (socket?.readyState === 1) return Promise.resolve(true);
      return new Promise((resolve) => {
        waiters.push(resolve);
        const t = setTimeout(() => {
          waiters = waiters.filter((w) => w !== resolve);
          resolve(false);
        }, ms);
        if (t.unref) t.unref();
      });
    },
    close() {
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
    addMic(cb) {
      micListeners.add(cb);
      sendMicState();
      return () => {
        micListeners.delete(cb);
        sendMicState();
      };
    },
    sendPcm,

    // What Claude is asking, for the page to show while it waits. The user reads the options
    // as well as hearing them: a list of four is hard to hold in your head from audio alone.
    ask: ({ spoken, options }) => send({ t: "ask", spoken, options: options || [] }),

    // Resolves true when the user presses the button, false when nobody does in time. This is
    // the entire trigger: no wake word, no level meter running in an empty room.
    waitForStart(ms) {
      send({ t: "armed", on: true });
      return new Promise((resolve) => {
        const done = (v) => {
          clearTimeout(t);
          startListeners.delete(onStart);
          send({ t: "armed", on: false });
          resolve(v);
        };
        const onStart = () => done(true);
        startListeners.add(onStart);
        const t = setTimeout(() => done(false), ms);
        if (t.unref) t.unref();
      });
    },

    report: (r) => send({ t: "report", ...r }),
    clear: () => send({ t: "clear" }),
    // Ask the page to tell us when the last sample has actually been HEARD. Estimating that
    // from bytes written is what clipped the agent's closing words before.
    drain(timeoutMs) {
      if (socket?.readyState !== 1) return Promise.resolve();
      const id = ++drainSeq;
      send({ t: "drain", id });
      return new Promise((resolve) => {
        drainWaiters.set(id, resolve);
        const t = setTimeout(() => {
          if (drainWaiters.delete(id)) {
            log(`drain ${id} timed out after ${timeoutMs} ms`);
            resolve();
          }
        }, timeoutMs);
        if (t.unref) t.unref();
      });
    },
  };
}

function openInBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch (err) {
    log(`could not open a browser (${String(err?.message ?? err)}) — open this yourself: ${url}`);
  }
}

// Start the bridge and make sure a tab is attached. Returns false when no tab showed up, so
// the caller can close the call rather than talk into silence.
export async function ensureBrowserAudio({
  waitMs = Number(process.env.VOICE_BROWSER_WAIT_MS) || 20000,
  reconnectMs = Number(process.env.VOICE_BROWSER_RECONNECT_MS) || 3000,
  // How long a tab seen once is assumed to still be there. Opening a second tab is worse than
  // waiting: the new one asks for the microphone again, while the call is already waiting.
  tabMemoryMs = Number(process.env.VOICE_BROWSER_TAB_MEMORY_MS) || 600000,
  autoOpen = hasDisplay(),
} = {}) {
  if (!bridge) {
    const b = createBridge();
    try {
      await b.listen();
    } catch (err) {
      log(`could not listen (${String(err?.message ?? err)})`);
      return false;
    }
    bridge = b;
  }
  if (bridge.connected()) return true;

  // Give a tab that is already open the chance to come back before opening another one. In
  // VOICE_DEV each call builds a fresh bridge, so "nothing is connected this millisecond" is
  // the normal state at the start of every call, and taking it to mean "there is no tab" is
  // what filled the browser with tabs that then fought each other. A tab seen recently — by
  // ANY process, which is the point of writing it down — is worth waiting the long wait for.
  const seenMs = msSinceTabSeen();
  const patience = seenMs < tabMemoryMs ? waitMs : reconnectMs;
  if (seenMs < tabMemoryMs) {
    log(`a tab was open ${Math.round(seenMs / 1000)}s ago — waiting for it rather than opening another`);
  }
  if (await bridge.waitForTab(patience)) {
    log("an open tab reconnected — not opening another one");
    return true;
  }

  if (autoOpen) {
    log(`opening ${bridge.url()} — leave that tab open, and allow the microphone once`);
    openInBrowser(bridge.url());
  } else {
    log(`waiting for a tab at ${bridge.url()}`);
  }
  const ok = await bridge.waitForTab(waitMs);
  if (!ok) log("no tab connected in time");
  return ok;
}

// Release the port. Only the tests and a deliberate shutdown need this — in normal use the
// bridge is meant to outlive individual calls so the tab keeps its microphone permission.
export async function shutdownBrowserAudio() {
  const b = bridge;
  bridge = null;
  await b?.close();
}

// Hands each PCM16 chunk from the page to onChunk; stop() ends it.
export function startMic(onChunk) {
  if (!bridge) {
    log("startMic called before the bridge was up — no audio will arrive");
    return { stop() {} };
  }
  const off = bridge.addMic(onChunk);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      off();
    },
  };
}

// How long to wait for the page to finish speaking, in wall clock.
//
// This used to be `durationMs(pcm) + 2000` capped at 20 s, and the cap was the bug. While the
// spoken lines were one or two sentences nothing ever reached it. The moment the brain started
// EXPLAINING — several sentences, twenty seconds and more of audio — the wait ran out while the
// tab was still talking: the call moved on, opened the microphone over the tail of its own
// sentence, heard nothing usable, and the next line began with a clear() that cut the sentence
// off mid-word. What you hear is the voice interrupting itself and then asking you to repeat.
//
// So the budget is proportional, with a floor for the short lines and a ceiling that exists
// only so a tab that has gone away cannot hang a call forever — a tab that CLOSES already
// settles the drain, so this ceiling is the dead-but-still-connected case alone.
export function drainBudgetMs(pcm, { floorMs = 3000, ceilingMs = 180000 } = {}) {
  const audioMs = durationMs(pcm);
  return Math.min(audioMs + Math.max(floorMs, audioMs * 0.25), ceilingMs);
}

// The recorder is the only part of this file worth a unit test, so it takes its mic as a
// parameter and knows nothing about websockets. An utterance is: wait for someone to start
// talking, keep everything from then on, and stop once they have been quiet long enough.
//
// Every duration here is counted in AUDIO time — millisecondsofPCM — never in wall clock. The
// chunks cross a websocket, so they arrive in bursts and gaps that have nothing to do with
// how long the user was quiet; measuring the pause with Date.now() means measuring the
// network. The wall clock is used for exactly one thing below: a mic that has gone silent as
// a device, and is therefore delivering no audio to count.
export function createRecorder({ startMic: mic }) {
  return {
    record({
      silenceMs = 800,
      minMs = 250,
      maxMs = 30000,
      onsetMs = 8000,
      level = 3,
      // Hysteresis. Deciding somebody has STARTED and deciding they are still going are two
      // different questions, and one threshold answered both: an unstressed syllable dipped
      // under it and the turn was cut mid-sentence — "Anche in questo caso non hai concluso
      // perché si" is a real transcript. Starting stays strict; continuing is lenient, because
      // the cost of the mistake is asymmetric. Cutting somebody off loses what they said.
      holdLevel = level / 2,
    } = {}) {
      return new Promise((resolve) => {
        const chunks = [];
        let speaking = false;
        let quietMs = 0;
        let spokenMs = 0;
        let heldMs = 0;
        let waitedMs = 0;
        let done = false;

        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(stuck);
          handle.stop();
          resolve(spokenMs >= minMs ? Buffer.concat(chunks) : Buffer.alloc(0));
        };

        const handle = mic((chunk) => {
          if (done) return;
          const ms = durationMs(chunk);
          const rms = rmsPct(chunk);
          const loud = speaking ? rms >= holdLevel : rms >= level;
          if (loud) {
            speaking = true;
            quietMs = 0;
            spokenMs += ms;
          } else if (!speaking) {
            // Nobody has started. Waiting the full maxMs for an answer that is not coming is
            // half a minute of the page apparently doing nothing, which reads as a crash —
            // and it is what happened after a stray noise cut the voice off mid-sentence.
            waitedMs += ms;
            if (waitedMs >= onsetMs) return finish();
          }
          // Everything from the first loud chunk onwards is kept, silence included: the pauses
          // inside a sentence are part of what the transcriber hears.
          if (speaking) {
            chunks.push(chunk);
            heldMs += ms;
            if (!loud) quietMs += ms;
            if (quietMs >= silenceMs || heldMs >= maxMs) finish();
          }
        });

        // A mic that stops delivering entirely cannot be caught by counting audio, because
        // there is none to count. This is the only wall-clock deadline in the file.
        const stuck = setTimeout(finish, maxMs + 2000);
        if (stuck.unref) stuck.unref();
      });
    },
  };
}

// The AudioIO implementation: the five things call.mjs is allowed to ask of a sound card.
export function createAudio({ cfg = config } = {}) {
  const recorder = createRecorder({ startMic });

  return {
    async arm({ spoken, options }) {
      const ok = await ensureBrowserAudio();
      if (!ok) return false;
      bridge.ask({ spoken, options });
      // The cue that says "Claude is waiting for you". It is the ONLY thing that happens
      // before the user clicks — no listening, no model loaded, nothing paid for.
      bridge.sendPcm(beepPcm({ freq: 880, ms: 160 }));
      return true;
    },

    // Waiting is a state, not a moment. The opening cue is one sound you had to be in the room
    // for; this keeps a soft pulse going for as long as the button is armed, so you can walk
    // back in and know something is waiting for you. It costs nothing but the tone — no
    // microphone, no model, nothing billed until the button is pressed.
    waitForButton(ms, { tickMs = cfg.waitTickMs, volume = cfg.waitTickVolume } = {}) {
      if (!bridge) return Promise.resolve(false);
      if (!tickMs) return bridge.waitForStart(ms);

      const timer = setInterval(
        () => bridge?.sendPcm(beepPcm({ freq: 660, ms: 90, volume })),
        tickMs,
      );
      if (timer.unref) timer.unref();
      return bridge.waitForStart(ms).finally(() => clearInterval(timer));
    },

    async play(pcm, { bargeInMs = cfg.bargeInMs, level = cfg.bargeInLevel } = {}) {
      if (!pcm?.length || !bridge) return { interrupted: false };
      bridge.clear();
      bridge.sendPcm(pcm);
      const budget = drainBudgetMs(pcm);

      // Off by default: with the microphone open during playback the voice cut itself off
      // partway through a sentence, which loses the question rather than answering it. Leaving
      // the mic shut here also means nothing is captured until it is actually our turn to
      // listen.
      if (!cfg.bargeIn) {
        await bridge.drain(budget);
        return { interrupted: false };
      }

      // The page has real echo cancellation, so the mic can stay open while we talk: what it
      // hears is the room, not us. That is the whole reason this backend exists.
      let loudFor = 0;
      let interrupted = false;
      const mic = startMic((chunk) => {
        loudFor = rmsPct(chunk) >= level ? loudFor + durationMs(chunk) : 0;
        if (loudFor >= bargeInMs && !interrupted) {
          interrupted = true;
          bridge.clear(); // stop mid-sentence: they are talking to us
        }
      });

      await bridge.drain(budget);
      mic.stop();
      return { interrupted };
    },

    record(opts) {
      return recorder.record({
        silenceMs: cfg.recordSilenceMs,
        minMs: cfg.recordMinMs,
        maxMs: cfg.recordMaxMs,
        onsetMs: cfg.recordOnsetMs,
        level: cfg.speechLevel,
        holdLevel: cfg.holdLevel,
        ...opts,
      });
    },

    // What to tell Claude when no tab ever attached. stderr goes to a log the user is not
    // reading; this rides back on the tool result, where Claude can put it in the terminal —
    // which on a headless box is the only place the URL can usefully appear.
    hint: () =>
      `No browser tab is attached to the voice bridge, so the call could not open. Open ` +
      `${pageUrl()} and allow the microphone once — the tab is the sound card. If this ` +
      `machine has no display, forward the port from yours first: ` +
      `ssh -L ${browserPort()}:127.0.0.1:${browserPort()} <user>@<host>`,

    report: (r) => bridge?.report(r),
    close: () => shutdownBrowserAudio(),
  };
}
