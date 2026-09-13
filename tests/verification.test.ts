import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../src/core/paths.js";
import { loadVerificationReceipt, saveVerificationReceipt, VerificationReceiptSchema } from "../src/core/verification.js";

test("verification receipts persist atomically and round-trip", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-verification-"));
  try {
    const paths = resolvePaths({ HOME: home });
    const receipt = VerificationReceiptSchema.parse({
      schemaVersion: 1,
      taskId: "T3",
      results: [{ command: "bun test", exitCode: 0, durationMs: 25, outputTail: "3 pass" }],
      changedFiles: ["src/a.ts"],
      diffHash: "a".repeat(64),
      recordedAt: "2026-09-13T00:00:00.000Z",
    });
    const path = await saveVerificationReceipt(paths, "workspace-1", receipt);
    assert.ok(path.endsWith("/sdd/verify/T3.json"));
    assert.deepEqual(await loadVerificationReceipt(paths, "workspace-1", "T3"), receipt);
    assert.equal(await loadVerificationReceipt(paths, "workspace-1", "T99"), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("verification receipt schema caps output tails and rejects unsafe task ids", () => {
  const base = {
    schemaVersion: 1,
    taskId: "T1",
    results: [{ command: "bun test", exitCode: 0, durationMs: 1, outputTail: "x".repeat(4_001) }],
    changedFiles: [],
    diffHash: "a".repeat(64),
    recordedAt: "2026-09-13T00:00:00.000Z",
  };
  assert.equal(VerificationReceiptSchema.safeParse(base).success, false);
  assert.equal(VerificationReceiptSchema.safeParse({ ...base, taskId: "../T1", results: [{ ...base.results[0], outputTail: "ok" }] }).success, false);
});
