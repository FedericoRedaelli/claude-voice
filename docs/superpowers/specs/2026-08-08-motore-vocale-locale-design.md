# Motore vocale locale — specifica di progetto

**Data:** 2026-08-08
**Stato:** progettato, non implementato. Le due incognite in fondo vanno misurate prima di scrivere codice.
**Obiettivo:** un secondo motore vocale che gira interamente sulla macchina dell'utente, senza
provider esterno, e che regge una conversazione di approfondimento sul contenuto scritto da
Claude — non solo la scelta fra opzioni.

Questo documento è scritto per essere autosufficiente dopo un compact: chi lo legge non ha la
conversazione che lo ha prodotto.

---

## 1. Da dove si parte

Tutto quanto segue è già su `main` e **non va riscritto**.

| Pezzo | File | Cosa fa |
|---|---|---|
| Contratto MCP | `src/server.mjs` | `talk_to_user(message, options, spoken)` |
| Dispatch | `src/session.mjs` | voce o testo |
| Motore cloud | `src/realtime.mjs` | OpenAI Realtime, ~700 righe |
| Guardiano decisioni | `src/policy.mjs` | `normalizeDecision`, ordinali parlati, gate del turno |
| Audio sox | `src/audio.mjs` | mic/speaker locali, `waitForSpeech`, `beepPcm` |
| Audio browser | `src/browser-audio.mjs` + `public/voice.html` | scheda Chrome come scheda audio, AEC vera |
| Parola chiave | `src/wake.mjs` | cattura enunciato + whisper.cpp locale + match fuzzy |
| Installazione whisper | `scripts/setup-wake.mjs` | brew + modello + righe nel `.env` |

Configurazione rilevante in `.env` (non tracciato):
`VOICE_AUDIO=browser`, `VOICE_WAKE_WORD=Claude, Cloud`, `VOICE_WHISPER_BIN`,
`VOICE_WHISPER_MODEL`, `VOICE_LANG=Italian`, `VOICE_WAKE_LEVEL=1`, `VOICE_HALF_DUPLEX=0`.

Tre cose acquisite che cambiano il progetto rispetto a un mese fa:

1. **Il barge-in è già risolto.** L'echo cancellation del browser regge l'interruzione sugli
   altoparlanti, senza cuffie, verificato dal vivo. Non serve un modello full-duplex per
   ottenerlo.
2. **La frase di apertura la scrive Claude**, e l'agente la pronuncia parola per parola
   (parametro `spoken`). Il modello vocale non compone più l'apertura.
3. **`message` ora porta il testo intero**, non un riassunto (`CLAUDE.md`, modificato oggi).
   È il materiale su cui si fanno gli approfondimenti.

---

## 2. Cosa deve fare il motore locale

Condurre l'intera sessione vocale: pronunciare, ascoltare, capire se stai decidendo o
chiedendo, rispondere alle domande usando il testo di Claude, e infine restituire **una sola**
decisione nel formato già in uso: `{kind: "choice"|"message"|"end", value?, optionIndex?}`.

Il contratto `talk_to_user` non cambia. Il motore si sceglie con `VOICE_ENGINE=local`
accanto a quello attuale, non al suo posto.

### Perché lo smistamento lo fa il modello e non il codice

Una prima versione di questo progetto smistava con regole: "la prima" → scelta, "basta" →
chiusura, e così via. **È sbagliato**: sono parole italiane cablate nel codice. Un utente che
parla inglese trova un prodotto rotto. Lo smistamento deve essere flessibile, quindi lo fa il
modello — e le regole deterministiche restano solo come paracadute (§6).

### Perché il modello locale può essere piccolo

Perché Claude è sempre raggiungibile: questo non è un dispositivo isolato, è un plugin di
Claude Code. Quando il modello non sa rispondere, la domanda torna a Claude come
`kind:"message"` e Claude risponde al turno dopo. Il modello locale deve coprire l'80% facile
in mezzo secondo, non essere bravo.

---

## 3. Componenti

| Ruolo | Scelta | Note |
|---|---|---|
| Audio + AEC + barge-in | **quello che c'è** (`browser-audio.mjs`) | nessun lavoro nuovo |
| Voce (TTS) | **Piper** (ONNX, CPU) | ~60 MB per voce, streaming, <0,2 s, portabile |
| Ascolto (STT) | **whisper.cpp** | già installato, `base` per la parola chiave, `small` per le frasi |
| Cattura enunciato / VAD | **quello che c'è** (`wake.mjs`) | pre-roll + silenzio, già scritto e testato |
| Cervello della sessione | **llama.cpp (`llama-server`)** | modello istruito piccolo, vedi §5 |
| Guardiano decisioni | **quello che c'è** (`policy.mjs`) | più importante che col cloud, vedi §6 |

Solo voce **italiana** per ora. Il multilingua è un problema di prodotto, non di prototipo —
whisper riconosce la lingua da solo, ma Piper vuole una voce per lingua.

