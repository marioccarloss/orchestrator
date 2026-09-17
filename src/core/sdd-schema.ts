import { z } from "zod";
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, canonicalJson, compactJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import type { EvidenceStore, FreshnessResult } from "./evidence-store.js";
import {
  IntentAssessmentPayloadSchema,
  IntentCapsuleSchema,
  type IntentAssessmentPayload,
  type IntentBrief,
  type IntentCapsule,
} from "./intent-schema.js";

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

export const EvidenceSourceSchema = z.enum(["atlas", "lsp", "grep", "read", "memory", "ticket", "user"]);

export const EvidenceSchema = z.strictObject({
  claim: z.string().min(1).max(300),
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  source: EvidenceSourceSchema,
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const ResearchCoverageSchema = z.strictObject({
  fresh: z.boolean(),
  unsupportedFiles: z.array(z.string()).default([]),
  unresolvedImports: z.array(z.string()).default([]),
});

export const ContractRefSchema = z.strictObject({
  name: z.string().min(1),
  file: z.string().min(1),
  kind: z.enum(["dto", "interface", "schema", "route", "event", "federation"]),
});

export const TestRefSchema = z.strictObject({
  file: z.string().min(1),
  covers: z.array(z.string()).default([]),
});

export type ResearchCoverage = z.infer<typeof ResearchCoverageSchema>;
export type ContractRef = z.infer<typeof ContractRefSchema>;
export type TestRef = z.infer<typeof TestRefSchema>;

export const ResearchCapsulePayloadV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  objective: z.string().min(1).max(300),
  evidence: z.array(EvidenceSchema).min(1),
  relevantNodes: z.array(z.string()).default([]),
  constraints: z.array(z.string().max(300)).default([]),
  unknowns: z.array(z.string().max(300)).default([]),
});

export const ResearchCapsulePayloadV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ticketId: z.string().min(1),
  objective: z.string().min(1).max(300),
  evidenceRefs: z.array(z.string().regex(/^ev-[a-f0-9]{8}$/u)).min(1),
  coverage: ResearchCoverageSchema,
  contracts: z.array(ContractRefSchema).default([]),
  tests: z.array(TestRefSchema).default([]),
  relevantNodes: z.array(z.string()).default([]),
  constraints: z.array(z.string().max(300)).default([]),
  unknowns: z.array(z.string().max(300)).default([]),
});

export const ResearchCapsulePayloadInputSchema = z.union([ResearchCapsulePayloadV1Schema, ResearchCapsulePayloadV2Schema]);
export const ResearchCapsulePayloadSchema = ResearchCapsulePayloadV2Schema;

export type ResearchCapsulePayloadV1 = z.infer<typeof ResearchCapsulePayloadV1Schema>;
export type ResearchCapsulePayload = z.infer<typeof ResearchCapsulePayloadV2Schema>;

export async function migrateResearchToV2(
  input: z.infer<typeof ResearchCapsulePayloadInputSchema>,
  createLegacyRef: (evidence: Evidence) => Promise<string>,
  coverage?: ResearchCoverage,
): Promise<ResearchCapsulePayload> {
  if (input.schemaVersion === 2) {
    return ResearchCapsulePayloadV2Schema.parse(coverage === undefined ? input : { ...input, coverage });
  }
  const evidenceRefs: string[] = [];
  for (const evidence of input.evidence) evidenceRefs.push(await createLegacyRef(evidence));
  return ResearchCapsulePayloadV2Schema.parse({
    schemaVersion: 2,
    ticketId: input.ticketId,
    objective: input.objective,
    evidenceRefs: [...new Set(evidenceRefs)],
    coverage: coverage ?? { fresh: false, unsupportedFiles: [], unresolvedImports: [] },
    contracts: [],
    tests: [],
    relevantNodes: input.relevantNodes,
    constraints: input.constraints,
    unknowns: input.unknowns,
  });
}

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

export const TaskFileV1Schema = z.strictObject({
  path: z.string().min(1),
  action: z.enum(["create", "modify", "delete", "rename"]),
  reason: z.string().min(1).max(300),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
});

