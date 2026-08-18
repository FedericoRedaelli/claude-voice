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
OpenRouter key, validates it against OpenRouter before saving it, and writes it to
`~/.claude-voice/.env` with mode `600` — outside the plugin, so plugin updates never take it
with them. Restart Claude Code and the loop is live.

`/voice-doctor` tells you what is wrong if it isn't.

### Or: hand it to your coding agent

Paste this into any Claude Code session and let it do the install:

> Install the claude-voice plugin from https://github.com/FedericoRedaelli/claude-voice — it
> gives me a voice loop where your final answer is read aloud and I reply by speaking. Run
> `/plugin marketplace add FedericoRedaelli/claude-voice`, then
> `/plugin install claude-voice@claude-voice`, then `/voice-setup`, and walk me through
> whatever it asks for. My machine is `<desktop | headless, I connect over SSH>`.

### Staying up to date

The plugin is installed from this repository, so an update is a `git pull` on the other end:

```
/voice-update
```

which runs `claude plugin marketplace update claude-voice` and
`claude plugin update claude-voice@claude-voice`, then tells you to restart Claude Code — the
MCP server is long-lived, so new code is not running until it starts again. Dependencies for
the new version install themselves on that first start.

You do not have to remember to run it. A `SessionStart` hook looks for a new version every six
hours and, when it finds one, updates in the background and tells you at the next start that a
restart will pick it up. The check itself is a **detached** process: a session start never waits
on the network, which is why the news arrives one session late rather than as a hang. Turn it
off with `VOICE_AUTO_UPDATE=0`, or change the interval with `VOICE_AUTO_UPDATE_MS`.

Your key is not in the plugin directory. Claude Code installs each version into its own
directory, so a key stored next to the code would be thrown away by every update; `/voice-setup`
writes it to `~/.claude-voice/.env` instead, and every version reads it from there. A checkout
that already has its own `.env` (a clone you work on) keeps using that one — plugin `.env`
first, `~/.claude-voice/.env` second, shell exports ahead of both.

### Remote machines: SSH, VS Code, WSL

The browser tab is the sound card — microphone, speaker and echo cancellation all live in it —
so it has to run where your ears are. That does not have to be where Claude Code runs, and
"this machine has no display" does not mean there is no browser: it usually means the browser is
on the laptop you are typing on.

So the plugin looks for a way to reach *that* browser before giving up:

| Where you are | What opens the tab |
| --- | --- |
| A desktop | `open` / `xdg-open` / `start`, as always |
| **VS Code remote** (Remote-SSH, WSL, dev container) | `code --openExternal` — the editor on **your own machine** opens the tab and forwards the port for it. Nothing to set up |
| WSL without VS Code | `wslview`, or `explorer.exe` — the Windows browser already shares this loopback |
| Anything else | `$BROWSER`, or `VOICE_BROWSER_CMD` if you want to name the command yourself |
| None of the above | the URL is printed and you open it yourself |

Plain SSH with no editor in the middle is the last row, and the bridge listens on loopback
precisely so a tunnel is all it takes:

```bash
ssh -L 8787:127.0.0.1:8787 <user>@<host>
```

then open the URL that `/voice-doctor` prints (or `npm run url` in the plugin directory) in your
local browser.

`/voice-doctor` reports which of these applies as `opensBrowser`. If you are in VS Code and it
still says nothing can open a browser, the `code` CLI is not on `PATH` in that shell — VS Code's
own integrated terminal has it.

### Teaching Claude the two payloads

The `Stop` hook already nudges Claude to call the tool, and the nudge carries the contract. If
you want it stated up front in a project, add this to your `CLAUDE.md`:

> Write your answer as normal text first, then call `talk_to_user` with `message` = that full
> text verbatim (it is the voice agent's only knowledge — a summary makes follow-up questions
> impossible), `options` = the choices you offered, and `spoken` = one or two short sentences
> to be read aloud word for word, naming the options out loud and numbered.

### Telling us what went wrong

Under the receipt at the end of a call there is an optional comment box. Fill it in and the
comment is saved **with the call it is about**: the question, the options, your words as
Whisper transcribed them, the decision, and how long each stage took. That is the difference
between "it picked the wrong option" and a record you can actually fix something from — the
four seconds where everything happens are otherwise invisible once the call is over.

The page says so above the box, because those are your spoken words: they go to a file,
`~/.claude-voice/feedback.jsonl`, on your own machine. **Nothing is uploaded.** Leaving the box
empty writes nothing at all.

`/voice-feedback` shows what is there. `--export <checkout>` copies it into `feedback/` in a
clone of this repository, for a human to read and commit — a deliberate step, taken by someone
who can see what is in it, and the only way anything here reaches the repo.

---

## Why it is built this way

**Two payloads, not one.** `spoken` is a line Claude wrote for the ear, read out **word for
word** — no model rewrites it, so it costs nothing and never drifts from what Claude meant.
`message` is Claude's full text; it is never spoken, and it is the entire knowledge of the
agent on the other end. That is what lets you interrupt with "wait, explain point six" and get
a real answer instead of "I don't know".

