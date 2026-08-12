#!/usr/bin/env node
// One call, in its own process. Reads {message, options, spoken} as JSON on stdin and writes
// the decision as JSON on stdout. See src/dev.mjs for why this exists.

import { runCall } from "../src/call.mjs";
import { config } from "../src/config.mjs";
import { loadModules } from "../src/modules.mjs";

const input = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => resolve(buf));
});

const { message, options = [], spoken = "" } = JSON.parse(input || "{}");

let decision = { kind: "end" };
try {
  const modules = await loadModules();
  decision = await runCall({ message, options, spoken, modules, cfg: config });
  await modules.audio?.close?.();
} catch (err) {
  // stdout carries the decision and nothing else, so the reason goes to stderr, which the
  // parent inherits.
  process.stderr.write(`[claude-voice] call failed: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
}

process.stdout.write(`${JSON.stringify(decision)}\n`);
process.exit(process.exitCode ?? 0);
