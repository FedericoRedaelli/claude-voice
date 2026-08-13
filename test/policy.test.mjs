// The rules, in isolation and at full speed: how a reported decision maps back onto Claude's
// options, and the one check that keeps a garbled transcript from becoming an answer.
//
// The cross-check on WHICH option was picked no longer lives here. It used to be ordinals in
// six languages; it is now a second model reading, tested in test/call.test.mjs where the two
// readings meet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { looksGarbled, normalizeDecision } from "../src/policy.mjs";


test("a transcript in the wrong script is noise the transcriber dressed up as words", () => {
  // Verbatim from a real call: an Italian turn came back as Korean, and a decision was built
  // on it.
  assert.equal(looksGarbled("정답.", "it"), true);
  assert.equal(looksGarbled("", "it"), true);
  assert.equal(looksGarbled("...", "it"), true);
  assert.equal(looksGarbled("la prima", "it"), false);
  // No language to check against, or a language that is not written in Latin: no opinion.
  assert.equal(looksGarbled("정답.", null), false);
  assert.equal(looksGarbled("정답.", "ja"), false);
});




test("normalizeDecision: the reported index beats the reported text", () => {
  const opts = ["Rifare da zero", "Migliorare quella esistente", "Farne una seconda"];
  // Exactly the reported failure: user said "la prima", model attached the wrong text.
  assert.deepEqual(normalizeDecision({ kind: "choice", value: opts[2], optionIndex: 1 }, opts), {
    kind: "choice",
    value: "Rifare da zero",
  });
  assert.deepEqual(normalizeDecision({ kind: "choice", value: "", optionIndex: 3 }, opts).value, opts[2]);
  // Out-of-range index falls back to matching the text.
  assert.deepEqual(normalizeDecision({ kind: "choice", value: opts[1], optionIndex: 9 }, opts).value, opts[1]);
  // Neither: it's an instruction, not a choice — Claude must not act on an option.
  assert.deepEqual(normalizeDecision({ kind: "choice", value: "mix of one and two", optionIndex: 0 }, opts), {
    kind: "message",
    value: "mix of one and two",
  });
  assert.deepEqual(normalizeDecision({ kind: "choice", value: "2" }, opts).value, opts[1]);
  assert.deepEqual(normalizeDecision({ kind: "end", value: "bye" }, opts), { kind: "end" });
});
