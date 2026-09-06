import { fileURLToPath, pathToFileURL } from "node:url";
import type { FacadeLoader, RegisteredWorkspace, ToolRegistry } from "./bridge.js";

interface PluginHooks {
  tool?: ToolRegistry;
}

interface PluginModule {
  MrOrchestrator: (context: { directory: string }) => Promise<PluginHooks>;
}

const pluginUrl = new URL("../../dist/src/plugin.js", import.meta.url);
const workspaceUrl = new URL("../../dist/src/core/workspace.js", import.meta.url);
const pathsUrl = new URL("../../dist/src/core/paths.js", import.meta.url);

export async function loadPluginFacade(workspacePath: string): Promise<ToolRegistry> {
  const plugin = await import(pluginUrl.href) as PluginModule;
  const hooks = await plugin.MrOrchestrator({ directory: workspacePath });
  if (hooks.tool === undefined) throw new Error("The immutable mr-orchestrator plugin did not expose a tool registry.");
  return hooks.tool;
}

interface RegistryProfile {
  id: string;
  root: string;
}

interface WorkspaceModule {
  loadRegistry: (paths: unknown) => Promise<{ workspaces: RegistryProfile[] }>;
}

interface PathsModule {
  resolvePaths: () => unknown;
}

export async function loadRegisteredWorkspaces(): Promise<RegisteredWorkspace[]> {
  const [{ loadRegistry }, { resolvePaths }] = await Promise.all([
    import(workspaceUrl.href) as Promise<WorkspaceModule>,
    import(pathsUrl.href) as Promise<PathsModule>,
  ]);
  const registry = await loadRegistry(resolvePaths());
  return registry.workspaces.map((workspace) => ({ id: workspace.id, path: workspace.root }));
}

export const facadeLoader: FacadeLoader = loadPluginFacade;

export function bridgeEntryPath(): string {
  return fileURLToPath(new URL("./cli.ts", import.meta.url));
}

export function bridgeEntryUrl(): string {
  return pathToFileURL(bridgeEntryPath()).href;
}