Runtime: `llama.cpp` scelto anche perché va bene su CPU modeste (verificato dall'utente su
macchine vecchie), e su Mac usa Metal.

---

## 4. Il flusso, per stati

**S0 — Attesa.** Claude chiama `talk_to_user`. Beep, poi ascolto della parola chiave con
whisper `base`. Nessun modello in memoria. Invariato rispetto a oggi.

**S1 — Apertura.** Piper pronuncia `spoken`, la frase scritta da Claude. **Il modello non è
coinvolto**: si mantengono i due decimi di secondo e la frase esatta. Se il modello componesse
anche l'apertura si tornerebbe ai nove secondi di preamboli già eliminati. Il microfono resta
aperto; parlare sopra taglia la riproduzione.

**S2 — Ascolto.** Cattura dell'enunciato (pre-roll + silenzio, codice esistente), poi whisper
`small` lo trascrive.

**S3 — Il modello decide cosa fare.** Riceve: il testo integrale di Claude, le opzioni
numerate, la storia dei turni di questa chiamata, e la trascrizione appena arrivata. Produce
**solo** una di queste due azioni, in JSON vincolato da grammatica:

```
{"action":"speak","text":"..."}                      → Piper lo pronuncia, si torna in S2
{"action":"decide","kind":"choice","optionIndex":2}  → fine chiamata
{"action":"decide","kind":"message","value":"..."}   → fine chiamata, testo verbatim a Claude
{"action":"decide","kind":"end"}                     → fine chiamata
```

Una domanda non chiude la chiamata: il modello risponde e si continua.

**S4 — Chiusura.** Decisione a Claude, beep discendente, ricevuta nella pagina (già
implementata), modello scaricato.

### Due dettagli senza i quali non funziona

- **Grammatica GBNF.** llama.cpp può vincolare l'output a una grammatica: il modello *non
  può* produrre un formato diverso da quello sopra. È ciò che rende un modello da 2 miliardi
  di parametri utilizzabile come controllore invece che come chiacchierone.
- **Cache del contesto.** Con `llama-server` la KV cache sopravvive tra i turni della stessa
  chiamata: il primo turno paga la lettura del testo integrale (un paio di secondi), i
  successivi elaborano solo la frase nuova. Senza, il modello rileggerebbe tutto a ogni turno
  e sarebbe inusabile.

### Memoria della conversazione

Dentro la chiamata **sì** — senza storia, una seconda domanda collegata alla prima non si
capisce. Tra una chiamata e l'altra **no**: contesto fresco ogni volta. Questo è deliberato e
risponde a una preoccupazione esplicita: niente deve accumularsi né nel contesto di Claude
Code né tra le sessioni vocali. La storia interna va tagliata agli ultimi N turni perché una
chiamata lunga non gonfi il contesto.

---

## 5. Livelli, scelti dalla macchina

Il bersaglio non è solo questo Mac (M2, 8 GB unificati): il software deve girare anche su
macchine più modeste e con RAM non unificata. Quindi la taglia del modello **non è una
costante, è un livello misurato all'installazione**.

Budget su questa macchina durante una chiamata: macOS ~3 GB, scheda Chrome ~0,7, Node ~0,15,
whisper ~0,5 mentre trascrive, Piper ~0,1. **Restano ~2-2,5 GB per il modello.**

| Livello | Modello | Sa fare | Gira su |
|---|---|---|---|
| 0 | nessuno | regole deterministiche, tutto l'ambiguo a Claude | ovunque, zero installazione |
| 1 | ~0,8B (~0,6 GB) | smistamento sì, spiegazioni no | anche CPU modeste |
| 2 | **~2B (~1,4 GB)** | smistamento + spiegazioni brevi | bersaglio predefinito |
| 3 | ~4B (~2,5 GB) | spiegazioni migliori | macchine con margine |

Famiglia: **Qwen** è il più solido sotto i 3B sul multilingua; i Llama piccoli vanno male in
italiano. I modelli tipo Gemma "E2B/E4B" dichiarano pochi parametri *effettivi* ma i pesi
reali sono molto più grossi: l'occupazione va misurata, non dedotta dal nome. E4B è fuori
budget su questa macchina.

**Criterio di scelta, fissato in anticipo:** si prende il livello più alto che rispetta
entrambe le soglie — memoria residente misurata **≤ 2,5 GB** e risposta **≤ 2 s**. Sopra una
delle due, si scende. `scripts/setup-local.mjs` misura RAM libera e fa un benchmark da dieci
secondi, e sceglie da solo: non chiede la taglia all'utente. Stessa logica già usata da
`setup-wake.mjs`.

Whisper segue la stessa scala (`tiny`/`base`/`small`). Piper è economico ovunque.

**Onestà sui livelli bassi:** a livello 0 e 1 puoi decidere ma non ragionare col vocale. La
promessa "spiegami il punto sei" vale dal livello 2 in su, e la specifica non deve far finta
del contrario.

