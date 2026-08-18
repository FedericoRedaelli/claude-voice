---
description: Set up claude-voice — check the install, save the OpenRouter key, open the tab
allowed-tools: Bash, Read, Edit
---

Set up the **claude-voice** plugin for this machine. Work through these steps in order and
stop at the first one that cannot be satisfied.

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --check` and read the JSON.

2. If `nodeOk` is false, tell the user their Node is too old (20 or newer is required) and
   stop. If `dependenciesInstalled` is false, run
   `cd "${CLAUDE_PLUGIN_ROOT}" && npm install --omit=dev` and check again.

3. If `key.ok` is already true, say so — the plugin is configured — and skip to step 5.

4. Otherwise the user needs an OpenRouter key. Tell them: one key covers speech,
   transcription and reasoning; they can create one at <https://openrouter.ai/keys>, and it
   starts with `sk-or-v1-`. Ask them to paste it in the chat. When they do, save it WITHOUT
   putting it on a command line — argv is visible to other processes — by piping it on stdin:

   ```bash
   printf %s 'THE_KEY' | node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --key -
   ```

   The script validates the key against OpenRouter before writing anything, and writes it
   with mode 600 to `~/.claude-voice/.env` — outside the plugin, so a plugin update (which
   installs into a new versioned directory) does not take the key with it. A checkout that
   already has its own `.env` keeps using that one instead. If it reports the key is rejected, say exactly
   what it said and ask for another one. Never echo the key back in your reply.

5. Ask which language the voice should speak, and set it if it is not English:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --no-prompt --lang 'Italiano'
   ```

6. Tell the user what happens next:
   - The voice needs a browser tab as its sound card. It opens by itself on a desktop machine;
     the URL is printed by `node "${CLAUDE_PLUGIN_ROOT}/scripts/url.mjs"`.
   - If this machine is headless and they are connected over SSH, they must forward the port
     from their own machine first: `ssh -L 8787:127.0.0.1:8787 <user>@<host>`, then open the
     URL there.
   - They must **restart Claude Code** so the voice server reads the new key.

7. Finally, tell them to say something back to you after the restart so the first call can be
   tested — the tab will ask for microphone permission once.
