import test from "node:test";
import assert from "node:assert/strict";
import { mergeVerdicts, createFixLoop, canContinueFixLoop, recordFixAttempt, shouldEscalateToHuman, buildJudgePrompt, buildFixPrompt, validateJudgeFindings, visibleDiffLines } from "../src/core/judgment.js";
import type { JudgeVerdict } from "../src/core/flow-schema.js";

const DIFF_HASH = "a".repeat(64);
const verdictA: JudgeVerdict = {
  schemaVersion: 1,
  judge: "a",
  status: "SUPPORTED",
  approved: false,
  diffHash: DIFF_HASH,
  findings: [
    { severity: "critical", claim: "Missing null check", file: "src/a.ts", line: 2, side: "new", source: "diff", evidence: "return input.value" },
    { severity: "warning", claim: "Consider caching", file: "src/a.ts", line: 2, side: "new", source: "diff", evidence: "input.value" },
    { severity: "suggestion", claim: "Add docs", file: "src/a.ts", line: 2, side: "new", source: "diff", evidence: "return" },
  ],
  reviewedAt: "2026-08-31T12:00:00.000Z",
};

const verdictB: JudgeVerdict = {
  schemaVersion: 1,
  judge: "b",
  status: "SUPPORTED",
  approved: true,
  diffHash: DIFF_HASH,
  findings: [
    { severity: "warning", claim: "Consider caching", file: "src/a.ts", line: 2, side: "new", source: "diff", evidence: "input.value" },
    { severity: "suggestion", claim: "Add tests", file: "src/a.ts", line: 2, side: "new", source: "diff", evidence: "return" },
    { severity: "suggestion", claim: "Add docs", file: "src/a.ts", line: 2, side: "new", source: "diff", evidence: "return" },
  ],
  reviewedAt: "2026-08-31T12:00:00.000Z",
};

test("mergeVerdicts combines both judges", () => {
  const merged = mergeVerdicts(verdictA, verdictB);
  assert.equal(merged.approved, false); // Both must approve
  assert.deepEqual(merged.critical, ["Missing null check"]);
  assert.deepEqual(merged.warnings, ["Consider caching"]);
  assert.deepEqual(merged.suggestions, ["Add docs", "Add tests"]);
  assert.equal(merged.findings.length, 4);
});

test("mergeVerdicts approves only when both approve", () => {
  const bothApprove = mergeVerdicts(
    { ...verdictA, approved: true, findings: verdictA.findings.filter((finding) => finding.severity !== "critical") },
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
  const prompt = buildJudgePrompt("diff content", "a", "{\"role\":\"judge-a\"}");
  assert.ok(prompt.includes("Judge A"));
  assert.ok(prompt.includes("Return only the strict verdict object to the orchestrator"));
  assert.ok(prompt.includes("diff content"));
  assert.ok(prompt.includes("approved"));
  assert.ok(prompt.includes("critical"));
  assert.ok(prompt.includes("INSUFFICIENT_EVIDENCE"));
  assert.ok(prompt.includes("exact snippet"));
  assert.ok(prompt.includes("## Context bundle"));
});

test("buildFixPrompt includes verdict and diff", () => {
  const merged = mergeVerdicts(verdictA, verdictB);
  const prompt = buildFixPrompt(merged, "original diff", "{\"role\":\"fix\"}");
  assert.ok(prompt.includes("Missing null check"));
  assert.ok(prompt.includes("original diff"));
  assert.ok(prompt.includes("Return only a compact execution receipt to the orchestrator"));
  assert.ok(prompt.includes("mr-fix"));
  assert.ok(prompt.includes("src/a.ts"));
  assert.ok(prompt.includes("## Context bundle"));
});

test("visibleDiffLines maps context and additions to new-side line numbers", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n const before = true;\n-old return;\n+return input.value;\n const after = true;\n";
  const lines = visibleDiffLines(diff);
  assert.equal(lines.get("src/a.ts")?.get(1), "const before = true;");
  assert.equal(lines.get("src/a.ts")?.get(2), "return input.value;");
  assert.equal(lines.get("src/a.ts")?.get(3), "const after = true;");
  assert.equal(visibleDiffLines(diff, "old").get("src/a.ts")?.get(2), "old return;");
});

test("validateJudgeFindings rejects unsupported citations and inconsistent approval", () => {
  const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+return input.value;\n";
  const valid = { severity: "critical" as const, claim: "Missing guard", file: "src/a.ts", line: 1, side: "new" as const, source: "diff" as const, evidence: "input.value", requirementId: "R1" };
  assert.deepEqual(validateJudgeFindings(diff, [valid], { approved: false, requirementIds: new Set(["R1"]) }), []);
  const removed = { ...valid, claim: "Required guard was removed", side: "old" as const, evidence: "old" };
  assert.deepEqual(validateJudgeFindings(diff, [removed], { approved: false, requirementIds: new Set(["R1"]) }), []);

  const issues = validateJudgeFindings(diff, [
    { ...valid, line: 9, evidence: "invented", requirementId: "R9" },
  ], { approved: true, requirementIds: new Set(["R1"]) });
  assert.ok(issues.some((issue) => issue.includes("not a visible new-side diff line")));
  assert.ok(issues.some((issue) => issue.includes("unknown requirement R9")));
  assert.ok(issues.some((issue) => issue.includes("approved must be false")));
});

test("CAS SHA-256: getDiffHash produces 64-character hex digest and changes when file bytes change", async () => {
  const { getDiffHash } = await import("../src/core/judgment.js");
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { runCommand } = await import("../src/core/process.js");

  const dir = await mkdtemp(join(tmpdir(), "mr-cas-test-"));
  runCommand("git", ["init", dir]);
  runCommand("git", ["-C", dir, "config", "user.email", "audit@orchestrator.local"]);
  runCommand("git", ["-C", dir, "config", "user.name", "Auditor"]);

  await writeFile(join(dir, "file.txt"), "version 1\n");
  runCommand("git", ["-C", dir, "add", "file.txt"]);
  runCommand("git", ["-C", dir, "commit", "-m", "initial commit"]);

  // Initial diff against HEAD is empty
  const hash1 = await getDiffHash(dir);
  assert.equal(hash1.length, 64);

  // Modify file
  await writeFile(join(dir, "file.txt"), "version 2 (mutated)\n");
  const hash2 = await getDiffHash(dir);
  assert.equal(hash2.length, 64);
  assert.notEqual(hash1, hash2, "Modifying file bytes must change SHA-256 CAS digest");

  // Single-byte alteration
  await writeFile(join(dir, "file.txt"), "version 2 (mutated)!\n");
  const hash3 = await getDiffHash(dir);
  assert.notEqual(hash2, hash3, "Single byte change must invalidate previous digest");

  await rm(dir, { recursive: true });
});
