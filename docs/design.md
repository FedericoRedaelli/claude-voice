# Pipeline OpenRouter — specifica di progetto

**Data:** 2026-08-12
**Stato:** progettato, approvato, non implementato.
**Obiettivo:** sostituire i tre motori sovrapposti nati dalle prove (OpenAI Realtime,
ElevenLabs, motore locale whisper.cpp + Piper) con **un solo flusso**, diviso in moduli
sostituibili, oggi interamente su OpenRouter con una chiave sola.

Questo documento è scritto per essere autosufficiente dopo un compact: chi lo legge non ha la
conversazione che lo ha prodotto.

---

## 1. Perché si riparte

Le prove hanno dato una risposta netta su due punti.

**Il realtime non serve.** Un modello vocale end-to-end costa più di tre chiamate separate,
non si può cambiare pezzo per pezzo, e la conversazione che ci serve è a turni netti: il
sistema parla, l'utente risponde, il sistema decide. Un flusso diviso — text-to-speech,
speech-to-text, cervello — copre il caso reale e lascia sostituire un pezzo alla volta.

**Il motore locale costa troppo in dipendenze.** whisper.cpp, Piper, llama.cpp e i loro
modelli sono ~2 GB da installare e mantenere per un progetto che deve essere clonabile e
partire. Resta come destinazione futura dei moduli, non come punto di partenza.

Da qui la scelta di OpenRouter: **una sola `OPENROUTER_API_KEY`** copre trascrizione,
sintesi e ragionamento, quindi la configurazione minima è una riga in `.env`.

## 2. Da dove si parte

Tutto quanto segue è già su `main` e **non va riscritto**.

| Pezzo | File | Cosa fa |
|---|---|---|
| Contratto MCP | `src/server.mjs` | `talk_to_user(message, options, spoken)` |
| Dispatch | `src/session.mjs` | voce o testo |
| Guardiano decisioni | `src/policy.mjs` | `normalizeDecision`, `looksGarbled`. La conferma di quale opzione sia stata scelta e' una seconda lettura del modello (`brain.confirmChoice`), non piu' una lista di ordinali |
| Fallback terminale | `src/text.mjs` | stessa decisione via `/dev/tty` |
| Config da env | `src/config.mjs`, `src/env.mjs` | `.env` alla radice del plugin |
| Nudge allo Stop | `hooks/` | costringe Claude a chiamare il tool |
| Pagina audio | `public/voice.html` + `src/browser-audio.mjs` | tab Chrome come scheda audio, AEC vera |

Da portare dal branch `local-engine`: il commit `ee3e45d` (*keep the bridge token, so the tab
survives a restart*) — senza quello il tab va riaperto a ogni riavvio del server MCP.

## 3. Il contratto dei due payload

È il nodo centrale del progetto e **il contratto esistente lo regge già**. Claude, al proprio
punto di arresto, produce tre cose e le passa al tool:

| Campo | Cosa contiene | Chi lo consuma |
|---|---|---|
| `spoken` | una o due frasi, scritte da Claude per l'orecchio | il TTS, **verbatim**. Nessun modello lo rielabora |
| `message` | l'intero output dell'ultimo turno di Claude | il cervello, come system prompt. **Mai letto ad alta voce** |
| `options` | le scelte offerte | il cervello per rispondere, `policy.mjs` per validare |

La conseguenza economica è il punto: la sintesi la scrive Claude, che sta già scrivendo. Non
si paga un secondo modello per riassumere, e l'utente sente una frase corta pur avendo dietro
un cervello che conosce tutto il contesto e può rispondere ai chiarimenti.

## 4. Architettura a moduli

Node è l'orchestratore, la pagina è la scheda audio, OpenRouter è il fornitore delle tre
capacità. Quattro interfacce, ognuna con un'implementazione oggi e uno slot per domani.

| Interfaccia | Metodi | Implementazione oggi | Slot futuri |
|---|---|---|---|
| `AudioIO` | `arm(view)`, `waitForButton()`, `play(pcm)`, `record()` | `src/audio/browser.mjs` | `audio/sox.mjs` per l'uso headless |
| `Tts` | `speak(text) → pcm` | `src/tts/openrouter.mjs` | Piper, Kokoro in locale |
| `Stt` | `transcribe(pcm) → text` | `src/stt/openrouter.mjs` | whisper.cpp |
| `Brain` | `route({context, options, turns}) → {kind, ...}` | `src/brain/openrouter.mjs` | llama.cpp con grammatica GBNF |

