# Backend vocale ElevenLabs per claude-voice

Data: 2026-08-07
Stato: design approvato, prototipo da costruire

## Problema

Il backend vocale attuale (`src/realtime.mjs`, OpenAI Realtime via `@openai/agents`) ha tre
difetti per l'uso quotidiano in italiano:

1. **Qualità della voce e pronuncia italiana** insufficienti.
2. **Turn-taking e latenza**: il VAD taglia le frasi, il barge-in è fragile.
3. **Controllo e affidabilità**: il modello ignora a intermittenza le istruzioni della
   sessione.

Il costo *non* è un vincolo: ElevenLabs costa più di `gpt-realtime-2.1-mini` al minuto e va
bene così.

## Obiettivo

Valutare, e se convince adottare, ElevenLabs Agents come backend vocale alternativo,
**distribuibile come plugin** che chiunque configura con il proprio account ElevenLabs.

## Non obiettivi

- Non si tocca il contratto del tool `talk_to_user` né lo Stop hook.
- Non si tocca `src/text.mjs` (fallback testuale) né `src/policy.mjs`.
- Nessuna dipendenza da un agente ElevenLabs condiviso o da un account nostro.
- Nessun round-trip di chiarimento verso Claude durante la chiamata: resta fuori scope come
  in v1.

## Decisioni prese

| Decisione | Scelta | Motivo |
|---|---|---|
| Chi fa da cervello | LLM dell'ElevenLabs Agent | Mantiene l'architettura attuale: un WebSocket, un tool `submit_decision`. Meno codice del cascade fatto in casa. |
| Primo passo | Prototipo standalone | Sentire voce e latenza reali prima di impegnarsi sull'integrazione. |
| Autenticazione | API key in env | L'hosted MCP di ElevenLabs (`https://api.elevenlabs.io/v1/mcp`) è OAuth-only e Claude Code non riesce a collegarsi (`Incompatible auth server: does not support dynamic client registration`). Inoltre un plugin non può dipendere dall'account di chi lo ha scritto. |
| Onboarding | Auto-provisioning da template | Chi installa il plugin fornisce solo `ELEVENLABS_API_KEY`. Zero configurazione manuale in dashboard. |

## Corrispondenza architetturale

L'SDK Node `@elevenlabs/elevenlabs-js` mappa quasi 1:1 sull'implementazione attuale.

| oggi (`src/realtime.mjs`) | ElevenLabs |
|---|---|
| `RealtimeSession` su WebSocket | `Conversation` su WebSocket |
| `tool({ name: "submit_decision" })` | `ClientTools.register("submit_decision", fn)` |
| `buildInstructions()` passato in `instructions` | `conversationConfigOverride.agent_prompt_override` |
| primo turno parlato dal modello | `conversationConfigOverride.first_message_override` |
| bridge PCM16 verso `sox` | `audioInterface` custom (`input` / `output` / `interrupt` / `stop`) |
| barge-in via `VOICE_BARGE_IN_MS` | evento `interruption` → `audioInterface.interrupt()` |
| `transcriptionPrompt()` con i nomi del progetto | **nessun equivalente** — vedi Rischi |

`src/policy.mjs` (`normalizeDecision`, `createTurnState`, `looksGarbled`) è già
provider-agnostico e viene riusato tale e quale: è lì che vive la garanzia che un `choice`
venga riportato solo se l'utente ha scelto un'opzione **intera**.

## Configurazione

Nello stile di `src/config.mjs` — tutto via env, con default sensati.

| variabile | obbligatoria | default | nota |
|---|---|---|---|
| `VOICE_PROVIDER` | no | `openai` | `openai` \| `elevenlabs` |
| `ELEVENLABS_API_KEY` | sì, se provider `elevenlabs` | — | unica cosa davvero richiesta |
| `ELEVENLABS_AGENT_ID` | no | — | se assente, l'agente viene provisionato |
| `ELEVENLABS_VOICE_ID` | no | voce italiana scelta nel prototipo | |
| `ELEVENLABS_LLM` | no | modello di default dell'agente | |
| `VOICE_LANG` | no | `English` | già esistente, riusata per `language` |

Le variabili già esistenti che restano valide anche sul nuovo backend: `VOICE_MODE`,
`VOICE_DISABLE`, `VOICE_WAIT_MS`, `VOICE_FOLLOWUP_MS`, `VOICE_TIMEOUT_MS`,
`VOICE_HALF_DUPLEX`, `VOICE_IN_DEVICE`, `VOICE_TURN_BEEP`, `VOICE_DEBUG`.

Se `VOICE_PROVIDER=elevenlabs` e manca `ELEVENLABS_API_KEY`, il messaggio d'errore segue lo
stesso schema di `requireApiKey` in `src/config.mjs`: indica la variabile da impostare e
ricorda `VOICE_MODE=text` come alternativa.

