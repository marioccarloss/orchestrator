import { test } from "bun:test";
import assert from "node:assert/strict";
import { assessRiskLane, classifyRiskLane } from "../src/core/risk.js";

test("auth changes are critical even at difficulty one", () => {
  const assessment = assessRiskLane({
    difficulty: 1,
    evidence: { count: 1, fresh: true },
    atlasImpact: 1,
    touchedAreas: ["src/Auth/LoginService.ts"],
    touchedFiles: ["src/Auth/LoginService.ts"],
  });
  assert.equal(assessment.lane, "critical");
  assert.ok(assessment.reasons.some((reason) => reason.includes("auth")));
});

test("large Atlas impact is critical and high difficulty is full", () => {
  assert.equal(classifyRiskLane({ difficulty: 1, evidence: 1, atlasImpact: 15, touchedAreas: ["src/a.ts"] }), "critical");
  assert.equal(classifyRiskLane({ difficulty: 5, evidence: 1, atlasImpact: 1, touchedAreas: ["src/a.ts"] }), "full");
});

test("small bounded work is fast and the remainder is standard", () => {
  assert.equal(classifyRiskLane({ difficulty: 3, evidence: 0, atlasImpact: 3, touchedAreas: ["src/a.ts", "src/b.ts"] }), "fast");
  assert.equal(classifyRiskLane({ difficulty: 3, evidence: 2, atlasImpact: 4, touchedAreas: ["src/a.ts", "src/b.ts", "src/c.ts"] }), "standard");
});

test("repository rules extend critical areas", () => {
  assert.equal(classifyRiskLane({
    difficulty: 1,
    evidence: 1,
    atlasImpact: 1,
    touchedAreas: ["src/compliance/audit.ts"],
    rules: { criticalAreas: ["compliance"] },
  }), "critical");
});
