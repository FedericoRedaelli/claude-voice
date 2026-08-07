#!/usr/bin/env node
// One-time setup for the wake word: a local recogniser and a model file, then two lines in
// .env. Nothing here talks to OpenAI — the point of the local path is that your microphone
// audio never leaves the machine, so this script only ever downloads a model.
//
// Safe to re-run: every step checks before doing anything.

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = join(ROOT, "models");
const ENV = join(ROOT, ".env");

// base is the smallest model that reads a two-word Italian name reliably; tiny mishears it
// often enough to make you repeat yourself, which defeats the feature. ~142 MB, once.
const MODEL = process.env.VOICE_WHISPER_MODEL_NAME || "ggml-base.bin";
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL}`;
const MIN_BYTES = 20 * 1024 * 1024; // anything smaller is an error page, not a model

const say = (m) => process.stdout.write(`${m}\n`);
const die = (m) => {
  process.stderr.write(`\n${m}\n`);
  process.exit(1);
};

// --- 1. the recogniser ---------------------------------------------------------------------
function findWhisper() {
  const which = spawnSync("which", ["whisper-cli"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : "";
}

let bin = findWhisper();
if (bin) {
  say(`whisper-cli: ${bin}`);
} else {
  say("whisper-cli not found — installing whisper-cpp with Homebrew (bottled, no compiling)");
  const brew = spawnSync("brew", ["install", "whisper-cpp"], { stdio: "inherit" });
  if (brew.status !== 0)
    die(
      "brew install whisper-cpp failed.\n" +
        "Install whisper.cpp however you prefer, then set VOICE_WHISPER_BIN in .env to the\n" +
        "path of its CLI and re-run this script.",
    );
  bin = findWhisper();
  if (!bin) die("whisper-cpp installed but whisper-cli is still not on PATH.");
  say(`whisper-cli: ${bin}`);
}

// --- 2. the model --------------------------------------------------------------------------
mkdirSync(MODELS, { recursive: true });
const modelPath = join(MODELS, MODEL);

if (existsSync(modelPath) && statSync(modelPath).size > MIN_BYTES) {
  say(`model: ${modelPath} (already there)`);
} else {
  say(`downloading ${MODEL} (~142 MB, once) …`);
  await download(MODEL_URL, modelPath);
  const size = existsSync(modelPath) ? statSync(modelPath).size : 0;
  if (size < MIN_BYTES) die(`the download produced ${size} bytes — that is not a model.`);
  say(`model: ${modelPath}`);
}

// --- 3. .env -------------------------------------------------------------------------------
// Appended, never rewritten: this file holds the user's API key and their own settings.
let env = existsSync(ENV) ? readFileSync(ENV, "utf8") : "";
if (env && !env.endsWith("\n")) env += "\n"; // a missing trailing newline once glued two keys together
const need = [
  ["VOICE_WHISPER_BIN", bin],
  ["VOICE_WHISPER_MODEL", modelPath],
];
const added = [];
for (const [key, value] of need) {
  if (new RegExp(`^${key}=`, "m").test(env)) continue;
  env += `${key}=${value}\n`;
  added.push(key);
}
if (!new RegExp("^VOICE_WAKE_WORD=", "m").test(env)) {
  env +=
    "\n# La parola con cui apri una chiamata. Piu' varianti separate da virgola.\n" +
    "# Commenta questa riga per tornare al gate a solo livello audio.\n" +
    "VOICE_WAKE_WORD=Claudio\n";
  added.push("VOICE_WAKE_WORD");
}
if (added.length) {
  writeFileSync(ENV, env);
  say(`.env: added ${added.join(", ")}`);
} else {
  say(".env: already configured");
}

// --- 4. prove it works -----------------------------------------------------------------------
say("\nchecking the recogniser runs …");
const { createWhisperRecognizer } = await import("../src/wake.mjs");
// The FIRST run after a download is slow — ten seconds here, against a quarter of a second
// afterwards — because macOS verifies the freshly downloaded binaries before letting them
// run. So warm it up, then time the run that resembles real use, and report THAT. Reporting
// the cold one as the answer would either look broken or, worse, look fine after a timeout.
const recognize = createWhisperRecognizer({
  bin,
  model: modelPath,
  lang: "auto",
  timeoutMs: 60000,
  log: say,
});
const silence = Buffer.alloc(24000 * 2 * 0.5); // half a second; this tests loading, not accuracy
await recognize(silence);
const started = Date.now();
await recognize(silence);
const ms = Date.now() - started;
say(`ok — whisper ran in ${ms} ms`);
if (ms > 3000)
  say(
    `warning: that is slow enough to be felt before every call. Try a smaller model:\n` +
      `  VOICE_WHISPER_MODEL_NAME=ggml-tiny.bin npm run setup:wake`,
  );

say(
  "\nDone. Reload the voice server (/mcp) and the call will only open when you say the wake word.\n" +
    "Try it: stay quiet and cough — nothing happens. Say the word — the call opens.",
);

function download(url, dest) {
  return new Promise((resolve, reject) => {
    // curl over a hand-rolled fetch loop: it follows redirects (HuggingFace always redirects
    // to a CDN), resumes, and shows a progress bar for a download this size.
    const curl = spawn("curl", ["-fL", "--progress-bar", "-o", dest, url], { stdio: "inherit" });
    curl.on("error", reject);
    curl.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`curl exited ${code}`))));
  });
}
