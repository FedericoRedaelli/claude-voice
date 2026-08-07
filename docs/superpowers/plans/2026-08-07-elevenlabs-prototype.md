# ElevenLabs Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/try-elevenlabs.mjs`, a standalone prototype that runs one full voice call through an ElevenLabs Agent — provisioning the agent into the user's own account on first run — so the Italian voice quality, latency and turn-taking can be judged against the current OpenAI Realtime backend before committing to an integration.

**Architecture:** The ElevenLabs `Conversation` class owns the WebSocket, turn-taking and the LLM. We supply three things: a custom `audioInterface` that wraps the existing `sox` helpers in `src/audio.mjs`, a `submit_decision` client tool whose result goes through the existing `normalizeDecision` in `src/policy.mjs`, and a per-session `agent_prompt_override` built the same way `buildInstructions()` builds it today. Nothing under `src/` is modified; every new pure function lands in a small module under `scripts/elevenlabs/` so it can be unit-tested and later moved into `src/elevenlabs.mjs` unchanged.

**Tech Stack:** Node >= 22, ESM, `@elevenlabs/elevenlabs-js`, `sox` (already required), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-08-07-elevenlabs-voice-backend-design.md`

## Global Constraints

- Node >= 22, ESM only (`"type": "module"`). No TypeScript, no build step.
- **Zero modifications to any file under `src/`.** The prototype imports from `src/` but never edits it.
- Existing tests must keep passing: `npm test` runs `node --test --test-timeout=15000 test/*.test.mjs`.
- The only new runtime dependency is `@elevenlabs/elevenlabs-js`.
- Secrets come from the environment only: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_LLM`, plus the existing `VOICE_LANG`. Never hardcode a key, never commit `.env` (already in `.gitignore`).
- No agent id belonging to any particular account may be hardcoded — this ships as a plugin others configure with their own ElevenLabs account.
- Audio is PCM16 mono. `src/audio.mjs` runs `sox` at a hardcoded `RATE = "24000"`; any format mismatch is resolved in the adapter, not by editing `src/audio.mjs`.
- Commit after every task with a conventional-commit subject line.

**Deviation from the spec, adopted deliberately:** the spec says the prototype introduces no automated tests. This plan adds unit tests for the three pure pieces (audio format negotiation, agent template builder, decision mapping) because they are cheap to test and expensive to debug by ear. The audio bridge and the live session remain validated by listening, as the spec intends. Task 6 amends that line in the spec so the two documents agree.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/elevenlabs/formats.mjs` | Pure. Maps an agent audio format string (`pcm_16000`, `pcm_24000`, …) to a sample rate, and decides whether resampling against `src/audio.mjs`'s 24 kHz is needed. |
| `scripts/elevenlabs/template.mjs` | Pure. Builds the agent-creation payload — prompt, voice, language, `submit_decision` client tool, audio formats, overrides enabled. |
| `scripts/elevenlabs/decision.mjs` | Pure. Maps the raw `submit_decision` tool parameters onto the shape `normalizeDecision` expects. |
| `scripts/elevenlabs/audio-interface.mjs` | Impure. The `audioInterface` object the SDK drives, wrapping `startMic` / `createSpeaker` / `beepPcm`. |
| `scripts/elevenlabs/agent.mjs` | Impure. `ensureAgent()` — reuse `ELEVENLABS_AGENT_ID` or create the agent from the template and print the id. |
| `scripts/try-elevenlabs.mjs` | Entry point. CLI parsing, gate, session, metrics report. |
| `test/elevenlabs-formats.test.mjs` | Tests for `formats.mjs`. |
| `test/elevenlabs-template.test.mjs` | Tests for `template.mjs`. |
| `test/elevenlabs-decision.test.mjs` | Tests for `decision.mjs`. |

---

### Task 1: Install the SDK and pin the real field names

The plan cannot hardcode wire field names that were never verified. The SDK ships TypeScript declarations; this task reads them and writes down what is actually there. Everything downstream depends on the notes this task produces.

**Files:**
- Modify: `package.json` (dependencies)
- Create: `docs/superpowers/plans/2026-08-07-elevenlabs-sdk-notes.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a notes file recording, verbatim from the `.d.ts` files, (a) the `AudioInterface` shape the `Conversation` constructor expects, (b) the accepted values for the agent's TTS output format and ASR user-input format, (c) the nested path to the system prompt, first message, language, voice id, client tools and the override toggles inside `ConversationalConfig` / `AgentPlatformSettingsRequestModel`, (d) the exact `conversationConfigOverride` key names.

- [ ] **Step 1: Install the SDK**

```bash
npm install @elevenlabs/elevenlabs-js
```

- [ ] **Step 2: Confirm existing tests still pass**

Run: `npm test`
Expected: PASS — the new dependency must not disturb anything.

- [ ] **Step 3: Read the AudioInterface declaration**

```bash
find node_modules/@elevenlabs/elevenlabs-js -path '*conversation*' -name '*.d.ts' | sort
sed -n '1,200p' node_modules/@elevenlabs/elevenlabs-js/api/resources/conversationalAi/conversation/AudioInterface.d.ts
```

Record in the notes file the exact method names and signatures. Expected shape, to be confirmed rather than assumed: `start(inputCallback: (chunk: Buffer) => void): void`, `stop(): void`, `output(audio: Buffer): void`, `interrupt(): void`.

- [ ] **Step 4: Read the conversation config and override declarations**

```bash
grep -rn "agent_prompt_override\|agentPromptOverride\|first_message_override\|firstMessageOverride" node_modules/@elevenlabs/elevenlabs-js --include=*.d.ts | head -20
grep -rln "ConversationalConfig\b" node_modules/@elevenlabs/elevenlabs-js/api/types | head
grep -rn "userInputAudioFormat\|user_input_audio_format\|agentOutputAudioFormat\|agent_output_audio_format" node_modules/@elevenlabs/elevenlabs-js --include=*.d.ts | head -20
```

Record every accepted audio-format literal and the full nested property path for prompt, first message, language, voice id and client tools.

- [ ] **Step 5: Read the override / privacy settings declaration**

```bash
grep -rn "overrides" node_modules/@elevenlabs/elevenlabs-js/api/types/AgentPlatformSettings*.d.ts | head -20
```

Record which flags must be `true` for `agent_prompt_override` and `first_message_override` to be honoured. **If these flags are not set at creation time, the per-session prompt is silently ignored** — this is the single highest-risk detail in the whole prototype.

- [ ] **Step 6: Write the notes file**

Write `docs/superpowers/plans/2026-08-07-elevenlabs-sdk-notes.md` with one section per step above, quoting the declarations verbatim. Later tasks read this file instead of guessing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json docs/superpowers/plans/2026-08-07-elevenlabs-sdk-notes.md
git commit -m "chore: add ElevenLabs SDK and pin its config field names"
```

---

### Task 2: Audio format negotiation

`src/audio.mjs` captures and plays PCM16 mono at a hardcoded 24 kHz. The agent may want a different rate. This task decides, in one pure function, what the agent should be configured with and whether any conversion is needed — before a single byte of audio is wired up.

**Files:**
- Create: `scripts/elevenlabs/formats.mjs`
- Test: `test/elevenlabs-formats.test.mjs`

**Interfaces:**
- Consumes: the list of accepted format literals from Task 1's notes.
- Produces: `SOX_RATE` (number, `24000`), `rateOf(format: string): number`, `pickFormats({ accepted: string[] }): { input: string, output: string, needsResample: boolean }`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/elevenlabs-formats.test.mjs
// The prototype plays and records through sox at a fixed 24 kHz. If the agent cannot be
// configured to match, we must know it here — in a unit test — and not by hearing chipmunks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOX_RATE, rateOf, pickFormats } from "../scripts/elevenlabs/formats.mjs";

test("sox runs at 24 kHz", () => {
  assert.equal(SOX_RATE, 24000);
});

test("reads the sample rate out of a format literal", () => {
  assert.equal(rateOf("pcm_16000"), 16000);
  assert.equal(rateOf("pcm_24000"), 24000);
});

test("an unknown format is an error, not a silent default", () => {
  assert.throws(() => rateOf("mp3_44100_128"), /pcm/);
  assert.throws(() => rateOf("ulaw_8000"), /pcm/);
});

test("prefers 24 kHz on both legs when the agent accepts it", () => {
  const f = pickFormats({ accepted: ["pcm_16000", "pcm_24000", "pcm_44100"] });
  assert.deepEqual(f, { input: "pcm_24000", output: "pcm_24000", needsResample: false });
});

test("falls back to the nearest accepted rate and flags the mismatch", () => {
  const f = pickFormats({ accepted: ["pcm_16000"] });
  assert.equal(f.input, "pcm_16000");
  assert.equal(f.output, "pcm_16000");
  assert.equal(f.needsResample, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/elevenlabs-formats.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/elevenlabs/formats.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// scripts/elevenlabs/formats.mjs
// sox is spawned at a fixed rate by src/audio.mjs, which the prototype must not modify. So
// the rate is negotiated in one place: prefer a format that matches sox exactly, and when the
// agent refuses, say so loudly rather than letting a rate mismatch reach the speaker.

export const SOX_RATE = 24000; // must track RATE in src/audio.mjs

export function rateOf(format) {
  const m = /^pcm_(\d+)$/.exec(format);
  if (!m) throw new Error(`unsupported audio format ${format}: the bridge only speaks raw pcm_*`);
  return Number(m[1]);
}

export function pickFormats({ accepted }) {
  const pcm = accepted.filter((f) => /^pcm_\d+$/.test(f));
  if (pcm.length === 0) throw new Error("the agent accepts no raw pcm format; the sox bridge cannot be used");

  const exact = pcm.find((f) => rateOf(f) === SOX_RATE);
  const chosen = exact || pcm.reduce((a, b) => (Math.abs(rateOf(a) - SOX_RATE) <= Math.abs(rateOf(b) - SOX_RATE) ? a : b));

  return { input: chosen, output: chosen, needsResample: rateOf(chosen) !== SOX_RATE };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/elevenlabs-formats.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/elevenlabs/formats.mjs test/elevenlabs-formats.test.mjs
git commit -m "feat: negotiate the ElevenLabs agent audio format against the sox rate"
```

---

### Task 3: Agent template and provisioning

`ensureAgent()` is the plugin's onboarding: someone who installs this supplies `ELEVENLABS_API_KEY` and nothing else. The payload builder is pure and tested; the API call around it is thin.

**Files:**
- Create: `scripts/elevenlabs/template.mjs`
- Create: `scripts/elevenlabs/agent.mjs`
- Test: `test/elevenlabs-template.test.mjs`

**Interfaces:**
- Consumes: `pickFormats` from Task 2; the nested config paths from Task 1's notes.
- Produces: `buildAgentPayload({ voiceId, language, llm, formats }): object` and `ensureAgent({ client, env }): Promise<{ agentId: string, created: boolean }>`.

**Note for the implementer:** the property paths written below follow the ElevenLabs wire format. **Before writing the implementation, open Task 1's notes and correct every path that does not match the declarations.** The tests assert on the paths, so a correction means editing both together — that is expected, not a failure.

- [ ] **Step 1: Write the failing test**

```javascript
// test/elevenlabs-template.test.mjs
// The template is what makes a freshly provisioned agent usable: without the override flags
// the per-session prompt is silently discarded, and without the client tool the call can
// never end with a decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentPayload } from "../scripts/elevenlabs/template.mjs";

const formats = { input: "pcm_24000", output: "pcm_24000", needsResample: false };
const payload = () => buildAgentPayload({ voiceId: "v1", language: "it", llm: "gpt-4o-mini", formats });

test("enables the prompt and first-message overrides", () => {
  const p = payload();
  const o = p.platformSettings.overrides.conversationConfigOverride;
  assert.equal(o.agent.prompt.prompt, true);
  assert.equal(o.agent.firstMessage, true);
  assert.equal(o.agent.language, true);
});

test("declares submit_decision as a client tool with a kind and a value", () => {
  const tools = payload().conversationConfig.agent.prompt.tools;
  const submit = tools.find((t) => t.name === "submit_decision");
  assert.equal(submit.type, "client");
  const props = submit.parameters.properties;
  assert.deepEqual(props.kind.enum, ["choice", "message", "end"]);
  assert.equal(props.value.type, "string");
  assert.deepEqual(submit.parameters.required, ["kind"]);
});

test("carries the negotiated audio formats onto both legs", () => {
  const p = payload();
  assert.equal(p.conversationConfig.tts.agentOutputAudioFormat, "pcm_24000");
  assert.equal(p.conversationConfig.asr.userInputAudioFormat, "pcm_24000");
});

test("carries voice, language and llm", () => {
  const p = payload();
  assert.equal(p.conversationConfig.tts.voiceId, "v1");
  assert.equal(p.conversationConfig.agent.language, "it");
  assert.equal(p.conversationConfig.agent.prompt.llm, "gpt-4o-mini");
});

test("the name identifies the plugin, not a person", () => {
  assert.match(buildAgentPayload({ voiceId: "v1", language: "it", llm: "x", formats }).name, /claude-voice/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/elevenlabs-template.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/elevenlabs/template.mjs'`

- [ ] **Step 3: Write the template builder**

```javascript
// scripts/elevenlabs/template.mjs
// The shape of a freshly provisioned agent. The real per-call prompt arrives as a session
// override, so the baked-in prompt only has to be a sane fallback — but the override FLAGS
// baked in here are not optional: without them the override is discarded without an error.

const BASE_PROMPT = [
  "You are a voice bridge between a developer and their coding assistant.",
  "You are given one message and you speak it back conversationally, then you take the",
  "user's answer and report it by calling submit_decision. You have no other knowledge and",
  "no access to their code. Keep every turn short.",
].join(" ");

export function buildAgentPayload({ voiceId, language, llm, formats }) {
  return {
    name: "claude-voice bridge",
    conversationConfig: {
      agent: {
        language,
        firstMessage: "",
        prompt: {
          prompt: BASE_PROMPT,
          llm,
          tools: [
            {
              type: "client",
              name: "submit_decision",
              description:
                "Report the user's answer and end the call. Use kind 'choice' only when the user picked one of the offered options whole; use 'message' for anything else they said; use 'end' when they are done.",
              parameters: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["choice", "message", "end"] },
                  value: { type: "string", description: "The chosen option verbatim, or the user's own words." },
                },
                required: ["kind"],
              },
            },
          ],
        },
      },
      tts: { voiceId, agentOutputAudioFormat: formats.output },
      asr: { userInputAudioFormat: formats.input },
    },
    platformSettings: {
      overrides: {
        conversationConfigOverride: {
          agent: { prompt: { prompt: true }, firstMessage: true, language: true },
        },
      },
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/elevenlabs-template.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the provisioning wrapper**

```javascript
// scripts/elevenlabs/agent.mjs
// Onboarding for whoever installs the plugin: one API key in, one agent id out. The id is
// printed rather than written to .env — the prototype must not edit a file it does not own.

import { buildAgentPayload } from "./template.mjs";
import { pickFormats } from "./formats.mjs";

// Filled in from Task 1's notes; the union of pcm formats the agent config accepts.
export const ACCEPTED_FORMATS = ["pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100"];

export async function ensureAgent({ client, env = process.env, log = console.error }) {
  if (env.ELEVENLABS_AGENT_ID) {
    return { agentId: env.ELEVENLABS_AGENT_ID, created: false };
  }

  const formats = pickFormats({ accepted: ACCEPTED_FORMATS });
  if (formats.needsResample) {
    log(`[try-elevenlabs] warning: agent runs at ${formats.input}, sox runs at 24000 — audio will be off-pitch`);
  }

  const payload = buildAgentPayload({
    voiceId: env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID,
    language: (env.VOICE_LANG || "English").slice(0, 2).toLowerCase() === "it" ? "it" : "en",
    llm: env.ELEVENLABS_LLM || undefined,
    formats,
  });

  const agent = await client.conversationalAi.agents.create(payload);
  log(`[try-elevenlabs] created agent ${agent.agentId} — save it: ELEVENLABS_AGENT_ID=${agent.agentId}`);
  return { agentId: agent.agentId, created: true };
}

// An ElevenLabs premade voice. Overridable with ELEVENLABS_VOICE_ID; the prototype's whole
// point is trying several, so this is a starting point and nothing more.
const DEFAULT_VOICE_ID = "XrExE9yKIg1WjnnlVkGX";
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — old tests untouched, two new files green.

- [ ] **Step 7: Commit**

```bash
git add scripts/elevenlabs/template.mjs scripts/elevenlabs/agent.mjs test/elevenlabs-template.test.mjs
git commit -m "feat: provision an ElevenLabs agent from a versioned template"
```

---

### Task 4: Decision mapping

The tool call arrives with the SDK's own envelope. `normalizeDecision` in `src/policy.mjs` is the existing gatekeeper that refuses a `choice` the user never picked whole. This task is the adapter between the two, and nothing more.

**Files:**
- Create: `scripts/elevenlabs/decision.mjs`
- Test: `test/elevenlabs-decision.test.mjs`
- Read for reference: `src/policy.mjs:14`

**Interfaces:**
- Consumes: `normalizeDecision({ kind, value, optionIndex }, options, log)` from `src/policy.mjs`.
- Produces: `toDecision(parameters: object, options: string[], log?: Function): { kind, value? }`.

- [ ] **Step 1: Read the existing gatekeeper**

Run: `sed -n '1,45p' src/policy.mjs`
Understand what `normalizeDecision` already guarantees. Do not reimplement any of it.

- [ ] **Step 2: Write the failing test**

```javascript
// test/elevenlabs-decision.test.mjs
// The SDK hands the tool parameters over with a tool_call_id mixed in. Everything else is
// already policed by normalizeDecision — this adapter must not add a second opinion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { toDecision } from "../scripts/elevenlabs/decision.mjs";

const OPTIONS = ["Rebase onto main", "Merge main in"];

test("passes a whole-option choice straight through", () => {
  const d = toDecision({ tool_call_id: "abc", kind: "choice", value: "Merge main in" }, OPTIONS);
  assert.deepEqual(d, { kind: "choice", value: "Merge main in" });
});

test("drops the tool_call_id before policy sees it", () => {
  const d = toDecision({ tool_call_id: "abc", kind: "message", value: "do neither" }, OPTIONS);
  assert.equal(d.kind, "message");
  assert.equal("tool_call_id" in d, false);
});

test("an option nobody picked is demoted to a message by policy", () => {
  const d = toDecision({ kind: "choice", value: "something else entirely" }, OPTIONS);
  assert.equal(d.kind, "message");
});

test("end carries no value", () => {
  assert.deepEqual(toDecision({ kind: "end" }, OPTIONS), { kind: "end" });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/elevenlabs-decision.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/elevenlabs/decision.mjs'`

- [ ] **Step 4: Write the implementation**

```javascript
// scripts/elevenlabs/decision.mjs
// One job: strip the SDK envelope and hand the rest to the policy that already exists. Any
// judgement about whether a choice is real belongs in src/policy.mjs, not here.

import { normalizeDecision } from "../../src/policy.mjs";

export function toDecision(parameters, options = [], log = () => {}) {
  const { kind, value } = parameters || {};
  return normalizeDecision({ kind, value }, options, log);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/elevenlabs-decision.test.mjs`
Expected: PASS, 4 tests. If the third test fails, read `normalizeDecision` again and fix the *test's* expectation to match the policy that already ships — do not change `src/policy.mjs`.

- [ ] **Step 6: Commit**

```bash
git add scripts/elevenlabs/decision.mjs test/elevenlabs-decision.test.mjs
git commit -m "feat: map the ElevenLabs tool call onto the existing decision policy"
```

---

### Task 5: Audio bridge and the runnable prototype

The first task whose deliverable is judged by ear rather than by assertion. Half-duplex is the default because it is what works on laptop speakers: the mic stays muted while the agent talks, anchored to playback and not to the arrival of audio.

**Files:**
- Create: `scripts/elevenlabs/audio-interface.mjs`
- Create: `scripts/try-elevenlabs.mjs`
- Read for reference: `src/audio.mjs:47` (`startMic`), `src/audio.mjs:177` (`createSpeaker`), `src/audio.mjs:162` (`beepPcm`), `src/audio.mjs:111` (`waitForSpeech`), `scripts/try-voice.mjs` (CLI shape to mirror)

**Interfaces:**
- Consumes: `ensureAgent` (Task 3), `toDecision` (Task 4), `pickFormats` (Task 2).
- Produces: `createAudioInterface({ halfDuplex, device }): { start, stop, output, interrupt, isPlaying }` and a runnable script.

- [ ] **Step 1: Re-read Task 1's notes on AudioInterface**

Run: `cat docs/superpowers/plans/2026-08-07-elevenlabs-sdk-notes.md`
The method names below must match the declaration exactly. If the SDK expects a class instance rather than a plain object, wrap it accordingly.

- [ ] **Step 2: Write the audio interface**

```javascript
// scripts/elevenlabs/audio-interface.mjs
// The bridge between the SDK's byte streams and sox. Half-duplex is anchored to PLAYBACK,
// not to the arrival of the agent's audio: the model streams a reply in bursts far faster
// than real time, so "nothing queued right now" is not the same as "it stopped talking".

import { startMic, createSpeaker } from "../../src/audio.mjs";

export function createAudioInterface({ halfDuplex = true, device = process.env.VOICE_IN_DEVICE } = {}) {
  let mic = null;
  let speaker = null;

  const self = {
    start(inputCallback) {
      speaker = createSpeaker({ device: process.env.VOICE_OUT_DEVICE });
      mic = startMic((chunk) => {
        if (halfDuplex && self.isPlaying()) return; // muted while the agent speaks
        inputCallback(chunk);
      }, { device });
    },
    output(audio) {
      speaker?.write(audio);
    },
    interrupt() {
      speaker?.clear?.();
    },
    stop() {
      mic?.stop?.();
      speaker?.stop?.();
      mic = null;
      speaker = null;
    },
    isPlaying() {
      return Boolean(speaker && speaker.endsAt > Date.now());
    },
  };

  return self;
}
```

- [ ] **Step 3: Reconcile with the real speaker API**

Run: `sed -n '177,312p' src/audio.mjs`
`createSpeaker` is the source of truth for what `write`, `clear`, `stop` and the playback deadline are actually called. Rename the calls in Step 2 to match; do not add methods to `src/audio.mjs`.

- [ ] **Step 4: Verify the bridge in isolation before any network call**

Run: `node -e "import('./scripts/elevenlabs/audio-interface.mjs').then(async m => { const a = m.createAudioInterface(); const { beepPcm } = await import('./src/audio.mjs'); a.start(() => {}); a.output(beepPcm({ ms: 300 })); setTimeout(() => a.stop(), 1500); })"`
Expected: one clean 300 ms beep at normal pitch, then silence and a clean exit. A chipmunk or a growl means the rate negotiation from Task 2 is wrong — fix that before continuing.

- [ ] **Step 5: Write the prototype entry point**

```javascript
// scripts/try-elevenlabs.mjs
// One full call through an ElevenLabs Agent, for listening to. Deliberately a twin of
// scripts/try-voice.mjs so the two backends can be compared back to back on the same words.
//
//   node scripts/try-elevenlabs.mjs "messaggio" "opzione A" "opzione B"

import { ElevenLabsClient, Conversation, ClientTools } from "@elevenlabs/elevenlabs-js";
import { ensureAgent } from "./elevenlabs/agent.mjs";
import { toDecision } from "./elevenlabs/decision.mjs";
import { createAudioInterface } from "./elevenlabs/audio-interface.mjs";

const [message, ...options] = process.argv.slice(2);
if (!message) {
  console.error('usage: node scripts/try-elevenlabs.mjs "message" ["option A" "option B" ...]');
  process.exit(2);
}
if (!process.env.ELEVENLABS_API_KEY) {
  console.error("ELEVENLABS_API_KEY is not set.");
  process.exit(2);
}

const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
const { agentId } = await ensureAgent({ client });

const metrics = { start: Date.now(), firstAudio: null, pings: [], transcripts: [] };
let decision = null;

const clientTools = new ClientTools();
clientTools.register("submit_decision", (parameters) => {
  decision = toDecision(parameters, options, (m) => console.error(`[policy] ${m}`));
  return { ok: true };
});

const audioInterface = createAudioInterface({ halfDuplex: process.env.VOICE_HALF_DUPLEX !== "0" });
const wrapped = {
  ...audioInterface,
  output(audio) {
    metrics.firstAudio = metrics.firstAudio ?? Date.now() - metrics.start;
    audioInterface.output(audio);
  },
};

const conversation = new Conversation({
  client,
  agentId,
  requiresAuth: true,
  audioInterface: wrapped,
  clientTools,
  config: {
    conversationConfigOverride: {
      agent_prompt_override: instructions(message, options),
      first_message_override: message,
      language: (process.env.VOICE_LANG || "English").toLowerCase().startsWith("it") ? "it" : "en",
    },
  },
  callbackUserTranscript: (t) => metrics.transcripts.push(t),
  callbackLatencyMeasurement: (ms) => metrics.pings.push(ms),
});

await conversation.startSession();
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (decision) { clearInterval(timer); resolve(); }
  }, 100);
  setTimeout(() => { clearInterval(timer); resolve(); }, Number(process.env.VOICE_TIMEOUT_MS) || 120000);
});
conversation.endSession();

console.log(JSON.stringify({ decision, metrics }, null, 2));
process.exit(0);

function instructions(msg, opts) {
  const list = opts.length ? `\nThe options are:\n${opts.map((o, i) => `${i + 1}. ${o}`).join("\n")}` : "";
  return [
    "You are a voice bridge. Speak the message below back to the user conversationally, in one short sentence.",
    "Assume they cannot see a screen: say the options out loud rather than telling them to look.",
    "Answer their questions using ONLY the message below — you know nothing else, and you have no access to their code.",
    "As soon as their answer is clear, call submit_decision and stop talking.",
    "Report kind 'choice' ONLY if they picked one of the options whole. A mix of two, an option with a condition attached, or a different idea entirely is kind 'message' in their own words.",
    `\nThe message is:\n${msg}${list}`,
  ].join(" ");
}
```

- [ ] **Step 6: Run it and listen**

Run: `node scripts/try-elevenlabs.mjs "Ho finito il refactor. Faccio il rebase su main o unisco main dentro il branch?" "Rebase su main" "Merge di main nel branch"`
Expected: the agent speaks the message in Italian, you answer out loud, the process prints a `decision` matching what you said plus the latency figures. Judge the four questions the spec asks: voice quality, first-audio latency, turn-taking, tool-call reliability.

- [ ] **Step 7: Run the same words through the old backend for comparison**

Run: `node scripts/try-voice.mjs "Ho finito il refactor. Faccio il rebase su main o unisco main dentro il branch?" "Rebase su main" "Merge di main nel branch"`
Expected: the same exchange on OpenAI Realtime. Note which is better, and by how much.

- [ ] **Step 8: Commit**

```bash
git add scripts/elevenlabs/audio-interface.mjs scripts/try-elevenlabs.mjs
git commit -m "feat: runnable ElevenLabs voice prototype"
```

---

### Task 6: Document it and record the verdict

A prototype nobody can rerun is a prototype that has to be rebuilt. This task makes it reproducible for someone with their own ElevenLabs account, and writes down what the listening test actually showed.

**Files:**
- Modify: `package.json` (scripts)
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-07-elevenlabs-voice-backend-design.md`

- [ ] **Step 1: Add the npm script**

In `package.json`, alongside `"try": "node scripts/try-voice.mjs"`, add:

```json
"try:elevenlabs": "node scripts/try-elevenlabs.mjs"
```

- [ ] **Step 2: Document the environment variables**

In `README.md`, in the section that lists the environment variables, add a subsection for the prototype covering `ELEVENLABS_API_KEY` (required), `ELEVENLABS_AGENT_ID` (optional, printed on first run), `ELEVENLABS_VOICE_ID` and `ELEVENLABS_LLM`. State plainly that the first run creates an agent in the reader's own ElevenLabs account and that they should save the printed id.

- [ ] **Step 3: Correct the spec's line about tests**

In the spec's Test section, replace the sentence claiming the prototype introduces no automated tests with the truth: the pure pieces — format negotiation, agent template, decision mapping — are unit-tested under `test/`, while the audio bridge and the live session are validated by listening.

- [ ] **Step 4: Record the verdict**

Append a "Verdict" section to the spec answering, with the numbers from Task 5, the four questions it poses: is the Italian voice noticeably better, is the first-audio latency acceptable, does turn-taking hold without clipping speech, does the `submit_decision` call arrive reliably. Then state the recommendation — integrate as a second backend, replace OpenAI Realtime outright, or drop it — and why.

- [ ] **Step 5: Run the full suite one last time**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json README.md docs/superpowers/specs/2026-08-07-elevenlabs-voice-backend-design.md
git commit -m "docs: document the ElevenLabs prototype and record its verdict"
```

---

## Notes for the implementer

- **The single riskiest detail** is the override flag in the agent's platform settings. If `agent_prompt_override` is not enabled at creation, the per-session prompt is discarded without any error and the agent will answer from the baked-in fallback prompt. If the prototype sounds like it is ignoring the message, check this first.
- **Do not touch `src/audio.mjs`.** Every format problem is solved in `scripts/elevenlabs/formats.mjs`.
- **Do not touch `src/policy.mjs`.** If a decision comes out wrong, the fix is in the prompt or in the adapter.
- The spec's known unknown about transcription priming has no code in this plan: today `transcriptionPrompt()` seeds project nouns into the transcriber, and ElevenLabs exposes no equivalent. Judge it by ear in Task 5 Step 6 by saying a branch name and a file name out loud, and record the result in the verdict.
