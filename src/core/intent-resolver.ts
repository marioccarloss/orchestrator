import type { TicketContent } from "./flow-schema.js";
import type { EngramMemoryHit } from "./engram-bridge.js";
import type { AtlasGraph } from "./atlas.js";
import {
  deriveIntentBriefFromTicket,
  IntentAssessmentPayloadSchema,
  IntentNeedsInputPayloadSchema,
  IntentProposedPayloadSchema,
  IntentReadyPayloadSchema,
  type IntentAssessmentPayload,
  type IntentDecision,
  type IntentProposedPayload,
  type IntentReadyPayload,
  type IntentUnresolved,
} from "./intent-schema.js";

export interface IntentResolveInput {
  readonly ticket: TicketContent;
  readonly engramHits?: readonly EngramMemoryHit[];
  readonly atlasGraph?: AtlasGraph;
  readonly difficulty?: number;
  /** Optional refinement from mr-intent (merged during S3; validated after merge). */
  readonly llmDraft?: Partial<Omit<IntentProposedPayload, "status" | "resolution" | "unresolved">>;
}

export interface IntentSweepResult {
  readonly assessment: IntentAssessmentPayload;
  readonly sweepLog: readonly string[];
}

const STOPWORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "de", "la", "el", "los", "las", "un", "una"]);

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 4 && !STOPWORDS.has(token)))];
}

function atlasHints(graph: AtlasGraph | undefined, ticket: TicketContent): readonly string[] {
  if (graph === undefined) return [];
  const tokens = tokenize(`${ticket.title} ${ticket.description}`);
  const hits = graph.nodes
    .filter((node) => tokens.some((token) => node.name.toLowerCase().includes(token)))
    .slice(0, 5)
    .map((node) => `${node.name}@${node.filePath}`);
  return hits;
}

function engramDecisions(hits: readonly EngramMemoryHit[] | undefined): IntentDecision[] {
  if (hits === undefined || hits.length === 0) return [];
  return hits.slice(0, 3).map((hit, index) => ({
    decision: `${hit.title}: ${hit.excerpt.slice(0, 180)}`,
    source: "engram" as const,
    ...(index === 0 ? {} : { questionId: undefined }),
  }));
}

function mergeDraft(
  base: IntentProposedPayload,
  llmDraft: IntentResolveInput["llmDraft"],
): IntentProposedPayload {
  if (llmDraft === undefined) return base;
  return IntentProposedPayloadSchema.parse({
    ...base,
    ...(llmDraft.problem === undefined ? {} : { problem: llmDraft.problem }),
    ...(llmDraft.outcome === undefined ? {} : { outcome: llmDraft.outcome }),
    ...(llmDraft.nonGoals === undefined ? {} : { nonGoals: llmDraft.nonGoals }),
    ...(llmDraft.acceptanceSignals === undefined ? {} : { acceptanceSignals: llmDraft.acceptanceSignals }),
    ...(llmDraft.constraints === undefined ? {} : { constraints: llmDraft.constraints }),
    ...(llmDraft.decisions === undefined ? {} : { decisions: llmDraft.decisions }),
    ...(llmDraft.assumptions === undefined ? {} : { assumptions: llmDraft.assumptions }),
    ...(llmDraft.mode === undefined ? {} : { mode: llmDraft.mode }),
    status: "PROPOSED",
  });
}

function buildUnresolved(
  ticket: TicketContent,
  proposed: IntentProposedPayload,
  atlas: readonly string[],
  engramCount: number,
): IntentUnresolved[] {
  const unresolved: IntentUnresolved[] = [];
  if (proposed.acceptanceSignals.length === 0) {
    unresolved.push({
      field: "acceptanceSignals",
      risk: "high",
      reason: "No acceptance signals could be inferred from ticket, memory, or atlas.",
      attemptedSources: ["ticket", ...(engramCount > 0 ? ["engram"] as const : []), ...(atlas.length > 0 ? ["atlas"] as const : [])],
      suggestedDefault: `Verify manually that '${ticket.title}' is satisfied in the target environment.`,
      options: ["Confirm the suggested default", "Provide explicit acceptance criteria", "Defer explore until ticket is clarified"],
    });
  }
  if (proposed.problem.length < 12 || proposed.outcome.length < 12) {
    unresolved.push({
      field: "outcome",
      risk: "high",
      reason: "Problem or outcome remains too vague after automated sweeps.",
      attemptedSources: ["ticket", "engram", "atlas", "inferred"],
      suggestedDefault: ticket.description.trim().slice(0, 240) || ticket.title,
      options: ["Use suggested default", "Rewrite outcome", "Ask product owner"],
    });
  }
  return unresolved.slice(0, 2);
}

function toReady(proposed: IntentProposedPayload): IntentReadyPayload {
  const { unresolved: _unresolved, resolution: _resolution, ...core } = proposed;
  return IntentReadyPayloadSchema.parse({ ...core, status: "READY" });
}