**Two independent readings have to agree before Claude acts on an option.** The router decides
what your turn meant; a second call then gets only your words and the options — never the
router's verdict, which it would just agree with — and answers with a position, or with
nothing. Same position, the choice stands. Different ones, neither wins and the call asks.
Nothing heard, the pick is dropped and Claude gets your sentence to read itself. A choice that
cannot be confirmed never gets through: this project started from "the first one" executed as
the third, and grew the second rule the day "let's skip that for now, do the rest" was reported
as picking the very thing being skipped.

That second reading is a model and not a list of words on purpose. It was ordinals in six
languages for a while, which meant it worked for the people whose languages someone had thought
of and silently abstained for everyone else — and it had nothing to say about the refusal that
made it necessary. "Nimm die zweite" is not in any source file here.

**Asking for detail is not a decision.** The routing model's first job is explaining Claude's
full text out loud — you are listening, not reading it. It only hands the turn back to Claude
when you decide something, ask for work, or ask something the text genuinely does not answer.

**Four sounds, and the server decides when.** You are listening to this thing, not watching it,
so the states that matter are audible:

| Cue | When | File |
| --- | --- | --- |
| opening | a question arrives and the button arms | `public/sounds/call-start.mp3` |
| waiting | every few seconds for as long as nobody answers | `public/sounds/attention.wav` |
| working | transcription and the brain, looped | `public/sounds/thinking.mp3` |
| closing | the decision goes back to Claude | `public/sounds/call-end.mp3` |

The working cue exists because that gap — microphone closed, two network calls, one to six
seconds — has nothing in it. From the page it is indistinguishable from a server that has died.

WHEN each one plays is a message from the server, not something the page guesses: the page
cannot see a model running. The files themselves the page holds, so a cue costs one fetch and
not a quarter of a megabyte down the socket every few seconds. Replace any of them by dropping
a file with the same name into `public/sounds/`; `attention.wav` is generated, and
`npm run sounds` rebuilds it from `scripts/make-attention.mjs` if you want to change its shape.
Anything that fails to load falls back to a synthesised tone rather than to silence.
`VOICE_SFX=0` uses the tones on purpose; `VOICE_SFX_VOLUME` and `VOICE_THINK_VOLUME` set the
levels, and `VOICE_THINK_SOUND=0` turns the working loop off.

**It can stop your music, if it is on the same machine.** A browser tab cannot pause Spotify —
no desktop browser gives a page that power — so this runs in Node, and Node is wherever Claude
Code is. On a laptop where you run both, `VOICE_PAUSE_MEDIA=1` pauses what is playing when you
press **Parla** and puts it back when the call closes, including when the call dies rather than
ends. Over Remote-SSH it would pause the music on a server nobody is listening to, so it is
opt-in rather than clever. WSL is the good case: `powershell.exe` reaches the Windows host,
which is where the speakers are.

The press, not the arming, is the trigger: a question can sit armed for three minutes while you
are in another room, and pausing your music for all of it because Claude *might* be asked
something is not a trade anyone would accept. macOS and Linux ask before they touch anything —
what was playing is what gets resumed, and a player you had deliberately stopped stays stopped.
Windows has no way to ask, so there it is the media key and therefore a blind toggle. macOS
will ask you once for permission to control Spotify or Music; refuse it and the feature simply
does nothing. `VOICE_PAUSE_CMD` / `VOICE_RESUME_CMD` take over completely if your player is
something else.

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
| `Brain` | decides what your answer meant | `openai/gpt-oss-120b` |

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
| `VOICE_BROWSER_CMD` | — | the exact command that opens a URL, when no guess fits |
| `VOICE_FEEDBACK_FILE` | `~/.claude-voice/feedback.jsonl` | where the comment box writes |
| `VOICE_THINK_SOUND` | `1` | the loop while transcription and the brain run; `0` for silence |
| `VOICE_THINK_VOLUME` | `0.05` | how loud that loop is (0–0.3) |
| `VOICE_SFX` | `1` | the recorded cues; `0` falls back to synthesised tones |
| `VOICE_SFX_VOLUME` | `0.6` | how loud the opening, waiting and closing cues are (0–1) |
| `VOICE_PAUSE_MEDIA` | `0` | `1` pauses other audio for the length of a call, on the machine Claude Code runs on |
| `VOICE_PAUSE_CMD` / `VOICE_RESUME_CMD` | — | your own commands, instead of the per-platform guess |
| `VOICE_DEV` | `0` | run each call in a fresh process, for editing the code |
| `VOICE_DISABLE` | `0` | turn the `Stop` nudge off |
| `VOICE_AUTO_UPDATE` | `1` | `0` stops the plugin updating itself from GitHub |
| `VOICE_AUTO_UPDATE_MS` | `21600000` | how often it looks for a new version (6 h) |

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

**`talk_to_user` does not exist at all.** That is not the plugin failing to start, it is usually
the client not starting it. Answering "no" once to the prompt that asks whether to trust a
project's MCP servers writes `voice` into `disabledMcpjsonServers` in `~/.claude.json`, and the
server is then never launched — indistinguishable, from the chat, from a crash. **Quit Claude
Code before editing that file**: it rewrites it from memory on exit, so a fix applied in a live
session is undone the moment you restart, which is exactly what makes this one expensive to
diagnose. `/voice-doctor` reports it under `mcp`, and every start of the server appends a line to
`~/.claude-voice/mcp-launch.log` — no line for today means it was never launched.

---

## Working on it

```bash
npm test           # 152 tests, none of them touches the network
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
