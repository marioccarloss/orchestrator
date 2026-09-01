#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModels, seedModels, syncWorkspace } from "./core/config.js";
import { runDoctor } from "./core/doctor.js";
import { install, planUninstall, uninstall } from "./core/install.js";
import { launch } from "./core/launch.js";
import { setModelPreset, setModelRole, type ModelRole } from "./core/models.js";
import { resolvePaths } from "./core/paths.js";
import { addWorkspace, detectWorkspace, loadRegistry, removeWorkspace } from "./core/workspace.js";
import { approve, failure, heading, info, success, warning } from "./tui/index.js";
import { formatModelMatrix, interactiveModelSelector } from "./tui/models.js";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const paths = resolvePaths();

function usage(): never {
  console.log(`mr-orchestrator

Usage:
  mr install [--workspace PATH] [--no-models]
  mr uninstall [--dry-run] [--purge] [--yes]
  mr workspace add PATH
  mr workspace list
  mr workspace remove ID
  mr models [list | set <role> <model> | preset <key>]
  mr flow-models
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

async function commandInstall(arguments_: readonly string[]): Promise<void> {
  heading("mr-orchestrator install");
  await seedModels(paths, sourceRoot);
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
    await syncWorkspace(paths, profile);
    info(`Registered ${profile.name}: ${profile.root}`);
  }
  success("Installation complete. Run `mr doctor`.");
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
  const sub = arguments_[0];
  if (sub === "list") {
    const models = await loadModels(paths);
    console.log(formatModelMatrix(models));
    return;
  }
  if (sub === "set" && arguments_[1] !== undefined && arguments_[2] !== undefined) {
    const role = arguments_[1] as ModelRole;
    const model = arguments_[2];
    await setModelRole(paths, role, model);
    success(`Rol '${role}' actualizado a '${model}' y workspaces sincronizados.`);
    return;
  }
  if (sub === "preset" && arguments_[1] !== undefined) {
    const presetKey = arguments_[1];
    await setModelPreset(paths, presetKey);
    success(`Preset '${presetKey}' aplicado y workspaces sincronizados.`);
    return;
  }
  await interactiveModelSelector(paths);
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  switch (command) {
    case "install": await commandInstall(arguments_); break;
    case "uninstall": await commandUninstall(arguments_); break;
    case "workspace": await commandWorkspace(arguments_); break;
    case "models": await commandModels(arguments_); break;
    case "flow-models": await interactiveModelSelector(paths); break;
    case "sync": await commandSync(arguments_[0]); break;
    case "doctor": await commandDoctor(); break;
    case "launch": process.exitCode = await launch(paths, process.cwd(), arguments_); break;
    case "help": case "--help": case "-h": case undefined: usage(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  failure(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
