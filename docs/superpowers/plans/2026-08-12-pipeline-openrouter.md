# Pipeline OpenRouter — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** sostituire i tre motori vocali sovrapposti con un solo flusso a turni — text-to-speech, speech-to-text, cervello — dietro quattro interfacce sostituibili, oggi tutte su OpenRouter con una chiave sola.

**Architecture:** Node è l'orchestratore e regge una macchina a cinque stati (`src/call.mjs`); una scheda del browser fa da scheda audio via websocket su localhost; un registry guidato da variabili d'ambiente (`src/modules.mjs`) sceglie quale implementazione di `AudioIO`, `Tts`, `Stt`, `Brain` caricare. Nessun modulo importa un altro modulo: parlano solo con l'orchestratore, scambiandosi PCM16 mono 24 kHz.

**Tech Stack:** Node ≥ 22 (ESM, `node --test`), `@modelcontextprotocol/sdk`, `zod`, `ws`, `fetch` nativo. Nessun SDK di provider.

**Spec:** `docs/superpowers/specs/2026-08-12-pipeline-openrouter-design.md`

## Global Constraints

- **Valuta audio unica:** PCM16 mono little-endian a 24 kHz, ovunque. 48000 byte = 1 secondo. Nessun ricampionamento in tutta la catena.
- **Una sola chiave:** `OPENROUTER_API_KEY`. Nessun altro segreto deve comparire nel codice o nella configurazione.
- **Modelli fissati:** TTS `microsoft/mai-voice-2-flash` con voce `en-US-Harper:MAI-Voice-2`; STT `openai/whisper-large-v3-turbo`; cervello `openai/gpt-oss-20b`. Sempre sovrascrivibili da env, mai cablati fuori da `config.mjs`.
- **Base URL:** `https://openrouter.ai/api/v1`.
- **Nessun test tocca la rete.** `fetch` entra sempre come parametro iniettabile con default `globalThis.fetch`.
- **Il trigger è il solo pulsante della pagina.** Niente parola di attivazione, niente misuratore di livello sempre attivo, niente processo locale tenuto caldo.
- **Ordine di lavoro:** il motore vecchio resta funzionante fino al Task 8. Prima si costruisce il nuovo accanto, poi si commuta e si cancella. `npm test` deve passare alla fine di ogni singolo task.
- **Lingua:** commenti e messaggi di commit in inglese, come tutto il repo esistente. Il testo mostrato all'utente nella pagina resta in italiano.
- **Branch:** `openrouter-pipeline`, già creato da `main`. Un commit per task.

---

### Task 1: Helper PCM (WAV, livello, beep)

Tre funzioni pure che devono sopravvivere alla cancellazione di `src/audio.mjs`: l'intestazione WAV che Whisper pretende, il misuratore di livello che serve al rilevamento del silenzio, e il generatore del beep. Nessuna dipendenza, nessun I/O — è il pezzo più facile da testare e tutto il resto lo usa.

**Scostamento dalla spec, deliberato:** la spec chiama questo file `src/wav.mjs`. Diventa `src/pcm.mjs` perché non contiene solo il wrapper WAV: il misuratore di livello e il generatore del beep sono funzioni pure che vivono oggi in `audio.mjs` e non hanno altro posto dove andare quando quel file sparisce. Un nome che descrive "helper sul PCM grezzo" regge tutte e tre; `wav.mjs` ne descriverebbe una.

**Files:**
- Create: `src/pcm.mjs`
- Test: `test/pcm.test.mjs`
- Reference: `src/audio.mjs:93-110` (`rmsPct`), `src/audio.mjs:162-176` (`beepPcm`) — le implementazioni esistenti da riusare tali e quali

**Interfaces:**
- Consumes: niente.
- Produces:
  - `pcmToWav(pcm: Buffer, {rate=24000, channels=1, bits=16}) → Buffer` — WAV a 44 byte di intestazione
  - `rmsPct(pcm: Buffer) → number` — livello RMS in percentuale 0-100
  - `beepPcm({freq=880, ms=160, volume=0.25, leadMs=0}) → Buffer` — tono sinusoidale PCM16 24 kHz
  - `durationMs(pcm: Buffer) → number` — millisecondi di audio nel buffer

- [ ] **Step 1: Write the failing test**

Crea `test/pcm.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { beepPcm, durationMs, pcmToWav, rmsPct } from "../src/pcm.mjs";

test("pcmToWav puts a 44-byte RIFF header in front of the samples", () => {
  const pcm = Buffer.alloc(480 * 2); // 20 ms at 24 kHz
  const wav = pcmToWav(pcm);

  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.subarray(36, 40).toString(), "data");
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length, "RIFF size is everything after byte 8");
  assert.equal(wav.readUInt32LE(40), pcm.length, "data size is the payload");
});

test("pcmToWav declares mono PCM16 at 24 kHz — the format the whole project speaks", () => {
  const wav = pcmToWav(Buffer.alloc(96));

  assert.equal(wav.readUInt16LE(20), 1, "format 1 = uncompressed PCM");
  assert.equal(wav.readUInt16LE(22), 1, "one channel");
  assert.equal(wav.readUInt32LE(24), 24000, "sample rate");
  assert.equal(wav.readUInt32LE(28), 48000, "byte rate = 24000 * 1 * 2");
  assert.equal(wav.readUInt16LE(32), 2, "block align");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
});

test("pcmToWav round-trips the samples untouched", () => {
  const pcm = Buffer.from([1, 0, 2, 0, 255, 127]);
  assert.deepEqual(pcmToWav(pcm).subarray(44), pcm);
});

test("rmsPct reads silence as zero and a loud tone as a large number", () => {
  assert.equal(rmsPct(Buffer.alloc(960)), 0);
  assert.ok(rmsPct(beepPcm({ ms: 100, volume: 0.9 })) > 20);
});

test("beepPcm produces the requested duration of audio", () => {
  const beep = beepPcm({ ms: 100 });
  assert.equal(beep.length, 0.1 * 48000, "100 ms at 48000 bytes/s");
  assert.equal(durationMs(beep), 100);
});

test("beepPcm prepends silence when asked for a lead-in", () => {
  const beep = beepPcm({ ms: 100, leadMs: 50 });
  assert.equal(durationMs(beep), 150);
  assert.equal(rmsPct(beep.subarray(0, 50 * 48)), 0, "the lead-in is silent");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pcm.test.mjs`
Expected: FAIL — `Cannot find module '.../src/pcm.mjs'`

- [ ] **Step 3: Write the implementation**

Crea `src/pcm.mjs`. `rmsPct` e `beepPcm` sono copiati da `src/audio.mjs` (che sparirà al Task 8) — leggi le versioni esistenti e portale invariate, cambiando solo i commenti dove citano sox.

```js
// Raw PCM helpers: the format every module in this project speaks, and the three things
// you have to do to it that have no home anywhere else.
//
// PCM16 mono little-endian @ 24 kHz. 48000 bytes = one second. That rate is not a taste:
// it is what MAI-Voice-2 emits and what the page's AudioWorklet runs at, so keeping it
// everywhere means the audio is never resampled between the model and the speaker.

export const RATE = 24000;
export const BYTES_PER_SEC = RATE * 2;

export function durationMs(pcm) {
  return (pcm.length / BYTES_PER_SEC) * 1000;
}

// Whisper wants a container, not loose samples. This is the smallest one that says
// "PCM16 mono at 24 kHz": 44 bytes in front of the buffer we already have.
export function pcmToWav(pcm, { rate = RATE, channels = 1, bits = 16 } = {}) {
  const head = Buffer.alloc(44);
  const blockAlign = (channels * bits) / 8;
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); // fmt chunk length
  head.writeUInt16LE(1, 20); // 1 = uncompressed PCM
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * blockAlign, 28);
  head.writeUInt16LE(blockAlign, 32);
  head.writeUInt16LE(bits, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// Level in percent. Room tone sits well under 1; a voice at laptop distance is in the teens.
// This is what decides when an utterance has ended, so it stays cheap and boring.
export function rmsPct(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n) * 100;
}

// The cue that says "Claude is waiting for you". A short sine, optionally after a beat of
// silence so it doesn't collide with whatever the speaker was doing.
export function beepPcm({ freq = 880, ms = 160, volume = 0.25, leadMs = 0 } = {}) {
  const lead = Math.round((leadMs / 1000) * RATE);
  const n = Math.round((ms / 1000) * RATE);
  const buf = Buffer.alloc((lead + n) * 2);
  for (let i = 0; i < n; i++) {
    // Fade both ends: a square-edged tone clicks, and a click is indistinguishable from a
    // fault when it comes out of a laptop speaker.
    const fade = Math.min(1, i / 240, (n - i) / 240);
    const s = Math.sin((2 * Math.PI * freq * i) / RATE) * volume * fade;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), (lead + i) * 2);
  }
  return buf;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pcm.test.mjs`
