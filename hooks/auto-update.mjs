#!/usr/bin/env node
// SessionStart hook: keeps the plugin in step with the repository it was installed from.
//
// The point is the two-machine loop: you push a fix on one machine and the other picks it up
// without being told to. What makes that safe is that the hook never does the update inline.
//
//   * The check runs DETACHED, in its own process. A session start must not wait on a network
//     fetch; the worst a slow or dead network can do here is nothing at all.
//   * A start therefore reports the PREVIOUS run's result. That is one session behind, and it
//     is the right trade: the alternative is a terminal that hangs on `git fetch`.
//   * It reports, it does not restart. The MCP server is long-lived, so an update is only
//     live after Claude Code restarts — saying so is the whole message.
//   * Every failure path is silent. A hook that prints an error at every start because a
//     laptop is offline is worse than one that skips the check.
//
// VOICE_AUTO_UPDATE=0 turns it off. VOICE_AUTO_UPDATE_MS sets how often it looks (default 6h).

import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadEnvFile, userEnvDir } from "../src/env.mjs";

loadEnvFile();

const SELF = fileURLToPath(import.meta.url);
const STATE = join(userEnvDir, "auto-update.json");
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PLUGIN = "claude-voice@claude-voice";
const MARKETPLACE = "claude-voice";

// ---------------------------------------------------------------- pure decisions (tested)

export function intervalMs(env = process.env) {
  const n = Number(env.VOICE_AUTO_UPDATE_MS);
  return Number.isFinite(n) && n >= 0 && env.VOICE_AUTO_UPDATE_MS !== undefined
    ? n
    : DEFAULT_INTERVAL_MS;
}

export function dueForCheck(state, now, interval) {
  return now - (state?.lastRun ?? 0) >= interval;
}

// An update that has landed but has not been announced yet. Announced once: a restart notice
// repeated at every start is noise the user learns to ignore.
export function pendingNotice(state) {
  return Boolean(state?.updated && !state?.notified);
}

// `claude plugin update` says what it did in words. "already up to date" is the common case
// and must not read as an update, or every start would ask for a restart that changes nothing.
export function readUpdateOutput(out) {
  const text = String(out ?? "");
  // Negations first, and they are not a nicety: "is not installed" contains "installed", so a
  // plugin that was never installed from the marketplace would otherwise announce an update
  // and ask for a restart at every session start.
  if (/\b(not|isn't|cannot|could not|couldn't|un)\s*install|fail|error|unknown|no such/i.test(text))
    return { updated: false };
  if (/already|up to date|no update/i.test(text)) return { updated: false };
  if (/updated|installed/i.test(text)) {
    const m = text.match(/v?(\d+\.\d+\.\d+)/);
    return { updated: true, version: m ? m[1] : null };
  }
  return { updated: false };
}

export function noticeFor(state) {
  const v = state?.version ? ` to ${state.version}` : "";
  return (
    `claude-voice was updated${v} in the background. The MCP server is long-lived, so the new ` +
    `code is not running yet: tell the user they can restart Claude Code when it suits them. ` +
    `Their OpenRouter key lives outside the plugin directory, so nothing has to be set up again.`
  );
}

// ---------------------------------------------------------------- state

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    mkdirSync(dirname(STATE), { recursive: true, mode: 0o700 });
    writeFileSync(STATE, JSON.stringify(state));
  } catch {
    /* a hook that cannot write its own stamp still must not break the session */
  }
}

// ---------------------------------------------------------------- the two modes

// --run: the detached worker. Nothing it prints reaches the user; it leaves a stamp behind.
function runCheck() {
  writeState({ ...readState(), lastRun: Date.now() }); // stamp first: a hanging network must
  // not turn into a check at every single start
  const run = (args) =>
    spawnSync("claude", args, {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const market = run(["plugin", "marketplace", "update", MARKETPLACE]);
  if (market.error || market.status !== 0) return; // no `claude` on PATH, no such marketplace,
  // an install that came from somewhere else — silence is the contract
  const res = run(["plugin", "update", PLUGIN, "--yes"]);
  if (res.error || res.status !== 0) return;

  const seen = readUpdateOutput(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  if (!seen.updated) return;
  writeState({ ...readState(), updated: true, version: seen.version, notified: false });
}

// The hook proper: report, then maybe start a check. Never blocks on the check.
function main() {
  if (process.env.VOICE_AUTO_UPDATE === "0") return;

  const state = readState();

  if (pendingNotice(state)) {
    writeState({ ...state, notified: true, updated: false });
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: noticeFor(state),
        },
      }),
    );
  }

  if (!dueForCheck(state, Date.now(), intervalMs())) return;
  try {
    const child = spawn(process.execPath, [SELF, "--run"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* fail open */
  }
}

if (process.argv.includes("--run")) runCheck();
else if (process.argv[1] === SELF) main();
