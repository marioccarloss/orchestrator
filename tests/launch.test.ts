import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePaths } from "../src/core/paths.js";
import { addWorkspace } from "../src/core/workspace.js";
import { prepareLaunch, launch } from "../src/core/launch.js";
import { seedModels } from "../src/core/config.js";

const sourceRoot = process.cwd();

async function createTestEnv(): Promise<{ home: string; outer: string; inner: string; sub: string }> {
  const home = await mkdtemp(join(tmpdir(), "mr-launch-"));
  const outer = join(home, "outer");
  const inner = join(outer, "inner");
  const sub = join(inner, "packages", "app");
  await mkdir(join(outer, ".aicontext"), { recursive: true });
  await mkdir(join(inner, ".aicontext"), { recursive: true });
  await mkdir(sub, { recursive: true });
  await mkdir(join(home, ".config", "mr-orchestrator"), { recursive: true });
  await writeFile(join(home, ".config", "mr-orchestrator", "models.json"), JSON.stringify({
    schemaVersion: 1,
    roles: {
      orchestrator: "copilot/gpt-4",
      explore: "copilot/gpt-4",
      plan: "copilot/gpt-4",
      general: "copilot/gpt-4",
      sddApply: "copilot/gpt-4",
      judgeA: "copilot/gpt-4",
      judgeB: "copilot/gpt-4",
      fix: "copilot/gpt-4",
    },
  }));
  return { home, outer, inner, sub };
}

void test("prepareLaunch detects workspace from registered root", async () => {
  const { home, inner } = await createTestEnv();
  const paths = resolvePaths({ HOME: home });
  await seedModels(paths, sourceRoot);
  const profile = await addWorkspace(paths, inner);

  const prep = await prepareLaunch(paths, inner, sourceRoot);
  assert.equal(prep.workspace.id, profile.id);
  assert.equal(prep.effectiveCwd, await realpath(inner));
  assert.ok(prep.configPath.endsWith(`generated/${profile.id}/opencode.mr.json`));
  assert.equal(prep.env["OPENCODE_CONFIG"], prep.configPath);
});

void test("prepareLaunch detects workspace from subdirectory and preserves cwd", async () => {
  const { home, inner, sub } = await createTestEnv();
  const paths = resolvePaths({ HOME: home });
  await seedModels(paths, sourceRoot);
  const profile = await addWorkspace(paths, inner);

  const prep = await prepareLaunch(paths, sub, sourceRoot);
  assert.equal(prep.workspace.id, profile.id);
  // Must preserve sub directory as effectiveCwd instead of overriding with workspace.root
  assert.equal(prep.effectiveCwd, await realpath(sub));
  assert.ok(prep.configPath.endsWith(`generated/${profile.id}/opencode.mr.json`));
  assert.equal(prep.env["OPENCODE_CONFIG"], prep.configPath);
});

void test("prepareLaunch throws when cwd is not inside any registered workspace", async () => {
  const { home, outer } = await createTestEnv();
  const paths = resolvePaths({ HOME: home });
  const outside = join(home, "unregistered");
  await mkdir(outside, { recursive: true });

  await assert.rejects(
    prepareLaunch(paths, outside, sourceRoot),
    /No registered mr-orchestrator workspace contains/,
  );
});

void test("launch invokes spawner with preserved cwd and injected OPENCODE_CONFIG", async () => {
  const { home, inner, sub } = await createTestEnv();
  const paths = resolvePaths({ HOME: home });
  await seedModels(paths, sourceRoot);
  const profile = await addWorkspace(paths, inner);

  let spawnedCommand = "";
  let spawnedArgs: readonly string[] = [];
  let spawnedCwd = "";
  let spawnedConfig = "";

  const mockSpawner = async (cmd: string, args: readonly string[], options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }) => {
    spawnedCommand = cmd;
    spawnedArgs = args;
    spawnedCwd = options.cwd;
    spawnedConfig = options.env["OPENCODE_CONFIG"] ?? "";
    return 0;
  };

  const code = await launch(paths, sub, ["--pure", "session"], mockSpawner);
  assert.equal(code, 0);
  assert.equal(spawnedCommand, "opencode");
  assert.deepEqual(spawnedArgs, ["--pure", "session"]);
  assert.equal(spawnedCwd, await realpath(sub));
  assert.ok(spawnedConfig.endsWith(`generated/${profile.id}/opencode.mr.json`));
});
