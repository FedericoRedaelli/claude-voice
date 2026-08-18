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
  opener,
  pageUrl,
} from "../bridge-url.mjs";
import { config } from "../config.mjs";
import { pauseMedia } from "../media.mjs";
import { appendFeedback, buildRecord } from "../feedback.mjs";
import { durationMs, rmsPct } from "../pcm.mjs";

// Re-exported so the audio backend stays the one place the rest of the code imports from.
export { browserHost, browserPort, hasDisplay, loadOrCreateToken, pageUrl };

const HERE = dirname(fileURLToPath(import.meta.url));

// Which version produced a record. Read once, and never fatal: a feedback record without a
// version number is still worth having.
function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}
const PAGE = join(HERE, "..", "..", "public", "voice.html");
const SOUNDS = join(HERE, "..", "..", "public", "sounds");
const log = (m) => process.stderr.write(`[claude-voice] audio/browser: ${m}\n`);

// One bridge per process. The MCP server is long-lived and the tab is meant to outlive a
// single talk_to_user call — reconnecting (and re-asking for microphone permission) on every
// question would be worse than the problem this file solves.
let bridge = null;

// What to undo when the call ends. It is a function rather than a flag because only a pause
// that actually happened can hand back a resume — see media.mjs. Reset to a no-op the moment
// it is used, so a second close cannot start music nobody asked for.
let resumeMedia = () => {};

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

