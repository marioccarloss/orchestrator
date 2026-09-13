import type { TicketRef, TicketContent, TicketPlatform } from "./flow-schema.js";
import { join } from "node:path";
import type { MrPaths } from "./paths.js";
import { atomicWrite, canonicalJson } from "./files.js";
import { runCommand } from "./process.js";

// ─── Ticket Port (Hexagonal Architecture) ────────────────────────────────────

export interface TicketPort {
  fetch(ref: TicketRef): Promise<TicketContent>;
}

// ─── GitHub Adapter ──────────────────────────────────────────────────────────

export class GitHubTicketAdapter implements TicketPort {
  constructor(private readonly mcpServer = "github") {}

  async fetch(ref: TicketRef): Promise<TicketContent> {
    // Try gh CLI first
    const result = runCommand("gh", ["issue", "view", ref.id, "--json", "title,body,number,url"]);
    if (result.ok) {
      const data = JSON.parse(result.stdout) as { title: string; body: string; number: number; url: string };
      return {
        schemaVersion: 1,
        ref: { ...ref, url: data.url },
        title: data.title,
        description: data.body,
        type: "feature",
        attachments: [],
        fetchedAt: new Date().toISOString(),
      };
    }
    throw new Error(`Failed to fetch GitHub issue ${ref.id}: ${result.stderr}`);
  }
}

// ─── Jira Adapter ────────────────────────────────────────────────────────────

export class JiraTicketAdapter implements TicketPort {
  constructor(private readonly mcpServer = "atlassian_read") {}

  async fetch(ref: TicketRef): Promise<TicketContent> {
    // Jira MCP integration uses the configured workspace server.
    // For now, stub with a placeholder that indicates MCP usage
    return {
      schemaVersion: 1,
      ref,
      title: `[Jira ${ref.id}]`,
      description: `Fetched via ${this.mcpServer} MCP (not yet implemented)`,
      type: "feature",
      attachments: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}

// ─── GitLab Adapter (Stub) ───────────────────────────────────────────────────

export class GitLabTicketAdapter implements TicketPort {
  async fetch(ref: TicketRef): Promise<TicketContent> {
    return {
      schemaVersion: 1,
      ref,
      title: `[GitLab ${ref.id}]`,
      description: "GitLab adapter not yet implemented",
      type: "feature",
      attachments: [],
      fetchedAt: new Date().toISOString(),
    };
  }
}

// ─── Local Adapter ───────────────────────────────────────────────────────────

export function inferLocalTicketType(taskText: string): TicketContent["type"] {
  const normalized = taskText.toLowerCase();
  if (/\b(?:hotfix|incident|production outage|incidente)\b/u.test(normalized)) return "hotfix";
  if (/\b(?:bug|fix|error|failure|broken|falla|fallo|corrige|corregir)\b/u.test(normalized)) return "bugfix";
  if (/\b(?:release|publish|deploy|lanzamiento)\b/u.test(normalized)) return "release";
  if (/\b(?:chore|maintenance|dependency|dependencies|mantenimiento|dependencia)\b/u.test(normalized)) return "chore";
  return "feature";
}

function localTitle(taskText: string): string {
  const firstLine = taskText.split(/\r?\n/u).map((line) => line.replace(/^\s*#+\s*/u, "").trim()).find(Boolean);
  const title = firstLine ?? "Local task";
  return title.length <= 120 ? title : `${title.slice(0, 119)}…`;
}

export class LocalTicketAdapter implements TicketPort {
  constructor(private readonly taskText: string) {}

  async fetch(ref: TicketRef): Promise<TicketContent> {
    return {
      schemaVersion: 1,
      ref,
      title: localTitle(this.taskText),
      description: this.taskText,
      type: inferLocalTicketType(this.taskText),
      attachments: [],
      fetchedAt: new Date().toISOString(),
      source: "user",
    };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTicketAdapter(platform: TicketPlatform, mcpServer?: string): TicketPort {
  switch (platform) {
    case "github": return new GitHubTicketAdapter(mcpServer);
    case "jira": return new JiraTicketAdapter(mcpServer);
    case "gitlab": return new GitLabTicketAdapter();
    case "local": return new LocalTicketAdapter(mcpServer ?? "Local task");
  }
}

interface LocalTicketCounter {
  readonly schemaVersion: 1;
  readonly date: string;
  readonly next: number;
}

/** Allocate a stable, human-readable local ticket id per workspace and UTC day. */
export async function nextLocalTicketId(
  paths: MrPaths,
  workspaceId: string,
  now = new Date(),
): Promise<string> {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const path = join(paths.generatedRoot, workspaceId, "local-ticket-counter.json");
  let counter: LocalTicketCounter | undefined;
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<LocalTicketCounter>;
    if (raw.schemaVersion === 1 && raw.date === date && typeof raw.next === "number" && Number.isInteger(raw.next) && raw.next > 0) {
      counter = raw as LocalTicketCounter;
    }
  } catch {
    // First local ticket or an invalid legacy counter: restart at 01 for today.
  }
  const sequence = counter?.next ?? 1;
  await atomicWrite(path, canonicalJson({ schemaVersion: 1, date, next: sequence + 1 }));
  return `LOCAL-${date}-${String(sequence).padStart(2, "0")}`;
}

// ─── Platform Detection (Ask-Once) ───────────────────────────────────────────

const PLATFORM_PREFERENCE_FILE = "ticket-platform.json";

export interface PlatformPreference {
  schemaVersion: 1;
  platform: TicketPlatform;
  mcpServer?: string;
  rememberedAt: string;
}

export async function loadPlatformPreference(configRoot: string, workspaceId: string): Promise<PlatformPreference | undefined> {
  const { readFile } = await import("node:fs/promises");
  const path = `${configRoot}/generated/${workspaceId}/${PLATFORM_PREFERENCE_FILE}`;
  try {
    const content = await readFile(path, "utf8");
    return JSON.parse(content) as PlatformPreference;
  } catch {
    return undefined;
  }
}

export async function savePlatformPreference(configRoot: string, workspaceId: string, pref: PlatformPreference): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const path = `${configRoot}/generated/${workspaceId}/${PLATFORM_PREFERENCE_FILE}`;
  const dir = path.slice(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(pref, null, 2));
}
