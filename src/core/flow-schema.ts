import { z } from "zod";
import { RiskLaneSchema, type RiskLane } from "./risk.js";
import { UserLanguageSchema, type UserLanguage } from "./language.js";

// ─── Flow State Machine ──────────────────────────────────────────────────────

export const FlowDifficultySchema = z.union([
  z.literal(1),
  z.literal(3),
  z.literal(5),
  z.literal(8),
  z.literal(13),
  z.literal(21),
]);

export type FlowDifficulty = z.infer<typeof FlowDifficultySchema>;

export function requiresJudgment(risk: number | RiskLane): boolean {
  return typeof risk === "number" ? risk >= 5 : risk === "full" || risk === "critical";
}

export function implementationAgentForDifficulty(difficulty: number, lane?: RiskLane): "mr-general" | "mr-sdd-apply" {
  return requiresJudgment(lane ?? difficulty) ? "mr-sdd-apply" : "mr-general";
}

export const TicketPlatformSchema = z.enum(["github", "jira", "gitlab", "local"]);

export type TicketPlatform = z.infer<typeof TicketPlatformSchema>;

export const TicketRefSchema = z.object({
  schemaVersion: z.literal(1),
  platform: TicketPlatformSchema,
  id: z.string().min(1),
  url: z.string().url().optional(),
});

export type TicketRef = z.infer<typeof TicketRefSchema>;

export const TicketContentSchema = z.object({
  schemaVersion: z.literal(1),
  ref: TicketRefSchema,
  title: z.string().min(1),
  description: z.string(),
  type: z.enum(["feature", "bugfix", "hotfix", "release", "chore"]).default("feature"),
  attachments: z.array(z.string()).default([]),
  fetchedAt: z.iso.datetime(),
  source: z.enum(["remote", "user"]).optional(),
});

export type TicketContent = z.infer<typeof TicketContentSchema>;

export const PlanCapsuleSchema = z.object({
  schemaVersion: z.literal(1),
  ticket: TicketRefSchema,
  summary: z.string().min(1),
  rootCause: z.string().optional(),
  files: z.array(z.object({
    path: z.string().min(1),
    action: z.enum(["create", "modify", "delete", "rename"]),
    reason: z.string().min(1),
    risk: z.enum(["low", "medium", "high"]).default("medium"),
  })).min(1),
  tests: z.array(z.object({
    path: z.string().min(1),
    type: z.enum(["unit", "integration", "e2e"]),
    description: z.string().min(1),
  })).default([]),
  verification: z.object({
    typecheck: z.boolean().default(true),
    lint: z.boolean().default(true),
    test: z.boolean().default(true),
    build: z.boolean().default(false),
  }).default({ typecheck: true, lint: true, test: true, build: false }),
  createdAt: z.iso.datetime(),
});

export type PlanCapsule = z.infer<typeof PlanCapsuleSchema>;

const RiskStateFields = {
  userLanguage: UserLanguageSchema.optional(),
  lane: RiskLaneSchema.optional(),
  riskReasons: z.array(z.string()).optional(),
};

