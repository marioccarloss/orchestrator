import {
  experimental_evaluate,
  type Experimental_EvaluationAnswer,
  type Experimental_EvaluationQuestion,
  type JSONValue,
} from "ai";
import type {
  DecisionAnswer,
  DecisionEngine,
  DecisionEngineResult,
  DecisionQuestion,
  DecisionState,
} from "../../core/decision.js";

interface JevRunnerInput {
  readonly model: string;
  readonly state: DecisionState;
  readonly questions: Readonly<Record<string, Experimental_EvaluationQuestion>>;
  readonly maxRetries: number;
  readonly abortSignal: AbortSignal;
}

interface JevRunnerResult {
  readonly answers: Readonly<Record<string, Experimental_EvaluationAnswer<Experimental_EvaluationQuestion>>>;
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
    readonly totalTokens: number | undefined;
  };
  readonly warnings: readonly unknown[];
  readonly providerMetadata: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
  readonly response: { readonly modelId: string };
}

export type JevEvaluationRunner = (input: JevRunnerInput) => Promise<JevRunnerResult>;

function questionsRecord(questions: readonly DecisionQuestion[]): Record<string, Experimental_EvaluationQuestion> {
  return Object.fromEntries(questions.map((question) => {
    if (question.type === "boolean") {
      return [question.id, {
        type: question.type,
        instructions: question.instructions,
        ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
      } satisfies Experimental_EvaluationQuestion];
    }
    if (question.type === "choice") {
      return [question.id, {
        type: question.type,
        instructions: question.instructions,
        criteria: question.criteria,
      } satisfies Experimental_EvaluationQuestion];
    }
    return [question.id, {
      type: "score",
      instructions: question.instructions,
      criteria: question.criteria,
    } satisfies Experimental_EvaluationQuestion];
  }));
}

function asDecisionAnswer(answer: Experimental_EvaluationAnswer<Experimental_EvaluationQuestion>): DecisionAnswer {
  if (answer.type === "boolean") return { type: answer.type, probability: answer.probability };
  if (answer.type === "choice") {
    return {
      type: answer.type,
      choice: answer.choice,
      ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
    };
  }
  return {
    type: answer.type,
    score: answer.score,
    ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteUnit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function confidenceMap(
  metadata: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined,
  questionIds: readonly string[],
): Record<string, number> | undefined {
  const provider = metadata?.["typesafe"] ?? metadata?.["typesafe-ai"];
  const raw = provider?.["confidence"];
  if (!isRecord(raw)) return undefined;
  const entries = questionIds.flatMap((id) => {
    const confidence = finiteUnit(raw[id]);
    return confidence === undefined ? [] : [[id, confidence] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function warningText(warning: unknown): string {
  if (typeof warning === "string") return warning;
  try {
    return JSON.stringify(warning);
  } catch {
    return String(warning);
  }
}

const defaultRunner: JevEvaluationRunner = async (input) => {
  const result = await experimental_evaluate({
    model: input.model,
    state: input.state as string | Readonly<Record<string, JSONValue>> | readonly JSONValue[],
    questions: input.questions,
    maxRetries: input.maxRetries,
    abortSignal: input.abortSignal,
    providerOptions: {
      gateway: { zeroDataRetention: true },
    },
  });
  return result;
};

export class JevDecisionEngine implements DecisionEngine {
  readonly provider = "vercel-ai-gateway";

  constructor(
    readonly model: string,
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly runner: JevEvaluationRunner = defaultRunner,
  ) {}

  status(): { readonly available: boolean; readonly reason?: string } {
    const hasCredentials = ["AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"]
      .some((name) => Boolean(this.environment[name]?.trim()));
    return hasCredentials
      ? { available: true }
      : { available: false, reason: "Vercel AI Gateway credentials are unavailable; set AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN" };
  }

  async evaluate(input: {
    readonly state: DecisionState;
    readonly questions: readonly DecisionQuestion[];
    readonly maxRetries: number;
    readonly timeoutMs: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<DecisionEngineResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("Jev evaluation timed out"));
    }, input.timeoutMs);
    const abort = (): void => {
      controller.abort(input.abortSignal?.reason);
    };
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await this.runner({
        model: this.model,
        state: input.state,
        questions: questionsRecord(input.questions),
        maxRetries: input.maxRetries,
        abortSignal: controller.signal,
      });
      const answers = Object.fromEntries(Object.entries(result.answers).map(([id, answer]) => [id, asDecisionAnswer(answer)]));
      const confidence = confidenceMap(result.providerMetadata, input.questions.map((question) => question.id));
      return {
        provider: this.provider,
        model: result.response.modelId || this.model,
        answers,
        ...(confidence === undefined ? {} : { confidence }),
        usage: {
          ...(result.usage.inputTokens === undefined ? {} : { inputTokens: result.usage.inputTokens }),
          ...(result.usage.outputTokens === undefined ? {} : { outputTokens: result.usage.outputTokens }),
          ...(result.usage.totalTokens === undefined ? {} : { totalTokens: result.usage.totalTokens }),
        },
        warnings: result.warnings.map(warningText),
      };
    } finally {
      clearTimeout(timeout);
      input.abortSignal?.removeEventListener("abort", abort);
    }
  }
}