export const TaskFileSchema = TaskFileV1Schema.extend({
  evidenced: z.boolean(),
}).superRefine((file, context) => {
  if (!file.evidenced && file.reason.length < 40) {
    context.addIssue({ code: "custom", path: ["reason"], message: "Unevidenced files require a reason of at least 40 characters" });
  }
});

export const TaskStatusSchema = z.enum(["pending", "in_progress", "done", "blocked"]);

export const SddTaskV1Schema = z.strictObject({
  id: z.string().regex(/^T\d+$/u, "Task id must match T<number>, e.g. T1"),
  title: z.string().min(1).max(200),
  dependsOn: z.array(z.string().regex(/^T\d+$/u)).default([]),
  requirements: z.array(z.string().regex(/^R\d+$/u)).min(1),
  files: z.array(TaskFileV1Schema).min(1),
  verify: z.array(z.string().max(200)).min(1),
  doneWhen: z.array(z.string().max(300)).min(1),
  status: TaskStatusSchema.default("pending"),
});

export const EditBoundariesSchema = z.strictObject({
  allowedFiles: z.array(z.string().min(1)).min(1),
  forbiddenGlobs: z.array(z.string()).default([]),
});

export const ExpectedDiffSchema = z.strictObject({
  adds: z.array(z.string().max(200)).default([]),
  removes: z.array(z.string().max(200)).default([]),
  touchedTests: z.array(z.string()).default([]),
});

export const TaskVerificationSchema = z.strictObject({
  commands: z.array(z.string().min(1).max(200)).min(1),
  mustPass: z.boolean().default(true),
});

export const SddTaskSchema = z.strictObject({
  id: z.string().regex(/^T\d+$/u, "Task id must match T<number>, e.g. T1"),
  title: z.string().min(1).max(200),
  dependsOn: z.array(z.string().regex(/^T\d+$/u)).default([]),
  requirements: z.array(z.string().regex(/^R\d+$/u)).min(1),
  files: z.array(TaskFileSchema).min(1),
  doneWhen: z.array(z.string().max(300)).min(1),
  status: TaskStatusSchema.default("pending"),
  targetSymbols: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().regex(/^ev-[a-f0-9]{8}$/u)).min(1),
  changeIntent: z.string().min(1).max(300),
  editBoundaries: EditBoundariesSchema,
  invariants: z.array(z.string().max(300)).default([]),
  expectedDiff: ExpectedDiffSchema.default({ adds: [], removes: [], touchedTests: [] }),
  verification: TaskVerificationSchema,
});

const SddTaskV2InputSchema = z.strictObject({
  id: z.string().regex(/^T\d+$/u, "Task id must match T<number>, e.g. T1"),
  title: z.string().min(1).max(200),
  dependsOn: z.array(z.string().regex(/^T\d+$/u)).default([]),
  requirements: z.array(z.string().regex(/^R\d+$/u)).min(1),
  files: z.array(TaskFileV1Schema.extend({ evidenced: z.boolean().optional() })).min(1),
  doneWhen: z.array(z.string().max(300)).min(1),
  status: TaskStatusSchema.default("pending"),
  targetSymbols: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().regex(/^ev-[a-f0-9]{8}$/u)).min(1),
  changeIntent: z.string().min(1).max(300),
  editBoundaries: EditBoundariesSchema,
  invariants: z.array(z.string().max(300)).default([]),
  expectedDiff: ExpectedDiffSchema.default({ adds: [], removes: [], touchedTests: [] }),
  verification: TaskVerificationSchema,
});

export type SddTask = z.infer<typeof SddTaskSchema>;

export const TaskGraphPayloadV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  tasks: z.array(SddTaskV1Schema).min(1),
});

export const TaskGraphPayloadV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  ticketId: z.string().min(1),
  tasks: z.array(SddTaskSchema).min(1),
});

export const TaskGraphPayloadV2InputSchema = z.strictObject({
  schemaVersion: z.literal(2),
  ticketId: z.string().min(1),
  tasks: z.array(SddTaskV2InputSchema).min(1),
});

export const TaskGraphPayloadInputSchema = z.union([TaskGraphPayloadV1Schema, TaskGraphPayloadV2InputSchema]);
export const TaskGraphPayloadSchema = TaskGraphPayloadV2Schema;

export type TaskGraphPayload = z.infer<typeof TaskGraphPayloadSchema>;

