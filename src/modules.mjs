// The registry: the file that makes "swappable module" true rather than aspirational.
//
// Every slot maps a NAME to a lazy import. Lazy matters twice over: a text-mode session must
// never open a port or touch the network, and a future local engine must not be loaded on a
// machine that only ever uses the cloud one.
//
// Nothing here knows what the modules do. It knows their names, and that each exposes a
// factory called create<Slot>.

import { config } from "./config.mjs";

const REGISTRY = {
  audio: {
    browser: () => import("./audio/browser.mjs").then((m) => m.createAudio),
    // The audio slot is the one a test can genuinely do without: call.mjs is handed fakes.
    none: () => Promise.resolve(() => null),
  },
  tts: {
    openrouter: () => import("./tts/openrouter.mjs").then((m) => m.createTts),
  },
  stt: {
    openrouter: () => import("./stt/openrouter.mjs").then((m) => m.createStt),
  },
  brain: {
    openrouter: () => import("./brain/openrouter.mjs").then((m) => m.createBrain),
  },
};

export async function loadModule(slot, name, cfg = config) {
  const impls = REGISTRY[slot];
  if (!impls) {
    throw new Error(`unknown module slot "${slot}" — known slots: ${Object.keys(REGISTRY).join(", ")}`);
  }
  const load = impls[name];
  if (!load) {
    throw new Error(
      `unknown ${slot} implementation "${name}" — available: ${Object.keys(impls).join(", ")}`,
    );
  }
  const create = await load();
  return create({ cfg });
}

export async function loadModules(cfg = config) {
  const [audio, tts, stt, brain] = await Promise.all([
    loadModule("audio", cfg.audio, cfg),
    loadModule("tts", cfg.tts, cfg),
    loadModule("stt", cfg.stt, cfg),
    loadModule("brain", cfg.brain, cfg),
  ]);
  return { audio, tts, stt, brain };
}
