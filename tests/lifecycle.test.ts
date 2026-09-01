import { test } from "bun:test";
import assert from "node:assert/strict";
import { createBackup, restoreBackup, planUpdate, exportProfile, detectPlatform, getWorkspacePlatform } from "../src/core/lifecycle.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
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
    },
  }));
  await writeFile(paths.manifest, JSON.stringify({
    schemaVersion: 1,
    version: "0.1.0",
    installedAt: new Date().toISOString(),
    sourceRoot: "/test",
    files: [],
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

    // Restore
    await restoreBackup(paths, backupDir);

    const content = await import("node:fs/promises").then((m) => m.readFile(paths.registry, "utf8"));
    const registry = JSON.parse(content);
    assert.equal(registry.workspaces.length, 0); // Original empty registry
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
