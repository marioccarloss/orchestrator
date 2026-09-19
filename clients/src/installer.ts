import { createHash } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bridgeEntryPath } from "./facade.js";
import {
  mergeClaudeConfig,
  mergeCodexConfig,
  mergeCursorConfig,
  mergeFxConfig,
  mergeFxSettings,
  mergeGeminiConfig,
  mergeOpenCodeCatalogs,
  removeCodexBridge,
  removeOwnedFxBridge,
  removeOwnedFxSettings,
  removeOwnedGeminiBridges,
  removeOwnedJsonBridge,
  removeOwnedJsonBridges,
  type McpServerConfig,
} from "./config.js";
import { adapterArtifacts } from "./adapters.js";
import type { HarnessId } from "./harness.js";

export type InstallTarget =
  | "opencode-cli"
  | "opencode-desktop"
  | "codex-cli"
  | "codex-desktop"
  | "cursor-cli"
  | "cursor-desktop"
  | "claude-code"
  | "antigravity-desktop"
  | "agy-cli"
  | "fx-cli";

type ArtifactTarget = "codex" | "cursor" | "claude" | "antigravity" | "agy" | "fx";
type ConfigTarget = "codex" | "cursor" | "claude" | "gemini" | "fx" | "fx-settings";
type LegacyConfigTarget = "antigravity" | "agy";
type ManagedTarget = ArtifactTarget | ConfigTarget;

interface OwnedEntry {
  kind?: "config" | "artifact";
  target: ManagedTarget;
  path: string;
  fingerprint: string;
  ownedKeys?: string[];
}

interface Manifest {
  version: 1;
  entries: OwnedEntry[];
}

const home = homedir();
const configHome = process.env["XDG_CONFIG_HOME"] ?? join(home, ".config");
const dataHome = process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
const manifestPath = join(dataHome, "mr-orchestrator-clients", "manifest.json");
const openCodePaths = [
  join(configHome, "mr-orchestrator", "recommended-mcps.json"),
  join(configHome, "opencode", "opencode.json"),
  join(configHome, "opencode", "opencode.jsonc"),
];

function targetPath(target: ConfigTarget): string {
  if (target === "codex") return join(home, ".codex", "config.toml");
  if (target === "cursor") return join(home, ".cursor", "mcp.json");
  if (target === "claude") return join(home, ".claude.json");
  if (target === "fx") return join(home, ".fx", "mcp.json");
  if (target === "fx-settings") return join(home, ".fx", "settings.json");
  return join(home, ".gemini", "config", "mcp_config.json");
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return "";
    throw error;
  }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

async function sourceCatalog(): Promise<Record<string, McpServerConfig>> {
  return mergeOpenCodeCatalogs(await Promise.all(openCodePaths.map(readOptional)));
}

function bridgeConfig(harness: HarnessId): McpServerConfig {
  return {
    command: [process.execPath, bridgeEntryPath(), "serve", "--harness", harness],
    env: { MR_HARNESS_ID: harness },
  };
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function loadManifest(): Promise<Manifest> {
  const content = await readOptional(manifestPath);
  if (content.length === 0) return { version: 1, entries: [] };
  const parsed: unknown = JSON.parse(content);
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { entries?: unknown }).entries)) return { version: 1, entries: [] };
  return parsed as Manifest;
}

async function saveManifest(manifest: Manifest): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

interface ConfigPlan {
  readonly target: Exclude<ConfigTarget, "fx-settings">;
  readonly bridges: Record<string, McpServerConfig>;
}

