// Voice path: a bounded OpenAI Realtime session that acts as a spoken BRIDGE between the
// user and Claude. It is seeded with Claude's message as its only context, speaks it, lets
// the user reply (and interrupt), and — as soon as the user's answer is clear — reports it
// straight back to Claude via the submit_decision tool, which ends the call.
//
// The @openai/agents-realtime SDK does the hard parts: connection, turn-taking (server VAD),
// interruptions/barge-in, and tool execution. We only bridge raw PCM16 audio to/from `sox`.

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { config, requireApiKey } from "./config.mjs";
import { startMic, createSpeaker, beepPcm, waitForSpeech } from "./audio.mjs";
import { createTurnState, normalizeDecision } from "./policy.mjs";
import { createWhisperRecognizer, waitForWakeWord } from "./wake.mjs";

export { normalizeDecision };

const DEBUG = process.env.VOICE_DEBUG === "1";
// The MCP server's stderr is usually invisible in Claude Code, so when debugging we ALSO
// append to a log file the user can read after a real run.
const LOGFILE = join(dirname(fileURLToPath(import.meta.url)), "..", "voice-debug.log");
const t0 = Date.now();
const dbg = (m) => {
  if (!DEBUG) return;
  const line = `+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}`;
  process.stderr.write(`[claude-voice:debug] ${line}\n`);
  try {
    appendFileSync(LOGFILE, `${line}\n`);
  } catch {
    /* ignore */
  }
};

// A silent chunk the same size as the one we're dropping, so the stream the API sees stays
// continuous and its clock keeps matching ours. Reused rather than allocated per chunk.
let SILENCE = Buffer.alloc(0);
function silenceLike(chunk) {
  if (SILENCE.length !== chunk.length) SILENCE = Buffer.alloc(chunk.length);
  return SILENCE.buffer.slice(SILENCE.byteOffset, SILENCE.byteOffset + SILENCE.byteLength);
}

// RMS (0-100%) of a PCM16 chunk — lets us tell "mic is sending silence" from "mic is muted".
function rmsPct(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return (Math.sqrt(sum / n) / 32768) * 100;
}

