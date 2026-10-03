import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson } from "../files.js";
import type { MrPaths } from "../paths.js";
import { ModelVariantSchema } from "../schema.js";
import { TaskStrategySchema, type TaskStrategy } from "./schema.js";

/**
 * Developer-owned reasoning effort per /task strategy and role. Models stay in
 * models.json; this file only overrides the variant (effort) of the role that
 * runs a given strategy, e.g. a low-effort planner for `replicate` and a
 * high-effort planner for `bugfix`. Jev never edits it.
 */

export const TaskEffortRoleSchema = z.enum(["explore", "plan", "general"]);
export type TaskEffortRole = z.infer<typeof TaskEffortRoleSchema>;

export const TaskEffortConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  strategies: z.partialRecord(TaskStrategySchema, z.partialRecord(TaskEffortRoleSchema, ModelVariantSchema)),
});
export type TaskEffortConfig = z.infer<typeof TaskEffortConfigSchema>;

export const EMPTY_TASK_EFFORT: TaskEffortConfig = { schemaVersion: 1, strategies: {} };

const BASE_AGENT: Readonly<Record<TaskEffortRole, string>> = {
  explore: "mr-task-explore",
  plan: "mr-task-plan",
  general: "mr-task-apply",
};

export function taskEffortPath(paths: MrPaths): string {
  return join(paths.configRoot, "task-effort.json");
}

/** Synchronous so config generation can stay synchronous. Invalid files are ignored with a warning. */
export function loadTaskEffortSync(paths: MrPaths): TaskEffortConfig {
  let raw: string;
  try {
    raw = readFileSync(taskEffortPath(paths), "utf8");
  } catch {
    return EMPTY_TASK_EFFORT;
  }
  const parsed = TaskEffortConfigSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    console.warn(`[mr-orchestrator] Ignoring invalid ${taskEffortPath(paths)}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return EMPTY_TASK_EFFORT;
  }
  return parsed.data;
}

export async function saveTaskEffort(paths: MrPaths, config: TaskEffortConfig): Promise<void> {
  await atomicWrite(taskEffortPath(paths), canonicalJson(TaskEffortConfigSchema.parse(config)));
}

export function setTaskEffort(config: TaskEffortConfig, strategy: TaskStrategy, role: TaskEffortRole, variant: string | undefined): TaskEffortConfig {
  const current = Object.fromEntries(Object.entries(config.strategies[strategy] ?? {}).filter(([key]) => key !== role));
  const roles = variant === undefined ? current : { ...current, [role]: ModelVariantSchema.parse(variant) };
  const others = Object.fromEntries(Object.entries(config.strategies).filter(([key]) => key !== strategy));
  const strategies = Object.keys(roles).length === 0 ? others : { ...others, [strategy]: roles };
  return TaskEffortConfigSchema.parse({ schemaVersion: 1, strategies });
}

export function taskAgentName(role: TaskEffortRole, variant?: string): string {
  return variant === undefined ? BASE_AGENT[role] : `${BASE_AGENT[role]}-${variant}`;
}

/** Every distinct (role, variant) pair that needs a generated agent. */
export function taskEffortVariants(config: TaskEffortConfig): readonly { readonly role: TaskEffortRole; readonly variant: string }[] {
  const pairs = new Map<string, { role: TaskEffortRole; variant: string }>();
  for (const roles of Object.values(config.strategies)) {
    for (const [role, variant] of Object.entries(roles) as [TaskEffortRole, string][]) {
      pairs.set(`${role}:${variant}`, { role, variant });
    }
  }
  return [...pairs.values()].sort((left, right) => `${left.role}:${left.variant}`.localeCompare(`${right.role}:${right.variant}`));
}

export interface TaskRoleRoute {
  readonly modelRole: TaskEffortRole;
  readonly agent: string;
  readonly variant?: string;
}

export function resolveTaskRoute(config: TaskEffortConfig, strategy: TaskStrategy, role: TaskEffortRole): TaskRoleRoute {
  const variant = config.strategies[strategy]?.[role];
  return { modelRole: role, agent: taskAgentName(role, variant), ...(variant === undefined ? {} : { variant }) };
}

/** Maps generated effort agents (mr-task-plan-low) back to their model role. */
export function taskAgentModelRole(agent: string): TaskEffortRole | undefined {
  for (const [role, base] of Object.entries(BASE_AGENT) as [TaskEffortRole, string][]) {
    if (agent === base || (agent.startsWith(`${base}-`) && ModelVariantSchema.safeParse(agent.slice(base.length + 1)).success)) return role;
  }
  return undefined;
}