## Provisioning dell'agente

`ensureAgent()` è l'onboarding del plugin, non boilerplate.

1. Se `ELEVENLABS_AGENT_ID` è impostata, viene usata così com'è. Fine.
2. Altrimenti si crea un agente **nell'account dell'utente** partendo da un template
   versionato nel repo (`agent.template.json`), che fissa:
   - prompt di sistema di base (quello vero arriva per-sessione via override);
   - `client tool` `submit_decision` con schema `{ kind, value }`;
   - voce, lingua, modello LLM;
   - formati audio in ingresso e in uscita;
   - **override abilitati** nelle impostazioni di sicurezza dell'agente — senza questo
     `agent_prompt_override` viene ignorato silenziosamente.
3. L'id creato viene stampato con l'istruzione di salvarlo in `.env`, così le esecuzioni
   successive non ricreano nulla.

## Flusso di una chiamata

1. `src/session.mjs` sceglie il modulo in base a `config.provider` (oggi sceglie solo fra
   testo e voce; il lazy-import resta, così chi non usa ElevenLabs non ne carica l'SDK).
2. Gate locale invariato: beep, `waitForSpeech`, `VOICE_WAIT_MS`, scorciatoia
   `VOICE_FOLLOWUP_MS`. Nessuna sessione remota si apre finché l'utente non parla davvero.
3. Si apre la `Conversation` con `agent_prompt_override` costruito dalle stesse regole di
   `buildInstructions()`, `first_message_override` con la frase di apertura, e `language`.
4. L'audio scorre attraverso l'`audioInterface` che avvolge `startMic` e `createSpeaker`.
   Half-duplex e finestra di mute restano ancorati alla **riproduzione**, non all'arrivo
   dell'audio, esattamente come oggi.
5. Alla `client_tool_call` di `submit_decision` il risultato passa per `normalizeDecision` e
   la sessione si chiude con il beep di chiusura.
6. `signal` (Esc in Claude Code) chiude la sessione all'istante, senza beep e senza drenare
   l'audio in coda.

## Prototipo

Primo deliverable: `scripts/try-elevenlabs.mjs`. **Zero modifiche a `src/`.**

- CLI gemella di `scripts/try-voice.mjs`:
  `node scripts/try-elevenlabs.mjs "messaggio" "opzione A" "opzione B"`, così il confronto
  A/B con il backend attuale è diretto.
- Contiene `ensureAgent()` e l'adapter `audioInterface` già scritti nella forma che poi
  migra in `src/elevenlabs.mjs`.
- Stampa a fine sessione: decisione normalizzata, latenza al primo audio, latenze riportate
  da `callbackLatencyMeasurement`, trascrizioni utente.
- Nuova dipendenza: `@elevenlabs/elevenlabs-js`.

Serve a rispondere a quattro domande prima di integrare: la voce italiana è
percettibilmente migliore? La latenza al primo audio è accettabile? Il turn-taking regge
senza tagliare le frasi? La tool call `submit_decision` arriva in modo affidabile?

## Rischi e incognite

- **Sample rate.** `src/audio.mjs` ha `RATE = "24000"` hardcoded. Se l'agente vuole
  `pcm_16000` in ingresso serve un resample o un secondo processo `sox`. Da verificare nel
  prototipo prima di ogni altra cosa.
- **Override.** `agent_prompt_override` funziona solo se gli override sono abilitati sulle
  impostazioni dell'agente. Il template li abilita, ma un agente creato a mano da un utente
  no: se `ELEVENLABS_AGENT_ID` è fornita dall'utente, va verificato a runtime e segnalato.
- **Priming del trascrittore.** Oggi `transcriptionPrompt()` inietta i nomi del progetto
  (branch, file) nel prompt del trascrittore. Su ElevenLabs la trascrizione è interna e non
  esiste un equivalente esposto. Perdita di qualità da misurare all'ascolto su nomi propri e
  termini tecnici.
- **Costo.** Più alto al minuto. Accettato, ma va misurato con una sessione reale.
- **Superficie da mantenere.** Se il prototipo convince e si tiene anche il backend OpenAI,
  restano due backend vocali da mantenere. La scelta fra convivenza e sostituzione totale è
  rimandata a dopo il prototipo, con dati alla mano.

## Test

- `src/policy.mjs` è invariato: `test/policy.test.mjs` e `test/gate.test.mjs` restano validi.
- Il prototipo non introduce test automatici: la sua validazione è l'ascolto.
- Se si passa all'integrazione, `test/fakes.mjs` va esteso con una `Conversation` finta, sullo
  stesso modello con cui oggi `deps.createSession` permette di testare il percorso della tool
  call senza aprire una sessione reale.