export const FlowStateSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("init"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    ...RiskStateFields,
  }),
  z.object({
    phase: z.literal("wizard"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    difficulty: FlowDifficultySchema,
    ticketId: z.string().min(1),
    hasFigma: z.boolean(),
    ...RiskStateFields,
  }),
  z.object({
    phase: z.literal("context"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    difficulty: FlowDifficultySchema,
    ticket: TicketContentSchema,
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    ...RiskStateFields,
  }),
  z.object({
    phase: z.literal("explore"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    difficulty: FlowDifficultySchema,
    ticket: TicketContentSchema,
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    atlasCache: z.string().optional(),
    ...RiskStateFields,
  }),
  z.object({
    phase: z.literal("plan"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    difficulty: FlowDifficultySchema,
    ticket: TicketContentSchema,
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    plan: PlanCapsuleSchema,
    ...RiskStateFields,
  }),
  z.object({
    phase: z.literal("implement"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    difficulty: FlowDifficultySchema,
    ticket: TicketContentSchema,
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    plan: PlanCapsuleSchema,
    fixAttempt: z.number().int().min(0).optional(),
    completedFiles: z.array(z.string()).default([]),
    ...RiskStateFields,
  }),
  z.object({
    phase: z.literal("judgment"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    difficulty: FlowDifficultySchema,
    ticket: TicketContentSchema,
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    plan: PlanCapsuleSchema,
    fixAttempt: z.number().int().min(0).optional(),
    diffHash: z.string().min(1),
    ...RiskStateFields,
  }),
  z.object({
    phase: z.literal("fix"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    difficulty: FlowDifficultySchema,
    ticket: TicketContentSchema,
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    plan: PlanCapsuleSchema,
    fixAttempt: z.number().int().min(1).default(1),
    verdict: z.object({
      critical: z.array(z.string()),
      warnings: z.array(z.string()),
      suggestions: z.array(z.string()),
    }),
    ...RiskStateFields,
  }),
  z.object({
    phase: z.literal("finish"),
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    startedAt: z.iso.datetime(),
    difficulty: FlowDifficultySchema,
    ticket: TicketContentSchema,
    branch: z.string().min(1),
    baseBranch: z.string().min(1),
    plan: PlanCapsuleSchema,
    approvalDigest: z.string().min(1).optional(),
    commitHash: z.string().optional(),
    prUrl: z.string().url().optional(),
    humanReviewApproved: z.boolean().optional(),
    ...RiskStateFields,
  }),
]);

export type FlowState = z.infer<typeof FlowStateSchema>;

export const FlowEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), workspaceId: z.string().min(1), userLanguage: UserLanguageSchema.optional() }),
  z.object({ type: z.literal("wizard_complete"), difficulty: FlowDifficultySchema, ticketId: z.string().min(1), hasFigma: z.boolean(), userLanguage: UserLanguageSchema.optional() }),
  z.object({ type: z.literal("context_ready"), ticket: TicketContentSchema, branch: z.string().min(1), baseBranch: z.string().min(1), userLanguage: UserLanguageSchema.optional() }),
  z.object({ type: z.literal("explore_done"), atlasCache: z.string().optional() }),
  z.object({ type: z.literal("plan_approved"), plan: PlanCapsuleSchema, lane: RiskLaneSchema.optional(), riskReasons: z.array(z.string()).optional() }),
  z.object({ type: z.literal("plan_rejected") }),
  z.object({ type: z.literal("implement_done"), completedFiles: z.array(z.string()), diffHash: z.string().min(1).optional() }),
  z.object({ type: z.literal("judgment_needed"), diffHash: z.string().min(1) }),
  z.object({ type: z.literal("judgment_passed"), approvalDigest: z.string().min(1).optional() }),
  z.object({ type: z.literal("judgment_failed"), verdict: z.object({ critical: z.array(z.string()), warnings: z.array(z.string()), suggestions: z.array(z.string()) }) }),
  z.object({ type: z.literal("fix_done") }),
  z.object({ type: z.literal("finish_confirmed"), commitHash: z.string().optional(), prUrl: z.string().url().optional(), humanApproved: z.boolean().optional() }),
  z.object({ type: z.literal("finish_rejected") }),
  z.object({ type: z.literal("abort") }),
]);

export type FlowEvent = z.infer<typeof FlowEventSchema>;

// ─── State Transitions ───────────────────────────────────────────────────────

type TransitionMap = Record<FlowState["phase"], readonly FlowState["phase"][]>;

const transitions: TransitionMap = {
  init: ["wizard", "finish"],
  wizard: ["context", "finish"],
  context: ["explore", "finish"],
  explore: ["plan", "implement", "finish"],
  plan: ["implement", "plan", "finish"],
  implement: ["judgment", "finish", "implement", "finish"],
  judgment: ["fix", "finish", "finish"],
  fix: ["implement", "finish", "finish"],
  finish: [],
};

export function canTransition(from: FlowState, to: FlowState["phase"]): boolean {
  return transitions[from.phase].includes(to);
}

function preservedRisk(state: FlowState): { userLanguage?: UserLanguage; lane?: RiskLane; riskReasons?: string[] } {
  return {
    ...(state.userLanguage === undefined ? {} : { userLanguage: state.userLanguage }),
    ...(state.lane === undefined ? {} : { lane: state.lane }),
    ...(state.riskReasons === undefined ? {} : { riskReasons: [...state.riskReasons] }),
  };
}