export const TaskGraphSchema = TaskGraphPayloadSchema.extend({
  createdAt: z.iso.datetime(),
});

export type TaskGraph = z.infer<typeof TaskGraphSchema>;

export function migrateTaskGraphToV2(
  input: z.infer<typeof TaskGraphPayloadInputSchema>,
  research?: ResearchCapsulePayload,
  store?: EvidenceStore,
): TaskGraphPayload {
  if (input.schemaVersion === 2) {
    return TaskGraphPayloadV2Schema.parse({
      ...input,
      tasks: input.tasks.map((task) => ({
        ...task,
        files: task.files.map((file) => ({
          ...file,
          evidenced: store === undefined
            ? (file.evidenced ?? false)
            : store.refs.some((ref) => task.evidenceRefs.includes(ref.id) && ref.file === file.path),
        })),
      })),
    });
  }
  const researchIds = new Set(research?.evidenceRefs ?? []);
  const available = store?.refs.filter((ref) => researchIds.size === 0 || researchIds.has(ref.id)) ?? [];
  if (available.length === 0) throw new Error("Cannot migrate TaskGraph v1 without stored research evidence");
  return TaskGraphPayloadV2Schema.parse({
    schemaVersion: 2,
    ticketId: input.ticketId,
    tasks: input.tasks.map((task) => {
      const filePaths = new Set(task.files.map((file) => file.path));
      const matching = available.filter((ref) => filePaths.has(ref.file));
      const evidenceRefs = [...new Set((matching.length > 0 ? matching : available).map((ref) => ref.id))];
      return {
        id: task.id,
        title: task.title,
        dependsOn: task.dependsOn,
        requirements: task.requirements,
        files: task.files.map((file) => {
          const evidenced = matching.some((ref) => ref.file === file.path);
          const reason = !evidenced && file.reason.length < 40
            ? `${file.reason}. No matching stored evidence was available during legacy migration.`
            : file.reason;
          return { ...file, reason, evidenced };
        }),
        doneWhen: task.doneWhen,
        status: task.status,
        targetSymbols: [],
        evidenceRefs,
        changeIntent: task.files.map((file) => file.reason).join("; ").slice(0, 300),
        editBoundaries: { allowedFiles: task.files.map((file) => file.path), forbiddenGlobs: [] },
        invariants: [],
        expectedDiff: { adds: [], removes: [], touchedTests: task.files.filter((file) => /(?:\.test\.|\.spec\.|(?:^|\/)tests?\/)/u.test(file.path)).map((file) => file.path) },
        verification: { commands: task.verify, mustPass: true },
      };
    }),
  });
}

// ── Cross-Validation (determinism guardrails) ────────────────────────────────

export interface SddValidationIssue {
  readonly severity: "error" | "warning";
  readonly message: string;
}

