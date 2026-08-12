// Raw PCM helpers: the format every module in this project speaks, and the three things
// you have to do to it that have no home anywhere else.
//
// PCM16 mono little-endian @ 24 kHz. 48000 bytes = one second. That rate is not a taste:
// it is what MAI-Voice-2 emits and what the page's AudioWorklet runs at, so keeping it
// everywhere means the audio is never resampled between the model and the speaker.

export const RATE = 24000;
export const BYTES_PER_SEC = RATE * 2;

export function durationMs(pcm) {
  return (pcm.length / BYTES_PER_SEC) * 1000;
}

// Whisper wants a container, not loose samples. This is the smallest one that says
// "PCM16 mono at 24 kHz": 44 bytes in front of the buffer we already have.
export function pcmToWav(pcm, { rate = RATE, channels = 1, bits = 16 } = {}) {
  const head = Buffer.alloc(44);
  const blockAlign = (channels * bits) / 8;
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16); // fmt chunk length
  head.writeUInt16LE(1, 20); // 1 = uncompressed PCM
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * blockAlign, 28);
  head.writeUInt16LE(blockAlign, 32);
  head.writeUInt16LE(bits, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// Level in percent. Room tone sits well under 1; a voice at laptop distance is in the teens.
// This is what decides when an utterance has ended, so it stays cheap and boring.
export function rmsPct(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n) * 100;
}

// The cue that says "Claude is waiting for you". A short sine, optionally after a beat of
// silence so it doesn't collide with whatever the speaker was doing.
export function beepPcm({ freq = 880, ms = 160, volume = 0.25, leadMs = 0 } = {}) {
  const lead = Math.round((leadMs / 1000) * RATE);
  const n = Math.round((ms / 1000) * RATE);
  const buf = Buffer.alloc((lead + n) * 2);
  for (let i = 0; i < n; i++) {
    // Fade both ends: a square-edged tone clicks, and a click is indistinguishable from a
    // fault when it comes out of a laptop speaker.
    const fade = Math.min(1, i / 240, (n - i) / 240);
    const s = Math.sin((2 * Math.PI * freq * i) / RATE) * volume * fade;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), (lead + i) * 2);
  }
  return buf;
}
