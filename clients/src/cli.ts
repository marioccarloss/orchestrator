#!/usr/bin/env bun
import * as p from "@clack/prompts";
import { serveStdio } from "./bridge.js";
import { facadeLoader, loadRegisteredWorkspaces } from "./facade.js";
import { doctor, install, type InstallTarget, uninstall } from "./installer.js";

const targets: Array<{ value: InstallTarget; label: string; hint: string }> = [
  { value: "opencode-cli", label: "OpenCode CLI", hint: "Informational only: immutable integration" },
  { value: "opencode-desktop", label: "OpenCode Desktop", hint: "Informational only: immutable integration" },
  { value: "codex-cli", label: "Codex CLI", hint: "MCP + $flow, $blueprint, and $flow-models skills" },
  { value: "codex-desktop", label: "Codex Desktop", hint: "MCP + $flow, $blueprint, and $flow-models skills" },
  { value: "cursor-cli", label: "Cursor CLI", hint: "MCP + /flow, /blueprint, and /flow-models skills" },
  { value: "cursor-desktop", label: "Cursor Desktop", hint: "MCP + /flow, /blueprint, and /flow-models skills" },
  { value: "claude-code", label: "Claude Code", hint: "MCP + /flow, /blueprint, and /flow-models commands" },
  { value: "antigravity-desktop", label: "Antigravity Desktop", hint: "MCP + flow, blueprint, and flow-models skills" },
  { value: "agy-cli", label: "AGY CLI", hint: "MCP + /flow, /blueprint, and /flow-models commands" },
];

const knownTargets = new Set(targets.map((target) => target.value));

function parseTargetFlags(args: string[]): InstallTarget[] | undefined {
  if (args.length === 0) return undefined;
  const unknown = args.filter((arg) => !knownTargets.has(arg as InstallTarget));
  if (unknown.length > 0) {
    console.error(`Unknown install target: ${unknown.join(", ")}`);
    process.exitCode = 1;
    return [];
  }
  const selected = args.filter((arg): arg is InstallTarget => knownTargets.has(arg as InstallTarget));
  return selected;
}

async function selectedTargets(): Promise<InstallTarget[]> {
  const selected = await p.multiselect({
    message: "Select clients to configure",
    options: targets,
    required: true,
  });
  if (p.isCancel(selected)) {
    p.cancel("Installation cancelled.");
    process.exitCode = 1;
    return [];
  }
  return selected;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "serve") {
    await serveStdio(facadeLoader, await loadRegisteredWorkspaces());
    return;
  }
  if (command === "install") {
    const selected = parseTargetFlags(args) ?? await selectedTargets();
    if (selected.length === 0) return;
    for (const message of await install(selected)) p.log.info(message);
    return;
  }
  if (command === "doctor") {
    for (const message of await doctor()) p.log.info(message);
    return;
  }
  if (command === "uninstall") {
    const dryRun = args.includes("--dry-run");
    for (const message of await uninstall(dryRun)) p.log.info(message);
    return;
  }
  console.error("Usage: mr-clients <install [targets...]|doctor|uninstall --dry-run|serve>");
  process.exitCode = 1;
}

void main();