Expected: PASS, 6 test.

- [ ] **Step 5: Commit**

```bash
git add src/pcm.mjs test/pcm.test.mjs
git commit -m "feat(pcm): raw PCM helpers — WAV wrapper, level meter, cue tone"
```

---

### Task 2: Configurazione dei nuovi moduli

`config.mjs` oggi descrive un motore che sta per sparire. Questo task **aggiunge** le chiavi nuove senza togliere quelle vecchie: la rimozione arriva al Task 8, quando nessuno le legge più. Aggiungere prima significa che i task successivi possono usare `config` senza rompere il motore ancora vivo.

**Files:**
- Modify: `src/config.mjs` (aggiunta in coda all'oggetto `config`, prima della chiusura a riga 203)
- Test: `test/config.test.mjs`

**Interfaces:**
- Consumes: niente.
- Produces: su `config` — `openrouterKey: string`, `baseUrl: string`, `audio: "browser"`, `tts/stt/brain: string` (nomi di implementazione), `ttsModel`, `ttsVoice`, `sttModel`, `brainModel: string`, `maxTurns: number`, `recordSilenceMs`, `recordMinMs`, `recordMaxMs`, `speechLevel: number`. Più `requireOpenRouterKey(): void`.

- [ ] **Step 1: Write the failing test**

Crea `test/config.test.mjs`. Nota il pattern: `config.mjs` legge l'ambiente all'import, quindi ogni caso reimporta il modulo con una query string diversa per bucare la cache di ESM.

```js
import assert from "node:assert/strict";
import { test } from "node:test";

// config.mjs reads process.env once, at import time. A cache-busting query string is the
// only way to see it read a different environment in the same process.
let n = 0;
async function freshConfig(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return (await import(`../src/config.mjs?case=${n++}`)).config;
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("the three models default to the ones the spec fixed", async () => {
  const config = await freshConfig({});
  assert.equal(config.ttsModel, "microsoft/mai-voice-2-flash");
  assert.equal(config.ttsVoice, "en-US-Harper:MAI-Voice-2");
  assert.equal(config.sttModel, "openai/whisper-large-v3-turbo");
  assert.equal(config.brainModel, "openai/gpt-oss-20b");
});

test("every module slot defaults to a named implementation", async () => {
  const config = await freshConfig({});
  assert.equal(config.audio, "browser");
  assert.equal(config.tts, "openrouter");
  assert.equal(config.stt, "openrouter");
  assert.equal(config.brain, "openrouter");
});

test("env overrides a slot without touching the others", async () => {
  const config = await freshConfig({ VOICE_TTS: "local" });
  assert.equal(config.tts, "local");
  assert.equal(config.stt, "openrouter");
});

test("requireOpenRouterKey names the variable that is missing", async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const mod = await import(`../src/config.mjs?case=${n++}`);
    assert.throws(() => mod.requireOpenRouterKey(), /OPENROUTER_API_KEY/);
  } finally {
    if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `config.ttsModel` è `undefined`.

**Attenzione:** se hai `OPENROUTER_API_KEY` in `.env` alla radice, `loadEnvFile()` la carica e il quarto test fallisce comunque. In quel caso il test va scritto per svuotare anche ciò che `.env` fornisce: cancella la chiave da `process.env` **dopo** l'import e verifica passando un `config` finto. Se ti trovi in questa situazione, sostituisci il quarto test con la forma qui sotto e vai avanti — non modificare `env.mjs` per accomodare un test.

```js
test("requireOpenRouterKey names the variable that is missing", async () => {
  const { makeRequireKey } = await import(`../src/config.mjs?case=${n++}`);
  assert.throws(() => makeRequireKey({ openrouterKey: "" })(), /OPENROUTER_API_KEY/);
  assert.doesNotThrow(() => makeRequireKey({ openrouterKey: "sk-x" })());
});
```

- [ ] **Step 3: Write the implementation**

In `src/config.mjs`, aggiungi dentro l'oggetto `config` (subito prima di `disabled:`, riga 202):

```js
  // --- OpenRouter pipeline -------------------------------------------------------------
  // One key covers transcription, synthesis and reasoning. That is the entire reason this
  // provider was chosen over three better-at-one-thing ones.
  openrouterKey: process.env.OPENROUTER_API_KEY || "",
  baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",

  // Which implementation fills each slot. The registry in modules.mjs turns these names into
  // dynamic imports, so a future local engine is a value here and nothing else.
  tts: process.env.VOICE_TTS || "openrouter",
  stt: process.env.VOICE_STT || "openrouter",
  brain: process.env.VOICE_BRAIN || "openrouter",

  ttsModel: process.env.VOICE_TTS_MODEL || "microsoft/mai-voice-2-flash",
  // MAI-Voice-2-Flash ships four voices and none of them is Italian (verified: it-IT-* is a
  // 502). The model is multilingual, so Harper reads Italian with an English accent. If that
  // grates, VOICE_TTS_MODEL points at a model with a native Italian voice — same key, same
  // interface.
  ttsVoice: process.env.VOICE_TTS_VOICE || "en-US-Harper:MAI-Voice-2",
  sttModel: process.env.VOICE_STT_MODEL || "openai/whisper-large-v3-turbo",
  brainModel: process.env.VOICE_BRAIN_MODEL || "openai/gpt-oss-20b",

  // A runaway conversation is a runaway bill. After this many exchanges the call closes and
  // Claude gets {kind:"end"} — it can always ask again.
  maxTurns: Number(process.env.VOICE_MAX_TURNS) || 8,

  // Utterance capture. Trailing silence that ends a turn, the floor below which a "turn" is
  // a cough, and the ceiling that stops a stuck mic from uploading a minute of a room.
  recordSilenceMs: Number(process.env.VOICE_RECORD_SILENCE_MS) || 800,
  recordMinMs: Number(process.env.VOICE_RECORD_MIN_MS) || 250,
  recordMaxMs: Number(process.env.VOICE_RECORD_MAX_MS) || 30000,

  // Level (RMS %) that counts as somebody talking, for both utterance start and barge-in.
  speechLevel: Number(process.env.VOICE_SPEECH_LEVEL) || 3,

```

E in coda al file, dopo `requireApiKey`:

```js
// Same idea as requireApiKey, for the only key the new pipeline needs. Split out so the
// error names the variable the user actually has to set.
export function makeRequireKey(cfg) {
  return () => {
    if (!cfg.openrouterKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Set it in .env, or run with VOICE_MODE=text to use " +
          "the terminal fallback.",
      );
    }
  };
}

export const requireOpenRouterKey = makeRequireKey(config);
```

Cambia anche il default di `audio` (riga 96) — la pagina è ora l'unico backend previsto:

```js
  // Where the audio actually happens. Only "browser" exists today: the page's own echo
  // canceller is what makes barge-in work on open speakers. A headless "sox" implementation
  // is the obvious next slot (spec §4).
  audio: process.env.VOICE_AUDIO || "browser",
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/config.test.mjs && npm test`
Expected: PASS. `npm test` resta verde: nessuna chiave vecchia è stata toccata.

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat(config): settings for the OpenRouter pipeline and the module slots"
```

---

### Task 3: Modulo TTS

Prima chiamata di rete del progetto. `POST /audio/speech` risponde con **byte audio grezzi, non JSON** — è la trappola principale di questo endpoint.

**Files:**
- Create: `src/tts/openrouter.mjs`
- Test: `test/tts.test.mjs`

**Interfaces:**
- Consumes: `config` dal Task 2.
- Produces: `createTts({fetchImpl?, cfg?}) → { speak(text: string) → Promise<Buffer> }`, dove il Buffer è PCM16 mono 24 kHz pronto per l'altoparlante.

- [ ] **Step 1: Write the failing test**