---

## 6. Guasti e degradi

Nessun guasto rompe la chiamata: degradano tutti verso "se ne occupa Claude", che è il
comportamento di oggi.

| Guasto | Cosa succede |
|---|---|
| Modello non installato | livello 0: regole deterministiche, il resto a Claude |
| Modello non sa rispondere | "questo lo chiedo a Claude" → `kind:"message"` |
| Modello oltre il tempo massimo (4 s) | stesso fallback |
| Modello produce JSON non valido | impossibile per costruzione (grammatica); se accade, fallback |
| Whisper capisce male | visibile nella ricevuta; correggi parlando → `message` → lo sistema Claude |
| Nessuno parla entro il timeout | `kind:"end"`, nessun costo |
| Rumore di fondo | scartato dal riconoscimento della parola chiave (già così) |

**`policy.mjs` diventa più importante, non meno.** Un modello piccolo inventa: in una prova
di oggi il modello di sistema Apple ha trasformato "restano *da decidere* due cose" in "è
stato deciso X e Y". Il guardiano esistente — la decisione muore se non hai parlato
abbastanza, se la trascrizione non è nella lingua attesa, e il numero dell'opzione vince sul
testo — è la rete sotto il trapezio e va mantenuto identico.

Le regole deterministiche del vecchio progetto (ordinali, parole di chiusura) **non
spariscono**: diventano il paracadute del livello 0. La via "manda a Claude" non ha bisogno di
sapere che lingua parli, quindi il problema dell'italiano cablato riguarda solo la corsia
veloce, mai la rete di sicurezza.

---

## 7. Numeri

Misurati oggi su questa macchina:

- whisper.cpp `base`, mezzo secondo di audio: **285 ms** a caldo (il primo avvio dopo il
  download è ~10 s, è macOS che verifica i binari, non calcolo).
- Modello di sistema Apple (FoundationModels, ~3B), domande ancorate a un documento:
  **616-1552 ms** a caldo, 4,2 s a freddo. Italiano buono. Una risposta su quattro sbagliata.
  I filtri Apple hanno rifiutato una domanda su git rebase come "contenuto non sicuro".

Stimati:

| | Oggi (cloud) | Locale |
|---|---|---|
| Prima parola | ~1,9 s | ~0,2 s |
| Da risposta a decisione | ~1,3 s | ~1,2 s |
| Approfondimento | ~1,5 s | ~3-4 s |

Le prime due righe migliorano o pareggiano. **La terza peggiora**, e su CPU senza GPU
peggiora di più: llama.cpp su CPU a 4 core fa 10-20 token/s su un 2B, quindi due frasi sono
2-4 secondi. Poiché nel progetto il modello sta sul percorso critico di *ogni* turno, quel
costo si paga sempre, non solo sulle domande.

---

## 8. Perché non un modello speech-to-speech

Valutati e scartati: Moshi, SALM-Duplex, CT-Duplex, MichiAI, MiniMind-O, Mini-Omni,
MiniCPM-o. Due ragioni, entrambe decisive:

1. **Vendono il barge-in, che abbiamo già** per un'altra strada (AEC del browser + VAD),
   verificato dal vivo. Il loro vantaggio principale, per noi, vale zero.
2. **L'hardware non c'è.** Sono stack PyTorch/NeMo su CUDA; le misure pubblicate sono su
   RTX 4090 o L40. Qui ci sono 8 GB unificati e nessuna NVIDIA. Moshi è escluso dagli autori
   stessi sotto i 12 GB; MiniCPM-o vuole 24 GB su Apple. MiniMind-O è cinese/inglese.

Nota: questi riferimenti vengono da una ricerca dell'utente e **non sono stati verificati** da
questa sessione (rete limitata a pochi host). Le uniche misure verificate sono quelle del §7.

---

## 9. Da verificare prima di scrivere codice

Due incognite, entrambe risolvibili in un pomeriggio:

1. **Come suona Piper in italiano.** È l'unico rischio che può affondare il progetto:
   l'utente ha già bocciato una voce italiana in passato (è il motivo per cui era stato
   provato ElevenLabs). Va ascoltata prima di progettare qualsiasi cosa attorno.
2. **Quanto è decente un 2B a spiegare, in italiano, restando ancorato al documento.** Lo
   stesso test già fatto col modello Apple (§7), ripetuto su Qwen 2B via llama.cpp, con le
   stesse quattro domande e lo stesso documento.

Solo dopo: piano di implementazione.

---

## 10. Fuori perimetro

- Multilingua (voce inglese, scelta automatica della voce).
- Sostituire il motore cloud: `VOICE_ENGINE=local` si affianca, non rimpiazza.
- Toccare `talk_to_user`, `policy.mjs`, l'audio del browser, la parola chiave, la ricevuta.
- Un modello locale che *decida* al posto di Claude. Il modello conduce la conversazione;
  decidere resta di chi parla, e interpretare resta di Claude.
