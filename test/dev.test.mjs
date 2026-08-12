import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runInChild } from "../src/dev.mjs";

// A child process, faked down to the three things runInChild touches: stdin it writes to,
// stdout it reads, and a close event.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.written = null;
  child.killed = null;
  child.stdin = { end: (s) => (child.written = s) };
  child.kill = (sig) => (child.killed = sig);
  return child;
}

function fakeSpawn(child) {
  const calls = [];
  return {
    calls,
    spawnImpl: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return child;
    },
  };
}

test("the call is handed to the child as JSON on stdin", async () => {
  const child = fakeChild();
  const { calls, spawnImpl } = fakeSpawn(child);

  const p = runInChild({
    message: "m",
    options: ["uno", "due"],
    spoken: "s",
    spawnImpl,
    script: "/x/run-call.mjs",
  });

  assert.deepEqual(JSON.parse(child.written), {
    message: "m",
    options: ["uno", "due"],
    spoken: "s",
  });
  assert.deepEqual(calls[0].args, ["/x/run-call.mjs"]);
  assert.equal(calls[0].opts.stdio[2], "inherit", "the child's logs go where every other log goes");

  child.stdout.emit("data", '{"kind":"end"}\n');
  child.emit("close", 0);
  await p;
});

test("the decision comes back from the child's last line of stdout", async () => {
  const child = fakeChild();
  const { spawnImpl } = fakeSpawn(child);

  const p = runInChild({ message: "m", spawnImpl, script: "x" });
  // A stray line before the decision must not break it.
  child.stdout.emit("data", "loading modules\n");
  child.stdout.emit("data", '{"kind":"choice","value":"uno"}\n');
  child.emit("close", 0);

  assert.deepEqual(await p, { kind: "choice", value: "uno" });
});

test("a child that dies without a decision is an error, so the caller can fall back to text", async () => {
  const child = fakeChild();
  const { spawnImpl } = fakeSpawn(child);

  const p = runInChild({ message: "m", spawnImpl, script: "x" });
  child.emit("close", 1);

  await assert.rejects(() => p, /without a decision/);
});

test("Esc kills the child and closes the call quietly", async () => {
  const ac = new AbortController();
  const child = fakeChild();
  const { spawnImpl } = fakeSpawn(child);

  const p = runInChild({ message: "m", signal: ac.signal, spawnImpl, script: "x" });
  ac.abort();
  assert.equal(child.killed, "SIGTERM");

  child.emit("close", null);
  // Killed on purpose is the same outcome as a call nobody answered — not a failure that
  // should drop the user into the terminal fallback.
  assert.deepEqual(await p, { kind: "end" });
});
