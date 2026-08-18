#!/usr/bin/env node
// Print the URL of the voice tab. Useful on a headless machine, where nothing can open a
// browser for you, and after a restart, when you want to check the tab still points at the
// right port. The token is created on first use and then reused, so this URL is stable.

import { browserPort, pageUrl } from "../src/bridge-url.mjs";

const port = browserPort();
process.stdout.write(`${pageUrl()}\n`);
process.stdout.write(
  `\nNo display on this machine? Forward the port from yours, then open the URL there:\n` +
    `  ssh -L ${port}:127.0.0.1:${port} <user>@<host>\n` +
    `\nTo have your OWN music pause during a call, run this on that same machine — the port is\n` +
    `already forwarded, so it needs nothing else:\n` +
    `  node <plugin>/scripts/media-agent.mjs "${pageUrl()}"\n`,
);