`src/modules.mjs` è il registry: legge `VOICE_AUDIO`, `VOICE_TTS`, `VOICE_STT`, `VOICE_BRAIN`
e importa dinamicamente l'implementazione richiesta. Le regole che tengono in piedi la cosa:

- nessun modulo importa un altro modulo — parlano solo con l'orchestratore;
- la valuta comune è **PCM16 mono little-endian a 24 kHz**, che è anche il sample rate nativo
  di MAI-Voice-2: nessun ricampionamento in tutta la catena;
- ogni modulo è sostituibile cambiando una variabile d'ambiente, senza toccare `call.mjs`.

### Modelli e chiamate

| Ruolo | Modello | Endpoint | Note |
|---|---|---|---|
| TTS | `microsoft/mai-voice-2-flash` | `POST /api/v1/audio/speech` | body `{model, input, voice, response_format:"pcm", speed}`; risposta = byte audio grezzi, non JSON |
| STT | `openai/whisper-large-v3-turbo` | `POST /api/v1/audio/transcriptions` | body `{model, input_audio:{data:<base64>, format:"wav"}, language}`; risposta `{text, usage}` |
| Cervello | `openai/gpt-oss-20b` | `POST /api/v1/chat/completions` | output JSON vincolato allo schema della decisione |

Voce scelta: **`en-US-Harper:MAI-Voice-2`**. MAI-Voice-2-Flash espone quattro voci soltanto
(`en-US-Harper`, `es-MX-Valeria`, `fr-FR-Soleil`, `de-DE-Klaus`): nessuna locale italiana
esiste, verificato provando `it-IT-*` e ottenendo 502. Il modello è multilingue e legge
italiano con l'accento della propria locale. Se l'accento diventerà fastidioso, si cambia
`VOICE_TTS_MODEL` verso un modello con italiano nativo (`minimax/speech-2.8-turbo`,
`qwen/qwen-audio-3.0-tts-flash`, `google/gemini-3.1-flash-tts-preview`): stessa chiave,
stessa interfaccia, una riga di env.

La scelta del provider dietro ogni modello (OpenRouter ne ha più di uno per modello, con
latenze diverse) si misura **dopo la prima run**, non ora. Fino ad allora si lascia il
routing predefinito.

## 5. Il flusso

Macchina a stati in `src/call.mjs`. Cinque stati, uno per riga.

| Stato | Cosa succede | Costo |
|---|---|---|
| **S0 armata** | il server apre o riusa il tab, ci scrive `spoken` e le opzioni, emette un beep, aspetta il click. Nessun ascolto, nessun motore acceso | zero |
| **S1 apertura** | il TTS legge `spoken` verbatim | una sintesi |
| **S2 ascolto** | la pagina registra un'utterance, chiusa da 800 ms di silenzio misurati in locale | zero |
| **S3 trascrizione** | Whisper Turbo restituisce il testo | a secondo di audio |
| **S4 routing** | il cervello riceve `message` come system prompt più `options` e la storia dei turni; risponde `speak` (→ S1 con il proprio testo, poi S2) o `decide` (→ S5) | token |
| **S5 chiusura** | `policy.normalizeDecision` valida contro le opzioni offerte, beep di chiusura, ricevuta sulla pagina, JSON a Claude | zero |

**Il trigger è il solo pulsante.** Niente parola di attivazione, niente misuratore di livello
sempre attivo, niente motore locale acceso in permanenza: sono state scelte esplicitamente
scartate. Il costo di una chiamata parte solo dopo il click; se in S0 nessuno clicca entro
30 s, il tool ritorna `{"kind":"end"}` senza aver speso nulla.

**Barge-in.** La pagina ha la cancellazione d'eco nativa del browser, quindi il microfono può
restare aperto durante la riproduzione. Se il livello supera la soglia per 300 ms consecutivi,
la riproduzione si ferma e si passa a S2.

**Degradazione.** Se un modulo fallisce — rete assente, 502 del provider, tab chiuso — la
sessione ripiega su `text.mjs` nel terminale. La decisione di Claude non si perde mai: al
massimo si perde la voce.

## 6. File dopo la pulizia

**Nuovi**

| File | Ruolo |
|---|---|
| `src/call.mjs` | macchina a stati a cinque stati |
| `src/modules.mjs` | registry delle implementazioni, guidato da env |
| `src/wav.mjs` | intestazione WAV attorno al PCM, per Whisper |
| `src/tts/openrouter.mjs` | sintesi |
| `src/stt/openrouter.mjs` | trascrizione |
| `src/brain/openrouter.mjs` | routing della conversazione |
| `src/audio/browser.mjs` | derivato da `browser-audio.mjs`, sfoltito |

