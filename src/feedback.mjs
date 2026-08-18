// Developer feedback: what the user thought of a call, with the call attached.
//
// The loop this closes is that everything worth improving here happens in the four seconds
// between a question being read out and an answer coming back, and none of it is visible
// afterwards. "It picked the wrong option" is not actionable; the same sentence next to what
// Whisper heard, what the router decided, what the second reading said and how long each stage
// took, is.
//
// Three rules the shape of this file follows from:
//
//   1. Optional. No comment, no record. The box is empty by default and a call that is never
//      commented on writes nothing at all.
//   2. Local. It appends to a file in the user's own directory and stops there. Nothing is
//      uploaded, nothing is sent anywhere: exporting into the repository is a separate,
//      deliberate command run by a human who can read the file first.
//   3. Outside the plugin, because a plugin update replaces the plugin directory — the same
//      reason the key lives there.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userEnvDir } from "./env.mjs";

export const FEEDBACK_FILE = process.env.VOICE_FEEDBACK_FILE || join(userEnvDir, "feedback.jsonl");

// One record. `call` is whatever the last report carried — the question, the options, the
// transcript, the decision, the trace — and `comment` is the only part a human typed.
export function buildRecord({ comment, call = {}, now, version = null, env = process.env, platform = process.platform }) {
  return {
    at: new Date(now ?? Date.now()).toISOString(),
    version,
    comment: String(comment ?? "").trim(),
    machine: { platform, node: process.versions?.node ?? null },
    settings: {
      lang: env.VOICE_LANG ?? null,
      mode: env.VOICE_MODE ?? null,
      ttsModel: env.VOICE_TTS_MODEL ?? null,
      sttModel: env.VOICE_STT_MODEL ?? null,
      brainModel: env.VOICE_BRAIN_MODEL ?? null,
    },
    call: {
      message: call.message ?? null,
      spoken: call.spoken ?? null,
      options: call.options ?? [],
      heard: call.heard ?? null,
      decision: call.decision ?? null,
      turns: call.turns ?? [],
      trace: call.trace ?? [],
    },
  };
}

// JSON Lines: appendable from any process without reading what is already there, and readable
// one record at a time by a tool that does not know the whole file. A malformed line loses one
// record instead of the file.
export function appendFeedback(record, { file = FEEDBACK_FILE, append = appendFileSync, mkdir = mkdirSync } = {}) {
  if (!record?.comment) return false; // no comment, nothing to say
  try {
    mkdir(dirname(file), { recursive: true, mode: 0o700 });
    append(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false; // a lost comment must never cost the call it is about
  }
}

// Every record in the file, newest last. Bad lines are skipped, not thrown: this is read by a
// command whose whole job is to show the user what is there.
export function readFeedback(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* one damaged line is not the end of the file */
    }
  }
  return out;
}

export function loadFeedback(file = FEEDBACK_FILE) {
  try {
    return readFeedback(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

// What a human reads before deciding to publish any of it. One block per record, and the
// comment first: it is the only part that was written for a reader.
export function formatRecord(r, index = 0) {
  const lines = [
    `--- ${index + 1} ${r.at ?? ""}${r.version ? ` v${r.version}` : ""}`,
    `comment: ${r.comment ?? ""}`,
  ];
  const decision = r.call?.decision;
  if (decision) lines.push(`decision: ${decision.kind}${decision.value ? ` — ${decision.value}` : ""}`);
  if (r.call?.heard) lines.push(`heard: ${r.call.heard}`);
  if (r.call?.options?.length) lines.push(`options: ${r.call.options.join(" | ")}`);
  if (r.call?.trace?.length) {
    lines.push(`trace: ${r.call.trace.map((e) => `${e.stage}@${e.at}ms`).join(" ")}`);
  }
  return lines.join("\n");
}
