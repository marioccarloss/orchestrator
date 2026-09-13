import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join } from "node:path";

export interface DiscoveredRepository {
  readonly name: string;
  readonly root: string;
  readonly markers: readonly string[];
}

const MARKERS = ["package.json", "composer.json", "pom.xml", "pnpm-workspace.yaml", "turbo.json", "nx.json", ".git"] as const;

async function markerNames(root: string): Promise<string[]> {
  const names = new Set((await readdir(root, { withFileTypes: true })).map((entry) => entry.name));
  return MARKERS.filter((marker) => names.has(marker));
}

export async function discoverRepositories(workspaceRoot: string): Promise<readonly DiscoveredRepository[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(workspaceRoot, "repos"), { withFileTypes: true });
  } catch {
    entries = [];
  }
  const repositories: DiscoveredRepository[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const base = join(workspaceRoot, "repos", entry.name);
    const direct = await markerNames(base).catch(() => []);
    const code = direct.length === 0 ? await markerNames(join(base, "code")).catch(() => []) : [];
    if (direct.length > 0) repositories.push({ name: entry.name, root: `repos/${entry.name}`, markers: direct });
    else if (code.length > 0) repositories.push({ name: entry.name, root: `repos/${entry.name}/code`, markers: code });
  }
  if (repositories.length > 0) return repositories.sort((a, b) => a.name.localeCompare(b.name));
  return [{ name: basename(workspaceRoot), root: ".", markers: await markerNames(workspaceRoot).catch(() => []) }];
}
