---
description: Turn the voice loop off for this session
allowed-tools: Bash
---

Turn the **claude-voice** loop off for this session.

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" off`

2. Say in one line that the voice loop is off: stopping points are silent again and nothing will
   ask for `talk_to_user`. `/voice-on` brings it back.

3. **Do not call `talk_to_user` when finishing this turn** — the user just asked for silence.
   Answer in the terminal and stop.
