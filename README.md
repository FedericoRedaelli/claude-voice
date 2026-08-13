# claude-voice

**Talk to Claude Code.** When Claude finishes something and would normally stop and wait, it
calls you instead: a browser tab beeps, a short line is read out loud, you press one button and
answer with your voice. Your answer goes back as the option you picked, or as a new instruction
in your own words, and Claude carries on.

Nothing runs until you press that button. No wake word, no microphone left open, no local model
kept warm — and a call you never answer costs nothing.

```
Claude ──▶ talk_to_user ──▶ 🔊 "Tests pass. Open the PR, or run more tests?"
                                     🎤 "open it, but squash the commits first"
Claude ◀── {"kind":"message","value":"open it, but squash the commits first"}
```

---

## Install

You need [Node 20+](https://nodejs.org) and an [OpenRouter key](https://openrouter.ai/keys).
One key covers all three models: speech, transcription and reasoning.

In Claude Code:

```
/plugin marketplace add FedericoRedaelli/claude-voice
/plugin install claude-voice@claude-voice
/voice-setup
```

`/voice-setup` checks the install, installs the three dependencies on first run, asks for your
OpenRouter key, validates it against OpenRouter before saving it, and writes it to the plugin's
own `.env` with mode `600`. Restart Claude Code and the loop is live.

`/voice-doctor` tells you what is wrong if it isn't.

### Or: hand it to your coding agent

Paste this into any Claude Code session and let it do the install:

> Install the claude-voice plugin from https://github.com/FedericoRedaelli/claude-voice — it
> gives me a voice loop where your final answer is read aloud and I reply by speaking. Run
> `/plugin marketplace add FedericoRedaelli/claude-voice`, then
> `/plugin install claude-voice@claude-voice`, then `/voice-setup`, and walk me through
> whatever it asks for. My machine is `<desktop | headless, I connect over SSH>`.

### Headless machines and SSH

The browser tab is the sound card — microphone, speaker and echo cancellation all live in it —
so it has to run where your ears are. That does not have to be where Claude Code runs.

The bridge listens on loopback, which is exactly what an SSH tunnel needs. From your own
machine:

```bash
ssh -L 8787:127.0.0.1:8787 <user>@<host>
```

then open the URL that `/voice-doctor` prints (or `npm run url` in the plugin directory) in
your local browser. On a machine with no display nothing tries to open a browser for you: the
URL comes back to Claude in the terminal instead, where you can actually see it.

### Teaching Claude the two payloads

The `Stop` hook already nudges Claude to call the tool, and the nudge carries the contract. If
you want it stated up front in a project, add this to your `CLAUDE.md`:

> Write your answer as normal text first, then call `talk_to_user` with `message` = that full
> text verbatim (it is the voice agent's only knowledge — a summary makes follow-up questions
> impossible), `options` = the choices you offered, and `spoken` = one or two short sentences
> to be read aloud word for word, naming the options out loud and numbered.

---

## Why it is built this way

**Two payloads, not one.** `spoken` is a line Claude wrote for the ear, read out **word for
word** — no model rewrites it, so it costs nothing and never drifts from what Claude meant.
`message` is Claude's full text; it is never spoken, and it is the entire knowledge of the
agent on the other end. That is what lets you interrupt with "wait, explain point six" and get
a real answer instead of "I don't know".

**A choice needs evidence, not just the absence of a contradiction.** An option only reaches
Claude if you named its position or repeated its words. Name a different one than the model
reported and neither wins — the call reads the disagreement back and asks. Name none at all and
the model's pick is dropped entirely: Claude gets your sentence instead, and decides itself.
This project started from "the first one" executed as the third, and grew the second rule the
day "let's skip that for now, do the rest" was reported as picking the thing being skipped.

**Asking for detail is not a decision.** The routing model's first job is explaining Claude's
full text out loud — you are listening, not reading it. It only hands the turn back to Claude
when you decide something, ask for work, or ask something the text genuinely does not answer.

**Nothing is billed for a call you don't take.** The button is the only trigger. Before you
press it there is no microphone, no transcription and no completion — only a soft pulse every
few seconds saying something is waiting. Ignore it for three minutes and the call closes with
`{"kind":"end"}`; Claude stops, and you pick it up at the keyboard whenever you get back.

**Every stage is replaceable.** Four slots, each a name in `src/modules.mjs` resolved to a lazy
import, all exchanging PCM16 mono at 24 kHz so nothing is ever resampled:

| Stage | What it does | Today |
| --- | --- | --- |
| `AudioIO` | button, microphone, speaker, echo cancellation | a browser tab on localhost |
| `Tts` | reads Claude's line, verbatim | `microsoft/mai-voice-2-flash` |
| `Stt` | turns your answer into words | `openai/whisper-large-v3-turbo` |
| `Brain` | decides what your answer meant | `openai/gpt-oss-20b` |

```
Tts    speak(text) -> Buffer                          PCM16 mono 24 kHz
Stt    transcribe(pcm) -> string
Brain  route({message, options, turns}) -> {kind: "speak" | "decide" | "empty", ...}
Audio  arm, waitForButton, play, record, report, close
```

A local Whisper is one entry in the registry and `VOICE_STT=local` — the modules never import
each other.

---

## The call, in five states

`src/call.mjs` is the only file that knows the order:

```
S0 armed       the page shows the question, the button waits. Nothing is paid for
S1 opening     the TTS reads Claude's line VERBATIM. No model rewrites it
S2 listen      one utterance, ended by silence
S3 transcribe  Whisper turns it into words
S4 route       the brain answers a question (back to S1) or reports a decision (S5)
S5 close       policy validates it, the page shows a receipt, Claude gets JSON
```

Claude gets back exactly one of:

```json
{"kind": "choice",  "value": "<one of the options you offered>"}
{"kind": "message", "value": "<your own words, as a new instruction>"}
{"kind": "end"}
```

**Text fallback.** `VOICE_MODE=text` runs the same loop on the terminal — no key, no browser,
no audio. The voice path also falls back to it by itself when the key is missing, the tab never
opens or a provider is down: the voice is optional, the decision is not.

---

## Settings

Every knob lives in `src/config.mjs` with a working default; `.env` in the plugin directory
overrides them. The ones worth knowing:

| Variable | Default | What it does |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | the only key |
| `VOICE_MODE` | `voice` | `text` for the terminal loop |
| `VOICE_LANG` | `English` | the language spoken, and the transcriber's hint |
| `VOICE_RETRY_LINE` / `VOICE_CONFIRM_LINE` | English | the only two lines no model writes — set them when you change `VOICE_LANG` |
| `VOICE_TTS_MODEL` / `VOICE_TTS_VOICE` | MAI-Voice-2-Flash / Harper | see the note below |
| `VOICE_BRAIN_SORT` | `throughput` | how OpenRouter picks a provider for the brain |
| `VOICE_BRAIN_PROVIDER` | — | pin named providers instead of sorting |
| `VOICE_MAX_TURNS` | `12` | exchanges before the call closes itself |
| `VOICE_WAIT_MS` | `180000` | how long the button stays armed |
| `VOICE_WAIT_TICK_MS` | `5000` | how often it pulses while waiting; `0` for one cue |
| `VOICE_RECORD_SILENCE_MS` | `1300` | trailing silence that ends your turn |
| `VOICE_SPEECH_LEVEL` / `VOICE_HOLD_LEVEL` | `3` / `1.5` | RMS % to start, and to keep, a turn |
| `VOICE_BARGE_IN` | `0` | let your voice cut the reply short — see below |
| `VOICE_BROWSER_PORT` | `8787` | the bridge's loopback port |
| `VOICE_BROWSER_OPEN` | auto | `0` never opens a browser, `1` always tries |
| `VOICE_DEV` | `0` | run each call in a fresh process, for editing the code |
| `VOICE_DISABLE` | `0` | turn the `Stop` nudge off |

**Provider choice is measured, not guessed.** Left to itself OpenRouter spreads `gpt-oss-20b`
across providers that differ by more than an order of magnitude: 0.3 s on the fastest, 3–6 s
typical, once 20.6 s. Advertised throughput is the wrong number to sort on for a thirty-token
answer — Amazon Bedrock at 295 TPS answered in 499 ms median, Groq at 160 TPS in 264 ms, because
the time is prefill and queueing, not generation.

**About the accent.** MAI-Voice-2-Flash ships four voices and none is Italian (every `it-IT-*`
name is a 502). The model is multilingual, so Harper reads Italian correctly but with an English
accent. `VOICE_TTS_MODEL` points at a model with a native voice —
`minimax/speech-2.8-turbo`, `qwen/qwen-audio-3.0-tts-flash`,
`google/gemini-3.1-flash-tts-preview` — same key, same interface, one line in `.env`.

---

## Troubleshooting

**No tab appears.** Get the URL from `/voice-doctor` and open it by hand. On a headless machine
that is expected — forward the port first (see above). If the port is taken by an older server,
move it with `VOICE_BROWSER_PORT`.

**The tab is open but the button does nothing.** **Parla** is armed by the call, not by the tab.
It lights up when Claude is actually waiting for you.

**It cuts its own sentence short.** That is barge-in, off by default for exactly this reason:
with the microphone open during playback, an echo canceller that does not fully subtract the
page's own audio makes the voice interrupt itself. `VOICE_BARGE_IN=1` if your setup handles it —
headphones always do.

**Claude never calls the tool.** The nudge only fires when the loop can actually run: no key, no
nudge. Run `/voice-doctor`.

---

## Working on it

```bash
npm test           # 79 tests, none of them touches the network
npm run smoke:mcp  # the MCP server boots and exposes the tool
npm run try        # run a whole call by hand
```

Every module takes its `fetch` as a parameter and the recorder takes its microphone the same
way, so the whole pipeline — utterance detection included — is tested against fakes rather than
by talking at it.

ESM modules are evaluated once per process and the MCP server is long-lived, so a code change is
invisible until Claude Code restarts. `VOICE_DEV=1` runs each call in a fresh child process
instead; a change lands on the next call, at the cost of a node startup and a tab reconnection.

The design that this was built from is in [`docs/design.md`](docs/design.md).

## License

MIT
