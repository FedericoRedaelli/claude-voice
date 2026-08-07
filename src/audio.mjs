// Mic capture + speaker playback via `sox`. Machine-specific — if device selection
// misbehaves, this is the only file to touch. Everything else treats audio as raw PCM16
// mono @ 24 kHz (little-endian signed), which is what the Realtime API expects.

import { spawn } from "node:child_process";
import { createJitterBuffer } from "./jitter.mjs";

const RATE = "24000";
const RAW = ["-t", "raw", "-b", "16", "-e", "signed-integer", "-r", RATE, "-c", "1"];

// sox reports a device name it cannot resolve as "there is no default audio device
// configured", which sends you looking at your system settings instead of at the name you
// typed. Say what actually happened.
function deviceHint(device, text) {
  if (!device || !/no default audio device|can't open|cannot open|unknown/i.test(text)) return "";
  return (
    `[claude-voice] ...sox could not use a device called ${JSON.stringify(device)}. ` +
    `Run \`npm run audio\` for the exact names — they follow your system language ` +
    `("Microfono MacBook Air", not "MacBook Air Microphone") — or unset ` +
    `VOICE_IN_DEVICE/VOICE_OUT_DEVICE to fall back to the system default.\n`
  );
}

function fail(err) {
  if (err && err.code === "ENOENT") {
    return new Error(
      "`sox` not found. Install it (`brew install sox` / `apt-get install sox`), " +
        "or run with VOICE_MODE=text.",
    );
  }
  return err;
}

// Capture default input device as raw PCM16 and hand each chunk (a Buffer) to onChunk.
// sox's `-d` is ONE default device for both directions, which is wrong the moment input and
// output are different pieces of hardware — headphones out, laptop mic in.
//
// A named device is selected by giving the DRIVER and the name in place of `-d`
// (`-t coreaudio "Microfono MacBook Air"`). Not via AUDIODEV: sox's own documentation points
// at that variable, but setting it makes sox refuse to start with "Sorry, there is no default
// audio device configured" — verified on macOS/homebrew sox, where `-t coreaudio <name>`
// records happily and AUDIODEV fails outright.
const DRIVER = process.env.VOICE_AUDIO_DRIVER || (process.platform === "darwin" ? "coreaudio" : "alsa");
const inputArgs = (device) => (device ? ["-t", DRIVER, device] : ["-d"]);
const outputArgs = (device) => (device ? ["-t", DRIVER, device] : ["-d"]);

export function startMic(onChunk, { device = process.env.VOICE_IN_DEVICE } = {}) {
  let stopped = false;
  let fellBack = !device;
  let proc;
  const start = (dev) => {
    proc = spawn("sox", ["-q", ...inputArgs(dev), ...RAW, "-"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // A spawn error (e.g. sox missing) must NOT throw here — that would be an uncaught async
    // exception. Log it; the agent can still speak even if the mic is unavailable.
    proc.on("error", (err) =>
      process.stderr.write(`[claude-voice] mic (sox) error: ${fail(err).message}\n`),
    );
    proc.stderr.on("data", (d) =>
      process.stderr.write(`[claude-voice] mic sox: ${d}${deviceHint(dev, String(d))}`),
    );
    // A name that doesn't resolve must cost you the device, not the call: retry once on the
    // system default. A mic that silently never opens looks exactly like a mic that hears
    // nothing, which is the hardest failure to diagnose from the far side of a phone call.
    proc.on("close", (code) => {
      if (code && !fellBack && !stopped) {
        fellBack = true;
        process.stderr.write(
          `[claude-voice] mic: ${JSON.stringify(dev)} could not be opened — ` +
            `falling back to the system default input.\n`,
        );
        start(null);
      }
    });
    proc.stdout.on("data", (buf) => onChunk(buf));
  };
  start(device);
  return {
    stop() {
      stopped = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    },
  };
}

// RMS level (0-100) of a PCM16 chunk. Silence in a quiet room reads well under 1%; a voice
// at laptop-mic distance reads in the teens.
export function rmsPct(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return (Math.sqrt(sum / n) / 32768) * 100;
}

// Passive gate in front of the paid Realtime session: open the mic locally and wait for the
// user to actually START TALKING. Nothing is sent anywhere — this is pure local level
// detection — so Claude can beep and then wait for you without burning API time, and without
// a voice starting to talk to an empty room while you're away from the desk.
//
// Resolves true as soon as ~`speechMs` of audio above `level` has accumulated (brief dips
// don't reset it, a long silence bleeds it back down), or false when `waitMs` runs out.
export function waitForSpeech({
  waitMs,
  level = 3,
  speechMs = 180,
  startMic: mkMic = startMic,
  signal,
  onTick,
  // True while a sound of OUR OWN is playing (the waiting cue). On laptop speakers that cue
  // goes straight back into the microphone and reads as speech — the gate would then open a
  // call because it heard itself beep. Chunks are discarded, not merely un-counted, so the
  // accumulated total doesn't decay either.
  ignoreWhile = () => false,
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    let voiced = 0;
    let peak = 0;
    let mic = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        mic?.stop();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), waitMs);
    if (timer.unref) timer.unref();
    signal?.addEventListener?.("abort", () => finish(false), { once: true });

    mic = mkMic((chunk) => {
      if (done || ignoreWhile()) return;
      const ms = (chunk.length / 48000) * 1000; // PCM16 @ 24 kHz = 48000 bytes/s
      const lvl = rmsPct(chunk);
      if (lvl > peak) peak = lvl;
      voiced = lvl >= level ? voiced + ms : Math.max(0, voiced - ms / 2);
      onTick?.({ level: lvl, voiced, peak });
      if (voiced >= speechMs) finish(true);
    });
  });
}

