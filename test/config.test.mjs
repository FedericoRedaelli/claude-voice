import assert from "node:assert/strict";
import { test } from "node:test";

// config.mjs reads process.env once, at import time. A cache-busting query string is the
// only way to see it read a different environment in the same process.
let n = 0;
async function freshConfig(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    return (await import(`../src/config.mjs?case=${n++}`)).config;
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("the three models default to the ones the spec fixed", async () => {
  const config = await freshConfig({});
  assert.equal(config.ttsModel, "microsoft/mai-voice-2-flash");
  assert.equal(config.ttsVoice, "en-US-Harper:MAI-Voice-2");
  assert.equal(config.sttModel, "openai/whisper-large-v3-turbo");
  assert.equal(config.brainModel, "openai/gpt-oss-120b");
});

test("every module slot defaults to a named implementation", async () => {
  const config = await freshConfig({});
  assert.equal(config.audio, "browser");
  assert.equal(config.tts, "openrouter");
  assert.equal(config.stt, "openrouter");
  assert.equal(config.brain, "openrouter");
});

test("env overrides a slot without touching the others", async () => {
  const config = await freshConfig({ VOICE_TTS: "local" });
  assert.equal(config.tts, "local");
  assert.equal(config.stt, "openrouter");
});

// The key is normally present (in the shell or in .env), so the missing-key path is tested
// on the factory rather than on the module-level instance: an assertion that only holds on
// a machine with no key is an assertion that fails for somebody.
test("requireOpenRouterKey names the variable that is missing", async () => {
  const { makeRequireKey } = await import(`../src/config.mjs?case=${n++}`);
  assert.throws(() => makeRequireKey({ openrouterKey: "" })(), /OPENROUTER_API_KEY/);
  assert.doesNotThrow(() => makeRequireKey({ openrouterKey: "sk-x" })());
});
