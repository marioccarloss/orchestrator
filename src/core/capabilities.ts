import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";

export const CAPABILITY_VERSIONS = {
  codebaseMemory: "v0.10.8",
  codegraph: "v1.6.0",
  engram: "v1.20.0",
  figmaLive: "942c719a0ebd2afa9c8076ea0ae1ae61f01b7626",
  iHaveAdhd: "6f1f982d0a47c65899af3c5a7450b7098bc65325",
} as const;

export interface OpenCodeMcpServer {
  readonly type: "local" | "remote";
  readonly command?: readonly string[];
  readonly url?: string;
  readonly enabled: boolean;
}

export const CAPABILITY_IDS = [
  "i-have-adhd",
  "codebase-memory",
  "codegraph",
  "context7",
  "engram",
  "github",
  "jira",
  "figma-live",
] as const;

export type CapabilityId = typeof CAPABILITY_IDS[number];
export type CredentialStatus = "ready" | "pending";

export interface CapabilitySelection {
  readonly schemaVersion: 1;
  readonly selected: readonly CapabilityId[];
  readonly credentials: Readonly<Record<"github" | "jira", CredentialStatus>>;
  readonly updatedAt: string;
}

export const LOCAL_CAPABILITY_IDS: readonly CapabilityId[] = [
  "i-have-adhd", "codebase-memory", "codegraph", "engram", "figma-live",
];

export function defaultCapabilitySelection(now = new Date()): CapabilitySelection {
  return {
    schemaVersion: 1,
    selected: [...CAPABILITY_IDS],
    credentials: { github: "pending", jira: "pending" },
    updatedAt: now.toISOString(),
  };
}

function selectionPath(paths: MrPaths): string {
  return paths.capabilitiesConfig ?? join(paths.configRoot, "capabilities.json");
}

function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && (CAPABILITY_IDS as readonly string[]).includes(value);
}

export async function loadCapabilitySelection(paths: MrPaths): Promise<CapabilitySelection> {
  try {
    const value: unknown = JSON.parse(await readFile(selectionPath(paths), "utf8"));
    if (typeof value !== "object" || value === null) throw new Error("capabilities.json must be an object");
    const record = value as Record<string, unknown>;
    const selected = Array.isArray(record["selected"]) ? record["selected"].filter(isCapabilityId) : [];
    const credentials = typeof record["credentials"] === "object" && record["credentials"] !== null
      ? record["credentials"] as Record<string, unknown>
      : {};
    return {
      schemaVersion: 1,
      selected,
      credentials: {
        github: credentials["github"] === "ready" ? "ready" : "pending",
        jira: credentials["jira"] === "ready" ? "ready" : "pending",
      },
      updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : new Date(0).toISOString(),
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultCapabilitySelection();
    throw error;
  }
}

export async function saveCapabilitySelection(paths: MrPaths, selection: CapabilitySelection): Promise<void> {
  await atomicWrite(selectionPath(paths), canonicalJson(selection));
}

export async function detectInstalledCapabilities(
  paths: MrPaths,
  selection: CapabilitySelection,
): Promise<ReadonlySet<CapabilityId>> {
  const capability = capabilityPaths(paths);
  const probes: readonly (readonly [CapabilityId, string])[] = [
    ["i-have-adhd", capability.adhdSkill],
    ["codebase-memory", capability.codebaseMemory],
    ["codegraph", capability.codegraph],
    ["engram", capability.engram],
    ["figma-live", capability.figmaLive],
  ];
  const installed = new Set<CapabilityId>(["context7"]);
  await Promise.all(probes.map(async ([id, path]) => {
    try { await access(path); installed.add(id); } catch { /* not installed yet */ }
  }));
  for (const id of ["github", "jira"] as const) {
    if (selection.credentials[id] === "ready") installed.add(id);
  }
  return installed;
}

export function capabilityPaths(paths: MrPaths) {
  const root = paths.capabilitiesRoot ?? join(paths.dataRoot, "capabilities");
  return {
    codebaseMemory: join(root, "codebase-memory", CAPABILITY_VERSIONS.codebaseMemory, "codebase-memory-mcp"),
    codegraph: join(root, "codegraph", CAPABILITY_VERSIONS.codegraph, "bin", "codegraph"),
    engram: join(root, "engram", CAPABILITY_VERSIONS.engram, "engram"),
    figmaLive: join(root, "figma-live-mcp", CAPABILITY_VERSIONS.figmaLive, "dist", "figma-live-mcp"),
    figmaPluginManifest: join(root, "figma-live-mcp", CAPABILITY_VERSIONS.figmaLive, "packages", "figma-plugin", "manifest.json"),
    adhdSkill: join(root, "i-have-adhd", CAPABILITY_VERSIONS.iHaveAdhd, "skills", "i-have-adhd", "SKILL.md"),
    adhdPlugin: join(root, "i-have-adhd", CAPABILITY_VERSIONS.iHaveAdhd, ".opencode", "plugins", "i-have-adhd.mjs"),
  } as const;
}

/** Recommended MCP baseline. Workspace entries with the same name override it. */
export function recommendedMcpServers(
  paths: MrPaths,
  enabled: readonly CapabilityId[] = CAPABILITY_IDS,
): Record<string, OpenCodeMcpServer> {
  const capability = capabilityPaths(paths);
  const servers: Record<Exclude<CapabilityId, "i-have-adhd">, OpenCodeMcpServer> = {
    "codebase-memory": { type: "local", command: [capability.codebaseMemory], enabled: true },
    codegraph: { type: "local", command: [capability.codegraph, "serve", "--mcp"], enabled: true },
    context7: { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true },
    engram: { type: "local", command: [capability.engram, "mcp", "--tools=agent"], enabled: true },
    github: { type: "remote", url: "https://api.githubcopilot.com/mcp/", enabled: true },
    jira: { type: "remote", url: "https://mcp.atlassian.com/v1/mcp/authv2", enabled: true },
    "figma-live": { type: "local", command: [capability.figmaLive], enabled: true },
  };
  const selected = new Set(enabled);
  return Object.fromEntries(Object.entries(servers).filter(([name]) => selected.has(name as CapabilityId)));
}

export function recommendedMcpCatalog(paths: MrPaths, enabled: readonly CapabilityId[] = CAPABILITY_IDS): object {
  return { $schema: "https://opencode.ai/config.json", mcp: recommendedMcpServers(paths, enabled) };
}
