import assert from "node:assert/strict";
import test from "node:test";
import { TypeSafeDecisionEngine, type TypeSafeFetch } from "../src/adapters/decision/typesafe.js";

const questions = [
  { id: "small", type: "boolean" as const, instructions: "One line?", criteria: { true: "yes", false: "no" } },
  { id: "strategy", type: "choice" as const, instructions: "Classify", criteria: { tweak: "t", bugfix: "b" } },
];

void test("TypeSafe adapter sends noul questions and maps answers, confidence and usage", async () => {
  let sent: Record<string, unknown> = {};
  const fetchImpl: TypeSafeFetch = async (_url, init) => {
    sent = JSON.parse(init.body) as Record<string, unknown>;
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => Promise.resolve({
        model: "jev-1.13.0",
        answers: {
          small: { type: "noul", noul: 0.88 },
          strategy: { type: "choice", choice: "tweak", confidence: 0.97, probabilities: { tweak: 0.97, bugfix: 0.03 } },
        },
        usage: { input_tokens: 395, output_tokens: 73 },
      }),
    });
  };
  const result = await new TypeSafeDecisionEngine("jev-latest", { TYPESAFE_API_KEY: "k" }, fetchImpl).evaluate({ state: "s", questions, maxRetries: 0, timeoutMs: 1_000 });
  assert.equal((sent["questions"] as Record<string, { type: string }>)["small"]?.type, "noul");
  assert.deepEqual(result.answers["small"], { type: "boolean", probability: 0.88 });
  assert.deepEqual(result.answers["strategy"], { type: "choice", choice: "tweak", probabilities: { tweak: 0.97, bugfix: 0.03 } });
  assert.equal(result.confidence?.["strategy"], 0.97);
  assert.deepEqual(result.usage, { inputTokens: 395, outputTokens: 73, totalTokens: 468 });
  assert.equal(result.model, "jev-1.13.0");
});

void test("TypeSafe adapter fails fast on 4xx, retries 5xx, and reports a missing key", async () => {
  let calls = 0;
  const failing = (status: number): TypeSafeFetch => async () => {
    calls += 1;
    return Promise.resolve({ ok: false, status, statusText: "err", json: async () => Promise.resolve({ detail: { message: "Invalid request." } }) });
  };
  await assert.rejects(new TypeSafeDecisionEngine("m", { TYPESAFE_API_KEY: "k" }, failing(400)).evaluate({ state: "s", questions, maxRetries: 2, timeoutMs: 1_000 }), /TypeSafe 400: Invalid request/u);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(new TypeSafeDecisionEngine("m", { TYPESAFE_API_KEY: "k" }, failing(503)).evaluate({ state: "s", questions, maxRetries: 2, timeoutMs: 1_000 }), /TypeSafe 503/u);
  assert.equal(calls, 3);
  assert.equal(new TypeSafeDecisionEngine("m", {}).status().available, false);
});
