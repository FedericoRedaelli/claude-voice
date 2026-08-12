// Speech-to-text through OpenRouter.
//
// The endpoint takes either OpenAI-style multipart or plain JSON with the audio base64'd
// inside it. JSON wins here: no multipart assembly, no temp file, and the whole request is
// one object you can print when something goes wrong. The cost is ~33% more bytes on the
// wire for an utterance that lasts a couple of seconds — a trade worth making.
//
// We are billed per second of audio, so an empty buffer must never become a request.

import { config } from "../config.mjs";
import { pcmToWav } from "../pcm.mjs";

export function createStt({ fetchImpl = globalThis.fetch, cfg = config } = {}) {
  return {
    async transcribe(pcm) {
      if (!pcm || !pcm.length) return "";

      const res = await fetchImpl(`${cfg.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.openrouterKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.sttModel,
          input_audio: { data: pcmToWav(pcm).toString("base64"), format: "wav" },
          // Without the hint the transcriber guesses per utterance, and a short Italian answer
          // guessed as English is how "la terza" once came back as "Certa".
          ...(cfg.langCode ? { language: cfg.langCode } : {}),
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`stt ${res.status}: ${detail.slice(0, 300)}`);
      }
      const json = await res.json();
      return String(json?.text ?? "").trim();
    },
  };
}
