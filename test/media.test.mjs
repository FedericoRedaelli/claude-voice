// Pausing what else is playing, for the length of a call. Nothing here runs osascript,
// playerctl or PowerShell: the executor is injected, which is the only way to test a feature
// whose whole job is to talk to software that is not installed on the test machine.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pauseMedia, pausedApps, resolveMedia } from "../src/media.mjs";

const on = { VOICE_PAUSE_MEDIA: "1" };

test("it does nothing at all unless it was asked for", () => {
  assert.equal(resolveMedia({ env: {}, platform: "darwin", has: () => true }), null);
  assert.equal(resolveMedia({ env: { VOICE_PAUSE_MEDIA: "0" }, platform: "darwin" }), null);
});

test("each platform gets the tool it actually has", () => {
  assert.equal(resolveMedia({ env: on, platform: "darwin" }).kind, "mac");
  assert.equal(resolveMedia({ env: on, platform: "linux", has: (c) => c === "playerctl" }).kind, "playerctl");
  assert.equal(resolveMedia({ env: on, platform: "win32", has: () => false }).kind, "windows");
  assert.equal(resolveMedia({ env: on, platform: "linux", has: () => false }), null, "no tool, no pretending");
});

// WSL is the case where the machine running Claude Code is not the machine with the speakers —
// and the one where that is fixable, because powershell.exe reaches the Windows side.
test("WSL controls the Windows host, not the Linux side", () => {
  const how = resolveMedia({
    env: { ...on, WSL_DISTRO_NAME: "Ubuntu" },
    platform: "linux",
    has: (c) => c === "powershell.exe" || c === "playerctl",
  });
  assert.equal(how.kind, "windows", "playerctl is present and still not the right answer here");
});

test("an explicit command beats every guess", () => {
  const how = resolveMedia({ env: { ...on, VOICE_PAUSE_CMD: "mpc pause", VOICE_RESUME_CMD: "mpc play" }, platform: "darwin" });
  assert.equal(how.kind, "custom");
  assert.equal(how.resumeCmd, "mpc play");
});

// The whole point of asking before pausing: at the end of the call we must put back what was
// playing, and nothing else. An unconditional "play" starts music the user had stopped.
test("nothing playing means nothing to resume", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(cmd);
    return { stdout: "" }; // no app was playing
  };
  const resume = pauseMedia({ how: { kind: "mac" }, exec });
  resume();
  assert.deepEqual(calls, ["osascript"], "asked once, and never told anything to play");
});

test("what was paused is what gets resumed, by name", () => {
  const scripts = [];
  const exec = (cmd, args) => {
    scripts.push(args[args.length - 1]);
    return { stdout: "Spotify\n" };
  };
  const resume = pauseMedia({ how: { kind: "mac" }, exec });
  resume();
  assert.equal(scripts.length, 2);
  assert.match(scripts[1], /tell application "Spotify" to play/);
});

test("playerctl is asked before it is told", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(" "));
    return { stdout: calls.length === 1 ? "Paused" : "" };
  };
  const resume = pauseMedia({ how: { kind: "playerctl" }, exec });
  resume();
  assert.deepEqual(calls, ["status"], "it was already paused — leave it alone");
});

test("a media player that throws costs the call nothing", () => {
  const resume = pauseMedia({
    how: { kind: "mac" },
    exec: () => {
      throw new Error("osascript: not found");
    },
  });
  assert.equal(typeof resume, "function", "and the resume is still safe to call");
  resume();
});

test("the mac script's output is read as a list of what it paused", () => {
  assert.deepEqual(pausedApps("Spotify\nMusic\n"), ["Spotify", "Music"]);
  assert.deepEqual(pausedApps(""), []);
  assert.deepEqual(pausedApps(undefined), []);
});
