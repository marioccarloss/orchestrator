import { z } from "zod";
import { RiskLaneSchema, type RiskLane } from "./risk.js";

export const ContextRoleSchema = z.enum(["plan", "implement", "judge-a", "judge-b", "fix"]);
export type ContextRole = z.infer<typeof ContextRoleSchema>;

/**
 * Character budgets deliberately preserve the approved Full-lane defaults:
 * plan=50k, implement=60k, each judge=40k, and fix=30k. Cheaper lanes
 * shrink the same role envelope; critical work gets a bounded 25% increase.
 */
export const CONTEXT_BUDGET_CHARS = {
  fast: { plan: 25_000, implement: 30_000, "judge-a": 20_000, "judge-b": 20_000, fix: 15_000 },
  standard: { plan: 37_500, implement: 45_000, "judge-a": 30_000, "judge-b": 30_000, fix: 22_500 },
  full: { plan: 50_000, implement: 60_000, "judge-a": 40_000, "judge-b": 40_000, fix: 30_000 },
  critical: { plan: 62_500, implement: 75_000, "judge-a": 50_000, "judge-b": 50_000, fix: 37_500 },
} as const satisfies Readonly<Record<RiskLane, Readonly<Record<ContextRole, number>>>>;

export function contextBudgetChars(
  role: ContextRole,
  lane: RiskLane = "full",
  override?: number,
): number {
  if (override !== undefined) {
    if (!Number.isSafeInteger(override) || override <= 0) throw new Error("Context budget override must be a positive safe integer.");
    return override;
  }
  return CONTEXT_BUDGET_CHARS[lane][role];
}

export interface FlowEconomyPolicy {
  readonly lane: RiskLane;
  readonly sessionMode: "single" | "staged";
  readonly planner: "mr-plan" | "mr-general";
  readonly implementer: "mr-general" | "mr-sdd-apply";
  readonly judges: boolean;
  readonly combineBriefAndImplementation: boolean;
}

/** Fast local work can keep plan + implementation in one mr-general session. */
export function flowEconomyPolicy(lane: RiskLane, hasTicket: boolean): FlowEconomyPolicy {
  const singleFastSession = lane === "fast" && !hasTicket;
  return {
    lane: RiskLaneSchema.parse(lane),
    sessionMode: singleFastSession ? "single" : "staged",
    planner: singleFastSession ? "mr-general" : "mr-plan",
    implementer: lane === "full" || lane === "critical" ? "mr-sdd-apply" : "mr-general",
    judges: lane === "full" || lane === "critical",
    combineBriefAndImplementation: singleFastSession,
  };
}
