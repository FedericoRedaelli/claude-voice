#!/usr/bin/env node
// Setup, in one file, usable three ways:
//
//   node scripts/setup.mjs --check          what is missing, as JSON (for a coding agent)
//   node scripts/setup.mjs --key -          read the key on stdin and save it (no argv leak)
//   node scripts/setup.mjs                  ask for the key on the terminal
//
// The key is written to <plugin root>/.env, which is git-ignored and never leaves the machine:
// it is used to call OpenRouter from this process only. It is deliberately never passed on the
// command line by default — argv is visible to every process on the box.

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { missingDeps, pluginRoot } from "../src/bootstrap.mjs";

const ENV_FILE = join(pluginRoot, ".env");
const EXAMPLE = join(pluginRoot, ".env.example");
const BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---------------------------------------------------------------- .env handling

function readEnvFile() {
  const out = new Map();
  if (!existsSync(ENV_FILE)) return out;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq > 0) out.set(s.slice(0, eq).trim(), s.slice(eq + 1).trim());
  }
  return out;
}

// Rewrite in place so the user's own comments and settings survive; append what is new.
export function mergeEnv(existing, updates) {
  const lines = existing ? existing.split("\n") : [];
  const left = new Map(Object.entries(updates));
  const merged = lines.map((line) => {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.trim().startsWith("#")) return line;
    const key = line.slice(0, eq).trim();
    if (!left.has(key)) return line;
    const v = left.get(key);
    left.delete(key);
    return `${key}=${v}`;
  });
  for (const [k, v] of left) merged.push(`${k}=${v}`);
  return `${merged.join("\n").replace(/\n+$/, "")}\n`;
}

function saveEnv(updates) {
  const seed = existsSync(ENV_FILE)
    ? readFileSync(ENV_FILE, "utf8")
    : existsSync(EXAMPLE)
      ? readFileSync(EXAMPLE, "utf8")
      : "";
  writeFileSync(ENV_FILE, mergeEnv(seed, updates), { mode: 0o600 });
  try {
    chmodSync(ENV_FILE, 0o600); // it holds a credential; nobody else on the box needs it
  } catch {}
}

// ---------------------------------------------------------------- checks

async function checkKey(key) {
  if (!key) return { ok: false, reason: "no key" };
  try {
    const res = await fetch(`${BASE}/key`, { headers: { authorization: `Bearer ${key}` } });
    if (res.status === 401) return { ok: false, reason: "OpenRouter rejected the key (401)" };
    if (!res.ok) return { ok: false, reason: `OpenRouter answered ${res.status}` };
    const body = await res.json().catch(() => ({}));
    const limit = body?.data?.limit;
    const used = body?.data?.usage;
    return { ok: true, label: body?.data?.label ?? null, limit: limit ?? null, usage: used ?? null };
  } catch (err) {
    return { ok: false, reason: `could not reach OpenRouter (${String(err?.message ?? err)})` };
  }
}

async function status() {
  const env = readEnvFile();
  const key = process.env.OPENROUTER_API_KEY || env.get("OPENROUTER_API_KEY") || "";
  const [major] = process.versions.node.split(".").map(Number);
  return {
    pluginRoot,
    node: process.versions.node,
    nodeOk: major >= 20,
    dependenciesInstalled: missingDeps().length === 0,
    missingDependencies: missingDeps(),
    envFile: ENV_FILE,
    envFileExists: existsSync(ENV_FILE),
    keyPresent: Boolean(key),
    key: key ? await checkKey(key) : { ok: false, reason: "no key" },
    display: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) || process.platform === "darwin" || process.platform === "win32",
    browserPort: Number(process.env.VOICE_BROWSER_PORT) || 8787,
  };
}

// ---------------------------------------------------------------- entry

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main() {
  if (has("--check") || has("--json")) {
    process.stdout.write(`${JSON.stringify(await status(), null, 2)}\n`);
    return;
  }

  let key = valueOf("--key");
  if (key === "-") key = await readStdin();

  if (!key && !has("--no-prompt")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(
      "\nclaude-voice needs one OpenRouter key — it covers speech, transcription and reasoning.\n" +
        "Create one at https://openrouter.ai/keys (it starts with sk-or-v1-).\n\n",
    );
    key = (await rl.question("Paste the key: ")).trim();
    rl.close();
  }

  if (!key) {
    process.stderr.write("No key given. Nothing written.\n");
    process.exitCode = 1;
    return;
  }

  const check = await checkKey(key);
  if (!check.ok) {
    process.stderr.write(`That key does not work: ${check.reason}. Nothing written.\n`);
    process.exitCode = 1;
    return;
  }

  const updates = { OPENROUTER_API_KEY: key };
  const lang = valueOf("--lang");
  if (lang) updates.VOICE_LANG = lang;
  saveEnv(updates);

  process.stdout.write(
    `Key accepted${check.label ? ` (${check.label})` : ""} and saved to ${ENV_FILE}.\n` +
      "Restart Claude Code so the voice server picks it up.\n",
  );
}

// Importable for the tests without running the wizard.
if (process.argv[1] && process.argv[1].endsWith("setup.mjs")) await main();
