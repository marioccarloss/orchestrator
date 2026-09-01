import type { TicketRef, TicketContent, TicketPlatform } from "./flow-schema.js";
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

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTicketAdapter(platform: TicketPlatform, mcpServer?: string): TicketPort {
  switch (platform) {
    case "github": return new GitHubTicketAdapter(mcpServer);
    case "jira": return new JiraTicketAdapter(mcpServer);
    case "gitlab": return new GitLabTicketAdapter();
  }
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
