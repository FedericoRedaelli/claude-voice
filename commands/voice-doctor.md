---
description: Diagnose claude-voice — what is installed, whether the key works, where the tab is
allowed-tools: Bash
---

Diagnose the **claude-voice** install and report in plain language.

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/setup.mjs" --check`
2. `node "${CLAUDE_PLUGIN_ROOT}/scripts/url.mjs"`

Then say, in a few lines: whether Node is new enough, whether the dependencies are installed,
whether OpenRouter accepts the key (and the credit left, if the check reported it), and the
URL of the tab.

Read `opensBrowser`, not `display`, when you say what will happen with the tab. `display` only
answers whether there is a screen on THIS machine; `opensBrowser` says whether a tab can be
opened at all and where it will appear:

- `opensBrowser` set — say the tab opens by itself, and where (`where`). Under VS Code remote
  that is the user's own machine, and VS Code forwards the port for it: no SSH tunnel needed.
- `opensBrowser` null — nothing here can open a browser. The user opens the URL themselves on
  their own machine, after forwarding the port:
  `ssh -L <browserPort>:127.0.0.1:<browserPort> <user>@<host>`. If they are in VS Code and it
  is still null, the `code` CLI is not on PATH in this shell — VS Code's own terminal has it.

Do not print the key, and do not offer to change any setting unless the user asks.
