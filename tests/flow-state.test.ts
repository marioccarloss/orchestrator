import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFlowState, saveFlowState, clearFlowState, applyEvent, isFlowActive, isFlowComplete, requiresJudgment, flowStatePath } from "../src/core/flow-state.js";
import type { MrPaths } from "../src/core/paths.js";
import type { FlowState } from "../src/core/flow-schema.js";

function makePaths(root: string): MrPaths {
  return {
    configRoot: join(root, "config"),
    dataRoot: join(root, "data"),
    cacheRoot: join(root, "cache"),
    binRoot: join(root, "bin"),
    registry: join(root, "config", "workspaces.json"),
    models: join(root, "config", "models.json"),
    generatedRoot: join(root, "config", "generated"),
    manifest: join(root, "config", "install-manifest.json"),
    bunRoot: join(root, "data", "toolchains", "bun"),
    bunBinary: join(root, "data", "toolchains", "bun", "bin", "bun"),
    opencodePluginsRoot: join(root, "config", "opencode-plugins"),
    opencodeAgentsRoot: join(root, "config", "opencode-agents"),
    opencodeCommandsRoot: join(root, "config", "opencode-commands"),
  };
}

test("saveFlowState and loadFlowState roundtrip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-flow-"));
  const paths = makePaths(dir);
  const state: FlowState = {
    phase: "init",
    schemaVersion: 1,
    workspaceId: "test-ws",
    startedAt: new Date().toISOString(),
  };
  await saveFlowState(paths, "test-ws", state);
  const loaded = await loadFlowState(paths, "test-ws");
  assert.ok(loaded !== undefined);
  assert.equal(loaded.phase, "init");
  assert.equal(loaded.workspaceId, "test-ws");
  await rm(dir, { recursive: true });
});

test("loadFlowState returns undefined for missing file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-flow-"));
  const paths = makePaths(dir);
  const loaded = await loadFlowState(paths, "nonexistent");
  assert.equal(loaded, undefined);
  await rm(dir, { recursive: true });
});

test("clearFlowState removes the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-flow-"));
  const paths = makePaths(dir);
  const state: FlowState = {
    phase: "init",
    schemaVersion: 1,
    workspaceId: "test-ws",
    startedAt: new Date().toISOString(),
  };
  await saveFlowState(paths, "test-ws", state);
  await clearFlowState(paths, "test-ws");
  const loaded = await loadFlowState(paths, "test-ws");
  assert.equal(loaded, undefined);
  await rm(dir, { recursive: true });
});

test("applyEvent creates and transitions state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-flow-"));
  const paths = makePaths(dir);
  const state = await applyEvent(paths, "test-ws", { type: "start", workspaceId: "test-ws", userLanguage: "fr" });
  assert.equal(state.phase, "wizard");
  assert.equal(state.userLanguage, "fr");
  await rm(dir, { recursive: true });
});

test("applyEvent throws without existing flow for non-start events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-flow-"));
  const paths = makePaths(dir);
  await assert.rejects(
    () => applyEvent(paths, "test-ws", { type: "abort" }),
    /No active flow/,
  );
  await rm(dir, { recursive: true });
});

test("isFlowActive returns true for active states", () => {
  assert.equal(isFlowActive({ phase: "init", schemaVersion: 1, workspaceId: "x", startedAt: "" } as FlowState), true);
  assert.equal(isFlowActive({ phase: "wizard", schemaVersion: 1, workspaceId: "x", startedAt: "", wizardStep: "source", wizardDraft: {} } as FlowState), true);
});

test("isFlowActive returns false for finish", () => {
  const state: FlowState = {
    phase: "finish",
    schemaVersion: 1,
    workspaceId: "x",
    startedAt: "",
    difficulty: 3,
    ticket: { schemaVersion: 1, ref: { schemaVersion: 1, platform: "github", id: "1" }, title: "", description: "", type: "feature", attachments: [], fetchedAt: "" },
    branch: "b",
    baseBranch: "main",
    plan: { schemaVersion: 1, ticket: { schemaVersion: 1, platform: "github", id: "1" }, summary: "", files: [], tests: [], verification: { typecheck: true, lint: true, test: true, build: false }, createdAt: "" },
  };
  assert.equal(isFlowActive(state), false);
});

test("isFlowComplete returns true only for finish", () => {
  assert.equal(isFlowComplete(undefined), false);
  assert.equal(isFlowComplete({ phase: "init", schemaVersion: 1, workspaceId: "x", startedAt: "" } as FlowState), false);
});

test("requiresJudgment follows Fibonacci Lite and Full thresholds", () => {
  assert.equal(requiresJudgment(1), false);
  assert.equal(requiresJudgment(3), false);
  assert.equal(requiresJudgment(5), true);
  assert.equal(requiresJudgment(8), true);
  assert.equal(requiresJudgment(13), true);
  assert.equal(requiresJudgment(21), true);
});

test("Event Sourcing: appendFlowEvent, loadFlowEvents, and replayFromOrigin reconstruct state deterministically", async () => {
  const { loadFlowEvents, replayFromOrigin } = await import("../src/core/flow-state.js");
  const dir = await mkdtemp(join(tmpdir(), "mr-flow-events-"));
  const paths = makePaths(dir);
  const workspaceId = "ws-event-sourcing";

  // Sequence of transitions
  await applyEvent(paths, workspaceId, { type: "start", workspaceId });
  await applyEvent(paths, workspaceId, {
    type: "wizard_complete",
    difficulty: 5,
    ticketId: "GH-123",
    hasFigma: false,
    userLanguage: "en",
  });
  await applyEvent(paths, workspaceId, {
    type: "context_ready",
    ticket: {
      schemaVersion: 1,
      ref: { schemaVersion: 1, platform: "github", id: "GH-123" },
      title: "Add cryptographic CAS",
      description: "Require sha256 binding",
      type: "feature",
      attachments: [],
      fetchedAt: "2026-09-07T00:00:00.000Z",
    },
    branch: "feature/gh-123",
    baseBranch: "main",
    userLanguage: "en",
  });

  const snapshotState = await loadFlowState(paths, workspaceId);
  assert.ok(snapshotState !== undefined);

  // Read raw events log
  const records = await loadFlowEvents(paths, workspaceId);
  assert.equal(records.length, 3);
  assert.equal(records[0]?.event.type, "start");
  assert.equal(records[1]?.event.type, "wizard_complete");
  assert.equal(records[2]?.event.type, "context_ready");

  // Replay from origin (pure deterministic function)
  const replayedState = replayFromOrigin(records, workspaceId);
  assert.deepEqual(replayedState, snapshotState);
  assert.equal(replayedState.userLanguage, "en");

  // Erase flow-state.json and reconstruct purely from events.jsonl
  const { unlink } = await import("node:fs/promises");
  await unlink(flowStatePath(paths, workspaceId));
  assert.equal(await loadFlowState(paths, workspaceId), undefined);

  const restoredRecords = await loadFlowEvents(paths, workspaceId);
  const reconstructedState = replayFromOrigin(restoredRecords, workspaceId);
  assert.deepEqual(reconstructedState, snapshotState);

  await rm(dir, { recursive: true });
});
