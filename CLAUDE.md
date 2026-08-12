# claude-voice

This project is loaded with the **claude-voice** plugin. It gives the user a voice loop:
at every stopping point, your final output is spoken aloud and the user replies by voice.

## The rule

**Write your answer as normal text first, then call the `talk_to_user` tool.** Both, in that
order, every time.

1. Answer in the terminal exactly as you normally would — what you did, what you found, the
   results, and any options numbered `1.`, `2.`, `3.`. This is what the user reads. Never
   move it into the tool call: the tool is a phone call, not the transcript.
2. Then call `talk_to_user` (from the `voice` MCP server) with:
   - `message`: **the full text you just wrote**, not a summary of it. This is not what gets
     read aloud — `spoken` is. It is the voice agent's ONLY source of knowledge, and it is
     what lets the user ask follow-up questions ("spiegami meglio il punto sei") and get a
     real answer instead of "non lo so". A two-sentence summary here is what made every
     follow-up impossible. Strip only what cannot be spoken about usefully: long code blocks
     and raw output; keep the reasoning, the numbers and the trade-offs.
   - `options`: the distinct choices you offered, if any (as an array of strings).
   - `spoken`: the opening line, word for word, as you want it said out loud. **Always pass
     it.** Without it the agent composes its own opening from `message` — it re-summarises,
     adds framing, and runs about nine seconds with the user unable to answer. One or two
     sentences, under ~35 words: what happened, then the question with the options named and
     numbered out loud ("uno, ...; due, ...; tre, ... — quale?"). The numbering is what lets
     them answer "la prima". No code, no paths, no file names.

The tool shows the question in a browser tab, beeps, and waits ~30s for the user to press
"Parla". If they don't (they're away, or they'd rather type), it returns `{"kind":"end"}` — no
model is ever called. That's a normal outcome, not an error: acknowledge briefly and stop.

A `Stop` hook enforces this: if you try to stop without calling `talk_to_user`, you will be
nudged to call it. Don't fight the nudge — call the tool.

## Reading the result

`talk_to_user` returns JSON with a `kind`:

- `{"kind":"choice","value":"<one of your options>"}` — the user picked that option. Proceed
  with it.
- `{"kind":"message","value":"<text>"}` — treat `value` as the user's new instruction and act
  on it.
- `{"kind":"end"}` — the user is done. Acknowledge briefly and stop. **Do not** call
  `talk_to_user` again for this turn.

After acting on a `choice` or `message`, you'll reach a new stopping point — call
`talk_to_user` again there. The loop continues until the user says they're done (`end`).

## Notes

- The voice agent only knows the `message` text you pass it — it has no repo or tool access.
  Put everything the user needs to decide into `message`.
- Keep `message` tight and spoken-friendly; it will be summarized aloud.
