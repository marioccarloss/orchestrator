#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModels, seedModels, syncWorkspace } from "./core/config.js";
import { CAPABILITY_IDS, LOCAL_CAPABILITY_IDS, defaultCapabilitySelection, detectInstalledCapabilities, loadCapabilitySelection, saveCapabilitySelection, type CapabilitySelection } from "./core/capabilities.js";
import { runDoctor } from "./core/doctor.js";
import { assessFigmaSetup, figmaSetupInstructions, publishFigmaManifest } from "./core/figma-setup.js";
import { install, planUninstall, uninstall } from "./core/install.js";
import { launch } from "./core/launch.js";
import { loadEffectiveModels, refreshHarnessCatalog, resetHarnessModels, setHarnessModelRole, setModelPreset, setModelRole, type ModelSlot } from "./core/models.js";
import { harnessCatalogPath, loadHarnessCatalog, parseHarnessId, writeEffectiveHarnessModels } from "./core/harness-models.js";
import { resolvePaths } from "./core/paths.js";
import { ModelRoleSchema, type HarnessId } from "./core/schema.js";
import { addWorkspace, detectWorkspace, loadRegistry, removeWorkspace } from "./core/workspace.js";
import { spawnInteractive } from "./core/process.js";
import { approve, failure, heading, info, success, warning } from "./tui/index.js";
import { formatCapabilityGuide, interactiveCapabilitySelector } from "./tui/capabilities.js";
import { formatEffectiveModelMatrix, formatModelMatrix, interactiveModelSelector } from "./tui/models.js";
import { buildAtlasBaseline, indexAtlasWorkspace } from "./core/atlas-init.js";
import type { WorkspaceRules } from "./core/rules/generator.js";
import { saveRepositoryProfiles, saveWorkspaceRules } from "./core/rules/store.js";
import { renderRepositoryAgentsMarkdown, renderRulesDiff, type AgentsLanguage } from "./core/rules/render.js";
import { runAtlasOnboarding } from "./tui/atlas.js";
import { atomicWrite } from "./core/files.js";
import { hasGatewayCredentials, loadDecisionPlaneConfig, setDecisionPlaneMode } from "./core/decision.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = existsSync(join(sourceDirectory, "..", "package.json")) ? join(sourceDirectory, "..") : join(sourceDirectory, "..", "..");
const paths = resolvePaths();

function usage(): never {
  console.log(`mr-orchestrator

Usage:
  mr install [--workspace PATH] [--no-models] [--capabilities-later]
  mr capabilities [status | install | all]
  mr uninstall [--dry-run] [--purge] [--yes]
  mr workspace add PATH
  mr workspace list
  mr workspace remove ID
  mr models list [--harness ID] [--effective] [--origins]
  mr models set <role> <model> [model|alternative] [--harness ID]
  mr models reset [role [model|alternative]] --harness ID
  mr models validate --harness ID
  mr models catalog --harness ID [--refresh]
  mr models preset <key>
  mr flow-models [--harness ID]
  mr decision [status | shadow | off] [--model ID]
  mr atlas index
  mr atlas init [--guided] [--no-rules] [--lang en|es] [--write-repo-agents] [--yes]
  mr atlas rules [--diff] [--guided] [--lang en|es] [--write-repo-agents] [--yes]
  mr sync [ID]
  mr doctor
  mr launch [opencode arguments...]`);
  process.exit(0);
}

function option(arguments_: readonly string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

async function version(): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("package.json has no valid version");
  return packageJson.version;
}

async function runCapabilityInstaller(selection: CapabilitySelection): Promise<boolean> {
  const local = selection.selected.filter((id) => LOCAL_CAPABILITY_IDS.includes(id));
  if (local.length === 0) return true;
  const code = await spawnInteractive("/bin/sh", [
    join(sourceRoot, "scripts", "install-capabilities.sh"),
    paths.bunBinary,
    ...local,
  ], { cwd: sourceRoot, env: process.env });
  return code === 0;
}

