import type { WorkspaceProfile } from "./schema.js";
import { runCommand } from "./process.js";

// ─── Git Convention Resolver ─────────────────────────────────────────────────

export interface GitConventions {
  readonly baseBranch: string;
  readonly branchPattern: string;
  readonly commitPattern: string;
  readonly commitSignoff: boolean;
  readonly prDraft: boolean;
}

const DEFAULT_CONVENTIONS: GitConventions = {
  baseBranch: "develop",
  branchPattern: "feature/GH-<id>-<slug>",
  commitPattern: "feat: <description>",
  commitSignoff: true,
  prDraft: true,
};

export async function resolveGitConventions(profile: WorkspaceProfile): Promise<GitConventions> {
  // Try to read from .aicontext/rules or AGENTS.md
  const { readFile } = await import("node:fs/promises");
  const agentsPath = `${profile.root}/AGENTS.md`;
  try {
    const content = await readFile(agentsPath, "utf8");
    return parseConventionsFromMarkdown(content);
  } catch {
    return DEFAULT_CONVENTIONS;
  }
}

function parseConventionsFromMarkdown(content: string): GitConventions {
  const conventions = { ...DEFAULT_CONVENTIONS };

  // Extract base branch
  const baseBranchMatch = /base.*?branch[:\s]+`?(\w+)`?/i.exec(content);
  if (baseBranchMatch?.[1]) {
    (conventions as { baseBranch: string }).baseBranch = baseBranchMatch[1];
  }

  // Check for GPG sign requirement
  if (/GPG|sign/i.exec(content)) {
    (conventions as { commitSignoff: boolean }).commitSignoff = true;
  }

  return conventions;
}

export function generateBranchName(ticketId: string, type: string, slug?: string): string {
  // Strip GH- prefix if present to avoid duplication
  const cleanId = ticketId.replace(/^GH-/i, "").replace(/[^a-zA-Z0-9-]/g, "");
  const cleanSlug = slug
    ? slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    : cleanId.toLowerCase();

  switch (type) {
    case "bugfix": return `bugfix/GH-${cleanId}-${cleanSlug}`;
    case "hotfix": return `hotfix/GH-${cleanId}-${cleanSlug}`;
    case "release": return `release/GH-${cleanId}-${cleanSlug}`;
    default: return `feature/GH-${cleanId}-${cleanSlug}`;
  }
}

export async function getRecentCommitMessages(root: string, count = 30): Promise<readonly string[]> {
  const result = runCommand("git", ["-C", root, "log", `--oneline`, `-${count}`, "--format=%s"]);
  if (!result.ok) return [];
  return result.stdout.split("\n").filter((line) => line.length > 0);
}

export function suggestCommitMessage(ticketId: string, title: string, recentCommits: readonly string[]): string {
  // Analyze recent commits for pattern
  const hasConventional = recentCommits.some((msg) => /^(feat|fix|chore|docs|style|refactor|test):/i.test(msg));
  const prefix = hasConventional ? "feat" : "feat";

  const cleanTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50);

  return `${prefix}: ${cleanTitle} (${ticketId})`;
}

// ─── PR Port ─────────────────────────────────────────────────────────────────

export interface PrPort {
  createDraft(title: string, body: string, branch: string, baseBranch: string): Promise<string>;
}

export class GitHubPrAdapter implements PrPort {
  async createDraft(title: string, body: string, branch: string, baseBranch: string): Promise<string> {
    const result = runCommand("gh", [
      "pr", "create",
      "--draft",
      "--title", title,
      "--body", body,
      "--head", branch,
      "--base", baseBranch,
    ]);
    if (!result.ok) {
      throw new Error(`Failed to create PR: ${result.stderr}`);
    }
    // Extract URL from output
    const urlMatch = /(https:\/\/github\.com\/[^\s]+)/.exec(result.stdout);
    return urlMatch?.[1] ?? result.stdout.trim();
  }
}

export class GitLabPrAdapter implements PrPort {
  async createDraft(_title: string, _body: string, branch: string, _baseBranch: string): Promise<string> {
    // GitLab stub - would use glab or API
    return `https://gitlab.com/merge_requests/new?merge_request[source_branch]=${branch}`;
  }
}
