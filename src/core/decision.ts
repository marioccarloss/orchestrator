import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";

export const DecisionPlaneModeSchema = z.enum(["off", "shadow"]);
export const DecisionProfileSchema = z.enum([
  "intent",
  "context",
  "routing",
  "flow",
  "judgment",
  "permission",
]);

export const DecisionPlaneConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: DecisionPlaneModeSchema,
  model: z.string().min(1),
  maxRetries: z.number().int().min(0).max(5),
  timeoutMs: z.number().int().min(250).max(30_000),
  thresholds: z.strictObject({
    booleanTrue: z.number().min(0.5).max(1),
    booleanFalse: z.number().min(0).max(0.5),
    choice: z.number().min(0.5).max(1),
    score: z.number().min(0.5).max(1),
  }),
}).refine(
  (config) => config.thresholds.booleanFalse < config.thresholds.booleanTrue,
  { message: "booleanFalse must be lower than booleanTrue" },
);

export type DecisionPlaneMode = z.infer<typeof DecisionPlaneModeSchema>;
export type DecisionProfile = z.infer<typeof DecisionProfileSchema>;
export type DecisionPlaneConfig = z.infer<typeof DecisionPlaneConfigSchema>;

export const DEFAULT_DECISION_PLANE_CONFIG: DecisionPlaneConfig = {
  schemaVersion: 1,
  mode: "off",
  model: "typesafe-ai/jev",
  maxRetries: 1,
  timeoutMs: 8_000,
  thresholds: {
    booleanTrue: 0.9,
    booleanFalse: 0.1,
    choice: 0.9,
    score: 0.9,
  },
};

export type DecisionState = string | Record<string, unknown> | readonly unknown[];

export interface BooleanDecisionQuestion {
  readonly id: string;
  readonly type: "boolean";
  readonly instructions: string;
  readonly criteria?: { readonly true: string; readonly false: string };
}

