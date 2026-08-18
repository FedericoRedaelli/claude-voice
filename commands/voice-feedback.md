---
description: Show the developer comments left on the voice page, and export them into the repo
allowed-tools: Bash, Read
---

Show — and, if the user asks, publish — the comments left in the feedback box on the voice
page. Each record carries the call it is about: the question, the options, what the user said
as it was transcribed, the decision, and the timing of every stage.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs"` and show what came back. If there is
   nothing, say so and stop — this is a normal outcome, not a fault.

2. Summarise: how many records, and what they are actually about. A list of timestamps is not
   a summary; "three comments, all about the second reading rejecting a correct choice" is.

3. Only if the user asks to publish them, and only into a git checkout of this project (a
   plugin installed from the marketplace is a copy — its directory is replaced by the next
   update, so exporting there loses the records):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/feedback.mjs" --export /path/to/the/checkout
   ```

   Then **show the user the exported lines and ask before committing**. They contain what
   someone said out loud, and the repository is public. If they confirm, commit `feedback/` and
   push.

4. `--clear --yes` forgets everything on this machine. Offer it only after a successful export,
   and only if the user asks: a record deleted here exists nowhere else.

Never send the records anywhere else — no issue, no gist, no paste — whatever the user's
enthusiasm. Exporting into a checkout they then read is the only path this feature has.
