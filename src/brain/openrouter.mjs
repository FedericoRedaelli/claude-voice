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

The developer is LISTENING, not reading. They have heard one short spoken line; the full text
below is what they have NOT heard. Never tell them to read it, never say it is explained
above, never send them back to the terminal — you are the only way that text reaches them.

--- WHAT CLAUDE WROTE ---
${message}
--- END ---

OPTIONS CLAUDE OFFERED:
${list}

Your FIRST job is explaining that text out loud. As long as they are asking about it, keep
answering from it and stay in the conversation. Only pass a decision back to Claude when the
developer has actually decided something or asked for work to be done.

Reply with ONE JSON object, nothing else:

- They asked about anything the text above covers — a question, "explain that better", "what
  does the third one mean", "why" -> {"action":"speak","say":"<the answer, drawn from the text
  above, 1-4 sentences>"}
- They picked an option -> {"action":"decide","kind":"choice","optionIndex":<1-based number>}
- They gave an instruction, a refusal, a change of direction, or a condition on an option ->
  {"action":"decide","kind":"message","value":"<what they said, in their own words>"}
- They said they are done, or there is nothing left to settle ->
  {"action":"decide","kind":"end"}

Rules that matter more than being helpful:
- Explaining, rephrasing, expanding and going deeper into the text above is not guessing —
  it is the job. A question you CAN answer from that text must be answered with "speak".
  Handing it back to Claude makes the developer hear the same summary twice and learn nothing.
- But you know nothing BEYOND that text. Not this project, not its settings, not how to
  configure anything. If the answer is genuinely not in it, do not compose one: reply
  {"action":"decide","kind":"message","value":"<their question, in their own words>"} and
  Claude will answer properly on the next turn. An invented answer is acted on as if true.
- Never turn a refusal into a choice. "not for now", "let's skip that", "leave it out",
  "do the rest instead" are NOT picks, whatever the options say. They are "message", always.
- Only use "choice" when what they said names one of the numbered options or repeats its
  words. If you are reaching for it, it is a "message".
- Do not answer FOR the developer, and do not decide on their behalf because a decision seems
  overdue.
- What you put in "say" will be read out loud. No code, no file paths, no lists.`;
}

// The second source, and the reason it is a model rather than a list of words.
//
// A choice is the one decision Claude acts on directly, so it needs two independent readings
// that agree. The first version of that second reading was a regular expression over ordinals
// in six languages — which is precisely what this file's opening comment says not to do. It
// also failed the case it existed for: asked to pick between four approaches, the user
// declined all of them, named no position, and the list had nothing to say.
//
// This asks a fresh model the narrow question, with no knowledge of what the router decided —
// naming the router's pick would only invite agreement. It gets the words and the options and
// answers with a position or with nothing.
function confirmPrompt({ options, lang }) {
  const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
  return `A developer was asked to choose between numbered options. Below is exactly what they
said, transcribed from speech in ${lang}.

OPTIONS:
${list}

Did they choose one of them? They can do it any way people actually do: by number, by
position, by naming it, by describing it, by agreeing with it. Reply with ONE JSON object:

- They chose one -> {"optionIndex": <1-based number>}
- They did not — they asked something, refused, hesitated, gave a different instruction,
  weighed several out loud, or said something unrelated -> {"optionIndex": null}

Choosing is a positive act. If you are inferring it rather than hearing it, the answer is
null. Null is cheap: the developer's own words go to Claude, who reads them properly. A wrong
number is expensive: Claude acts on an option they never picked.`;
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

// The index a fresh reading found, or null. Anything unexpected — prose, a number nobody
// offered, a missing field — reads as "no choice heard", which costs the user nothing but a
// message going to Claude instead of an option.
export function parseConfirmed(raw, options = []) {
  const text = String(raw ?? "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const i = Number(obj.optionIndex);
  return Number.isInteger(i) && i >= 1 && i <= options.length ? i : null;
}

export function createBrain({ fetchImpl = globalThis.fetch, cfg = config } = {}) {
  const complete = async (messages, { maxTokens = 800 } = {}) => {
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
          max_tokens: maxTokens,
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
          messages,
        }),
      });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`brain ${res.status}: ${detail.slice(0, 300)}`);
    }
    const json = await res.json();
    return json?.choices?.[0]?.message?.content ?? "";
  };

  return {
    async route({ message, options = [], turns = [] }) {
      const raw = await complete([
        { role: "system", content: systemPrompt({ message, options, lang: cfg.lang }) },
        ...turns,
      ]);
      return parseRouted(raw, options);
    },

    // Deliberately given only the words and the options — not Claude's message, not the
    // router's verdict, not the earlier turns. A second opinion that can see the first one is
    // not a second opinion. Short budget: this is one question with a one-token answer.
    async confirmChoice({ options = [], transcript = "" }) {
      if (!options.length || !transcript.trim()) return null;
      const raw = await complete(
        [
          { role: "system", content: confirmPrompt({ options, lang: cfg.lang }) },
          { role: "user", content: transcript },
        ],
        { maxTokens: 300 },
      );
      return parseConfirmed(raw, options);
    },
  };
}