// Generate a short beep as raw PCM16 mono @ 24 kHz — a "your turn" cue. Returns a Buffer
// you can write() straight to the speaker.
// `leadMs` is silence played BEFORE the tone. Bluetooth headphones idle out of the audio
// path and take a few hundred milliseconds to come back: a short tone written to a sleeping
// AirPod is swallowed whole, which is exactly how the "Claude wants you" beep went missing
// while every later sound played fine.
export function beepPcm({ freq = 880, ms = 160, volume = 0.25, leadMs = 0 } = {}) {
  const rate = 24000;
  const lead = Math.floor((rate * leadMs) / 1000);
  const n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc((lead + n) * 2);
  for (let i = 0; i < n; i++) {
    // Fade in/out to avoid clicks.
    const env = Math.min(1, i / 240, (n - i) / 240);
    const s = Math.sin((2 * Math.PI * freq * i) / rate) * volume * env;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), (lead + i) * 2);
  }
  return buf;
}

// Stream raw PCM16 to the default output device. write(Buffer) plays audio.
export function createSpeaker({
  device = process.env.VOICE_OUT_DEVICE,
  jitterMs = Number(process.env.VOICE_JITTER_MS) || 250,
} = {}) {
  // A pinned name is a guess (device names follow the system language, and macOS lists the
  // same headphones twice — once as input, once as output — so the output lookup can land on
  // the input entry and fail). Losing the whole call to that is not acceptable: fall back to
  // the system default once, loudly, and keep talking.
  let proc = spawn("sox", ["-q", ...RAW, "-", ...outputArgs(device)], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let fellBack = !device;
  let alive = true;
  // Stay one gulp ahead of the stream, so a late burst is covered by audio already in hand
  // instead of by silence in the middle of a word.
  const jitter = createJitterBuffer({ jitterMs });
  let exited = false;
  // When the audio written so far will have finished PLAYING. The model streams a whole
  // reply in ~1s while sox plays it over ~8s, so "last chunk received" is useless as a
  // proxy for "the agent stopped talking" — half-duplex muting needs this instead.
  let endsAt = 0;
  const die = (why) => {
    if (alive && why) process.stderr.write(`[claude-voice] speaker sox ${why}\n`);
    alive = false;
  };
  const attach = (p) => {
    p.on("error", (err) => die(`error: ${fail(err).message}`));
    p.on("close", (code) => {
      if (code && !fellBack && alive) {
        fellBack = true;
        process.stderr.write(
          `[claude-voice] speaker: ${JSON.stringify(device)} could not be opened — ` +
            `falling back to the system default output.\n`,
        );
        device = null;
        endsAt = 0;
        proc = spawn("sox", ["-q", ...RAW, "-", "-d"], { stdio: ["pipe", "ignore", "pipe"] });
        attach(proc);
        return;
      }
      exited = true;
      die(code ? `exited (code ${code}) — no audio device?` : "");
    });
    // If sox exits (e.g. can't open the output device), writes to its stdin raise EPIPE.
    // Swallow it here so it never becomes an unhandled 'error' that crashes the server.
    p.stdin.on("error", () => {
      if (!fellBack) return; // the close handler is about to respawn; not fatal yet
      die();
    });
    p.stderr.on("data", (d) =>
      process.stderr.write(`[claude-voice] speaker sox: ${d}${deviceHint(device, String(d))}`),
    );
  };
  attach(proc);
  // Raw write, past the cushion. `endsAt` counts audio HANDED TO sox, which is what the
  // half-duplex mute reads as "the agent is still talking".
  const raw = (buf) => {
    if (!buf || !alive || !proc.stdin.writable) return;
    try {
      proc.stdin.write(buf);
      // PCM16 mono @ 24 kHz = 48000 bytes per second of audio.
      endsAt = Math.max(Date.now(), endsAt) + (buf.length / 48000) * 1000;
    } catch {
      die();
    }
  };

  return {
    write(buf) {
      raw(jitter.push(buf));
    },
    // Everything the model had to say for this turn has arrived: release the cushion, or a
    // reply shorter than it would sit there unplayed.
    flush() {
      raw(jitter.drain());
    },
    // Next turn gets its own cushion — the pause between turns is not a stall to ride out.
    rearm() {
      raw(jitter.drain());
      jitter.reset();
    },
    // Epoch ms at which everything written so far has finished playing (past = silent now).
    playingUntil() {
      return alive ? endsAt : 0;
    },
    // Milliseconds of audio written but not yet heard.
    remainingMs() {
      return alive ? Math.max(0, endsAt - Date.now()) : 0;
    },
    // `immediate` = the user pulled the plug (Esc in Claude Code): cut the audio off now
    // instead of politely playing out what is still queued.
    //
    // Returns a promise that settles when the audio has actually been HEARD. We write far
    // faster than real time (a whole reply lands in ~1s and plays for ~10s), so sox is always
    // behind; closing its stdin makes it play out the rest and exit on its own. Waiting for
    // that exit is exact — estimating the remaining time from bytes written is not, and every
    // underestimate clipped the agent's last words.
    stop({ immediate = false } = {}) {
      if (!immediate) raw(jitter.drain());
      alive = false;
      const queued = Math.max(0, endsAt - Date.now());
      endsAt = 0;
      if (immediate) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        return Promise.resolve();
      }
      try {
        proc.stdin.end();
      } catch {
        /* ignore */
      }
      return new Promise((resolve) => {
        if (exited) return resolve();
        // Backstop: a wedged sox must not hold the tool call open forever. Give it what it
        // still owes us plus a margin, never more than 20s.
        const t = setTimeout(() => {
          try {
            proc.kill("SIGTERM");
          } catch {
            /* ignore */
          }
          resolve();
        }, Math.min(queued + 2000, 20000));
        if (t.unref) t.unref();
        proc.once("close", () => {
          clearTimeout(t);
          resolve();
        });
      });
    },
  };
}
