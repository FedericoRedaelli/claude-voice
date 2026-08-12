import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule, loadModules } from "../src/modules.mjs";

const cfg = {
  openrouterKey: "sk-test",
  baseUrl: "https://openrouter.ai/api/v1",
  audio: "browser",
  tts: "openrouter",
  stt: "openrouter",
  brain: "openrouter",
  ttsModel: "m",
  ttsVoice: "v",
  sttModel: "m",
  brainModel: "m",
  lang: "Italiano",
  speed: 1,
};

test("a named implementation loads and exposes its interface", async () => {
  const tts = await loadModule("tts", "openrouter", cfg);
  assert.equal(typeof tts.speak, "function");

  const stt = await loadModule("stt", "openrouter", cfg);
  assert.equal(typeof stt.transcribe, "function");

  const brain = await loadModule("brain", "openrouter", cfg);
  assert.equal(typeof brain.route, "function");
});

test("an unknown implementation fails with the list of the real ones", async () => {
  await assert.rejects(() => loadModule("tts", "elevenlabs", cfg), /elevenlabs.*openrouter/s);
});

test("an unknown slot fails by name", async () => {
  await assert.rejects(() => loadModule("telepathy", "openrouter", cfg), /telepathy/);
});

test("loadModules fills every slot from config", async () => {
  const mods = await loadModules({ ...cfg, audio: "none" });
  assert.equal(typeof mods.tts.speak, "function");
  assert.equal(typeof mods.stt.transcribe, "function");
  assert.equal(typeof mods.brain.route, "function");
  assert.equal(mods.audio, null, '"none" is the audio slot for tests: no port, no tab');
});
