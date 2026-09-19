import assert from "node:assert/strict";
import test from "node:test";
import { JevDecisionEngine, type JevEvaluationRunner } from "../src/adapters/decision/jev.js";
import { questionsForDecisionProfile } from "../src/core/decision.js";

test("Jev adapter maps typed answers, usage, and provider confidence", async () => {
  const runner: JevEvaluationRunner = async (input) => {
    assert.equal(input.model, "typesafe-ai/jev");
    assert.equal(input.questions["modelTier"]?.type, "choice");
    return {
      answers: {
        modelTier: {
          type: "choice",
          choice: "balanced",
          probabilities: { cheap: 0.03, balanced: 0.94, strong: 0.03 },
        },
      },
      usage: { inputTokens: 42, outputTokens: 0, totalTokens: 42 },
      warnings: [],
      providerMetadata: { typesafe: { confidence: { modelTier: 0.93 } } },
      response: { modelId: "typesafe-ai/jev" },
    };
  };
  const engine = new JevDecisionEngine("typesafe-ai/jev", { AI_GATEWAY_API_KEY: "test" }, runner);
  assert.equal(engine.status().available, true);
  const evaluated = await engine.evaluate({
    state: { task: "localized UI change" },
    questions: questionsForDecisionProfile("routing"),
    maxRetries: 0,
    timeoutMs: 1_000,
  });
  assert.equal(evaluated.provider, "vercel-ai-gateway");
  assert.deepEqual(evaluated.answers["modelTier"], {
    type: "choice",
    choice: "balanced",
    probabilities: { cheap: 0.03, balanced: 0.94, strong: 0.03 },
  });
  assert.equal(evaluated.confidence?.["modelTier"], 0.93);
  assert.equal(evaluated.usage.inputTokens, 42);
});

test("Jev adapter fails closed when Gateway credentials are unavailable", () => {
  const engine = new JevDecisionEngine("typesafe-ai/jev", {});
  assert.equal(engine.status().available, false);
  assert.match(engine.status().reason ?? "", /AI_GATEWAY_API_KEY/u);
});
