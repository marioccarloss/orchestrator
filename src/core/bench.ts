import { z } from "zod";

export const RepoProfileSchema = z.enum([
  "inditex-mfe", "prensa-ds", "prensa-monorepo", "prensa-api",
  "openreferences-api", "openreferences-next", "openreferences-spa", "openreferences-auth",
]);

export const FailureCauseSchema = z.enum([
  "missing_context", "stale_context", "wrong_plan", "implementation",
  "verification", "judge_false_positive", "none",
]);

export const JourneyRecordSchema = z.strictObject({
  id: z.string().regex(/^J\d{2,}$/u),
  repoProfile: RepoProfileSchema,
  difficulty: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(8), z.literal(13), z.literal(21)]),
  hasTicket: z.boolean(),
  taskText: z.string().min(10),
  language: z.enum(["es", "en", "pt", "ca", "fr"]),
  expectedFiles: z.array(z.string().min(1)).min(1),
  expectedVerify: z.array(z.string().min(1)).min(1),
});

const RoleTokensSchema = z.strictObject({ input: z.number().nonnegative(), output: z.number().nonnegative() });

export const JourneyOutcomeSchema = z.strictObject({
  journeyId: z.string().min(1),
  oneShot: z.boolean(),
  failureCause: FailureCauseSchema,
  tokens: z.strictObject({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    byRole: z.record(z.string(), RoleTokensSchema),
  }),
  insufficientEvidenceStops: z.number().int().nonnegative(),
  necessaryInsufficientEvidenceStops: z.number().int().nonnegative().default(0),
  filesReadUnnecessarily: z.number().int().nonnegative(),
  languageCompliant: z.boolean().default(true),
  staleContextIncidents: z.number().int().nonnegative().default(0),
});

export const BenchReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  journeys: z.number().int().nonnegative(),
  acceptedDeliveries: z.number().int().nonnegative(),
  metrics: z.strictObject({
    oneShotRate: z.number().min(0).max(1),
    insufficientEvidencePrecision: z.number().min(0).max(1),
    staleContextIncidents: z.number().int().nonnegative(),
    tokensPerAcceptedDelivery: z.number().nonnegative(),
    rediscoveryRatio: z.number().min(0).max(1),
    languageCompliance: z.number().min(0).max(1),
  }),
  tokensByRole: z.record(z.string(), RoleTokensSchema),
  failuresByCause: z.record(FailureCauseSchema, z.number().int().nonnegative()),
});

export type JourneyRecord = z.infer<typeof JourneyRecordSchema>;
export type JourneyOutcome = z.infer<typeof JourneyOutcomeSchema>;
export type BenchReport = z.infer<typeof BenchReportSchema>;

function ratio(numerator: number, denominator: number, empty = 1): number {
  return denominator === 0 ? empty : numerator / denominator;
}

export function summarizeBench(outcomes: readonly JourneyOutcome[], generatedAt = new Date().toISOString()): BenchReport {
  const parsed = outcomes.map((outcome) => JourneyOutcomeSchema.parse(outcome));
  const accepted = parsed.filter((outcome) => outcome.oneShot).length;
  const totalTokens = parsed.reduce((total, outcome) => total + outcome.tokens.input + outcome.tokens.output, 0);
  const stops = parsed.reduce((total, outcome) => total + outcome.insufficientEvidenceStops, 0);
  const necessaryStops = parsed.reduce((total, outcome) => total + Math.min(outcome.insufficientEvidenceStops, outcome.necessaryInsufficientEvidenceStops), 0);
  const filesRead = parsed.reduce((total, outcome) => total + outcome.filesReadUnnecessarily, 0);
  const tokensByRole: Record<string, { input: number; output: number }> = {};
  const failuresByCause = Object.fromEntries(FailureCauseSchema.options.map((cause) => [cause, 0])) as Record<z.infer<typeof FailureCauseSchema>, number>;
  for (const outcome of parsed) {
    failuresByCause[outcome.failureCause] += 1;
    for (const [role, tokens] of Object.entries(outcome.tokens.byRole)) {
      const current = tokensByRole[role] ?? { input: 0, output: 0 };
      tokensByRole[role] = { input: current.input + tokens.input, output: current.output + tokens.output };
    }
  }
  return BenchReportSchema.parse({
    schemaVersion: 1,
    generatedAt,
    journeys: parsed.length,
    acceptedDeliveries: accepted,
    metrics: {
      oneShotRate: ratio(accepted, parsed.length, 0),
      insufficientEvidencePrecision: ratio(necessaryStops, stops),
      staleContextIncidents: parsed.reduce((total, outcome) => total + outcome.staleContextIncidents, 0),
      tokensPerAcceptedDelivery: ratio(totalTokens, accepted, 0),
      rediscoveryRatio: ratio(filesRead, Math.max(filesRead, parsed.length), 0),
      languageCompliance: ratio(parsed.filter((outcome) => outcome.languageCompliant).length, parsed.length, 0),
    },
    tokensByRole,
    failuresByCause,
  });
}
