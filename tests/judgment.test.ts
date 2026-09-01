import { test } from "bun:test";
import assert from "node:assert/strict";
import { mergeVerdicts, createFixLoop, canContinueFixLoop, recordFixAttempt, shouldEscalateToHuman, buildJudgePrompt, buildFixPrompt } from "../src/core/judgment.js";
import type { JudgeVerdict } from "../src/core/flow-schema.js";

const verdictA: JudgeVerdict = {
  schemaVersion: 1,
  judge: "a",
  approved: false,
  critical: ["Missing null check"],
  warnings: ["Consider caching"],
  suggestions: ["Add docs"],
  reviewedAt: "2026-08-31T12:00:00.000Z",
};

const verdictB: JudgeVerdict = {
  schemaVersion: 1,
  judge: "b",
  approved: true,
  critical: [],
  warnings: ["Consider caching"],
  suggestions: ["Add tests", "Add docs"],
  reviewedAt: "2026-08-31T12:00:00.000Z",
};

test("mergeVerdicts combines both judges", () => {
  const merged = mergeVerdicts(verdictA, verdictB);
  assert.equal(merged.approved, false); // Both must approve
  assert.deepEqual(merged.critical, ["Missing null check"]);
  assert.deepEqual(merged.warnings, ["Consider caching"]);
  assert.deepEqual(merged.suggestions, ["Add docs", "Add tests"]);
});

test("mergeVerdicts approves only when both approve", () => {
  const bothApprove = mergeVerdicts(
    { ...verdictA, approved: true },
    { ...verdictB, approved: true },
  );
  assert.equal(bothApprove.approved, true);
});

test("createFixLoop initializes correctly", () => {
  const loop = createFixLoop(3);
  assert.equal(loop.maxAttempts, 3);
  assert.equal(loop.attempts.length, 0);
  assert.equal(loop.currentAttempt, 0);
});

test("canContinueFixLoop respects max attempts", () => {
  let loop = createFixLoop(2);
  assert.equal(canContinueFixLoop(loop), true);
  loop = recordFixAttempt(loop, mergeVerdicts(verdictA, verdictB), "hash1");
  assert.equal(canContinueFixLoop(loop), true);
  loop = recordFixAttempt(loop, mergeVerdicts(verdictA, verdictB), "hash2");
  assert.equal(canContinueFixLoop(loop), false);
});

test("shouldEscalateToHuman after max attempts", () => {
  let loop = createFixLoop(1);
  loop = recordFixAttempt(loop, mergeVerdicts(verdictA, verdictB), "hash1");
  assert.equal(shouldEscalateToHuman(loop), true);
});

test("shouldEscalateToHuman on repeated critical issues", () => {
  let loop = createFixLoop(3);
  const verdict = mergeVerdicts(verdictA, verdictB);
  loop = recordFixAttempt(loop, verdict, "hash1");
  loop = recordFixAttempt(loop, verdict, "hash2");
  assert.equal(shouldEscalateToHuman(loop), true);
});

test("buildJudgePrompt includes diff and judge name", () => {
  const prompt = buildJudgePrompt("diff content", "a");
  assert.ok(prompt.includes("Judge A"));
  assert.ok(prompt.includes("diff content"));
  assert.ok(prompt.includes("approved"));
  assert.ok(prompt.includes("critical"));
});

test("buildFixPrompt includes verdict and diff", () => {
  const merged = mergeVerdicts(verdictA, verdictB);
  const prompt = buildFixPrompt(merged, "original diff");
  assert.ok(prompt.includes("Missing null check"));
  assert.ok(prompt.includes("original diff"));
  assert.ok(prompt.includes("mr-fix"));
});
