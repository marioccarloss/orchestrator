import { z } from "zod";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";

// ─── SDD + RPI Capsules ──────────────────────────────────────────────────────
//
// Best of both worlds, wired into the /flow phases:
//   explore  → ResearchCapsule (RPI: evidence-based findings, no prose)
//   plan     → PlanningBrief (Blueprint-lite: risk-driven clarification)
//            → SpecCapsule (SDD: requirements + acceptance criteria)
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

export const ResearchCapsulePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  objective: z.string().min(1).max(300),
  evidence: z.array(EvidenceSchema).min(1),
  relevantNodes: z.array(z.string()).default([]),
  constraints: z.array(z.string().max(300)).default([]),
  unknowns: z.array(z.string().max(300)).default([]),
});

export type ResearchCapsulePayload = z.infer<typeof ResearchCapsulePayloadSchema>;

export const ResearchCapsuleSchema = ResearchCapsulePayloadSchema.extend({
  createdAt: z.iso.datetime(),
});

export type ResearchCapsule = z.infer<typeof ResearchCapsuleSchema>;

// ── Planning brief (Blueprint-lite) ──────────────────────────────────────────

export const PlanningQuestionSchema = z.strictObject({
  id: z.string().regex(/^Q\d+$/u, "Question id must match Q<number>, e.g. Q1"),
  question: z.string().min(1).max(240),
  reason: z.string().min(1).max(240),
  risk: z.enum(["medium", "high"]),
  options: z.array(z.string().min(1).max(120)).max(5).default([]),
});

export const PlanningNeedsInputPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  status: z.literal("NEEDS_INPUT"),
  questions: z.array(PlanningQuestionSchema).min(1).max(3),
}).superRefine((payload, context) => {
  const ids = new Set<string>();
  let mediumSeen = false;
  for (const [index, question] of payload.questions.entries()) {
    if (ids.has(question.id)) {
      context.addIssue({ code: "custom", path: ["questions", index, "id"], message: `Duplicate question id ${question.id}` });
    }
    ids.add(question.id);
    if (question.risk === "medium") mediumSeen = true;
    if (question.risk === "high" && mediumSeen) {
      context.addIssue({ code: "custom", path: ["questions", index, "risk"], message: "Questions must be ordered high risk before medium risk" });
    }
  }
});

export type PlanningNeedsInputPayload = z.infer<typeof PlanningNeedsInputPayloadSchema>;

export const PlanningDecisionSchema = z.strictObject({
  questionId: z.string().regex(/^Q\d+$/u).optional(),
  decision: z.string().min(1).max(300),
  source: z.enum(["user", "ticket", "research"]),
});

export const PlanningAssumptionSchema = z.strictObject({
  statement: z.string().min(1).max(300),
  risk: z.enum(["low", "medium"]),
});

export const PlanningBriefPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  status: z.literal("READY"),
  mode: z.enum(["auto", "guided", "direct"]),
  decisions: z.array(PlanningDecisionSchema).max(8).default([]),
  assumptions: z.array(PlanningAssumptionSchema).max(5).default([]),
});

export type PlanningBriefPayload = z.infer<typeof PlanningBriefPayloadSchema>;

export const PlanningAssessmentPayloadSchema = z.discriminatedUnion("status", [
  PlanningNeedsInputPayloadSchema,
  PlanningBriefPayloadSchema,
]);

export const PlanningBriefSchema = PlanningBriefPayloadSchema.extend({
  createdAt: z.iso.datetime(),
});

export type PlanningBrief = z.infer<typeof PlanningBriefSchema>;

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

export const SpecCapsulePayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  goal: z.string().min(1).max(300),
  scopeIn: z.array(z.string().max(300)).min(1),
  scopeOut: z.array(z.string().max(300)).default([]),
  requirements: z.array(RequirementSchema).min(1),
  risks: z.array(z.string().max(300)).default([]),
});

export type SpecCapsulePayload = z.infer<typeof SpecCapsulePayloadSchema>;

export const SpecCapsuleSchema = SpecCapsulePayloadSchema.extend({
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

export const TaskGraphPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  tasks: z.array(SddTaskSchema).min(1),
});