function buildInstructions(message, options) {
  const optionBlock = options.length
    ? `\n\nOptions Claude offered the user:\n${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`
    : "";
  // No options means Claude is REPORTING, not asking — a finished run, a summary of what was
  // done. The rest of this prompt is written around picking between alternatives, and without
  // this the agent turns a report into a question, invents choices to offer, and refuses to
  // let go: the user says "ok, va bene", the agent asks what they would like to do next, and a
  // run that was over keeps the call open. Hands-free, that is the failure that matters —
  // walking away has to be a way of finishing, not a way of hanging.
  const closingBlock = options.length
    ? ""
    : [
        "",
        "Claude offered NO options this time: this is a REPORT, not a question. Say what",
        "happened in one or two sentences and then stop. Do not invent options, do not ask",
        "which one they want, do not ask what to do next — if they have something to add they",
        "will say it. Anything that sounds like agreement, acknowledgement or nothing at all",
        "('ok', 'va bene', 'perfetto', 'grazie', silence) is kind='end': call submit_decision",
        "with it and let them go. Only a real new instruction is kind='message'.",
      ].join("\n");
  return [
    `Always speak in ${config.lang}, even if the user speaks another language.`,
    "",
    "HARD LIMIT, ABOVE EVERYTHING ELSE: your opening turn is AT MOST two short sentences —",
    "one saying what Claude did or asks, one asking the question with the options named. Under",
    "forty spoken words in total, about ten seconds. Every later turn is ONE sentence. The user",
    "cannot interrupt you while you speak, so a long turn is not thorough, it is a wall: they",
    "sit there unable to answer. Cut adjectives, context, reasoning, apologies and confirmations",
    "before you cut information.",
    "",
    "You are the spoken bridge between a user and the Claude Code agent. Your ONLY knowledge",
    "is Claude's message below — no tools, no repo access, no outside facts. If asked",
    "something not answerable from it, say you don't know.",
    "",
    "Assume the user is NOT looking at a screen — they may be in another room. Everything they",
    "need to answer must come out of your mouth. Never say 'as shown', 'on screen', 'in the",
    "terminal', 'the options listed', or 'pick one of those' — they can't see any of it. When",
    "Claude offered options, SAY the options themselves, short, and NUMBER them out loud in the",
    "exact order they are listed below ('one, commit now; two, open a pull request; three, keep",
    "going — which one?'). The numbering is what lets them answer 'the first one' and be",
    "understood. Never reorder them, never renumber them, never invent an option. Only tell",
    "them to go look at the screen if the answer genuinely requires reading something — a diff,",
    "a long output.",
    "",
    "Be EXTREMELY brief — this is a quick phone call, not a presentation. Speak first, without",
    "waiting: ONE short sentence (about 15 words) saying what Claude did or asks, then the",
    "question with the options in it. That's your whole opening turn — about five to eight",
    "seconds of speech. Never read Claude's message out verbatim, never explain your own role.",
    "Every later turn: one sentence, no preamble, no recap of what was already said.",
    "The user may interrupt you at any time — answer briefly using only Claude's message.",
    "",
    "NEVER decide for the user. You do not have an opinion, a preference, or permission to pick",
    "the sensible option yourself. After you ask, STOP and wait — silence means they are",
    "thinking, not that you should proceed. A submit_decision call made before they answered is",
    "rejected by the system and you will be told to keep listening; do not retry it, just wait.",
    "",
    "When — and ONLY when — the user has actually decided or given an instruction, call the",
    "submit_decision tool to report it back to Claude (this ends the call). Don't confirm or",
    "keep chatting once the answer is clear — just call the tool.",
    "- kind='choice' when the user picked one of the options listed below WHOLE and unmodified.",
    "  ALWAYS pass optionIndex — the option's number in the list below (1 for the first). If the",
    "  user answered by position ('the first', 'la prima', 'number two'), that number IS the",
    "  answer: pass it and do not try to recall which option text it was. Never guess an option",
    "  they did not mention. If you are not certain WHICH option they meant, ask — do not pick.",
    "- kind='message' with their own words for EVERYTHING else — and that includes a mix of two",
    "  options, an option with a condition or change attached, an option plus an extra request,",
    "  or an answer that is none of them. Do not round a partial match up to 'choice': report",
    "  what they actually said, in their words, and Claude will handle it.",
    "- kind='end' if they say stop, nothing, or never mind.",
    "",
    "Do NOT call submit_decision when: the user asked you a question, made small talk, asked",
    "you to repeat or to switch language, or said something you did not understand (a garbled",
    "or half-transcribed turn). In all those cases reply in one short sentence and, if you are",
    "unsure what they want, ask. When in doubt, ask instead of reporting — a wrong decision",
    "sent to Claude is much worse than one extra question.",
    closingBlock,
    "",
    "=== Claude's message ===",
    message,
    optionBlock,
  ].join("\n");
}

// Every live session registers its abort here, so a dying MCP server (Esc, SIGTERM, stdin
// closed) can silence sox instead of leaving a voice talking in an empty room.
const ACTIVE_ABORTS = new Set();

// When the last call ended. The MCP server outlives individual calls, so this survives across
// them and lets a quick follow-up question skip the "say something to wake me" gate.
let lastSessionEndedAt = 0;
export function abortActiveVoiceSessions(why = "shutdown") {
  for (const abort of [...ACTIVE_ABORTS]) {
    try {
      abort(why);
    } catch {
      /* ignore */
    }
  }
}

// Vocabulary hint for the transcriber: the words the answer is most likely to be made of.
// Positional answers in the session language, plus Claude's own option texts (which carry the
// project's nouns — branch names, file names — that a general model has never seen).
const POSITIONAL = {
  it: "la prima, la seconda, la terza, la quarta, sì, no, aspetta, ripeti",
  en: "the first, the second, the third, the fourth, yes, no, wait, repeat",
  es: "la primera, la segunda, la tercera, sí, no, espera, repite",
  fr: "la première, la deuxième, la troisième, oui, non, attends, répète",
  de: "die erste, die zweite, die dritte, ja, nein, warte, wiederhole",
  pt: "a primeira, a segunda, a terceira, sim, não, espera, repete",
};
function transcriptionPrompt(options) {
  const positional = POSITIONAL[config.langCode] || POSITIONAL.en;
  const opts = options.filter(Boolean).join(". ");
  return opts ? `${positional}. ${opts}.` : positional;
}

