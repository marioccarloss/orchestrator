import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  bindChildFlowSession,
  finalizeFlowMetrics,
  loadFlowMetrics,
  recordFlowAssistantUsage,
  startFlowMetrics,
  summarizeFlowMetrics,
} from "../src/core/flow-metrics.js";
import { resolvePaths } from "../src/core/paths.js";

const STARTED_AT = "2026-09-12T10:00:00.000Z";

test("Flow metrics deduplicate message updates and include child sessions", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-flow-metrics-"));
  const paths = resolvePaths({ HOME: home });
  await startFlowMetrics(paths, "workspace-1", "GH-42", STARTED_AT, "parent");
  assert.equal(await bindChildFlowSession(paths, "workspace-1", "parent", "child"), true);

  const first = {
    id: "message-1",
    sessionID: "parent",
    providerID: "openai",
    modelID: "gpt-5.6-sol",
    cost: 0.01,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } },
  };
  assert.equal(await recordFlowAssistantUsage(paths, "workspace-1", first), true);
  assert.equal(await recordFlowAssistantUsage(paths, "workspace-1", {
    ...first,
    cost: 0.012,
    tokens: { ...first.tokens, output: 25 },
  }), true);
  assert.equal(await recordFlowAssistantUsage(paths, "workspace-1", {
    ...first,
    id: "message-2",
    sessionID: "child",
    cost: 0.02,
    tokens: { input: 80, output: 10, reasoning: 0, cache: { read: 20, write: 3 } },
  }), true);
  assert.equal(await recordFlowAssistantUsage(paths, "workspace-1", {
    ...first,
    id: "outside",
    sessionID: "unbound",
  }), false);

  const stored = await loadFlowMetrics(paths, "workspace-1");
  assert.ok(stored);
  const summary = summarizeFlowMetrics(stored);
  assert.equal(summary.cost, 0.032);
  assert.equal(summary.messages, 2);
  assert.equal(summary.sessions, 2);
  assert.deepEqual(summary.tokens, {
    input: 180,
    output: 35,
    reasoning: 5,
    cacheRead: 70,
    cacheWrite: 3,
  });
});

test("Flow metrics retain the final provider-reported total", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-flow-metrics-final-"));
  const paths = resolvePaths({ HOME: home });
  await startFlowMetrics(paths, "workspace-1", "GH-9", STARTED_AT, "parent");
  const finalized = await finalizeFlowMetrics(paths, "workspace-1", "completed");
  assert.equal(finalized?.status, "completed");
  assert.equal(typeof finalized?.completedAt, "string");
});
