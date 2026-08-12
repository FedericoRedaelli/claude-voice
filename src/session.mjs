// Dispatches a stopping-point hand-off to the voice or text path and returns a normalized
// decision: { kind: "choice"|"message"|"end", value?: string }.

import { config } from "./config.mjs";
import { runTextSession } from "./text.mjs";

let modules = null;

// `signal` aborts when Claude Code cancels the tool call (the user pressed Esc): the session
// must go silent and return, not keep talking to nobody.
// `spoken` is the opening line Claude wrote to be read verbatim. Text mode ignores it on
// purpose: it prints `message`, which is the full version, and reading a line meant for the
// ear off a screen would just be a worse summary of what is already there.
export async function runSession({ message, options = [], spoken = "", signal }) {
  if (config.mode === "text") return runTextSession({ message, options, signal });

  try {
    // Lazy on purpose: text mode must never open a port, load a module, or need a key.
    const [{ runCall }, { loadModules }] = await Promise.all([
      import("./call.mjs"),
      import("./modules.mjs"),
    ]);
    modules = modules || (await loadModules());
    return await runCall({ message, options, spoken, signal, modules });
  } catch (err) {
    // A missing key, a provider outage, a tab that never opened: the voice is optional, the
    // decision is not. Fall back to the terminal rather than losing Claude's turn.
    process.stderr.write(
      `[claude-voice] voice path failed (${String(err?.message ?? err)}) — falling back to text\n`,
    );
    return runTextSession({ message, options, signal });
  }
}

// Server shutdown (SIGTERM/SIGINT, stdin closed): release the port and let the process exit.
// No-op if the voice path was never loaded — we must not open a bridge just to shut one down.
export function abortActiveSessions() {
  modules?.audio?.close?.();
  modules = null;
}