// What the environment asked for, before any per-session fallback overwrites it.
const HALF_DUPLEX_CONFIGURED = config.halfDuplex;

function turnDetection() {
  // Half-duplex has no barge-in by design, so nothing the mic picks up while the agent talks
  // should ever cancel its turn. This must be enforced SERVER-side: `interrupt_response:true`
  // makes the API truncate the in-flight response the moment its VAD thinks it heard speech,
  // and no amount of ignoring the event locally brings those words back — the model already
  // stopped generating them and started over. That was the "it cuts itself off and restarts".
  const interrupt = !config.halfDuplex;
  if (config.vad === "semantic_vad") {
    return { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: interrupt };
  }
  return {
    type: "server_vad",
    // Higher = more audio energy needed before it counts as speech. Raise it in a noisy room
    // (keyboard, fan, people); lower it if a quiet voice fails to trigger a turn.
    threshold: config.vadThreshold,
    // Audio kept from BEFORE the VAD decided you were talking. Too little and the first
    // syllable never reaches the transcriber: "la terza" came back as "Certa.", and the agent
    // then picked an option off a word you never said. The mic is muted while the agent talks,
    // so there is no echo to pad into.
    prefix_padding_ms: config.prefixPaddingMs,
    silence_duration_ms: config.silenceMs,
    create_response: true,
    interrupt_response: interrupt,
  };
}

