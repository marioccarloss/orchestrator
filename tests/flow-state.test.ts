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
  const state = await applyEvent(paths, "test-ws", { type: "start", workspaceId: "test-ws" });
  assert.equal(state.phase, "wizard");
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
  assert.equal(isFlowActive({ phase: "wizard", schemaVersion: 1, workspaceId: "x", startedAt: "", difficulty: 3, ticketId: "1", hasFigma: false } as FlowState), true);
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

test("requiresJudgment returns true for difficulty >= 5", () => {
  assert.equal(requiresJudgment(1), false);
  assert.equal(requiresJudgment(3), false);
  assert.equal(requiresJudgment(5), true);
  assert.equal(requiresJudgment(8), true);
  assert.equal(requiresJudgment(13), true);
});
