#!/usr/bin/env node
// One real call, end to end, with no browser and no human voice.
//
// WHY THIS IS A SCRIPT AND NOT A TEST: it spends money and needs a key, and a provider having a
// bad afternoon must not be able to fail the build. test/bridge.test.mjs covers the protocol
// with fakes and an ephemeral port; this covers the part fakes cannot — that the contract with
// the three providers still holds, and that what you say survives synthesis, Whisper and the
// router without turning into something you did not say.
//
// It plays the browser: answers drains, and when the microphone opens it feeds back an answer
// synthesised with the SAME TTS the call uses. Real audio, real transcription, real routing.
//
//   npm run smoke:voice                                  -- say "facciamo la seconda"
//   npm run smoke:voice -- --say "no, lasciamo stare"    -- something the options do not cover
//   npm run smoke:voice -- --click 1                     -- answer with the mouse instead
//   VOICE_BRAIN_MODEL=openai/gpt-oss-120b npm run smoke:voice
//
// Exit code 0 when a decision came back, 1 when the call hung or died.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { config } from "../src/config.mjs";
import { loadOrCreateToken } from "../src/bridge-url.mjs";
import { createTts } from "../src/tts/openrouter.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const SAY = flag("say", "facciamo la seconda");
const CLICK = flag("click", null); // 1-based, like the page shows them
const OPTIONS = ["Apri la pull request", "Fai altri test"];
const SPOKEN = "Ho finito. Procedo, o preferisci altro?";
// Never the port the running session uses: this must not evict the user's own tab.
const PORT = Number(process.env.VOICE_SMOKE_PORT) || 8899;
const TIMEOUT_MS = Number(process.env.VOICE_SMOKE_TIMEOUT_MS) || 90000;

const t0 = Date.now();
const log = (...a) => console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7), ...a);

console.log(`brain ${config.brainModel}`);
console.log(`stt   ${config.sttModel}`);
console.log(`tts   ${config.ttsModel}`);
console.log(CLICK ? `answering by clicking option ${CLICK}` : `answering out loud: "${SAY}"`);

// Synthesised before the call, so its latency is not part of what we are measuring.
let answerPcm = Buffer.alloc(0);
if (!CLICK) {
  answerPcm = await createTts().speak(SAY);
  log(`answer synthesised (${(answerPcm.length / 2 / 24000).toFixed(1)}s of audio)`);
}

const child = spawn(process.execPath, [join(ROOT, "scripts", "run-call.mjs")], {
  cwd: ROOT,
  stdio: ["pipe", "pipe", process.env.VOICE_SMOKE_QUIET ? "ignore" : "inherit"],
  // The call must run here, not in a grandchild: VOICE_DEV would spawn another one.
  env: { ...process.env, VOICE_DEV: "", VOICE_BROWSER_PORT: String(PORT), VOICE_BROWSER_OPEN: "0" },
});

let out = "";
child.stdout.on("data", (d) => (out += String(d)));
child.on("close", (code) => {
  const decision = out.trim().split("\n").filter(Boolean).at(-1) ?? "";
  console.log();
  console.log(`decision  ${decision || "(none)"}`);
  console.log(`heard     ${heard ?? "(nothing)"}`);
  console.log(`took      ${((Date.now() - t0) / 1000).toFixed(1)}s, exit ${code}`);
  process.exit(decision.includes('"kind"') ? 0 : 1);
});
child.stdin.end(JSON.stringify({ message: SPOKEN, options: OPTIONS, spoken: SPOKEN }));

let heard = null;
let spoke = false;

const attach = () => {
  const tab = new WebSocket(`ws://127.0.0.1:${PORT}/ws?t=${loadOrCreateToken()}`);
  tab.on("error", () => setTimeout(attach, 200));
  tab.on("open", () => {
    log("tab attached");
    tab.send(JSON.stringify({ t: "ready", sampleRate: 24000 }));
  });

  // The drain contract, as the worklet implements it: report "heard" only once the audio would
  // actually have finished playing, or the call talks over its own sentence.
  let owed = null;
  const settle = () => {
    if (owed !== null) {
      tab.send(JSON.stringify({ t: "drained", id: owed }));
      owed = null;
    }
  };

  tab.on("message", (data, isBinary) => {
    if (isBinary) {
      setTimeout(settle, (data.length / 2 / 24000) * 1000 + 30);
      return;
    }
    const m = JSON.parse(String(data));
    if (m.t === "ask") {
      log(`question shown with ${m.options.length} options`);
      setTimeout(() => {
        if (CLICK) tab.send(JSON.stringify({ t: "pick", index: Number(CLICK) - 1 }));
        else tab.send(JSON.stringify({ t: "start" }));
      }, 300);
    } else if (m.t === "clear") owed = null;
    else if (m.t === "drain") {
      owed = m.id;
      setTimeout(settle, 50);
    } else if (m.t === "mic" && m.on && !spoke) {
      spoke = true;
      log("microphone open — speaking");
      // 20 ms frames, then enough silence for the recorder to call the utterance over. Pace is
      // irrelevant: the recorder measures audio time, not wall clock.
      const FRAME = 960;
      let i = 0;
      const pump = setInterval(() => {
        if (i < answerPcm.length) tab.send(answerPcm.subarray(i, i + FRAME), { binary: true });
        else if (i < answerPcm.length + FRAME * 100) tab.send(Buffer.alloc(FRAME), { binary: true });
        else return clearInterval(pump);
        i += FRAME;
      }, 4);
    } else if (m.t === "report") {
      heard = m.heard ?? null;
      log(`receipt ${JSON.stringify(m.decision)}`);
    } else if (m.t === "superseded") log("SUPERSEDED — another tab is on this port");
  });
};
setTimeout(attach, 300);

setTimeout(() => {
  console.log(`\nTIMED OUT after ${TIMEOUT_MS / 1000}s — the call never came back`);
  child.kill("SIGKILL");
  process.exit(1);
}, TIMEOUT_MS).unref?.();
