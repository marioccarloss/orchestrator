import assert from "node:assert/strict";
import test from "node:test";
import { chooseGatewayModel, modelsFromCandidates, parseGatewayCatalog, shortlist } from "../src/core/choose-model.js";

const catalog = parseGatewayCatalog({
  data: [
    { id: "cheap/tools", name: "Cheap", type: "language", tags: ["tool-use"], context_window: 200000, pricing: { input: "0.0000002", output: "0.000001" }, description: "barato" },
    { id: "strong/reason", name: "Strong", type: "language", tags: ["reasoning", "tool-use"], context_window: 200000, pricing: { input: "0.00002", output: "0.00008" }, description: "caro" },
    { id: "embed/one", name: "Embed", type: "embedding", tags: [], context_window: 8000, pricing: { input: "0.0000001", output: "0" } },
  ],
});

void test("shortlist keeps language models and prefers a cheap tool model when cost matters", () => {
  const picked = shortlist(catalog, { tools: 1, vision: 0, reasoning: 0.2, longContext: 1, cheap: 1 });
  assert.equal(picked[0]?.id, "cheap/tools");
  assert.equal(picked.some((model) => model.id === "embed/one"), false);
});

void test("modelsFromCandidates keeps the agent shortlist and its price notes", () => {
  const models = modelsFromCandidates([
    { id: "openai/gpt-6.1", note: "más barato que gpt-5.6 según la página de precios" },
    { id: "deepseek/deepseek-v4", note: "código barato" },
  ]);
  assert.equal(models[0]?.id, "openai/gpt-6.1");
  assert.match(models[0]?.description ?? "", /gpt-5\.6/);
});

void test("chooseGatewayModel returns the Jev choice among the shortlist", async () => {
  const result = await chooseGatewayModel("agente de código barato", catalog, async (_state, questions) => {
    if ("best" in questions) {
      return {
        model: "jev-1.13.0",
        answers: { best: { choice: "cheap/tools", confidence: 0.7, probabilities: { "cheap/tools": 0.7, "strong/reason": 0.3 } } },
      };
    }
    return { answers: { tools: { noul: 0.9 }, vision: { noul: 0 }, reasoning: { noul: 0.2 }, longContext: { noul: 0.8 }, cheap: { noul: 0.9 } } };
  });
  assert.equal(result.format, "json");
  assert.equal(result.winnerId, "cheap/tools");
  assert.equal(result.ranking[0]?.id, "cheap/tools");
  assert.equal(result.jevModel, "jev-1.13.0");
});

void test("scoring format ranks by Jev score", async () => {
  const result = await chooseGatewayModel("explore", catalog, async (_state, questions) => {
    if ("tools" in questions) {
      return { answers: { tools: { noul: 0.2 }, vision: { noul: 0 }, reasoning: { noul: 0.2 }, longContext: { noul: 0.4 }, cheap: { noul: 0.5 } } };
    }
    return { model: "jev-1.13.0", answers: { "cheap/tools": { score: 1 }, "strong/reason": { score: 2 } } };
  }, "scoring");
  assert.equal(result.format, "scoring");
  assert.equal(result.winnerId, "strong/reason");
  assert.equal(result.scoring[0]?.score, 2);
});
