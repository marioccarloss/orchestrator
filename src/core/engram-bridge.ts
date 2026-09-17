import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import { capabilityPaths, loadCapabilitySelection } from "./capabilities.js";
import { runCommand, type CommandResult } from "./process.js";
import type { FlowState } from "./flow-schema.js";
import type { PlanningBrief } from "./sdd-schema.js";
import type { SpecCapsulePayload } from "./sdd-schema.js";

export const EngramMemoryHitSchema = z.strictObject({
  id: z.string().min(1),
  type: z.string().min(1).optional(),
  title: z.string().min(1),
  excerpt: z.string().min(1),
  project: z.string().min(1).optional(),
});

export type EngramMemoryHit = z.infer<typeof EngramMemoryHitSchema>;

export const FlowEngramPrefetchSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  query: z.string().min(1),
  hits: z.array(EngramMemoryHitSchema).max(5),
  atlasWarmed: z.boolean(),
  recordedAt: z.iso.datetime(),
});

export type FlowEngramPrefetch = z.infer<typeof FlowEngramPrefetchSchema>;

const ENTRY_HEADER_RE = /^\[(\d+)\]\s+#(\d+)\s*(?:\(([^)]+)\))?\s*—\s*(.+)$/u;
const PROJECT_TAIL_RE = /\|\s*project:\s*([^|]+)/u;

export function flowEngramPrefetchPath(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, "flow-engram-prefetch.json");
}

export async function resolveEngramBinary(paths: MrPaths): Promise<string | undefined> {
  const bundled = capabilityPaths(paths).engram;
  try {
    await access(bundled);
    return bundled;
  } catch {
    const probe = runCommand("which", ["engram"]);
    if (probe.ok && probe.stdout.trim()) return probe.stdout.trim();
    return undefined;
  }
}

export async function isEngramEnabled(paths: MrPaths): Promise<boolean> {
  const selection = await loadCapabilitySelection(paths);
  return selection.selected.includes("engram");
}

export function buildFlowMemoryQuery(title: string, description: string, extra?: string): string {
  const parts = [title.trim(), description.trim(), extra?.trim()].filter((part) => part !== undefined && part.length > 0);
  const merged = parts.join(" ").replace(/\s+/gu, " ").trim();
  return merged.slice(0, 400);
}

