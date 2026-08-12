# claude-voice

A voice loop for Claude Code. At every stopping point Claude writes its answer in the terminal
as usual, then hands two things to a phone call: one short line to be read out loud, and its
full text as the only context the call is allowed to know. You answer by voice, and Claude gets
back either the option you picked or your own words as a new instruction.

Nothing runs until you press a button. No wake word, no microphone left open, no local model
kept warm — and nothing is paid for on a call you never answer.

## How it works

Four stages, in order, each one a module you can replace:

| Stage | What it is | Today |
| --- | --- | --- |
| `AudioIO` | button, microphone, speaker, echo cancellation | a browser tab on localhost |
| `Tts` | reads Claude's line, verbatim | `microsoft/mai-voice-2-flash` |
| `Stt` | turns your answer into words | `openai/whisper-large-v3-turbo` |
| `Brain` | decides what your answer meant | `openai/gpt-oss-20b` |

All three models are on OpenRouter, behind one key. That is why it was chosen: a single
credential covers speech, transcription and reasoning.

The call is five states, in `src/call.mjs`:

```
S0 armed       the page shows the question, the button waits. Nothing is paid for
S1 opening     the TTS reads Claude's line VERBATIM. No model rewrites it
S2 listen      one utterance, ended by silence
S3 transcribe  Whisper turns it into words
S4 route       the brain answers a question (back to S1) or reports a decision (S5)
S5 close       the rules validate it, the page shows a receipt, Claude gets JSON
```

### The two payloads

`talk_to_user` takes `spoken` and `message`, and they are not two versions of the same thing:

- **`spoken`** is one or two sentences Claude wrote for the ear. It is read out **word for
  word** — no model summarizes it, so it costs nothing in tokens and never drifts from what
  Claude meant.
- **`message`** is Claude's full text. It is never spoken. It is the brain's entire knowledge
  of the world, which is what lets you ask "spiegami meglio il punto sei" and get a real
  answer instead of "non lo so".

Both have to arrive. A summary in `message` is what made every follow-up question impossible.

### What Claude is never told

Two independent sources have to agree before Claude acts on an option: what you actually said,
and what the brain decided you meant. When the transcript names one position and the brain
names another, neither wins — the call reads the disagreement back and asks. This is the
failure the project started from ("ho detto la prima e ha fatto la terza").

Likewise a `choice` only survives if it really maps to one of the offered options. "The first
one but keep the second's naming" comes back as a free `message` in your own words, because
Claude acting on option one would be acting on something you didn't say.

## Install

```bash
npm install
cp .env.example .env      # put your OPENROUTER_API_KEY in it
```

Register the MCP server (`.mcp.json` in this repo already does it for this project):

```json
{ "mcpServers": { "voice": { "command": "node", "args": ["src/server.mjs"] } } }
```

A `Stop` hook nudges Claude to call `talk_to_user` at every stopping point, so the loop does
not depend on the model remembering. `VOICE_DISABLE=1` turns the nudge off.

## Using it

1. Claude finishes something and calls `talk_to_user`.
2. A browser tab opens (the first time, press **Attiva audio** and allow the microphone once —
   the tab and its permission survive restarts).
3. The tab shows the question and the numbered options, and you hear a short beep.
4. Press **Parla**. Now, and only now, the microphone comes on and the models are called.
5. Answer. Ask a clarifying question if you want — the call stays open until you decide.
6. The tab shows a receipt of exactly what went back to Claude.

Say nothing for 30 seconds and the call closes with `{"kind":"end"}`: Claude stops, you pick it
up at the keyboard whenever you get back. Pressing Esc in Claude Code does the same, at once.

Try a whole call by hand:

```bash
npm run try
```

## Swapping a module

Each slot is a name in `src/modules.mjs`, resolved to a lazy import. A local Whisper would be:

```js
stt: {
  openrouter: () => import("./stt/openrouter.mjs").then((m) => m.createStt),
  local: () => import("./stt/local.mjs").then((m) => m.createStt),
}
```

