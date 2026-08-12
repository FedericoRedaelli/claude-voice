// Development mode: run each call in a fresh child process.
//
// WHY THIS EXISTS: ESM modules are evaluated once per process. The MCP server is long-lived,
// so the first talk_to_user call freezes call.mjs, config.mjs and the audio backend in memory
// for the rest of the session — and every code change after that needs Claude Code restarted
// to be seen. Three restarts in half an hour is not a way to iterate.
//
// A child process has none of that history. It costs one node startup (~80 ms) and a tab
// reconnection: the bridge dies with the child, the page notices and retries within two
// seconds, and the token is persistent so the permission survives. That is a fine trade in
// development and a bad one in normal use, which is why VOICE_DEV=1 chooses it explicitly.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CHILD_SCRIPT = join(HERE, "..", "scripts", "run-call.mjs");

// The child speaks one JSON object on stdin and answers with one on stdout. Its stderr is
// inherited, so the logs still land in the same place as everything else.
export function runInChild({
  message,
  options = [],
  spoken = "",
  signal,
  spawnImpl = spawn,
  script = CHILD_SCRIPT,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [script], { stdio: ["pipe", "pipe", "inherit"] });

    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d);
    });
    child.on("error", reject);

    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.on("close", (code) => {
      signal?.removeEventListener?.("abort", onAbort);
      // Esc during a call: the child is killed mid-sentence and has nothing to say. That is
      // the same outcome as a call nobody answered, not a failure to fall back from.
      if (signal?.aborted) return resolve({ kind: "end" });

      // The child may print other things; the decision is the last JSON object it wrote.
      const line = out.trim().split("\n").filter(Boolean).at(-1) ?? "";
      try {
        const decision = JSON.parse(line);
        if (decision && typeof decision.kind === "string") return resolve(decision);
      } catch {
        /* fall through to the error below */
      }
      reject(new Error(`the call process exited (${code}) without a decision`));
    });

    child.stdin.end(JSON.stringify({ message, options, spoken }));
  });
}
