#!/usr/bin/env node
// No-audio smoke test for the Realtime path. Validates auth, model, session connect, and
// that the model calls submit_decision — using a TEXT turn instead of mic/speaker (so it
// runs without sox or a microphone). Not a substitute for a real voice test, but de-risks
// everything except the audio bridge.
//
// Usage: OPENAI_API_KEY=sk-... node scripts/test-realtime-noaudio.mjs

import { RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { config } from "../src/config.mjs";

if (!config.apiKey) {
  console.error("Set OPENAI_API_KEY to run this test.");
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
    "You are a liaison. Claude's text: 'I created two files, main.js and test.js.' " +
    "Options: 1. commit  2. keep going. When the user states a choice, call submit_decision " +
    "with kind='choice' and the exact option text; kind='message' for free text; kind='end' to stop.",
  tools: [submitDecision],
});

const session = new RealtimeSession(agent, {
  transport: "websocket",
  model: config.model,
  config: { outputModalities: ["text"], turnDetection: { type: config.vad } },
});

session.on("error", (e) => console.error("[error]", e?.error ?? e));

const timeout = setTimeout(() => {
  console.error("FAIL: timed out waiting for submit_decision (30s).");
  session.close();
  process.exit(1);
}, 30000);

try {
  console.error(`Connecting model=${config.model} vad=${config.vad} ...`);
  await session.connect({ apiKey: config.apiKey, model: config.model });
  console.error("Connected. Sending a simulated user turn: 'I choose commit.'");
  session.sendMessage("I choose commit.");
  const d = await decision;
  clearTimeout(timeout);
  console.error("PASS: submit_decision fired ->", JSON.stringify(d));
  session.close();
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  console.error("FAIL:", err?.message ?? err);
  session.close();
  process.exit(1);
}