// Audio dependencies are injectable so the whole session can be exercised headlessly (a
// self-test feeds synthesized speech in and captures audio out — no real mic/speaker).
export async function runVoiceSession({ message, options = [], spoken = "", deps = {}, signal } = {}) {
  requireApiKey();

  // The browser backend has to be reachable BEFORE the gate opens a mic — but it must never
  // be a new way for the call to fail: if no tab answers, sox takes over and the user gets
  // the old half-duplex behaviour instead of silence.
  // A tab missing for ONE call must not silently pin every later call to half-duplex, so the
  // configured value is restored before each session decides again.
  config.halfDuplex = HALF_DUPLEX_CONFIGURED;
  let audio = { startMic, createSpeaker, waitForSpeech };
  if (config.audio === "browser" && !deps.startMic) {
    const browser = await import("./browser-audio.mjs");
    if (await browser.ensureBrowserAudio()) {
      audio = browser;
      dbg(`audio backend: browser (${browser.browserAudioUrl()})`);
    } else {
      dbg("audio backend: browser requested but no tab — falling back to sox (half-duplex)");
      config.halfDuplex = true;
    }
  }

  const mkMic = deps.startMic || audio.startMic;
  const mkSpeaker = deps.createSpeaker || audio.createSpeaker;
  const beep = deps.beepPcm || beepPcm;
  const gate = deps.waitForSpeech || audio.waitForSpeech;

  // The gate: beep, then wait for the user to start talking before paying for (and starting)
  // a Realtime session. Claude has already printed its answer as text, so if nobody is at the
  // desk this returns {kind:"end"} and Claude simply stops — nothing talks to an empty room.
  // Still mid-conversation? Then don't make the user announce themselves again.
  const sinceLast = Date.now() - lastSessionEndedAt;
  const followUp = config.followupMs > 0 && sinceLast <= config.followupMs;
  if (followUp) dbg(`follow-up (${(sinceLast / 1000).toFixed(1)}s since last call) -> skipping gate`);

  if (config.waitMs > 0 && !followUp) {
    const cue = mkSpeaker();
    // While a cue of our own is playing the gate must not listen: on laptop speakers the tone
    // goes straight back into the mic, reads as speech, and opens a call nobody asked for.
    let quietUntil = 0;
    const playCue = (parts) => {
      try {
        let total = 0;
        for (const p of parts) {
          cue.write(beep(p));
          total += (p.leadMs || 0) + p.ms;
        }
        cue.flush?.(); // the tones are shorter than the speaker's jitter cushion
        quietUntil = Math.max(quietUntil, Date.now() + total + config.cueEchoMs);
      } catch {
        /* ignore */
      }
    };
    // The opening cue plays into a device that has been silent for minutes: lead-in silence to
    // wake a sleeping Bluetooth link, and two tones so a swallowed first one isn't fatal.
    playCue([
      { freq: 880, ms: 220, leadMs: 400, volume: 0.25 },
      { freq: 1180, ms: 220, leadMs: 90, volume: 0.25 },
    ]);
    // Then a soft tick while it waits, so "Claude is waiting for you" is a state you can hear
    // from the next room, not a single sound you had to be present for.
    const ticker =
      config.waitTickMs > 0
        ? setInterval(() => playCue([{ freq: 1180, ms: 70, volume: config.waitTickVolume }]), config.waitTickMs)
        : null;
    if (ticker?.unref) ticker.unref();

    // With a wake word configured the level gate stops being the decision and becomes the
    // cheap first stage: it says "someone spoke", the local recogniser says whether they
    // spoke to US. Everything else about the wait — the cue, the ticker, the deadline — is
    // the same; the two paths differ only in what counts as an answer.
    // The page's button is a valid answer to EITHER gate. A wake word that mishears you, or a
    // level gate that will not trip, must never be the only way in — there has to be a control
    // that always works. Racing it means the losing wait has to be cancelled, hence the extra
    // controller: the gate holds the microphone open until it is.
    const manual = new AbortController();
    const offManual = audio.onManualStart?.(() => manual.abort()) || (() => {});
    const gateSignal = signal ? AbortSignal.any([signal, manual.signal]) : manual.signal;
    const startedByHand = () => manual.signal.aborted && !signal?.aborted;

    if (config.wakeWord) {
      dbg(
        `gate: waiting up to ${(config.waitMs / 1000).toFixed(0)}s for "${config.wakeWord}" ` +
          `(level>=${config.wakeLevel}%, local whisper)`,
      );
      const woke = await waitForWakeWord({
        waitMs: config.waitMs,
        words: config.wakeWord,
        level: config.wakeLevel,
        speechMs: config.wakeMs,
        startMic: mkMic,
        recognize:
          deps.recognizeWake ||
          createWhisperRecognizer({
            bin: config.whisperBin,
            model: config.whisperModel,
            lang: config.langCode || "auto",
            words: config.wakeWord,
            log: dbg,
          }),
        signal: gateSignal,
        ignoreWhile: () => Date.now() < quietUntil,
        log: dbg,
      });
      if (ticker) clearInterval(ticker);
      offManual();
      await cue.stop?.();
      if (startedByHand()) dbg("started from the page button");
      else if (!woke) {
        dbg(`nobody said "${config.wakeWord}" -> ending without a session`);
        lastSessionEndedAt = Date.now();
        return { kind: "end" };
      }
      dbg("wake word heard -> opening session");
    } else {
      dbg(`gate: waiting up to ${(config.waitMs / 1000).toFixed(0)}s for speech (level>=${config.wakeLevel}%)`);
      const spoke = await gate({
        waitMs: config.waitMs,
        level: config.wakeLevel,
        speechMs: config.wakeMs,
        startMic: mkMic,
        signal: gateSignal,
        ignoreWhile: () => Date.now() < quietUntil,
      });
      if (ticker) clearInterval(ticker);
      offManual();
      // Let the beep finish, then hand the mic to the session (one sox recorder at a time).
      await cue.stop?.();
      if (startedByHand()) dbg("started from the page button");
      else if (!spoke) {
        dbg("gate: nobody spoke -> ending without a session");
        return { kind: "end" };
      }
      dbg("gate: speech detected -> opening session");
    }
  }

  let resolveDecision;
  const decisionPromise = new Promise((res) => (resolveDecision = res));
  let settled = false;
  let aborted = false;
  let speakerRef = null;
  const finish = (d) => {
    if (settled) return;
    settled = true;
    dbg(`reporting to Claude: ${JSON.stringify(d)}`);
    // Closing beep (descending) so the user hears the call end; speaker.stop() in `finally`
    // drains it before killing sox, so it plays out even as we return to Claude.
    try {
      speakerRef?.write(beep({ freq: 520, ms: 180 }));
      speakerRef?.flush?.(); // shorter than the jitter cushion — play it, don't hold it
    } catch {
      /* ignore */
    }
    // Leave the receipt on screen. The voice loop is otherwise the one part of a session you
    // cannot check afterwards — you hear a confirmation and have to take its word for what it
    // sent back. Best effort: no page, no receipt, and never a reason to fail the call.
    try {
      audio.reportToPage?.({
        decision: d,
        heard: turn.transcript || "",
        spoken: spoken?.trim() || "",
        message,
        options,
      });
    } catch {
      /* ignore */
    }
    resolveDecision(d);
  };

  // Cancellation: the user pressed Esc in Claude Code (or the server is shutting down). The
  // call must go silent AT ONCE — no closing beep, no draining the agent's queued sentence —
  // and the tool must return, or the agent keeps talking to an empty room.
  const abort = (why) => {
    if (aborted) return;
    aborted = true;
    dbg(`aborted (${why}) -> silencing session`);
    try {
      speakerRef?.stop({ immediate: true });
    } catch {
      /* ignore */
    }
    settled = true; // suppress finish()'s beep if a decision races in
    resolveDecision({ kind: "end" });
  };
  if (signal?.aborted) return { kind: "end" };
  signal?.addEventListener?.("abort", () => abort("signal"), { once: true });
  ACTIVE_ABORTS.add(abort);

  // Half-duplex turn taking and the "did the user actually answer?" gate live in policy.mjs so
  // they can be tested without a microphone. See test/policy.test.mjs.
  const turn = createTurnState({
    halfDuplex: config.halfDuplex,
    micReopenMs: config.micReopenMs,
    minAnswerMs: config.minAnswerMs,
    openingGraceMs: config.openingGraceMs,
    langCode: config.langCode,
  });

  // Resolves when the transcript of the current user turn arrives, or after a short grace —
  // a missing transcript is itself a signal (the API heard no words), never a reason to hang.
  let transcriptWaiter = null;
  const waitForTranscript = () =>
    new Promise((res) => {
      const t = setTimeout(() => {
        transcriptWaiter = null;
        res();
      }, config.transcriptWaitMs);
      if (t.unref) t.unref();
      transcriptWaiter = () => {
        clearTimeout(t);
        transcriptWaiter = null;
        res();
      };
    });

  // The exact code path the model's tool call takes. Exposed to deps.createSession so a fake
  // session in the tests drives the SAME gate the real one does.
  const handleSubmit = async ({ kind, value, optionIndex }) => {
    dbg(`submit_decision(kind=${kind}, index=${optionIndex ?? "-"}, value=${JSON.stringify(value ?? "")})`);
    // The model reports about 0.2s after the turn is committed; the transcript lands about
    // 0.4s after. Deciding in that gap is deciding without the one thing that shows whether
    // the API heard words at all — so wait for it (briefly) before judging.
    if (turn.turns > 0 && !turn.transcribed) {
      await waitForTranscript();
      dbg(`waited for transcript: ${JSON.stringify(turn.transcript ?? "(none)")}`);
    }
    const allowed = turn.canSubmit({ kind, optionIndex });
    if (!allowed.ok) {
      // Refusing here rather than in the prompt is the whole point: the model repeatedly
      // reported a decision the user never gave, and no wording stopped it. The call stays
      // open and the model is told to listen.
      dbg(`submit REJECTED (${allowed.reason}) — turns=${turn.turns} heard=${turn.heardMs}ms`);
      if (allowed.spoken) {
        // Two sources disagree about WHICH option: don't guess, and don't make them repeat the
        // whole thing — read the one they seem to have said back to them and take a yes/no.
        return (
          `Rejected: ${allowed.reason}. Ask them, in one short sentence, to confirm: name ` +
          `option ${allowed.spoken} out loud and ask if that is the one. Then report what they ` +
          `confirm.`
        );
      }
      return (
        `Rejected: ${allowed.reason}. Do not report anything yet. Ask them ONCE, in one short ` +
        `sentence, to say it again — then stay silent and listen. Never report a decision you ` +
        `did not clearly hear.`
      );
    }
    finish(normalizeDecision({ kind, value, optionIndex }, options, dbg));
    return "Reported to Claude.";
  };

  const submitDecision = tool({
    name: "submit_decision",
    description:
      "Report the user's decision back to Claude and end the call. Call this ONCE, as soon " +
      "as the user's answer or instruction is clear. Rejected if the user has not spoken yet.",
    parameters: z.object({
      kind: z.enum(["choice", "message", "end"]),
      value: z.string().nullable().optional(),
      // Positional answers ("the first one", "la prima") are the common case in speech, and
      // letting the model translate the position into option TEXT is where it silently picks
      // the wrong line. Make it report the NUMBER and do the lookup ourselves.
      optionIndex: z.number().int().nullable().optional(),
    }),
    execute: handleSubmit,
  });

  const sessionConfig = {
    outputModalities: ["audio"],
    audio: {
      input: {
        turnDetection: turnDetection(),
        noiseReduction: config.noise ? { type: config.noise } : null,
        // Language hint: without it short non-English turns get transcribed as garbage
        // English, and the agent then acts on nonsense.
        transcription: {
          model: config.transcribeModel,
          ...(config.langCode ? { language: config.langCode } : {}),
          // We know what the user is about to say better than a general transcriber does: the
          // answer is usually a position ("la terza") or one of Claude's option names. Handing
          // those over as context is the cheapest accuracy we can buy — "la terza" came back
          // as "Certa." and "il commit" as "Il camminto.", and the transcript is what the
          // wrong-option check is judged on.
          prompt: transcriptionPrompt(options),
        },
      },
      output: { voice: config.voice, speed: config.speed },
    },
  };

  const makeSession =
    deps.createSession ||
    (({ instructions, tools, sessionConfig: cfg }) =>
      new RealtimeSession(
        new RealtimeAgent({ name: "claude-voice-bridge", instructions, tools }),
        { transport: "websocket", model: config.model, config: cfg },
      ));

  const session = makeSession({
    instructions: buildInstructions(message, options),
    tools: [submitDecision],
    sessionConfig,
    // Test doubles call this directly instead of going through the SDK's tool plumbing.
    handleSubmit,
  });

  // --- audio bridge ---
  let speaker = mkSpeaker();
  speakerRef = speaker;
  let mic;
  let micStatTimer = null;

  session.on("audio", (evt) => speaker.write(Buffer.from(evt.data)));

  // Barge-in: when the user interrupts, drop the agent's already-queued audio so playback
  // stops immediately (sox buffers, so we replace the process).
  // Barge-in, debounced. Killing playback the instant the VAD fires makes every cough, key
  // press and door close chop the agent's sentence in half — heard as "it interrupted me" and
  // as choppy speech. A real interruption is someone who is STILL talking a moment later, so
  // wait that moment out: `input_audio_buffer.speech_stopped` arriving first cancels it.
  let bargeTimer = null;
  const cancelBarge = () => {
    if (!bargeTimer) return;
    clearTimeout(bargeTimer);
    bargeTimer = null;
  };
  const armBarge = () => {
    // In half-duplex we never send mic audio while the agent talks, so an "interruption" is
    // always spurious (leaked speaker sound). Honouring it was what made the agent clip its
    // own sentence and start over.
    if (config.halfDuplex) {
      dbg("interruption ignored (half-duplex)");
      return;
    }
    if (bargeTimer) return;
    bargeTimer = setTimeout(() => {
      bargeTimer = null;
      dbg("user interrupted -> flush speaker");
      speaker.stop({ immediate: true });
      speaker = mkSpeaker();
      speakerRef = speaker;
    }, config.bargeInMs);
    if (bargeTimer.unref) bargeTimer.unref();
  };
  session.on("audio_interrupted", armBarge);

  session.on("error", (err) => {
    const detail = err?.error ?? err;
    process.stderr.write(
      `[claude-voice] realtime error: ${typeof detail === "string" ? detail : JSON.stringify(detail)}\n`,
    );
  });

  // Optional half-duplex for users on SPEAKERS (no echo cancellation): mute the mic while the
  // agent is speaking so the speaker's output can't feed back. This disables barge-in — use
  // headphones + full-duplex (default) if you want to interrupt.
  //
  // The mute window must follow PLAYBACK, not the arrival of the model's audio: the model
  // streams a whole reply in about a second while sox plays it for several, so keying off the
  // last `audio` event re-opened the mic mid-sentence, the agent heard itself, interrupted
  // itself, and looped forever. speaker.playingUntil() is the real "still talking" signal.
  // The model streams a reply in bursts with gaps between them, so "nothing queued right now"
  // does NOT mean "it stopped talking". Keeping the mic shut for the whole turn — from
  // response.created until response.done AND the audio has finished playing — is what stops
  // the agent from hearing itself mid-sentence, flushing, and starting over.
  const micMuted = () => turn.muted(speakerRef?.playingUntil?.() ?? 0);

  // The user is not looking at the terminal, so the ONLY signal that the agent has stopped and
  // the mic is live is a sound. Without it they answer into a muted mic, get no reaction, and
  // conclude the thing is broken.
  const cueTurn = () => {
    if (!config.turnBeep || !config.halfDuplex) return;
    // The call is already over (a decision was reported): the next sound the user should hear
    // is the closing beep, not an invitation to speak.
    if (settled) return;
    if (!turn.micJustOpened(speakerRef?.playingUntil?.() ?? 0)) return;
    dbg("mic open -> your-turn cue");
    try {
      speakerRef?.write(beep({ freq: 660, ms: 90, volume: 0.12 }));
      speakerRef?.flush?.();
    } catch {
      /* ignore */
    }
  };

  // Speak first, but only after our config (instructions + tools) is applied, so the opening
  // turn isn't generated with empty instructions. session.updated is the ack.
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    // When Claude wrote the opening line itself, the agent's job for this turn is to READ it,
    // not to compose one. Composing is what made the opening run nine seconds while the mic
    // stayed shut: the model summarises Claude's whole message, adds its own framing, and the
    // user sits there unable to answer. Per-response instructions override the session's for
    // this turn only — every later turn goes back to the normal rules.
    const spokenLine = spoken?.trim();
    dbg(spokenLine ? `opening turn (verbatim, ${spokenLine.length} chars)` : "opening turn (response.create)");
    try {
      session.transport.sendEvent(
        spokenLine
          ? {
              type: "response.create",
              response: {
                instructions:
                  "Say the following out loud, word for word, and then STOP and wait. Do not " +
                  "add a greeting, a preamble, a summary or a closing question of your own. " +
                  "Do not rephrase it. Say exactly this and nothing else:\n\n" +
                  spokenLine,
              },
            }
          : { type: "response.create" },
      );
    } catch (err) {
      process.stderr.write(`[claude-voice] opening turn failed: ${err?.message ?? err}\n`);
    }
  };
  // How long the user's committed utterance was. The API doesn't hand us a duration, so we
  // time it from its own VAD events — this is what tells a real answer from the 0.2s fragment
  // the agent once turned into a wrong option.
  let speechStartedAt = 0;
  session.on("transport_event", (e) => {
    if (e?.type === "session.updated") open();
    const type = e?.type || "";
    if (type === "response.created") {
      turn.responseCreated();
      // A new turn gets a fresh cushion; the pause between turns is not a stall to ride out.
      speakerRef?.rearm?.();
    }
    if (type === "response.done") {
      turn.responseDone();
      // Nothing more is coming for this turn: release whatever is still held back, or a reply
      // shorter than the cushion would never be heard at all.
      speakerRef?.flush?.();
    }
    if (type === "input_audio_buffer.speech_started") {
      speechStartedAt = Date.now();
      armBarge();
    }
    // A blip that stops this fast was never an interruption — don't cut the agent for it.
    if (type === "input_audio_buffer.speech_stopped") cancelBarge();
    if (type === "input_audio_buffer.committed") {
      // silence_duration_ms of trailing quiet is part of the window, not of the speech.
      const ms = speechStartedAt ? Math.max(0, Date.now() - speechStartedAt - config.silenceMs) : 0;
      speechStartedAt = 0;
      turn.userSpoke(ms);
      dbg(`user turn #${turn.turns} (~${(ms / 1000).toFixed(1)}s of speech)`);
    }
    if (type === "conversation.item.input_audio_transcription.completed") {
      turn.setTranscript(e?.transcript || "");
      transcriptWaiter?.();
    }
    // The transcriber gave up: treat it as an empty transcript rather than waiting it out.
    if (type === "conversation.item.input_audio_transcription.failed") {
      turn.setTranscript("");
      transcriptWaiter?.();
    }
    if (DEBUG && /error|response\.(created|done)|speech_(started|stopped)|committed|transcription/.test(type)) {
      const tr = e?.transcript || e?.delta || "";
      dbg(`event ${type}${tr ? " :: " + JSON.stringify(tr) : ""}`);
    }
  });

  // Safety net only: never hang the tool call forever if the model never reports.
  const timeout = new Promise((res) => setTimeout(() => res({ kind: "end" }), config.timeoutMs));

  try {
    dbg(`connecting model=${config.model} vad=${config.vad} halfDuplex=${config.halfDuplex}`);
    // Log the numbering the agent is given, so a wrong pick can be audited after the fact.
    if (options.length) dbg(`options: ${options.map((o, i) => `${i + 1}=${o}`).join(" | ")}`);
    await session.connect({ apiKey: config.apiKey, model: config.model });
    dbg("connected; mic open");
    // Opening beep so the user knows the call is live and it's about to speak.
    try {
      speaker.write(beep({ freq: 880, ms: 200, leadMs: 150 }));
      speaker.flush?.();
    } catch {
      /* ignore */
    }
    const stats = { sent: 0, dropped: 0, level: 0, chunks: 0 };
    mic = mkMic((chunk) => {
      stats.chunks++;
      if (DEBUG) stats.level = Math.max(stats.level, rmsPct(chunk));
      if (micMuted()) {
        stats.dropped += chunk.length;
        // Muted means "hear silence", NOT "hear nothing". The server's VAD is a state machine
        // fed by a continuous stream: cut the stream mid-utterance and it can never see the
        // trailing silence that ends the turn, so it holds the turn open across the agent's
        // whole reply and glues the next words onto it. That is what produced a 13.9s "turn"
        // transcribed as "Come?", and the one-character fragments before it.
        session.sendAudio(silenceLike(chunk));
        return;
      }
      cueTurn();
      stats.sent += chunk.length;
      session.sendAudio(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    });
    // Periodic mic health, so a real run tells us whether audio is flowing, being muted, or
    // just silent (permission/device). Cleared in `finally`.
    if (DEBUG) {
      micStatTimer = setInterval(() => {
        dbg(
          `mic: ${stats.chunks} chunks, sent ${(stats.sent / 48000).toFixed(1)}s, ` +
            `dropped(muted) ${(stats.dropped / 48000).toFixed(1)}s, peakLevel ${stats.level.toFixed(1)}% ` +
            `(muted=${micMuted()})`,
        );
        stats.level = 0;
      }, 2000);
      if (micStatTimer.unref) micStatTimer.unref();
    }
    // Open the turn on session.updated (voice is applied by then). This is only a safety
    // fallback if that ack never arrives — keep it long so it doesn't race ahead of the
    // voice config and make the agent speak in the wrong (default) voice.
    setTimeout(open, 5000);
    return await Promise.race([decisionPromise, timeout]);
  } catch (err) {
    process.stderr.write(`[claude-voice] voice session failed: ${String(err?.message ?? err)}\n`);
    return { kind: "end" };
  } finally {
    ACTIVE_ABORTS.delete(abort);
    // Only a real conversation counts as "we're still talking". After an Esc the user is at
    // the keyboard and clearly does not want the next question opening a call by itself.
    if (!aborted) lastSessionEndedAt = Date.now();
    if (micStatTimer) clearInterval(micStatTimer);
    try {
      mic?.stop();
    } catch {
      /* ignore */
    }
    // Wait for the queued audio (the agent's last words + the closing beep) to actually be
    // heard: closing sox's stdin makes it play out and exit, and stop() resolves on that exit.
    // On abort we skip straight to silence — the user wants it NOW.
    if (!aborted) dbg(`draining speaker (~${((speakerRef?.remainingMs?.() ?? 0) / 1000).toFixed(1)}s queued)`);
    await speakerRef?.stop?.({ immediate: aborted });
    dbg("speaker drained");
    try {
      session.close();
    } catch {
      /* ignore */
    }
  }
}
