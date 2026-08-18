#!/usr/bin/env node
// The entry point Claude Code launches. It exists only so that the dependency check runs
// BEFORE the server's imports are evaluated: static imports are hoisted, so a server that
// imports the MCP SDK at the top of the file cannot check whether the SDK is installed.

import { ensureDeps, noteLaunch } from "../src/bootstrap.mjs";

// First line, before anything can fail. "Was this process ever started?" is the question that
// separates a server that crashes from a server the client has disabled and never launches —
// two very different problems that look identical from the chat, where the tool is simply
// absent either way.
noteLaunch("launched");

if (!ensureDeps()) {
  noteLaunch("exit: dependencies missing");
  process.stderr.write(
    "[claude-voice] cannot start without its dependencies — see the lines above\n",
  );
  process.exit(1);
}

await import("../src/server.mjs");
noteLaunch("serving");