// A deadline that can be pushed back. The point of it being a separate, injectable thing is
// that the rule it enforces — "give up only when the page has gone quiet, not when a guessed
// duration runs out" — is testable without a browser, a port or a real second passing.
export function createDeadline({ ms, onExpire, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  const arm = (delay) => {
    if (timer) clearTimer(timer);
    timer = setTimer(onExpire, delay);
    if (timer?.unref) timer.unref();
  };
  arm(ms);
  return {
    extend: (delay) => arm(delay),
    cancel: () => {
      if (timer) clearTimer(timer);
      timer = null;
    },
  };
}

// What a "still speaking, this much left" report is worth in extra patience: the page's own
// count of queued audio, plus a quarter for scheduling, and never less than the stall window —
// below that we would be timing out a tab that is answering us.
export function patienceFor(leftMs, stallMs) {
  return Math.max(stallMs, Number(leftMs) > 0 ? leftMs * 1.25 : 0);
}

// Exported for the protocol tests. `port: 0` asks the OS for a free one and `token` skips the
// on-disk token, so a test can open a real socket without a fixed port or touching the file the
// running session depends on. Nothing else constructs this — normal use goes through
// ensureBrowserAudio, which owns the one-bridge-per-process rule.
export function createBridge({
  port = browserPort(),
  host = browserHost(),
  token = loadOrCreateToken(),
} = {}) {
  const micListeners = new Set();
  // The page's "Parla" button: the only way into a call. Kept as a listener set rather than a
  // single callback so an abandoned wait can unsubscribe without disarming the next one.
  const startListeners = new Set();
  // An option clicked on the page. Cleared at the start of every call: a listener belonging to
  // a call that is already over must not be woken by the next click, and it never unsubscribes
  // on its own because a click has no timeout to lose.
  const pickListeners = new Set();
  // Resolvers that settle an outstanding waitForStart with "no button". Something else answered
  // the question, so the press it is waiting for is never coming.
  const abandonListeners = new Set();
  // The question currently on the table, and whether the button is live. Kept because a tab can
  // attach in the MIDDLE of a call — a reload, a laptop waking up, the page's own two-second
  // retry — and everything it needs to answer was sent before it got here. Without this the
  // page comes back blank: no options to click, the button dead, and a call that goes on
  // waiting for three minutes for an answer the user has no way to give.
  let pendingAsk = null;
  let lastReport = null;
  let armed = false;
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
    // The token guards everything this server has, sounds included. Not because a cue is a
    // secret, but because one rule is auditable and two are how the exception grows.
    if (url.searchParams.get("t") !== token) {
      res.writeHead(403).end("bad token");
      return;
    }
    // The cues. A whitelist rather than a path join: `/sounds/../../.env` is the oldest bug in
    // static file serving, and there are four files here — none of them worth a traversal.
    if (url.pathname.startsWith("/sounds/")) {
      const name = url.pathname.slice("/sounds/".length);
      if (!/^[a-z0-9-]+\.(mp3|wav)$/.test(name)) {
        res.writeHead(404).end("not found");
        return;
      }
      let bytes;
      try {
        bytes = readFileSync(join(SOUNDS, name));
      } catch {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": name.endsWith(".wav") ? "audio/wav" : "audio/mpeg",
        // Unlike the page, these do not change between restarts, and re-fetching a quarter of
        // a megabyte at the start of every call would be silly.
        "cache-control": "public, max-age=3600",
      });
      res.end(bytes);
      return;
    }
    if (url.pathname !== "/") {
      res.writeHead(404).end("not found");
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
      // Catch the new tab up on the call it just walked into.
      if (pendingAsk) send({ t: "ask", ...pendingAsk });
      if (armed) send({ t: "armed", on: true });
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
        // Hand it to the waiter and let IT do the bookkeeping. Deleting the entry here as well
        // was fatal: settle() ends in a `if (drainWaiters.delete(id))` guard, so the second
        // delete returned false, resolve() was never called, and the call hung forever the
        // moment it finished speaking — with the timeout log inside the same guard, silently.
        // Hand it to the waiter and let IT do the bookkeeping. Deleting the entry here as well
        // was fatal: settle() ends in a `if (drainWaiters.delete(id))` guard, so the second
        // delete returned false, resolve() was never called, and the call hung forever the
        // moment it finished speaking — with the timeout log inside the same guard, silently.
        if (msg.t === "drained") drainWaiters.get(msg.id)?.settle();
        // The page is still speaking and has told us how much is left. Push the deadline back
        // by that much: the only party that knows when a sentence ends is the one playing it.
        else if (msg.t === "draining") {
          drainWaiters.get(msg.id)?.heartbeat(msg.leftMs);
        }
        else if (msg.t === "start") {
          log("start requested from the page");
          for (const cb of [...startListeners]) cb();
        }
        // An option clicked. The index is passed on as it arrived and validated against the
        // offered options by the caller, which is the only place that knows how many there were.
        else if (msg.t === "pick") {
          log(`option ${Number(msg.index) + 1} clicked on the page`);
          for (const cb of [...pickListeners]) cb(Number(msg.index));
        }
        // An optional developer comment about the call that just ended. It is the one message
        // the page sends that outlives the call, so it is answered rather than acted on: the
        // page needs to be told it landed, or the user retypes it.
        else if (msg.t === "feedback") {
          const saved = appendFeedback(
            buildRecord({ comment: msg.text, call: lastReport ?? {}, version: pluginVersion() }),
          );
          log(saved ? "feedback saved" : "feedback not saved (empty, or the file is not writable)");
          try {
            ws.send(JSON.stringify({ t: "feedbackSaved", ok: saved }));
          } catch {
            /* the tab went away between typing and sending */
          }
        } else if (msg.t === "error") log(`page reported: ${msg.message}`);
        else if (msg.t === "ready") log(`page ready (mic @ ${msg.sampleRate} Hz)`);
      });
      ws.on("close", () => {
        if (socket === ws) socket = null;
        log("tab disconnected");
        // Nobody is going to answer a drain request from a closed tab. Same rule as above:
        // settle() owns the deletion, so deleting here first would swallow the resolve.
        for (const w of [...drainWaiters.values()]) w.settle();
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

  // The port actually in use, which is only the requested one when it was not 0.
  let bound = port;
  const url = () => `http://127.0.0.1:${bound}/?t=${token}`;

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        bound = server.address()?.port ?? port;
        resolve();
      });
    });

  return {
    url,
    listen,
    port: () => bound,
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
    ask: ({ spoken, options }) => {
      // The waiting sound travels with the question: the page has no configuration of its own,
      // and this is the one message it is guaranteed to get before any waiting starts.
      pendingAsk = {
        spoken,
        options: options || [],
        think: { on: config.thinkSound, volume: config.thinkVolume },
        sfx: { on: config.sfxSound, volume: config.sfxVolume },
      };
      send({ t: "ask", ...pendingAsk });
    },

    // Resolves true when the user presses the button, false when nobody does in time. This is
    // the entire trigger: no wake word, no level meter running in an empty room.
    waitForStart(ms) {
      armed = true;
      send({ t: "armed", on: true });
      return new Promise((resolve) => {
        const done = (v) => {
          clearTimeout(t);
          startListeners.delete(onStart);
          abandonListeners.delete(onAbandon);
          armed = false;
          // Pressed: the question stays on the table, the conversation is about to happen.
          // Not pressed — timed out, or answered with a click — and it is over. Keeping it
          // would replay a dead question to the next tab that attaches, which looks alive and
          // answers to nobody.
          if (!v) pendingAsk = null;
          send({ t: "armed", on: false });
          resolve(v);
        };
        const onStart = () => done(true);
        const onAbandon = () => done(false);
        startListeners.add(onStart);
        abandonListeners.add(onAbandon);
        const t = setTimeout(() => done(false), ms);
        if (t.unref) t.unref();
      });
    },

    // Settle that wait now. Leaving it pending is not harmless: until it resolves, the page is
    // still told it is armed and the waiting cue keeps beeping every couple of seconds. So a
    // question answered with the mouse looked exactly like a question nobody had answered.
    abandonStart: () => {
      for (const cb of [...abandonListeners]) cb();
    },

    // Resolves with the index of an option clicked on the page, and otherwise never — a click
    // has no deadline of its own, it just loses the race to whatever else settles first.
    waitForPick() {
      return new Promise((resolve) => pickListeners.add(resolve));
    },
    // Called when a new question is armed. Without it every call would leave its own resolver
    // behind, and one click would wake all of them — including the ones whose call is long over.
    forgetPicks: () => pickListeners.clear(),

    // The receipt is the end of the call: whatever was on the table has been answered.
    report: (r) => {
      pendingAsk = null;
      // Kept so a comment typed on the page a minute later still has the call it is about.
      // The page could send it all back, but then what a record contains would be whatever a
      // tab decided to return, and a stale tab would file feedback about the wrong call.
      lastReport = r;
      send({ t: "report", ...r });
    },
    // A cue, by name. The page owns the sound; this owns WHEN — which is the half that has to
    // agree with the state of the call, and the half that is testable without a speaker.
    sfx: (name, on) => send({ t: "sfx", name, ...(on === undefined ? {} : { on })  }),
    clear: () => send({ t: "clear" }),
    // Ask the page to tell us when the last sample has actually been HEARD. Estimating that
    // from bytes written is what clipped the agent's closing words before.
    //
    // `timeoutMs` is not how long the audio is expected to take — the page reports that itself,
    // four times a second, and every report pushes the deadline back. It is the answer to a
    // different question: how long a tab may go silent before we accept it is not coming back.
    // A page too old to send those reports still gets the whole opening budget.
    drain(timeoutMs, { stallMs = 5000 } = {}) {
      if (socket?.readyState !== 1) return Promise.resolve();
      const id = ++drainSeq;
      send({ t: "drain", id });
      return new Promise((resolve) => {
        let beats = 0;
        const give = (why) => {
          if (drainWaiters.delete(id)) {
            deadline.cancel();
            if (why) log(why);
            resolve();
          }
        };
        const deadline = createDeadline({
          ms: timeoutMs,
          onExpire: () =>
            give(
              `drain ${id} gave up after ${beats} progress report${beats === 1 ? "" : "s"} — ` +
                `the tab stopped answering`,
            ),
        });
        drainWaiters.set(id, {
          settle: () => give(null),
          heartbeat: (leftMs) => {
            beats++;
            deadline.extend(patienceFor(leftMs, stallMs));
          },
        });
      });
    },
  };
}

