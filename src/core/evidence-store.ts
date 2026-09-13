import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { AtlasGraph } from "./atlas.js";
import { findNodeByName } from "./atlas.js";
import { atomicWrite, canonicalJson, readJson, sha256 } from "./files.js";
import type { MrPaths } from "./paths.js";

export const EvidenceKindSchema = z.enum(["behavior", "contract", "type", "test", "config", "route", "style", "doc"]);
export const StoredEvidenceSourceSchema = z.enum(["atlas", "lsp", "grep", "read", "memory", "ticket", "user"]);

export const EvidenceRefSchema = z.strictObject({
  id: z.string().regex(/^ev-[a-f0-9]{8}$/u),
  file: z.string().min(1),
  symbol: z.string().optional(),
  range: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  fileHash: z.string().length(64),
  sliceHash: z.string().length(64),
  kind: EvidenceKindSchema,
  source: StoredEvidenceSourceSchema,
  supports: z.array(z.string().regex(/^R\d+$/u)).default([]),
  claim: z.string().min(1).max(300),
  createdAt: z.iso.datetime(),
});

export const EvidenceStoreSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  refs: z.array(EvidenceRefSchema),
});

export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type StoredEvidenceSource = z.infer<typeof StoredEvidenceSourceSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export type EvidenceStore = z.infer<typeof EvidenceStoreSchema>;

export type FreshnessResult =
  | { readonly status: "fresh" }
  | { readonly status: "relocated"; readonly range: [number, number]; readonly fileHash: string }
  | { readonly status: "stale"; readonly reason: "file-changed" | "file-missing" | "symbol-not-found" };

export interface AddEvidenceInput {
  readonly file: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: EvidenceKind;
  readonly source: StoredEvidenceSource;
  readonly claim: string;
  readonly supports?: readonly string[];
  readonly symbol?: string;
}

function safeTicket(ticketId: string): string {
  const safe = ticketId.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  if (safe.length === 0) throw new Error("ticketId must contain at least one letter or number");
  return safe;
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveWorkspaceFile(workspaceRoot: string, file: string): Promise<string> {
  if (file.length === 0 || isAbsolute(file)) throw new Error("Evidence file must be a workspace-relative path");
  const root = await realpath(workspaceRoot);
  const candidate = resolve(root, file);
  if (!isInside(root, candidate)) throw new Error(`Evidence file escapes the workspace: ${file}`);
  const canonical = await realpath(candidate);
  if (!isInside(root, canonical)) throw new Error(`Evidence file resolves outside the workspace: ${file}`);
  return canonical;
}

export function evidenceDir(paths: MrPaths, workspaceId: string, ticketId: string): string {
  return join(paths.generatedRoot, workspaceId, "evidence", safeTicket(ticketId));
}

export async function loadEvidenceStore(paths: MrPaths, workspaceId: string, ticketId: string): Promise<EvidenceStore | undefined> {
  try {
    return await readJson(join(evidenceDir(paths, workspaceId, ticketId), "store.json"), EvidenceStoreSchema);
  } catch {
    return undefined;
  }
}

export async function addEvidence(
  paths: MrPaths,
  workspaceId: string,
  workspaceRoot: string,
  ticketId: string,
  input: AddEvidenceInput,
): Promise<EvidenceRef> {
  if (input.startLine > input.endLine) throw new Error("startLine must be less than or equal to endLine");
  const filePath = await resolveWorkspaceFile(workspaceRoot, input.file);
  const content = await readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/u);
  if (input.startLine < 1 || input.endLine > lines.length) throw new Error(`Evidence range ${input.startLine}-${input.endLine} is outside ${input.file}`);
  const text = lines.slice(input.startLine - 1, input.endLine).join("\n");
  const sliceHash = sha256(text);
  const nextBase = {
    id: `ev-${sliceHash.slice(0, 8)}`,
    file: input.file,
    range: [input.startLine, input.endLine] as [number, number],
    fileHash: sha256(content),
    sliceHash,
    kind: input.kind,
    source: input.source,
    supports: [...new Set(input.supports ?? [])].sort(),
    claim: input.claim,
    createdAt: new Date().toISOString(),
  };
  const next = EvidenceRefSchema.parse(input.symbol === undefined ? nextBase : { ...nextBase, symbol: input.symbol });
  const current = await loadEvidenceStore(paths, workspaceId, ticketId) ?? { schemaVersion: 1 as const, ticketId, refs: [] };
  const duplicate = current.refs.find((ref) => ref.sliceHash === sliceHash);
  const ref = duplicate === undefined
    ? next
    : EvidenceRefSchema.parse({ ...duplicate, supports: [...new Set([...duplicate.supports, ...next.supports])].sort(), claim: next.claim });
  const refs = duplicate === undefined ? [...current.refs, ref] : current.refs.map((item) => item.id === duplicate.id ? ref : item);
  const dir = evidenceDir(paths, workspaceId, ticketId);
  await mkdir(join(dir, "slices"), { recursive: true });
  await atomicWrite(join(dir, "slices", `${sliceHash}.txt`), text);
  await atomicWrite(join(dir, "store.json"), canonicalJson(EvidenceStoreSchema.parse({ schemaVersion: 1, ticketId, refs })));
  return ref;
}

