// Where the voice tab lives, and the token that guards it. Split out of audio/browser.mjs so
// that a setup command can print the URL on a machine where the dependencies are not installed
// yet — browser.mjs imports `ws`, this file imports nothing but node: builtins.

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Beside .env, and gitignored for the same reason.
export const TOKEN_FILE =
  process.env.VOICE_BROWSER_TOKEN_FILE || join(ROOT, ".voice-bridge-token");
// Touched every time a tab attaches. Its mtime is how a BRAND NEW bridge knows a tab is
// already open somewhere — which it cannot tell by looking, because a tab that lost its server
// a moment ago is not connected yet and is not absent either.
export const SEEN_FILE = process.env.VOICE_BROWSER_SEEN_FILE || join(ROOT, ".voice-bridge-tab");

const log = (m) => process.stderr.write(`[claude-voice] bridge: ${m}\n`);

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
    log(
      `could not persist the bridge token (${String(err?.message ?? err)}) — the tab will not survive a restart`,
    );
  }
  return token;
}

// Where the bridge listens. 127.0.0.1 is the right answer even when the browser is on another
// machine: `ssh -L 8787:127.0.0.1:8787` puts the tunnel's end inside this loopback, so the page
// reaches the port without the port being reachable from the network. Set
// VOICE_BROWSER_HOST=0.0.0.0 only if you accept that it exposes the bridge — and so the
// microphone — to anything on the network that can guess the token.
export const browserHost = () => process.env.VOICE_BROWSER_HOST || "127.0.0.1";
export const browserPort = () => Number(process.env.VOICE_BROWSER_PORT) || 8787;

// What you type into a browser. A wildcard bind has no address you can visit, so the URL stays
// loopback: over an SSH tunnel that is the address on YOUR machine anyway.
export const pageUrl = () => `http://127.0.0.1:${browserPort()}/?t=${loadOrCreateToken()}`;

// A machine with no display cannot open a browser, and trying is worse than not: xdg-open
// either fails silently or hangs, and the user waits for a tab that was never going to appear.
// Headless is not a failure mode here — it is the SSH case, where the human opens the URL on
// their own machine through a forwarded port.
export function hasDisplay() {
  if (process.env.VOICE_BROWSER_OPEN === "0") return false;
  if (process.env.VOICE_BROWSER_OPEN === "1") return true;
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