// The browser is not always on this machine. `open`/`xdg-open` is only one of the answers;
// over VS Code remote the opener hands the URL to the editor on the user's own laptop, which
// opens it there and forwards the port for it. resolveOpener picks; this only runs the choice.
function openInBrowser(url, how = opener()) {
  if (!how) {
    log(`no way to open a browser from here — open this yourself: ${url}`);
    return;
  }
  try {
    const child = spawn(how.cmd, [...how.args, url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    // A missing command surfaces as an async error, not a throw: without this the user is told
    // a tab is opening and then waits out the whole timeout for a tab nobody ever asked for.
    child.on("error", (err) =>
      log(`${how.cmd} failed (${String(err?.message ?? err)}) — open this yourself: ${url}`),
    );
    child.unref();
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
  autoOpen = opener(),
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
    log(`opening ${bridge.url()} in ${autoOpen.where} — leave that tab open, and allow the microphone once`);
    openInBrowser(bridge.url(), autoOpen);
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

// The OPENING patience for a page that has not reported anything yet, in wall clock.
//
// It used to be the whole story: `durationMs(pcm) + 2000` capped at 20 s. The cap was the bug —
// while the spoken lines were one or two sentences nothing reached it, and the moment the brain
// started EXPLAINING the wait ran out mid-sentence, the microphone opened over the tail, and
// the next line's clear() cut the sentence off mid-word.
//
// It is no longer a guess at how long the audio takes: the page counts what it still has queued
// and says so four times a second, and each report pushes the deadline back (see drain()). This
// value only has to cover the gap before the FIRST report — and to be the whole budget for a
// cached page too old to send any.
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
      bridge.forgetPicks();
      bridge.ask({ spoken, options });
      // The cue that says "Claude is waiting for you". It is the ONLY thing that happens
      // before the user clicks — no listening, no model loaded, nothing paid for.
      bridge.sfx("start");
      return true;
    },

    // Waiting is a state, not a moment. The opening cue is one sound you had to be in the room
    // for; this keeps a soft pulse going for as long as the button is armed, so you can walk
    // back in and know something is waiting for you. It costs nothing but the tone — no
    // microphone, no model, nothing billed until the button is pressed.
    waitForButton(ms, { tickMs = cfg.waitTickMs, volume = cfg.waitTickVolume } = {}) {
      if (!bridge) return Promise.resolve(false);
      // The press, not the arming, is where other audio has to stop. A question can sit armed
      // for three minutes while you are in another room: pausing your music for all of it,
      // because Claude MIGHT be asked something, is not a trade anyone would accept.
      const pressed = (ok) => {
        if (ok) resumeMedia = pauseMedia();
        return ok;
      };
      if (!tickMs) return bridge.waitForStart(ms).then(pressed);

      const timer = setInterval(() => bridge?.sfx("attention"), tickMs);
      if (timer.unref) timer.unref();
      return bridge
        .waitForStart(ms)
        .finally(() => clearInterval(timer))
        .then(pressed);
    },

    // The models are running: transcription, then the brain. Nothing else can tell the page
    // this — the gap has no messages in it, which is exactly the problem the sound solves.
    // call.mjs calls it because call.mjs is the only file that knows when a model is running.
    working: (on) => bridge?.sfx("thinking", !!on),

    // The mouse path into the same call. Never resolves when there is no bridge, which is what
    // makes it safe to race against everything else.
    waitForPick: () => bridge?.waitForPick() ?? new Promise(() => {}),

    // Stop waiting for the button. Called when something else has already answered.
    abandonWait: () => bridge?.abandonStart(),

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

    report: (r) => {
      // The call is over: whatever was playing before it gets its turn back.
      resumeMedia();
      resumeMedia = () => {};
      bridge?.report(r);
    },
    // A call that ends without a receipt — an abort, a timeout, Claude Code quitting — must
    // put the music back too. This is the path a crash takes, and silence-forever is exactly
    // the failure that would make the whole feature not worth having.
    close: () => {
      resumeMedia();
      resumeMedia = () => {};
      return shutdownBrowserAudio();
    },
  };
}
