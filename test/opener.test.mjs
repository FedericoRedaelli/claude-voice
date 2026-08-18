// Who opens the tab. "No display" is not the same as "no browser": the machine running Claude
// Code is often a remote one driven from a laptop that has the browser AND the ears, and both
// VS Code remote and WSL can reach that browser without the user forwarding anything by hand.

import assert from "node:assert/strict";
import { test } from "node:test";
import { onPath, resolveOpener } from "../src/bridge-url.mjs";

const none = () => false;
const all = () => true;

test("a desktop opens its own browser", () => {
  assert.equal(resolveOpener({ env: {}, platform: "darwin", has: none }).cmd, "open");
  assert.equal(resolveOpener({ env: { DISPLAY: ":0" }, platform: "linux", has: none }).cmd, "xdg-open");
});

test("a bare SSH session has nothing to open with, and says so", () => {
  assert.equal(resolveOpener({ env: {}, platform: "linux", has: all }), null);
});

// The case this was written for: VS Code Remote-SSH. `code --openExternal` hands the URL to the
// editor running on the user's own machine, which opens the local browser and forwards the port
// for it — the `ssh -L` dance, done by the editor.
test("under VS Code remote the tab is opened on the user's own machine", () => {
  const how = resolveOpener({
    env: { VSCODE_IPC_HOOK_CLI: "/run/user/1000/vscode-ipc.sock" },
    platform: "linux",
    has: (c) => c === "code",
  });
  assert.equal(how.cmd, "code");
  assert.deepEqual(how.args, ["--openExternal"]);
  assert.match(how.where, /your own machine/);
});

test("VS Code without its CLI on PATH is not claimed as an opener", () => {
  assert.equal(
    resolveOpener({ env: { VSCODE_IPC_HOOK_CLI: "/x.sock" }, platform: "linux", has: none }),
    null,
    "announcing a tab that never opens is worse than printing the URL",
  );
});

test("WSL opens the Windows browser, which already shares this loopback", () => {
  const wsl = { WSL_DISTRO_NAME: "Ubuntu" };
  assert.equal(resolveOpener({ env: wsl, platform: "linux", has: (c) => c === "wslview" }).cmd, "wslview");
  assert.equal(
    resolveOpener({ env: wsl, platform: "linux", has: (c) => c === "explorer.exe" }).cmd,
    "explorer.exe",
    "wslu is not installed everywhere",
  );
});

test("$BROWSER is honoured, arguments included", () => {
  const how = resolveOpener({ env: { BROWSER: "firefox --new-tab" }, platform: "linux", has: none });
  assert.equal(how.cmd, "firefox");
  assert.deepEqual(how.args, ["--new-tab"]);
});

test("an explicit command wins over every guess, and 0 silences all of them", () => {
  const how = resolveOpener({
    env: { VOICE_BROWSER_CMD: "my-opener --url", DISPLAY: ":0" },
    platform: "linux",
    has: all,
  });
  assert.equal(how.cmd, "my-opener");
  assert.equal(
    resolveOpener({ env: { VOICE_BROWSER_OPEN: "0", DISPLAY: ":0" }, platform: "darwin", has: all }),
    null,
  );
});

test("PATH lookup answers for a real command and for nonsense, without throwing", () => {
  assert.equal(onPath("node"), true);
  assert.equal(onPath("definitely-not-a-command-9f3c"), false);
  assert.equal(onPath("anything", { PATH: "" }), false, "an empty PATH is just a no");
});
