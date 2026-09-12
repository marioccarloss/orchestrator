import assert from "node:assert/strict";
import test from "node:test";
import {
  GROUNDING_CONTRACT,
  INSUFFICIENT_EVIDENCE,
  InsufficientEvidenceSchema,
} from "../src/core/grounding.js";

test("grounding contract defines one canonical insufficient-evidence sentinel", () => {
  assert.ok(GROUNDING_CONTRACT.includes(INSUFFICIENT_EVIDENCE));
  assert.ok(GROUNDING_CONTRACT.includes("Never invent"));
  assert.ok(GROUNDING_CONTRACT.includes("Evidence present"));
  assert.ok(GROUNDING_CONTRACT.includes("Evidence absent"));
});

test("insufficient evidence requires actionable missing context", () => {
  assert.ok(InsufficientEvidenceSchema.safeParse({
    status: INSUFFICIENT_EVIDENCE,
    missing: ["current source implementation"],
    nextAction: "read the defining function",
  }).success);
  assert.equal(InsufficientEvidenceSchema.safeParse({
    status: INSUFFICIENT_EVIDENCE,
    missing: [],
    nextAction: "guess",
  }).success, false);
});
