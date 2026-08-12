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

If `display` is false, this machine has no desktop: the tab has to be opened on the user's own
machine through an SSH tunnel — `ssh -L <browserPort>:127.0.0.1:<browserPort> <user>@<host>` —
and that is worth saying explicitly rather than leaving them to guess why no tab appears.

Do not print the key, and do not offer to change any setting unless the user asks.