function capabilityReminder(selection: CapabilitySelection): void {
  const pendingCredentials = (["github", "jira"] as const)
    .filter((id) => selection.selected.includes(id) && selection.credentials[id] === "pending");
  if (selection.selected.length < CAPABILITY_IDS.length || pendingCredentials.length > 0) {
    warning(`Configuración de capacidades pendiente. Ejecuta \`mr capabilities install\` más tarde.${pendingCredentials.length > 0 ? ` Credenciales: ${pendingCredentials.join(", ")}.` : ""}`);
  }
  if (selection.selected.includes("figma-live")) {
    info("Ejecuta `mr figma setup` para publicar el manifiesto del plugin en una ruta fija.");
  }
}

async function commandFigmaSetup(): Promise<void> {
  heading("Figma Live MCP");
  const published = await publishFigmaManifest(paths);
  const status = await assessFigmaSetup(paths);
  success(`Manifiesto publicado en ${published}`);
  info(figmaSetupInstructions(status, "es"));
}

async function chooseCapabilities(
  arguments_: readonly string[] = [],
  options: { readonly initialInstall?: boolean } = {},
): Promise<CapabilitySelection | null> {
  if (arguments_.includes("--capabilities-later")) {
    info("Skills y MCP aplazados. Continúa después con `mr capabilities install`.");
    return { ...defaultCapabilitySelection(), selected: [], updatedAt: new Date().toISOString() };
  }
  if (process.stdin.isTTY && process.stdout.isTTY) return interactiveCapabilitySelector(paths);
  if (options.initialInstall) {
    info("Selección interactiva de skills/MCP omitida: se instalará la selección recomendada y GitHub/Jira quedarán pendientes de credenciales.");
    return defaultCapabilitySelection();
  }
  info("Sin TTY: se reanudará la selección de capacidades guardada.");
  return loadCapabilitySelection(paths);
}

async function commandDecision(arguments_: readonly string[]): Promise<void> {
  const action = arguments_[0] ?? "status";
  if (!(["status", "shadow", "off"] as const).includes(action as "status" | "shadow" | "off")) {
    throw new Error("Usage: mr decision [status | shadow | off] [--model ID]");
  }
  const model = option(arguments_, "--model");
  if (arguments_.includes("--model") && model === undefined) throw new Error("--model requires an id");
  const config = action === "status"
    ? await loadDecisionPlaneConfig(paths)
    : await setDecisionPlaneMode(paths, action === "shadow" ? "shadow" : "off", model);
  heading("Jev Decision Plane");
  info(`Mode: ${config.mode}`);
  info(`Model: ${config.model}`);
  info(`Authority: deterministic FSM (Jev is advisory)`);
  if (hasGatewayCredentials()) success("Vercel AI Gateway credentials detected without reading or printing them.");
  else warning("No AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN detected. Shadow calls will fail closed without changing FSM decisions.");
}

async function commandInstall(arguments_: readonly string[]): Promise<void> {
  heading("mr-orchestrator install");
  const capabilities = await chooseCapabilities(arguments_, { initialInstall: true });
  if (capabilities === null) return;
  await seedModels(paths, sourceRoot);
  await saveCapabilitySelection(paths, capabilities);
  if (!(await runCapabilityInstaller(capabilities))) {
    warning("Una o más capacidades no pudieron instalarse. La instalación principal continuará; reintenta con `mr capabilities install`.");
  }
  if (!arguments_.includes("--no-models") && process.stdin.isTTY && process.stdout.isTTY) {
    await interactiveModelSelector(paths, { installation: true, sync: false });
    heading("Instalando mr-orchestrator");
  } else if (!arguments_.includes("--no-models")) {
    info("Selector de modelos omitido porque la instalación no tiene una terminal interactiva. Ejecuta `mr flow-models` después.");
  }
  const result = await install(paths, sourceRoot, await version());
  info(`${String(result.changedFiles.length)} launcher file(s) written.`);
  const workspaceRoot = option(arguments_, "--workspace");
  if (workspaceRoot !== undefined) {
    const profile = await addWorkspace(paths, workspaceRoot);
    await syncWorkspace(paths, profile, sourceRoot);
    info(`Registered ${profile.name}: ${profile.root}`);
  }
  capabilityReminder(capabilities);
  success("Installation complete. Run `mr doctor`.");
}

