// Developer feedback: optional, local, and attached to the call it is about. Nothing here
// touches a real home directory or a real repository — the writer is injected.

import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFeedback, buildRecord, formatRecord, readFeedback } from "../src/feedback.mjs";
import { identity, newRecords } from "../scripts/feedback.mjs";

const call = {
  message: "Tests pass. Open the PR?",
  spoken: "I test passano. Apro la PR?",
  options: ["Open it", "Run more tests"],
  heard: "apri la prima",
  decision: { kind: "choice", value: "Open it" },
  turns: [{ role: "user", content: "apri la prima" }],
  trace: [{ stage: "armed", at: 0 }, { stage: "decided", at: 4100, kind: "choice" }],
};

test("a record carries the comment and the whole call it is about", () => {
  const r = buildRecord({ comment: "  ha scelto giusto  ", call, now: 0, version: "0.7.0", env: { VOICE_LANG: "Italiano" } });
  assert.equal(r.comment, "ha scelto giusto", "trimmed");
  assert.equal(r.version, "0.7.0");
  assert.equal(r.settings.lang, "Italiano");
  assert.equal(r.call.heard, "apri la prima");
  assert.deepEqual(r.call.options, ["Open it", "Run more tests"]);
  assert.equal(r.call.trace.at(-1).at, 4100, "the timings are what a log cannot recover later");
  assert.equal(r.at, "1970-01-01T00:00:00.000Z");
});

test("an empty comment writes nothing at all — the field is optional", () => {
  let wrote = false;
  const append = () => (wrote = true);
  assert.equal(appendFeedback(buildRecord({ comment: "", call, now: 0 }), { append, mkdir: () => {} }), false);
  assert.equal(appendFeedback(buildRecord({ comment: "   ", call, now: 0 }), { append, mkdir: () => {} }), false);
  assert.equal(wrote, false);
});

test("a comment is appended as one JSON line", () => {
  const lines = [];
  const ok = appendFeedback(buildRecord({ comment: "troppo lento", call, now: 0 }), {
    append: (_f, line) => lines.push(line),
    mkdir: () => {},
  });
  assert.equal(ok, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\n$/);
  assert.equal(JSON.parse(lines[0]).comment, "troppo lento");
});

test("a file that cannot be written loses the comment, never the call", () => {
  const ok = appendFeedback(buildRecord({ comment: "x", call, now: 0 }), {
    append: () => {
      throw new Error("EACCES");
    },
    mkdir: () => {},
  });
  assert.equal(ok, false, "reported, not thrown");
});

test("a damaged line costs one record, not the file", () => {
  const text = `${JSON.stringify({ comment: "a" })}\nnot json\n${JSON.stringify({ comment: "b" })}\n`;
  assert.deepEqual(readFeedback(text).map((r) => r.comment), ["a", "b"]);
});

test("exporting twice does not duplicate what is already there", () => {
  const a = { at: "2026-08-18T10:00:00.000Z", comment: "uno" };
  const b = { at: "2026-08-18T11:00:00.000Z", comment: "due" };
  assert.deepEqual(newRecords([a, b], [a]), [b]);
  assert.deepEqual(newRecords([a], [a]), []);
  assert.notEqual(identity(a), identity(b));
});

test("the readable form leads with the comment, because it is the only part written for a reader", () => {
  const text = formatRecord(buildRecord({ comment: "ha capito male", call, now: 0 }), 0);
  assert.match(text.split("\n")[1], /^comment: ha capito male$/);
  assert.match(text, /heard: apri la prima/);
  assert.match(text, /decided@4100ms/);
});
