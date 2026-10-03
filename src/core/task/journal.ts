import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { sha256 } from "../files.js";
import type { MrPaths } from "../paths.js";
import { taskDir } from "./store.js";

/**
 * Relay journal: an append-only, typed record of everything the /task roles did.
 * It is written by deterministic plugin code (zero model tokens) and is the
 * single source for handoffs. Nothing is ever deleted; handoffs only choose
 * what to send inline versus by reference (manifest + recall).
 */

export const JournalKindSchema = z.enum([
  "input", "read", "search", "edit", "command", "fact", "decision", "discard", "unknown", "error", "note", "jev", "phase",
]);
export type JournalKind = z.infer<typeof JournalKindSchema>;

export const JournalEntrySchema = z.strictObject({
  id: z.string().regex(/^J\d+$/u),
  at: z.iso.datetime(),
  kind: JournalKindSchema,
  role: z.string().max(80).optional(),
  summary: z.string().max(400),
  file: z.string().max(500).optional(),
  range: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  fileSha: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  failed: z.boolean().optional(),
  detail: z.string().max(4_000).optional(),
});
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export type JournalDraft = Omit<JournalEntry, "id" | "at">;

/** Kinds that always travel verbatim to the next role. */
export const MUST_KEEP_KINDS: ReadonlySet<JournalKind> = new Set(["input", "fact", "decision", "discard", "unknown", "error"]);