function configPlans(targets: InstallTarget[]): ConfigPlan[] {
  const selected = new Set(targets);
  const plans: ConfigPlan[] = [];
  if (selected.has("codex-cli") || selected.has("codex-desktop")) plans.push({ target: "codex", bridges: { "mr-orchestrator": bridgeConfig("codex") } });
  if (selected.has("cursor-cli") || selected.has("cursor-desktop")) plans.push({ target: "cursor", bridges: { "mr-orchestrator": bridgeConfig("cursor") } });
  if (selected.has("claude-code")) plans.push({ target: "claude", bridges: { "mr-orchestrator": bridgeConfig("claude") } });
  const geminiBridges: Record<string, McpServerConfig> = {};
  if (selected.has("antigravity-desktop")) geminiBridges["mr-orchestrator-antigravity"] = bridgeConfig("antigravity");
  if (selected.has("agy-cli")) geminiBridges["mr-orchestrator-agy"] = bridgeConfig("agy");
  if (Object.keys(geminiBridges).length > 0) plans.push({ target: "gemini", bridges: geminiBridges });
  if (selected.has("fx-cli")) plans.push({ target: "fx", bridges: { "mr-orchestrator": bridgeConfig("fx") } });
  return plans;
}

function removeManagedBridges(content: string, target: Exclude<ConfigTarget, "fx-settings"> | LegacyConfigTarget): string {
  if (target === "codex") return removeCodexBridge(content);
  if (target === "fx") return removeOwnedFxBridge(content);
  if (target === "gemini") return removeOwnedGeminiBridges(content);
  return removeOwnedJsonBridge(content);
}

function removePlanBridges(content: string, plan: ConfigPlan): string {
  if (plan.target !== "gemini") return removeManagedBridges(content, plan.target);
  return removeOwnedJsonBridges(content, "mcpServers", ["mr-orchestrator", ...Object.keys(plan.bridges)]);
}

export async function install(targets: InstallTarget[]): Promise<string[]> {
  const catalog = await sourceCatalog();
  const manifest = await loadManifest();
  const ownedConfigFingerprints = new Map(
    manifest.entries
      .filter((entry) => entry.kind !== "artifact")
      .map((entry) => [entry.path, entry.fingerprint]),
  );
  const ownedArtifactFingerprints = new Map(
    manifest.entries
      .filter((entry) => entry.kind === "artifact")
      .map((entry) => [entry.path, entry.fingerprint]),
  );
  const messages = targets.filter((target) => target.startsWith("opencode")).map(
    (target) => `${target === "opencode-cli" ? "OpenCode CLI" : "OpenCode Desktop"} selected: no changes made; its integration is immutable.`,
  );
  for (const plan of configPlans(targets)) {
    const { target } = plan;
    const path = targetPath(target);
    const before = await readOptional(path);
    const ownedFingerprint = ownedConfigFingerprints.get(path);
    const ownedUnchanged = ownedFingerprint !== undefined && fingerprint(before) === ownedFingerprint;
    const base = ownedUnchanged
      ? removePlanBridges(before, plan)
      : before;
    const after = target === "codex"
      ? mergeCodexConfig(base, catalog, plan.bridges["mr-orchestrator"]!)
      : target === "cursor"
        ? mergeCursorConfig(base, catalog, plan.bridges["mr-orchestrator"]!)
        : target === "claude"
          ? mergeClaudeConfig(base, catalog, plan.bridges["mr-orchestrator"]!)
          : target === "fx"
            ? mergeFxConfig(base, catalog, plan.bridges["mr-orchestrator"]!)
            : mergeGeminiConfig(base, catalog, plan.bridges);
    if (before === after && !ownedUnchanged) {
      messages.push(`Preserved ${target} MCP configuration at ${path}: an existing bridge entry is not owned by mr-orchestrator.`);
      continue;
    }
    if (before !== after) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, after);
    }
    manifest.entries = manifest.entries.filter((entry) => entry.kind === "artifact" || entry.path !== path);
    manifest.entries.push({ kind: "config", target, path, fingerprint: fingerprint(after) });
    messages.push(`Installed ${target} MCP configuration at ${path}.`);
  }
  if (targets.includes("fx-cli")) {
    const settingsPath = targetPath("fx-settings");
    const before = await readOptional(settingsPath);
    const previous = manifest.entries.find((entry) => entry.target === "fx-settings" && entry.path === settingsPath);
    const ownedUnchanged = previous !== undefined && fingerprint(before) === previous.fingerprint;
    const base = ownedUnchanged ? removeOwnedFxSettings(before, previous.ownedKeys ?? []) : before;
    const merged = mergeFxSettings(base);
    if (before !== merged.content) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, merged.content);
    }
    manifest.entries = manifest.entries.filter((entry) => entry.path !== settingsPath);
    if (merged.ownedKeys.length > 0) {
      manifest.entries.push({
        kind: "config",
        target: "fx-settings",
        path: settingsPath,
        fingerprint: fingerprint(merged.content),
        ownedKeys: [...merged.ownedKeys],
      });
      messages.push(`Configured fx native Jev reviewer in ${settingsPath}; provider and permission mode remain user-overridable.`);
    }
    if (merged.preservedKeys.length > 0) {
      messages.push(`Preserved user-managed fx settings: ${merged.preservedKeys.join(", ")}.`);
    }
  }

  const artifacts = adapterArtifacts(targets, home, [process.execPath, bridgeEntryPath()]);
  for (const owner of new Set(artifacts.map((artifact) => artifact.owner))) {
    manifest.entries = manifest.entries.filter((entry) => entry.kind !== "artifact" || entry.target !== owner);
  }
  for (const artifact of artifacts) {
    const before = await readOptional(artifact.path);
    let exists = true;
    try {
      await access(artifact.path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      exists = false;
    }
    const ownedFingerprint = ownedArtifactFingerprints.get(artifact.path);
    const isOwnedUnchanged = ownedFingerprint !== undefined && fingerprint(before) === ownedFingerprint;
    if (exists && before !== artifact.content && !isOwnedUnchanged) {
      messages.push(`Preserved ${artifact.path}: an existing user-managed adapter has different content.`);
      continue;
    }
    if (!exists || before !== artifact.content) {
      await mkdir(dirname(artifact.path), { recursive: true });
      await writeFile(artifact.path, artifact.content);
    }
    manifest.entries.push({ kind: "artifact", target: artifact.owner, path: artifact.path, fingerprint: fingerprint(artifact.content) });
    messages.push(`Installed ${artifact.invocation} adapter at ${artifact.path}.`);
  }
  await saveManifest(manifest);
  return messages;
}

