import { createHash } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bridgeEntryPath } from "./facade.js";
import { mergeAntigravityConfig, mergeClaudeConfig, mergeCodexConfig, mergeCursorConfig, mergeOpenCodeCatalogs, removeCodexBridge, removeJsonBridge, type McpServerConfig } from "./config.js";
import { adapterArtifacts } from "./adapters.js";

export type InstallTarget =
  | "opencode-cli"
  | "opencode-desktop"
  | "codex-cli"
  | "codex-desktop"
  | "cursor-cli"
  | "cursor-desktop"
  | "claude-code"
  | "antigravity-desktop"
  | "agy-cli";

type ManagedTarget = "codex" | "cursor" | "claude" | "antigravity" | "agy";
type ConfigTarget = Exclude<ManagedTarget, "agy">;

interface OwnedEntry {
  kind?: "config" | "artifact";
  target: ManagedTarget;
  path: string;
  fingerprint: string;
}

interface Manifest {
  version: 1;
  entries: OwnedEntry[];
}

const home = homedir();
const configHome = process.env["XDG_CONFIG_HOME"] ?? join(home, ".config");
const dataHome = process.env["XDG_DATA_HOME"] ?? join(home, ".local", "share");
const manifestPath = join(dataHome, "mr-orchestrator-clients", "manifest.json");
const openCodePaths = [join(configHome, "opencode", "opencode.json"), join(configHome, "opencode", "opencode.jsonc")];

function targetPath(target: ConfigTarget): string {
  if (target === "codex") return join(home, ".codex", "config.toml");
  if (target === "cursor") return join(home, ".cursor", "mcp.json");
  if (target === "claude") return join(home, ".claude.json");
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

function bridgeConfig(): McpServerConfig {
  return { command: [process.execPath, bridgeEntryPath(), "serve"], env: {} };
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

function uniqueTargets(targets: InstallTarget[]): ConfigTarget[] {
  return [...new Set(targets.flatMap((target): ConfigTarget[] => {
    if (target.startsWith("opencode")) return [];
    if (target.startsWith("codex")) return ["codex"];
    if (target.startsWith("cursor")) return ["cursor"];
    if (target === "claude-code") return ["claude"];
    return ["antigravity"];
  }))];
}

export async function install(targets: InstallTarget[]): Promise<string[]> {
  const catalog = await sourceCatalog();
  const manifest = await loadManifest();
  const ownedArtifactFingerprints = new Map(
    manifest.entries
      .filter((entry) => entry.kind === "artifact")
      .map((entry) => [entry.path, entry.fingerprint]),
  );
  const messages = targets.filter((target) => target.startsWith("opencode")).map(
    (target) => `${target === "opencode-cli" ? "OpenCode CLI" : "OpenCode Desktop"} selected: no changes made; its integration is immutable.`,
  );
  for (const target of uniqueTargets(targets)) {
    const path = targetPath(target);
    const before = await readOptional(path);
    const after = target === "codex"
      ? mergeCodexConfig(before, catalog, bridgeConfig())
      : target === "cursor"
        ? mergeCursorConfig(before, catalog, bridgeConfig())
        : target === "claude"
          ? mergeClaudeConfig(before, catalog, bridgeConfig())
          : mergeAntigravityConfig(before, catalog, bridgeConfig());
    if (before !== after) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, after);
    }
    manifest.entries = manifest.entries.filter((entry) => entry.kind === "artifact" || entry.target !== target);
    manifest.entries.push({ kind: "config", target, path, fingerprint: fingerprint(after) });
    messages.push(`Installed ${target} MCP configuration at ${path}.`);
  }
  const artifacts = adapterArtifacts(targets, home);
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
    const after = entry.target === "codex"
      ? removeCodexBridge(content)
      : removeJsonBridge(content, bridgeConfig());
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
