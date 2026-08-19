---
description: Turn the voice loop on for this session (it is off by default)
allowed-tools: Bash
---

Turn the **claude-voice** loop on for this session only.

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" on`

2. Then say, in one or two lines, that the voice loop is on for this session: from now on every
   stopping point is spoken aloud and the user answers by voice, until they run `/voice-off` or
   this session ends. A new session starts off again — this is per-session on purpose.

3. If the command reported it could not write the state, or that there is no session id, say so
   plainly: the loop is still off, and `VOICE_ALWAYS=1` in the environment is the way to keep it
   on without a session switch.

4. Nothing about the voice path itself changed, so if `/voice-doctor` used to complain about the
   key or the tab, it still will. Only the switch moved.

From here on, follow the loop: write your answer in the terminal as normal, then call
`talk_to_user` with `message` (that full text), `options` and `spoken`.
