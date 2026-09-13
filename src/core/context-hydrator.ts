import type { AtlasGraph, AtlasNode } from "./atlas.js";
import type { EvidenceKind, EvidenceRef, EvidenceStore, FreshnessResult } from "./evidence-store.js";
import type { ContractRef, Requirement, ResearchCapsulePayload, SddTask, SpecCapsulePayload, TaskGraphPayload, TestRef } from "./sdd-schema.js";
import { canonicalJson } from "./files.js";
import type { JudgeFinding } from "./flow-schema.js";
import { CONTEXT_BUDGET_CHARS, ContextRoleSchema, contextBudgetChars, type ContextRole } from "./budgets.js";
import type { RiskLane } from "./risk.js";

export const HydrationRoleSchema = ContextRoleSchema;
export type HydrationRole = ContextRole;
export const DEFAULT_BUDGET_CHARS = CONTEXT_BUDGET_CHARS.full;

export interface RuleDigest {
  readonly id: string;
  readonly statement: string;
  readonly severity: "info" | "warn" | "block";
}

export interface ContextSlice {
  readonly ref: string;
  readonly file: string;
  readonly range: [number, number];
  readonly kind: EvidenceKind;
  readonly claim: string;
  readonly text: string;
  readonly freshness: FreshnessResult["status"];
}

export interface ContextNeighbor {
  readonly file: string;
  readonly symbol: string;
  readonly relation: "caller" | "callee" | "dependent" | "dependency";
  readonly signature?: string;
}

export interface ContextBundle {
  readonly schemaVersion: 1;
  readonly role: HydrationRole;
  readonly ticketId: string;
  readonly taskId?: string;
  readonly task?: SddTask;
  readonly acceptance?: readonly Requirement[];
  readonly slices: readonly ContextSlice[];
  readonly tests: readonly TestRef[];
  readonly contracts: readonly ContractRef[];
  readonly neighbors: readonly ContextNeighbor[];
  readonly rules: readonly RuleDigest[];
  readonly coverage: ResearchCapsulePayload["coverage"];
  readonly budget: { readonly requestedChars: number; readonly usedChars: number; readonly truncated: readonly string[] };
}

export interface HydrateInput {
  readonly role: HydrationRole;
  readonly ticketId: string;
  readonly taskId?: string;
  readonly research: ResearchCapsulePayload;
  readonly spec?: SpecCapsulePayload;
  readonly tasks?: TaskGraphPayload;
  readonly store: EvidenceStore;
  readonly graph: AtlasGraph;
  readonly readSlice: (ref: EvidenceRef) => Promise<string | undefined>;
  readonly checkFreshness: (ref: EvidenceRef) => Promise<FreshnessResult>;
  readonly budgetChars?: number;
  readonly lane?: RiskLane;
  readonly rules?: readonly RuleDigest[];
  readonly findings?: readonly JudgeFinding[];
  readonly readLiveRange?: (file: string, startLine: number, endLine: number) => Promise<string | undefined>;
}

function nodeNeighbors(graph: AtlasGraph, names: readonly string[]): ContextNeighbor[] {
  const rows: ContextNeighbor[] = [];
  const push = (node: AtlasNode, relation: ContextNeighbor["relation"]): void => {
    const base = { file: node.filePath, symbol: node.name, relation };
    rows.push(node.signature === undefined ? base : { ...base, signature: node.signature });
  };
  for (const name of names) {
    const node = graph.nodes.find((candidate) => candidate.name === name);
    if (node === undefined) continue;
    for (const edge of graph.edges.filter((candidate) => candidate.from === node.id)) {
      const target = graph.nodes.find((candidate) => candidate.id === edge.to);
      if (target !== undefined) push(target, edge.type === "calls" ? "callee" : "dependency");
    }
    for (const edge of graph.edges.filter((candidate) => candidate.to === node.id)) {
      const source = graph.nodes.find((candidate) => candidate.id === edge.from);
      if (source !== undefined) push(source, edge.type === "calls" ? "caller" : "dependent");
    }
  }
  return [...new Map(rows.map((row) => [`${row.relation}:${row.file}:${row.symbol}`, row])).values()];
}

function selectedRefs(input: HydrateInput, task: SddTask | undefined): readonly EvidenceRef[] {
  const explicit = task?.evidenceRefs ?? input.research.evidenceRefs;
  const byId = input.store.refs.filter((ref) => explicit.includes(ref.id));
  const fallbackFiles = new Set(task?.files.map((file) => file.path) ?? []);
  const fallback = byId.length === 0 && fallbackFiles.size > 0
    ? input.store.refs.filter((ref) => fallbackFiles.has(ref.file))
    : byId;
  if (input.role === "judge-a") return fallback.filter((ref) => ["contract", "route", "config", "behavior"].includes(ref.kind));
  if (input.role === "judge-b") return fallback.filter((ref) => ref.kind === "test" || ref.kind === "behavior");
  return fallback;
}

