import assert from "node:assert/strict";
import { test } from "node:test";
import { createTts } from "../src/tts/openrouter.mjs";

const cfg = {
  openrouterKey: "sk-test",
  baseUrl: "https://openrouter.ai/api/v1",
  ttsModel: "microsoft/mai-voice-2-flash",
  ttsVoice: "en-US-Harper:MAI-Voice-2",
  speed: 1.15,
};

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return response;
  };
  return { calls, fetchImpl };
}

const okAudio = (bytes) => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
});

test("speak posts the fixed model, the chosen voice and pcm output", async () => {
  const { calls, fetchImpl } = fakeFetch(okAudio(Buffer.alloc(96)));
  await createTts({ fetchImpl, cfg }).speak("ciao");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/audio/speech");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
  assert.deepEqual(calls[0].body, {
    model: "microsoft/mai-voice-2-flash",
    input: "ciao",
    voice: "en-US-Harper:MAI-Voice-2",
    response_format: "pcm",
    speed: 1.15,
  });
});

test("speak returns the raw bytes — this endpoint does not answer JSON", async () => {
  const audio = Buffer.from([1, 2, 3, 4]);
  const { fetchImpl } = fakeFetch(okAudio(audio));

  const out = await createTts({ fetchImpl, cfg }).speak("ciao");
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, audio);
});

test("an error response throws with the status and the provider's words", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 502,
    text: async () => '{"error":{"message":"Provider returned 502"}}',
  });

  await assert.rejects(() => createTts({ fetchImpl, cfg }).speak("ciao"), /502.*Provider returned/s);
});

test("empty text never reaches the network", async () => {
  const { calls, fetchImpl } = fakeFetch(okAudio(Buffer.alloc(0)));
  const out = await createTts({ fetchImpl, cfg }).speak("   ");

  assert.equal(calls.length, 0, "nothing to say costs nothing");
  assert.equal(out.length, 0);
});
