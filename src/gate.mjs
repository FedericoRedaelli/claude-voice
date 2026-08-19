// Is the voice loop on for THIS session?
//
// The plugin is installed once and then every session in every project would have a voice
// loop — which is not what an installed plugin should mean. Most sessions are ordinary work.
// So the loop is OFF unless this session asked for it: `/voice-on` turns it on, `/voice-off`
// turns it back off, and a new session starts off again.
//
// The state cannot live in the environment: a slash command runs in its own shell and cannot
// export anything back into the session. It lives in a file named after the session id, which
// both sides can see — the command writes it (CLAUDE_CODE_SESSION_ID), the Stop hook reads it
// (session_id in the hook payload). One file per session is also what makes "new session =
// off" true without any clearing step: a fresh id has no file.
//
// Two environment escapes, for the cases with no session to speak of (cron, a script, a
// machine you want always talking):
//
//   VOICE_ALWAYS=1   on, whatever the file says
//   VOICE_DISABLE=1  off, whatever the file says — this one wins
//
// Files are pruned after a week. Nothing here ever throws: a gate that fails is a gate that
// says off, and an unreadable state directory must not break a session start.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { userEnvDir } from "./env.mjs";

// VOICE_SESSIONS_DIR moves the state elsewhere — a sandbox with no writable home, mostly.
export const sessionsDir = process.env.VOICE_SESSIONS_DIR || join(userEnvDir, "sessions");
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// Session ids are uuids, but the id arrives from outside and it becomes a path, so it is
// sanitized rather than trusted.
export function sessionFile(id, dir = sessionsDir) {
  const safe = String(id || "unknown").replace(/[^\w.-]/g, "_").slice(0, 120);
  return join(dir, `${safe}.json`);
}

// The whole decision, in one place, with no filesystem in it.
export function gateDecision({ env = process.env, state = null } = {}) {
  if (env.VOICE_DISABLE === "1") return false;
  if (env.VOICE_ALWAYS === "1") return true;
  return Boolean(state?.on);
}

export function readState(id, { dir = sessionsDir, read = readFileSync } = {}) {
  try {
    return JSON.parse(read(sessionFile(id, dir), "utf8"));
  } catch {
    return null;
  }
}

export function isOn(id, { env = process.env, dir = sessionsDir, read = readFileSync } = {}) {
  return gateDecision({ env, state: readState(id, { dir, read }) });
}

export function setOn(id, on, { dir = sessionsDir, cwd = process.cwd(), now = Date.now(), write = writeFileSync, mkdir = mkdirSync } = {}) {
  try {
    mkdir(dir, { recursive: true, mode: 0o700 });
    write(sessionFile(id, dir), JSON.stringify({ on: Boolean(on), at: now, cwd }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Housekeeping, called from the session-start hook. A session that ended left its file behind
// and nothing else will ever remove it.
export function prune({ dir = sessionsDir, now = Date.now(), maxAge = MAX_AGE_MS, list = readdirSync, stat = statSync, remove = rmSync } = {}) {
  let removed = 0;
  let names;
  try {
    names = list(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (now - stat(path).mtimeMs > maxAge) {
        remove(path);
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
