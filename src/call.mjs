// The call: five states, and the only file that knows the order they come in.
//
//   S0 armed       the page shows the question and waits for the button. Nothing is paid for
//   S1 opening     the TTS reads Claude's line VERBATIM. No model is involved
//   S2 listen      one utterance, ended by silence
//   S3 transcribe  Whisper turns it into words
//   S4 route       the brain says whether to answer (-> S1) or to decide (-> S5)
//   S4b confirm    a choice only: a second, blind reading of the same words has to agree
//   S5 close       policy validates the decision, the page gets a receipt, Claude gets JSON
//
// It talks to four interfaces and to nothing else — no network, no audio device, no timers of
// its own beyond the ones it hands to the audio backend. That is what makes the whole flow
// testable with four fakes and no ports.

import { config } from "./config.mjs";
import { looksGarbled, normalizeDecision } from "./policy.mjs";

const log = (m) => process.stderr.write(`[claude-voice] call: ${m}\n`);

// The second reading, or null when there isn't one. A brain that cannot confirm and a provider
// that fails are the same answer here: no confirmation. Never throws — a failed second opinion
// must cost the user a message to Claude, not the whole call.
async function confirmedIndex({ brain, options, heard, log }) {
  if (typeof brain.confirmChoice !== "function") {
    log("this brain cannot confirm a choice — treating it as unconfirmed");
    return null;
  }
  try {
    return await brain.confirmChoice({ options, transcript: heard });
  } catch (e) {
    log(`the second reading failed (${String(e?.message ?? e)}) — treating it as unconfirmed`);
    return null;
  }
}

export async function runCall({ message, options = [], spoken = "", signal, modules, cfg = config }) {
  const { audio, tts, stt, brain } = modules;
  const stopped = () => signal?.aborted;

  // S0 — the gate. A call nobody answers must cost nothing: no synthesis, no transcription,
  // no model. This is the only reason the button exists rather than an open microphone.
  // No tab, no call. The reason has to travel back to Claude rather than into stderr: on a
  // headless machine the terminal is the only place the user will ever see the URL.
  if (!(await audio.arm({ spoken, options }))) {
    const note = audio.hint?.();
    return note ? { kind: "end", note } : { kind: "end" };
  }
  if (!(await audio.waitForButton(cfg.waitMs))) {
    log("nobody answered — closing without opening the call");
    return { kind: "end" };
  }

  // Claude wrote `spoken` for the ear. If it did not, its full message is all we have.
  let say = spoken.trim() || message;
  const turns = [];

  for (let turn = 0; turn < cfg.maxTurns; turn++) {
    if (stopped()) return { kind: "end" };

    // S1 — say it, verbatim.
    const voice = await tts.speak(say);
    const { interrupted } = await audio.play(voice);
    if (interrupted) log("interrupted — listening");
    if (stopped()) return { kind: "end" };

    // S2 + S3 — one utterance, then words.
    const heard = await stt.transcribe(await audio.record());
    if (stopped()) return { kind: "end" };

    // Silence is not a turn, and neither is a transcript in the wrong alphabet: that is the
    // transcriber inventing words out of room noise. Asking again costs one synthesis;
    // sending either to the brain costs a turn AND invites it to answer for the user.
    if (!heard || looksGarbled(heard, cfg.langCode)) {
      if (heard) log(`transcript ${JSON.stringify(heard)} is not ${cfg.langCode} — asking again`);
      say = cfg.retryLine;
      continue;
    }
    turns.push({ role: "user", content: heard });

    // S4 — choosing, asking, or done?
    const routed = await brain.route({ message, options, turns });
    if (stopped()) return { kind: "end" };

    // The brain answered with nothing. Ask again rather than reporting a blank decision: one
    // more synthesis is cheap, and a turn Claude cannot read is worse than a repeated question.
    if (routed.kind === "empty") {
      log("the brain returned an empty answer — asking again");
      turns.pop();
      say = cfg.retryLine;
      continue;
    }

    if (routed.kind === "speak") {
      turns.push({ role: "assistant", content: routed.text });
      say = routed.text;
      continue;
    }

    // Two independent readings have to agree before Claude acts on a position. The second one
    // is a separate model call that sees only what the user said and the options — never the
    // router's verdict, which it would simply agree with. Three outcomes:
    //
    //   same position   -> the choice stands
    //   no choice heard -> Claude gets the user's own words instead. Silent: they already said
    //                      it clearly once, and making them repeat it is its own kind of wrong
    //   a different one -> nobody wins. Read it back and let the user settle it
    //
    // The check runs only on a choice, so the extra call is not on the common path. If it
    // cannot run at all — no confirmer, a provider down — the choice does not get through:
    // an unverified position is exactly the failure this exists to prevent.
    if (routed.decision?.kind === "choice") {
      const seen = await confirmedIndex({ brain, options, heard, log });
      if (stopped()) return { kind: "end" };

      if (seen === null) {
        log("the second reading heard no choice — sending the words to Claude instead");
        routed.decision = { kind: "message", value: heard };
      } else if (seen !== routed.decision.optionIndex) {
        log(`readings disagree: ${routed.decision.optionIndex} vs ${seen} — asking`);
        turns.push({ role: "assistant", content: cfg.confirmLine });
        say = cfg.confirmLine;
        continue;
      }
    }

    // S5 — policy has the last word on what Claude is told.
    const decision = normalizeDecision(routed.decision, options, log);
    audio.report({ decision, heard, spoken: say, message, options });
    return decision;
  }

  log(`hit the ${cfg.maxTurns}-turn ceiling — closing`);
  audio.report({ decision: { kind: "end" }, message, options });
  return { kind: "end" };
}
