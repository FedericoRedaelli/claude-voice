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
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Every start of the server, one line, in the user's own directory.
//
// When this server does not come up, Claude Code says "MCP failed to connect" and the stderr
// that would explain why is not somewhere a user can reach. The one diagnosis that cost the
// most was not even a startup failure: the client had the server DISABLED, so it was never
// launched at all — and no amount of reading the code could tell that apart from a crash,
// because both look like a tool that is not there. A log with no line for today answers it in
// one look. It lives outside the plugin because a plugin update replaces the plugin directory.
export const LAUNCH_LOG = join(homedir(), ".claude-voice", "mcp-launch.log");
const LOG_MAX_BYTES = 64 * 1024;

export function noteLaunch(note, file = LAUNCH_LOG) {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Truncate rather than rotate: this is a breadcrumb trail, not an audit log, and a file
    // that grows without bound in someone's home directory is a bug of its own.
    try {
      if (statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, "");
    } catch {
      /* no file yet */
    }
    appendFileSync(
      file,
      `${new Date().toISOString()} pid=${process.pid} node=${process.versions.node} root=${pluginRoot} ${note}\n`,
      { mode: 0o600 },
    );
  } catch {
    // A server that cannot write its own breadcrumb still has to start.
  }
}

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
