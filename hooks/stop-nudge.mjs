#!/usr/bin/env node
// Stop hook: makes Claude call `talk_to_user` at every stopping point, deterministically.
//
// Contract (all fail-open — on ANY error we allow the stop, never trap the user):
//   * VOICE_DISABLE=1                      -> allow stop.
//   * last talk_to_user decision kind=end  -> allow stop (the voice loop finished).
//   * kind=message | kind=choice | none    -> block with a nudge to call talk_to_user.
//   * bounded retry: if we already nudged twice for the same state without the model
//     producing a NEW talk_to_user result, allow the stop so a disobeying model can't
//     ping-pong forever.
//
// Output: to block, print {"decision":"block","reason":"..."} and exit 0.
//         to allow, exit 0 with no output.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "../src/env.mjs";

// Pick up persisted settings (plugin-root/.env) so the key/mode gate below matches the
// server's view even when nothing was exported in the shell.
loadEnvFile();

const DECISION_KINDS = new Set(["choice", "message", "end"]);
const MAX_NUDGES = 2;
// The nudge is also the documentation. A user who installed the plugin has no project file
// explaining the two payloads, so the contract has to travel with the reminder itself —
// otherwise `message` arrives as a two-line summary and every follow-up question dies on
// "I don't know".
const NUDGE_REASON =
  "Before stopping, call the talk_to_user tool so the user can answer by voice. Write your " +
  "answer in the terminal as normal FIRST, then pass: `message` = that full text, verbatim " +
  "(it is the voice agent's only knowledge, so a summary makes follow-up questions " +
  "impossible — strip only code blocks and raw output); `options` = the distinct choices you " +
  "offered; `spoken` = what is read aloud, word for word. Write it for the ear: two to four " +
  "sentences, roughly 40-70 words — enough to say what happened and why it matters before the " +
  "question, then the options named and numbered out loud (\"uno, ...; due, ...\"). Shorter " +
  "lands as an abrupt question with no context; longer and the user is sitting there waiting " +
  "to answer. No code, no paths, no file names. When the tool returns kind=end, you may stop.";

function allow() {
  // No output + exit 0 = let Claude stop.
  process.exit(0);
}

function block() {
  process.stdout.write(JSON.stringify({ decision: "block", reason: NUDGE_REASON }));
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Walk any nested content structure and collect strings that parse to a decision object.
// Returns the parsed decisions in document order.
function extractDecisions(line) {
  const found = [];
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return found;
  }
  const visit = (node) => {
    if (node == null) return;
    if (typeof node === "string") {
      const s = node.trim();
      if (s.startsWith("{") && s.includes("kind")) {
        try {
          const d = JSON.parse(s);
          if (d && DECISION_KINDS.has(d.kind)) found.push(d);
        } catch {
          /* not a decision */
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v);
      return;
    }
    if (typeof node === "object") {
      for (const v of Object.values(node)) visit(v);
    }
  };
  visit(obj);
  return found;
}

// Returns { kind, line } for the most recent decision in the transcript, or null.
function lastDecision(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const decisions = extractDecisions(lines[i]);
    if (decisions.length) {
      // Last decision on the latest line wins.
      return { kind: decisions[decisions.length - 1].kind, line: i };
    }
  }
  return null;
}

function statePath(sessionId) {
  const dir = join(process.env.TMPDIR || tmpdir(), "claude-voice");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return join(dir, `nudge-${(sessionId || "unknown").replace(/[^\w.-]/g, "_")}.json`);
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { lastDecisionLine: -1, nudges: 0 };
  }
}

function writeState(path, state) {
  try {
    writeFileSync(path, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function main() {
  if (process.env.VOICE_DISABLE === "1") allow();

  // Only nudge when the voice loop can actually run. In the default (voice) mode that means
  // OPENROUTER_API_KEY must be set; otherwise talk_to_user can't function and a nudge would
  // just surface as a confusing "stop hook" message in an ordinary session. Text mode always
  // runs. (This said OPENAI_API_KEY until the pipeline moved to OpenRouter, which meant a
  // correctly configured install never got nudged at all.)
  const mode = process.env.VOICE_MODE === "text" ? "text" : "voice";
  if (mode === "voice" && !process.env.OPENROUTER_API_KEY) allow();

  const input = readStdin();
  let hook = {};
  try {
    hook = JSON.parse(input);
  } catch {
    allow(); // no parseable input -> fail open
  }

  const decision = hook.transcript_path ? lastDecision(hook.transcript_path) : null;

  // Voice loop explicitly finished.
  if (decision && decision.kind === "end") allow();

  // Bounded-retry guard, keyed by whether a NEW decision appeared since last run.
  const sPath = statePath(hook.session_id);
  const state = readState(sPath);
  const curLine = decision ? decision.line : -1;

  if (curLine > state.lastDecisionLine) {
    // Model produced a new talk_to_user result since we last looked — reset the counter.
    state.lastDecisionLine = curLine;
    state.nudges = 0;
  }

  if (state.nudges >= MAX_NUDGES) {
    // We've nudged repeatedly with no new tool call — give up so we don't trap the user.
    state.nudges = 0;
    writeState(sPath, state);
    allow();
  }

  state.nudges += 1;
  writeState(sPath, state);
  block();
}

main();