function approvedRisk(
  state: FlowState,
  event: Extract<FlowEvent, { readonly type: "plan_approved" }>,
): { userLanguage?: UserLanguage; lane?: RiskLane; riskReasons?: string[] } {
  return {
    ...preservedRisk(state),
    ...(event.lane === undefined ? {} : { lane: event.lane }),
    ...(event.riskReasons === undefined ? {} : { riskReasons: [...event.riskReasons] }),
  };
}

export function transition(state: FlowState, event: FlowEvent): FlowState {
  switch (state.phase) {
    case "init":
      if (event.type === "start") {
        return {
          phase: "wizard",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: 3,
          ticketId: "pending",
          hasFigma: false,
          ...preservedRisk(state),
          ...(event.userLanguage === undefined ? {} : { userLanguage: event.userLanguage }),
        };
      }
      break;
    case "wizard":
      if (event.type === "wizard_complete") {
        return {
          phase: "context",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: event.difficulty,
          ticket: {
            schemaVersion: 1,
            ref: { schemaVersion: 1, platform: "github", id: event.ticketId },
            title: `Ticket ${event.ticketId}`,
            description: "",
            type: "feature",
            attachments: [],
            fetchedAt: new Date().toISOString(),
          },
          branch: `feature/${event.ticketId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
          baseBranch: "develop",
          ...preservedRisk(state),
          ...(event.userLanguage === undefined ? {} : { userLanguage: event.userLanguage }),
        };
      }
      break;
    case "context":
      if (event.type === "context_ready") {
        return {
          phase: "explore",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: event.ticket,
          branch: event.branch,
          baseBranch: event.baseBranch,
          ...preservedRisk(state),
          ...(event.userLanguage === undefined ? {} : { userLanguage: event.userLanguage }),
        };
      }
      break;
    case "explore":
      if (event.type === "plan_approved") {
        return {
          phase: "implement",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          plan: event.plan,
          completedFiles: [],
          ...approvedRisk(state, event),
        };
      }
      if (event.type === "explore_done") {
        return {
          phase: "plan",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          plan: {
            schemaVersion: 1,
            ticket: state.ticket.ref,
            summary: "Plan in progress",
            files: [{ path: "README.md", action: "modify", reason: "Initial exploration", risk: "low" }],
            tests: [],
            verification: { typecheck: true, lint: true, test: true, build: false },
            createdAt: new Date().toISOString(),
          },
          ...preservedRisk(state),
        };
      }
      break;
    case "plan":
      if (event.type === "plan_approved") {
        return {
          phase: "implement",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          plan: event.plan,
          completedFiles: [],
          ...approvedRisk(state, event),
        };
      }
      if (event.type === "plan_rejected") {
        return {
          phase: "explore",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          ...preservedRisk(state),
        };
      }
      break;
    case "implement":
      if (event.type === "implement_done") {
        if (!requiresJudgment(state.lane ?? state.difficulty)) {
          return {
            phase: "finish",
            schemaVersion: 1,
            workspaceId: state.workspaceId,
            startedAt: state.startedAt,
            difficulty: state.difficulty,
            ticket: state.ticket,
            branch: state.branch,
            baseBranch: state.baseBranch,
            plan: state.plan,
            ...preservedRisk(state),
          };
        }
        return {
          phase: "judgment",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          plan: state.plan,
          fixAttempt: state.fixAttempt ?? 0,
          diffHash: event.diffHash ?? "legacy-unbound",
          ...preservedRisk(state),
        };
      }
      if (event.type === "judgment_needed") {
        return {
          phase: "judgment",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          plan: state.plan,
          fixAttempt: state.fixAttempt ?? 0,
          diffHash: event.diffHash,
          ...preservedRisk(state),
        };
      }
      break;
    case "judgment":
      if (event.type === "judgment_passed") {
        return {
          phase: "finish",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          plan: state.plan,
          approvalDigest: event.approvalDigest,
          ...preservedRisk(state),
        };
      }
      if (event.type === "judgment_failed") {
        return {
          phase: "fix",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          plan: state.plan,
          fixAttempt: (state.fixAttempt ?? 0) + 1,
          verdict: event.verdict,
          ...preservedRisk(state),
        };
      }
      break;
    case "fix":
      if (event.type === "fix_done") {
        return {
          phase: "implement",
          schemaVersion: 1,
          workspaceId: state.workspaceId,
          startedAt: state.startedAt,
          difficulty: state.difficulty,
          ticket: state.ticket,
          branch: state.branch,
          baseBranch: state.baseBranch,
          plan: state.plan,
          fixAttempt: state.fixAttempt,
          completedFiles: [],
          ...preservedRisk(state),
        };
      }
      break;
    case "finish":
      if (event.type === "finish_confirmed") {
        return {
          ...state,
          commitHash: event.commitHash ?? state.commitHash,
          prUrl: event.prUrl ?? state.prUrl,
          humanReviewApproved: event.humanApproved ?? state.humanReviewApproved,
        };
      }
      break;
  }
  if (event.type === "abort") {
    return {
      phase: "finish",
      schemaVersion: 1,
      workspaceId: state.workspaceId,
      startedAt: state.startedAt,
      difficulty: "difficulty" in state ? state.difficulty : 3,
      ticket: "ticket" in state ? state.ticket : {
        schemaVersion: 1,
        ref: { schemaVersion: 1, platform: "github", id: "aborted" },
        title: "Aborted",
        description: "",
        type: "feature" as const,
        attachments: [],
        fetchedAt: new Date().toISOString(),
      },
      branch: "branch" in state ? state.branch : "",
      baseBranch: "baseBranch" in state ? state.baseBranch : "",
      plan: "plan" in state ? state.plan : {
        schemaVersion: 1,
        ticket: { schemaVersion: 1, platform: "github", id: "aborted" },
        summary: "Aborted",
        files: [],
        tests: [],
        verification: { typecheck: true, lint: true, test: true, build: false },
        createdAt: new Date().toISOString(),
      },
      ...preservedRisk(state),
    };
  }
  throw new Error(`Invalid transition: ${state.phase} + ${event.type}`);
}

// ─── Migration Framework ─────────────────────────────────────────────────────

export interface Migration<T = unknown> {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(state: T): T;
}

export class MigrationRegistry {
  private readonly migrations = new Map<string, Migration>();

  register(migration: Migration): void {
    const key = `${migration.fromVersion}->${migration.toVersion}`;
    this.migrations.set(key, migration);
  }

  migrate(state: Record<string, unknown>, targetVersion: number): Record<string, unknown> {
    let current = state;
    let version = (current["schemaVersion"] as number) ?? 1;
    while (version < targetVersion) {
      const key = `${version}->${version + 1}`;
      const migration = this.migrations.get(key);
      if (migration === undefined) {
        throw new Error(`No migration registered for ${key}`);
      }
      current = migration.migrate(current) as Record<string, unknown>;
      version = migration.toVersion;
    }
    return current;
  }
}

// ─── Verdict Schemas ─────────────────────────────────────────────────────────

export const JudgeFindingSchema = z.strictObject({
  severity: z.enum(["critical", "warning", "suggestion"]),
  claim: z.string().min(1).max(500),
  file: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(["new", "old"]),
  source: z.literal("diff"),
  evidence: z.string().min(1).max(500),
  requirementId: z.string().regex(/^R\d+$/u).optional(),
});

export type JudgeFinding = z.infer<typeof JudgeFindingSchema>;
export const JudgeFindingsSchema = z.array(JudgeFindingSchema);

export const JudgeVerdictSchema = z.strictObject({
  schemaVersion: z.literal(1),
  judge: z.enum(["a", "b"]),
  status: z.literal("SUPPORTED"),
  approved: z.boolean(),
  diffHash: z.string().regex(/^[a-f0-9]{64}$/u),
  findings: JudgeFindingsSchema.default([]),
  reviewedAt: z.iso.datetime(),
});

export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

export const MergedVerdictSchema = z.object({
  schemaVersion: z.literal(1),
  approved: z.boolean(),
  critical: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  suggestions: z.array(z.string()).default([]),
  findings: JudgeFindingsSchema.default([]),
  judgeA: JudgeVerdictSchema,
  judgeB: JudgeVerdictSchema,
  mergedAt: z.iso.datetime(),
});

export type MergedVerdict = z.infer<typeof MergedVerdictSchema>;
