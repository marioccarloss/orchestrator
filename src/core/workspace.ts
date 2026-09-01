import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, atomicWrite, readJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import {
  SCHEMA_VERSION,
  WorkspaceRegistrySchema,
  type WorkspaceProfile,
  type WorkspaceRegistry,
} from "./schema.js";

const EMPTY_REGISTRY: WorkspaceRegistry = { schemaVersion: SCHEMA_VERSION, workspaces: [] };

export async function loadRegistry(paths: MrPaths): Promise<WorkspaceRegistry> {
  try {
    return await readJson(paths.registry, WorkspaceRegistrySchema);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return EMPTY_REGISTRY;
    }
    throw error;
  }
}

export async function saveRegistry(paths: MrPaths, registry: WorkspaceRegistry): Promise<void> {
  const valid = WorkspaceRegistrySchema.parse(registry);
  await atomicWrite(paths.registry, canonicalJson(valid));
}

function workspaceId(root: string): string {
  const slug = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "") || "workspace";
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${slug}-${suffix}`;
}

export async function addWorkspace(paths: MrPaths, inputRoot: string): Promise<WorkspaceProfile> {
  const root = await realpath(resolve(inputRoot));
  const contextRoot = join(root, ".aicontext");
  await access(contextRoot);
  const registry = await loadRegistry(paths);
  const existing = registry.workspaces.find((item) => item.root === root);
  if (existing !== undefined) {
    return existing;
  }

  const profile: WorkspaceProfile = {
    schemaVersion: SCHEMA_VERSION,
    id: workspaceId(root),
    name: basename(root),
    root,
    contextRoot,
  };
  await saveRegistry(paths, {
    ...registry,
    workspaces: [...registry.workspaces, profile].sort((left, right) => left.root.localeCompare(right.root)),
  });
  return profile;
}

export async function removeWorkspace(paths: MrPaths, id: string): Promise<boolean> {
  const registry = await loadRegistry(paths);
  const workspaces = registry.workspaces.filter((item) => item.id !== id);
  if (workspaces.length === registry.workspaces.length) {
    return false;
  }
  await saveRegistry(paths, { ...registry, workspaces });
  return true;
}

function contains(root: string, candidate: string): boolean {
  const fragment = relative(root, candidate);
  return fragment === "" || (!fragment.startsWith("..") && !isAbsolute(fragment));
}

export function detectWorkspace(registry: WorkspaceRegistry, cwd: string): WorkspaceProfile | undefined {
  let candidate = resolve(cwd);
  try {
    candidate = realpathSync(candidate);
  } catch {
    // Keep resolved path if it cannot be realpathed
  }
  return registry.workspaces
    .filter((workspace) => contains(workspace.root, candidate))
    .sort((left, right) => right.root.length - left.root.length)[0];
}

export async function ensureWorkspaceDirectories(paths: MrPaths): Promise<void> {
  await mkdir(paths.generatedRoot, { recursive: true });
}
