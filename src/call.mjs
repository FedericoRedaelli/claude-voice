// The call: five states, and the only file that knows the order they come in.
//
//   S0 armed       the page shows the question and waits for the button. Nothing is paid for
//   S1 opening     the TTS reads Claude's line VERBATIM. No model is involved
//   S2 listen      one utterance, ended by silence
//   S3 transcribe  Whisper turns it into words
//   S4 route       the brain says whether to answer (-> S1) or to decide (-> S5)
//   S5 close       policy validates the decision, the page gets a receipt, Claude gets JSON
//
// It talks to four interfaces and to nothing else — no network, no audio device, no timers of
// its own beyond the ones it hands to the audio backend. That is what makes the whole flow
// testable with four fakes and no ports.

import { config } from "./config.mjs";
import { normalizeDecision } from "./policy.mjs";

const log = (m) => process.stderr.write(`[claude-voice] call: ${m}\n`);

export async function runCall({ message, options = [], spoken = "", signal, modules, cfg = config }) {
  const { audio, tts, stt, brain } = modules;
  const stopped = () => signal?.aborted;

  // S0 — the gate. A call nobody answers must cost nothing: no synthesis, no transcription,
  // no model. This is the only reason the button exists rather than an open microphone.
  if (!(await audio.arm({ spoken, options }))) return { kind: "end" };
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

    if (!heard) {
      // Silence is not a turn. Asking again costs one synthesis; sending an empty transcript
      // to the model costs a turn AND invites it to answer for the user.
      say = cfg.retryLine;
      continue;
    }
    turns.push({ role: "user", content: heard });

    // S4 — choosing, asking, or done?
    const routed = await brain.route({ message, options, turns });
    if (stopped()) return { kind: "end" };

    if (routed.kind === "speak") {
      turns.push({ role: "assistant", content: routed.text });
      say = routed.text;
      continue;
    }

    // S5 — policy has the last word on what Claude is told, exactly as before.
    const decision = normalizeDecision(routed.decision, options, log);
    audio.report({ decision, heard, spoken: say, message, options });
    return decision;
  }

  log(`hit the ${cfg.maxTurns}-turn ceiling — closing`);
  audio.report({ decision: { kind: "end" }, message, options });
  return { kind: "end" };
}
