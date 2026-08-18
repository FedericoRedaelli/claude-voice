// The SessionStart hook that keeps the plugin in step with the repository. Nothing here runs
// `claude` or touches the network: the decisions are pure and the check itself is a detached
// process, which is exactly what makes a session start unable to hang on it.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dueForCheck,
  intervalMs,
  noticeFor,
  pendingNotice,
  readUpdateOutput,
} from "../hooks/auto-update.mjs";

test("a machine that has never checked is due immediately", () => {
  assert.equal(dueForCheck({}, 1_000, 100), true);
  assert.equal(dueForCheck(undefined, 1_000, 100), true);
});

test("a recent check is not repeated at every session start", () => {
  const state = { lastRun: 1_000 };
  assert.equal(dueForCheck(state, 1_050, 100), false, "50ms into a 100ms window");
  assert.equal(dueForCheck(state, 1_100, 100), true, "the window closed");
});

test("the interval is six hours unless the env says otherwise", () => {
  assert.equal(intervalMs({}), 6 * 60 * 60 * 1000);
  assert.equal(intervalMs({ VOICE_AUTO_UPDATE_MS: "0" }), 0, "0 means check every start");
  assert.equal(intervalMs({ VOICE_AUTO_UPDATE_MS: "nonsense" }), 6 * 60 * 60 * 1000);
});

test("'already up to date' is not an update", () => {
  assert.deepEqual(readUpdateOutput("claude-voice is already up to date"), { updated: false });
  assert.deepEqual(readUpdateOutput("No updates available"), { updated: false });
  assert.deepEqual(readUpdateOutput(""), { updated: false });
});

test("an update is recognised, with the version when it is printed", () => {
  assert.deepEqual(readUpdateOutput("Updated claude-voice to v0.3.0"), {
    updated: true,
    version: "0.3.0",
  });
  assert.deepEqual(readUpdateOutput("Installed claude-voice"), { updated: true, version: null });
});

// "is not installed" contains "installed". Read as an update, it would ask for a restart at
// every session start of a plugin that was never installed from the marketplace at all.
test("a failure is never mistaken for an update", () => {
  for (const line of [
    "Plugin claude-voice@claude-voice is not installed",
    "Error: unknown marketplace claude-voice",
    "failed to update plugin",
    "Could not install claude-voice",
  ]) {
    assert.deepEqual(readUpdateOutput(line), { updated: false }, line);
  }
});

test("the restart notice is shown once and then goes quiet", () => {
  assert.equal(pendingNotice({ updated: true, notified: false }), true);
  assert.equal(pendingNotice({ updated: true, notified: true }), false, "already announced");
  assert.equal(pendingNotice({}), false, "nothing was updated");
});

test("the notice says the new code is not live until a restart", () => {
  const text = noticeFor({ version: "0.3.0" });
  assert.match(text, /0\.3\.0/);
  assert.match(text, /restart/i);
  assert.match(text, /key/i, "and that the key does not have to be entered again");
});