export async function hydrateContext(input: HydrateInput): Promise<ContextBundle> {
  const task = input.taskId === undefined ? undefined : input.tasks?.tasks.find((candidate) => candidate.id === input.taskId);
  const acceptance = task === undefined ? undefined : input.spec?.requirements.filter((requirement) => task.requirements.includes(requirement.id));
  const refs = selectedRefs(input, task);
  const candidates: ContextSlice[] = [];
  for (const ref of refs) {
    const freshness = await input.checkFreshness(ref);
    const stored = await input.readSlice(ref);
    const text = input.role === "plan" && ref.kind !== "contract" ? "" : stored ?? "";
    const range = freshness.status === "relocated" ? freshness.range : ref.range;
    candidates.push({ ref: ref.id, file: ref.file, range, kind: ref.kind, claim: ref.claim, text, freshness: freshness.status });
  }
  if (input.role === "fix" && input.readLiveRange !== undefined) {
    for (const finding of input.findings ?? []) {
      const start = Math.max(1, finding.line - 20);
      const end = finding.line + 20;
      const text = await input.readLiveRange(finding.file, start, end) ?? "";
      candidates.unshift({
        ref: `live:${finding.file}:${String(finding.line)}`,
        file: finding.file,
        range: [start, end],
        kind: "behavior",
        claim: finding.claim,
        text,
        freshness: "fresh",
      });
    }
  }
  const allNeighbors = nodeNeighbors(input.graph, task?.targetSymbols ?? input.research.relevantNodes);
  const neighbors = input.role === "judge-a" || input.role === "judge-b"
    ? allNeighbors.filter((neighbor) => neighbor.relation === "caller" || neighbor.relation === "dependent")
    : allNeighbors;
  const requestedChars = contextBudgetChars(input.role, input.lane ?? "full", input.budgetChars);
  const slices: ContextSlice[] = [];
  const contracts: ContractRef[] = [];
  const tests: TestRef[] = [];
  const selectedNeighbors: ContextNeighbor[] = [];
  const rules: RuleDigest[] = [];
  const truncated: string[] = [];
  const relevantTests = input.research.tests.filter((test) => task === undefined || test.covers.length === 0 || test.covers.some((id) => task.requirements.includes(id)));
  const budget = { requestedChars, usedChars: 0, truncated };
  const base = {
    schemaVersion: 1 as const,
    role: input.role,
    ticketId: input.ticketId,
    slices,
    tests,
    contracts,
    neighbors: selectedNeighbors,
    rules,
    coverage: input.research.coverage,
    budget,
  };
  const bundle: ContextBundle = {
    ...base,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(task === undefined ? {} : { task }),
    ...(acceptance === undefined ? {} : { acceptance }),
  };

  interface Candidate { readonly id: string; readonly add: () => void; readonly remove: () => void }
  const queue: Candidate[] = [
    ...candidates.sort((a, b) => slicePriority(a.kind) - slicePriority(b.kind)).map((slice) => ({
      id: slice.ref, add: () => { slices.push(slice); }, remove: () => { slices.pop(); },
    })),
    ...input.research.contracts.map((contract) => ({
      id: `contract:${contract.name}`, add: () => { contracts.push(contract); }, remove: () => { contracts.pop(); },
    })),
    ...relevantTests.map((test) => ({
      id: `test:${test.file}`, add: () => { tests.push(test); }, remove: () => { tests.pop(); },
    })),
    ...neighbors.map((neighbor) => ({
      id: `neighbor:${neighbor.file}:${neighbor.symbol}`, add: () => { selectedNeighbors.push(neighbor); }, remove: () => { selectedNeighbors.pop(); },
    })),
    ...(input.rules ?? []).map((rule) => ({
      id: `rule:${rule.id}`, add: () => { rules.push(rule); }, remove: () => { rules.pop(); },
    })),
  ];
  for (const candidate of queue) {
    candidate.add();
    if (canonicalJson(bundle).length > requestedChars) {
      candidate.remove();
      truncated.push(candidate.id);
    }
  }
  budget.usedChars = canonicalJson(bundle).length;
  return bundle;
}

function slicePriority(kind: EvidenceKind): number {
  if (kind === "contract" || kind === "route" || kind === "type") return 1;
  if (kind === "test") return 2;
  return 0;
}

export function serializeBundle(bundle: ContextBundle): string {
  return canonicalJson(bundle).trimEnd();
}
