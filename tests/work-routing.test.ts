import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyWork, saveWorkDocument } from "../src/core/work-routing.js";

test("ODD-lite keeps non-implementation and unauthorized work read-only", () => {
  assert.equal(classifyWork({
    intent: "investigate",
    writeAuthorized: true,
    observedReadFiles: 8,
    expectedWriteFiles: 3,
    meaningfulSteps: 4,
    incident: false,
  }).route, "read-only");
  assert.equal(classifyWork({
    intent: "implement",
    writeAuthorized: false,
    observedReadFiles: 1,
    expectedWriteFiles: 1,
    meaningfulSteps: 1,
    incident: false,
  }).route, "read-only");
});

test("ODD-lite routes a small understood write directly and broader work to tracking", () => {
  const direct = classifyWork({
    intent: "implement",
    writeAuthorized: true,
    observedReadFiles: 2,
    expectedWriteFiles: 1,
    meaningfulSteps: 1,
    incident: false,
  });
  assert.equal(direct.route, "direct");
  assert.equal(direct.flowSelected, false);

  for (const input of [
    { observedReadFiles: 4, expectedWriteFiles: 1, meaningfulSteps: 1, incident: false },
    { observedReadFiles: 1, expectedWriteFiles: 2, meaningfulSteps: 1, incident: false },
    { observedReadFiles: 1, expectedWriteFiles: 1, meaningfulSteps: 2, incident: false },
    { observedReadFiles: 1, expectedWriteFiles: 1, meaningfulSteps: 1, incident: true },
  ]) {
    const tracked = classifyWork({ intent: "implement", writeAuthorized: true, ...input });
    assert.equal(tracked.route, "tracked");
    assert.equal(tracked.trackingRequired, true);
    assert.equal(tracked.flowSelected, false, "ODD-lite must never select formal Flow implicitly");
  }
});

test("tracked work is persisted as a resumable Markdown task record", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-work-routing-"));
  try {
    const path = await saveWorkDocument(root, {
      slug: "frozen-judgment",
      title: "Freeze Judgment candidate",
      objective: "Make both judges inspect the same bytes.",
      scope: ["src/core/judgment.ts"],
      tasks: [
        { id: "W1", title: "Persist candidate", status: "done" },
        { id: "W2", title: "Verify integrity", status: "in_progress" },
      ],
      evidence: ["Focused tests pass"],
      nextStep: "Run the full test suite.",
      status: "active",
    });
    assert.equal(path, join(root, ".mr", "odd", "tasks", "frozen-judgment.md"));
    const content = await readFile(path, "utf8");
    assert.match(content, /\[x\] W1: Persist candidate/u);
    assert.match(content, /\[>\] W2: Verify integrity/u);
    assert.match(content, /Focused tests pass/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
