import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DecisionQuestion, DecisionState } from "../decision.js";
import type { RuleDigest } from "../context-hydrator.js";
import { isMustKeep, readRange, type JournalEntry } from "./journal.js";
import { STRATEGY_CHECKLIST, type ContextStrategy, type ExecutionPlan, type ExploreReport, type PlanStep, type TaskState } from "./schema.js";
import type { JevRunner } from "./decide.js";

/**
 * Receiver-driven, lossless-by-reference handoff.
 *
 * 1. must-keep entries travel verbatim (input, facts, decisions, discards, unknowns, errors, failed commands);
 * 2. candidate entries are kept or deferred by Jev with a keep bias;
 * 3. everything deferred is listed in the manifest and recoverable with mr_task_recall;
 * 4. code is sent as live slices with staleness flags, never as paraphrase.
 */

export const HandoffRoleSchemaValues = ["explore", "plan", "apply"] as const;
export type HandoffRole = (typeof HandoffRoleSchemaValues)[number];

/** Drop only when Jev is confident the receiver does not need the entry. */
export const KEEP_PROBABILITY_FLOOR = 0.25;

export const HANDOFF_BUDGET_CHARS: Readonly<Record<HandoffRole, Readonly<Record<ContextStrategy["size"], number>>>> = {
  explore: { trivial: 6_000, small: 10_000, medium: 16_000, large: 24_000 },
  plan: { trivial: 16_000, small: 32_000, medium: 48_000, large: 64_000 },
  apply: { trivial: 8_000, small: 14_000, medium: 20_000, large: 28_000 },
};

export interface HandoffSlice {
  readonly ref: string;
  readonly file: string;
  readonly range: readonly [number, number];
  readonly text: string;
  readonly stale: boolean;
  readonly why: string;
}

export interface HandoffManifestItem {
  readonly id: string;
  readonly kind: JournalEntry["kind"];
  readonly summary: string;
}

export interface HandoffBundle {
  readonly schemaVersion: 1;
  readonly role: HandoffRole;
  readonly taskId: string;
  readonly objective: string;
  readonly strategy: TaskState["classification"];
  readonly contextStrategy: Pick<ContextStrategy, "graph" | "engram" | "rules" | "read" | "verify" | "size">;
  readonly checklist?: Readonly<Record<string, string>>;
  readonly requiredChecklist?: readonly string[];
  readonly report?: Omit<ExploreReport, "facts" | "checklist">;
  readonly step?: PlanStep;
  readonly plan?: { readonly summary: string; readonly assumptions: readonly string[]; readonly verification: readonly string[] };
  readonly mustKeep: readonly JournalEntry[];
  readonly kept: readonly JournalEntry[];
  readonly slices: readonly HandoffSlice[];
  readonly rules: readonly RuleDigest[];
  readonly memory: readonly string[];
  readonly manifest: readonly HandoffManifestItem[];
  readonly selection: { readonly by: "jev" | "recency"; readonly error?: string };
  readonly budget: { readonly limitChars: number; readonly usedChars: number };
}

export interface HandoffInput {
  readonly role: HandoffRole;
  readonly state: TaskState;
  readonly journal: readonly JournalEntry[];
  readonly workspaceRoot: string;
  readonly report?: ExploreReport;
  readonly plan?: ExecutionPlan;
  readonly stepId?: string;
  readonly rules?: readonly RuleDigest[];
  readonly memory?: readonly string[];
  readonly jev?: JevRunner;
  readonly budgetChars?: number;
}

function sizeOf(value: unknown): number {
  return JSON.stringify(value).length;
}

function sliceKey(file: string, range: readonly [number, number]): string {
  return `${file}:${String(range[0])}-${String(range[1])}`;
}

async function liveSlice(root: string, ref: string, file: string, range: readonly [number, number], why: string, expectedSha?: string): Promise<HandoffSlice | undefined> {
  const live = await readRange(root, file, range);
  if (live === undefined) return undefined;
  return { ref, file, range, text: live.text, stale: expectedSha !== undefined && expectedSha !== live.fileSha, why };
}

function clampRange(range: readonly [number, number], padding: number): [number, number] {
  return [Math.max(1, range[0] - padding), range[1] + padding];
}

async function anchorRange(root: string, step: PlanStep): Promise<[number, number] | undefined> {
  if (step.anchor === undefined) return undefined;
  let source: string;
  try {
    source = await readFile(join(root, step.file), "utf8");
  } catch {
    return undefined;
  }
  const index = source.indexOf(step.anchor.snippet);
  if (index === -1) return undefined;
  const startLine = source.slice(0, index).split("\n").length;
  const endLine = startLine + step.anchor.snippet.split("\n").length - 1;
  return [startLine, endLine];
}

function candidateQuestions(role: HandoffRole, candidates: readonly JournalEntry[]): readonly DecisionQuestion[] {
  return candidates.map((entry) => ({
    id: entry.id,
    type: "boolean" as const,
    instructions: `Does the ${role} role need this item inline (not just a reference) to do its job correctly? Item: ${entry.summary}`,
    criteria: {
      true: "Omitting it could cause a wrong plan, a missed constraint, a repeated failed attempt, or re-reading.",
      false: "It is superseded, duplicated, exploratory noise, or irrelevant to the objective.",
    },
  }));
}

