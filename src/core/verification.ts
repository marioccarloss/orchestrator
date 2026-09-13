import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson, readJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import { runCommand } from "./process.js";

export const VerificationCommandResultSchema = z.strictObject({
  command: z.string().min(1).max(200),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  outputTail: z.string().max(4_000).default(""),
});

export const VerificationReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: z.string().regex(/^T\d+$/u),
  results: z.array(VerificationCommandResultSchema).min(1),
  changedFiles: z.array(z.string()).default([]),
  diffHash: z.string().length(64),
  recordedAt: z.iso.datetime(),
});

export type VerificationCommandResult = z.infer<typeof VerificationCommandResultSchema>;
export type VerificationReceipt = z.infer<typeof VerificationReceiptSchema>;

export interface GitDiffFile {
  readonly path: string;
  readonly action: "create" | "modify" | "delete";
}

function receiptPath(paths: MrPaths, workspaceId: string, taskId: string): string {
  if (!/^T\d+$/u.test(taskId)) throw new Error(`Invalid task id '${taskId}'`);
  return join(paths.generatedRoot, workspaceId, "sdd", "verify", `${taskId}.json`);
}

export function getGitDiffNames(workspaceRoot: string): readonly string[] {
  runCommand("git", ["-C", workspaceRoot, "add", "-N", "."]);
  const result = runCommand("git", ["-C", workspaceRoot, "diff", "--name-only", "HEAD"]);
  if (!result.ok || result.stdout.trim() === "") return [];
  return [...new Set(result.stdout
    .split(/\r?\n/u)
    .map((file) => file.trim().replaceAll("\\", "/").replace(/^\.\//u, ""))
    .filter((file) => file.length > 0 && !file.startsWith(".aicontext/deliverables/mr/sdd/")))]
    .sort();
}

export function getGitDiffFiles(workspaceRoot: string): readonly GitDiffFile[] {
  runCommand("git", ["-C", workspaceRoot, "add", "-N", "."]);
  const result = runCommand("git", ["-C", workspaceRoot, "diff", "--name-status", "HEAD"]);
  if (!result.ok || result.stdout.trim() === "") return [];
  return result.stdout.split(/\r?\n/u).flatMap((line) => {
    const [status, ...parts] = line.split("\t");
    const path = (parts.at(-1) ?? "").trim().replaceAll("\\", "/").replace(/^\.\//u, "");
    if (path === "" || path.startsWith(".aicontext/deliverables/mr/sdd/")) return [];
    return [{ path, action: status?.startsWith("A") === true ? "create" as const : status?.startsWith("D") === true ? "delete" as const : "modify" as const }];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

export async function saveVerificationReceipt(
  paths: MrPaths,
  workspaceId: string,
  receipt: VerificationReceipt,
): Promise<string> {
  const parsed = VerificationReceiptSchema.parse(receipt);
  const path = receiptPath(paths, workspaceId, parsed.taskId);
  await atomicWrite(path, canonicalJson(parsed));
  return path;
}

export async function loadVerificationReceipt(
  paths: MrPaths,
  workspaceId: string,
  taskId: string,
): Promise<VerificationReceipt | undefined> {
  try {
    return await readJson(receiptPath(paths, workspaceId, taskId), VerificationReceiptSchema);
  } catch {
    return undefined;
  }
}
