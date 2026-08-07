#!/usr/bin/env node
// Unit test for hooks/stop-nudge.mjs. Feeds Stop-event JSON on stdin with crafted
// transcripts and asserts block vs allow. Exits non-zero on any failure.
//
// Usage: node scripts/smoke-hook.mjs

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = join(here, "..", "hooks", "stop-nudge.mjs");
const work = mkdtempSync(join(tmpdir(), "claude-voice-hook-"));

// Build a transcript JSONL where the newest tool_result carries the given decision kind.
function transcript(kind) {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } }),
  ];
  if (kind) {
    const decision = kind === "end" ? { kind } : { kind, value: "do the thing" };
    lines.push(
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", content: [{ type: "text", text: JSON.stringify(decision) }] }],
        },
      }),
    );
  }
  const path = join(work, `t-${kind || "none"}-${Math.round(performance.now())}.jsonl`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// Run the hook once; resolve { stdout, code }.
function runHook({ stdin, env = {} }) {
  return new Promise((resolve) => {
    const proc = spawn("node", [hookPath], {
      stdio: ["pipe", "pipe", "inherit"],
      // Base env uses text mode so the voice/key gate passes and the block logic is exercised.
      env: { ...process.env, TMPDIR: work, VOICE_MODE: "text", ...env },
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", (code) => resolve({ stdout: out.trim(), code }));
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}

const isBlock = (r) => r.stdout.includes('"decision"') && r.stdout.includes('"block"');
const isAllow = (r) => r.stdout === "" && r.code === 0;

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`ok: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

// Each case uses a unique session_id so the bounded-retry counter never carries over.
const sid = (n) => `sess-${n}-${Math.round(performance.now())}`;

// (a) no talk_to_user yet -> block
check(
  "no decision -> block",
  isBlock(
    await runHook({
      stdin: JSON.stringify({ session_id: sid("a"), transcript_path: transcript(null) }),
    }),
  ),
);

// (b) last decision kind=message -> block
check(
  "kind=message -> block",
  isBlock(
    await runHook({
      stdin: JSON.stringify({ session_id: sid("b"), transcript_path: transcript("message") }),
    }),
  ),
);

// (c) last decision kind=end -> allow
check(
  "kind=end -> allow",
  isAllow(
    await runHook({
      stdin: JSON.stringify({ session_id: sid("c"), transcript_path: transcript("end") }),
    }),
  ),
);

// (d) garbage stdin -> allow (fail-open)
check("garbage stdin -> allow", isAllow(await runHook({ stdin: "not json at all" })));

// (e) VOICE_DISABLE=1 -> allow
check(
  "VOICE_DISABLE=1 -> allow",
  isAllow(
    await runHook({
      stdin: JSON.stringify({ session_id: sid("e"), transcript_path: transcript(null) }),
      env: { VOICE_DISABLE: "1" },
    }),
  ),
);

// (g) voice mode without an API key -> allow (don't nudge into a non-functional tool)
check(
  "voice mode + no key -> allow",
  isAllow(
    await runHook({
      stdin: JSON.stringify({ session_id: sid("g"), transcript_path: transcript(null) }),
      env: { VOICE_MODE: "voice", OPENAI_API_KEY: "" },
    }),
  ),
);

// (h) voice mode WITH an API key -> block (voice can run)
check(
  "voice mode + key -> block",
  isBlock(
    await runHook({
      stdin: JSON.stringify({ session_id: sid("h"), transcript_path: transcript(null) }),
      env: { VOICE_MODE: "voice", OPENAI_API_KEY: "sk-test" },
    }),
  ),
);

// (f) bounded retry: same session, no new decision, third nudge -> allow
{
  const s = sid("f");
  const t = transcript(null);
  const r1 = await runHook({ stdin: JSON.stringify({ session_id: s, transcript_path: t }) });
  const r2 = await runHook({ stdin: JSON.stringify({ session_id: s, transcript_path: t }) });
  const r3 = await runHook({ stdin: JSON.stringify({ session_id: s, transcript_path: t }) });
  check("bounded retry: nudge, nudge, then allow", isBlock(r1) && isBlock(r2) && isAllow(r3));
}

if (failures) {
  console.error(`\n${failures} hook check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Stop-hook checks passed.");
process.exit(0);
