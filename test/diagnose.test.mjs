// Telling "the server crashed" apart from "the client never launched it". From the chat both
// look the same — talk_to_user is not there — and the second one is the expensive one, because
// every hour spent on it is spent reading a launch command that was never run.

import assert from "node:assert/strict";
import { test } from "node:test";
import { launches, mcpStatus, quarantine } from "../src/diagnose.mjs";

const withProjects = (projects) => ({ projects });

test("a server disabled in a project is found, with the project named", () => {
  const q = quarantine(
    withProjects({
      "/home/me/app": { disabledMcpjsonServers: ["voice"] },
      "/home/me/other": { disabledMcpjsonServers: [] },
    }),
  );
  assert.equal(q.disabled, true);
  assert.deepEqual(q.disabledIn, ["/home/me/app"]);
});

test("a config with nothing to say is not read as a fault", () => {
  assert.equal(quarantine(withProjects({})).disabled, false);
  assert.equal(quarantine({}).disabled, false);
  assert.equal(quarantine(null).disabled, false, "an unreadable config is not evidence");
});

test("an approved server is reported as approved, not as disabled", () => {
  const q = quarantine(withProjects({ "/p": { enabledMcpjsonServers: ["voice"] } }));
  assert.equal(q.disabled, false);
  assert.deepEqual(q.enabledIn, ["/p"]);
});

test("the launch log is read newest last, blank lines ignored", () => {
  const text = "2026-08-18T10:00:00.000Z pid=1 node=20 root=/p launched\n\n2026-08-18T11:00:00.000Z pid=2 node=20 root=/p serving\n";
  const got = launches(text, 2);
  assert.equal(got.length, 2);
  assert.equal(got[1].at, "2026-08-18T11:00:00.000Z");
  assert.equal(got[1].note, "serving");
});

// The hint is the whole point: the fix that does not work is editing the client's config while
// the client is running, because it writes the file back from memory when it exits.
test("a disabled server is told to quit the client before editing anything", () => {
  const status = mcpStatus({
    readConfig: () => withProjects({ "/p": { disabledMcpjsonServers: ["voice"] } }),
    readLog: () => "",
  });
  assert.equal(status.disabledByClient, true);
  assert.match(status.hint, /Quit Claude Code FIRST/);
  assert.match(status.hint, /disabledMcpjsonServers/);
});

test("never launched, but not disabled, points at the client rather than at the code", () => {
  const status = mcpStatus({ readConfig: () => ({}), readLog: () => "" });
  assert.equal(status.everLaunched, false);
  assert.match(status.hint, /never started/);
});

test("a server that has been starting normally reports no fault at all", () => {
  const status = mcpStatus({
    readConfig: () => ({}),
    readLog: () => "2026-08-18T11:00:00.000Z pid=2 node=20 root=/p serving\n",
  });
  assert.equal(status.everLaunched, true);
  assert.equal(status.hint, null);
});

test("a missing log file is not an error — it is the answer", () => {
  const status = mcpStatus({
    readConfig: () => ({}),
    readLog: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(status.everLaunched, false);
});
