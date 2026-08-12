#!/usr/bin/env node
// The entry point Claude Code launches. It exists only so that the dependency check runs
// BEFORE the server's imports are evaluated: static imports are hoisted, so a server that
// imports the MCP SDK at the top of the file cannot check whether the SDK is installed.

import { ensureDeps } from "../src/bootstrap.mjs";

if (!ensureDeps()) {
  process.stderr.write(
    "[claude-voice] cannot start without its dependencies — see the lines above\n",
  );
  process.exit(1);
}

await import("../src/server.mjs");
