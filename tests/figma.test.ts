import { test } from "bun:test";
import assert from "node:assert/strict";
import { FigmaCache, FigmaMcpAdapter, runE2ETest, formatE2EResults } from "../src/core/figma.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MrPaths } from "../src/core/paths.js";

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

test("FigmaCache stores and retrieves data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-figma-"));
  const paths = makePaths(dir);
  const cache = new FigmaCache(paths, "test-ws");

  const file = {
    key: "abc123",
    name: "Test File",
    lastModified: new Date().toISOString(),
    nodes: [],
  };

  await cache.set("abc123", file);
  const retrieved = await cache.get("abc123");
  assert.ok(retrieved !== undefined);
  assert.equal(retrieved.key, "abc123");
  assert.equal(retrieved.name, "Test File");

  await rm(dir, { recursive: true });
});

test("FigmaCache returns undefined for missing key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-figma-"));
  const paths = makePaths(dir);
  const cache = new FigmaCache(paths, "test-ws");

  const retrieved = await cache.get("nonexistent");
  assert.equal(retrieved, undefined);

  await rm(dir, { recursive: true });
});

test("FigmaCache respects TTL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-figma-"));
  const paths = makePaths(dir);
  const cache = new FigmaCache(paths, "test-ws");

  const file = {
    key: "abc123",
    name: "Test File",
    lastModified: new Date().toISOString(),
    nodes: [],
  };

  // Set with 0 TTL (expired immediately)
  await cache.set("abc123", file, 0);
  // Wait a tick
  await new Promise((r) => setTimeout(r, 10));
  const retrieved = await cache.get("abc123");
  assert.equal(retrieved, undefined);

  await rm(dir, { recursive: true });
});

test("FigmaMcpAdapter returns stub file", async () => {
  const adapter = new FigmaMcpAdapter();
  const file = await adapter.fetchFile("test-key");
  assert.equal(file.key, "test-key");
  assert.ok(file.name.includes("Figma"));
});

test("runE2ETest passes for successful command", async () => {
  const result = await runE2ETest({
    name: "echo test",
    command: "echo",
    args: ["hello"],
    expectedExitCode: 0,
    expectedStdout: "hello",
  });
  assert.equal(result.passed, true);
  assert.equal(result.exitCode, 0);
});

test("runE2ETest fails for wrong exit code", async () => {
  const result = await runE2ETest({
    name: "false test",
    command: "false",
    args: [],
    expectedExitCode: 0,
  });
  assert.equal(result.passed, false);
});

test("formatE2EResults produces markdown", () => {
  const results = [
    { name: "test1", passed: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 },
    { name: "test2", passed: false, exitCode: 1, stdout: "", stderr: "error", durationMs: 200, error: "exit code mismatch" },
  ];
  const md = formatE2EResults(results);
  assert.ok(md.includes("E2E Test Results"));
  assert.ok(md.includes("2"));
  assert.ok(md.includes("✅"));
  assert.ok(md.includes("❌"));
});