async function commandCapabilities(arguments_: readonly string[]): Promise<void> {
  const action = arguments_[0] ?? "status";
  if (action === "status") {
    const selection = await loadCapabilitySelection(paths);
    console.log(formatCapabilityGuide(selection, await detectInstalledCapabilities(paths, selection)));
    info("Para instalar, reanudar o cambiar la selección: `mr capabilities install`.");
    return;
  }
  let selection: CapabilitySelection | null;
  if (action === "all") {
    const current = await loadCapabilitySelection(paths);
    selection = {
      ...current,
      selected: [...CAPABILITY_IDS],
      updatedAt: new Date().toISOString(),
    };
  }
  else if (action === "install") selection = await chooseCapabilities();
  else throw new Error("Usage: mr capabilities [status | install | all]");
  if (selection === null) return;
  await saveCapabilitySelection(paths, selection);
  if (!(await runCapabilityInstaller(selection))) {
    warning("La descarga quedó incompleta. Puedes continuar trabajando y reintentar con `mr capabilities install`.");
  }
  await install(paths, sourceRoot, await version());
  const registry = await loadRegistry(paths);
  for (const workspace of registry.workspaces) await syncWorkspace(paths, workspace, sourceRoot);
  capabilityReminder(selection);
  success("Selección de capacidades aplicada.");
}

async function commandUninstall(arguments_: readonly string[]): Promise<void> {
  const plan = await planUninstall(paths);
  for (const item of plan) info(`${item.action}: ${item.path}`);
  if (arguments_.includes("--dry-run")) return;
  const confirmed = arguments_.includes("--yes") || (await approve("Remove manifest-owned launcher files?"));
  if (!confirmed) return;
  const completed = await uninstall(paths, arguments_.includes("--purge"));
  const preserved = completed.filter((item) => item.action === "preserve-modified");
  if (preserved.length > 0) warning(`${String(preserved.length)} modified file(s) preserved.`);
  success("Uninstall complete.");
}

async function commandWorkspace(arguments_: readonly string[]): Promise<void> {
  const action = arguments_[0];
  if (action === "add" && arguments_[1] !== undefined) {
    const profile = await addWorkspace(paths, arguments_[1]);
    await syncWorkspace(paths, profile);
    success(`Registered ${profile.id}: ${profile.root}`);
    return;
  }
  if (action === "list") {
    const registry = await loadRegistry(paths);
    registry.workspaces.forEach((workspace) => { info(`${workspace.id}\t${workspace.root}`); });
    return;
  }
  if (action === "remove" && arguments_[1] !== undefined) {
    if (!(await removeWorkspace(paths, arguments_[1]))) throw new Error(`Unknown workspace: ${arguments_[1]}`);
    success(`Removed ${arguments_[1]} from the registry.`);
    return;
  }
  throw new Error("Usage: mr workspace add PATH | list | remove ID");
}

async function commandSync(id: string | undefined): Promise<void> {
  const registry = await loadRegistry(paths);
  const profile = id === undefined ? detectWorkspace(registry, process.cwd()) : registry.workspaces.find((item) => item.id === id);
  if (profile === undefined) throw new Error("Workspace not found. Pass an ID or run from a registered workspace.");
  success(`Generated ${await syncWorkspace(paths, profile, sourceRoot)}`);
}

