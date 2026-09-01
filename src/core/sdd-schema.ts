import { z } from "zod";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MrPaths } from "./paths.js";

// ─── SDD + RPI Capsules ──────────────────────────────────────────────────────
//
// Best of both worlds, wired into the /flow phases:
//   explore  → ResearchCapsule (RPI: evidence-based findings, no prose)
//   plan     → SpecCapsule (SDD: requirements + acceptance criteria)
//            → TaskGraph   (SDD tasks + RPI plan: bounded, verifiable DAG)
//   implement→ tasks served one at a time ("pase gol"), marked done deterministically
//
// The AI ONLY produces/consumes these compact typed graphs. User-facing
// markdown is rendered by script (see render.ts), never drafted by the model.

// ── Research (RPI) ────────────────────────────────────────────────────────────

export const EvidenceSourceSchema = z.enum(["atlas", "grep", "read", "memory", "ticket", "user"]);

export const EvidenceSchema = z.strictObject({
  claim: z.string().min(1).max(300),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  source: EvidenceSourceSchema,
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const ResearchCapsuleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  objective: z.string().min(1).max(300),
  evidence: z.array(EvidenceSchema).min(1),
  relevantNodes: z.array(z.string()).default([]),
  constraints: z.array(z.string().max(300)).default([]),
  unknowns: z.array(z.string().max(300)).default([]),
  createdAt: z.iso.datetime(),
});

export type ResearchCapsule = z.infer<typeof ResearchCapsuleSchema>;

// ── Spec (SDD) ────────────────────────────────────────────────────────────────

export const AcceptanceCriterionSchema = z.strictObject({
  given: z.string().max(300).optional(),
  when: z.string().min(1).max(300),
  then: z.string().min(1).max(300),
});

export const RequirementSchema = z.strictObject({
  id: z.string().regex(/^R\d+$/u, "Requirement id must match R<number>, e.g. R1"),
  statement: z.string().min(1).max(500),
  acceptance: z.array(AcceptanceCriterionSchema).min(1),
});

export type Requirement = z.infer<typeof RequirementSchema>;

export const SpecCapsuleSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  goal: z.string().min(1).max(300),
  scopeIn: z.array(z.string().max(300)).min(1),
  scopeOut: z.array(z.string().max(300)).default([]),
  requirements: z.array(RequirementSchema).min(1),
  risks: z.array(z.string().max(300)).default([]),
  createdAt: z.iso.datetime(),
});

export type SpecCapsule = z.infer<typeof SpecCapsuleSchema>;

// ── Task Graph (SDD tasks + RPI plan) ────────────────────────────────────────

export const TaskFileSchema = z.strictObject({
  path: z.string().min(1),
  action: z.enum(["create", "modify", "delete", "rename"]),
  reason: z.string().min(1).max(300),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
});

export const TaskStatusSchema = z.enum(["pending", "in_progress", "done", "blocked"]);

export const SddTaskSchema = z.strictObject({
  id: z.string().regex(/^T\d+$/u, "Task id must match T<number>, e.g. T1"),
  title: z.string().min(1).max(200),
  dependsOn: z.array(z.string().regex(/^T\d+$/u)).default([]),
  requirements: z.array(z.string().regex(/^R\d+$/u)).min(1),
  files: z.array(TaskFileSchema).min(1),
  verify: z.array(z.string().max(200)).min(1),
  doneWhen: z.array(z.string().max(300)).min(1),
  status: TaskStatusSchema.default("pending"),
});

export type SddTask = z.infer<typeof SddTaskSchema>;

export const TaskGraphSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  tasks: z.array(SddTaskSchema).min(1),
  createdAt: z.iso.datetime(),
});

export type TaskGraph = z.infer<typeof TaskGraphSchema>;

// ── Cross-Validation (determinism guardrails) ────────────────────────────────

export interface SddValidationIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

/**
 * Structural guardrails beyond zod shape validation:
 *  - task DAG: no unknown or cyclic dependsOn references
 *  - traceability: every task requirement exists in the spec
 *  - coverage: every spec requirement is covered by at least one task
 *  - research linkage (soft): modified files should appear in research evidence
 */
