import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import { generatedConfigPath } from "./config.js";
import { loadManifest } from "./install.js";
import type { MrPaths } from "./paths.js";
import { runCommand } from "./process.js";
import { loadRegistry } from "./workspace.js";

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function commandVersion(command: string, arguments_: readonly string[]): CheckResult {
  const result = runCommand(command, arguments_);
  return {
    name: command,
    ok: result.ok,
    detail: result.ok ? `${result.stdout}${result.stderr}`.trim() : "not available",
  };
}

export async function runDoctor(paths: MrPaths, env: NodeJS.ProcessEnv = process.env): Promise<readonly CheckResult[]> {
  const checks: CheckResult[] = [
    commandVersion(paths.bunBinary, ["--version"]),
    commandVersion("opencode", ["--version"]),
  ];

  const pathDirectories = (env["PATH"] ?? "").split(delimiter);
  checks.push({
    name: "PATH",
    ok: pathDirectories.includes(paths.binRoot),
    detail: pathDirectories.includes(paths.binRoot) ? `${paths.binRoot} is configured` : `add ${paths.binRoot} to PATH`,
  });

  try {
    const manifest = await loadManifest(paths);
    checks.push({ name: "install manifest", ok: true, detail: `v${manifest.version}` });
  } catch (error: unknown) {
    checks.push({ name: "install manifest", ok: false, detail: (error as Error).message });
  }

  const registry = await loadRegistry(paths);
  checks.push({
    name: "workspace registry",
    ok: registry.workspaces.length > 0,
    detail: `${String(registry.workspaces.length)} registered`,
  });

  for (const workspace of registry.workspaces) {
    try {
      await access(workspace.contextRoot);
      await access(generatedConfigPath(paths, workspace.id));
      checks.push({ name: workspace.name, ok: true, detail: workspace.root });
    } catch (error: unknown) {
      checks.push({ name: workspace.name, ok: false, detail: (error as Error).message });
    }
  }
  return checks;
}
