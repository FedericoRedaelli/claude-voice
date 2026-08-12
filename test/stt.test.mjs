import assert from "node:assert/strict";
import { test } from "node:test";
import { createStt } from "../src/stt/openrouter.mjs";

const cfg = {
  openrouterKey: "sk-test",
  baseUrl: "https://openrouter.ai/api/v1",
  sttModel: "openai/whisper-large-v3-turbo",
  langCode: "it",
};

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
  return { calls, fetchImpl };
}

test("transcribe sends base64 WAV and the language hint", async () => {
  const { calls, fetchImpl } = fakeFetch({ text: "la prima" });
  const pcm = Buffer.alloc(480 * 2);

  await createStt({ fetchImpl, cfg }).transcribe(pcm);

  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/audio/transcriptions");
  assert.equal(calls[0].body.model, "openai/whisper-large-v3-turbo");
  assert.equal(calls[0].body.language, "it");
  assert.equal(calls[0].body.input_audio.format, "wav");

  const sent = Buffer.from(calls[0].body.input_audio.data, "base64");
  assert.equal(sent.subarray(0, 4).toString(), "RIFF", "a container, not loose samples");
  assert.equal(sent.length, 44 + pcm.length);
});

test("no language hint is sent when the language is unknown", async () => {
  const { calls, fetchImpl } = fakeFetch({ text: "hello" });
  await createStt({ fetchImpl, cfg: { ...cfg, langCode: null } }).transcribe(Buffer.alloc(96));

  assert.ok(!("language" in calls[0].body), "an absent hint means auto-detect");
});

test("transcribe returns the trimmed text", async () => {
  const { fetchImpl } = fakeFetch({ text: "  la prima  " });
  assert.equal(await createStt({ fetchImpl, cfg }).transcribe(Buffer.alloc(96)), "la prima");
});

test("a response with no text reads as silence, not as a crash", async () => {
  const { fetchImpl } = fakeFetch({ usage: { seconds: 0.2 } });
  assert.equal(await createStt({ fetchImpl, cfg }).transcribe(Buffer.alloc(96)), "");
});

test("an empty buffer never reaches the network", async () => {
  const { calls, fetchImpl } = fakeFetch({ text: "x" });
  assert.equal(await createStt({ fetchImpl, cfg }).transcribe(Buffer.alloc(0)), "");
  assert.equal(calls.length, 0, "we are billed per second of audio; zero seconds is zero calls");
});

test("an error response throws with the status", async () => {
  const { fetchImpl } = fakeFetch({ error: "nope" }, { ok: false, status: 413 });
  await assert.rejects(() => createStt({ fetchImpl, cfg }).transcribe(Buffer.alloc(96)), /413/);
});
