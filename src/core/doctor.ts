import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import { generatedConfigPath, loadModels } from "./config.js";
import { capabilityPaths, loadCapabilitySelection } from "./capabilities.js";
import { loadManifest } from "./install.js";
import type { MrPaths } from "./paths.js";
import { runCommand } from "./process.js";
import { loadRegistry } from "./workspace.js";
import { AtlasIndexer, computeWorkspaceFileHashes, isGraphFresh, loadAtlasGraph } from "./atlas.js";
import { assessFigmaSetup } from "./figma-setup.js";
import { discoverRepositories } from "./rules/discover.js";
import { profileRepository } from "./rules/profiler.js";
import { loadWorkspaceRules, staleRuleRepositories } from "./rules/store.js";
import { configuredHarnesses, resolveStoredHarnessModels } from "./harness-models.js";
import type { HarnessId } from "./schema.js";
import { hasGatewayCredentials, loadDecisionPlaneConfig } from "./decision.js";

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

export async function checkHarnessModelRosters(paths: MrPaths): Promise<readonly CheckResult[]> {
  try {
    const models = await loadModels(paths);
    const harnesses = new Set<HarnessId>(["opencode", ...await configuredHarnesses(paths)]);
    const checks: CheckResult[] = [];
    for (const harness of harnesses) {
      try {
        const effective = await resolveStoredHarnessModels(paths, models, harness);
        checks.push({
          name: `${harness} model roster`,
          ok: true,
          detail: `${effective.applicationMode}; ${String(Object.keys(effective.roles).length)} roles validated`,
        });
      } catch (error: unknown) {
        checks.push({
          name: `${harness} model roster`,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return checks;
  } catch (error: unknown) {
    return [{
      name: "model rosters",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    }];
  }
}

export async function runDoctor(paths: MrPaths, env: NodeJS.ProcessEnv = process.env): Promise<readonly CheckResult[]> {
  const capability = capabilityPaths(paths);
  const selection = await loadCapabilitySelection(paths);
  const selected = new Set(selection.selected);
  const checks: CheckResult[] = [
    commandVersion(paths.bunBinary, ["--version"]),
    commandVersion("opencode", ["--version"]),
  ];

  if (selected.has("codebase-memory")) checks.push(commandVersion(capability.codebaseMemory, ["--version"]));
  if (selected.has("codegraph")) checks.push(commandVersion(capability.codegraph, ["--version"]));
  if (selected.has("engram")) checks.push(commandVersion(capability.engram, ["--version"]));
  for (const [name, path, detail, capabilityId] of [
    ["i-have-adhd", capability.adhdSkill, "installed for Orchestrator presentation only", "i-have-adhd"],
    ["figma-live-mcp", capability.figmaLive, "server binary installed", "figma-live"],
  ] as const) {
    if (!selected.has(capabilityId)) continue;
    try {
      await access(path);
      checks.push({ name, ok: true, detail });
    } catch {
      checks.push({ name, ok: false, detail: `missing: ${path}` });
    }
  }
  if (selected.has("figma-live")) {
    const figma = await assessFigmaSetup(paths);
    checks.push({
      name: "Figma Live MCP",
      ok: figma.binaryInstalled,
      detail: figma.detail,
    });
    checks.push({
      name: "Figma plugin manifest",
      ok: figma.manifestPublishedOk || figma.binaryInstalled,
      detail: figma.manifestPublishedOk
        ? `published at ${figma.manifestPublished}`
        : `run mr figma setup — source ${figma.manifestSource}`,
    });
  }
  for (const id of ["github", "jira"] as const) {
    if (!selected.has(id)) continue;
    const ready = selection.credentials[id] === "ready";
    checks.push({
      name: `${id} credentials`,
      ok: ready,
      detail: ready ? "marked ready by user" : `pending; complete OAuth and run mr capabilities install`,
    });
  }

  try {
    const decision = await loadDecisionPlaneConfig(paths, env);
    const credentials = hasGatewayCredentials(env);
    checks.push({
      name: "Jev decision plane",
      ok: decision.mode === "off" || credentials,
      detail: decision.mode === "off"
        ? `off; enable advisory mode with mr decision shadow (${decision.model})`
        : credentials
          ? `shadow; ${decision.model}; deterministic FSM remains authoritative`
          : `shadow; ${decision.model}; missing AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN`,
    });
  } catch (error: unknown) {
    checks.push({ name: "Jev decision plane", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

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

  checks.push(...await checkHarnessModelRosters(paths));

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
    const rules = await loadWorkspaceRules(workspace);
    if (rules === undefined) continue;
    const graph = await loadAtlasGraph(paths, workspace.id);
    if (graph === undefined) {
      checks.push({ name: `${workspace.name} Atlas rules`, ok: false, detail: "rules exist but the Atlas index is missing; run mr atlas rules" });
      continue;
    }
    try {
      const hashes = await computeWorkspaceFileHashes(workspace.root);
      const freshness = isGraphFresh(graph, hashes);
      const currentGraph = freshness.fresh ? graph : await new AtlasIndexer().indexWorkspace(workspace.root, { previous: graph });
      const repositories = await discoverRepositories(workspace.root);
      const profiles = await Promise.all(repositories.map((repository) => profileRepository(workspace.root, repository, currentGraph)));
      const stale = staleRuleRepositories(rules, profiles);
      checks.push({
        name: `${workspace.name} Atlas rules`,
        ok: stale.length === 0,
        detail: stale.length === 0 ? "baseline matches the current stack" : `stale for: ${stale.join(", ")}; run mr atlas rules`,
      });
    } catch (error: unknown) {
      checks.push({ name: `${workspace.name} Atlas rules`, ok: false, detail: `could not verify freshness: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return checks;
}
