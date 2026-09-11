import assert from "node:assert/strict";
import test from "node:test";
import { ModelMapSchema, ModelTargetSchema } from "../src/core/schema.js";

void test("model variants use a separate field instead of a hash suffix", () => {
  assert.deepEqual(ModelTargetSchema.parse({ model: "openai/gpt-5.6-sol", variant: "high" }), {
    model: "openai/gpt-5.6-sol",
    variant: "high",
  });
  assert.throws(() => ModelTargetSchema.parse({ model: "openai/gpt-5.6-sol#high" }));
});

void test("model map rejects provider-less model identifiers", () => {
  assert.throws(() => ModelMapSchema.parse({
    schemaVersion: 1,
    roles: {
      orchestrator: { model: "gpt", alternative: { model: "provider/model" } },
      explore: { model: "provider/model", alternative: { model: "provider/model" } },
      plan: { model: "provider/model", alternative: { model: "provider/model" } },
      general: { model: "provider/model", alternative: { model: "provider/model" } },
      sddApply: { model: "provider/model", alternative: { model: "provider/model" } },
      judgeA: { model: "provider/model", alternative: { model: "provider/model" } },
      judgeB: { model: "provider/model", alternative: { model: "provider/model" } },
      fix: { model: "provider/model", alternative: { model: "provider/model" } },
      bpExtractor: { model: "provider/model", alternative: { model: "provider/model" } },
      bpArchitect: { model: "provider/model", alternative: { model: "provider/model" } },
      bpTransactor: { model: "provider/model", alternative: { model: "provider/model" } },
    },
  }));
});
