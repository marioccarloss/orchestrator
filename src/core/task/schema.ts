import { z } from "zod";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const TaskInputKindSchema = z.enum(["oneliner", "prompt", "ticket", "design"]);
export type TaskInputKind = z.infer<typeof TaskInputKindSchema>;

export const TaskStrategySchema = z.enum(["tweak", "replicate", "ui", "feature", "bugfix", "refactor"]);
export type TaskStrategy = z.infer<typeof TaskStrategySchema>;

export const TASK_DIFFICULTIES = [1, 2, 3, 5, 8, 13] as const;
export const TaskDifficultySchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8), z.literal(13),
]);
export type TaskDifficulty = z.infer<typeof TaskDifficultySchema>;

export const GraphDepthSchema = z.enum(["skip", "map", "impact"]);
export const EngramUseSchema = z.enum(["skip", "prefetch"]);
export const RulesUseSchema = z.enum(["skip", "applicable"]);
export const ReadDepthSchema = z.enum(["none", "targeted", "broad"]);
export const VerifyTierSchema = z.enum(["format-lint", "typecheck", "tests"]);
export const TaskSizeSchema = z.enum(["trivial", "small", "medium", "large"]);

export type GraphDepth = z.infer<typeof GraphDepthSchema>;
export type ReadDepth = z.infer<typeof ReadDepthSchema>;
export type VerifyTier = z.infer<typeof VerifyTierSchema>;
export type TaskSize = z.infer<typeof TaskSizeSchema>;

export const DecisionSourceSchema = z.enum(["jev", "heuristic", "floor"]);
export type DecisionSource = z.infer<typeof DecisionSourceSchema>;

/** Ordered from cheapest to most expensive; floors only move right. */
export const ORDERED = {
  graph: GraphDepthSchema.options,
  read: ReadDepthSchema.options,
  verify: VerifyTierSchema.options,
  size: TaskSizeSchema.options,
} as const;

export const ContextStrategySchema = z.strictObject({
  graph: GraphDepthSchema,
  engram: EngramUseSchema,
  rules: RulesUseSchema,
  read: ReadDepthSchema,
  verify: VerifyTierSchema,
  size: TaskSizeSchema,
  sources: z.record(z.string(), DecisionSourceSchema).default({}),
  floors: z.array(z.string().max(200)).default([]),
});
export type ContextStrategy = z.infer<typeof ContextStrategySchema>;

export const TaskClassificationSchema = z.strictObject({
  strategy: TaskStrategySchema,
  difficulty: TaskDifficultySchema,
  source: DecisionSourceSchema,
  confidence: z.number().min(0).max(1).optional(),
});
export type TaskClassification = z.infer<typeof TaskClassificationSchema>;

export const TaskEscalationSchema = z.strictObject({
  recommend: z.literal("flow"),
  reasons: z.array(z.string().max(200)).min(1),
});
export type TaskEscalation = z.infer<typeof TaskEscalationSchema>;

