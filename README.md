# claude-voice (v1)

A voice agent for Claude Code. At every stopping point, Claude hands its final text to a
voice-to-voice agent (OpenAI Realtime) that **summarizes it aloud**, answers your questions
about it, then asks what you want to do — returning either a **choice** (among the options
Claude offered) or a **free message** back to Claude, which then continues.

The voice agent's only knowledge is the text Claude hands it. No tools, no repo access, no
callbacks to Claude for more context. (Escalation / clarification round-trips are out of
scope for v1.)

## How it works

- Claude answers **in the terminal as usual** — full text, results, numbered options — and
  only then hands a short spoken version to the voice tool. The voice layer never replaces
  what you read; it's a phone call about it.
- A **Stop hook** fires at every stop and nudges Claude to call the MCP tool `talk_to_user`,
  so voice is deterministic — not dependent on the model remembering. The nudge is
  fail-open, bounded (won't loop forever), and disabled by `VOICE_DISABLE=1`.
- **Nothing starts talking on its own.** `talk_to_user` beeps and then just listens locally
  (mic level only — no audio leaves the machine, no API session, no cost). The Realtime call
  opens only once you actually start speaking. Say nothing for `VOICE_WAIT_MS` (30s) and it
  returns `{kind:"end"}`: Claude stops, and you pick it up at the keyboard whenever you get
  back. So you can walk away from the desk mid-task without a voice narrating to an empty room.
  The gate is skipped when Claude comes back within `VOICE_FOLLOWUP_MS` (15s) of the last
  call — mid-conversation you shouldn't have to keep saying "yes, I'm here".
- **The agent assumes you can't see the screen.** It says the options out loud rather than
  telling you to pick from the terminal, so the loop works from another room.
- **Esc cancels the call.** Claude Code cancels the tool request, the session goes silent at
  once (no closing beep, no draining), and the tool returns `{kind:"end"}`.
- `talk_to_user(message, options?)` opens a bounded session (voice or text). A short **beep**
  marks the call opening. The agent is a **bridge**: it's seeded with Claude's message as its
  only context, **speaks it first** (one short sentence, conversational), answers your
  questions using only that text, and — as soon as your answer is clear — reports it back to
  Claude via a `submit_decision` tool call, which ends the call with a closing **beep**.
  Result: `{"kind":"choice"|"message"|"end", "value"?:...}`.
- A `choice` is only reported when the user picked one of Claude's options **whole**. Anything
  else — a mix of two options, an option with a condition attached, a different idea entirely —
  is reported as a free `message` in the user's own words. The agent is told this, and
  `normalizeDecision` enforces it regardless, so Claude never acts on an option nobody picked.
- **Half-duplex by default** (works on laptop speakers): the mic is muted while the agent
  talks, so its own voice can't echo back and make it interrupt/repeat itself. For **barge-in**
  (interrupting the agent mid-sentence) use **headphones** and set `VOICE_HALF_DUPLEX=0`.
- Turn-taking and VAD are handled by OpenAI's `@openai/agents` Realtime SDK (`server_vad`).

```
src/server.mjs     MCP server (stdio) — exposes talk_to_user
src/session.mjs    dispatch: voice vs text
src/realtime.mjs   Realtime session + submit_decision tool + audio bridge
src/audio.mjs      mic/speaker via sox  ← machine-specific, verify on your box
src/text.mjs       VOICE_MODE=text fallback (terminal via /dev/tty)
src/config.mjs     env-driven config
hooks/stop-nudge.mjs   the Stop hook
.mcp.json          registers the voice MCP server
CLAUDE.md          steers Claude to use the tool at every stop
```

## Requirements

- Node.js >= 22 (global `fetch`/`WebSocket`, ESM)
- [sox](https://sox.sourceforge.net/) for mic + speaker (voice mode only):
  `brew install sox` / `apt-get install sox`
- An OpenAI API key with Realtime access (voice mode only)

## Install (dev route — recommended for v1)

```bash
cd claude-voice
npm install

# Test the whole loop with zero external deps first:
VOICE_MODE=text claude --plugin-dir ./claude-voice

# For real voice:
export OPENAI_API_KEY=sk-...
# optional: export VOICE_REALTIME_MODEL=gpt-realtime-2.1-mini
# optional: export VOICE_NAME=alloy
# optional: export VOICE_VAD=semantic_vad   # or server_vad
claude --plugin-dir ./claude-voice
```

`--plugin-dir` loads the plugin from this directory, keeping `node_modules` in place. Inside
Claude Code, confirm with `/mcp` (look for the `voice` server / `talk_to_user` tool);
`/reload-plugins` if it isn't there.

> Note: if `npm`'s cache is not writable in your environment, use a local cache:
> `npm install --cache ./.npm-cache`.

## Persisting settings (`.env`)

Instead of exporting variables every session, create a `.env` file in the plugin root (it's
gitignored). Any `KEY=VALUE` there fills in variables you didn't export in the shell, so both
the MCP server and the Stop hook pick them up:

```
OPENAI_API_KEY=sk-...
# VOICE_VAD=server_vad
# VOICE_NAME=alloy
```

Shell exports still win over `.env`. Never commit this file.

## Config (all via env)

| var | default | notes |
|-----|---------|-------|
| `OPENAI_API_KEY` | — | required for voice mode |
| `VOICE_MODE` | `voice` | `voice` \| `text` |
| `VOICE_REALTIME_MODEL` | `gpt-realtime-2.1-mini` | model lineup drifts; override as needed |
| `VOICE_NAME` | `alloy` | fixed voice (e.g. alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar) |
| `VOICE_VAD` | `server_vad` | `server_vad` (predictable) \| `semantic_vad` |
| `VOICE_SILENCE_MS` | `900` | server_vad: trailing silence that ends your turn — lower = snappier, higher = fewer cut-offs |
| `VOICE_VAD_THRESHOLD` | `0.5` | server_vad: how loud audio must be to count as speech (0-1) — raise it in a noisy room, lower it if a quiet voice doesn't register |
| `VOICE_PREFIX_PADDING_MS` | `500` | server_vad: audio kept from before the VAD triggered — too little and the first syllable never reaches the transcriber ("la terza" arrived as "Certa") |
| `VOICE_BARGE_IN_MS` | `350` | full-duplex only: how long someone must keep talking before it counts as interrupting the agent — below it a cough or a key press no longer chops the sentence in half |
| `VOICE_LANG` | `English` | language the agent speaks, whatever you speak; also sets the input-transcription language hint (English/Italian/Spanish/French/German/Portuguese/Dutch/Japanese/Chinese — anything else = auto-detect) |
| `VOICE_TRANSCRIBE_MODEL` | `gpt-4o-transcribe` | model that transcribes your audio (transcript only; the agent hears the audio itself) |
| `VOICE_NOISE` | `near_field` | input noise reduction: `near_field` \| `far_field` \| `off` |
| `VOICE_OUT_DEVICE` | unset | pin the speaker to a named device (sox `-t coreaudio "<name>"`) — needed when output and input are different hardware, e.g. headphones out, laptop mic in |
| `VOICE_IN_DEVICE` | unset | pin the microphone to a named device; run `npm run audio` to list the names macOS reports |
| `VOICE_HALF_DUPLEX` | `1` | `1` mutes the mic while the agent talks (no echo, no barge-in); `0` = full-duplex barge-in (use headphones) |
| `VOICE_MIC_REOPEN_MS` | `600` | half-duplex only: delay before the mic re-opens after playback *finishes* (echo tail) |
| `VOICE_DISABLE` | unset | `1` disables the Stop-hook nudge |
| `VOICE_WAIT_MS` | `30000` | passive gate: how long to beep-and-listen before ending without opening a session; `0` disables the gate (call starts immediately) |
| `VOICE_WAKE_LEVEL` | `3` | mic level (RMS %) that counts as "the user is talking" in that gate |
| `VOICE_WAKE_MS` | `180` | how much speech that gate needs — one short word ("vai") is ~200 ms |
| `VOICE_WAIT_TICK_MS` | `1500` | soft tick while the gate waits, so "Claude is waiting" is audible from the next room; `0` = opening cue only |
| `VOICE_WAIT_TICK_VOLUME` | `0.08` | volume of that tick (0-1) — it repeats for up to half a minute, so it is far quieter than the opening cue |
| `VOICE_CUE_ECHO_MS` | `350` | how long after our own cue the gate ignores the mic, so the beep leaking into the microphone cannot open a call by itself |
| `VOICE_FOLLOWUP_MS` | `15000` | a new question this soon after the last call ended skips the gate entirely (you're still mid-conversation); `0` always gates |
| `VOICE_SPEED` | `1.15` | playback speed of the agent's voice (0.25-1.5) — while it talks your mic is dead, so a faster delivery shortens the window you can't answer in, without cutting sentences the way a token cap would |
| `VOICE_JITTER_MS` | `250` | audio held back before playback starts, per turn — covers a late burst from the stream so the agent does not go silent mid-word and catch up afterwards; costs the same delay before the first word |
| `VOICE_MIN_ANSWER_MS` | `250` | how much speech must be heard before a reported decision is believed — below it the agent is told to ask again instead of guessing |
| `VOICE_TRANSCRIPT_WAIT_MS` | `1500` | how long a reported decision waits for the transcript of your turn before being judged; a transcript that is empty, or in the wrong alphabet for `VOICE_LANG`, is noise and the decision is rejected |
| `VOICE_TURN_BEEP` | `1` | short cue tone when the agent stops and the mic re-opens (half-duplex only); `0` silences it |
| `VOICE_OPENING_GRACE_MS` | `3000` | half-duplex only: mic starts muted this long, covering the gap before the opening turn's audio exists |
| `VOICE_TIMEOUT_MS` | `120000` | session wall-clock safety net; on timeout resolves `{kind:"end"}` |

## Verify

```bash
npm test             # 35 headless tests: turn taking, the submit gate, the gate, Esc
npm run smoke:mcp    # boots the MCP server, checks talk_to_user is listed
npm run smoke:hook   # unit-tests the Stop hook (block/allow/fail-open/bounded-retry)
npm run audio        # lists devices, plays a tone, records 3s — proves BOTH directions
npm run mic          # 3s microphone diagnostic (sox path only, no API)
npm run try          # LIVE rehearsal: real mic + speaker, real session, no MCP/Claude
```

`npm test` runs whole calls against a fake microphone, speaker and Realtime session
(`test/fakes.mjs`): the agent speaks, the room is noisy, the user answers, the model
misbehaves — all in milliseconds, with the real turn-taking and decision code. Every scenario
in `test/session.test.mjs` is a failure seen in an actual call, so a regression there is a
regression you would have heard. The rules themselves (`src/policy.mjs`) are driven off a fake
clock in `test/policy.test.mjs`.

`npm run try` is the fastest way to tell an audio problem from a wiring problem: it calls the
same `runVoiceSession` the plugin does, with a canned Claude message, and prints the decision
that would have gone back to Claude. Override it with
`npm run try -- "your message" "option a" "option b"`.

Then the text-mode loop end-to-end: `VOICE_MODE=text claude --plugin-dir ./claude-voice`,
give Claude a trivial task, and at each stop reply in the terminal (a number to pick an
option, free text for an instruction, or blank/`stop` to end).

## Troubleshooting

- **`/mcp` shows `voice` failed `-32000` / no `voice` at all.** A plugin's `.mcp.json` uses
  the server map **directly at the top level** — *no* `mcpServers` wrapper (that wrapper is
  the project-level format). Correct plugin shape:
  ```json
  { "voice": { "type": "stdio", "command": "...", "args": ["..."] } }
  ```
- **`-32000` = the server process couldn't be spawned.** Claude Code launches MCP servers
  with a restricted `PATH` that excludes Homebrew, so a bare `"command": "node"` fails with
  `ENOENT`. Use an **absolute** node path (`/opt/homebrew/bin/node`) or set `env.PATH`. This
  is macOS/Homebrew-specific — adjust for your install (`which node`).
- **After editing `.mcp.json`, fully restart Claude Code.** `/reload-plugins` does not
  re-spawn MCP servers.
- **The agent repeats itself / says a bit then restarts (voice mode, on speakers).** That's
  a feedback loop: an open mic hears the agent's own voice and interrupts it. The default
  **half-duplex** mode prevents it (mic muted while the agent talks) — just wait for the
  agent to finish, then talk. Only switch to full-duplex (`VOICE_HALF_DUPLEX=0`) with
  **headphones**, where you can then interrupt it.
  Note the mute window follows **playback**, not the arrival of the model's audio: the model
  streams a whole reply in about a second while `sox` plays it for several, so keying the mute
  off the last `audio` event re-opened the mic mid-sentence and the loop came back. If your
  room still echoes enough to retrigger it, raise `VOICE_MIC_REOPEN_MS`.
- **The agent's last words get cut off.** Same cause, other end: we write audio far faster
  than real time, so `sox` is always behind. The session now drains whatever is still queued
  before closing (bounded at 8s). If you're calling `runVoiceSession` yourself, don't
  `process.exit()` the moment it returns.
- **The voice changes (male/female) between sessions.** OpenAI's default voice is `marin`;
  the configured voice (`VOICE_NAME`, default `alloy`) is applied once the session is
  updated, and the agent's opening turn now waits for that, so the voice is stable. Pin a
  different one with `VOICE_NAME`.
- **The Stop hook keeps nudging "call the talk_to_user tool…" when you don't want voice.**
  The nudge now only fires when the voice loop can actually run: in the default `voice` mode
  it requires `OPENAI_API_KEY` (no key ⇒ the hook stays silent), and `VOICE_MODE=text`
  always runs. To turn the nudge off entirely for a session, set `VOICE_DISABLE=1`.

## What's verified

- MCP server registration + handshake, live in Claude Code (`initialize` → `tools/list`).
- Stop-hook nudge → Claude actually calls `talk_to_user` → decision consumed → stops
  (verified end-to-end in a real headless Claude Code run).
- Text mode: choice / free-message / end / no-tty fallback (all branches).
- `src/audio.mjs` PCM16 mono @ 24 kHz format (sox round-trip).
- Realtime path against the live OpenAI API with a real key: auth, model
  `gpt-realtime-2.1-mini`, session config, and the model calling `submit_decision`.
- **Full voice pipeline, through the real `runVoiceSession`**: opening beep → agent speaks →
  a synthesized spoken answer is fed in (mock mic) → server VAD → `submit_decision` → the
  decision returned to Claude. Both branches verified live: `{"kind":"choice","value":"commit"}`
  and `{"kind":"message","value":"…"}`. Run it yourself: `npm run test:voice -- "let's commit it"`
  (`scripts/selftest-voice.mjs` — no real mic/speaker, plays no sound; needs a key + network).

Dev test harnesses: `scripts/selftest-voice.mjs` (full session, mock audio),
`scripts/test-realtime-noaudio.mjs` (text turn), and
`scripts/test-realtime-audiofile.mjs <raw-pcm16-24k-mono>` (audio-in only).

- **Real microphone and speakers**, spoken end to end via `npm run try` (macOS, laptop
  speakers, half-duplex, Italian): the agent speaks, the user answers out loud, and the
  correct decision comes back — no self-interruption loop, no clipped tail.

## Later (v2)

- **Distribution**: bundle the one dependency (`@openai/agents`) with `esbuild` into a single
  file (so a marketplace install needs no `node_modules`), then add
  `.claude-plugin/marketplace.json` for `/plugin marketplace add` + `/plugin install`.
- **Escalation**: let the agent go back to Claude for missing context — slots in by
  extending `submit_decision` with a new kind and letting the tool loop.