export interface ChoiceDecisionQuestion {
  readonly id: string;
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface ScoreDecisionQuestion {
  readonly id: string;
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly [string, string, ...string[]];
}

export type DecisionQuestion = BooleanDecisionQuestion | ChoiceDecisionQuestion | ScoreDecisionQuestion;

export interface BooleanDecisionAnswer {
  readonly type: "boolean";
  readonly probability: number;
}

export interface ChoiceDecisionAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export interface ScoreDecisionAnswer {
  readonly type: "score";
  readonly score: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export type DecisionAnswer = BooleanDecisionAnswer | ChoiceDecisionAnswer | ScoreDecisionAnswer;

export interface DecisionEngineResult {
  readonly provider: string;
  readonly model: string;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly confidence?: Readonly<Record<string, number>>;
  readonly usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
  readonly warnings: readonly string[];
}

export interface DecisionEngineStatus {
  readonly available: boolean;
  readonly reason?: string;
}

export interface DecisionEngine {
  readonly provider: string;
  readonly model: string;
  status(): DecisionEngineStatus;
  evaluate(input: {
    readonly state: DecisionState;
    readonly questions: readonly DecisionQuestion[];
    readonly maxRetries: number;
    readonly timeoutMs: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<DecisionEngineResult>;
}

export interface DecisionRecommendation {
  readonly id: string;
  readonly type: DecisionAnswer["type"];
  readonly value: boolean | string | number;
  readonly probability?: number;
  readonly confidence?: number;
  readonly accepted: boolean;
}

export interface DecisionReport {
  readonly schemaVersion: 1;
  readonly mode: "shadow";
  readonly profile: DecisionProfile;
  readonly provider: string;
  readonly model: string;
  readonly status: "accepted" | "escalate";
  readonly authority: "deterministic-fsm";
  readonly recommendations: readonly DecisionRecommendation[];
  readonly usage: DecisionEngineResult["usage"];
  readonly warnings: readonly string[];
}

function decisionConfigPath(paths: MrPaths): string {
  return join(paths.configRoot, "decision-plane.json");
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { readonly code?: unknown }).code === "ENOENT";
}

export async function loadDecisionPlaneConfig(
  paths: MrPaths,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DecisionPlaneConfig> {
  let stored = DEFAULT_DECISION_PLANE_CONFIG;
  try {
    const parsed: unknown = JSON.parse(await readFile(decisionConfigPath(paths), "utf8"));
    stored = DecisionPlaneConfigSchema.parse(parsed);
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  const mode = env["MR_DECISION_MODE"] === undefined
    ? stored.mode
    : DecisionPlaneModeSchema.parse(env["MR_DECISION_MODE"]);
  const configuredModel = env["MR_DECISION_MODEL"]?.trim();
  const model = configuredModel === undefined || configuredModel.length === 0 ? stored.model : configuredModel;
  return DecisionPlaneConfigSchema.parse({ ...stored, mode, model });
}

export async function saveDecisionPlaneConfig(paths: MrPaths, config: DecisionPlaneConfig): Promise<void> {
  await atomicWrite(decisionConfigPath(paths), canonicalJson(DecisionPlaneConfigSchema.parse(config)));
}

export async function setDecisionPlaneMode(
  paths: MrPaths,
  mode: DecisionPlaneMode,
  model?: string,
): Promise<DecisionPlaneConfig> {
  const current = await loadDecisionPlaneConfig(paths, {});
  const next = DecisionPlaneConfigSchema.parse({
    ...current,
    mode,
    ...(model === undefined ? {} : { model: model.trim() }),
  });
  await saveDecisionPlaneConfig(paths, next);
  return next;
}

export function hasGatewayCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"]
    .some((name) => Boolean(env[name]?.trim()));
}

const PROFILE_QUESTIONS: Record<DecisionProfile, readonly DecisionQuestion[]> = {
  intent: [{
    id: "contextEnough",
    type: "boolean",
    instructions: "Is the supplied evidence sufficient to continue without asking the developer for more information?",
    criteria: {
      true: "The objective, constraints, and acceptance signals are concrete enough for the deterministic workflow to continue safely.",
      false: "A material ambiguity could change behavior, scope, data integrity, security, or the required verification.",
    },
  }],
  context: [{
    id: "retention",
    type: "choice",
    instructions: "Choose the safest treatment for this context candidate before the next generative-model call.",
    criteria: {
      keep: "Preserve the exact content because later work depends on its details.",
      shrink: "Keep a compact factual summary; exact wording or bulk output is unnecessary.",
      drop: "Remove it because it is superseded, resolved, duplicated, or unrelated.",
    },
  }],
  routing: [{
    id: "modelTier",
    type: "choice",
    instructions: "Choose the minimum generative-model tier that can safely complete the bounded task.",
    criteria: {
      cheap: "Small, localized, low-uncertainty work with a narrow blast radius.",
      balanced: "Moderate localized work requiring normal reasoning and verification.",
      strong: "Cross-cutting, architectural, security-sensitive, high-uncertainty, or high-blast-radius work.",
    },
  }],
  flow: [{
    id: "nextAction",
    type: "choice",
    instructions: "Recommend the next workflow action without overriding deterministic state-machine rules.",
    criteria: {
      continue: "Evidence and checks support advancing to the next allowed state.",
      retry: "The current bounded operation should be attempted again after a transient or correctable failure.",
      ask: "Material user input is required before a safe decision is possible.",
      stop: "Continuing would be unsafe, invalid, or outside the declared scope.",
    },
  }],
  judgment: [{
    id: "reviewDepth",
    type: "choice",
    instructions: "Recommend review depth from the supplied risk evidence. This is advisory and cannot remove a mandatory judge.",
    criteria: {
      single: "Low-risk, localized change with strong focused verification.",
      double: "Behavior-sensitive or moderately cross-cutting change needing independent perspectives.",
      human: "Security, data integrity, production-critical, or uncertain high-blast-radius change.",
    },
  }],
  permission: [{
    id: "clearToProceed",
    type: "boolean",
    instructions: "Is the proposed tool action clearly within the declared scope and safe to execute without additional caution?",
    criteria: {
      true: "The action is scoped, reversible or non-destructive, and consistent with explicit permissions.",
      false: "The action is destructive, credential-sensitive, externally publishing, ambiguous, or outside the declared scope.",
    },
  }],
};

export function questionsForDecisionProfile(profile: DecisionProfile): readonly DecisionQuestion[] {
  return PROFILE_QUESTIONS[profile];
}

function finiteUnit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export function applyDecisionPolicy(
  profile: DecisionProfile,
  result: DecisionEngineResult,
  config: DecisionPlaneConfig,
): DecisionReport {
  const recommendations = questionsForDecisionProfile(profile).map((question): DecisionRecommendation => {
    const answer = result.answers[question.id];
    if (answer === undefined || answer.type !== question.type) {
      throw new Error(`Decision answer '${question.id}' is missing or has the wrong type`);
    }
    const providerConfidence = finiteUnit(result.confidence?.[question.id]);
    if (answer.type === "boolean") {
      const probability = finiteUnit(answer.probability);
      if (probability === undefined) throw new Error(`Decision answer '${question.id}' has an invalid probability`);
      const value = probability >= 0.5;
      const accepted = probability >= config.thresholds.booleanTrue || probability <= config.thresholds.booleanFalse;
      return { id: question.id, type: answer.type, value, probability, ...(providerConfidence === undefined ? {} : { confidence: providerConfidence }), accepted };
    }
    if (answer.type === "choice") {
      if (question.type !== "choice") throw new Error(`Decision answer '${question.id}' has the wrong question type`);
      if (!(answer.choice in question.criteria)) throw new Error(`Decision answer '${question.id}' selected an unknown choice`);
      const probability = finiteUnit(answer.probabilities?.[answer.choice]);
      const confidence = probability ?? providerConfidence;
      return {
        id: question.id,
        type: answer.type,
        value: answer.choice,
        ...(probability === undefined ? {} : { probability }),
        ...(confidence === undefined ? {} : { confidence }),
        accepted: confidence !== undefined && confidence >= config.thresholds.choice,
      };
    }
    if (question.type !== "score") throw new Error(`Decision answer '${question.id}' has the wrong question type`);
    const confidence = providerConfidence;
    return {
      id: question.id,
      type: answer.type,
      value: answer.score,
      ...(confidence === undefined ? {} : { confidence }),
      accepted: confidence !== undefined && confidence >= config.thresholds.score,
    };
  });
  return {
    schemaVersion: 1,
    mode: "shadow",
    profile,
    provider: result.provider,
    model: result.model,
    status: recommendations.every((recommendation) => recommendation.accepted) ? "accepted" : "escalate",
    authority: "deterministic-fsm",
    recommendations,
    usage: result.usage,
    warnings: result.warnings,
  };
}

export async function evaluateDecisionProfile(
  engine: DecisionEngine,
  config: DecisionPlaneConfig,
  profile: DecisionProfile,
  state: DecisionState,
  abortSignal?: AbortSignal,
): Promise<DecisionReport> {
  if (config.mode === "off") throw new Error("Decision plane is disabled; run `mr decision shadow` to enable advisory evaluation");
  const availability = engine.status();
  if (!availability.available) throw new Error(availability.reason ?? "Decision engine is unavailable");
  const result = await engine.evaluate({
    state,
    questions: questionsForDecisionProfile(profile),
    maxRetries: config.maxRetries,
    timeoutMs: config.timeoutMs,
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
  return applyDecisionPolicy(profile, result, config);
}
