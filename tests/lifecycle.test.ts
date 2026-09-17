import { test } from "bun:test";
import assert from "node:assert/strict";
import { createBackup, restoreBackup, planUpdate, exportProfile, importProfile, detectPlatform, getWorkspacePlatform } from "../src/core/lifecycle.js";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
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

async function setupTestPaths(): Promise<{ dir: string; paths: MrPaths }> {
  const dir = await mkdtemp(join(tmpdir(), "mr-lifecycle-"));
  const paths = makePaths(dir);

  // Create minimal required files
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(paths.registry, JSON.stringify({ schemaVersion: 1, workspaces: [] }));
  await writeFile(paths.models, JSON.stringify({
    schemaVersion: 1,
    roles: {
      orchestrator: "github-copilot/kimi-k3",
      explore: "github-copilot/gemini-3.7-flash",
      plan: "github-copilot/gpt-5.6-sol",
      general: "github-copilot/kimi-k3",
      sddApply: "github-copilot/gpt-5.6-sol",
      judgeA: "github-copilot/grok-4.6",
      judgeB: "github-copilot/claude-opus-5",
      fix: "github-copilot/gpt-5.6-sol",
      bpExtractor: "github-copilot/gpt-4o-mini",
      bpArchitect: "github-copilot/gemini-3.8-flash",
      bpTransactor: "github-copilot/gpt-4o-mini",
    },
  }));
  await writeFile(paths.manifest, JSON.stringify({
    schemaVersion: 1,
    version: "0.1.0",
    installedAt: new Date().toISOString(),
    sourceRoot: "/test",
    files: [],
  }));
  const cursorHarness = join(paths.configRoot, "harnesses", "cursor");
  await mkdir(cursorHarness, { recursive: true });
  await writeFile(join(cursorHarness, "models.json"), JSON.stringify({
    schemaVersion: 1,
    harness: "cursor",
    roles: {
      explore: { primary: { model: "github-copilot/gemini-3.7-flash" } },
    },
  }));
  await writeFile(join(cursorHarness, "catalog.json"), JSON.stringify({
    schemaVersion: 1,
    harness: "cursor",
    applicationMode: "per-invocation",
    provenance: { source: "explicit" },
    models: {
      "github-copilot/gemini-3.7-flash": { nativeModel: "cursor/gemini-3.7-flash" },
    },
  }));

  return { dir, paths };
}

test("createBackup creates backup directory with files", async () => {
  const { dir, paths } = await setupTestPaths();
  try {
    const backupDir = await createBackup(paths);
    assert.ok(existsSync(backupDir));
    assert.ok(existsSync(join(backupDir, "workspaces.json")));
    assert.ok(existsSync(join(backupDir, "models.json")));
    assert.ok(existsSync(join(backupDir, "install-manifest.json")));
    assert.ok(existsSync(join(backupDir, "harnesses", "cursor", "models.json")));
    assert.ok(existsSync(join(backupDir, "harnesses", "cursor", "catalog.json")));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("restoreBackup restores files from backup", async () => {
  const { dir, paths } = await setupTestPaths();
  try {
    const backupDir = await createBackup(paths);

    // Modify original files
    await writeFile(paths.registry, JSON.stringify({ schemaVersion: 1, workspaces: [{ id: "modified" }] }));
    await writeFile(join(paths.configRoot, "harnesses", "cursor", "models.json"), "modified");

    // Restore
    await restoreBackup(paths, backupDir);

    const content = await import("node:fs/promises").then((m) => m.readFile(paths.registry, "utf8"));
    const registry = JSON.parse(content);
    assert.equal(registry.workspaces.length, 0); // Original empty registry
    const harnessModels = JSON.parse(await readFile(join(paths.configRoot, "harnesses", "cursor", "models.json"), "utf8"));
    assert.equal(harnessModels.harness, "cursor");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("planUpdate generates migration plan", async () => {
  const { dir, paths } = await setupTestPaths();
  try {
    const plan = await planUpdate(paths, "1.0.0");
    assert.equal(plan.fromVersion, "0.1.0");
    assert.equal(plan.toVersion, "1.0.0");
    assert.ok(plan.migrations.length > 0);
    assert.ok(existsSync(plan.backupPath));
    assert.ok(existsSync(plan.rollbackPath));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("exportProfile creates export file", async () => {
  const { dir, paths } = await setupTestPaths();
  try {
    const exportPath = await exportProfile(paths);
    assert.ok(existsSync(exportPath));
    const content = await import("node:fs/promises").then((m) => m.readFile(exportPath, "utf8"));
    const profile = JSON.parse(content);
    assert.equal(profile.schemaVersion, 1);
    assert.equal(profile.version, "0.1.0");
    assert.equal(profile.harnesses.cursor.models.harness, "cursor");
    assert.equal(profile.harnesses.cursor.catalog.applicationMode, "per-invocation");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("importProfile replaces harness-scoped source configuration", async () => {
  const { dir, paths } = await setupTestPaths();
  try {
    const exportPath = await exportProfile(paths);
    const cursorModels = join(paths.configRoot, "harnesses", "cursor", "models.json");
    await writeFile(cursorModels, JSON.stringify({ schemaVersion: 1, harness: "cursor", roles: {} }));
    await mkdir(join(paths.configRoot, "harnesses", "claude"), { recursive: true });
    await writeFile(join(paths.configRoot, "harnesses", "claude", "models.json"), JSON.stringify({
      schemaVersion: 1,
      harness: "claude",
      roles: {},
    }));

    await importProfile(paths, exportPath);

    const restored = JSON.parse(await readFile(cursorModels, "utf8"));
    assert.equal(restored.roles.explore.primary.model, "github-copilot/gemini-3.7-flash");
    assert.equal(existsSync(join(paths.configRoot, "harnesses", "claude")), false);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("detectPlatform identifies GitHub", () => {
  assert.equal(detectPlatform("https://github.com/user/repo.git"), "github");
  assert.equal(detectPlatform("git@github.com:user/repo.git"), "github");
});

test("detectPlatform identifies GitLab", () => {
  assert.equal(detectPlatform("https://gitlab.com/user/repo.git"), "gitlab");
});

test("detectPlatform identifies Bitbucket", () => {
  assert.equal(detectPlatform("https://bitbucket.org/user/repo.git"), "bitbucket");
});

test("detectPlatform returns unknown for others", () => {
  assert.equal(detectPlatform("https://example.com/repo.git"), "unknown");
  assert.equal(detectPlatform(""), "unknown");
});