Crea `test/tts.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTts } from "../src/tts/openrouter.mjs";

const cfg = {
  openrouterKey: "sk-test",
  baseUrl: "https://openrouter.ai/api/v1",
  ttsModel: "microsoft/mai-voice-2-flash",
  ttsVoice: "en-US-Harper:MAI-Voice-2",
  speed: 1.15,
};

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return { calls, fetchImpl };
}

const okAudio = (bytes) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
});

test("speak posts the fixed model, the chosen voice and pcm output", async () => {
  const { calls, fetchImpl } = fakeFetch(okAudio(Buffer.alloc(96)));
  await createTts({ fetchImpl, cfg }).speak("ciao");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/audio/speech");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
  assert.deepEqual(calls[0].body, {
    model: "microsoft/mai-voice-2-flash",
    input: "ciao",
    voice: "en-US-Harper:MAI-Voice-2",
    response_format: "pcm",
    speed: 1.15,
  });
});

test("speak returns the raw bytes — this endpoint does not answer JSON", async () => {
  const audio = Buffer.from([1, 2, 3, 4]);
  const { fetchImpl } = fakeFetch(okAudio(audio));

  const out = await createTts({ fetchImpl, cfg }).speak("ciao");
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, audio);
});

test("an error response throws with the status and the provider's words", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    text: async () => '{"error":{"message":"Provider returned 502"}}',
  });

  await assert.rejects(() => createTts({ fetchImpl, cfg }).speak("ciao"), /502.*Provider returned/s);
});

test("empty text never reaches the network", async () => {
  const { calls, fetchImpl } = fakeFetch(okAudio(Buffer.alloc(0)));
  const out = await createTts({ fetchImpl, cfg }).speak("   ");

  assert.equal(calls.length, 0, "nothing to say costs nothing");
  assert.equal(out.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tts.test.mjs`
Expected: FAIL — `Cannot find module '.../src/tts/openrouter.mjs'`

- [ ] **Step 3: Write the implementation**

Crea `src/tts/openrouter.mjs`:

```js
// Text-to-speech through OpenRouter.
//
// Two things about this endpoint are not like the rest of the API: it answers with raw audio
// bytes rather than JSON, and `response_format: "pcm"` gives us exactly the currency the rest
// of the project speaks — PCM16 mono @ 24 kHz — so nothing has to decode or resample.
//
// The text handed here is spoken VERBATIM. Claude wrote it for the ear; no model rewrites it,
// which is why the spoken line costs no tokens at all.

import { config } from "../config.mjs";

export function createTts({ fetchImpl = globalThis.fetch, cfg = config } = {}) {
  return {
    async speak(text) {
      const input = String(text ?? "").trim();
      if (!input) return Buffer.alloc(0);

      const res = await fetchImpl(`${cfg.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.openrouterKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.ttsModel,
          input,
          voice: cfg.ttsVoice,
          response_format: "pcm",
          speed: cfg.speed,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`tts ${res.status}: ${detail.slice(0, 300)}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/tts.test.mjs`
Expected: PASS, 4 test.

- [ ] **Step 5: Verify against the real endpoint**

Questo è l'unico punto del piano che tocca la rete, e serve: il piano assume che `response_format: "pcm"` restituisca 24 kHz mono a 16 bit, e quell'assunzione va misurata, non creduta.

```bash
node --input-type=module -e '
import { createTts } from "./src/tts/openrouter.mjs";
import { durationMs } from "./src/pcm.mjs";
const t0 = Date.now();
const pcm = await createTts().speak("Uno, due, tre, quattro, cinque.");
console.log(`bytes=${pcm.length} durata=${Math.round(durationMs(pcm))}ms latenza=${Date.now() - t0}ms`);
'
```

Atteso: `durata` intorno ai 2000-2500 ms per quella frase. Se il valore è la metà o il doppio del parlato reale, il sample rate non è 24 kHz: fermati, misuralo, e correggi `RATE` in `src/pcm.mjs` prima di andare avanti — ogni task successivo eredita quel numero. Annota la latenza: serve al punto 9 della spec.

- [ ] **Step 6: Commit**

```bash
git add src/tts/openrouter.mjs test/tts.test.mjs
git commit -m "feat(tts): speak through OpenRouter MAI-Voice-2-Flash"
```

---

### Task 4: Modulo STT

**Files:**
- Create: `src/stt/openrouter.mjs`
- Test: `test/stt.test.mjs`

**Interfaces:**
- Consumes: `pcmToWav` dal Task 1, `config` dal Task 2.
- Produces: `createStt({fetchImpl?, cfg?}) → { transcribe(pcm: Buffer) → Promise<string> }`. Ritorna sempre una stringa già ripulita ai bordi, mai `null`.

- [ ] **Step 1: Write the failing test**

Crea `test/stt.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStt } from "../src/stt/openrouter.mjs";

const cfg = {
  openrouterKey: "sk-test",
  baseUrl: "https://openrouter.ai/api/v1",
  sttModel: "openai/whisper-large-v3-turbo",
  langCode: "it",
};

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { calls, fetchImpl };
}

test("transcribe sends base64 WAV and the language hint", async () => {
  const { calls, fetchImpl } = fakeFetch({ text: "la prima" });
  const pcm = Buffer.alloc(480 * 2);

  await createStt({ fetchImpl, cfg }).transcribe(pcm);

  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.equal(calls[0].body.model, "openai/whisper-large-v3-turbo");
  assert.equal(calls[0].body.language, "it");
  assert.equal(calls[0].body.input_audio.format, "wav");

  const sent = Buffer.from(calls[0].body.input_audio.data, "base64");
  assert.equal(sent.subarray(0, 4).toString(), "RIFF", "a container, not loose samples");
  assert.equal(sent.length, 44 + pcm.length);
});

test("no language hint is sent when the language is unknown", async () => {
  const { calls, fetchImpl } = fakeFetch({ text: "hello" });
  await createStt({ fetchImpl, cfg: { ...cfg, langCode: null } }).transcribe(Buffer.alloc(96));

  assert.ok(!("language" in calls[0].body), "an absent hint means auto-detect");
});

test("transcribe returns the trimmed text", async () => {
  const { fetchImpl } = fakeFetch({ text: "  la prima  " });
  assert.equal(await createStt({ fetchImpl, cfg }).transcribe(Buffer.alloc(96)), "la prima");
});

test("a response with no text reads as silence, not as a crash", async () => {
  const { fetchImpl } = fakeFetch({ usage: { seconds: 0.2 } });
  assert.equal(await createStt({ fetchImpl, cfg }).transcribe(Buffer.alloc(96)), "");
});

test("an empty buffer never reaches the network", async () => {
  const { calls, fetchImpl } = fakeFetch({ text: "x" });
  assert.equal(await createStt({ fetchImpl, cfg }).transcribe(Buffer.alloc(0)), "");
  assert.equal(calls.length, 0, "we are billed per second of audio; zero seconds is zero calls");
});

test("an error response throws with the status", async () => {
  const { fetchImpl } = fakeFetch({ error: "nope" }, { ok: false, status: 413 });
  await assert.rejects(() => createStt({ fetchImpl, cfg }).transcribe(Buffer.alloc(96)), /413/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/stt.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Write the implementation**

Crea `src/stt/openrouter.mjs`:

```js
// Speech-to-text through OpenRouter.
//
// The endpoint takes either OpenAI-style multipart or plain JSON with the audio base64'd
// inside it. JSON wins here: no multipart assembly, no temp file, and the whole request is
// one object you can print when something goes wrong. The cost is ~33% more bytes on the
// wire for an utterance that lasts a couple of seconds — a trade worth making.
//
// We are billed per second of audio, so an empty buffer must never become a request.

import { config } from "../config.mjs";
import { pcmToWav } from "../pcm.mjs";

export function createStt({ fetchImpl = globalThis.fetch, cfg = config } = {}) {
  return {
    async transcribe(pcm) {
      if (!pcm || !pcm.length) return "";

      const res = await fetchImpl(`${cfg.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.openrouterKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.sttModel,
          input_audio: { data: pcmToWav(pcm).toString("base64"), format: "wav" },
          // Without the hint the transcriber guesses per utterance, and a short Italian answer
          // guessed as English is how "la terza" once came back as "Certa".
          ...(cfg.langCode ? { language: cfg.langCode } : {}),
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`stt ${res.status}: ${detail.slice(0, 300)}`);
      }
      const json = await res.json();
      return String(json?.text ?? "").trim();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/stt.test.mjs`
Expected: PASS, 6 test.

- [ ] **Step 5: Commit**

```bash
git add src/stt/openrouter.mjs test/stt.test.mjs
git commit -m "feat(stt): transcribe through OpenRouter Whisper Large V3 Turbo"
```

---

### Task 5: Modulo cervello

Il pezzo che decide se l'utente sta scegliendo, chiedendo o chiudendo. Riceve il `message` **completo** di Claude come contesto: è tutto il senso del contratto a due payload.

**Files:**
- Create: `src/brain/openrouter.mjs`
- Test: `test/brain.test.mjs`

**Interfaces:**
- Consumes: `config` dal Task 2.
- Produces:
  - `createBrain({fetchImpl?, cfg?}) → { route({message, options, turns}) → Promise<Routed> }`
  - `Routed` = `{kind: "speak", text: string}` oppure `{kind: "decide", decision: {kind: "choice"|"message"|"end", value?: string, optionIndex?: number}}`
  - `turns` = `Array<{role: "user"|"assistant", content: string}>`
  - `parseRouted(raw: string, options: string[]) → Routed` esportata a parte, perché è la parte che va testata a fondo senza rete.

- [ ] **Step 1: Write the failing test**

Crea `test/brain.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrain, parseRouted } from "../src/brain/openrouter.mjs";

const OPTIONS = ["Apri la pull request", "Fai altri test", "Fermati qui"];

const cfg = {
  openrouterKey: "sk-test",
  baseUrl: "https://openrouter.ai/api/v1",
  brainModel: "openai/gpt-oss-20b",
  lang: "Italiano",
};

const reply = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

function fakeFetch(response) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return response;
    },
  };
}

test("a picked option becomes a choice carrying the option's own words", () => {
  const out = parseRouted('{"action":"decide","kind":"choice","optionIndex":1}', OPTIONS);
  assert.deepEqual(out, {
    kind: "decide",
    decision: { kind: "choice", value: "Apri la pull request", optionIndex: 1 },
  });
});

test("a new instruction becomes a message carrying the user's words", () => {
  const out = parseRouted(
    '{"action":"decide","kind":"message","value":"fai la prima ma senza i test"}',
    OPTIONS,
  );
  assert.deepEqual(out, {
    kind: "decide",
    decision: { kind: "message", value: "fai la prima ma senza i test" },
  });
});

test("a question becomes something to say, and the call stays open", () => {
  const out = parseRouted('{"action":"speak","say":"Il punto sei riguarda i test."}', OPTIONS);
  assert.deepEqual(out, { kind: "speak", text: "Il punto sei riguarda i test." });
});

test("done means end, and end never carries a value", () => {
  const out = parseRouted('{"action":"decide","kind":"end","value":"basta"}', OPTIONS);
  assert.deepEqual(out, { kind: "decide", decision: { kind: "end" } });
});

test("JSON wrapped in a code fence still parses — small models keep doing this", () => {
  const raw = '```json\n{"action":"speak","say":"Certo."}\n```';
  assert.deepEqual(parseRouted(raw, OPTIONS), { kind: "speak", text: "Certo." });
});

test("prose around the JSON still parses", () => {
  const raw = 'Ecco la risposta: {"action":"speak","say":"Va bene."} spero sia utile';
  assert.deepEqual(parseRouted(raw, OPTIONS), { kind: "speak", text: "Va bene." });
});

test("unparseable output hands the turn to Claude instead of guessing", () => {
  assert.deepEqual(parseRouted("non ho capito niente", OPTIONS), {
    kind: "decide",
    decision: { kind: "message", value: "non ho capito niente" },
  });
});

test("an option index outside the offered range is not a choice", () => {
  const out = parseRouted('{"action":"decide","kind":"choice","optionIndex":9}', OPTIONS);
  assert.equal(out.decision.kind, "message", "Claude must never act on an option nobody offered");
});

test("route sends Claude's full message as context and the turns as history", async () => {
  const { calls, fetchImpl } = fakeFetch(reply('{"action":"speak","say":"ok"}'));

  await createBrain({ fetchImpl, cfg }).route({
    message: "Ho toccato quattro file e i test passano.",
    options: OPTIONS,
    turns: [{ role: "user", content: "cosa hai cambiato?" }],
  });

  const body = calls[0].body;
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(body.model, "openai/gpt-oss-20b");

  const system = body.messages[0];
  assert.equal(system.role, "system");
  assert.match(system.content, /Ho toccato quattro file/, "the full context goes in");
  assert.match(system.content, /1\. Apri la pull request/, "so do the numbered options");
  assert.match(system.content, /Italiano/, "and the language to answer in");

  assert.deepEqual(body.messages.slice(1), [{ role: "user", content: "cosa hai cambiato?" }]);
});

test("an error response throws with the status", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => "slow down" });
  await assert.rejects(
    () => createBrain({ fetchImpl, cfg }).route({ message: "m", options: [], turns: [] }),
    /429/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/brain.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Write the implementation**

Crea `src/brain/openrouter.mjs`:

```js
// The conductor: the model that decides, turn by turn, whether you are choosing, asking, or
// done.
//
// Why a model and not rules: the first version of this project routed on words — "la prima"
// meant a choice, "basta" meant hang up. Those are Italian words in the source code, and an
// English speaker gets a broken product.
//
// Why a small model is enough: Claude is always one turn away. Anything this model cannot
// answer leaves as kind:"message" and Claude answers it next turn. It has to cover the easy
// 80% in half a second, not to be clever.
//
// Its only knowledge of the world is Claude's `message`. That is deliberate — it is a bridge,
// not a second opinion, and a bridge that invents facts is worse than no bridge.

import { config } from "../config.mjs";

function systemPrompt({ message, options, lang }) {
  const list = options.length
    ? options.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "(nessuna opzione offerta)";

  return `You are the voice bridge between a developer and Claude Code. Claude has just
finished a piece of work and needs an answer. You speak for Claude and you listen for the
developer. Answer in ${lang}.

Everything you know is below. Never state a fact that is not in it.

--- WHAT CLAUDE WROTE ---
${message}
--- END ---

OPTIONS CLAUDE OFFERED:
${list}

Decide what the developer's last turn means and reply with ONE JSON object, nothing else:

- They picked an option -> {"action":"decide","kind":"choice","optionIndex":<1-based number>}
- They gave a different instruction, or a condition on an option ->
  {"action":"decide","kind":"message","value":"<their instruction, in their own words>"}
- They asked something about the work -> {"action":"speak","say":"<answer, max 2 sentences,
  only from the context above>"}
- They said they are done, or there is nothing left to settle ->
  {"action":"decide","kind":"end"}

Rules that matter more than being helpful:
- Do not answer FOR the developer. If their turn is not clearly one of the four, choose
  "message" and let Claude handle it.
- Only use "choice" when what they said really maps to one of the numbered options.
- What you put in "say" will be read out loud. No code, no file paths, no lists.`;
}

// Small models wrap JSON in fences, add a sentence before it, or answer in prose. None of
// that is a failure worth losing a turn over: pull the object out if it is in there, and if
// it truly is not, hand the raw words to Claude as an instruction. Claude is one turn away.
export function parseRouted(raw, options = []) {
  const text = String(raw ?? "").trim();
  const asMessage = { kind: "decide", decision: { kind: "message", value: text } };

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return asMessage;

  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return asMessage;
  }

  if (obj.action === "speak") {
    const say = String(obj.say ?? "").trim();
    return say ? { kind: "speak", text: say } : asMessage;
  }

  if (obj.kind === "end") return { kind: "decide", decision: { kind: "end" } };

  if (obj.kind === "choice") {
    const i = Number(obj.optionIndex);
    // An index nobody offered is the single most expensive mistake here: Claude would act on
    // an option the user never picked. Downgrade instead of guessing.
    if (Number.isInteger(i) && i >= 1 && i <= options.length) {
      return { kind: "decide", decision: { kind: "choice", value: options[i - 1], optionIndex: i } };
    }
    const value = String(obj.value ?? "").trim();
    return { kind: "decide", decision: { kind: "message", value: value || text } };
  }

  const value = String(obj.value ?? "").trim();
  return { kind: "decide", decision: { kind: "message", value: value || text } };
}

export function createBrain({ fetchImpl = globalThis.fetch, cfg = config } = {}) {
  return {
    async route({ message, options = [], turns = [] }) {
      const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.openrouterKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.brainModel,
          temperature: 0.2,
          max_tokens: 300,
          messages: [
            { role: "system", content: systemPrompt({ message, options, lang: cfg.lang }) },
            ...turns,
          ],
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`brain ${res.status}: ${detail.slice(0, 300)}`);
      }
      const json = await res.json();
      return parseRouted(json?.choices?.[0]?.message?.content ?? "", options);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/brain.test.mjs`
Expected: PASS, 10 test.

- [ ] **Step 5: Commit**

```bash
git add src/brain/openrouter.mjs test/brain.test.mjs
git commit -m "feat(brain): route the conversation with GPT-OSS-20B over Claude's context"
```

---

### Task 6: Registry dei moduli

Il pezzo che rende vera la promessa dell'architettura: cambiare implementazione è una variabile d'ambiente. È anche il modo in cui i test del Task 8 iniettano i finti.

**Files:**
- Create: `src/modules.mjs`
- Test: `test/modules.test.mjs`

**Interfaces:**
- Consumes: i tre `create*` dai Task 3-5; `createAudio` dal Task 7 (l'import è pigro, quindi questo task si completa e si testa prima che quel file esista, purché i test non chiedano lo slot `audio`).
- Produces:
  - `loadModule(slot: "audio"|"tts"|"stt"|"brain", name: string, cfg?) → Promise<object>` — l'istanza già costruita
  - `loadModules(cfg?) → Promise<{audio, tts, stt, brain}>`

- [ ] **Step 1: Write the failing test**

Crea `test/modules.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule, loadModules } from "../src/modules.mjs";

const cfg = {
  openrouterKey: "sk-test",
  baseUrl: "https://openrouter.ai/api/v1",
  audio: "browser",
  tts: "openrouter",
  stt: "openrouter",
  brain: "openrouter",
  ttsModel: "m",
  ttsVoice: "v",
  sttModel: "m",
  brainModel: "m",
  lang: "Italiano",
  speed: 1,
};

test("a named implementation loads and exposes its interface", async () => {
  const tts = await loadModule("tts", "openrouter", cfg);
  assert.equal(typeof tts.speak, "function");

  const stt = await loadModule("stt", "openrouter", cfg);
  assert.equal(typeof stt.transcribe, "function");

  const brain = await loadModule("brain", "openrouter", cfg);
  assert.equal(typeof brain.route, "function");
});

test("an unknown implementation fails with the list of the real ones", async () => {
  await assert.rejects(() => loadModule("tts", "elevenlabs", cfg), /elevenlabs.*openrouter/s);
});

test("an unknown slot fails by name", async () => {
  await assert.rejects(() => loadModule("telepathy", "openrouter", cfg), /telepathy/);
});

test("loadModules fills every slot from config", async () => {
  const mods = await loadModules({ ...cfg, audio: "none" });
  assert.equal(typeof mods.tts.speak, "function");
  assert.equal(typeof mods.stt.transcribe, "function");
  assert.equal(typeof mods.brain.route, "function");
  assert.equal(mods.audio, null, '"none" is the audio slot for tests: no port, no tab');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/modules.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Write the implementation**

Crea `src/modules.mjs`:

```js
// The registry: the file that makes "swappable module" true rather than aspirational.
//
// Every slot maps a NAME to a lazy import. Lazy matters twice over: a text-mode session must
// never open a port or touch the network, and a future local engine must not be loaded on a
// machine that only ever uses the cloud one.
//
// Nothing here knows what the modules do. It knows their names, and that each exposes a
// factory called create<Slot>.

import { config } from "./config.mjs";

const REGISTRY = {
  audio: {
    browser: () => import("./audio/browser.mjs").then((m) => m.createAudio),
    // The audio slot is the one a test can genuinely do without: call.mjs is handed fakes.
    none: () => Promise.resolve(() => null),
  },
  tts: {
    openrouter: () => import("./tts/openrouter.mjs").then((m) => m.createTts),
  },
  stt: {
    openrouter: () => import("./stt/openrouter.mjs").then((m) => m.createStt),
  },
  brain: {
    openrouter: () => import("./brain/openrouter.mjs").then((m) => m.createBrain),
  },
};

export async function loadModule(slot, name, cfg = config) {
  const impls = REGISTRY[slot];
  if (!impls) {
    throw new Error(`unknown module slot "${slot}" — known slots: ${Object.keys(REGISTRY).join(", ")}`);
  }
  const load = impls[name];
  if (!load) {
    throw new Error(
      `unknown ${slot} implementation "${name}" — available: ${Object.keys(impls).join(", ")}`,
    );
  }
  const create = await load();
  return create({ cfg });
}

export async function loadModules(cfg = config) {
  const [audio, tts, stt, brain] = await Promise.all([
    loadModule("audio", cfg.audio, cfg),
    loadModule("tts", cfg.tts, cfg),
    loadModule("stt", cfg.stt, cfg),
    loadModule("brain", cfg.brain, cfg),
  ]);
  return { audio, tts, stt, brain };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/modules.test.mjs`
Expected: PASS, 4 test.

- [ ] **Step 5: Commit**

```bash
git add src/modules.mjs test/modules.test.mjs
git commit -m "feat(modules): env-driven registry behind every swappable slot"
```

---

### Task 7: Backend audio nel browser + pagina

Il ponte esiste già e funziona: `src/browser-audio.mjs` regge il server HTTP, il websocket, il token e i due worklet. Questo task lo **riduce all'interfaccia `AudioIO`** e cambia la pagina da "spiega la parola di attivazione" a "mostra la domanda e offri il pulsante".

**Files:**
- Create: `src/audio/browser.mjs` (derivato da `src/browser-audio.mjs` — copialo e riducilo, non riscriverlo da zero)
- Modify: `public/voice.html`
- Test: `test/audio-browser.test.mjs`
- Reference: `src/browser-audio.mjs` (intero), `public/voice.html:164-245`

**Interfaces:**
- Consumes: `beepPcm`, `rmsPct`, `durationMs` dal Task 1; `config` dal Task 2.
- Produces: `createAudio({cfg?}) → AudioIO`, dove `AudioIO` è:
  - `arm({spoken, options}) → Promise<boolean>` — apre o riusa la scheda, ci scrive la domanda, suona il beep, abilita il pulsante. `false` se nessuna scheda si presenta.
  - `waitForButton(ms) → Promise<boolean>` — `true` al click, `false` allo scadere.
  - `play(pcm, {bargeInMs}) → Promise<{interrupted: boolean}>` — risolve quando l'ultimo campione è stato **sentito**, o subito dopo un'interruzione.
  - `record({silenceMs, minMs, maxMs, level}) → Promise<Buffer>` — una utterance, chiusa dal silenzio.
  - `report(r) → void` — la ricevuta di fine chiamata.
  - `close() → Promise<void>`

Protocollo websocket, invariato dove possibile. Nuovi messaggi: Node → pagina `{t:"ask", spoken, options}` e `{t:"armed", on}`; rimosso `{t:"hello", wakeWord}`, che diventa `{t:"hello"}`.

- [ ] **Step 1: Write the failing test**

Il test guida un `AudioIO` vero contro un finto ponte, perché il pezzo che vale la pena testare è il rilevamento della fine di una utterance — non il websocket, che è codice già in produzione.

Crea `test/audio-browser.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRecorder } from "../src/audio/browser.mjs";
import { beepPcm } from "../src/pcm.mjs";

// A fake mic: hand it chunks and it delivers them on the next tick, like the bridge does.
function fakeMic(chunks) {
  return (onChunk) => {
    let i = 0;
    const timer = setInterval(() => {
      if (i >= chunks.length) return;
      onChunk(chunks[i++]);
    }, 1);
    return { stop: () => clearInterval(timer) };
  };
}

const SILENCE = Buffer.alloc(480 * 2); // 20 ms
const SPEECH = beepPcm({ ms: 20, volume: 0.5 });
const times = (n, chunk) => Array.from({ length: n }, () => chunk);

test("a recording ends after the configured trailing silence", async () => {
  // 10 chunks of speech (200 ms), then 50 of silence (1000 ms) — past the 800 ms cutoff.
  const mic = fakeMic([...times(10, SPEECH), ...times(50, SILENCE)]);
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 800, minMs: 100, maxMs: 5000, level: 3 });

  assert.ok(pcm.length > 0, "the speech is kept");
  assert.ok(pcm.length < (10 + 50) * SILENCE.length, "the trailing silence is not");
});

test("silence alone returns nothing rather than uploading a quiet room", async () => {
  const mic = fakeMic(times(60, SILENCE));
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 300, minMs: 100, maxMs: 800, level: 3 });
  assert.equal(pcm.length, 0);
});

test("a stuck microphone is cut off at maxMs", async () => {
  const mic = fakeMic(times(1000, SPEECH));
  const rec = createRecorder({ startMic: mic });

  const t0 = Date.now();
  const pcm = await rec.record({ silenceMs: 800, minMs: 100, maxMs: 300, level: 3 });

  assert.ok(Date.now() - t0 < 2000, "it returns, and soon");
  assert.ok(pcm.length > 0);
});

test("a cough shorter than minMs is not an utterance", async () => {
  const mic = fakeMic([SPEECH, ...times(40, SILENCE)]);
  const rec = createRecorder({ startMic: mic });

  const pcm = await rec.record({ silenceMs: 200, minMs: 250, maxMs: 2000, level: 3 });
  assert.equal(pcm.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/audio-browser.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Write the implementation**

Copia `src/browser-audio.mjs` in `src/audio/browser.mjs` e lavora lì. Cosa cambia:

**Da tenere invariato:** `createBridge` con server HTTP, controllo del token, `WebSocketServer`, "last tab wins", `addMic`, `sendPcm`, `drain`, `openInBrowser`, `waitForTab`.

**Da rimuovere:** l'import di `./audio.mjs` (che sparisce al Task 8) e la `waitForSpeech` esportata in fondo; `config.wakeWord` dentro `hello`; `createSpeaker` con `flush`/`rearm`/`playingUntil` (interfaccia del vecchio realtime).

**Da aggiungere:** l'import di `beepPcm`, `rmsPct` e `durationMs` da `../pcm.mjs`; il token persistente (porta il comportamento del commit `ee3e45d` da `local-engine`: leggi `.voice-bridge-token` se esiste, altrimenti genera e scrivi, con `mode: 0o600`), i due messaggi nuovi, e il registratore isolato:

```js
// The recorder is the only part of this file worth a unit test, so it takes its mic as a
// parameter and knows nothing about websockets. An utterance is: wait for someone to start
// talking, keep everything from then on, and stop once they have been quiet long enough.
export function createRecorder({ startMic }) {
  return {
    record({ silenceMs = 800, minMs = 250, maxMs = 30000, level = 3 } = {}) {
      return new Promise((resolve) => {
        const chunks = [];
        let speaking = false;
        let quietSince = 0;
        let spokenMs = 0;
        let done = false;

        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(cap);
          mic.stop();
          resolve(spokenMs >= minMs ? Buffer.concat(chunks) : Buffer.alloc(0));
        };

        const mic = startMic((chunk) => {
          if (done) return;
          const loud = rmsPct(chunk) >= level;
          if (loud) {
            speaking = true;
            quietSince = 0;
            spokenMs += durationMs(chunk);
          }
          // Everything from the first loud chunk onwards is kept, silence included: the pauses
          // inside a sentence are part of what the transcriber hears.
          if (speaking) chunks.push(chunk);
          if (speaking && !loud) {
            const now = Date.now();
            if (!quietSince) quietSince = now;
            if (now - quietSince >= silenceMs) finish();
          }
        });

        const cap = setTimeout(finish, maxMs);
        if (cap.unref) cap.unref();
      });
    },
  };
}
```

E l'oggetto `AudioIO` che `createAudio` restituisce:

```js
export function createAudio({ cfg = config } = {}) {
  const recorder = createRecorder({ startMic });

  return {
    async arm({ spoken, options }) {
      const ok = await ensureBrowserAudio();
      if (!ok) return false;
      bridge.ask({ spoken, options });
      // The cue that says "Claude is waiting for you". It is the ONLY thing that happens
      // before the user clicks — no listening, no model loaded, nothing paid for.
      bridge.sendPcm(beepPcm({ freq: 880, ms: 160 }));
      return true;
    },

    waitForButton(ms) {
      return bridge ? bridge.waitForStart(ms) : Promise.resolve(false);
    },

    async play(pcm, { bargeInMs = cfg.bargeInMs, level = cfg.speechLevel } = {}) {
      if (!pcm?.length || !bridge) return { interrupted: false };
      bridge.clear();
      bridge.sendPcm(pcm);

      // The page has real echo cancellation, so the mic can stay open while we talk: what it
      // hears is the room, not us. That is the whole reason this backend exists.
      let loudFor = 0;
      let interrupted = false;
      const mic = startMic((chunk) => {
        loudFor = rmsPct(chunk) >= level ? loudFor + durationMs(chunk) : 0;
        if (loudFor >= bargeInMs && !interrupted) {
          interrupted = true;
          bridge.clear(); // stop mid-sentence: they are talking to us
        }
      });

      await bridge.drain(Math.min(durationMs(pcm) + 2000, 20000));
      mic.stop();
      return { interrupted };
    },

    record(opts) {
      return recorder.record({
        silenceMs: cfg.recordSilenceMs,
        minMs: cfg.recordMinMs,
        maxMs: cfg.recordMaxMs,
        level: cfg.speechLevel,
        ...opts,
      });
    },

    report: (r) => bridge?.report(r),
    close: () => shutdownBrowserAudio(),
  };
}
```

Aggiungi a `createBridge` i due metodi che servono qui — `ask` e `waitForStart` — modellati su `waitForTab` che è già lì:

```js
    ask: ({ spoken, options }) => send({ t: "ask", spoken, options: options || [] }),

    // Resolves true when the user presses the button, false when nobody does in time. This
    // is the entire trigger: no wake word, no level meter running in an empty room.
    waitForStart(ms) {
      send({ t: "armed", on: true });
      return new Promise((resolve) => {
        const off = this.onManualStart(() => {
          clearTimeout(t);
          off();
          send({ t: "armed", on: false });
          resolve(true);
        });
        const t = setTimeout(() => {
          off();
          send({ t: "armed", on: false });
          resolve(false);
        }, ms);
        if (t.unref) t.unref();
      });
    },
```

**Nota implementativa:** `waitForStart` usa `this.onManualStart`, quindi `createBridge` deve restituire un oggetto letterale in cui `waitForStart` è un metodo (non una arrow function), oppure — più sicuro — cattura `startListeners` direttamente dalla chiusura invece che passare da `this`. Preferisci la seconda: meno modi di sbagliare.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/audio-browser.test.mjs`
Expected: PASS, 4 test.

- [ ] **Step 5: Update the page**

In `public/voice.html`:

1. Sostituisci il blocco `#howto` (righe 64-69) con un riquadro che mostra la domanda e le opzioni, e il pulsante:

```html
        <div id="howto">
          <div id="ask">In attesa che Claude chieda qualcosa.</div>
          <div id="opts"></div>
          <button class="ghost" id="start" disabled>Parla</button>
        </div>
```

2. Butta `wakeWord`, `showHowTo` e la riga `else if (msg.t === "hello")` che le legge. Al loro posto:

```js
      function showAsk(msg) {
        $("ask").textContent = msg.spoken || "Claude ha una domanda.";
        $("opts").innerHTML = (msg.options || [])
          .map((o, i) => `<div>${i + 1}. ${esc(o)}</div>`)
          .join("");
        $("report").hidden = true; // the previous call's receipt is not this call's answer
      }
```

E nel dispatch dei messaggi:

```js
          else if (msg.t === "ask") showAsk(msg);
          else if (msg.t === "armed") { startBtn.disabled = !msg.on; }
```

3. In `setMic`, **togli** `startBtn.disabled = !on`: il pulsante ora dipende da `armed`, non dal microfono. Il microfono si accende dopo il click, quindi legare le due cose renderebbe il pulsante inutilizzabile proprio quando serve.

4. Nel testo fisso: `"Lascia questa scheda aperta. Il microfono si accende solo dopo che premi Parla."`

- [ ] **Step 6: Try the page by hand**

```bash
node --input-type=module -e '
import { createAudio } from "./src/audio/browser.mjs";
import { beepPcm } from "./src/pcm.mjs";
const audio = createAudio();
console.log("armed:", await audio.arm({ spoken: "Ho finito. Procedo?", options: ["Sì", "No"] }));
console.log("clicked:", await audio.waitForButton(30000));
await audio.play(beepPcm({ freq: 660, ms: 400 }));
const pcm = await audio.record({});
console.log("recorded bytes:", pcm.length);
await audio.close();
process.exit(0);
'
```

Atteso: si apre una scheda, premi "Attiva audio", concedi il microfono, leggi la domanda e le due opzioni, senti il beep, il pulsante "Parla" è attivo. Premilo, senti il tono, parla, e alla fine il conteggio dei byte è coerente con quanto hai parlato (48000 byte al secondo).

- [ ] **Step 7: Commit**

```bash
git add src/audio/browser.mjs public/voice.html test/audio-browser.test.mjs
git commit -m "feat(audio): the page as the sound card, with the button as the only trigger"
```

---

### Task 8: La macchina a stati

Il pezzo che tiene insieme tutto il resto. Non parla con la rete e non tocca l'audio: chiama i quattro moduli che riceve, il che è esattamente ciò che lo rende testabile per intero.

**Files:**
- Create: `src/call.mjs`
- Test: `test/call.test.mjs`
- Reference: `src/policy.mjs:14-40` (`normalizeDecision`)

**Interfaces:**
- Consumes: `normalizeDecision` da `policy.mjs`; le quattro interfacce dei Task 3-7.
- Produces: `runCall({message, options, spoken, signal, modules, cfg}) → Promise<{kind, value?}>` — lo stesso contratto che `session.mjs` già restituisce a `server.mjs`.

- [ ] **Step 1: Write the failing test**

Crea `test/call.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCall } from "../src/call.mjs";

const OPTIONS = ["Apri la pull request", "Fai altri test"];

const cfg = {
  waitMs: 30000,
  maxTurns: 8,
  retryLine: "Non ho sentito. Puoi ripetere?",
};

// Fakes with a memory: every test asserts on what the modules were asked to do, which is the
// only way to tell "it worked" apart from "it returned something".
function fakes({ armed = true, clicked = true, heard = [], routed = [] } = {}) {
  const log = { spoken: [], played: 0, reports: [] };
  return {
    log,
    audio: {
      arm: async (view) => {
        log.armed = view;
        return armed;
      },
      waitForButton: async () => clicked,
      play: async () => {
        log.played++;
        return { interrupted: false };
      },
      record: async () => Buffer.alloc(96),
      report: (r) => log.reports.push(r),
      close: async () => {},
    },
    tts: {
      speak: async (text) => {
        log.spoken.push(text);
        return Buffer.alloc(96);
      },
    },
    stt: { transcribe: async () => heard.shift() ?? "" },
    brain: { route: async () => routed.shift() ?? { kind: "decide", decision: { kind: "end" } } },
  };
}

test("nobody clicks: the call ends without a single paid call", async () => {
  const f = fakes({ clicked: false });
  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  assert.deepEqual(out, { kind: "end" });
  assert.equal(f.log.spoken.length, 0, "no synthesis");
  assert.equal(f.log.played, 0, "no playback");
});

test("no tab at all: the call ends rather than talking to nobody", async () => {
  const f = fakes({ armed: false });
  assert.deepEqual(
    await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg }),
    { kind: "end" },
  );
});

test("the opening line is spoken verbatim — no model rewrites it", async () => {
  const f = fakes({
    heard: ["la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  await runCall({ message: "m", options: OPTIONS, spoken: "Ho finito. Procedo?", modules: f, cfg });
  assert.equal(f.log.spoken[0], "Ho finito. Procedo?");
});

test("a picked option comes back as a validated choice", async () => {
  const f = fakes({
    heard: ["la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.deepEqual(out, { kind: "choice", value: "Apri la pull request" });
});

test("a choice that matches no offered option is downgraded, not acted on", async () => {
  const f = fakes({
    heard: ["fai come vuoi"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: "Cancella tutto" } }],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.equal(out.kind, "message", "Claude must never act on an option nobody offered");
});

test("a question keeps the call open and the answer is spoken", async () => {
  const f = fakes({
    heard: ["cosa hai cambiato?", "allora la seconda"],
    routed: [
      { kind: "speak", text: "Ho toccato quattro file." },
      { kind: "decide", decision: { kind: "choice", value: OPTIONS[1], optionIndex: 2 } },
    ],
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  assert.deepEqual(f.log.spoken, ["s", "Ho toccato quattro file."]);
  assert.deepEqual(out, { kind: "choice", value: "Fai altri test" });
});

test("silence is asked to repeat, without spending a turn on the model", async () => {
  const f = fakes({
    heard: ["", "la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.deepEqual(f.log.spoken, ["s", "Non ho sentito. Puoi ripetere?"]);
});

test("a conversation that never lands is closed by the turn ceiling", async () => {
  const f = fakes({
    heard: Array(20).fill("e poi?"),
    routed: Array(20).fill({ kind: "speak", text: "Dimmi." }),
  });

  const out = await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });
  assert.deepEqual(out, { kind: "end" });
  assert.ok(f.log.spoken.length <= cfg.maxTurns + 1, "a runaway conversation is a runaway bill");
});

test("the page gets a receipt of what went back to Claude", async () => {
  const f = fakes({
    heard: ["la prima"],
    routed: [{ kind: "decide", decision: { kind: "choice", value: OPTIONS[0], optionIndex: 1 } }],
  });

  await runCall({ message: "m", options: OPTIONS, spoken: "s", modules: f, cfg });

  const r = f.log.reports.at(-1);
  assert.equal(r.decision.kind, "choice");
  assert.equal(r.heard, "la prima");
});

test("an aborted call goes quiet and returns end", async () => {
  const ac = new AbortController();
  const f = fakes({ heard: ["la prima"] });
  f.audio.record = async () => {
    ac.abort();
    return Buffer.alloc(96);
  };

  const out = await runCall({
    message: "m",
    options: OPTIONS,
    spoken: "s",
    signal: ac.signal,
    modules: f,
    cfg,
  });
  assert.deepEqual(out, { kind: "end" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/call.test.mjs`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Write the implementation**

Crea `src/call.mjs`:

```js
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
```

Aggiungi `retryLine` a `config.mjs`, accanto alle altre chiavi del Task 2:

```js
  // What to say when a turn came back empty. It is spoken, so it stays short.
  retryLine: process.env.VOICE_RETRY_LINE || "Non ho sentito. Puoi ripetere?",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/call.test.mjs`
Expected: PASS, 10 test.

Se il test "a choice that matches no offered option" fallisce, leggi `src/policy.mjs:14-40` prima di toccare `call.mjs`: quella regola vive lì e questo task deve solo chiamarla, non riscriverla.

- [ ] **Step 5: Commit**

```bash
git add src/call.mjs src/config.mjs test/call.test.mjs
git commit -m "feat(call): the five-state machine behind the four interfaces"
```

---

### Task 9: Commutazione e demolizione

Tutto il nuovo esiste e ha i suoi test. Questo task lo attacca al server MCP e cancella il vecchio. È il primo momento in cui il repo perde qualcosa, e va fatto in un commit solo, così un `git revert` riporta indietro un motore intero.

**Files:**
- Modify: `src/session.mjs`, `src/config.mjs`, `package.json`, `.gitignore`
- Create: `scripts/try-call.mjs`
- Delete: `src/realtime.mjs`, `src/wake.mjs`, `src/audio.mjs`, `src/jitter.mjs`, `src/browser-audio.mjs`, `test/bargein.test.mjs`, `test/browser-audio.test.mjs`, `test/gate.test.mjs`, `test/jitter.test.mjs`, `test/session.test.mjs`, `test/wait.test.mjs`, `test/wake.test.mjs`, `test/fakes.mjs`, `scripts/audio-check.mjs`, `scripts/mic-check.mjs`, `scripts/selftest-voice.mjs`, `scripts/setup-wake.mjs`, `scripts/smoke-hook.mjs`, `scripts/test-realtime-audiofile.mjs`, `scripts/test-realtime-noaudio.mjs`, `scripts/try-voice.mjs`

**Interfaces:**
- Consumes: `runCall` dal Task 8, `loadModules` dal Task 6.
- Produces: `session.mjs` invariato all'esterno — `runSession({message, options, spoken, signal}) → Promise<{kind, value?}>`.

- [ ] **Step 1: Rewrite session.mjs**

```js
// Dispatches a stopping-point hand-off to the voice or text path and returns a normalized
// decision: { kind: "choice"|"message"|"end", value?: string }.

import { config } from "./config.mjs";
import { runTextSession } from "./text.mjs";

// `signal` aborts when Claude Code cancels the tool call (the user pressed Esc): the session
// must go silent and return, not keep talking to nobody.
// `spoken` is the opening line Claude wrote to be read verbatim. Text mode ignores it on
// purpose: it prints `message`, which is the full version, and reading a line meant for the
// ear off a screen would just be a worse summary of what is already there.
export async function runSession({ message, options = [], spoken = "", signal }) {
  if (config.mode === "text") return runTextSession({ message, options, signal });

  // Lazy on purpose: text mode must never open a port, load a module, or need a key.
  const [{ runCall }, { loadModules }] = await Promise.all([
    import("./call.mjs"),
    import("./modules.mjs"),
  ]);

  try {
    modules = modules || (await loadModules());
    return await runCall({ message, options, spoken, signal, modules });
  } catch (err) {
    // A missing key, a provider outage, a tab that never opened: the voice is optional, the
    // decision is not. Fall back to the terminal rather than losing Claude's turn.
    process.stderr.write(`[claude-voice] voice path failed (${String(err?.message ?? err)}) — falling back to text\n`);
    return runTextSession({ message, options, signal });
  }
}

let modules = null;

// Server shutdown (SIGTERM/SIGINT, stdin closed): release the port and let the process exit.
export function abortActiveSessions() {
  modules?.audio?.close?.();
  modules = null;
}
```

- [ ] **Step 2: Delete the old engine**

```bash
git rm src/realtime.mjs src/wake.mjs src/audio.mjs src/jitter.mjs src/browser-audio.mjs
git rm test/bargein.test.mjs test/browser-audio.test.mjs test/gate.test.mjs \
       test/jitter.test.mjs test/session.test.mjs test/wait.test.mjs test/wake.test.mjs \
       test/fakes.mjs
git rm scripts/audio-check.mjs scripts/mic-check.mjs scripts/selftest-voice.mjs \
       scripts/setup-wake.mjs scripts/smoke-hook.mjs scripts/test-realtime-audiofile.mjs \
       scripts/test-realtime-noaudio.mjs scripts/try-voice.mjs
```

- [ ] **Step 3: Strip the dead settings**

In `src/config.mjs` cancella le chiavi che non ha più senso leggere: `apiKey`, `model`, `voice`, `vad`, `vadThreshold`, `prefixPaddingMs`, `transcribeModel`, `noise`, `halfDuplex`, `micReopenMs`, `waitTickMs`, `waitTickVolume`, `cueEchoMs`, `wakeLevel`, `wakeWord`, `whisperBin`, `whisperModel`, `wakeMs`, `followupMs`, `openingGraceMs`, `minAnswerMs`, `transcriptWaitMs`, `turnBeep`. Cancella anche `requireApiKey`.

Tieni: `mode`, `lang`, `langCode`, `audio`, `silenceMs` (rinominata? **no** — cancellala, il suo lavoro lo fa `recordSilenceMs`), `bargeInMs`, `waitMs`, `speed`, `timeoutMs`, `disabled`, più tutte le chiavi aggiunte al Task 2.

Poi verifica di non aver lasciato riferimenti orfani:

```bash
grep -rn "requireApiKey\|config\.apiKey\|wakeWord\|halfDuplex\|realtime\|browser-audio" src/ hooks/ scripts/ public/ package.json
```

Expected: nessun risultato. Se ne trova, l'unico posto legittimo è un commento storico: riscrivilo o cancellalo.

- [ ] **Step 4: Clean package.json and .gitignore**

In `package.json`: togli la dipendenza `@openai/agents`, e riduci gli script a

```json
  "scripts": {
    "server": "node src/server.mjs",
    "test": "node --test --test-timeout=15000 test/*.test.mjs",
    "smoke:mcp": "node scripts/smoke-mcp.mjs",
    "try": "node scripts/try-call.mjs"
  },
```

Poi `npm install` per aggiornare `package-lock.json`.

In `.gitignore` aggiungi:

```
vendor/
models/
.voice-bridge-token
voice-debug.log
```

- [ ] **Step 5: Write the end-to-end script**

Crea `scripts/try-call.mjs`. È l'unico modo di misurare i tre numeri del §9 della spec, quindi stampa le latenze per stadio.

```js
#!/usr/bin/env node
// One real call, end to end, with the clock running on every stage. This is how the three
// open questions in the spec get answered: perceived latency, the accent, and whether
// GPT-OSS-20B closes the call at the right moment.

import { runCall } from "../src/call.mjs";
import { config } from "../src/config.mjs";
import { loadModules } from "../src/modules.mjs";

const MESSAGE = `Ho riscritto il motore vocale su OpenRouter: tre moduli separati per voce,
ascolto e ragionamento, dietro interfacce sostituibili. I test passano, 34 su 34. Restano due
cose da decidere prima di aprire la pull request: se tenere il fallback testuale attivo di
default, e se misurare i provider adesso o dopo la prima settimana d'uso.`;

const OPTIONS = ["Apri la pull request", "Misura prima i provider", "Fermati qui"];

const stamp = (label, t0) => console.log(`  ${label}: ${Date.now() - t0} ms`);

const modules = await loadModules();

// Wrap each module so the timings come from the real thing, not from a guess.
for (const [name, method] of [["tts", "speak"], ["stt", "transcribe"], ["brain", "route"]]) {
  const inner = modules[name][method].bind(modules[name]);
  modules[name][method] = async (...args) => {
    const t0 = Date.now();
    try {
      return await inner(...args);
    } finally {
      stamp(name, t0);
    }
  };
}

const t0 = Date.now();
const decision = await runCall({
  message: MESSAGE,
  options: OPTIONS,
  spoken: "Ho finito il motore vocale. Apro la pull request, misuro prima i provider, o mi fermo?",
  modules,
  cfg: config,
});

console.log(`\ndecisione: ${JSON.stringify(decision)}`);
console.log(`totale: ${Date.now() - t0} ms`);
await modules.audio?.close?.();
process.exit(0);
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. I file rimasti sono `pcm`, `config`, `tts`, `stt`, `brain`, `modules`, `audio-browser`, `call`, `policy`.

Run: `npm run smoke:mcp`
Expected: il server MCP risponde. Se `smoke-mcp.mjs` importava qualcosa che hai cancellato, aggiustalo: è l'unico test che verifica che il tool esista ancora.

- [ ] **Step 7: Try it for real**

Run: `npm run try`
Atteso: la scheda si apre, leggi la domanda, premi "Parla", senti Harper leggere la riga di apertura, rispondi "la prima", e il comando stampa `{"kind":"choice","value":"Apri la pull request"}` con le latenze per stadio.

Prova anche il giro di chiarimento: invece di scegliere, chiedi "cosa resta da decidere?" e verifica che risponda dal contesto e resti in ascolto.

Annota i tre numeri: latenza percepita totale, tenuta di GPT-OSS-20B, com'è l'accento all'ascolto.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(engine): switch the MCP server to the OpenRouter pipeline

The Realtime engine, the wake word, the sox backend and the jitter buffer all
go in one commit, so reverting brings back a whole working engine rather than
half of one. What replaces them is smaller and, more to the point, splittable:
each of the four stages is now a module behind an interface, so a local engine
lands as a new value in the registry instead of as a fourth parallel path."
```

---

### Task 10: Documentazione e pull request

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: `.env.example`

**Interfaces:**
- Consumes: tutto.
- Produces: niente codice.

- [ ] **Step 1: Write .env.example**

```bash
# The only key you have to set. One key covers speech, transcription and reasoning.
OPENROUTER_API_KEY=

# Voice or terminal. Text mode needs nothing at all — no key, no browser, no audio.
VOICE_MODE=voice

# The language the voice speaks and the transcriber expects.
VOICE_LANG=Italiano

# Which implementation fills each slot. Today there is one of each; a local engine would
# land here as a new name and nothing else would change.
VOICE_AUDIO=browser
VOICE_TTS=openrouter
VOICE_STT=openrouter
VOICE_BRAIN=openrouter

# The models. MAI-Voice-2-Flash has no Italian voice — Harper is multilingual and reads
# Italian with an English accent. Swap the model here if that grates.
VOICE_TTS_MODEL=microsoft/mai-voice-2-flash
VOICE_TTS_VOICE=en-US-Harper:MAI-Voice-2
VOICE_STT_MODEL=openai/whisper-large-v3-turbo
VOICE_BRAIN_MODEL=openai/gpt-oss-20b

# How long the page waits for you to press the button before giving up (ms).
VOICE_WAIT_MS=30000
```

- [ ] **Step 2: Rewrite the README**

Il README attuale (15 KB) descrive tre motori che non esistono più. Riscrivilo intorno a: cosa fa in tre frasi; installazione (`npm install`, la chiave, `.mcp.json`); come si usa (Claude si ferma, la scheda mostra la domanda, premi Parla, rispondi); i quattro moduli e come si sostituiscono; la tabella dei modelli e dei costi; il fallback testuale; risoluzione dei problemi (scheda non aperta, microfono negato, chiave assente).

Cancella dal README: sezioni su Realtime, ElevenLabs, motore locale, `setup:wake`, `setup:local`, sox, dispositivi di ingresso.

- [ ] **Step 3: Check CLAUDE.md is still true**

`CLAUDE.md` descrive il contratto del tool, non il motore. Verifica che ogni frase regga ancora — in particolare "beeps and waits ~30s": ora il beep c'è, ma quello che si aspetta è un click, non una voce. Correggi quella frase e lascia stare il resto.

- [ ] **Step 4: Full verification before the PR**

```bash
npm test && npm run smoke:mcp && git status --short
```

Expected: test verdi, smoke verde, working tree pulito.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A
git commit -m "docs: rewrite the README around the OpenRouter pipeline"
git push -u origin openrouter-pipeline
gh pr create --base main --title "Split-pipeline voice engine on OpenRouter" --body "$(cat <<'EOF'
Replaces three overlapping engines (OpenAI Realtime, ElevenLabs, local
whisper.cpp + Piper) with one turn-based flow behind four swappable
interfaces, all running on OpenRouter with a single key.

- `AudioIO` — the browser page: button, microphone, speaker, echo cancellation
- `Tts` — MAI-Voice-2-Flash, reading Claude's line verbatim
- `Stt` — Whisper Large V3 Turbo
- `Brain` — GPT-OSS-20B, routing over Claude's full message

The trigger is the button and nothing else: no wake word, no always-on level
meter, no local engine kept warm. Nothing is paid for until the user clicks.

Spec: docs/superpowers/specs/2026-08-12-pipeline-openrouter-design.md
Plan: docs/superpowers/plans/2026-08-12-pipeline-openrouter.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verifica finale

Dopo il Task 10, questi devono essere veri tutti insieme:

- [ ] `npm test` passa, e i file di test sono nove
- [ ] `grep -rn "openai/agents\|realtime\|wakeWord\|sox" src/ package.json` non trova nulla
- [ ] `npm run try` porta a una decisione vera, con la voce
- [ ] `VOICE_MODE=text npm run smoke:mcp` funziona senza chiave e senza browser
- [ ] `src/` sta sotto le 1.200 righe (`wc -l src/*.mjs src/*/*.mjs`)
- [ ] i tre numeri del §9 della spec sono annotati nella descrizione della pull request
