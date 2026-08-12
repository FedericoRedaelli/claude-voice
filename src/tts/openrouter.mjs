// Text-to-speech through OpenRouter.
//
// Two things about this endpoint are not like the rest of the API: it answers with raw audio
// bytes rather than JSON, and `response_format: "pcm"` gives us exactly the currency the rest
// of the project speaks — PCM16 mono @ 24 kHz — so nothing has to decode or resample.
//
// The text handed here is spoken VERBATIM. Claude wrote it for the ear; no model rewrites it,
// which is why the spoken line costs no tokens at all.

import { config } from "../config.mjs";

export function createTts({ fetchImpl = globalThis.fetch, cfg = config } = {}) {
  return {
    async speak(text) {
      const input = String(text ?? "").trim();
      if (!input) return Buffer.alloc(0);

      const res = await fetchImpl(`${cfg.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.openrouterKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.ttsModel,
          input,
          voice: cfg.ttsVoice,
          response_format: "pcm",
          speed: cfg.speed,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`tts ${res.status}: ${detail.slice(0, 300)}`);
      }
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
