import assert from "node:assert/strict";
import test from "node:test";
import { ModelMapSchema } from "../src/core/schema.js";

void test("model map rejects provider-less model identifiers", () => {
  assert.throws(() => ModelMapSchema.parse({
    schemaVersion: 1,
    roles: {
      orchestrator: "gpt",
      explore: "provider/model",
      plan: "provider/model",
      general: "provider/model",
      sddApply: "provider/model",
      judgeA: "provider/model",
      judgeB: "provider/model",
      fix: "provider/model",
    },
  }));
});
