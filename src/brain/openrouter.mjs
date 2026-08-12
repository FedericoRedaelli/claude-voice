// The conductor: the model that decides, turn by turn, whether you are choosing, asking, or
// done.
//
// Why a model and not rules: the first version of this project routed on words — "la prima"
// meant a choice, "basta" meant hang up. Those are Italian words in the source code, and an
// English speaker gets a broken product.
//
// Why a small model is enough: Claude is always one turn away. Anything this model cannot
// answer leaves as kind:"message" and Claude answers it next turn. It has to cover the easy
// 80% in half a second, not to be clever.
//
// Its only knowledge of the world is Claude's `message`. That is deliberate — it is a bridge,
// not a second opinion, and a bridge that invents facts is worse than no bridge.

import { config } from "../config.mjs";

function systemPrompt({ message, options, lang }) {
  const list = options.length
    ? options.map((o, i) => `${i + 1}. ${o}`).join("\n")
    : "(nessuna opzione offerta)";

  return `You are the voice bridge between a developer and Claude Code. Claude has just
finished a piece of work and needs an answer. You speak for Claude and you listen for the
developer. Answer in ${lang}.

Everything you know is below. Never state a fact that is not in it.

--- WHAT CLAUDE WROTE ---
${message}
--- END ---

OPTIONS CLAUDE OFFERED:
${list}

Decide what the developer's last turn means and reply with ONE JSON object, nothing else:

- They picked an option -> {"action":"decide","kind":"choice","optionIndex":<1-based number>}
- They gave a different instruction, or a condition on an option ->
  {"action":"decide","kind":"message","value":"<their instruction, in their own words>"}
- They asked something WHOSE ANSWER IS WRITTEN ABOVE ->
  {"action":"speak","say":"<answer, max 2 sentences, quoting only what is above>"}
- They said they are done, or there is nothing left to settle ->
  {"action":"decide","kind":"end"}

Rules that matter more than being helpful:
- You know NOTHING except the text above. Not this project, not its settings, not how to
  configure anything. If the answer is not written above, you must NOT compose one: reply
  {"action":"decide","kind":"message","value":"<their question, in their own words>"} and
  Claude will answer it properly on the next turn. Guessing is the worst thing you can do
  here — a plausible invented answer is acted on as if it were true.
- Do not answer FOR the developer. If their turn is not clearly one of the four, choose
  "message" and let Claude handle it.
- Only use "choice" when what they said really maps to one of the numbered options.
- What you put in "say" will be read out loud. No code, no file paths, no lists.`;
}

// Small models wrap JSON in fences, add a sentence before it, or answer in prose. None of
// that is a failure worth losing a turn over: pull the object out if it is in there, and if
// it truly is not, hand the raw words to Claude as an instruction. Claude is one turn away.
export function parseRouted(raw, options = []) {
  const text = String(raw ?? "").trim();
  // A reasoning model that spent its budget thinking answers with nothing at all. That is not
  // an instruction from the user, and forwarding it as one would hand Claude a blank decision.
  if (!text) return { kind: "empty" };
  const asMessage = { kind: "decide", decision: { kind: "message", value: text } };

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return asMessage;

  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return asMessage;
  }

  if (obj.action === "speak") {
    const say = String(obj.say ?? "").trim();
    return say ? { kind: "speak", text: say } : asMessage;
  }

  if (obj.kind === "end") return { kind: "decide", decision: { kind: "end" } };

  if (obj.kind === "choice") {
    const i = Number(obj.optionIndex);
    // An index nobody offered is the single most expensive mistake here: Claude would act on
    // an option the user never picked. Downgrade instead of guessing.
    if (Number.isInteger(i) && i >= 1 && i <= options.length) {
      return { kind: "decide", decision: { kind: "choice", value: options[i - 1], optionIndex: i } };
    }
    const value = String(obj.value ?? "").trim();
    return { kind: "decide", decision: { kind: "message", value: value || text } };
  }

  const value = String(obj.value ?? "").trim();
  return { kind: "decide", decision: { kind: "message", value: value || text } };
}

export function createBrain({ fetchImpl = globalThis.fetch, cfg = config } = {}) {
  return {
    async route({ message, options = [], turns = [] }) {
      const res = await fetchImpl(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.openrouterKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.brainModel,
          temperature: 0.2,
          // GPT-OSS is a reasoning model: the budget covers its thinking as well as its
          // answer. At 300 it spent the lot thinking and returned an empty message about one
          // turn in three. Low effort plus room to finish is what a router needs — it is
          // deciding which of four shapes a sentence has, not solving anything.
          max_tokens: 800,
          reasoning: { effort: "low" },
          // Not belt and braces — the one thing that makes this model usable. GPT-OSS splits
          // its output into a reasoning channel and a final one, and on the fast providers the
          // final channel came back EMPTY 4 times in 10 while the reasoning plainly said
          // "choose option 1". finish_reason was "stop", so nothing looked wrong. Asking for a
          // JSON object took that to 0 in 12, at the same latency.
          ...(cfg.brainJson === false ? {} : { response_format: { type: "json_object" } }),
          // Named providers win over the sort: naming one is a deliberate act, sorting is a
          // preference. Neither is sent when neither is configured.
          ...(cfg.brainProviders?.length
            ? { provider: { only: cfg.brainProviders } }
            : cfg.brainSort
              ? { provider: { sort: cfg.brainSort } }
              : {}),
          messages: [
            { role: "system", content: systemPrompt({ message, options, lang: cfg.lang }) },
            ...turns,
          ],
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`brain ${res.status}: ${detail.slice(0, 300)}`);
      }
      const json = await res.json();
      return parseRouted(json?.choices?.[0]?.message?.content ?? "", options);
    },
  };
}