export type TaskGraphPayload = z.infer<typeof TaskGraphPayloadSchema>;

export const TaskGraphSchema = TaskGraphPayloadSchema.extend({
  createdAt: z.iso.datetime(),
});

export type TaskGraph = z.infer<typeof TaskGraphSchema>;

// ── Cross-Validation (determinism guardrails) ────────────────────────────────

export interface SddValidationIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface SddValidationOptions {
  readonly requireEvidenceForModifiedFiles?: boolean;
}

/**
 * Structural guardrails beyond zod shape validation:
 *  - task DAG: no unknown or cyclic dependsOn references
 *  - traceability: every task requirement exists in the spec
 *  - coverage: every spec requirement is covered by at least one task
 *  - research linkage (soft): modified files should appear in research evidence
 */
export function validateSddArtifacts(
  spec: SpecCapsulePayload,
  tasks: TaskGraphPayload,
  research?: ResearchCapsulePayload,
  options: SddValidationOptions = {},
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

  if (research === undefined && options.requireEvidenceForModifiedFiles === true) {
    issues.push({ severity: "error", message: "Research capsule is required before task validation in Full flows" });
  }

  if (research !== undefined) {
    if (research.ticketId !== spec.ticketId) {
      issues.push({ severity: "error", message: `Research ticket '${research.ticketId}' != spec ticket '${spec.ticketId}'` });
    }
    const evidenceFiles = new Set(research.evidence.map((e) => e.file));
    for (const task of tasks.tasks) {
      for (const file of task.files) {
        if (file.action === "modify" && !evidenceFiles.has(file.path)) {
          issues.push({
            severity: options.requireEvidenceForModifiedFiles === true ? "error" : "warning",
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

export type SddKind = "research" | "brief" | "spec" | "tasks";
export type SddArtifact = ResearchCapsule | PlanningBrief | SpecCapsule | TaskGraph;
export type SddArtifactPayload = ResearchCapsulePayload | PlanningBriefPayload | SpecCapsulePayload | TaskGraphPayload;

const SDD_FILES: Record<SddKind, string> = {
  research: "research.json",
  brief: "brief.json",
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
  artifact: SddArtifact | SddArtifactPayload,
): Promise<string> {
  const dir = sddDir(paths, workspaceId);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, SDD_FILES[kind]);
  const createdAt = "createdAt" in artifact && typeof artifact.createdAt === "string"
    ? artifact.createdAt
    : new Date().toISOString();
  const persisted = (() => {
    switch (kind) {
      case "research": return ResearchCapsuleSchema.parse({ ...artifact, createdAt });
      case "brief": return PlanningBriefSchema.parse({ ...artifact, createdAt });
      case "spec": return SpecCapsuleSchema.parse({ ...artifact, createdAt });
      case "tasks": return TaskGraphSchema.parse({ ...artifact, createdAt });
    }
  })();
  await writeFile(filePath, canonicalJson(persisted));
  return filePath;
}

/** Remove disk-only audit metadata before a capsule enters model context. */
export function toOperationalSddPayload(artifact: SddArtifact): SddArtifactPayload {
  const { createdAt: _createdAt, ...payload } = artifact;
  if ("objective" in payload) return ResearchCapsulePayloadSchema.parse(payload);
  if ("status" in payload) return PlanningBriefPayloadSchema.parse(payload);
  if ("goal" in payload) return SpecCapsulePayloadSchema.parse(payload);
  return TaskGraphPayloadSchema.parse(payload);
}

/** Stable model-facing serialization: schema-normalized keys, no volatile audit timestamp. */
export function canonicalSddPayload(artifact: SddArtifact): string {
  return canonicalJson(toOperationalSddPayload(artifact)).trimEnd();
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

export async function loadPlanningBrief(paths: MrPaths, workspaceId: string): Promise<PlanningBrief | undefined> {
  const raw = await loadJson<unknown>(join(sddDir(paths, workspaceId), SDD_FILES.brief));
  if (raw === undefined) return undefined;
  const parsed = PlanningBriefSchema.safeParse(raw);
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
