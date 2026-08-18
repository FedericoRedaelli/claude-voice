#!/usr/bin/env node
// The media agent: pauses your music on the machine you are actually sitting at.
//
// WHY IT EXISTS: pausing music has to happen where the speakers are, and over SSH that is not
// where Claude Code runs. A browser tab cannot do it either — no desktop browser lets a page
// touch another application. So something small has to run on your own machine, and this is it.
//
// It needs no new plumbing. The bridge port is ALREADY forwarded to your machine — that is how
// the voice page reaches the server at all — so the agent dials the same address the page uses
// and waits to be told two things: pause, and resume.
//
//   node scripts/media-agent.mjs "http://127.0.0.1:8787/?t=<token>"
//
// Paste the URL that /voice-doctor prints, in a terminal on the machine with the browser. Leave
// it running. It reconnects by itself, and it exits with whatever it was told to resume put
// back — a laptop left silent because an agent was killed mid-call would be a bad trade for a
// convenience.
//
// WHAT IT CAN BE ASKED TO DO: pause, and resume. That is the entire vocabulary. The commands
// live here, in a file you can read, rather than in something the server sends — a remote that
// can name a shell command is a remote that can run one.

import WebSocket from "ws";
import { pauseMedia, resolveMedia } from "../src/media.mjs";

const raw = process.argv[2] || process.env.VOICE_BRIDGE_URL;
if (!raw) {
  process.stderr.write(
    "Usage: node scripts/media-agent.mjs \"http://127.0.0.1:8787/?t=<token>\"\n" +
      "Run it on the machine with the browser. /voice-doctor prints the URL.\n",
  );
  process.exit(1);
}

const page = new URL(raw);
const wsUrl = `${page.protocol === "https:" ? "wss" : "ws"}://${page.host}/media?t=${encodeURIComponent(
  page.searchParams.get("t") ?? "",
)}`;

// The agent decides for itself what it can do, and says so once. Running it on a machine with
// no player it knows about should say that immediately rather than at the first silent no-op.
const how = resolveMedia({ env: { ...process.env, VOICE_PAUSE_MEDIA: "1" } });
if (!how) {
  process.stderr.write(
    "No media player this can control here (Spotify or Music on macOS, playerctl on Linux, " +
      "the media key on Windows). Set VOICE_PAUSE_CMD / VOICE_RESUME_CMD to name your own.\n",
  );
  process.exit(1);
}
process.stdout.write(`claude-voice media agent — ${how.kind}, connecting to ${page.host}\n`);

let resume = () => {};
let socket = null;

function connect() {
  socket = new WebSocket(wsUrl);

  socket.on("open", () => process.stdout.write("attached — your music pauses for the length of a call\n"));

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t !== "media") return;
    if (msg.action === "pause") {
      resume(); // a pause arriving while one is outstanding means the last call never closed
      resume = pauseMedia({ how });
    } else if (msg.action === "resume") {
      resume();
      resume = () => {};
    }
  });

  // Reconnect, but never resume on the way out: a dropped socket is not the end of a call, and
  // starting the music in the middle of one is the failure this whole feature is meant to avoid.
  socket.on("close", () => setTimeout(connect, 2000));
  socket.on("error", () => {});
}

// Whatever happens to this process, the music goes back. Ctrl-C is the normal way to stop it.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    resume();
    process.exit(0);
  });
}

connect();
