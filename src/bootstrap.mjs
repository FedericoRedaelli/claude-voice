// Make the plugin runnable on a machine that only cloned it.
//
// Claude Code installs a plugin by copying its files. It does not run `npm install`, so the
// three runtime dependencies are simply absent the first time the MCP server starts — and a
// server that fails to start reads to the user as "MCP failed to connect", with no clue why.
// So we check, and if they are missing we install them once, into the plugin's own directory.
//
// This file must have ZERO imports beyond node: builtins, and must not be the thing that
// needs the dependencies it is installing. That is why the real server lives behind a dynamic
// import in bin/voice-mcp.mjs.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const log = (m) => process.stderr.write(`[claude-voice] ${m}\n`);

function required() {
  const pkg = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8"));
  return Object.keys(pkg.dependencies ?? {});
}

export function missingDeps(root = pluginRoot) {
  return required().filter((name) => !existsSync(join(root, "node_modules", name)));
}

// Returns true when the dependencies are present (already, or after installing them).
export function ensureDeps({ root = pluginRoot, run = spawnSync } = {}) {
  const missing = missingDeps(root);
  if (missing.length === 0) return true;

  log(`first run: installing ${missing.join(", ")} into ${root}`);
  // stdio "inherit" would put npm's chatter on stdout, which for an MCP server IS the
  // JSON-RPC transport. Everything npm says goes to stderr instead, where Claude Code logs it.
  const res = run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();

  if (res.error || res.status !== 0) {
    log(`npm install failed (${res.error?.message ?? `exit ${res.status}`})`);
    if (out) log(out.split("\n").slice(-5).join(" | "));
    log(`run it yourself: cd "${root}" && npm install --omit=dev`);
    return false;
  }

  const still = missingDeps(root);
  if (still.length) {
    log(`npm install finished but ${still.join(", ")} is still missing`);
    return false;
  }
  log("dependencies installed");
  return true;
}
