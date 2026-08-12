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
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "../config.mjs";
import { beepPcm, durationMs, rmsPct } from "../pcm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "..", "public", "voice.html");
// Beside .env, and gitignored for the same reason.
const TOKEN_FILE = process.env.VOICE_BROWSER_TOKEN_FILE || join(HERE, "..", "..", ".voice-bridge-token");

const log = (m) => process.stderr.write(`[claude-voice] audio/browser: ${m}\n`);

// One bridge per process. The MCP server is long-lived and the tab is meant to outlive a
// single talk_to_user call — reconnecting (and re-asking for microphone permission) on every
// question would be worse than the problem this file solves.
let bridge = null;

// The token that guards the bridge, kept across restarts.
//
// Anything running as this user can reach 127.0.0.1, so a token in the URL is what keeps a
// stray local page from opening our microphone or listening to the agent's audio. Minting a
// fresh one per process made every restart of the MCP server — which Claude Code does often —
// orphan the open tab: a new URL, a new tab, and the microphone permission asked for again.
// The page already retries its websocket every two seconds, so a stable token is the whole
// difference between "the tab survives a reload" and "you have nine dead tabs".
//
// Same standing as .env: user-only permissions, gitignored, never logged in full.
export function loadOrCreateToken(file = TOKEN_FILE) {
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch {
    // no file yet, or unreadable — mint a new one
  }
  const token = randomBytes(16).toString("hex");
  try {
    writeFileSync(file, `${token}\n`, { mode: 0o600 });
  } catch (err) {
    log(`could not persist the bridge token (${String(err?.message ?? err)}) — the tab will not survive a restart`);
  }
  return token;
}

function createBridge({ port = Number(process.env.VOICE_BROWSER_PORT) || 8787 } = {}) {
  const token = loadOrCreateToken();
  const micListeners = new Set();
  // The page's "Parla" button: the only way into a call. Kept as a listener set rather than a
  // single callback so an abandoned wait can unsubscribe without disarming the next one.
  const startListeners = new Set();
  let socket = null;
  let waiters = [];
  let drainWaiters = [];

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
        if (msg.t === "drained") for (const r of drainWaiters.splice(0)) r();
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
        for (const r of drainWaiters.splice(0)) r();
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
      server.listen(port, "127.0.0.1", () => resolve());
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
      send({ t: "drain" });
      return new Promise((resolve) => {
        drainWaiters.push(resolve);
        const t = setTimeout(() => {
          drainWaiters = drainWaiters.filter((w) => w !== resolve);
          resolve();
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
  autoOpen = process.env.VOICE_BROWSER_OPEN !== "0",
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

  // Give a tab that is already open the chance to come back before opening another one. It
  // retries every two seconds, and "not connected this millisecond" is not the same as "there
  // is no tab" — in VOICE_DEV each call builds a fresh bridge, so without this wait every
  // single call opened a new tab, and the tabs then fought each other over the connection.
  if (await bridge.waitForTab(reconnectMs)) {
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

    waitForButton(ms) {
      return bridge ? bridge.waitForStart(ms) : Promise.resolve(false);
    },

    async play(pcm, { bargeInMs = cfg.bargeInMs, level = cfg.bargeInLevel } = {}) {
      if (!pcm?.length || !bridge) return { interrupted: false };
      bridge.clear();
      bridge.sendPcm(pcm);

      // Listening while we talk costs nothing to get wrong in one direction and a whole turn
      // in the other, so it can be switched off entirely.
      if (cfg.bargeIn === false) {
        await bridge.drain(Math.min(durationMs(pcm) + 2000, 20000));
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

      await bridge.drain(Math.min(durationMs(pcm) + 2000, 20000));
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

    report: (r) => bridge?.report(r),
    close: () => shutdownBrowserAudio(),
  };
}
