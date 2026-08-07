// Wake word: the call opens only when you CALL the agent by name.
//
// The plain gate is a level meter — it hears energy, not words — so with a sensitive
// threshold a cough, a door or a passing conversation opens a paid Realtime session and a
// voice starts talking to a room that never asked for it. A wake word replaces "somebody made
// a noise" with "somebody said my name".
//
// Recognition runs LOCALLY (whisper.cpp): no account, no per-noise API call, and no audio
// leaving the machine. The level gate stays in front of it — whisper only ever sees an
// utterance that already passed the loudness test, so a quiet room costs nothing.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmsPct, startMic as realMic } from "./audio.mjs";

// What the microphone gives us, and what whisper.cpp insists on. Everything else in this
// project is 24 kHz; whisper only accepts 16 kHz, hence the resample below.
export const MIC_RATE = 24000;
export const WHISPER_RATE = 16000;

// Strip everything that separates what you SAID from how it was written down: case, accents,
// and punctuation. "Vai, Claudio!" and "vai claudio" must compare equal.
export function normalizeText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // the combining marks NFD just split off
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein, capped: we only care whether two words are within a couple of edits.
function distance(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

// Does this transcript call the agent by name?
//
// Exact matching is the wrong tool: a tiny local model transcribing one shouted word gets it
// nearly right far more often than exactly right ("Claudio" comes back as "claudia", "cloudio",
// "glaudio"). Refusing those means standing in the kitchen repeating yourself, which is the
// one failure that makes a wake word worse than no wake word. So each spoken word is compared
// to each configured name with a small edit budget that scales with length — short names get
// no slack, since at three letters everything is within two edits of everything.
export function matchesWake(transcript, words, { maxDistance = 2 } = {}) {
  const said = normalizeText(transcript).split(" ").filter(Boolean);
  if (!said.length) return false;
  const wanted = (Array.isArray(words) ? words : String(words || "").split(","))
    .map((w) => normalizeText(w))
    .filter(Boolean);
  if (!wanted.length) return false;

  for (const want of wanted) {
    // A multi-word wake phrase ("vai claudio") matches as a phrase, not word by word.
    const parts = want.split(" ");
    if (parts.length > 1) {
      for (let i = 0; i + parts.length <= said.length; i++) {
        const window = said.slice(i, i + parts.length);
        if (window.every((w, k) => within(w, parts[k], maxDistance))) return true;
      }
      continue;
    }
    if (said.some((w) => within(w, want, maxDistance))) return true;
  }
  return false;
}

function within(said, want, maxDistance) {
  // The budget has to reach zero for a three-letter word: at that length one edit already
  // covers most of the language ("vai" would accept "mai", "hai", "dai"), and a wake word that
  // fires on ordinary speech is worse than none. It reaches 2 at seven letters, which is where
  // a name like "claudio" lives and where the mishearings that matter sit.
  const budget = Math.min(maxDistance, Math.floor((want.length - 1) / 3));
  if (distance(said, want) <= budget) return true;

  // The other way a name comes back wrong: TRUNCATED into a real word. A live "Claudio" was
  // transcribed "cloud" — three edits from the full name, so rejected, but one edit from its
  // first five letters. Comparing against the same-length START of the name catches that,
  // while a four-letter floor and a budget of one keep it from catching ordinary speech
  // ("ciao" and "come" are both two edits from "clau", and stay out).
  if (said.length >= 4 && said.length < want.length)
    return distance(said, want.slice(0, said.length)) <= 1;
  return false;
}

// 24 kHz -> 16 kHz, PCM16 mono. Exactly 3 input samples for every 2 output ones, so this is a
// plain linear interpolation rather than a resampler worth the name — at wake-word duration
// and a tiny model, the difference is inaudible to whisper and it saves a dependency (sox is
// not required by the browser audio backend, and this must work there too).
export function resampleTo16k(pcm) {
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor((inSamples * WHISPER_RATE) / MIC_RATE);
  const out = Buffer.alloc(outSamples * 2);
  const ratio = MIC_RATE / WHISPER_RATE; // 1.5
  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, inSamples - 1);
    const frac = pos - a;
    const s = pcm.readInt16LE(a * 2) * (1 - frac) + pcm.readInt16LE(b * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

// Minimal RIFF/WAVE header around PCM16 mono. whisper-cli reads a file, not a stream.
export function wavFromPcm(pcm, rate = WHISPER_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Runs whisper.cpp over one short utterance and returns what it heard. Failures return "" —
// a wake word that cannot recognise must leave you unable to start a call, not stuck in a
// crash loop; the caller keeps listening and the log says why.
export function createWhisperRecognizer({
  bin = process.env.VOICE_WHISPER_BIN || "whisper-cli",
  model = process.env.VOICE_WHISPER_MODEL || "",
  lang = "auto",
  timeoutMs = Number(process.env.VOICE_WAKE_TIMEOUT_MS) || 8000,
  // The names we are listening for, used to BIAS the decoder. A single shouted word carries
  // no context, and the model fills that in from nothing: a real "Claudio" came back as
  // "Vado!" — the initial consonant lost, the rest reshaped into a commoner word. Whisper's
  // initial prompt is exactly the lever for that; it makes the expected spelling cheap to
  // reach without making anything else impossible.
  words = "",
  log = () => {},
} = {}) {
  const prompt = String(words || "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean)
    .join(", ");
  return async function recognize(pcm) {
    if (!model) {
      log("no VOICE_WHISPER_MODEL set — run `npm run setup:wake`");
      return "";
    }
    const dir = mkdtempSync(join(tmpdir(), "claude-voice-wake-"));
    const wav = join(dir, "utterance.wav");
    try {
      writeFileSync(wav, wavFromPcm(resampleTo16k(pcm)));
      const args = ["-m", model, "-f", wav, "-nt", "-np", "-t", "4"];
      if (lang && lang !== "auto") args.push("-l", lang);
      if (prompt) args.push("--prompt", prompt);
      const text = await run(bin, args, timeoutMs, log);
      return text;
    } catch (err) {
      log(`whisper failed: ${String(err?.message ?? err)}`);
      return "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function run(bin, args, timeoutMs, log) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      log(`could not start ${bin}: ${String(e?.message ?? e)}`);
      return resolve("");
    }
    // A wedged recogniser must not hold the gate open: whichever comes first, an answer or
    // the deadline.
    const t = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      log(`whisper timed out after ${timeoutMs}ms`);
      resolve("");
    }, timeoutMs);
    if (t.unref) t.unref();
    proc.on("error", (e) => {
      clearTimeout(t);
      log(
        e?.code === "ENOENT"
          ? `${bin} not found — run \`npm run setup:wake\` (brew install whisper-cpp)`
          : `whisper error: ${String(e?.message ?? e)}`,
      );
      resolve("");
    });
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => {
      clearTimeout(t);
      if (code) log(`whisper exited ${code}: ${err.trim().split("\n").slice(-2).join(" ")}`);
      resolve(out.trim());
    });
  });
}

