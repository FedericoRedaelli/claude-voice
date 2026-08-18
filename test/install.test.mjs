// The install path: what a machine that only cloned this repo depends on. Nothing here talks
// to the network or to npm — the installer is injected.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureDeps, missingDeps, pluginRoot } from "../src/bootstrap.mjs";
import { browserPort, hasDisplay, loadOrCreateToken, pageUrl } from "../src/bridge-url.mjs";
import { envTarget, mergeEnv } from "../scripts/setup.mjs";
import { applyEnvFiles, parseEnvFile, pluginEnvFile, userEnvFile } from "../src/env.mjs";

test("a directory with no node_modules is reported as missing every dependency", () => {
  const empty = mkdtempSync(join(tmpdir(), "cv-"));
  assert.deepEqual(missingDeps(empty).sort(), ["@modelcontextprotocol/sdk", "ws", "zod"]);
});

test("this checkout has its dependencies, so nothing is installed", () => {
  let ran = false;
  assert.equal(ensureDeps({ root: pluginRoot, run: () => (ran = true) }), true);
  assert.equal(ran, false, "npm is not run when the modules are already there");
});

test("a failed install is reported as false rather than left to crash the server later", () => {
  const empty = mkdtempSync(join(tmpdir(), "cv-"));
  const run = () => ({ status: 1, stdout: "", stderr: "npm ERR! offline" });
  assert.equal(ensureDeps({ root: empty, run }), false);
});

test("saving a key keeps the user's other settings and comments", () => {
  const before = "# my notes\nOPENROUTER_API_KEY=\nVOICE_LANG=Italiano\n";
  const after = mergeEnv(before, { OPENROUTER_API_KEY: "sk-or-v1-x" });
  assert.match(after, /^# my notes$/m);
  assert.match(after, /^OPENROUTER_API_KEY=sk-or-v1-x$/m);
  assert.match(after, /^VOICE_LANG=Italiano$/m, "an unrelated setting survives");
});

test("a setting that was not in the file is appended rather than dropped", () => {
  const after = mergeEnv("OPENROUTER_API_KEY=k\n", { VOICE_LANG: "English" });
  assert.match(after, /^VOICE_LANG=English$/m);
});

test("the tab URL carries the token and the configured port", () => {
  const token = loadOrCreateToken();
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(pageUrl(), `http://127.0.0.1:${browserPort()}/?t=${token}`);
});

test("a headless machine is not asked to open a browser", () => {
  const saved = { ...process.env };
  try {
    process.env.VOICE_BROWSER_OPEN = "0";
    assert.equal(hasDisplay(), false, "the override wins on any platform");
    delete process.env.VOICE_BROWSER_OPEN;
    process.env.VOICE_BROWSER_OPEN = "1";
    assert.equal(hasDisplay(), true);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// ---- settings that survive an update ---------------------------------------------------
//
// Claude Code installs a plugin into a directory named after its version, so every update
// lands in a new directory. A key written next to the code dies with it.

test("the user-level file fills in what the plugin directory does not have", () => {
  const files = { [pluginEnvFile]: "VOICE_LANG=Italiano\n", [userEnvFile]: "OPENROUTER_API_KEY=k\n" };
  const env = {};
  applyEnvFiles({ files: [pluginEnvFile, userEnvFile], env, read: (p) => files[p] });
  assert.equal(env.OPENROUTER_API_KEY, "k", "the key survives outside the plugin directory");
  assert.equal(env.VOICE_LANG, "Italiano");
});

test("the plugin directory wins over the user-level file, and the shell wins over both", () => {
  const files = { [pluginEnvFile]: "VOICE_LANG=Italiano\n", [userEnvFile]: "VOICE_LANG=English\nVOICE_MODE=text\n" };
  const env = { VOICE_MODE: "voice" };
  applyEnvFiles({ files: [pluginEnvFile, userEnvFile], env, read: (p) => files[p] });
  assert.equal(env.VOICE_LANG, "Italiano");
  assert.equal(env.VOICE_MODE, "voice", "an export is never overwritten by a file");
});

test("a missing file is not an error — the next one still loads", () => {
  const env = {};
  applyEnvFiles({
    files: [pluginEnvFile, userEnvFile],
    env,
    read: (p) => {
      if (p === pluginEnvFile) throw new Error("ENOENT");
      return "OPENROUTER_API_KEY=k\n";
    },
  });
  assert.equal(env.OPENROUTER_API_KEY, "k");
});

test("quotes and comments are stripped the way a .env is normally read", () => {
  assert.deepEqual(parseEnvFile('# note\nA="x"\nB=\'y\'\nbroken\n'), [["A", "x"], ["B", "y"]]);
});

test("a key goes to the plugin directory only when a .env is already there", () => {
  assert.equal(envTarget(() => true), pluginEnvFile, "a configured checkout keeps its file");
  assert.equal(envTarget(() => false), userEnvFile, "a fresh install writes where updates cannot reach");
});