export function validateSddArtifacts(
  spec: SpecCapsule,
  tasks: TaskGraph,
  research?: ResearchCapsule,
): readonly SddValidationIssue[] {
  const issues: SddValidationIssue[] = [];
  const requirementIds = new Set(spec.requirements.map((r) => r.id));
  const taskIds = new Set(tasks.tasks.map((t) => t.id));

  if (spec.ticketId !== tasks.ticketId) {
    issues.push({ severity: "error", message: `Spec ticket '${spec.ticketId}' != tasks ticket '${tasks.ticketId}'` });
  }

  const duplicateTask = tasks.tasks.length !== taskIds.size;
  if (duplicateTask) {
    issues.push({ severity: "error", message: "Duplicate task ids in task graph" });
  }

  const coveredRequirements = new Set<string>();
  for (const task of tasks.tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        issues.push({ severity: "error", message: `Task ${task.id} depends on unknown task ${dep}` });
      }
      if (dep === task.id) {
        issues.push({ severity: "error", message: `Task ${task.id} depends on itself` });
      }
    }
    for (const req of task.requirements) {
      if (!requirementIds.has(req)) {
        issues.push({ severity: "error", message: `Task ${task.id} references unknown requirement ${req}` });
      }
      coveredRequirements.add(req);
    }
  }

  for (const requirement of spec.requirements) {
    if (!coveredRequirements.has(requirement.id)) {
      issues.push({ severity: "error", message: `Requirement ${requirement.id} is not covered by any task` });
    }
  }

  // Cycle detection over dependsOn
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(tasks.tasks.map((t) => [t.id, t]));
  const visit = (id: string, trail: readonly string[]): void => {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "visiting") {
      issues.push({ severity: "error", message: `Dependency cycle: ${[...trail, id].join(" → ")}` });
      return;
    }
    state.set(id, "visiting");
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (byId.has(dep)) visit(dep, [...trail, id]);
    }
    state.set(id, "done");
  };
  for (const task of tasks.tasks) visit(task.id, []);

  if (research !== undefined) {
    const evidenceFiles = new Set(research.evidence.map((e) => e.file));
    for (const task of tasks.tasks) {
      for (const file of task.files) {
        if (file.action === "modify" && !evidenceFiles.has(file.path)) {
          issues.push({
            severity: "warning",
            message: `Task ${task.id} modifies '${file.path}' without research evidence — verify before editing`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Next actionable task: pending, with every dependsOn already done.
 * Deterministic: lowest task number first.
 */
export function nextPendingTask(tasks: TaskGraph): SddTask | undefined {
  const done = new Set(tasks.tasks.filter((t) => t.status === "done").map((t) => t.id));
  return [...tasks.tasks]
    .sort((a, b) => Number.parseInt(a.id.slice(1), 10) - Number.parseInt(b.id.slice(1), 10))
    .find((t) => t.status === "pending" && t.dependsOn.every((dep) => done.has(dep)));
}

export function markTaskStatus(tasks: TaskGraph, taskId: string, status: SddTask["status"]): TaskGraph {
  if (!tasks.tasks.some((t) => t.id === taskId)) {
    throw new Error(`Unknown task ${taskId}`);
  }
  return {
    ...tasks,
    tasks: tasks.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)),
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export type SddKind = "research" | "spec" | "tasks";

const SDD_FILES: Record<SddKind, string> = {
  research: "research.json",
  spec: "spec.json",
  tasks: "tasks.json",
};

function sddDir(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, "sdd");
}

export async function saveSddArtifact(
  paths: MrPaths,
  workspaceId: string,
  kind: SddKind,
  artifact: ResearchCapsule | SpecCapsule | TaskGraph,
): Promise<string> {
  const dir = sddDir(paths, workspaceId);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, SDD_FILES[kind]);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return filePath;
}

async function loadJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function loadResearch(paths: MrPaths, workspaceId: string): Promise<ResearchCapsule | undefined> {
  const raw = await loadJson<unknown>(join(sddDir(paths, workspaceId), SDD_FILES.research));
  if (raw === undefined) return undefined;
  const parsed = ResearchCapsuleSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function loadSpec(paths: MrPaths, workspaceId: string): Promise<SpecCapsule | undefined> {
  const raw = await loadJson<unknown>(join(sddDir(paths, workspaceId), SDD_FILES.spec));
  if (raw === undefined) return undefined;
  const parsed = SpecCapsuleSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export async function loadTasks(paths: MrPaths, workspaceId: string): Promise<TaskGraph | undefined> {
  const raw = await loadJson<unknown>(join(sddDir(paths, workspaceId), SDD_FILES.tasks));
  if (raw === undefined) return undefined;
  const parsed = TaskGraphSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Compact zod error report the model can act on in one retry. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") === "" ? "(root)" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}