export async function listEvidence(
  paths: MrPaths,
  workspaceId: string,
  ticketId: string,
  filter: { readonly kind?: EvidenceKind; readonly supports?: string; readonly file?: string } = {},
): Promise<readonly EvidenceRef[]> {
  const refs = (await loadEvidenceStore(paths, workspaceId, ticketId))?.refs ?? [];
  return refs.filter((ref) =>
    (filter.kind === undefined || ref.kind === filter.kind)
    && (filter.supports === undefined || ref.supports.includes(filter.supports))
    && (filter.file === undefined || ref.file === filter.file));
}

export async function readEvidenceSlice(paths: MrPaths, workspaceId: string, ticketId: string, ref: EvidenceRef): Promise<string | undefined> {
  try {
    return await readFile(join(evidenceDir(paths, workspaceId, ticketId), "slices", `${ref.sliceHash}.txt`), "utf8");
  } catch {
    return undefined;
  }
}

/** Removes references not in `keepIds` and deletes now-unreferenced slice blobs. */
export async function pruneEvidence(
  paths: MrPaths,
  workspaceId: string,
  ticketId: string,
  keepIds: ReadonlySet<string>,
): Promise<{ readonly removed: readonly string[]; readonly kept: number }> {
  const current = await loadEvidenceStore(paths, workspaceId, ticketId);
  if (current === undefined) return { removed: [], kept: 0 };
  const refs = current.refs.filter((ref) => keepIds.has(ref.id));
  const removed = current.refs.filter((ref) => !keepIds.has(ref.id));
  const liveHashes = new Set(refs.map((ref) => ref.sliceHash));
  await Promise.all(removed.filter((ref) => !liveHashes.has(ref.sliceHash)).map(async (ref) => {
    await rm(join(evidenceDir(paths, workspaceId, ticketId), "slices", `${ref.sliceHash}.txt`), { force: true });
  }));
  await atomicWrite(join(evidenceDir(paths, workspaceId, ticketId), "store.json"), canonicalJson(EvidenceStoreSchema.parse({ ...current, refs })));
  return { removed: removed.map((ref) => ref.id), kept: refs.length };
}

export async function checkEvidenceFreshness(workspaceRoot: string, ref: EvidenceRef, graph?: AtlasGraph): Promise<FreshnessResult> {
  let content: string;
  try {
    content = await readFile(await resolveWorkspaceFile(workspaceRoot, ref.file), "utf8");
  } catch {
    return { status: "stale", reason: "file-missing" };
  }
  const fileHash = sha256(content);
  if (fileHash === ref.fileHash) return { status: "fresh" };
  if (ref.symbol === undefined || graph === undefined) return { status: "stale", reason: "file-changed" };
  const node = findNodeByName(graph, ref.symbol);
  if (node === undefined || node.filePath !== ref.file) return { status: "stale", reason: "symbol-not-found" };
  return { status: "relocated", range: [node.line, node.endLine ?? node.line], fileHash };
}