and then `VOICE_STT=local`. Nothing else changes: the modules never import each other, they
only talk to the orchestrator, and they only exchange PCM16 mono at 24 kHz — the rate MAI-Voice-2
emits and the page's AudioWorklet runs at, so the audio is never resampled anywhere in the chain.

The interfaces are one method each, except audio:

```
Tts    speak(text)  -> Buffer          PCM16 mono 24 kHz
Stt    transcribe(pcm) -> string
Brain  route({message, options, turns}) -> {kind:"speak"|"decide"|"empty", ...}
Audio  arm, waitForButton, play, record, report, close
```

## Cost

Nothing is spent until you press the button. After that, one turn is one TTS call over a short
line, one transcription of a few seconds of audio, and one small-model completion. A call
nobody answers costs zero.

`VOICE_MAX_TURNS` (8) closes a conversation that never lands: a runaway conversation is a
runaway bill.

## Text fallback

`VOICE_MODE=text` runs the same loop on the terminal — no key, no browser, no audio. The voice
path also falls back to it by itself if the key is missing, the tab never opens or a provider is
down: the voice is optional, the decision is not.

## Settings

Everything lives in `src/config.mjs`, and every knob has a working default. The ones worth
knowing:

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | the only key |
| `VOICE_MODE` | `voice` | `text` for the terminal loop |
| `VOICE_LANG` | `English` | the language spoken, and the transcriber's hint |
| `VOICE_TTS_MODEL` / `VOICE_TTS_VOICE` | MAI-Voice-2-Flash / Harper | see the note below |
| `VOICE_BRAIN_SORT` | `throughput` | how OpenRouter picks a provider for the brain |
| `VOICE_BRAIN_PROVIDER` | — | pin named providers instead of sorting |
| `VOICE_BRAIN_JSON` | `1` | ask for a JSON object; `0` only for providers that can't |
| `VOICE_MAX_TURNS` | `8` | exchanges before the call closes itself |
| `VOICE_WAIT_MS` | `30000` | how long the button stays armed |
| `VOICE_RECORD_SILENCE_MS` | `1300` | trailing silence that ends your turn |
| `VOICE_SPEECH_LEVEL` | `3` | RMS % that counts as somebody starting to talk |
| `VOICE_HOLD_LEVEL` | `1.5` | RMS % that counts as somebody still talking |
| `VOICE_BARGE_IN_LEVEL` | `12` | RMS % that counts as interrupting the voice |
| `VOICE_RECORD_ONSET_MS` | `8000` | give up on an answer that never starts |
| `VOICE_BROWSER_PORT` | `8787` | the bridge's localhost port |

**About the accent.** MAI-Voice-2-Flash ships four voices and none of them is Italian (every
`it-IT-*` name is a 502). The model is multilingual, so Harper reads Italian correctly but with
an English accent. `VOICE_TTS_MODEL` points at a model with a native Italian voice —
`minimax/speech-2.8-turbo`, `qwen/qwen-audio-3.0-tts-flash` or
`google/gemini-3.1-flash-tts-preview` — same key, same interface, one line in `.env`.

## Troubleshooting

**No tab opens.** The bridge prints its URL on stderr; open it by hand. `VOICE_BROWSER_OPEN=0`
stops it trying. If the port is taken by an older server, `VOICE_BROWSER_PORT` moves it.

**The tab is there but nothing happens.** The **Parla** button is armed by the call, not by the
tab: it lights up when Claude is actually waiting for you.

**It hears itself.** It shouldn't — that is what the browser is for. If it does, the tab lost
its echo canceller: reload it and allow the microphone again.

**"OPENROUTER_API_KEY is not set".** Put it in `.env`, or run with `VOICE_MODE=text`.

## Tests

```bash
npm test          # 65 tests, none of them touches the network
npm run smoke:mcp # the MCP server boots and exposes the tool
```

Every module takes its `fetch` as a parameter, so the whole pipeline is tested against fakes.
The recorder takes its microphone the same way, which is why utterance detection is a unit test
rather than something you verify by talking to it.
