// Text-mode fallback for the decision loop. No key, no browser, no audio — pure local I/O.
//
// The MCP server owns stdin/stdout (that is the JSON-RPC transport), so this MUST talk to
// the terminal directly via /dev/tty. It prints the summary + numbered options and reads a
// single line, mapping it to the same {kind, value} contract as the voice path.

import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

function normalize(line) {
  return String(line || "").trim();
}

// A blank line, "stop", "done", "quit", or "exit" ends the loop.
const END_WORDS = new Set(["", "stop", "done", "quit", "exit", "end"]);

export async function runTextSession({ message, options = [], signal }) {
  if (signal?.aborted) return { kind: "end" };
  const tty = createReadStream("/dev/tty");
  const out = createWriteStream("/dev/tty");

  // Opening /dev/tty fails asynchronously (ENXIO) when there is no controlling terminal.
  // Guard both streams so that degrades to a clean {kind:"end"} instead of crashing.
  const openFailed = new Promise((resolve) => {
    const onErr = () => resolve({ kind: "end" });
    tty.once("error", onErr);
    out.once("error", onErr);
  });

  const rl = createInterface({ input: tty, output: out, terminal: false });
  rl.on("error", () => {}); // swallow late readline errors

  const lines = [];
  lines.push("");
  lines.push("──────── claude-voice (text mode) ────────");
  lines.push(message);
  if (options.length) {
    lines.push("");
    lines.push("Options:");
    options.forEach((opt, i) => lines.push(`  ${i + 1}. ${opt}`));
  }
  lines.push("");
  lines.push("Reply: a number to pick an option, free text for an instruction,");
  lines.push("or blank/stop to finish.");
  lines.push("──────────────────────────────────────────");
  const interaction = new Promise((resolve) => {
    out.write(lines.join("\n") + "\n> ");
    rl.once("line", (l) => resolve(l));
    rl.once("close", () => resolve(""));
  });

  // The user pressed Esc in Claude Code: stop waiting on the prompt and return.
  const cancelled = new Promise((resolve) => {
    signal?.addEventListener?.("abort", () => resolve({ kind: "end" }), { once: true });
  });

  // Whichever settles first: a real answer, a stream-open failure, or cancellation → end.
  const answer = await Promise.race([interaction, openFailed, cancelled]);

  rl.close();
  tty.close?.();
  out.end?.();

  // openFailed resolves to an object; the interaction resolves to a string.
  if (answer && typeof answer === "object" && answer.kind) return answer;

  const text = normalize(answer);
  const lower = text.toLowerCase();

  if (END_WORDS.has(lower)) {
    return { kind: "end" };
  }

  // Numeric pick that maps to an offered option → choice.
  if (options.length && /^\d+$/.test(text)) {
    const idx = Number(text) - 1;
    if (idx >= 0 && idx < options.length) {
      return { kind: "choice", value: options[idx] };
    }
  }

  // Exact-text match against an option (case-insensitive) → choice.
  const matched = options.find((o) => o.toLowerCase() === lower);
  if (matched) {
    return { kind: "choice", value: matched };
  }

  return { kind: "message", value: text };
}
