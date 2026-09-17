import type { RiskLane } from "./risk.js";
import {
  IntentProposedPayloadSchema,
  IntentReadyPayloadSchema,
  type IntentAssessmentPayload,
  type IntentProposedPayload,
  type IntentReadyPayload,
} from "./intent-schema.js";

export interface IntentApprovalInput {
  readonly assessment: IntentAssessmentPayload;
  readonly lane: RiskLane;
  readonly approved: boolean;
  readonly confirmMediumAssumptions?: boolean;
}

export interface IntentApprovalResult {
  readonly ok: boolean;
  readonly ready?: IntentReadyPayload;
  readonly reason: string;
}

export function isIntentApprovable(assessment: IntentAssessmentPayload): assessment is IntentProposedPayload | IntentReadyPayload {
  return assessment.status === "PROPOSED" || assessment.status === "READY";
}

export function validateIntentApproval(input: IntentApprovalInput): IntentApprovalResult {
  if (!input.approved) {
    return { ok: false, reason: "Intent approval required before explore." };
  }
  if (input.assessment.status === "NEEDS_INPUT") {
    return { ok: false, reason: "Intent still NEEDS_INPUT. Run mr_flow_intent_resolve or submit mr_sdd_submit kind=intent after answering gaps." };
  }
  if (!isIntentApprovable(input.assessment)) {
    return { ok: false, reason: "Intent assessment is not approvable." };
  }

  const unresolvedHigh = input.assessment.status === "PROPOSED"
    ? input.assessment.unresolved.filter((gap) => gap.risk === "high")
    : [];
  if (unresolvedHigh.length > 0) {
    return {
      ok: false,
      reason: `High-risk unresolved fields remain: ${unresolvedHigh.map((gap) => gap.field).join(", ")}`,
    };
  }

  const mediumAssumptions = input.assessment.assumptions.filter((assumption) => assumption.risk === "medium");
  if ((input.lane === "full" || input.lane === "critical") && mediumAssumptions.length > 0 && input.confirmMediumAssumptions !== true) {
    return {
      ok: false,
      reason: `Lane '${input.lane}' requires confirmMediumAssumptions=true when medium assumptions exist (${String(mediumAssumptions.length)}).`,
    };
  }

  if (input.assessment.status === "READY") {
    return { ok: true, ready: IntentReadyPayloadSchema.parse(input.assessment), reason: "READY intent approved." };
  }

  const proposed = IntentProposedPayloadSchema.parse(input.assessment);
  const { unresolved: _unresolved, ...core } = proposed;
  return {
    ok: true,
    ready: IntentReadyPayloadSchema.parse({
      ...core,
      status: "READY",
      mode: proposed.mode === "auto" ? "guided" : proposed.mode,
    }),
    reason: "PROPOSED intent confirmed and promoted to READY.",
  };
}
