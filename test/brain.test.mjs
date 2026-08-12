import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrain, parseRouted } from "../src/brain/openrouter.mjs";

const OPTIONS = ["Apri la pull request", "Fai altri test", "Fermati qui"];

const cfg = {
  openrouterKey: "sk-test",
  baseUrl: "https://openrouter.ai/api/v1",
  brainModel: "openai/gpt-oss-20b",
  brainSort: "throughput",
  lang: "Italiano",
};

const reply = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

function fakeFetch(response) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return response;
    },
  };
}

test("a picked option becomes a choice carrying the option's own words", () => {
  const out = parseRouted('{"action":"decide","kind":"choice","optionIndex":1}', OPTIONS);
  assert.deepEqual(out, {
    kind: "decide",
    decision: { kind: "choice", value: "Apri la pull request", optionIndex: 1 },
  });
});

test("a new instruction becomes a message carrying the user's words", () => {
  const out = parseRouted(
    '{"action":"decide","kind":"message","value":"fai la prima ma senza i test"}',
    OPTIONS,
  );
  assert.deepEqual(out, {
    kind: "decide",
    decision: { kind: "message", value: "fai la prima ma senza i test" },
  });
});

test("a question becomes something to say, and the call stays open", () => {
  const out = parseRouted('{"action":"speak","say":"Il punto sei riguarda i test."}', OPTIONS);
  assert.deepEqual(out, { kind: "speak", text: "Il punto sei riguarda i test." });
});

test("done means end, and end never carries a value", () => {
  const out = parseRouted('{"action":"decide","kind":"end","value":"basta"}', OPTIONS);
  assert.deepEqual(out, { kind: "decide", decision: { kind: "end" } });
});

test("JSON wrapped in a code fence still parses — small models keep doing this", () => {
  const raw = '```json\n{"action":"speak","say":"Certo."}\n```';
  assert.deepEqual(parseRouted(raw, OPTIONS), { kind: "speak", text: "Certo." });
});

test("prose around the JSON still parses", () => {
  const raw = 'Ecco la risposta: {"action":"speak","say":"Va bene."} spero sia utile';
  assert.deepEqual(parseRouted(raw, OPTIONS), { kind: "speak", text: "Va bene." });
});

test("unparseable output hands the turn to Claude instead of guessing", () => {
  assert.deepEqual(parseRouted("non ho capito niente", OPTIONS), {
    kind: "decide",
    decision: { kind: "message", value: "non ho capito niente" },
  });
});

test("an option index outside the offered range is not a choice", () => {
  const out = parseRouted('{"action":"decide","kind":"choice","optionIndex":9}', OPTIONS);
  assert.equal(out.decision.kind, "message", "Claude must never act on an option nobody offered");
});

test("route sends Claude's full message as context and the turns as history", async () => {
  const { calls, fetchImpl } = fakeFetch(reply('{"action":"speak","say":"ok"}'));

  await createBrain({ fetchImpl, cfg }).route({
    message: "Ho toccato quattro file e i test passano.",
    options: OPTIONS,
    turns: [{ role: "user", content: "cosa hai cambiato?" }],
  });

  const body = calls[0].body;
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(body.model, "openai/gpt-oss-20b");

  const system = body.messages[0];
  assert.equal(system.role, "system");
  assert.match(system.content, /Ho toccato quattro file/, "the full context goes in");
  assert.match(system.content, /1\. Apri la pull request/, "so do the numbered options");
  assert.match(system.content, /Italiano/, "and the language to answer in");

  assert.deepEqual(body.messages.slice(1), [{ role: "user", content: "cosa hai cambiato?" }]);
});

test("the request asks for a fast provider and leaves the model room to finish", async () => {
  const { calls, fetchImpl } = fakeFetch(reply('{"action":"speak","say":"ok"}'));
  await createBrain({ fetchImpl, cfg }).route({ message: "m", options: [], turns: [] });

  // Measured: the same model runs 0.3 s on one provider and 20.6 s on another.
  assert.deepEqual(calls[0].body.provider, { sort: "throughput" });
  // GPT-OSS spends the token budget thinking before it answers; at 300 it returned nothing
  // about one turn in three.
  assert.equal(calls[0].body.reasoning.effort, "low");
  assert.ok(calls[0].body.max_tokens >= 800);
});

test("no sort is sent when the choice is handed back to the router", async () => {
  const { calls, fetchImpl } = fakeFetch(reply('{"action":"speak","say":"ok"}'));
  await createBrain({ fetchImpl, cfg: { ...cfg, brainSort: "" } }).route({
    message: "m",
    options: [],
    turns: [],
  });
  assert.ok(!("provider" in calls[0].body));
});

test("an empty answer is not an empty instruction for Claude", () => {
  // A truncated reasoning model returns content: "". Passing that through as a message would
  // hand Claude a blank instruction and call it a decision.
  assert.deepEqual(parseRouted("", OPTIONS), { kind: "empty" });
  assert.deepEqual(parseRouted("   ", OPTIONS), { kind: "empty" });
});

test("an error response throws with the status", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => "slow down" });
  await assert.rejects(
    () => createBrain({ fetchImpl, cfg }).route({ message: "m", options: [], turns: [] }),
    /429/,
  );
});
