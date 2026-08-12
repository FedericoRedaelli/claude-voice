# Split-pipeline voice engine on OpenRouter

Testo pronto per la descrizione della pull request, da usare quando il remote esiste.

---

Replaces three overlapping engines (OpenAI Realtime, ElevenLabs, local whisper.cpp + Piper)
with one turn-based flow behind four swappable interfaces, all running on OpenRouter with a
single key.

- `AudioIO` — the browser page: button, microphone, speaker, echo cancellation
- `Tts` — MAI-Voice-2-Flash, reading Claude's line verbatim
- `Stt` — Whisper Large V3 Turbo
- `Brain` — GPT-OSS-20B, routing over Claude's full message

The trigger is the button and nothing else: no wake word, no always-on level meter, no local
engine kept warm. Nothing is paid for until the user clicks.

## Measured, not assumed (spec §9)

| Stage | Latency |
| --- | --- |
| TTS | 1.3–1.5 s per line (2.1 s for a 7.5 s utterance) |
| STT | 0.26–0.75 s |
| Brain | 0.2–0.5 s with `provider.sort=throughput` |
| Two-turn call, end to end | **4.0 s** of model time (26.6 s before the provider was pinned) |

Three findings that only a real call could produce:

1. **`response_format: "pcm"` really is PCM16 mono @ 24 kHz.** Verified rather than believed:
   sample autocorrelation falls off monotonically at lag 1/2/4 (so mono 16-bit, not stereo and
   not float32), the pitch peak of a voiced frame sits at 122 samples — 197 Hz at 24 kHz — and
   the same endpoint's mp3 reports `1 ch, 24000 Hz`. Every duration in the project inherits
   that number.
2. **OpenRouter's provider choice dominates perceived latency.** The same model ran 0.3 s on
   the fastest provider, 3–6 s typically, and once 20.6 s. `provider: { sort: "throughput" }`
   is now the default, and `VOICE_BRAIN_SORT=""` hands the choice back.
3. **GPT-OSS answers on two channels and the final one is often empty.** At `max_tokens: 300`
   it spent the whole budget thinking; raising it to 800 with low reasoning effort did not fix
   the problem, because the cause was not truncation — `finish_reason` was `stop` and the
   reasoning channel plainly held the answer ("choose option 1") while the content came back
   as `""` 4 times in 10. `response_format: {type: "json_object"}` took that to 0 in 12 at the
   same latency. `parseRouted` returning `kind:"empty"` covers the remainder, because a blank
   content was otherwise forwarded to Claude as a blank instruction and called a decision. It
   fired once during the live call, which is how the rate was noticed at all.
4. **Advertised throughput is the wrong number to choose a provider on.** Amazon Bedrock
   advertises 295 TPS against Groq's 160 and costs half as much per output token, but answered
   in 499 ms median against Groq's 264 ms: a thirty-token JSON object is prefill and queueing,
   not generation. Bedrock also cannot serve `response_format` — OpenRouter answers "No
   endpoints found" rather than ignoring it — so pinning it costs 4 empty answers in 12, and
   an empty answer costs a whole extra turn. `VOICE_BRAIN_PROVIDER` and `VOICE_BRAIN_JSON`
   make the choice a variable rather than a code change.

The accent is the one open question left, and it needs an ear rather than a clock:
MAI-Voice-2-Flash has four voices and none is Italian, so Harper reads Italian correctly with an
English accent. Three native-Italian models are reachable with the same key and the same
interface, one line in `.env`.

## Two deliberate departures from the plan

**The recorder counts trailing silence in audio time, not wall clock.** The chunks cross a
websocket and arrive in bursts, so `Date.now()` measures the network rather than the pause. The
plan's own test could not pass against a wall clock for exactly that reason. The only wall-clock
deadline left is the one case audio time cannot see: a microphone that has stopped delivering
anything at all.

**`policy.mjs` keeps two checks the plan would have deleted with the engine they lived in.**
`createTurnState` was half-duplex machinery and is gone, but a transcript in the wrong alphabet
is still treated as silence rather than routed, and a choice is still refused when the transcript
names one option and the brain names another. That second one is the failure this project
started from, and it happened to be sitting inside the class being removed.

## Verification

- `npm test` — 61 tests across 9 files, none of them touches the network
- `npm run smoke:mcp` — green, and green again with `VOICE_MODE=text` (no key, no browser)
- End to end through all three real models with a scripted sound card: question → clarification
  → answer → validated choice
- The websocket protocol (arm, button, play/drain, record, receipt) driven headlessly by a
  stand-in for the page

One live call with a real microphone, start to finish: question, spoken clarification, spoken
answer, and `{"kind":"choice","value":"Apri la pull request"}` back to Claude. Per stage, with
the microphone in the loop: TTS 1.2-2.3 s, STT 0.31-0.34 s, brain 0.29-0.43 s.

Spec: `docs/superpowers/specs/2026-08-12-pipeline-openrouter-design.md`
Plan: `docs/superpowers/plans/2026-08-12-pipeline-openrouter.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
