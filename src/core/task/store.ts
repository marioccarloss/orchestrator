import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { atomicWrite, canonicalJson, sha256 } from "../files.js";
import type { MrPaths } from "../paths.js";
import {
  ExecutionPlanSchema,
  ExploreReportSchema,
  TaskStateSchema,
  type ExecutionPlan,
  type ExploreReport,
  type TaskState,
} from "./schema.js";

export function taskRoot(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, "task");
}

export function taskDir(paths: MrPaths, workspaceId: string, taskId: string): string {
  return join(taskRoot(paths, workspaceId), taskId);
}

function statePath(paths: MrPaths, workspaceId: string): string {
  return join(taskRoot(paths, workspaceId), "state.json");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

async function readOptionalJson<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function loadTaskState(paths: MrPaths, workspaceId: string): Promise<TaskState | undefined> {
  return readOptionalJson(statePath(paths, workspaceId), TaskStateSchema);
}

export async function saveTaskState(paths: MrPaths, state: TaskState): Promise<void> {
  const parsed = TaskStateSchema.parse(state);
  await mkdir(taskDir(paths, parsed.workspaceId, parsed.id), { recursive: true });
  await atomicWrite(statePath(paths, parsed.workspaceId), canonicalJson(parsed));
}

/** Removes the active pointer; the per-task directory (journal, capsule, plan) is kept for audit. */
export async function clearTaskState(paths: MrPaths, workspaceId: string): Promise<void> {
  await rm(statePath(paths, workspaceId), { force: true });
}

export function isTaskActive(state: TaskState | undefined): state is TaskState {
  return state !== undefined && state.phase !== "done" && state.phase !== "aborted";
}

export async function saveExploreReport(paths: MrPaths, state: TaskState, report: ExploreReport): Promise<string> {
  const content = canonicalJson(ExploreReportSchema.parse(report));
  await atomicWrite(join(taskDir(paths, state.workspaceId, state.id), "capsule.json"), content);
  return sha256(content);
}

export async function loadExploreReport(paths: MrPaths, state: TaskState): Promise<ExploreReport | undefined> {
  return readOptionalJson(join(taskDir(paths, state.workspaceId, state.id), "capsule.json"), ExploreReportSchema);
}

export async function saveExecutionPlan(paths: MrPaths, state: TaskState, plan: ExecutionPlan): Promise<string> {
  const content = canonicalJson(ExecutionPlanSchema.parse(plan));
  await atomicWrite(join(taskDir(paths, state.workspaceId, state.id), "plan.json"), content);
  return sha256(content);
}

export async function loadExecutionPlan(paths: MrPaths, state: TaskState): Promise<ExecutionPlan | undefined> {
  return readOptionalJson(join(taskDir(paths, state.workspaceId, state.id), "plan.json"), ExecutionPlanSchema);
}
