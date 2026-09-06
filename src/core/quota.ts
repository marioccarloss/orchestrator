import type { ModelRole } from "./models.js";

export interface QuotaFailure {
  readonly code: "insufficient_quota" | "quota_exceeded";
  readonly statusCode: 429;
}

const agentRoles: Readonly<Record<string, ModelRole>> = {
  orchestrator: "orchestrator",
  "mr-explore": "explore",
  "mr-plan": "plan",
  "mr-general": "general",
  "mr-sdd-apply": "sddApply",
  "mr-judge-a": "judgeA",
  "mr-judge-b": "judgeB",
  "mr-fix": "fix",
  "bp-extractor": "bpExtractor",
  "bp-architect": "bpArchitect",
  "bp-transactor": "bpTransactor",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function classifyQuotaError(error: unknown): QuotaFailure | undefined {
  if (!isRecord(error) || error["name"] !== "APIError" || !isRecord(error["data"])) return undefined;
  const data = error["data"];
  if (data["statusCode"] !== 429 || typeof data["responseBody"] !== "string") return undefined;
  const body = data["responseBody"].toLowerCase();
  if (body.includes("insufficient_quota")) return { code: "insufficient_quota", statusCode: 429 };
  if (body.includes("quota_exceeded")) return { code: "quota_exceeded", statusCode: 429 };
  return undefined;
}

export function resolveModelRole(agent: string): ModelRole | undefined {
  return agentRoles[agent];
}
