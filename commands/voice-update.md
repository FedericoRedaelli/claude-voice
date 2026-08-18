---
description: Update claude-voice to the latest version published on GitHub
allowed-tools: Bash
---

Update the **claude-voice** plugin on this machine to whatever is on `main` upstream.

1. Refresh the marketplace, then the plugin:

   ```bash
   claude plugin marketplace update claude-voice
   claude plugin update claude-voice@claude-voice --yes
   ```

2. Report what the commands said — in particular the version it moved to, or that it was
   already current.

3. If it did update, tell the user to **restart Claude Code**: the MCP server is long-lived,
   so the new code is not running until it starts again. The new install directory has no
   `node_modules`, but the server installs them itself on its first start — the first call
   after a restart may take a few seconds longer.

4. The OpenRouter key lives in `~/.claude-voice/.env` (or in the plugin's own `.env` if that
   is where it was configured), so an update never asks for it again. If `/voice-doctor`
   after the restart says the key is missing, the key was written into an old install
   directory: run `/voice-setup` once and it will be saved outside the plugin from then on.
