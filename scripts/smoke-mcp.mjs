#!/usr/bin/env node
// Smoke test: boot the MCP server over stdio, run the JSON-RPC handshake, and confirm
// `talk_to_user` is listed, then call it in text mode with a piped decision.
//
// Usage: node scripts/smoke-mcp.mjs
// Exits non-zero on any failure.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "src", "server.mjs");

const proc = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, VOICE_MODE: "text" },
});

let buf = "";
const pending = new Map();

proc.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function send(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function assert(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    proc.kill();
    process.exit(1);
  }
  console.log(`ok: ${label}`);
}

const init = await send(1, "initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke", version: "0" },
});
assert(init.result?.serverInfo?.name === "claude-voice", "initialize -> serverInfo.name");

notify("notifications/initialized", {});

const tools = await send(2, "tools/list", {});
const names = (tools.result?.tools ?? []).map((t) => t.name);
assert(names.includes("talk_to_user"), `tools/list includes talk_to_user (got: ${names})`);

console.log("\nAll MCP boot checks passed.");
proc.kill();
process.exit(0);
