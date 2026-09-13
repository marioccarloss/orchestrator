import { z } from "zod";

export const RiskLaneSchema = z.enum(["fast", "standard", "full", "critical"]);
export type RiskLane = z.infer<typeof RiskLaneSchema>;

export interface RiskEvidence {
  readonly count: number;
  readonly fresh: boolean;
}

export interface RiskRules {
  readonly criticalAreas?: readonly string[];
}

export interface RiskInput {
  readonly difficulty: number;
  readonly evidence: RiskEvidence | number;
  readonly atlasImpact: number;
  /** Paths and/or semantic area labels touched by the change. */
  readonly touchedAreas: readonly string[];
  readonly touchedFiles?: readonly string[];
  readonly rules?: RiskRules;
}

export interface RiskAssessment {
  readonly lane: RiskLane;
  readonly reasons: readonly string[];
}

export const DEFAULT_CRITICAL_AREAS = [
  "auth",
  "security",
  "payment",
  "persistence",
  "migration",
  "federation-contract",
  "public-api",
  "cache-concurrency",
] as const;

function normalized(value: string): string {
  return value.toLowerCase().replaceAll("_", "-").replaceAll(" ", "-");
}

function matchesArea(value: string, area: string): boolean {
  const target = normalized(value);
  const expected = normalized(area);
  const tokens = target.split(/[^a-z0-9]+/u).filter(Boolean);
  return target.includes(expected) || expected.split("-").every((part) => tokens.includes(part));
}

function evidenceState(evidence: RiskInput["evidence"]): RiskEvidence {
  return typeof evidence === "number" ? { count: evidence, fresh: evidence > 0 } : evidence;
}

export function assessRiskLane(input: RiskInput): RiskAssessment {
  const evidence = evidenceState(input.evidence);
  const criticalAreas = [...new Set([...DEFAULT_CRITICAL_AREAS, ...(input.rules?.criticalAreas ?? [])])];
  const matchedCritical = criticalAreas.filter((area) => input.touchedAreas.some((value) => matchesArea(value, area)));
  const touchedFileCount = new Set((input.touchedFiles ?? input.touchedAreas).map(normalized)).size;

  if (matchedCritical.length > 0 || input.atlasImpact >= 15) {
    const reasons = [
      ...(matchedCritical.length === 0 ? [] : [`critical areas: ${matchedCritical.sort().join(", ")}`]),
      ...(input.atlasImpact < 15 ? [] : [`Atlas impact ${String(input.atlasImpact)} >= 15`]),
    ];
    return { lane: "critical", reasons };
  }
  if (input.difficulty >= 5) {
    const reasons = [
      `difficulty ${String(input.difficulty)} >= 5`,
      ...(evidence.count > 0 ? [] : ["no evidence references"]),
      ...(evidence.count === 0 || evidence.fresh ? [] : ["evidence is not fresh"]),
    ];
    return { lane: "full", reasons };
  }
  if (input.difficulty <= 3 && touchedFileCount <= 2 && input.atlasImpact <= 3) {
    return {
      lane: "fast",
      reasons: [
        `difficulty ${String(input.difficulty)} <= 3`,
        `${String(touchedFileCount)} touched file(s)`,
        `Atlas impact ${String(input.atlasImpact)} <= 3`,
        `${String(evidence.count)} evidence reference(s)${evidence.count > 0 && !evidence.fresh ? " (not fresh)" : ""}`,
      ],
    };
  }
  return {
    lane: "standard",
    reasons: [`difficulty ${String(input.difficulty)}`, `${String(touchedFileCount)} touched file(s)`, `Atlas impact ${String(input.atlasImpact)}`],
  };
}

export function classifyRiskLane(input: RiskInput): RiskLane {
  return assessRiskLane(input).lane;
}