async function commandDoctor(): Promise<void> {
  heading("mr-orchestrator doctor");
  const checks = await runDoctor(paths);
  for (const check of checks) (check.ok ? info : warning)(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
  else success("All checks passed.");
}

async function commandModels(arguments_: readonly string[]): Promise<void> {
  const harnessValue = option(arguments_, "--harness");
  if (arguments_.includes("--harness") && harnessValue === undefined) throw new Error("--harness requires an id");
  const harness: HarnessId | undefined = harnessValue === undefined ? undefined : parseHarnessId(harnessValue);
  const positional = arguments_.filter((argument, index) => {
    const previous = arguments_[index - 1];
    return argument !== "--harness"
      && previous !== "--harness"
      && argument !== "--effective"
      && argument !== "--origins"
      && argument !== "--refresh";
  });
  const sub = positional[0];
  if (sub === "list") {
    if (harness === undefined) console.log(formatModelMatrix(await loadModels(paths)));
    else console.log(formatEffectiveModelMatrix(await loadEffectiveModels(paths, harness)));
    return;
  }
  if (sub === "set" && positional[1] !== undefined && positional[2] !== undefined) {
    const role = ModelRoleSchema.parse(positional[1]);
    const model = positional[2];
    const slot = (positional[3] ?? "model") as ModelSlot;
    if (slot !== "model" && slot !== "alternative") {
      throw new Error("Usage: mr models set <role> <model> [model|alternative] [--harness ID]");
    }
    if (harness === undefined) await setModelRole(paths, role, model, slot);
    else await setHarnessModelRole(paths, harness, role, model, slot);
    success(`Rol '${role}.${slot}' actualizado a '${model}' en ${harness === undefined ? "el roster global" : `el arnés '${harness}'`}.`);
    return;
  }
  if (sub === "reset") {
    if (harness === undefined) throw new Error("mr models reset requires --harness ID; the global roster cannot inherit from another scope");
    const role = positional[1] === undefined ? undefined : ModelRoleSchema.parse(positional[1]);
    const slot = positional[2] as ModelSlot | undefined;
    if (slot !== undefined && slot !== "model" && slot !== "alternative") {
      throw new Error("Usage: mr models reset [role [model|alternative]] --harness ID");
    }
    const effective = await resetHarnessModels(paths, harness, role, slot);
    success(`Override de '${harness}' restablecido. ${Object.values(effective.roles).filter((assignment) => assignment.primary.origin !== "global" || assignment.alternative.origin !== "global").length} rol(es) aún tienen overrides.`);
    return;
  }
  if (sub === "validate") {
    if (harness === undefined) throw new Error("mr models validate requires --harness ID");
    const effective = await loadEffectiveModels(paths, harness);
    const output = await writeEffectiveHarnessModels(paths, effective);
    console.log(formatEffectiveModelMatrix(effective));
    success(`Configuración válida; resultado efectivo: ${output}`);
    return;
  }
  if (sub === "catalog") {
    if (harness === undefined) throw new Error("mr models catalog requires --harness ID");
    if (arguments_.includes("--refresh")) {
      const refreshed = await refreshHarnessCatalog(paths, harness);
      info(`Catálogo actualizado: ${Object.keys(refreshed.catalog.models).length} modelos en ${harnessCatalogPath(paths, harness)}.`);
      if (refreshed.warning !== undefined) warning(refreshed.warning);
    } else {
      const catalog = await loadHarnessCatalog(paths, harness);
      if (catalog === undefined) throw new Error(`No existe catálogo para '${harness}' en ${harnessCatalogPath(paths, harness)}`);
      console.log(JSON.stringify(catalog, null, 2));
    }
    return;
  }
  if (sub === "preset" && positional[1] !== undefined) {
    if (harness !== undefined) throw new Error("Presets are global; omit --harness or configure explicit harness roles");
    const presetKey = positional[1];
    await setModelPreset(paths, presetKey);
    success(`Preset '${presetKey}' aplicado y workspaces sincronizados.`);
    return;
  }
  await interactiveModelSelector(paths, { ...(harness === undefined ? {} : { harness }) });
}

async function activeWorkspace() {
  const registry = await loadRegistry(paths);
  const workspace = detectWorkspace(registry, process.cwd());
  if (workspace === undefined) throw new Error("Workspace not found. Register it with `mr workspace add PATH` and run this command inside it.");
  return workspace;
}

async function writeRepositoryAgents(
  workspace: Awaited<ReturnType<typeof activeWorkspace>>,
  profiles: Awaited<ReturnType<typeof buildAtlasBaseline>>["profiles"],
  rules: WorkspaceRules,
  language: AgentsLanguage,
  assumeYes: boolean,
): Promise<void> {
  for (const profile of profiles) {
    const repositoryRules = rules.repositories.find((candidate) => candidate.repo === profile.repo);
    if (repositoryRules === undefined) continue;
    const path = join(workspace.root, profile.root, "AGENTS.md");
    const next = renderRepositoryAgentsMarkdown(repositoryRules, profile, rules.preferences, language);
    const previous = await readFile(path, "utf8").catch(() => undefined);
    const diff = renderRulesDiff(previous, next);
    info(`Proposed ${path}:\n${diff}`);
    if (diff === "No changes.") continue;
    const confirmed = assumeYes || (process.stdin.isTTY && process.stdout.isTTY && await approve(`Write ${path}?`));
    if (!confirmed) {
      warning(`Preserved ${path}; pass --yes to accept the displayed diff non-interactively.`);
      continue;
    }
    await atomicWrite(path, next.endsWith("\n") ? next : `${next}\n`);
    success(`Wrote ${path}`);
  }
}

async function commandAtlas(arguments_: readonly string[]): Promise<void> {
  const action = arguments_[0] ?? "init";
  if (!["index", "init", "rules"].includes(action)) throw new Error("Usage: mr atlas index | init [--guided] [--no-rules] [--lang en|es] | rules [--diff] [--guided] [--lang en|es]");
  const workspace = await activeWorkspace();
  heading(`mr atlas ${action}`);
  const graph = await indexAtlasWorkspace(paths, workspace);
  info(`Indexed ${String(graph.stats.totalFiles)} files, ${String(graph.stats.totalNodes)} nodes, ${String(graph.stats.totalEdges)} edges.`);
  if (action === "index") {
    success("Atlas index updated.");
    return;
  }
  const baseline = await buildAtlasBaseline(workspace, graph);
  for (const error of baseline.errors) warning(`Best-effort profiler: ${error}`);
  await saveRepositoryProfiles(workspace, baseline.profiles);
  if (arguments_.includes("--no-rules")) {
    success(`Atlas profiles saved for ${String(baseline.profiles.length)} repositories; rules were skipped.`);
    return;
  }
  if (baseline.proposal === undefined) {
    warning("Atlas index is usable, but no rules proposal could be generated.");
    return;
  }
  const language: AgentsLanguage = option(arguments_, "--lang") === "es" ? "es" : "en";
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  let rules = baseline.proposal.rules;
  if (interactive) {
    const onboarding = await runAtlasOnboarding(baseline.proposal, baseline.profiles, { guided: arguments_.includes("--guided"), language });
    if (onboarding.action === "skip") {
      success("Atlas profiles saved; rules onboarding skipped.");
      return;
    }
    rules = onboarding.rules;
  } else if (arguments_.includes("--guided")) {
    warning("Guided onboarding requires a TTY; inferred rules remain unconfirmed.");
  }
  const internalAgents = join(workspace.contextRoot, "atlas", "AGENTS.md");
  const previous = await readFile(internalAgents, "utf8").catch(() => undefined);
  const written = await saveWorkspaceRules(workspace, rules, baseline.profiles, language);
  if (arguments_.includes("--diff")) {
    const next = await readFile(internalAgents, "utf8");
    info(`Rules projection diff:\n${renderRulesDiff(previous, next)}`);
  }
  if (arguments_.includes("--write-repo-agents")) {
    await writeRepositoryAgents(workspace, baseline.profiles, rules, language, arguments_.includes("--yes"));
  }
  await seedModels(paths, sourceRoot);
  await syncWorkspace(paths, workspace);
  success(`Atlas rules saved (${String(written.length)} artifacts, ${String(baseline.profiles.length)} repositories).`);
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  switch (command) {
    case "install": await commandInstall(arguments_); break;
    case "capabilities": await commandCapabilities(arguments_); break;
    case "uninstall": await commandUninstall(arguments_); break;
    case "workspace": await commandWorkspace(arguments_); break;
    case "models": await commandModels(arguments_); break;
    case "decision": await commandDecision(arguments_); break;
    case "flow-models": {
      const harnessValue = option(arguments_, "--harness");
      if (arguments_.includes("--harness") && harnessValue === undefined) throw new Error("--harness requires an id");
      await interactiveModelSelector(paths, harnessValue === undefined ? {} : { harness: parseHarnessId(harnessValue) });
      break;
    }
    case "atlas": await commandAtlas(arguments_); break;
    case "sync": await commandSync(arguments_[0]); break;
    case "doctor": await commandDoctor(); break;
    case "figma": {
      const sub = arguments_[0];
      if (sub === "setup") await commandFigmaSetup();
      else throw new Error("Usage: mr figma setup");
      break;
    }
    case "launch": process.exitCode = await launch(paths, process.cwd(), arguments_); break;
    case "help": case "--help": case "-h": case undefined: usage(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  failure(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