async function selectCandidates(
  input: HandoffInput,
  candidates: readonly JournalEntry[],
): Promise<{ readonly keep: ReadonlySet<string>; readonly by: "jev" | "recency"; readonly error?: string }> {
  if (candidates.length === 0) return { keep: new Set(), by: "recency" };
  const jev = input.jev;
  if (jev?.available === true) {
    const batch = candidates.slice(-60);
    const state: DecisionState = {
      objective: input.report?.objective ?? input.state.input.text.slice(0, 2_000),
      receiver: input.role,
      strategy: input.state.classification.strategy,
      requiredChecklist: [...STRATEGY_CHECKLIST[input.state.classification.strategy]],
      ...(input.stepId === undefined ? {} : { step: input.stepId }),
    };
    try {
      const result = await jev.evaluate(state, candidateQuestions(input.role, batch));
      const keep = new Set<string>();
      for (const entry of batch) {
        const answer = result.answers[entry.id];
        const probability = answer?.type === "boolean" ? answer.probability : undefined;
        if (probability === undefined || probability >= KEEP_PROBABILITY_FLOOR) keep.add(entry.id);
      }
      return { keep, by: "jev" };
    } catch (error: unknown) {
      return { keep: new Set(candidates.map((entry) => entry.id)), by: "recency", error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { keep: new Set(candidates.map((entry) => entry.id)), by: "recency" };
}

function relevantToStep(entry: JournalEntry, step: PlanStep | undefined): boolean {
  if (step === undefined) return true;
  if (entry.file !== undefined) return entry.file === step.file || entry.file === step.reference?.file;
  return entry.kind !== "read" && entry.kind !== "search";
}

export async function buildHandoff(input: HandoffInput): Promise<HandoffBundle> {
  const { state, role } = input;
  const limitChars = input.budgetChars ?? HANDOFF_BUDGET_CHARS[role][state.contextStrategy.size];
  const step = input.stepId === undefined ? undefined : input.plan?.steps.find((candidate) => candidate.id === input.stepId);

  const mustKeepAll = input.journal.filter((entry) => isMustKeep(entry) && (role !== "apply" || relevantToStep(entry, step) || entry.kind === "input" || entry.kind === "decision"));
  const candidateAll = input.journal.filter((entry) => !isMustKeep(entry) && entry.kind !== "phase" && entry.kind !== "jev" && (role !== "apply" || relevantToStep(entry, step)));
  const selection = await selectCandidates(input, candidateAll);

  const slices: HandoffSlice[] = [];
  const seenSlices = new Set<string>();
  const pushSlice = (slice: HandoffSlice | undefined): void => {
    if (slice === undefined) return;
    const key = sliceKey(slice.file, slice.range);
    if (seenSlices.has(key)) return;
    seenSlices.add(key);
    slices.push(slice);
  };

  // Priority slices: what the receiver acts on.
  if (role === "apply" && step !== undefined) {
    const anchor = await anchorRange(input.workspaceRoot, step);
    if (anchor !== undefined) pushSlice(await liveSlice(input.workspaceRoot, `anchor:${step.id}`, step.file, clampRange(anchor, 20), "anchor neighborhood"));
    if (step.reference !== undefined) pushSlice(await liveSlice(input.workspaceRoot, `reference:${step.id}`, step.reference.file, step.reference.lines, "reference to replicate"));
  }
  if (role === "plan" && input.report !== undefined) {
    if (input.report.reference !== undefined) {
      pushSlice(await liveSlice(input.workspaceRoot, "reference", input.report.reference.file, input.report.reference.range, input.report.reference.why));
    }
    for (const [index, fact] of input.report.facts.entries()) {
      pushSlice(await liveSlice(input.workspaceRoot, `fact:${String(index + 1)}`, fact.file, clampRange(fact.range, 3), fact.claim));
    }
  }

  const base = {
    schemaVersion: 1 as const,
    role,
    taskId: state.id,
    objective: input.report?.objective ?? state.input.text,
    strategy: state.classification,
    contextStrategy: {
      graph: state.contextStrategy.graph,
      engram: state.contextStrategy.engram,
      rules: state.contextStrategy.rules,
      read: state.contextStrategy.read,
      verify: state.contextStrategy.verify,
      size: state.contextStrategy.size,
    },
    ...(role === "plan" && input.report !== undefined ? { checklist: input.report.checklist } : {}),
    ...(role === "explore" ? { requiredChecklist: STRATEGY_CHECKLIST[state.classification.strategy] } : {}),
    ...(role === "plan" && input.report !== undefined
      ? {
        report: {
          objective: input.report.objective,
          ...(input.report.reference === undefined ? {} : { reference: input.report.reference }),
          filesOfInterest: input.report.filesOfInterest,
          unknowns: input.report.unknowns,
        },
      }
      : {}),
    ...(step === undefined ? {} : { step }),
    ...(role === "apply" && input.plan !== undefined
      ? { plan: { summary: input.plan.summary, assumptions: input.plan.assumptions, verification: input.plan.verification } }
      : {}),
  };

  const mustKeep: JournalEntry[] = [];
  const kept: JournalEntry[] = [];
  const rules: RuleDigest[] = [];
  const memory: string[] = [];
  const manifest: HandoffManifestItem[] = [];
  const selectedSlices: HandoffSlice[] = [];
  const bundle = (): HandoffBundle => ({
    ...base,
    mustKeep,
    kept,
    slices: selectedSlices,
    rules,
    memory,
    manifest,
    selection: { by: selection.by, ...(selection.error === undefined ? {} : { error: selection.error }) },
    budget: { limitChars, usedChars: 0 },
  });
  const fits = (): boolean => sizeOf(bundle()) <= limitChars;
  const defer = (entry: JournalEntry): void => { manifest.push({ id: entry.id, kind: entry.kind, summary: entry.summary }); };

  // 1. must-keep always travels, even over budget: losing it is worse than spending tokens.
  mustKeep.push(...mustKeepAll);
  // 2. rules marked block are must-keep as well.
  for (const rule of input.rules ?? []) {
    rules.push(rule);
    if (rule.severity !== "block" && !fits()) rules.pop();
  }
  // 3. priority slices.
  for (const slice of slices) {
    selectedSlices.push(slice);
    if (!fits() && selectedSlices.length > 1) selectedSlices.pop();
  }
  // 4. Jev-selected candidates, newest first; read entries are rehydrated as slices.
  const ordered = [...candidateAll].reverse();
  for (const entry of ordered) {
    if (!selection.keep.has(entry.id)) {
      defer(entry);
      continue;
    }
    if (entry.kind === "read" && entry.file !== undefined && entry.range !== undefined && role !== "explore") {
      const key = sliceKey(entry.file, entry.range);
      if (seenSlices.has(key)) continue;
      const slice = await liveSlice(input.workspaceRoot, entry.id, entry.file, entry.range, entry.summary, entry.fileSha);
      if (slice === undefined) {
        defer(entry);
        continue;
      }
      selectedSlices.push(slice);
      if (!fits()) {
        selectedSlices.pop();
        defer(entry);
      } else {
        seenSlices.add(key);
      }
      continue;
    }
    kept.push(entry);
    if (!fits()) {
      kept.pop();
      defer(entry);
    }
  }
  kept.reverse();
  // 5. memory last: advisory.
  for (const item of input.memory ?? []) {
    memory.push(item);
    if (!fits()) memory.pop();
  }
  const final = bundle();
  return { ...final, budget: { limitChars, usedChars: sizeOf(final) } };
}

/** Model-facing wire form: no timestamps, ids kept for recall, empty sections and duplicates omitted. */
export function compactHandoff(bundle: HandoffBundle): Record<string, unknown> {
  const entry = (item: JournalEntry): Record<string, unknown> => ({
    id: item.id,
    kind: item.kind,
    ...(item.role === undefined ? {} : { role: item.role }),
    text: item.detail !== undefined && item.detail !== item.summary && !item.detail.startsWith(item.summary.replace(/…$/u, "")) ? `${item.summary}\n${item.detail}` : item.detail ?? item.summary,
    ...(item.file === undefined ? {} : { file: item.file }),
    ...(item.range === undefined ? {} : { range: item.range }),
    ...(item.failed === true ? { failed: true } : {}),
  });
  const internalDecision = (item: JournalEntry): boolean => item.kind === "decision" && item.role === "jev";
  const mustKeep = bundle.mustKeep.filter((item) => !internalDecision(item) && !(item.kind === "input" && item.detail === bundle.objective));
  const optional = <T>(key: string, values: readonly T[]): Record<string, readonly T[]> => (values.length === 0 ? {} : { [key]: values });
  return {
    role: bundle.role,
    objective: bundle.objective,
    strategy: `${bundle.strategy.strategy} d${String(bundle.strategy.difficulty)}`,
    verify: bundle.contextStrategy.verify,
    ...(bundle.checklist === undefined ? {} : { checklist: bundle.checklist }),
    ...(bundle.requiredChecklist === undefined ? {} : { requiredChecklist: bundle.requiredChecklist }),
    ...(bundle.report === undefined ? {} : { report: bundle.report }),
    ...(bundle.step === undefined ? {} : { step: bundle.step }),
    ...(bundle.plan === undefined ? {} : { plan: bundle.plan }),
    mustKeep: mustKeep.map(entry),
    ...optional("kept", bundle.kept.map(entry)),
    slices: bundle.slices.map((slice) => ({ ref: slice.ref, file: slice.file, range: slice.range, text: slice.text.replace(/\n\d+: $/u, ""), ...(slice.stale ? { stale: true } : {}), why: slice.why })),
    ...optional("rules", bundle.rules),
    ...optional("memory", bundle.memory),
    ...optional("manifest", bundle.manifest),
    selection: bundle.selection,
  };
}
