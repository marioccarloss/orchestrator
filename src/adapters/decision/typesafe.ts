import type {
  DecisionAnswer,
  DecisionEngine,
  DecisionEngineResult,
  DecisionQuestion,
  DecisionState,
} from "../../core/decision.js";

/**
 * Direct TypeSafe API adapter for Jev (POST /v1/systemone), used when
 * TYPESAFE_API_KEY (or JEV_API_KEY) is available. It avoids Vercel AI Gateway,
 * whose Zero Data Retention option is not available on every plan.
 *
 * Wire format: boolean questions travel as `noul` (answer: noul = P(true));
 * choice answers carry choice/confidence/probabilities; score answers carry a
 * 0..1 score plus confidence.
 */

export type TypeSafeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}>;

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

export function typeSafeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ["TYPESAFE_API_KEY", "JEV_API_KEY"]) {
    const key = env[name]?.trim();
    if (key !== undefined && key.length > 0) return key;
  }
  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function wireQuestion(question: DecisionQuestion): Record<string, unknown> {
  if (question.type === "boolean") {
    return { type: "noul", instructions: question.instructions, ...(question.criteria === undefined ? {} : { criteria: question.criteria }) };
  }
  if (question.type === "choice") return { type: "choice", instructions: question.instructions, criteria: question.criteria };
  return { type: "score", instructions: question.instructions, criteria: question.criteria };
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).flatMap(([key, probability]) => {
    const parsed = unit(probability);
    return parsed === undefined ? [] : [[key, parsed] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function readAnswer(question: DecisionQuestion, raw: unknown): { readonly answer?: DecisionAnswer; readonly confidence?: number } {
  if (!isRecord(raw)) return {};
  const confidence = unit(raw["confidence"]);
  if (question.type === "boolean") {
    const probability = unit(raw["noul"]);
    return probability === undefined ? {} : { answer: { type: "boolean", probability } };
  }
  if (question.type === "choice") {
    const choice = raw["choice"];
    if (typeof choice !== "string") return {};
    const probabilities = numberRecord(raw["probabilities"]);
    return {
      answer: { type: "choice", choice, ...(probabilities === undefined ? {} : { probabilities }) },
      ...(confidence === undefined ? {} : { confidence }),
    };
  }
  const score = typeof raw["score"] === "number" && Number.isFinite(raw["score"]) ? raw["score"] : undefined;
  if (score === undefined) return {};
  const probabilities = numberRecord(raw["probabilities"]);
  return {
    answer: { type: "score", score, ...(probabilities === undefined ? {} : { probabilities }) },
    ...(confidence === undefined ? {} : { confidence }),
  };
}

const defaultFetch: TypeSafeFetch = async (url, init) => fetch(url, init);

export class TypeSafeDecisionEngine implements DecisionEngine {
  readonly provider = "typesafe";

  constructor(
    readonly model: string = TYPESAFE_DEFAULT_MODEL,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: TypeSafeFetch = defaultFetch,
  ) {}

  status(): { readonly available: boolean; readonly reason?: string } {
    return typeSafeApiKey(this.environment) === undefined
      ? { available: false, reason: "TYPESAFE_API_KEY (or JEV_API_KEY) is not set" }
      : { available: true };
  }

  async evaluate(input: {
    readonly state: DecisionState;
    readonly questions: readonly DecisionQuestion[];
    readonly maxRetries: number;
    readonly timeoutMs: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<DecisionEngineResult> {
    const apiKey = typeSafeApiKey(this.environment);
    if (apiKey === undefined) throw new Error("TYPESAFE_API_KEY (or JEV_API_KEY) is not set");
    const root = (this.environment["TYPESAFE_BASE_URL"]?.trim() ?? TYPESAFE_DEFAULT_BASE_URL).replace(/\/$/u, "");
    const body = JSON.stringify({
      model: this.model,
      state: input.state,
      questions: Object.fromEntries(input.questions.map((question) => [question.id, wireQuestion(question)])),
    });
    let lastError: unknown;
    for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => { controller.abort(new Error("Jev evaluation timed out")); }, input.timeoutMs);
      const abort = (): void => { controller.abort(input.abortSignal?.reason); };
      input.abortSignal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await this.fetchImpl(`${root}/v1/systemone`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = isRecord(payload) && isRecord(payload["detail"]) ? payload["detail"]["message"] : undefined;
          const error = new Error(`TypeSafe ${String(response.status)}: ${typeof detail === "string" ? detail : response.statusText}`);
          if (response.status < 500 && response.status !== 429) throw error;
          lastError = error;
          continue;
        }
        const answersRaw = isRecord(payload) && isRecord(payload["answers"]) ? payload["answers"] : {};
        const answers: Record<string, DecisionAnswer> = {};
        const confidence: Record<string, number> = {};
        for (const question of input.questions) {
          const read = readAnswer(question, answersRaw[question.id]);
          if (read.answer !== undefined) answers[question.id] = read.answer;
          if (read.confidence !== undefined) confidence[question.id] = read.confidence;
        }
        const usage = isRecord(payload) && isRecord(payload["usage"]) ? payload["usage"] : {};
        const inputTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : undefined;
        const outputTokens = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : undefined;
        return {
          provider: this.provider,
          model: isRecord(payload) && typeof payload["model"] === "string" ? payload["model"] : this.model,
          answers,
          ...(Object.keys(confidence).length === 0 ? {} : { confidence }),
          usage: {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
          },
          warnings: [],
        };
      } catch (error: unknown) {
        if (controller.signal.aborted && input.abortSignal?.aborted === true) throw error;
        lastError = error;
        if (error instanceof Error && /^TypeSafe 4\d\d/u.test(error.message) && !error.message.startsWith("TypeSafe 429")) throw error;
      } finally {
        clearTimeout(timeout);
        input.abortSignal?.removeEventListener("abort", abort);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
