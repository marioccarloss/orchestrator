import { z } from "zod";
import type { TicketContent } from "./flow-schema.js";

export const IntentQuestionSchema = z.strictObject({
  id: z.string().regex(/^Q\d+$/u, "Question id must match Q<number>, e.g. Q1"),
  question: z.string().min(1).max(240),
  reason: z.string().min(1).max(240),
  risk: z.enum(["medium", "high"]),
  options: z.array(z.string().min(1).max(120)).max(5).default([]),
});

export const IntentNeedsInputPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  status: z.literal("NEEDS_INPUT"),
  questions: z.array(IntentQuestionSchema).min(1).max(5),
}).superRefine((payload, context) => {
  const ids = new Set<string>();
  let mediumSeen = false;
  for (const [index, question] of payload.questions.entries()) {
    if (ids.has(question.id)) {
      context.addIssue({ code: "custom", path: ["questions", index, "id"], message: `Duplicate question id ${question.id}` });
    }
    ids.add(question.id);
    if (question.risk === "medium") mediumSeen = true;
    if (question.risk === "high" && mediumSeen) {
      context.addIssue({ code: "custom", path: ["questions", index, "risk"], message: "Questions must be ordered high risk before medium risk" });
    }
  }
});

export const IntentDecisionSchema = z.strictObject({
  questionId: z.string().regex(/^Q\d+$/u).optional(),
  decision: z.string().min(1).max(300),
  source: z.enum(["user", "ticket", "engram", "atlas", "inferred", "research"]),
});

export const IntentAssumptionSchema = z.strictObject({
  statement: z.string().min(1).max(300),
  risk: z.enum(["low", "medium"]),
});

export const IntentFieldResolutionSchema = z.strictObject({
  source: z.enum(["ticket", "engram", "atlas", "inferred", "user"]),
  confidence: z.enum(["high", "medium", "low"]),
  evidenceRef: z.string().min(1).max(120).optional(),
});

export const IntentResolutionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sweepsCompleted: z.number().int().min(0).max(5),
  fields: z.record(z.string(), IntentFieldResolutionSchema),
});

export const IntentUnresolvedSchema = z.strictObject({
  field: z.enum(["problem", "outcome", "acceptanceSignals", "constraints", "scope"]),
  risk: z.enum(["medium", "high"]),
  reason: z.string().min(1).max(300),
  attemptedSources: z.array(z.enum(["ticket", "engram", "atlas", "inferred", "user"])).min(1).max(5),
  suggestedDefault: z.string().min(1).max(300).optional(),
  options: z.array(z.string().min(1).max(120)).max(5).optional(),
});

const IntentCoreFieldsSchema = {
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  mode: z.enum(["auto", "guided", "direct"]),
  problem: z.string().min(1).max(400),
  outcome: z.string().min(1).max(400),
  nonGoals: z.array(z.string().min(1).max(200)).max(5).default([]),
  acceptanceSignals: z.array(z.string().min(1).max(240)).min(1).max(8),
  constraints: z.array(z.string().min(1).max(240)).max(6).default([]),
  decisions: z.array(IntentDecisionSchema).max(8).default([]),
  assumptions: z.array(IntentAssumptionSchema).max(5).default([]),
};

export const IntentReadyPayloadSchema = z.strictObject({
  ...IntentCoreFieldsSchema,
  status: z.literal("READY"),
  resolution: IntentResolutionSchema.optional(),
});

/** Backward-compatible alias — persisted READY capsules use this shape. */
export const IntentBriefPayloadSchema = IntentReadyPayloadSchema;

export const IntentProposedPayloadSchema = z.strictObject({
  ...IntentCoreFieldsSchema,
  status: z.literal("PROPOSED"),
  resolution: IntentResolutionSchema,
  unresolved: z.array(IntentUnresolvedSchema).max(5).default([]),
});

export type IntentNeedsInputPayload = z.infer<typeof IntentNeedsInputPayloadSchema>;
export type IntentReadyPayload = z.infer<typeof IntentReadyPayloadSchema>;
export type IntentBriefPayload = IntentReadyPayload;
export type IntentProposedPayload = z.infer<typeof IntentProposedPayloadSchema>;
export type IntentUnresolved = z.infer<typeof IntentUnresolvedSchema>;
export type IntentDecision = z.infer<typeof IntentDecisionSchema>;
export type IntentDisplayPayload = Omit<IntentReadyPayload, "status"> & { status?: "READY" | "PROPOSED" };

export const IntentAssessmentPayloadSchema = z.discriminatedUnion("status", [
  IntentNeedsInputPayloadSchema,
  IntentProposedPayloadSchema,
  IntentReadyPayloadSchema,
]);

export type IntentAssessmentPayload = z.infer<typeof IntentAssessmentPayloadSchema>;

export const IntentCapsuleSchema = z.discriminatedUnion("status", [
  IntentProposedPayloadSchema.extend({ createdAt: z.iso.datetime() }),
  IntentReadyPayloadSchema.extend({ createdAt: z.iso.datetime() }),
]);

export const IntentBriefSchema = IntentCapsuleSchema;

export type IntentCapsule = z.infer<typeof IntentCapsuleSchema>;
export type IntentBrief = IntentCapsule;

const VAGUE_TITLE_RE = /^(fix|update|improve|change|refactor|optimize|wip|todo)\b/iu;
const ACCEPTANCE_LINE_RE = /(?:^|\b)(?:given|when|then|acceptance|criteri|debe|must|should|shall)\b/iu;

function extractAcceptanceSignals(description: string): string[] {
  const signals: string[] = [];
  for (const rawLine of description.split(/\r?\n/u)) {
    const line = rawLine.replace(/^[-*]\s+/u, "").trim();
    if (line.length < 8) continue;
    if (ACCEPTANCE_LINE_RE.test(line) || line.includes(":")) signals.push(line.slice(0, 240));
  }
  return [...new Set(signals)].slice(0, 8);
}

/** S0 mechanical parse — returns undefined when the ticket is too vague for auto-grounding. */
export function deriveIntentBriefFromTicket(ticket: TicketContent): IntentReadyPayload | undefined {
  const title = ticket.title.trim();
  const description = ticket.description.trim();
  if (title.length < 8) return undefined;
  if (description.length < 40 && VAGUE_TITLE_RE.test(title)) return undefined;
  const acceptanceSignals = extractAcceptanceSignals(description);
  if (acceptanceSignals.length === 0 && description.length < 80) return undefined;
  const problem = title.slice(0, 400);
  const outcome = (acceptanceSignals[0] ?? description.split(/\.\s+/u)[0] ?? title).slice(0, 400);
  const signals = acceptanceSignals.length > 0
    ? acceptanceSignals
    : [description.slice(0, 240)];
  return IntentReadyPayloadSchema.parse({
    schemaVersion: 1,
    ticketId: ticket.ref.id,
    status: "READY",
    mode: "auto",
    problem,
    outcome,
    nonGoals: [],
    acceptanceSignals: signals,
    constraints: ticket.type === "hotfix" ? ["Minimize blast radius; prefer surgical fix"] : [],
    decisions: [{ decision: problem, source: "ticket" }],
    assumptions: [],
    resolution: {
      schemaVersion: 1,
      sweepsCompleted: 1,
      fields: {
        problem: { source: "ticket", confidence: "high" },
        outcome: { source: "ticket", confidence: "high" },
        acceptanceSignals: { source: "ticket", confidence: "high" },
      },
    },
  });
}
