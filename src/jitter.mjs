// A jitter buffer in front of the speaker.
//
// The model streams its reply in bursts over a websocket, and we hand each burst straight to
// sox, which plays it immediately. When the next burst is late — a slow hop, a busy machine —
// sox has nothing left to play, goes silent mid-word, and resumes when audio arrives. From the
// far end that sounds exactly like the agent losing its train of thought and catching up.
//
// The fix is to stay one gulp ahead: hold the first `jitterMs` of audio back, then write
// through. That head start is what the stream spends during a stall instead of silence. It
// costs the same `jitterMs` of extra latency before the first word, once per turn.
export function createJitterBuffer({ jitterMs = 250, bytesPerMs = 48 } = {}) {
  const need = jitterMs * bytesPerMs;
  let held = [];
  let heldBytes = 0;
  let primed = jitterMs <= 0;

  return {
    // Returns the buffer to write now, or null while still filling the cushion.
    push(buf) {
      if (primed) return buf;
      held.push(buf);
      heldBytes += buf.length;
      if (heldBytes < need) return null;
      const out = Buffer.concat(held);
      held = [];
      heldBytes = 0;
      primed = true;
      return out;
    },
    // Everything still held back — call before closing, or the tail of a reply shorter than
    // the cushion would never be played at all.
    drain() {
      if (!held.length) return null;
      const out = Buffer.concat(held);
      held = [];
      heldBytes = 0;
      primed = true;
      return out;
    },
    // A new turn starts a new cushion: the gap between turns is not a stall to ride out.
    reset() {
      held = [];
      heldBytes = 0;
      primed = jitterMs <= 0;
    },
    get pendingBytes() {
      return heldBytes;
    },
    get primed() {
      return primed;
    },
  };
}