**Invariati:** `server.mjs`, `session.mjs`, `policy.mjs`, `text.mjs`, `env.mjs`, `hooks/`.
`config.mjs` sfoltito delle chiavi morte.

**Cancellati** (esistono su questo branch): `src/realtime.mjs`, `src/wake.mjs`,
`src/audio.mjs`, `src/jitter.mjs`, `src/browser-audio.mjs` (assorbito in `audio/browser.mjs`);
gli script `audio-check`, `mic-check`, `selftest-voice`, `setup-wake`, `smoke-hook`,
`test-realtime-audiofile`, `test-realtime-noaudio`, `try-voice`; i test `bargein`,
`browser-audio`, `gate`, `jitter`, `session`, `wait`, `wake`; la dipendenza `@openai/agents`.
Restano `@modelcontextprotocol/sdk`, `zod` e `ws` (il ponte con la pagina).

**Mai importati da `local-engine`:** `local.mjs`, `llm.mjs`, `piper.mjs`, `piper_worker.py`,
`gate.mjs`, `brain.mjs` e le cartelle `models/` e `vendor/` vivono solo su quel branch e non
attraversano. `vendor/` va aggiunto a `.gitignore` perché è presente non tracciato nella
working copy.

Ordine di grandezza atteso: da ~2.480 righe di `src/` a ~1.100.

**Script superstiti:** `smoke-mcp.mjs` (il tool risponde) e uno nuovo `try-call.mjs` (una
chiamata vera end-to-end, per misurare la latenza dei provider).

## 7. Configurazione

```
OPENROUTER_API_KEY=...        # l'unica obbligatoria
VOICE_MODE=voice|text         # default voice
VOICE_LANG=italiano           # steer del TTS e hint per Whisper
VOICE_AUDIO=browser           # slot: sox
VOICE_TTS=openrouter          # slot: local
VOICE_STT=openrouter
VOICE_BRAIN=openrouter
VOICE_TTS_MODEL=microsoft/mai-voice-2-flash
VOICE_TTS_VOICE=en-US-Harper:MAI-Voice-2
VOICE_STT_MODEL=openai/whisper-large-v3-turbo
VOICE_BRAIN_MODEL=openai/gpt-oss-20b
```

Chiavi da rimuovere da `.env` e da `config.mjs`: `ELEVENLABS_*`, `OPENAI_API_KEY`,
`VOICE_ENGINE`, `VOICE_PIPER_VOICE`, `VOICE_WAKE_*`, `VOICE_WHISPER_*`, `VOICE_IN_DEVICE`.

## 8. Test

Nessun test tocca la rete. I moduli si sostituiscono con fake attraverso il registry, che è
il motivo principale per cui il registry esiste.

| File | Cosa verifica |
|---|---|
| `test/policy.test.mjs` | invariato: una `choice` che non mappa a un'opzione decade a `message` |
| `test/call.test.mjs` | i cinque stati con TTS/STT/cervello/audio finti: apertura verbatim, giro di chiarimento, chiusura, timeout in S0, barge-in |
| `test/modules.test.mjs` | l'env seleziona l'implementazione giusta; un nome sconosciuto fallisce con un messaggio leggibile |
| `test/brain.test.mjs` | nuovo: dallo schema JSON alla decisione, con risposte del modello finte, incluse quelle malformate |
| `test/wav.test.mjs` | intestazione corretta, round-trip PCM |

## 9. Cosa resta da misurare dopo la prima run

1. **Latenza percepita** da fine parlato a inizio risposta. Somma di trascrizione, cervello e
   sintesi. Sopra ~1,5 s la conversazione smette di sembrare tale, e allora si sceglie il
   provider per modello su OpenRouter invece di lasciare il routing predefinito.
2. **Qualità dell'accento** di Harper sull'italiano nell'uso quotidiano, non su una frase di
   prova.
3. **Tenuta di GPT-OSS-20B** come conduttore: quante volte sceglie `decide` quando l'utente
   stava ancora chiedendo, e viceversa.

## 10. Piano di consegna

Branch `openrouter-pipeline`, aperto da `main`. I branch `elevenlabs-prototype` e
`local-engine` restano come archivio delle prove. A lavoro finito: pull request verso `main`.