export function parseEngramSearchOutput(stdout: string, excerptLimit = 320): readonly EngramMemoryHit[] {
  const hits: EngramMemoryHit[] = [];
  const blocks = stdout.split(/\n(?=\[\d+\]\s+#\d+)/u).map((block) => block.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u);
    const header = lines[0];
    if (header === undefined) continue;
    const match = ENTRY_HEADER_RE.exec(header);
    if (match === null) continue;
    const id = match[2];
    const type = match[3];
    const title = match[4];
    if (id === undefined || title === undefined) continue;
    const bodyLines = lines.slice(1).filter((line) => line.trim().length > 0);
    const tail = bodyLines.at(-1) ?? "";
    const projectMatch = PROJECT_TAIL_RE.exec(tail);
    const excerptSource = projectMatch === null ? bodyLines.join(" ") : bodyLines.slice(0, -1).join(" ");
    const excerpt = excerptSource.replace(/\s+/gu, " ").trim().slice(0, excerptLimit);
    if (excerpt.length === 0) continue;
    hits.push(EngramMemoryHitSchema.parse({
      id: `#${id}`,
      ...(type === undefined ? {} : { type }),
      title: title.trim(),
      excerpt,
      ...(projectMatch === null ? {} : { project: projectMatch[1]?.trim() }),
    }));
  }
  return hits;
}

export interface EngramSearchOptions {
  readonly cwd: string;
  readonly limit?: number;
  readonly run?: (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => CommandResult;
}

export async function searchEngramMemories(
  binary: string,
  query: string,
  options: EngramSearchOptions,
): Promise<readonly EngramMemoryHit[]> {
  const run = options.run ?? runCommand;
  const limit = options.limit ?? 5;
  const result = run(binary, ["search", query, "--limit", String(limit)], { ...process.env, cwd: options.cwd });
  if (!result.ok || result.stdout.trim().length === 0) return [];
  if (result.stdout.startsWith("Found 0 memories")) return [];
  return parseEngramSearchOutput(result.stdout);
}

export interface EngramSaveOptions {
  readonly cwd: string;
  readonly topic: string;
  readonly type?: "decision" | "discovery" | "bugfix" | "architecture" | "session_summary";
  readonly run?: (command: string, args: readonly string[], env?: NodeJS.ProcessEnv) => CommandResult;
}

export async function saveEngramMemory(
  binary: string,
  title: string,
  content: string,
  options: EngramSaveOptions,
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  const run = options.run ?? runCommand;
  const args = [
    "save",
    title.slice(0, 200),
    content.slice(0, 4000),
    "--type",
    options.type ?? "decision",
    "--topic",
    options.topic,
  ];
  const result = run(binary, args, { ...process.env, cwd: options.cwd });
  if (!result.ok) {
    return { ok: false, detail: (result.stderr || result.stdout || "engram save failed").trim() };
  }
  return { ok: true, detail: result.stdout.trim() || "saved" };
}

export async function loadFlowEngramPrefetch(paths: MrPaths, workspaceId: string): Promise<FlowEngramPrefetch | undefined> {
  try {
    const parsed = FlowEngramPrefetchSchema.safeParse(JSON.parse(await readFile(flowEngramPrefetchPath(paths, workspaceId), "utf8")) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function saveFlowEngramPrefetch(
  paths: MrPaths,
  workspaceId: string,
  prefetch: FlowEngramPrefetch,
): Promise<void> {
  await atomicWrite(flowEngramPrefetchPath(paths, workspaceId), canonicalJson(FlowEngramPrefetchSchema.parse(prefetch)));
}

export interface WarmFlowContextInput {
  readonly paths: MrPaths;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly ticketId: string;
  readonly query: string;
  readonly indexAtlas: () => Promise<{ readonly reindexed: boolean }>;
}

export async function warmFlowContext(input: WarmFlowContextInput): Promise<FlowEngramPrefetch> {
  const [atlas, engramHits] = await Promise.all([
    input.indexAtlas(),
    prefetchFlowEngram(input.paths, input.workspaceRoot, input.query),
  ]);
  const prefetch = FlowEngramPrefetchSchema.parse({
    schemaVersion: 1,
    ticketId: input.ticketId,
    query: input.query,
    hits: [...engramHits],
    atlasWarmed: atlas.reindexed,
    recordedAt: new Date().toISOString(),
  });
  await saveFlowEngramPrefetch(input.paths, input.workspaceId, prefetch);
  return prefetch;
}

export async function prefetchFlowEngram(
  paths: MrPaths,
  workspaceRoot: string,
  query: string,
): Promise<readonly EngramMemoryHit[]> {
  if (!(await isEngramEnabled(paths))) return [];
  const binary = await resolveEngramBinary(paths);
  if (binary === undefined || query.trim().length === 0) return [];
  return searchEngramMemories(binary, query, { cwd: workspaceRoot, limit: 5 });
}

export function buildFlowCompletionMemory(input: {
  readonly state: FlowState;
  readonly spec?: SpecCapsulePayload;
  readonly brief?: PlanningBrief;
  readonly commitHash?: string;
  readonly prUrl?: string;
}): { readonly title: string; readonly content: string; readonly topic: string } {
  const ticket = "ticket" in input.state ? input.state.ticket : undefined;
  const ticketId = "ticketId" in input.state ? input.state.ticketId : ticket?.ref.id ?? "LOCAL";
  const title = `Flow ${ticketId} completed`;
  const lines = [
    `**What**: Completed mr-orchestrator /flow for ${ticketId}.`,
    ticket === undefined ? undefined : `**Ticket**: ${ticket.title}`,
    input.spec === undefined ? undefined : `**Goal**: ${input.spec.goal}`,
    input.brief === undefined ? undefined : `**Decisions**: ${input.brief.decisions.map((row) => row.decision).join("; ") || "none recorded"}`,
    "lane" in input.state && input.state.lane !== undefined ? `**Lane**: ${input.state.lane}` : undefined,
    "difficulty" in input.state ? `**Difficulty**: ${input.state.difficulty}` : undefined,
    input.commitHash === undefined ? undefined : `**Commit**: ${input.commitHash}`,
    input.prUrl === undefined ? undefined : `**PR**: ${input.prUrl}`,
    "**Why**: Preserve delivery context for future flows in this workspace.",
  ].filter((line): line is string => line !== undefined);
  return {
    title,
    content: lines.join("\n"),
    topic: `flow/${ticketId.toLowerCase().replace(/[^a-z0-9-]+/gu, "-")}`,
  };
}

export async function persistFlowCompletionMemory(
  paths: MrPaths,
  workspaceRoot: string,
  payload: { readonly title: string; readonly content: string; readonly topic: string },
): Promise<{ readonly ok: boolean; readonly detail: string }> {
  if (!(await isEngramEnabled(paths))) return { ok: false, detail: "engram not selected" };
  const binary = await resolveEngramBinary(paths);
  if (binary === undefined) return { ok: false, detail: "engram binary unavailable" };
  return saveEngramMemory(binary, payload.title, payload.content, {
    cwd: workspaceRoot,
    topic: payload.topic,
    type: "decision",
  });
}

export function renderFlowEngramPrefetch(prefetch: FlowEngramPrefetch | undefined): string {
  if (prefetch === undefined || prefetch.hits.length === 0) {
    return "No Engram prefetch available for this flow.";
  }
  const lines = [
    `Engram prefetch for ${prefetch.ticketId} (${prefetch.hits.length} hit(s), query="${prefetch.query.slice(0, 80)}")`,
    ...prefetch.hits.map((hit) => `- ${hit.id}${hit.type === undefined ? "" : ` (${hit.type})`}: ${hit.title} — ${hit.excerpt}`),
  ];
  return lines.join("\n");
}
