#!/usr/bin/env node
// End-to-end audio test WITHOUT a microphone: feeds a pre-recorded PCM16 utterance into the
// Realtime session exactly as the mic bridge would (session.sendAudio), then waits for the
// model to transcribe it, react, and call submit_decision. Exercises the real audio-in path
// + server VAD + tool call. Only the physical mic device (`-d`) is left untested.
//
// Usage: OPENAI_API_KEY=sk-... node scripts/test-realtime-audiofile.mjs <raw-pcm16-24k-mono>

import { readFileSync } from "node:fs";
import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { config } from "../src/config.mjs";

const rawPath = process.argv[2];
if (!config.apiKey || !rawPath) {
  console.error("Usage: OPENAI_API_KEY=... node scripts/test-realtime-audiofile.mjs <raw>");
  process.exit(2);
}

let resolveDecision;
const decision = new Promise((res) => (resolveDecision = res));

const submitDecision = tool({
  name: "submit_decision",
  description: "Record the user's decision and end the conversation.",
  parameters: z.object({
    kind: z.enum(["choice", "message", "end"]),
    value: z.string().nullable().optional(),
  }),
  execute: ({ kind, value }) => {
    resolveDecision({ kind, value: value ?? null });
    return "Decision recorded.";
  },
});

const agent = new RealtimeAgent({
  name: "claude-voice-liaison",
  instructions:
    "You are a liaison. Claude's text: 'I created two files.' Options: 1. commit  2. keep going. " +
    "When the user states a choice, call submit_decision with kind='choice' and the exact option " +
    "text; kind='message' for free text; kind='end' to stop.",
  tools: [submitDecision],
});

const td =
  config.vad === "semantic_vad"
    ? { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: false }
    : { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: config.silenceMs, create_response: true, interrupt_response: false };
const session = new RealtimeSession(agent, {
  transport: "websocket",
  model: config.model,
  config: {
    outputModalities: ["audio"],
    audio: {
      input: { turnDetection: td, noiseReduction: config.noise ? { type: config.noise } : null },
      output: { voice: config.voice },
    },
  },
});

session.on("error", (e) => console.error("[error]", JSON.stringify(e?.error ?? e)));
session.on("history_added", (i) => {
  const t = i?.content?.map?.((c) => c.transcript || c.text).filter(Boolean).join(" ");
  if (t) console.error(`[${i.role}] ${t}`);
});
// Raw server events — reveals transcription, VAD, and response lifecycle.
session.on("transport_event", (e) => {
  const t = e?.type || "";
  if (/transcription|speech|committed|response\.(created|done)|function_call|error/i.test(t)) {
    console.error(`  <event> ${t}${e?.transcript ? " :: " + e.transcript : ""}`);
  }
});

const timeout = setTimeout(() => {
  console.error("FAIL: timed out (40s).");
  session.close();
  process.exit(1);
}, 40000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.error(`Connecting model=${config.model} vad=${config.vad} ...`);
  await session.connect({ apiKey: config.apiKey, model: config.model });
  console.error("Connected. Streaming utterance...");

  const pcm = readFileSync(rawPath);
  const CHUNK = 4800; // 0.1s @ 24kHz mono 16-bit
  for (let off = 0; off < pcm.length; off += CHUNK) {
    const slice = pcm.subarray(off, off + CHUNK);
    session.sendAudio(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
    await sleep(80);
  }
  // Trailing silence, paced in real time, so VAD detects end-of-speech.
  const sil = Buffer.alloc(CHUNK); // 0.1s of zeros
  for (let i = 0; i < 25; i++) {
    session.sendAudio(sil.buffer.slice(0, sil.byteLength));
    await sleep(80);
  }
  console.error("Utterance + silence sent; waiting for decision...");

  const d = await decision;
  clearTimeout(timeout);
  console.error("PASS: submit_decision ->", JSON.stringify(d));
  session.close();
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  console.error("FAIL:", err?.message ?? err);
  session.close();
  process.exit(1);
}