// Listen until somebody says the name, or until the deadline runs out.
//
// Shape mirrors waitForSpeech in audio.mjs — same level gate, same options, same true/false —
// because it replaces it. The difference is what happens once speech is detected: instead of
// resolving straight away, the utterance is captured to its end and read.
export function waitForWakeWord({
  waitMs,
  words,
  level = 3,
  speechMs = 180,
  // How much of what came BEFORE the level gate tripped to keep. A wake word is one or two
  // words and the first syllable is what trips the gate, so without a pre-roll whisper is
  // handed "-laudio" and hears nothing.
  prerollMs = 800,
  // Trailing quiet that ends the utterance, and a ceiling for someone who just keeps talking.
  utteranceSilenceMs = 600,
  maxUtteranceMs = 4000,
  startMic = realMic,
  recognize,
  signal,
  onTick,
  onHeard,
  ignoreWhile = () => false,
  log = () => {},
} = {}) {
  return new Promise((resolve) => {
    let done = false;
    let mic = null;
    let voiced = 0;
    let collecting = false;
    let busy = false; // whisper is reading the previous utterance
    let quiet = 0;
    let captured = [];
    let capturedMs = 0;
    const preroll = [];
    let prerollMsHeld = 0;

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

    const reset = () => {
      collecting = false;
      voiced = 0;
      quiet = 0;
      captured = [];
      capturedMs = 0;
    };

    const judge = async () => {
      const pcm = Buffer.concat(captured);
      reset();
      busy = true;
      let heard = "";
      try {
        heard = await recognize(pcm);
      } finally {
        busy = false;
      }
      if (done) return;
      const ok = matchesWake(heard, words);
      log(`heard "${heard || "(nothing)"}" -> ${ok ? "wake" : "ignored"}`);
      onHeard?.({ text: heard, matched: ok });
      if (ok) finish(true);
    };

    mic = startMic((chunk) => {
      if (done || ignoreWhile()) return;
      const ms = (chunk.length / (MIC_RATE * 2)) * 1000;
      const lvl = rmsPct(chunk);
      onTick?.({ level: lvl, voiced, collecting });

      // While whisper is reading, keep the microphone open but throw the audio away: queuing
      // it would judge the previous utterance twice, and half of one plus half of the next
      // transcribes as neither.
      if (busy) return;

      if (!collecting) {
        // Hold a rolling pre-roll so the word that TRIPPED the gate is in the recording.
        preroll.push(chunk);
        prerollMsHeld += ms;
        while (prerollMsHeld > prerollMs && preroll.length > 1) {
          const dropped = preroll.shift();
          prerollMsHeld -= (dropped.length / (MIC_RATE * 2)) * 1000;
        }
        voiced = lvl >= level ? voiced + ms : Math.max(0, voiced - ms / 2);
        if (voiced < speechMs) return;
        collecting = true;
        captured = [...preroll];
        capturedMs = prerollMsHeld;
        preroll.length = 0;
        prerollMsHeld = 0;
        return;
      }

      captured.push(chunk);
      capturedMs += ms;
      quiet = lvl >= level ? 0 : quiet + ms;
      if (quiet >= utteranceSilenceMs || capturedMs >= maxUtteranceMs) judge();
    });
  });
}
