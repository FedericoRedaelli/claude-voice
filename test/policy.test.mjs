// The rules, in isolation and at full speed: mic gating, the your-turn cue, the submit gate,
// and how a reported decision maps back onto Claude's options.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTurnState,
  normalizeDecision,
  looksGarbled,
  spokenOptionIndex,
} from "../src/policy.mjs";

// A clock we control, so "the agent is still talking" isn't a sleep().
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => (t += ms) };
}

test("half-duplex: mic stays shut for the WHOLE model turn, not just while audio arrives", () => {
  const c = clock();
  const s = createTurnState({ micReopenMs: 100, openingGraceMs: 1000, now: c.now });

  assert.equal(s.muted(0), true, "muted during the opening grace");
  c.tick(1000);
  assert.equal(s.muted(0), false, "grace over, nothing playing");

  s.responseCreated();
  assert.equal(s.muted(0), true, "generating: muted even before any audio exists");

  // The model streams 8s of speech in one burst and stops GENERATING immediately.
  const playingUntil = c.now() + 8000;
  s.responseDone();
  assert.equal(s.muted(playingUntil), true, "still playing: this is the loop bug");

  c.tick(8000);
  assert.equal(s.muted(playingUntil), true, "playback just ended, reopen delay not elapsed");
  c.tick(101);
  assert.equal(s.muted(playingUntil), false, "now it's the user's turn");
});

test("half-duplex: a gap between audio bursts does not reopen the mic mid-sentence", () => {
  const c = clock();
  const s = createTurnState({ micReopenMs: 100, openingGraceMs: 0, now: c.now });
  s.responseCreated();
  const firstBurst = c.now() + 500;
  c.tick(600); // first burst played out, second burst hasn't arrived
  assert.equal(s.muted(firstBurst), true, "response.done has not fired: still the model's turn");
});

test("full-duplex never mutes", () => {
  const s = createTurnState({ halfDuplex: false, openingGraceMs: 5000 });
  s.responseCreated();
  assert.equal(s.muted(Date.now() + 10000), false);
});

test("your-turn cue fires once per model turn, never on its own tail", () => {
  const c = clock();
  const s = createTurnState({ micReopenMs: 100, openingGraceMs: 0, now: c.now });
  s.responseCreated();
  const until = c.now() + 500;
  s.responseDone();
  assert.equal(s.micJustOpened(until), false, "still playing");
  c.tick(601);
  assert.equal(s.micJustOpened(until), true, "edge: muted -> open");

  // Playing the cue itself re-mutes the mic. Without arming, this is an infinite beep.
  const afterCue = c.now() + 90;
  assert.equal(s.micJustOpened(afterCue), false);
  c.tick(200);
  assert.equal(s.micJustOpened(afterCue), false, "cue must not retrigger on itself");

  s.responseCreated(); // next model turn re-arms it
  const until2 = c.now() + 300;
  s.responseDone();
  c.tick(401);
  assert.equal(s.micJustOpened(until2), true);
});

test("submit is rejected until the user has actually answered", () => {
  const s = createTurnState({ minAnswerMs: 600 });
  assert.equal(s.canSubmit().ok, false, "the agent deciding on its own");

  s.userSpoke(200); // 0.2s — the fragment that produced the wrong option
  assert.equal(s.canSubmit().ok, false, "a fragment is not an answer");

  s.userSpoke(900);
  assert.equal(s.canSubmit().ok, true);
});

test("a transcript in the wrong script is noise the transcriber dressed up as words", () => {
  assert.equal(looksGarbled("정답.", "it"), true, "Korean in an Italian call");
  assert.equal(looksGarbled("", "it"), true);
  assert.equal(looksGarbled("...", "it"), true, "punctuation only");
  assert.equal(looksGarbled("la seconda", "it"), false);
  assert.equal(looksGarbled("apri una PR, ok?", "it"), false);
  assert.equal(looksGarbled("Varikammit.", "it"), false, "mis-heard but still plausible speech");
  // No language hint, or a non-Latin language: nothing to compare against, so let it through.
  assert.equal(looksGarbled("정답.", null), false);
  assert.equal(looksGarbled("정답.", "ja"), false);
});

test("a decision is judged only once the transcript exists", () => {
  const s = createTurnState({ minAnswerMs: 0, langCode: "it" });
  s.userSpoke(900);
  assert.equal(s.transcribed, false, "the model reports before the transcript lands");
  assert.equal(s.canSubmit().ok, true, "unknown yet: nothing to reject it on");

  s.setTranscript("정답.");
  assert.equal(s.canSubmit().ok, false);
  s.setTranscript("la seconda");
  assert.equal(s.canSubmit().ok, true);

  // A new turn invalidates the previous transcript — it must not vouch for the next answer.
  s.userSpoke(900);
  assert.equal(s.transcribed, false);
});

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

test("the transcriber echoing our own vocabulary hint is not an answer", () => {
  // Verbatim from a real call: half a second of unclear audio, and gpt-4o-transcribe returned
  // the hint we had given it instead of what was said. The agent reported option 2 off it and
  // Claude acted on it.
  const echo = "la prima, la seconda, la terza, la quarta, sì, no, aspetta, ripeti.";
  const s = createTurnState({ minAnswerMs: 0, langCode: "it" });
  s.userSpoke(500);
  s.setTranscript(echo);

  assert.equal(spokenOptionIndex(echo), null, "four positions named = none chosen");
  const v = s.canSubmit({ kind: "choice", optionIndex: 2 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /4 different options named/);

  // Weighing options out loud is the same shape and equally not a decision.
  s.setTranscript("la prima o la seconda?");
  assert.equal(s.canSubmit({ kind: "choice", optionIndex: 1 }).ok, false);
});

test("a choice is refused when the transcript names a different option than the model", () => {
  const s = createTurnState({ minAnswerMs: 0, langCode: "it" });
  s.userSpoke(900);
  s.setTranscript("Sì, dicevo la terza");

  const bad = s.canSubmit({ kind: "choice", optionIndex: 2 });
  assert.equal(bad.ok, false);
  assert.equal(bad.spoken, 3, "so the agent can read option 3 back and confirm");
  assert.equal(s.canSubmit({ kind: "choice", optionIndex: 3 }).ok, true);

  // A free instruction is not a positional answer: nothing to cross-check against.
  assert.equal(s.canSubmit({ kind: "message" }).ok, true);
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
