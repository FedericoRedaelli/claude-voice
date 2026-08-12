// Loads <pluginRoot>/.env (simple KEY=VALUE lines) into process.env for any keys that are
// not already set. Lets the user persist OPENROUTER_API_KEY and VOICE_* settings once instead of
// re-exporting them every session. The path is resolved relative to THIS file (src/), so it
// points at the plugin root no matter which module imports it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let loaded = false;

export function loadEnvFile() {
  if (loaded) return;
  loaded = true;
  // The test suite pins every knob it cares about explicitly; letting the developer's own
  // .env leak in means their machine decides whether a test passes. (It did: VOICE_HALF_DUPLEX=0
  // in a local .env silently disabled the half-duplex behaviour three tests exist to check.)
  if (process.env.VOICE_NO_ENV_FILE === "1") return;
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return; // no .env — fine, env vars / shell exports still work
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq < 0) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    // Shell exports take precedence — only fill in what isn't already set.
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
}
