#!/usr/bin/env node
// One real call, end to end, with the clock running on every stage. This is how the three
// open questions in the spec get answered: perceived latency, the accent, and whether
// GPT-OSS-20B closes the call at the right moment.

import { runCall } from "../src/call.mjs";
import { config } from "../src/config.mjs";
import { loadModules } from "../src/modules.mjs";

const MESSAGE = `Ho riscritto il motore vocale su OpenRouter: tre moduli separati per voce,
ascolto e ragionamento, dietro interfacce sostituibili. I test passano, 42 su 42. Restano due
cose da decidere prima di aprire la pull request: se tenere il fallback testuale attivo di
default, e se misurare i provider adesso o dopo la prima settimana d'uso.`;

const OPTIONS = ["Apri la pull request", "Misura prima i provider", "Fermati qui"];

const stamp = (label, t0) => console.log(`  ${label}: ${Date.now() - t0} ms`);

const modules = await loadModules();

// Wrap each module so the timings come from the real thing, not from a guess.
for (const [name, method] of [
  ["tts", "speak"],
  ["stt", "transcribe"],
  ["brain", "route"],
]) {
  const inner = modules[name][method].bind(modules[name]);
  modules[name][method] = async (...args) => {
    const t0 = Date.now();
    try {
      return await inner(...args);
    } finally {
      stamp(name, t0);
    }
  };
}

const t0 = Date.now();
const decision = await runCall({
  message: MESSAGE,
  options: OPTIONS,
  spoken: "Ho finito il motore vocale. Apro la pull request, misuro prima i provider, o mi fermo?",
  modules,
  cfg: config,
});

console.log(`\ndecisione: ${JSON.stringify(decision)}`);
console.log(`totale: ${Date.now() - t0} ms`);
await modules.audio?.close?.();
process.exit(0);
