// The session switch: installing the plugin must not make every session a voice session.
// Everything here works on a temp directory — the state is one small file per session id.

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateDecision, isOn, prune, readState, sessionFile, setOn } from "../src/gate.mjs";

const fresh = () => mkdtempSync(join(process.env.TMPDIR || tmpdir(), "voice-gate-"));

test("off is the default — a session nobody switched on is silent", () => {
  const dir = fresh();
  assert.equal(isOn("never-seen", { env: {}, dir }), false);
  assert.equal(readState("never-seen", { dir }), null, "and no file was created by asking");
});

test("on, then off, for one session id", () => {
  const dir = fresh();
  assert.equal(setOn("s1", true, { dir }), true);
  assert.equal(isOn("s1", { env: {}, dir }), true);
  setOn("s1", false, { dir });
  assert.equal(isOn("s1", { env: {}, dir }), false);
});

// The point of keying on the session id: a second window, or the next session, starts off.
test("switching one session on leaves every other session off", () => {
  const dir = fresh();
  setOn("s1", true, { dir });
  assert.equal(isOn("s2", { env: {}, dir }), false);
});

test("VOICE_DISABLE wins over everything, VOICE_ALWAYS over the file", () => {
  assert.equal(gateDecision({ env: { VOICE_DISABLE: "1", VOICE_ALWAYS: "1" }, state: { on: true } }), false);
  assert.equal(gateDecision({ env: { VOICE_ALWAYS: "1" }, state: null }), true, "no session, still on");
  assert.equal(gateDecision({ env: {}, state: { on: true } }), true);
  assert.equal(gateDecision({ env: {}, state: {} }), false);
});

// The id becomes a path, and it arrives from outside this process.
test("a session id cannot walk out of the state directory", () => {
  const dir = fresh();
  const path = sessionFile("../../etc/passwd", dir);
  assert.equal(path.startsWith(dir), true, path);
  assert.match(path, /_+\.+_+/);
});

test("unreadable or corrupt state reads as off, and never throws", () => {
  const dir = fresh();
  writeFileSync(join(dir, "s3.json"), "{not json");
  assert.equal(isOn("s3", { env: {}, dir }), false);
  assert.equal(isOn("s4", { env: {}, dir: join(dir, "gone") }), false);
});

test("a write that fails says so instead of pretending", () => {
  assert.equal(setOn("s5", true, { dir: "/proc/nope", mkdir: () => { throw new Error("EACCES"); } }), false);
});

test("what was switched on is remembered with when and where", () => {
  const dir = fresh();
  setOn("s6", true, { dir, cwd: "/work/thing", now: 1234 });
  const state = JSON.parse(readFileSync(sessionFile("s6", dir), "utf8"));
  assert.deepEqual(state, { on: true, at: 1234, cwd: "/work/thing" });
});

// Sessions end without telling anyone, so the files have to age out on their own.
test("stale switches are pruned, current ones are left alone", () => {
  const dir = fresh();
  setOn("old", true, { dir });
  setOn("new", true, { dir });
  const old = sessionFile("old", dir);
  const longAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
  utimesSync(old, longAgo, longAgo);
  assert.equal(prune({ dir }), 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(sessionFile("new", dir)), true);
});

test("pruning a directory that is not there is not an error", () => {
  assert.equal(prune({ dir: join(fresh(), "nope") }), 0);
});

// The switch only matters because of the Stop hook, so run the hook itself.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/stop-nudge.mjs", import.meta.url));

function runHook({ dir, id }) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: id, transcript_path: "" }),
    encoding: "utf8",
    env: {
      ...process.env,
      VOICE_SESSIONS_DIR: dir,
      VOICE_NO_ENV_FILE: "1",
      VOICE_DISABLE: "",
      VOICE_ALWAYS: "",
      OPENROUTER_API_KEY: "test-key",
    },
  });
}

test("with the session off the Stop hook says nothing at all", () => {
  const dir = fresh();
  const out = runHook({ dir, id: "hook-off" });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "", "an ordinary session must not be nudged about voice");
});

test("with the session on the Stop hook asks for talk_to_user", () => {
  const dir = fresh();
  setOn("hook-on", true, { dir });
  const out = runHook({ dir, id: "hook-on" });
  assert.equal(out.status, 0);
  const decision = JSON.parse(out.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /talk_to_user/);
});