export async function doctor(): Promise<string[]> {
  const manifest = await loadManifest();
  const results = ["OpenCode integration: immutable; not managed by mr-clients."];
  for (const entry of manifest.entries) {
    const content = await readOptional(entry.path);
    const kind = entry.kind === "artifact" ? "adapter" : "configuration";
    results.push(`${entry.target} ${kind}: ${fingerprint(content) === entry.fingerprint ? `managed ${kind} unchanged` : `${kind} changed; uninstall will preserve it`}`);
  }
  return results;
}

export async function uninstall(dryRun: boolean): Promise<string[]> {
  const manifest = await loadManifest();
  const remaining: OwnedEntry[] = [];
  const results: string[] = [];
  for (const entry of manifest.entries) {
    const content = await readOptional(entry.path);
    if (fingerprint(content) !== entry.fingerprint) {
      remaining.push(entry);
      results.push(`Preserved ${entry.path}: it changed after installation.`);
      continue;
    }
    if (entry.kind === "artifact") {
      results.push(`${dryRun ? "Would remove" : "Removed"} owned ${entry.target} adapter at ${entry.path}.`);
      if (!dryRun) await unlink(entry.path);
      continue;
    }
    const after = entry.target === "fx-settings"
      ? removeOwnedFxSettings(content, entry.ownedKeys ?? [])
      : removeManagedBridges(content, entry.target as Exclude<ConfigTarget, "fx-settings"> | LegacyConfigTarget);
    if (after === content) {
      remaining.push(entry);
      results.push(`Preserved ${entry.path}: its bridge entry no longer matches the owned configuration.`);
      continue;
    }
    results.push(`${dryRun ? "Would remove" : "Removed"} owned ${entry.target} bridge entry from ${entry.path}.`);
    if (!dryRun) {
      await access(entry.path);
      await writeFile(entry.path, after);
    }
  }
  if (!dryRun) await saveManifest({ version: 1, entries: remaining });
  return results;
}
