// Loads the persisted settings (simple KEY=VALUE lines) into process.env for any keys that are
// not already set. Lets the user persist OPENROUTER_API_KEY and VOICE_* settings once instead of
// re-exporting them every session.
//
// Two files, in order:
//
//   <pluginRoot>/.env      a checkout you work on, or an install you configured in place
//   ~/.claude-voice/.env   the user's own, outside the plugin
//
// The second one exists because of updates. Claude Code installs a plugin into a directory
// named after its version, so every update lands in a NEW directory — a key written next to
// the code is gone the moment the plugin is updated. The user-level file is the same key on
// the other side of an update, which is what makes "git push here, update there" painless.
//
// Precedence: shell exports > plugin .env > user .env. Nothing ever overwrites what is set.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const pluginEnvFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
export const userEnvDir = join(homedir(), ".claude-voice");
export const userEnvFile = join(userEnvDir, ".env");

export const envFiles = () => [pluginEnvFile, userEnvFile];

// KEY=VALUE lines, # comments, optional surrounding quotes. Returns [key, value] pairs in order.
export function parseEnvFile(raw) {
  const out = [];
  for (const line of String(raw).split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out.push([k, v]);
  }
  return out;
}

let loaded = false;

export function loadEnvFile({ files = envFiles(), env = process.env, read = readFileSync } = {}) {
  if (loaded) return;
  loaded = true;
  // The test suite pins every knob it cares about explicitly; letting the developer's own
  // .env leak in means their machine decides whether a test passes. (It did: VOICE_HALF_DUPLEX=0
  // in a local .env silently disabled the half-duplex behaviour three tests exist to check.)
  if (env.VOICE_NO_ENV_FILE === "1") return;
  applyEnvFiles({ files, env, read });
}

// The loading itself, without the once-per-process latch — this is what the tests drive.
export function applyEnvFiles({ files, env, read = readFileSync }) {
  for (const path of files) {
    let raw;
    try {
      raw = read(path, "utf8");
    } catch {
      continue; // no file — fine, the next one (or a shell export) still works
    }
    // Shell exports, and anything an earlier file already set, take precedence.
    for (const [k, v] of parseEnvFile(raw)) if (env[k] === undefined) env[k] = v;
  }
}