export const TaskInputSchema = z.strictObject({
  kind: TaskInputKindSchema,
  text: z.string().trim().min(1).max(20_000),
  ticketRef: z.string().trim().min(1).max(200).optional(),
  designRef: z.string().trim().min(1).max(1_000).optional(),
  attachments: z.array(z.string().max(1_000)).max(20).default([]),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

// ─── Receiver contracts (explore → plan checklist) ───────────────────────────

export const STRATEGY_CHECKLIST: Readonly<Record<TaskStrategy, readonly string[]>> = {
  tweak: ["target"],
  replicate: ["reference", "target", "deltas"],
  ui: ["design", "reuse", "placement"],
  feature: ["entrypoints", "contracts", "tests"],
  bugfix: ["reproduction", "rootCauseCandidates", "failingPath", "tests"],
  refactor: ["symbols", "dependents", "tests"],
};

export const ExploreFactSchema = z.strictObject({
  claim: z.string().trim().min(1).max(400),
  file: z.string().trim().min(1).max(500),
  range: z.tuple([z.number().int().positive(), z.number().int().positive()]),
});
export type ExploreFact = z.infer<typeof ExploreFactSchema>;

export const ExploreReportSchema = z.strictObject({
  objective: z.string().trim().min(1).max(1_000),
  checklist: z.record(z.string(), z.string().trim().min(1).max(1_000)),
  facts: z.array(ExploreFactSchema).max(40).default([]),
  reference: z.strictObject({
    file: z.string().trim().min(1).max(500),
    range: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    why: z.string().trim().min(1).max(300),
  }).optional(),
  filesOfInterest: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  unknowns: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
});
export type ExploreReport = z.infer<typeof ExploreReportSchema>;

export function checklistGaps(strategy: TaskStrategy, report: ExploreReport): readonly string[] {
  return STRATEGY_CHECKLIST[strategy].filter((key) => {
    const value = report.checklist[key];
    return value === undefined || value.trim().length === 0;
  });
}

export function checklistUnknowns(strategy: TaskStrategy, report: ExploreReport): readonly string[] {
  return STRATEGY_CHECKLIST[strategy].filter((key) => report.checklist[key]?.trim().toLowerCase().startsWith("unknown") === true);
}

// ─── Execution plan ──────────────────────────────────────────────────────────

export const PlanStepOpSchema = z.enum(["replace", "insertAfter", "insertBefore", "create", "deleteFile"]);
export type PlanStepOp = z.infer<typeof PlanStepOpSchema>;

export const PlanStepSchema = z.strictObject({
  id: z.string().regex(/^S\d+$/u),
  file: z.string().trim().min(1).max(500),
  op: PlanStepOpSchema,
  anchor: z.strictObject({
    snippet: z.string().min(1).max(4_000),
    fileSha: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }).optional(),
  code: z.string().max(40_000).optional(),
  intent: z.string().trim().min(20).max(2_000).optional(),
  reference: z.strictObject({
    file: z.string().trim().min(1).max(500),
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  }).optional(),
  mustNotTouch: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  dependsOn: z.array(z.string().regex(/^S\d+$/u)).max(20).default([]),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const ExecutionPlanSchema = z.strictObject({
  summary: z.string().trim().min(1).max(1_000),
  strategy: TaskStrategySchema,
  difficulty: TaskDifficultySchema,
  assumptions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  steps: z.array(PlanStepSchema).min(1).max(40),
  verification: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

export function isDeterministicStep(step: PlanStep): boolean {
  return step.op === "deleteFile" || step.code !== undefined;
}

// ─── Verification receipts ───────────────────────────────────────────────────

export const CommandReceiptSchema = z.strictObject({
  command: z.string().min(1),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
  outputTail: z.string().max(4_000),
  origin: z.enum(["plan", "floor"]),
});
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const VerificationResultSchema = z.strictObject({
  ok: z.boolean(),
  receipts: z.array(CommandReceiptSchema),
  outOfPlanFiles: z.array(z.string()),
  at: z.iso.datetime(),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// ─── State machine ───────────────────────────────────────────────────────────

export const TaskPhaseSchema = z.enum(["explore", "plan", "apply", "verify", "done", "aborted"]);
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

export const TaskStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^T\d{8}-\d{6}-[a-z0-9]{4}$/u),
  workspaceId: z.string().min(1),
  phase: TaskPhaseSchema,
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  userLanguage: z.string().min(2).max(10).optional(),
  input: TaskInputSchema,
  contextStrategy: ContextStrategySchema,
  classification: TaskClassificationSchema,
  escalation: TaskEscalationSchema.optional(),
  baselineDirtyFiles: z.array(z.string()).default([]),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  appliedSteps: z.array(z.string().regex(/^S\d+$/u)).default([]),
  verifyFailures: z.number().int().min(0).default(0),
  humanQuestionsAsked: z.number().int().min(0).default(0),
  jevQuestionsAsked: z.number().int().min(0).default(0),
  lastVerification: VerificationResultSchema.optional(),
});
export type TaskState = z.infer<typeof TaskStateSchema>;

export type TaskEvent =
  | { readonly type: "explore_skipped" }
  | { readonly type: "explore_submitted"; readonly reportHash: string; readonly classification: TaskClassification; readonly escalation?: TaskEscalation }
  | { readonly type: "plan_accepted"; readonly planHash: string; readonly classification: TaskClassification }
  | { readonly type: "step_applied"; readonly stepId: string }
  | { readonly type: "apply_complete" }
  | { readonly type: "verify_passed"; readonly result: VerificationResult }
  | { readonly type: "verify_failed"; readonly result: VerificationResult }
  | { readonly type: "replan" }
  | { readonly type: "abort" };

const ALLOWED: Readonly<Record<TaskPhase, readonly TaskEvent["type"][]>> = {
  explore: ["explore_skipped", "explore_submitted", "abort"],
  plan: ["plan_accepted", "abort"],
  apply: ["step_applied", "apply_complete", "replan", "abort"],
  verify: ["verify_passed", "verify_failed", "replan", "abort"],
  done: [],
  aborted: [],
};

/** Consecutive verification failures before the planner gets the failure capsule. */
export const MAX_VERIFY_FAILURES = 2;

export function canApplyTaskEvent(state: TaskState, type: TaskEvent["type"]): boolean {
  return ALLOWED[state.phase].includes(type);
}

export function transitionTask(state: TaskState, event: TaskEvent, now: string = new Date().toISOString()): TaskState {
  if (!canApplyTaskEvent(state, event.type)) {
    throw new Error(`Invalid /task transition: ${state.phase} + ${event.type}`);
  }
  const base = { ...state, updatedAt: now };
  switch (event.type) {
    case "explore_skipped":
      return { ...base, phase: "plan" };
    case "explore_submitted":
      return {
        ...base,
        phase: "plan",
        reportHash: event.reportHash,
        classification: event.classification,
        ...(event.escalation === undefined ? {} : { escalation: event.escalation }),
      };
    case "plan_accepted":
      return { ...base, phase: "apply", planHash: event.planHash, classification: event.classification, appliedSteps: [], verifyFailures: 0 };
    case "step_applied":
      return base.appliedSteps.includes(event.stepId) ? base : { ...base, appliedSteps: [...base.appliedSteps, event.stepId] };
    case "apply_complete":
      return { ...base, phase: "verify" };
    case "verify_passed":
      return { ...base, phase: "done", lastVerification: event.result, verifyFailures: 0 };
    case "verify_failed": {
      const failures = base.verifyFailures + 1;
      return { ...base, phase: failures >= MAX_VERIFY_FAILURES ? "plan" : "apply", lastVerification: event.result, verifyFailures: failures };
    }
    case "replan":
      return { ...base, phase: "plan" };
    case "abort":
      return { ...base, phase: "aborted" };
  }
}

export function newTaskId(now: Date = new Date(), random: () => number = Math.random): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const date = `${String(now.getUTCFullYear())}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const time = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  const suffix = Array.from({ length: 4 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(random() * 36)] ?? "x").join("");
  return `T${date}-${time}-${suffix}`;
}

export function nearestDifficulty(value: number): TaskDifficulty {
  let best: TaskDifficulty = 1;
  for (const candidate of TASK_DIFFICULTIES) {
    if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate;
  }
  return best;
}
