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

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { missingDeps, pluginRoot } from "../src/bootstrap.mjs";
import { envFiles, parseEnvFile, pluginEnvFile, userEnvDir, userEnvFile } from "../src/env.mjs";
import { opener } from "../src/bridge-url.mjs";
import { mcpStatus } from "../src/diagnose.mjs";
import { resolveMedia } from "../src/media.mjs";
import { onPath } from "../src/bridge-url.mjs";

const EXAMPLE = join(pluginRoot, ".env.example");

// Where a new key goes. An existing file wins so a checkout you already configured keeps
// working; otherwise the user-level file, because a plugin install directory is named after
// the version and is therefore thrown away by the next update — key and all.
export function envTarget(exists = existsSync) {
  return exists(pluginEnvFile) ? pluginEnvFile : userEnvFile;
}
const BASE = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

// ---------------------------------------------------------------- .env handling

// Every file the running plugin would read, in the same precedence order it reads them.
function readEnvFile() {
  const out = new Map();
  for (const path of envFiles()) {
    if (!existsSync(path)) continue;
    for (const [k, v] of parseEnvFile(readFileSync(path, "utf8"))) if (!out.has(k)) out.set(k, v);
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
  const file = envTarget();
  if (file === userEnvFile) mkdirSync(userEnvDir, { recursive: true, mode: 0o700 });
  const seed = existsSync(file)
    ? readFileSync(file, "utf8")
    : existsSync(EXAMPLE)
      ? readFileSync(EXAMPLE, "utf8")
      : "";
  writeFileSync(file, mergeEnv(seed, updates), { mode: 0o600 });
  try {
    chmodSync(file, 0o600); // it holds a credential; nobody else on the box needs it
  } catch {}
  return file;
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
    envFile: envTarget(),
    envFiles: envFiles().filter((p) => existsSync(p)),
    envFileExists: envFiles().some((p) => existsSync(p)),
    keyPresent: Boolean(key),
    key: key ? await checkKey(key) : { ok: false, reason: "no key" },
    display: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) || process.platform === "darwin" || process.platform === "win32",
    // Where a tab would be opened from here. "display" only answers whether there is a screen
    // on THIS machine; over VS Code remote the browser is on the user's laptop and the editor
    // opens it for us, which is a different question and the one that decides the experience.
    opensBrowser: opener() ? { command: opener().cmd, where: opener().where } : null,
    browserPort: Number(process.env.VOICE_BROWSER_PORT) || 8787,
    // Why talk_to_user might not be there at all: crashed, or never launched.
    mcp: mcpStatus(),
    // Whether pausing other audio would reach the machine with the speakers. The question is
    // never "can we pause" — it is "pause WHOSE music": this runs where Claude Code runs, and
    // that is the user's own machine in some setups and a server in others.
    pausesMedia: {
      enabled: process.env.VOICE_PAUSE_MEDIA === "1",
      // The way out of the split-machine case: an agent run where the browser is. It attaches
      // over the port that is already forwarded, and then it — not this machine — is what
      // pauses. Reported as a command because the answer to "how do I get this" is the command.
      agentCommand: `node "${pluginRoot}/scripts/media-agent.mjs" "<the tab URL>"`,
      would: resolveMedia({
        env: { ...process.env, VOICE_PAUSE_MEDIA: "1" },
        has: (c) => onPath(c),
      }),
    },
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
  const file = saveEnv(updates);

  process.stdout.write(
    `Key accepted${check.label ? ` (${check.label})` : ""} and saved to ${file}.\n` +
      "Restart Claude Code so the voice server picks it up.\n",
  );
}

// Importable for the tests without running the wizard.
if (process.argv[1] && process.argv[1].endsWith("setup.mjs")) await main();