export interface SddValidationOptions {
  readonly requireEvidenceForModifiedFiles?: boolean;
  readonly evidenceStore?: EvidenceStore;
  readonly freshness?: ReadonlyMap<string, FreshnessResult>;
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
    for (const refId of task.evidenceRefs) {
      const stored = options.evidenceStore?.refs.find((ref) => ref.id === refId);
      if (options.evidenceStore !== undefined && stored === undefined) {
        issues.push({ severity: "error", message: `Task ${task.id} references missing evidence ${refId}` });
      }
      if (options.freshness?.get(refId)?.status === "stale") {
        issues.push({ severity: options.requireEvidenceForModifiedFiles === true ? "error" : "warning", message: `Task ${task.id} evidence ${refId} is stale` });
      }
    }
    for (const file of task.files) {
      if (!task.editBoundaries.allowedFiles.includes(file.path)) {
        issues.push({ severity: "error", message: `Task ${task.id} file '${file.path}' is outside editBoundaries.allowedFiles` });
      }
    }
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
    const storedRefs = new Map(options.evidenceStore?.refs.map((ref) => [ref.id, ref]) ?? []);
    const evidenceFiles = new Set(research.evidenceRefs.map((id) => storedRefs.get(id)?.file).filter((file): file is string => file !== undefined));
    for (const refId of research.evidenceRefs) {
      if (!storedRefs.has(refId)) issues.push({ severity: "error", message: `Research references missing evidence ${refId}` });
      if (options.freshness?.get(refId)?.status === "stale") {
        issues.push({
          severity: options.requireEvidenceForModifiedFiles === true ? "error" : "warning",
          message: `Research evidence ${refId} is stale`,
        });
      }
    }
    for (const requirement of spec.requirements) {
      const supported = options.evidenceStore?.refs.some((ref) => research.evidenceRefs.includes(ref.id) && ref.supports.includes(requirement.id)) ?? false;
      if (research.evidenceRefs.length > 0 && !supported) {
        issues.push({
          severity: options.requireEvidenceForModifiedFiles === true ? "error" : "warning",
          message: `Requirement ${requirement.id} has no supporting evidence reference`,
        });
      }
    }
    for (const task of tasks.tasks) {
      if (task.files.some((file) => file.action === "modify") && task.evidenceRefs.length === 0 && research.evidenceRefs.length > 0) {
        issues.push({
          severity: options.requireEvidenceForModifiedFiles === true ? "error" : "warning",
          message: `Task ${task.id} modifies files without evidenceRefs`,
        });
      }
      for (const file of task.files) {
        const hasStoredEvidence = options.evidenceStore?.refs.some((ref) => task.evidenceRefs.includes(ref.id) && ref.file === file.path) ?? false;
        if (file.action === "modify" && !evidenceFiles.has(file.path) && !hasStoredEvidence) {
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

export type SddKind = "research" | "intent" | "brief" | "spec" | "tasks";
export type SddArtifact = ResearchCapsule | IntentCapsule | PlanningBrief | SpecCapsule | TaskGraph;
export type SddArtifactPayload = ResearchCapsulePayload | IntentAssessmentPayload | PlanningBriefPayload | SpecCapsulePayload | TaskGraphPayload;

const SDD_FILES: Record<SddKind, string> = {
  research: "research.json",
  intent: "intent.json",
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
      case "intent": return IntentCapsuleSchema.parse({ ...artifact, createdAt });
      case "brief": return PlanningBriefSchema.parse({ ...artifact, createdAt });
      case "spec": return SpecCapsuleSchema.parse({ ...artifact, createdAt });
      case "tasks": return TaskGraphSchema.parse({ ...artifact, createdAt });
    }
  })();
  await atomicWrite(filePath, canonicalJson(persisted));
  return filePath;
}

/** Remove disk-only audit metadata before a capsule enters model context. */
export function toOperationalSddPayload(artifact: SddArtifact): SddArtifactPayload {
  const { createdAt: _createdAt, ...payload } = artifact;
  if ("objective" in payload) return ResearchCapsulePayloadSchema.parse(payload);
  if ("status" in payload && "problem" in payload) return IntentAssessmentPayloadSchema.parse(payload);
  if ("status" in payload) return PlanningBriefPayloadSchema.parse(payload);
  if ("goal" in payload) return SpecCapsulePayloadSchema.parse(payload);
  return TaskGraphPayloadSchema.parse(payload);
}

/** Stable model-facing serialization: schema-normalized keys, no volatile audit timestamp. */
export function canonicalSddPayload(artifact: SddArtifact): string {
  return compactJson(toOperationalSddPayload(artifact));
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

export async function loadIntentCapsule(paths: MrPaths, workspaceId: string): Promise<IntentCapsule | undefined> {
  const raw = await loadJson<unknown>(join(sddDir(paths, workspaceId), SDD_FILES.intent));
  if (raw === undefined) return undefined;
  const parsed = IntentCapsuleSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Returns only a persisted READY capsule (research gate and legacy callers). */
export async function loadIntentBrief(paths: MrPaths, workspaceId: string): Promise<(IntentBrief & { status: "READY" }) | undefined> {
  const capsule = await loadIntentCapsule(paths, workspaceId);
  return capsule?.status === "READY" ? capsule : undefined;
}

export async function loadIntentAssessment(paths: MrPaths, workspaceId: string): Promise<IntentAssessmentPayload | undefined> {
  const capsule = await loadIntentCapsule(paths, workspaceId);
  if (capsule === undefined) return undefined;
  const { createdAt: _createdAt, ...payload } = capsule;
  return IntentAssessmentPayloadSchema.parse(payload);
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
