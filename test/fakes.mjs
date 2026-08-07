// Test doubles for everything runVoiceSession touches from the outside: microphone, speaker,
// and the OpenAI Realtime session. They let a whole call be played out in milliseconds, with
// the room noise, the timing and the model's misbehaviour scripted by the test.
//
// The speaker double uses the SAME playback arithmetic as the real one (PCM16 mono @ 24 kHz =
// 48000 bytes per second, writes queue up behind each other) because every half-duplex bug so
// far came from that arithmetic, not from sox.

export const BYTES_PER_MS = 48; // 48000 bytes/s

// A chunk of PCM16 at a given loudness — `level` is roughly the RMS percentage the code reads.
export function pcm(ms, level = 0) {
  const buf = Buffer.alloc(Math.round(ms * BYTES_PER_MS));
  const amp = Math.round((level / 100) * 32767);
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return buf;
}

export function fakeSpeaker() {
  const state = { writes: [], endsAt: 0, stopped: false, immediate: false, killed: 0 };
  const spk = {
    write(buf) {
      if (state.stopped) return;
      state.writes.push(buf.length);
      state.endsAt = Math.max(Date.now(), state.endsAt) + buf.length / BYTES_PER_MS;
    },
    // The real speaker holds audio back in a jitter buffer; these release/re-arm it. Nothing
    // is buffered here — the fake plays instantly — so they only need to exist.
    flush() {},
    rearm() {},
    playingUntil: () => (state.stopped ? 0 : state.endsAt),
    remainingMs: () => (state.stopped ? 0 : Math.max(0, state.endsAt - Date.now())),
    async stop({ immediate = false } = {}) {
      state.stopped = true;
      state.immediate = immediate;
      state.killed++;
    },
    state,
    // Total audio written, in ms — how long the agent talked for.
    spokenMs: () => state.writes.reduce((a, b) => a + b, 0) / BYTES_PER_MS,
  };
  return spk;
}

export function fakeMic() {
  const mics = [];
  const start = (onChunk) => {
    const m = { onChunk, stopped: false, stop: () => (m.stopped = true) };
    mics.push(m);
    return m;
  };
  // Feed a chunk to whichever mic is currently open (the gate opens one, the session another).
  start.feed = (buf) => {
    const live = mics.filter((m) => !m.stopped);
    for (const m of live) m.onChunk(buf);
    return live.length;
  };
  start.mics = mics;
  return start;
}

// Stands in for RealtimeSession. `ctl` is the puppet strings: emit transport events, stream
// agent audio, and call the model's submit_decision through the real gate.
export function fakeRealtime({ onConnect } = {}) {
  const ctl = {
    handlers: {},
    sentEvents: [],
    audioSent: [], // ArrayBuffers the session forwarded to the API
    closed: false,
    handleSubmit: null,
    instructions: "",
    sessionConfig: null,
  };
  const emit = (name, payload) => (ctl.handlers[name] || []).forEach((h) => h(payload));

  const createSession = ({ instructions, sessionConfig, handleSubmit }) => {
    ctl.instructions = instructions;
    ctl.sessionConfig = sessionConfig;
    ctl.handleSubmit = handleSubmit;
    return {
      on(name, cb) {
        (ctl.handlers[name] ||= []).push(cb);
      },
      async connect() {
        await onConnect?.(ctl);
      },
      sendAudio(ab) {
        ctl.audioSent.push(ab);
      },
      close() {
        ctl.closed = true;
      },
      transport: {
        sendEvent(e) {
          ctl.sentEvents.push(e);
          // The real API answers a response.create with response.created; the session's own
          // opening turn depends on that, so the fake must too.
          if (e?.type === "response.create") ctl.startResponse();
        },
      },
    };
  };

  // Milliseconds of NON-SILENT audio forwarded to the API. A muted mic still streams silence
  // (cutting the stream hangs the server's VAD mid-turn), so "did the user's voice get through"
  // is a question about content, not about byte count.
  ctl.voicedMs = () =>
    ctl.audioSent
      .filter((ab) => new Int16Array(ab).some((s) => s !== 0))
      .reduce((a, ab) => a + ab.byteLength, 0) / 48;

  ctl.emit = emit;
  ctl.event = (type, extra = {}) => emit("transport_event", { type, ...extra });
  // The model starts generating.
  ctl.startResponse = () => ctl.event("response.created");
  // The model streams `ms` of speech, then finishes generating. Note the split: generation
  // ends long before playback does, which is the trap the mute logic has to survive.
  ctl.speak = (ms) => {
    const buf = pcm(ms, 30);
    emit("audio", { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    ctl.event("response.done");
  };
  // A full user turn as the API reports it. `transcriptDelayMs` reproduces the real ordering:
  // the transcript lands AFTER the turn is committed — and, in a live call, after the model has
  // already tried to report a decision.
  ctl.userTurn = async (ms, transcript = "", { transcriptDelayMs = 0 } = {}) => {
    ctl.event("input_audio_buffer.speech_started");
    await new Promise((r) => setTimeout(r, ms));
    ctl.event("input_audio_buffer.speech_stopped");
    ctl.event("input_audio_buffer.committed");
    const emitTranscript = () =>
      ctl.event("conversation.item.input_audio_transcription.completed", { transcript });
    if (transcriptDelayMs) setTimeout(emitTranscript, transcriptDelayMs);
    else emitTranscript();
  };
  ctl.submit = (args) => ctl.handleSubmit(args);
  ctl.createSession = createSession;
  return ctl;
}

// Wait until `fn()` is truthy, polling — for "the mic re-opened" style conditions that depend
// on wall-clock playback rather than on an event.
export async function until(fn, { timeoutMs = 4000, everyMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("until(): timed out");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
