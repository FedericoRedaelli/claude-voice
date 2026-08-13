// The rules, in isolation and at full speed: how a reported decision maps back onto Claude's
// options, and the two cross-checks that stand between a garbled turn and Claude acting on it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  choiceDisagreement,
  choiceUncorroborated,
  optionEcho,
  looksGarbled,
  normalizeDecision,
  spokenOptionIndex,
} from "../src/policy.mjs";

test("the position the user named out loud is read straight off the transcript", () => {
  assert.equal(spokenOptionIndex("la prima"), 1);
  assert.equal(spokenOptionIndex("Sì, dicevo la terza"), 3);
  assert.equal(spokenOptionIndex("vai con la seconda grazie"), 2);
  assert.equal(spokenOptionIndex("the first one"), 1);
  assert.equal(spokenOptionIndex("opzione 3"), 3);
  // Nothing to go on — the answer is by content, not by position.
  assert.equal(spokenOptionIndex("apri la pull request"), null);
  assert.equal(spokenOptionIndex(""), null);
  // Named two: they were asking, not choosing.
  assert.equal(spokenOptionIndex("la prima o la seconda?"), null);
  // "un attimo" must not read as option one.
  assert.equal(spokenOptionIndex("aspetta un attimo"), null);
});

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

test("a choice is refused when the transcript names a different option than the brain", () => {
  // The failure this project started from.
  assert.match(
    choiceDisagreement({ kind: "choice", optionIndex: 3 }, "Sì, dicevo la prima"),
    /you said option 1.*reported option 3/,
  );
  assert.equal(choiceDisagreement({ kind: "choice", optionIndex: 1 }, "Sì, dicevo la prima"), null);
});

test("the transcriber echoing our own vocabulary hint is not an answer", () => {
  // Verbatim from a real call: half a second of unclear audio, and the transcriber returned
  // the hint we had given it instead of what was said. Option 2 was reported off it.
  const echo = "la prima, la seconda, la terza, la quarta, sì, no, aspetta, ripeti.";
  assert.match(choiceDisagreement({ kind: "choice", optionIndex: 2 }, echo), /named 4 options/);
  // Weighing options out loud is the same shape and equally not a decision.
  assert.match(
    choiceDisagreement({ kind: "choice", optionIndex: 1 }, "la prima o la seconda?"),
    /named 2 options/,
  );
});

test("nothing to cross-check against is not a disagreement", () => {
  // An answer by content names no position at all.
  assert.equal(choiceDisagreement({ kind: "choice", optionIndex: 1 }, "apri la pull request"), null);
  // A free instruction is not a positional answer.
  assert.equal(choiceDisagreement({ kind: "message", value: "fai altro" }, "la terza"), null);
  assert.equal(choiceDisagreement({ kind: "end" }, "la terza"), null);
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

// The failure this rule exists for, run as it actually happened. Claude offered four
// approaches; the user declined all of them for now. The brain reported option 1 — the very
// approach being declined — and the old gate waved it through, because the gate only compared
// positions and the user had named none.
test("choiceUncorroborated: a refusal that names nothing is never a choice", () => {
  const opts = [
    "A + B: finestra sullo Stop hook con coda sotto",
    "Solo A: finestra di dettatura",
    "Solo B: coda persistente",
    "C: processo esterno",
  ];
  const said = "Ma per il momento direi che evitiamo questa cosa dell'injection del prompt, facciamo il resto.";

  // The old gate saw nothing wrong — that is the bug, pinned here so it cannot come back.
  assert.equal(choiceDisagreement({ kind: "choice", optionIndex: 1 }, said), null);
  assert.match(
    choiceUncorroborated({ kind: "choice", optionIndex: 1 }, said, opts),
    /names or repeats/,
  );

  // Naming the position is corroboration.
  assert.equal(choiceUncorroborated({ kind: "choice", optionIndex: 3 }, "facciamo la terza", opts), null);
  // So is repeating the option's own words, which is how people answer without counting.
  assert.equal(
    choiceUncorroborated({ kind: "choice", optionIndex: 3 }, "andiamo con la coda persistente", opts),
    null,
  );
  // A clash is somebody else's job — this rule must not double-report it.
  assert.equal(choiceUncorroborated({ kind: "choice", optionIndex: 1 }, "la terza", opts), null);
  // Non-choices pass straight through.
  assert.equal(choiceUncorroborated({ kind: "message", value: "x" }, said, opts), null);
  assert.equal(choiceUncorroborated({ kind: "end" }, said, opts), null);
});

test("optionEcho: measures how much of an option the user actually said", () => {
  assert.equal(optionEcho("andiamo con la coda persistente", "Coda persistente"), 1);
  assert.equal(optionEcho("apri la pull request", "Coda persistente"), 0);
  // An option with no content words of its own cannot corroborate anything.
  assert.equal(optionEcho("qualsiasi cosa", "A e B"), 0);
});
