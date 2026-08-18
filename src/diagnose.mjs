// Why the voice tool is not there.
//
// "MCP failed to connect", or a `talk_to_user` that simply does not exist, has two very
// different causes that look identical from the chat:
//
//   the server crashed          -> it was launched, and died
//   the client disabled it      -> it was never launched at all
//
// The second one cost a full debugging session on a remote machine: the server was rejected
// once (the prompt that asks whether to trust a project's MCP servers), which writes the name
// into `disabledMcpjsonServers` in ~/.claude.json. Clearing that from INSIDE a running session
// does nothing, because the client rewrites the file from memory when it exits — so the fix
// looked like it had failed, and the search moved on to the launch command, which was fine.
//
// This file reads the two facts that tell them apart, and nothing else. It never writes: the
// file it looks at is the client's, and the whole lesson is that it must be edited with the
// client closed.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LAUNCH_LOG } from "./bootstrap.mjs";

export const CLIENT_CONFIG = join(homedir(), ".claude.json");

// Where, if anywhere, this MCP server has been turned off. Projects are keys in the client's
// config; a name in `disabledMcpjsonServers` is a server the client will not start.
export function quarantine(config, name = "voice") {
  const projects = config?.projects ?? {};
  const disabledIn = [];
  const enabledIn = [];
  for (const [path, project] of Object.entries(projects)) {
    if (project?.disabledMcpjsonServers?.includes?.(name)) disabledIn.push(path);
    if (project?.enabledMcpjsonServers?.includes?.(name)) enabledIn.push(path);
  }
  return { disabledIn, enabledIn, disabled: disabledIn.length > 0 };
}

// The last few starts of the server. No line at all means it has never run on this machine —
// which, with the plugin installed, means the client is not launching it.
export function launches(text, limit = 3) {
  return String(text ?? "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-limit)
    .map((line) => {
      const at = line.slice(0, line.indexOf(" "));
      const note = line.slice(line.lastIndexOf(" ") + 1);
      return { at, note, line };
    });
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// The whole diagnosis, for /voice-doctor. Injectable so the tests never read a real home.
export function mcpStatus({
  configPath = CLIENT_CONFIG,
  logPath = LAUNCH_LOG,
  name = "voice",
  readConfig = readJson,
  readLog = (p) => readFileSync(p, "utf8"),
} = {}) {
  const config = readConfig(configPath);
  const q = config ? quarantine(config, name) : { disabledIn: [], enabledIn: [], disabled: false };
  let log = "";
  try {
    log = readLog(logPath);
  } catch {
    /* never started, or no permission to say so */
  }
  const recent = launches(log);
  return {
    launchLog: logPath,
    everLaunched: recent.length > 0,
    lastLaunches: recent,
    disabledByClient: q.disabled,
    disabledInProjects: q.disabledIn,
    clientConfig: configPath,
    // The one thing a user cannot guess and keeps getting wrong.
    hint: q.disabled
      ? "The client has this server disabled. Quit Claude Code FIRST — it rewrites ~/.claude.json " +
        "from memory on exit, so an edit made while it is running is undone — then remove " +
        `"${name}" from disabledMcpjsonServers, and start it again.`
      : recent.length === 0
        ? "The server has never started on this machine: the plugin is installed but the client " +
          "is not launching it. Check /mcp, and that Claude Code was restarted after the install."
        : null,
  };
}
