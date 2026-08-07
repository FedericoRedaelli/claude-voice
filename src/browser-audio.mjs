// Audio backend that uses a browser tab as the sound card.
//
// WHY THIS EXISTS: sox gives us raw capture with no acoustic echo cancellation, so the
// agent's own voice comes back in through the microphone and reads as the user
// interrupting. The whole half-duplex design (mic muted while the agent talks) is a
// workaround for that missing AEC. A browser has AEC built in — one flag on getUserMedia
// hands us the same WebRTC echo canceller Google Meet uses — so moving capture and playback
// into a page buys real full-duplex barge-in on laptop speakers, with no headphones.
//
// The OpenAI session stays in Node. The page is a dumb pair of ears and a mouth: PCM16 mono
// @ 24 kHz over a localhost websocket, in both directions. In particular the API key never
// leaves this process, which it would have to if the page ran the Realtime session itself.
//
// The exported startMic/createSpeaker are drop-in replacements for the sox ones in
// audio.mjs — same shapes, same semantics — because realtime.mjs already injects both.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { waitForSpeech as gate } from "./audio.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "public", "voice.html");

// PCM16 mono @ 24 kHz = 48000 bytes per second of audio. Every duration below is derived
// from this, exactly as in audio.mjs.
const BYTES_PER_SEC = 48000;

const log = (m) => process.stderr.write(`[claude-voice] browser-audio: ${m}\n`);

// One bridge per process. The MCP server is long-lived and the tab is meant to outlive a
// single talk_to_user call — reconnecting (and re-asking for microphone permission) on every
// question would be worse than the problem this file solves.
let bridge = null;

function createBridge({ port = Number(process.env.VOICE_BROWSER_PORT) || 8787 } = {}) {
  // Anything running as this user can reach 127.0.0.1. A token in the URL keeps a stray
  // local page from opening our microphone or listening to the agent's audio.
  const token = randomBytes(16).toString("hex");
  const micListeners = new Set();
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
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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
      if (socket && socket !== ws) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }
      socket = ws;
      ws.binaryType = "nodebuffer";
      log("tab connected");
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
        else if (msg.t === "error") log(`page reported: ${msg.message}`);
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
    clear: () => send({ t: "clear" }),
    // Ask the page to tell us when the last sample has actually been HEARD. Estimating that
    // from bytes written is what clipped the agent's closing words in the sox path.
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
// the caller can fall back to sox rather than sit in silence.
export async function ensureBrowserAudio({
  waitMs = Number(process.env.VOICE_BROWSER_WAIT_MS) || 20000,
  autoOpen = process.env.VOICE_BROWSER_OPEN !== "0",
} = {}) {
  if (!bridge) {
    const b = createBridge();
    try {
      await b.listen();
    } catch (err) {
      log(`could not listen (${String(err?.message ?? err)}) — falling back to sox`);
      return false;
    }
    bridge = b;
  }
  if (bridge.connected()) return true;
  if (autoOpen) {
    log(`opening ${bridge.url()} — leave that tab open, and allow the microphone once`);
    openInBrowser(bridge.url());
  } else {
    log(`waiting for a tab at ${bridge.url()}`);
  }
  const ok = await bridge.waitForTab(waitMs);
  if (!ok) log("no tab connected in time — falling back to sox for this call");
  return ok;
}

export function browserAudioUrl() {
  return bridge?.url() ?? null;
}

// Release the port. Only the tests and a deliberate shutdown need this — in normal use the
// bridge is meant to outlive individual calls so the tab keeps its microphone permission.
export async function shutdownBrowserAudio() {
  const b = bridge;
  bridge = null;
  await b?.close();
}

// Same contract as audio.mjs's startMic: hands each PCM16 chunk to onChunk, stop() ends it.
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

// Same contract as audio.mjs's createSpeaker. The jitter buffer lives in the page (the
// worklet's queue IS one), so there is nothing to cushion here — but flush/rearm stay,
// because realtime.mjs calls them.
export function createSpeaker() {
  let alive = true;
  let endsAt = 0;
  if (bridge) bridge.clear(); // a new turn never plays the previous one's leftovers

  const write = (buf) => {
    if (!buf || !buf.length || !alive || !bridge) return;
    bridge.sendPcm(buf);
    endsAt = Math.max(Date.now(), endsAt) + (buf.length / BYTES_PER_SEC) * 1000;
  };

  return {
    write,
    flush() {},
    rearm() {},
    playingUntil() {
      return alive ? endsAt : 0;
    },
    remainingMs() {
      return alive ? Math.max(0, endsAt - Date.now()) : 0;
    },
    stop({ immediate = false } = {}) {
      if (!alive) return Promise.resolve();
      alive = false;
      const queued = Math.max(0, endsAt - Date.now());
      endsAt = 0;
      if (!bridge) return Promise.resolve();
      if (immediate) {
        bridge.clear();
        return Promise.resolve();
      }
      return bridge.drain(Math.min(queued + 2000, 20000));
    },
  };
}

// The passive pre-session gate is pure level detection over whatever mic it is given, so the
// sox implementation works unchanged — it just needs ours.
export function waitForSpeech(opts = {}) {
  return gate({ ...opts, startMic: opts.startMic || startMic });
}
