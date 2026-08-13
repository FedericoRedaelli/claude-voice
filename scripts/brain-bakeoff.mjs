#!/usr/bin/env node
// Compare routing models on the only question that matters: does it decide what the user
// actually said, or does it invent a choice?
//
// No audio, no synthesis, no transcription — just brain.route() and brain.confirmChoice() on
// fixed transcripts, repeated, so the numbers mean something. That isolation is the point: a
// full voice run mixes in Whisper's mistakes and the turn loop, and then a bad answer has three
// possible authors.
//
// The expensive failure is not "picked the wrong option". It is "picked an option at all when
// the user asked for something the options do not cover" — Claude then acts on a decision
// nobody made. The second reading exists to catch exactly that, so it is measured too.
//
//   node scripts/brain-bakeoff.mjs
//   node scripts/brain-bakeoff.mjs --models openai/gpt-oss-20b,openai/gpt-oss-120b --runs 5

import { config } from "../src/config.mjs";
import { createBrain } from "../src/brain/openrouter.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const MODELS = flag("models", "openai/gpt-oss-20b,openai/gpt-oss-120b").split(",");
const RUNS = Number(flag("runs", 3));

const MESSAGE =
  "Ho finito il restyle della pagina e i test passano. Posso committare, oppure aggiungere " +
  "prima un test di integrazione sul bridge, che oggi non ne ha nessuno.";
const OPTIONS = ["Committa pure", "Aggiungi prima il test sul bridge"];

// Each case says what the RIGHT answer is, and why getting it wrong is expensive.
const CASES = [
  { said: "facciamo la seconda", want: "choice", detail: "index 2" },
  { said: "la prima, dai", want: "choice", detail: "index 1" },
  { said: "committa pure", want: "choice", detail: "index 1, named" },
  // The one this whole project exists for: the user declined every option. Reporting a choice
  // here makes Claude act on something nobody chose.
  { said: "no, per ora lasciamo stare, fammi prima un riassunto di cosa hai cambiato", want: "message" },
  { said: "aspetta, prima spiegami cosa fa il test sul bridge", want: "speak-or-message" },
  { said: "fai la prima ma prima mostrami il diff", want: "message" },
];

const kindOf = (r) => (r.kind === "decide" ? r.decision?.kind : r.kind);

for (const model of MODELS) {
  console.log(`\n=== ${model} ===`);
  const brain = createBrain({ cfg: { ...config, brainModel: model } });
  let wrong = 0;
  let invented = 0;
  let total = 0;

  for (const c of CASES) {
    const seen = [];
    for (let i = 0; i < RUNS; i++) {
      total++;
      let kind;
      let confirmed = "-";
      try {
        const routed = await brain.route({
          message: MESSAGE,
          options: OPTIONS,
          turns: [{ role: "user", content: c.said }],
        });
        kind = kindOf(routed) ?? "?";
        // The second reading never sees the router's verdict. When it hears no choice, the
        // pipeline downgrades to the user's own words — so a router that invents a choice is
        // only dangerous when the confirmer agrees with it.
        if (kind === "choice") {
          const idx = await brain.confirmChoice({ options: OPTIONS, transcript: c.said });
          confirmed = idx === null ? "refused" : `agreed:${idx}`;
          if (c.want === "message" && idx !== null) invented++;
        }
      } catch (e) {
        kind = `error(${String(e?.message ?? e).slice(0, 40)})`;
      }
      seen.push(`${kind}/${confirmed}`);

      const ok =
        c.want === "speak-or-message"
          ? kind === "speak" || kind === "message"
          : kind === c.want;
      if (!ok) wrong++;
    }
    console.log(`  want ${c.want.padEnd(17)} "${c.said.slice(0, 46)}"`);
    console.log(`    -> ${seen.join("  ")}`);
  }

  console.log(`  ${total - wrong}/${total} as wanted; ${invented} invented a choice the user refused`);
}