/** Deterministic intent resolution sweeps S0–S4 (no LLM). */
export function runIntentSweeps(input: IntentResolveInput): IntentSweepResult {
  const log: string[] = [];
  const ticket = input.ticket;

  // S0 — mechanical ticket parse
  log.push("S0 ticket: parse title, description, and acceptance patterns");
  const mechanical = deriveIntentBriefFromTicket(ticket);
  const problem = mechanical?.problem ?? ticket.title.trim().slice(0, 400);
  const outcome = mechanical?.outcome ?? (ticket.description.trim().slice(0, 400) || problem);
  const acceptanceSignals = mechanical?.acceptanceSignals ?? (ticket.description.trim().length >= 20 ? [ticket.description.trim().slice(0, 240)] : []);
  const constraints = mechanical?.constraints ?? (ticket.type === "hotfix" ? ["Minimize blast radius; prefer surgical fix"] : []);

  // S1 — Engram memory
  const engramHits = input.engramHits ?? [];
  log.push(`S1 engram: ${String(engramHits.length)} hit(s) scanned for prior decisions`);
  const memoryDecisions = engramDecisions(engramHits);

  // S2 — Atlas map (names only, no file bodies)
  const atlas = atlasHints(input.atlasGraph, ticket);
  log.push(`S2 atlas: ${String(atlas.length)} node hint(s) from keyword map`);
  const atlasAssumptions = atlas.length > 0
    ? [{ statement: `Likely touch area: ${atlas.slice(0, 3).join(", ")}`, risk: "low" as const }]
    : [];

  // S3 — bounded merge (optional LLM draft supplied by caller)
  log.push("S3 infer: merge ticket + memory + atlas hints" + (input.llmDraft === undefined ? "" : " + llm draft"));
  let proposed = IntentProposedPayloadSchema.parse({
    schemaVersion: 1,
    ticketId: ticket.ref.id,
    status: "PROPOSED",
    mode: mechanical?.mode ?? (memoryDecisions.length > 0 ? "guided" : "auto"),
    problem,
    outcome,
    nonGoals: mechanical?.nonGoals ?? [],
    acceptanceSignals: acceptanceSignals.length > 0 ? acceptanceSignals : [outcome],
    constraints,
    decisions: [
      { decision: problem, source: "ticket" },
      ...memoryDecisions,
    ],
    assumptions: [...(mechanical?.assumptions ?? []), ...atlasAssumptions],
    resolution: {
      schemaVersion: 1,
      sweepsCompleted: 4,
      fields: {
        problem: { source: mechanical === undefined ? "inferred" : "ticket", confidence: mechanical === undefined ? "medium" : "high" },
        outcome: { source: mechanical === undefined ? "inferred" : "ticket", confidence: acceptanceSignals.length > 0 ? "high" : "medium" },
        acceptanceSignals: { source: acceptanceSignals.length > 0 ? "ticket" : "inferred", confidence: acceptanceSignals.length > 0 ? "high" : "low" },
      },
    },
    unresolved: [],
  });
  proposed = mergeDraft(proposed, input.llmDraft);

  // S4 — validate gaps and decide PROPOSED vs NEEDS_INPUT vs auto READY
  log.push("S4 validate: classify unresolved high-risk gaps");
  const unresolved = buildUnresolved(ticket, proposed, atlas, engramHits.length);
  proposed = IntentProposedPayloadSchema.parse({ ...proposed, unresolved });

  const highUnresolved = unresolved.filter((gap) => gap.risk === "high");
  if (highUnresolved.length > 0) {
    log.push(`S4 result: NEEDS_INPUT (${String(highUnresolved.length)} high gap(s))`);
    return {
      assessment: IntentNeedsInputPayloadSchema.parse({
        schemaVersion: 1,
        ticketId: ticket.ref.id,
        status: "NEEDS_INPUT",
        questions: highUnresolved.map((gap, index) => ({
          id: `Q${String(index + 1)}`,
          question: gap.suggestedDefault ?? `Clarify ${gap.field}`,
          reason: gap.reason,
          risk: "high" as const,
          options: gap.options ?? [],
        })),
      }),
      sweepLog: log,
    };
  }

  const autoReady = (input.difficulty ?? 3) <= 3
    && proposed.resolution.fields["outcome"]?.confidence !== "low"
    && proposed.assumptions.every((assumption) => assumption.risk === "low");

  if (autoReady) {
    log.push("S4 result: READY (fast lane + sufficient confidence, no high gaps)");
    return { assessment: toReady(proposed), sweepLog: log };
  }

  log.push("S4 result: PROPOSED (confirm draft or refine with mr-intent)");
  return { assessment: proposed, sweepLog: log };
}

export function parseIntentAssessment(raw: unknown): IntentAssessmentPayload {
  return IntentAssessmentPayloadSchema.parse(raw);
}
