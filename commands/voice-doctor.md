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

Read `session` before anything else if the complaint is "nothing is spoken": the loop is OFF in
every session until `/voice-on` switches it on, so `session.on` false means everything is working
and this session simply is not a voice session. Say that, and name `/voice-on`. `session.id` null
means the check ran outside a Claude Code session, so it could not tell either way.

If the user's complaint is that `talk_to_user` is missing, read `mcp` before anything else —
it separates the two causes that look identical from the chat:

- `mcp.disabledByClient` true — the client has the server turned off (it is in
  `disabledMcpjsonServers` for the projects listed). Say `mcp.hint` in full: the edit only
  holds if Claude Code is **quit first**, because it rewrites `~/.claude.json` from memory on
  exit. This is the common one, and editing the plugin's launch command instead is a dead end.
- `mcp.everLaunched` false with nothing disabled — the server has never run here: the plugin is
  installed but not being launched. Check `/mcp` and whether Claude Code was restarted after
  the install.
- `mcp.lastLaunches` showing recent lines — the server does start, so the fault is elsewhere;
  a line that says `launched` with no `serving` after it is a start that died on its imports.

`pausesMedia` answers "would pausing my music work here", which is only ever a question about
WHICH machine: this runs where Claude Code runs.

- `would` null — nothing here can pause anything, or no player was found.
- `would.kind` `windows` on WSL — it reaches the Windows host. If that host is also where the
  browser is (VS Code Remote-WSL, one physical machine) this is the right machine and
  `VOICE_PAUSE_MEDIA=1` works. Say that plainly.
- `would.kind` set while the tab is opened on a DIFFERENT machine (see `opensBrowser`) — it
  would pause the music on this one, which nobody is listening to. Say so instead of
  recommending it.

When the tab opens on a different machine from this one and the user wants their own music
paused during a call, that is what `pausesMedia.agentCommand` is for: they run it on the machine
with the browser, with the tab URL, and leave it running. The bridge port is already forwarded
there, so nothing else has to be set up. Mention it only if the question comes up.

Do not print the key, and do not offer to change any setting unless the user asks.
