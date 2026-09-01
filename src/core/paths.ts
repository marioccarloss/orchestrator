import { homedir } from "node:os";
import { join } from "node:path";

export interface MrPaths {
  readonly configRoot: string;
  readonly dataRoot: string;
  readonly cacheRoot: string;
  readonly binRoot: string;
  readonly registry: string;
  readonly models: string;
  readonly generatedRoot: string;
  readonly manifest: string;
  readonly bunRoot: string;
  readonly bunBinary: string;
  readonly opencodePluginsRoot: string;
  readonly opencodeAgentsRoot: string;
  readonly opencodeCommandsRoot: string;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): MrPaths {
  const home = env["HOME"] ?? homedir();
  const xdgConfig = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  const configRoot = join(xdgConfig, "mr-orchestrator");
  const dataRoot = join(env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), "mr-orchestrator");
  const cacheRoot = join(env["XDG_CACHE_HOME"] ?? join(home, ".cache"), "mr-orchestrator");
  const binRoot = env["MR_BIN_HOME"] ?? join(home, ".local", "bin");
  const bunRoot = join(dataRoot, "toolchains", "bun");

  return {
    configRoot,
    dataRoot,
    cacheRoot,
    binRoot,
    registry: join(configRoot, "workspaces.json"),
    models: join(configRoot, "models.json"),
    generatedRoot: join(configRoot, "generated"),
    manifest: join(configRoot, "install-manifest.json"),
    bunRoot,
    bunBinary: join(bunRoot, "bin", "bun"),
    opencodePluginsRoot: join(xdgConfig, "opencode", "plugins"),
    opencodeAgentsRoot: join(xdgConfig, "opencode", "agents"),
    opencodeCommandsRoot: join(xdgConfig, "opencode", "commands"),
  };
}
