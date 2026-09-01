import type { MrPaths } from "./paths.js";
import { syncWorkspace } from "./config.js";
import { spawnInteractive } from "./process.js";
import { detectWorkspace, loadRegistry } from "./workspace.js";
import type { WorkspaceProfile } from "./schema.js";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function findSourceRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (current !== "/" && current !== ".") {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    current = dirname(current);
  }
  return process.cwd();
}

export interface LaunchPreparation {
  readonly workspace: WorkspaceProfile;
  readonly configPath: string;
  readonly effectiveCwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type ProcessSpawner = (
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => Promise<number>;

export async function prepareLaunch(
  paths: MrPaths,
  cwd: string,
  sourceRootOverride?: string,
): Promise<LaunchPreparation> {
  const registry = await loadRegistry(paths);
  const workspace = detectWorkspace(registry, cwd);
  if (workspace === undefined) {
    throw new Error(`No registered mr-orchestrator workspace contains ${cwd}. Run: mr workspace add <root>`);
  }

  const effectiveSourceRoot = sourceRootOverride ?? findSourceRoot();
  const configPath = await syncWorkspace(paths, workspace, effectiveSourceRoot);
  let effectiveCwd = resolve(cwd);
  try {
    effectiveCwd = realpathSync(effectiveCwd);
  } catch {
    // Keep resolved path
  }

  return {
    workspace,
    configPath,
    effectiveCwd,
    env: { ...process.env, OPENCODE_CONFIG: configPath },
  };
}

export async function launch(
  paths: MrPaths,
  cwd: string,
  arguments_: readonly string[],
  spawner: ProcessSpawner = spawnInteractive,
): Promise<number> {
  const prep = await prepareLaunch(paths, cwd);
  return spawner("opencode", arguments_, {
    cwd: prep.effectiveCwd,
    env: prep.env,
  });
}