export function isMustKeep(entry: JournalEntry): boolean {
  return MUST_KEEP_KINDS.has(entry.kind) || (entry.kind === "command" && entry.failed === true);
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{16,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*["']?[^\s"']{8,}/giu,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, "[REDACTED]"), text);
}

function clip(text: string, max: number): string {
  const clean = redactSecrets(text);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function tail(text: string, max: number): string {
  const clean = redactSecrets(text);
  return clean.length <= max ? clean : `…${clean.slice(clean.length - max + 1)}`;
}

export function journalPath(paths: MrPaths, workspaceId: string, taskId: string): string {
  return join(taskDir(paths, workspaceId, taskId), "journal.jsonl");
}

export async function loadJournal(paths: MrPaths, workspaceId: string, taskId: string): Promise<JournalEntry[]> {
  let content: string;
  try {
    content = await readFile(journalPath(paths, workspaceId, taskId), "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content.split("\n").filter((line) => line.trim().length > 0).flatMap((line) => {
    const parsed = JournalEntrySchema.safeParse(JSON.parse(line) as unknown);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Appends entries and assigns sequential ids. Callers must serialize writes per task. */
export async function appendJournal(
  paths: MrPaths,
  workspaceId: string,
  taskId: string,
  drafts: readonly JournalDraft[],
  now: string = new Date().toISOString(),
): Promise<readonly JournalEntry[]> {
  if (drafts.length === 0) return [];
  const existing = await loadJournal(paths, workspaceId, taskId);
  const entries = drafts.map((draft, index) => JournalEntrySchema.parse({
    ...draft,
    summary: clip(draft.summary, 400),
    ...(draft.detail === undefined ? {} : { detail: clip(draft.detail, 4_000) }),
    id: `J${String(existing.length + index + 1)}`,
    at: now,
  }));
  await mkdir(taskDir(paths, workspaceId, taskId), { recursive: true });
  await appendFile(journalPath(paths, workspaceId, taskId), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf8");
  return entries;
}

// ─── Relay capture (tool.execute.after) ──────────────────────────────────────

export interface ToolEventInput {
  readonly tool: string;
  readonly args: unknown;
  readonly output: string;
  readonly metadata?: unknown;
  readonly role?: string;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArg(args: Readonly<Record<string, unknown>>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function numberArg(args: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function workspaceRelative(workspaceRoot: string, file: string): string {
  if (!isAbsolute(file)) return file;
  const rel = relative(workspaceRoot, file);
  return rel.startsWith("..") ? file : rel;
}

const FAILURE_MARKERS = /\b(?:error|failed|failure|exception|traceback|cannot find|not found|exit code [1-9])\b/iu;

function exitCodeOf(metadata: unknown): number | undefined {
  const meta = record(metadata);
  for (const key of ["exit", "exitCode", "code", "status"]) {
    const value = meta[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return undefined;
}

/**
 * Maps one harness tool call to a journal draft. Returns undefined for tools that
 * carry no workspace knowledge (the mr_task_* tools journal themselves).
 */
export function captureToolEvent(
  input: ToolEventInput,
  workspaceRoot: string,
  fileSha?: (file: string) => string | undefined,
): JournalDraft | undefined {
  const tool = input.tool.toLowerCase();
  const args = record(input.args);
  const role = input.role === undefined ? {} : { role: input.role };
  if (tool.startsWith("mr_task_")) return undefined;

  if (tool === "read" || tool === "read_file") {
    const raw = stringArg(args, "filePath", "path", "file");
    if (raw === undefined) return undefined;
    const file = workspaceRelative(workspaceRoot, raw);
    const offset = numberArg(args, "offset") ?? 1;
    const limit = numberArg(args, "limit");
    const lineCount = input.output.split("\n").length;
    const start = Math.max(1, Math.trunc(offset));
    const end = Math.max(start, start + Math.max(1, Math.trunc(limit ?? lineCount)) - 1);
    const sha = fileSha?.(file);
    return {
      kind: "read",
      ...role,
      summary: `read ${file}:${String(start)}-${String(end)}`,
      file,
      range: [start, end],
      ...(sha === undefined ? {} : { fileSha: sha }),
    };
  }

  if (["grep", "glob", "list", "ls", "codesearch", "search"].includes(tool)) {
    const pattern = stringArg(args, "pattern", "query", "path") ?? "";
    const lines = input.output.split("\n").filter((line) => line.trim().length > 0);
    return {
      kind: "search",
      ...role,
      summary: `${tool} ${pattern} → ${String(lines.length)} line(s)`,
      detail: clip(lines.slice(0, 40).join("\n"), 1_500),
    };
  }

  if (["edit", "write", "patch", "multiedit", "apply_patch"].includes(tool)) {
    const raw = stringArg(args, "filePath", "path", "file");
    const file = raw === undefined ? undefined : workspaceRelative(workspaceRoot, raw);
    return {
      kind: "edit",
      ...role,
      summary: `${tool} ${file ?? "(patch)"}`,
      ...(file === undefined ? {} : { file }),
    };
  }

  if (tool === "bash" || tool === "shell" || tool === "terminal") {
    const command = stringArg(args, "command", "cmd") ?? "(command)";
    const exitCode = exitCodeOf(input.metadata);
    const failed = exitCode === undefined ? FAILURE_MARKERS.test(input.output.slice(-2_000)) : exitCode !== 0;
    return {
      kind: "command",
      ...role,
      summary: `$ ${clip(command, 200)}${exitCode === undefined ? "" : ` → exit ${String(exitCode)}`}`,
      failed,
      detail: tail(input.output, 1_500),
    };
  }
  return undefined;
}

// ─── Recall ──────────────────────────────────────────────────────────────────

export interface RecalledEntry {
  readonly entry: JournalEntry;
  readonly content?: string;
  readonly stale?: boolean;
}

export async function readRange(workspaceRoot: string, file: string, range: readonly [number, number], maxChars = 12_000): Promise<{ readonly text: string; readonly fileSha: string } | undefined> {
  try {
    const source = await readFile(isAbsolute(file) ? file : join(workspaceRoot, file), "utf8");
    const lines = source.split(/\r?\n/u);
    const text = lines.slice(range[0] - 1, range[1]).map((line, index) => `${String(range[0] + index)}: ${line}`).join("\n");
    return { text: clip(text, maxChars), fileSha: sha256(source) };
  } catch {
    return undefined;
  }
}

/** Returns full entries; reads are rehydrated from disk and flagged stale when the file changed. */
export async function recallEntries(entries: readonly JournalEntry[], ids: readonly string[], workspaceRoot: string): Promise<readonly RecalledEntry[]> {
  const wanted = new Set(ids);
  const results: RecalledEntry[] = [];
  for (const entry of entries.filter((candidate) => wanted.has(candidate.id))) {
    if (entry.kind === "read" && entry.file !== undefined && entry.range !== undefined) {
      const live = await readRange(workspaceRoot, entry.file, entry.range);
      results.push(live === undefined
        ? { entry, stale: true }
        : { entry, content: live.text, stale: entry.fileSha !== undefined && entry.fileSha !== live.fileSha });
      continue;
    }
    results.push({ entry });
  }
  return results;
}
