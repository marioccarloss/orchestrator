import type { DecisionEngine, DecisionEngineResult, DecisionQuestion, DecisionState } from "../decision.js";
import { DEFAULT_CRITICAL_AREAS } from "../risk.js";
import {
  ORDERED,
  STRATEGY_CHECKLIST,
  TASK_DIFFICULTIES,
  checklistGaps,
  checklistUnknowns,
  type ContextStrategy,
  type DecisionSource,
  type ExploreReport,
  type TaskClassification,
  type TaskDifficulty,
  type TaskEscalation,
  type TaskInput,
  type TaskSize,
  type TaskStrategy,
} from "./schema.js";
import type { VerificationTools } from "./verify.js";

/** Minimum probability for a Jev answer to override the deterministic heuristic. */
export const TASK_ACCEPT_THRESHOLD = 0.75;
/** Minimum probability for Jev to resolve a model-authored question without asking anyone. */
export const TASK_ASK_RESOLVE_THRESHOLD = 0.85;
export const MAX_HUMAN_QUESTIONS = 2;
export const MAX_JEV_QUESTIONS = 9;

// ─── Signals (deterministic intake) ─────────────────────────────────────────

export interface TaskSignals {
  readonly words: number;
  readonly crossCutting: number;
  readonly mentionedFiles: readonly string[];
  readonly mentionedSymbols: readonly string[];
  readonly keywordHits: Readonly<Record<TaskStrategy, number>>;
  readonly criticalAreas: readonly string[];
  readonly blockRules: readonly string[];
  readonly hasDesign: boolean;
  readonly isTicket: boolean;
  readonly tools: VerificationTools;
}

const KEYWORDS: Readonly<Record<TaskStrategy, readonly string[]>> = {
  bugfix: ["bug", "fix", "arregla", "corrige", "corregir", "correct ", "debería", "deberia", "should be", "should not", "instead of", "en lugar de", "en vez de", "incorrect", "wrong", "no elimina", "no muestra", "no guarda", "no carga", "no actualiza", "arreglar", "error", "falla", "fallo", "no funciona", "rompe", "roto", "broken", "crash", "exception", "excepción", "regression", "regresión", "undefined", "500", "issue"],
  replicate: ["como en", "igual que", "same as", "like the", "como la", "como el", "copiar", "copia", "replica", "reutiliza", "similar a", "mismo que", "ya existe", "already exists", "patrón", "pattern"],
  ui: ["landing", "página", "pagina", "page", "componente", "component", "banner", "modal", "figma", "diseño", "design", "layout", "botón", "button", "header", "footer", "hero", "estilo", "style", "css", "responsive"],
  tweak: ["cambia", "cambiar", "change", "pon ", "poner", "set ", "rename", "renombra", "true", "false", "texto", "copy", "color", "valor", "value", "typo", "variable", "constante", "flag", "una línea", "one line"],
  feature: ["feature", "funcionalidad", "implementa", "implement", "añade", "agrega", "add ", "nuevo", "nueva", "new ", "endpoint", "soporte", "support", "permitir", "allow"],
  refactor: ["refactor", "refactoriza", "extrae", "extract", "mueve", "move ", "limpia", "clean up", "reorganiza", "simplifica", "renombrar en todo", "deduplica"],
};

/** Phrases that signal blast radius or contracts to preserve; they raise difficulty. */
const CROSS_CUTTING = [
  "consumer", "consumidor", "downstream", "monorepo", "shared", "compartid", "all ", "todos los", "todas las",
  "federation", "federad", "expose", "public contract", "contrato", "contract", "domain", "dominio", "boundar",
  "without breaking", "sin romper", "without changing", "sin cambiar", "preserv", "conservando", "manteniendo",
  "backward", "retrocompat", "memoiz", "schema", "esquema", "convention", "convenci", "typed", "tipad",
];

/** Domain words that map to the critical areas in risk.ts. */
const CRITICAL_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  auth: ["auth", "jwt", "oauth", "login", "password", "contraseña", "session", "sesión", "refresh token", "voter", "protegida", "protected route", "permission", "permiso"],
  security: ["security", "seguridad", "csrf", "xss", "encrypt", "cifrad", "secret"],
  payment: ["payment", "pago", "checkout", "billing", "factura", "stripe"],
  migration: ["migration", "migración", "migrate "],
  persistence: ["database", "base de datos", "persistence", "persistencia"],
};

const FILE_TOKEN = /[\w@.\-/]+\.(?:tsx?|jsx?|mjs|cjs|php|java|css|scss|astro|vue|svelte|json|ya?ml|md|html|py|go|rs)\b/giu;
const IDENTIFIER_TOKEN = /`([A-Za-z_$][\w$]{2,})`|\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:[A-Z][a-z0-9]+)+)\b/gu;

export interface SignalContext {
  readonly fileExists: (path: string) => boolean;
  readonly knownSymbols?: ReadonlySet<string>;
  readonly blockRulesFor?: (files: readonly string[]) => readonly string[];
  readonly tools: VerificationTools;
}

function countHits(text: string, words: readonly string[]): number {
  return words.reduce((total, word) => total + (text.includes(word) ? 1 : 0), 0);
}

export function collectTaskSignals(input: TaskInput, context: SignalContext): TaskSignals {
  const text = `${input.text}\n${input.ticketRef ?? ""}`;
  const lower = ` ${text.toLowerCase()} `;
  const mentionedFiles = [...new Set([...text.matchAll(FILE_TOKEN)].map((match) => match[0].replace(/^\.\//u, "")))]
    .filter((file) => context.fileExists(file))
    .slice(0, 20);
  const identifiers = [...text.matchAll(IDENTIFIER_TOKEN)].map((match) => match[1] ?? match[2] ?? "").filter((name) => name.length > 0);
  const mentionedSymbols = [...new Set(identifiers)]
    .filter((name) => context.knownSymbols === undefined || context.knownSymbols.has(name))
    .slice(0, 20);
  const keywordHits = Object.fromEntries(
    (Object.keys(KEYWORDS) as TaskStrategy[]).map((strategy) => [strategy, countHits(lower, KEYWORDS[strategy])]),
  ) as Record<TaskStrategy, number>;
  const criticalAreas = DEFAULT_CRITICAL_AREAS.filter((area) => {
    const needle = area.replaceAll("-", " ");
    const synonyms = CRITICAL_SYNONYMS[area] ?? [];
    return lower.includes(` ${needle}`)
      || synonyms.some((word) => lower.includes(word))
      || mentionedFiles.some((file) => file.toLowerCase().includes(area));
  });
  return {
    words: text.trim().split(/\s+/u).filter(Boolean).length,
    crossCutting: countHits(lower, CROSS_CUTTING),
    mentionedFiles,
    mentionedSymbols,
    keywordHits,
    criticalAreas,
    blockRules: context.blockRulesFor?.(mentionedFiles) ?? [],
    hasDesign: input.kind === "design" || input.designRef !== undefined,
    isTicket: input.kind === "ticket" || input.ticketRef !== undefined,
    tools: context.tools,
  };
}

// ─── Heuristics (fallback when Jev is unavailable or unsure) ────────────────

const STRATEGY_PRIORITY: readonly TaskStrategy[] = ["bugfix", "replicate", "refactor", "ui", "feature", "tweak"];

export function heuristicStrategy(signals: TaskSignals): TaskStrategy {
  if (signals.hasDesign && signals.keywordHits.bugfix === 0) return signals.keywordHits.replicate > 0 ? "replicate" : "ui";
  const short = signals.words <= 25;
  if (short && signals.keywordHits.tweak > 0 && signals.keywordHits.bugfix === 0 && signals.keywordHits.feature === 0) return "tweak";
  // An explicit "like X already does" names a reference in the codebase: that is the cheapest strategy.
  if (signals.keywordHits.replicate > 0 && signals.keywordHits.bugfix === 0) return "replicate";
  let best: TaskStrategy = "feature";
  let bestHits = 0;
  for (const strategy of STRATEGY_PRIORITY) {
    if (signals.keywordHits[strategy] > bestHits) {
      best = strategy;
      bestHits = signals.keywordHits[strategy];
    }
  }
  return best;
}

export function heuristicDifficulty(strategy: TaskStrategy, signals: TaskSignals): TaskDifficulty {
  const base: Record<TaskStrategy, TaskDifficulty> = { tweak: 1, replicate: 2, ui: 3, feature: 3, bugfix: 3, refactor: 5 };
  let value: number = base[strategy];
  if (signals.crossCutting >= 2) value = Math.max(value, 5);
  if (signals.crossCutting >= 4) value = Math.max(value, 8);
  if (signals.criticalAreas.length > 0) value = Math.max(value, 5);
  if (signals.words > 120 || signals.mentionedFiles.length > 3) value = Math.max(value, 5);
  if (signals.words > 400) value = Math.max(value, 8);
  if (signals.isTicket && strategy !== "tweak") value = Math.max(value, 3);
  if (signals.hasDesign && strategy === "ui" && signals.words > 80) value = Math.max(value, 5);
  return TASK_DIFFICULTIES.find((candidate) => candidate >= value) ?? 13;
}

export function sizeForDifficulty(difficulty: TaskDifficulty): TaskSize {
  if (difficulty === 1) return "trivial";
  if (difficulty <= 3) return "small";
  if (difficulty <= 8) return "medium";
  return "large";
}

export function heuristicContextStrategy(strategy: TaskStrategy, difficulty: TaskDifficulty, signals: TaskSignals): Omit<ContextStrategy, "sources" | "floors"> {
  const hasFiles = signals.mentionedFiles.length > 0;
  const size = sizeForDifficulty(difficulty);
  const read: ContextStrategy["read"] = strategy === "tweak" && hasFiles
    ? "none"
    : strategy === "refactor" || size === "large" ? "broad" : "targeted";
  const graph: ContextStrategy["graph"] = strategy === "refactor"
    ? "impact"
    : read === "none" ? "skip" : read === "broad" || !hasFiles ? "map" : "skip";
  const verify: Record<TaskStrategy, ContextStrategy["verify"]> = {
    tweak: "format-lint", replicate: "typecheck", ui: "typecheck", feature: "typecheck", bugfix: "tests", refactor: "tests",
  };
  return {
    graph,
    engram: strategy === "tweak" ? "skip" : "prefetch",
    rules: strategy === "tweak" || strategy === "replicate" ? "skip" : "applicable",
    read,
    verify: verify[strategy],
    size,
  };
}

// ─── Floors (deterministic minimums Jev cannot lower) ───────────────────────

function atLeast<K extends keyof typeof ORDERED>(key: K, current: (typeof ORDERED)[K][number], minimum: (typeof ORDERED)[K][number]): (typeof ORDERED)[K][number] {
  const order = ORDERED[key] as readonly string[];
  return order.indexOf(current) >= order.indexOf(minimum) ? current : minimum;
}

export function applyTaskFloors(strategy: ContextStrategy, classification: TaskClassification, signals: TaskSignals): ContextStrategy {
  const floors: string[] = [];
  const sources: Record<string, DecisionSource> = { ...strategy.sources };
  let next: ContextStrategy = { ...strategy };
  const raise = <K extends "graph" | "read" | "verify">(key: K, minimum: ContextStrategy[K], reason: string): void => {
    const raised = atLeast(key, next[key], minimum);
    if (raised !== next[key]) {
      next = { ...next, [key]: raised };
      sources[key] = "floor";
      floors.push(reason);
    }
  };
  if (signals.blockRules.length > 0 && next.rules === "skip") {
    next = { ...next, rules: "applicable" };
    sources["rules"] = "floor";
    floors.push(`blocking rules apply: ${signals.blockRules.slice(0, 5).join(", ")}`);
  }
  if (classification.strategy === "bugfix") {
    raise("read", "targeted", "bugfix requires targeted reading");
    if (signals.tools.scripts.test !== undefined) raise("verify", "tests", "bugfix requires tests when a test script exists");
  }
  if ((classification.strategy === "feature" || classification.strategy === "refactor") && signals.tools.scripts.typecheck !== undefined) {
    raise("verify", "typecheck", `${classification.strategy} requires typecheck when available`);
  }
  if (classification.strategy === "refactor") raise("graph", "impact", "refactor requires impact analysis");
  if (next.read === "broad") raise("graph", "map", "broad reading requires a graph map");
  if (next.read === "none" && signals.mentionedFiles.length === 0) raise("read", "targeted", "no target file is known");
  return { ...next, sources, floors: [...strategy.floors, ...floors] };
}

export function escalationFor(classification: TaskClassification, size: TaskSize, signals: TaskSignals): TaskEscalation | undefined {
  const reasons = [
    ...(signals.criticalAreas.length === 0 ? [] : [`critical areas: ${signals.criticalAreas.join(", ")}`]),
    ...(size === "large" ? ["size is large"] : []),
    ...(classification.difficulty >= 13 ? [`difficulty ${String(classification.difficulty)} >= 13`] : []),
  ];
  return reasons.length === 0 ? undefined : { recommend: "flow", reasons };
}

// ─── Jev questions ───────────────────────────────────────────────────────────

const STRATEGY_CRITERIA: Readonly<Record<TaskStrategy, string>> = {
  tweak: "A localized value, text, flag, or one-line change in a known place.",
  replicate: "The codebase already solves the same thing elsewhere; copy that reference with small deltas.",
  ui: "New or changed UI (page, landing, component) usually driven by a design.",
  feature: "New behavior across one or more modules, typically from a ticket.",
  bugfix: "Existing behavior is wrong; requires reproduction, root cause, and a regression check.",
  refactor: "Restructure code without changing behavior; dependents and tests matter.",
};

const DIFFICULTY_CRITERIA: Readonly<Record<string, string>> = {
  d1: "Trivial: one place, no reasoning.",
  d2: "Copy of an existing pattern with small deltas.",
  d3: "Small: a few files, clear approach.",
  d5: "Medium: several files or a non-obvious approach.",
  d8: "Hard: cross-cutting or subtle behavior; careful reasoning.",
  d13: "Very hard or risky: should use the full /flow pipeline.",
};

export function intakeQuestions(): readonly DecisionQuestion[] {
  return [
    { id: "strategy", type: "choice", instructions: "Classify the task so the cheapest correct delivery strategy is used.", criteria: STRATEGY_CRITERIA },
    { id: "difficulty", type: "choice", instructions: "Estimate delivery difficulty on a Fibonacci scale.", criteria: DIFFICULTY_CRITERIA },
    {
      id: "read", type: "choice", instructions: "How much source must be read before planning? Prefer the least that still avoids mistakes.",
      criteria: {
        none: "The target is explicit; the planner can read it directly.",
        targeted: "A few specific files or symbols must be located and read.",
        broad: "Many files or unknown locations must be mapped.",
      },
    },
    {
      id: "graph", type: "choice", instructions: "Is the code graph (symbols, callers, dependents) needed?",
      criteria: {
        skip: "No graph needed; paths are known or the change is isolated.",
        map: "Needed only to locate files and symbols.",
        impact: "Needed to know callers or dependents affected by the change.",
      },
    },
    {
      id: "engram", type: "choice", instructions: "Would past project memory (decisions, conventions, previous fixes) help?",
      criteria: { skip: "Memory is irrelevant for this change.", prefetch: "Past decisions or conventions likely matter." },
    },
    {
      id: "rules", type: "choice", instructions: "Must repository rules and conventions be loaded?",
      criteria: { skip: "The change cannot violate conventions (value or text only).", applicable: "New code is written; conventions matter." },
    },
    {
      id: "verify", type: "choice", instructions: "Minimum verification that proves the change works. Formatting and lint of touched files always run when available.",
      criteria: {
        "format-lint": "Formatting and lint of touched files are enough.",
        typecheck: "Types or contracts may break; run typecheck.",
        tests: "Behavior changes; run tests.",
      },
    },
  ];
}

export function postExploreQuestions(): readonly DecisionQuestion[] {
  return [
    { id: "strategy", type: "choice", instructions: "With the explore report, classify the delivery strategy.", criteria: STRATEGY_CRITERIA },
    { id: "difficulty", type: "choice", instructions: "With the explore report, estimate delivery difficulty.", criteria: DIFFICULTY_CRITERIA },
    {
      id: "sufficient", type: "boolean",
      instructions: "Is the report sufficient for a planner to write an exact, anchored plan without re-exploring the codebase?",
      criteria: {
        true: "Targets, references, and constraints are concrete; remaining unknowns cannot change the plan.",
        false: "A missing location, reproduction, contract, or reference could change the plan.",
      },
    },
  ];
}

export interface AcceptedAnswers {
  readonly choices: Readonly<Record<string, { readonly value: string; readonly probability: number }>>;
  readonly booleans: Readonly<Record<string, { readonly value: boolean; readonly probability: number }>>;
}

/** Keeps only answers whose probability clears the threshold; everything else falls back to heuristics. */
export function acceptAnswers(result: DecisionEngineResult, questions: readonly DecisionQuestion[], threshold = TASK_ACCEPT_THRESHOLD): AcceptedAnswers {
  const choices: Record<string, { value: string; probability: number }> = {};
  const booleans: Record<string, { value: boolean; probability: number }> = {};
  for (const question of questions) {
    const answer = result.answers[question.id];
    if (answer === undefined || answer.type !== question.type) continue;
    if (answer.type === "choice" && question.type === "choice") {
      if (!(answer.choice in question.criteria)) continue;
      const probability = answer.probabilities?.[answer.choice] ?? result.confidence?.[question.id];
      if (probability !== undefined && probability >= threshold) choices[question.id] = { value: answer.choice, probability };
    }
    if (answer.type === "boolean") {
      const probability = answer.probability;
      if (probability >= threshold || probability <= 1 - threshold) {
        booleans[question.id] = { value: probability >= 0.5, probability: probability >= 0.5 ? probability : 1 - probability };
      }
    }
  }
  return { choices, booleans };
}

export interface JevRunner {
  readonly available: boolean;
  evaluate(state: DecisionState, questions: readonly DecisionQuestion[]): Promise<DecisionEngineResult>;
}

export function jevRunner(engine: DecisionEngine | undefined, enabled: boolean, config: { readonly maxRetries: number; readonly timeoutMs: number }): JevRunner {
  const available = enabled && engine?.status().available === true;
  return {
    available,
    async evaluate(state, questions) {
      if (!available || engine === undefined) throw new Error("Jev is unavailable");
      return engine.evaluate({ state, questions, maxRetries: config.maxRetries, timeoutMs: config.timeoutMs });
    },
  };
}

async function tryEvaluate(jev: JevRunner, state: DecisionState, questions: readonly DecisionQuestion[]): Promise<{ readonly accepted?: AcceptedAnswers; readonly error?: string; readonly result?: DecisionEngineResult }> {
  if (!jev.available) return { error: "jev-unavailable" };
  try {
    const result = await jev.evaluate(state, questions);
    return { accepted: acceptAnswers(result, questions), result };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function difficultyFromChoice(value: string): TaskDifficulty | undefined {
  const parsed = Number(value.replace(/^d/u, ""));
  return TASK_DIFFICULTIES.find((candidate) => candidate === parsed);
}

// ─── J1: intake decision ─────────────────────────────────────────────────────

export interface IntakeDecision {
  readonly classification: TaskClassification;
  readonly contextStrategy: ContextStrategy;
  readonly escalation?: TaskEscalation;
  readonly jev: { readonly used: boolean; readonly accepted: readonly string[]; readonly error?: string; readonly usage?: DecisionEngineResult["usage"] };
}

export async function decideIntake(input: TaskInput, signals: TaskSignals, jev: JevRunner): Promise<IntakeDecision> {
  const questions = intakeQuestions();
  const state = {
    task: input.text.slice(0, 6_000),
    kind: input.kind,
    signals: {
      words: signals.words,
      mentionedFiles: signals.mentionedFiles,
      mentionedSymbols: signals.mentionedSymbols,
      keywordHits: signals.keywordHits,
      criticalAreas: signals.criticalAreas,
      hasDesign: signals.hasDesign,
      isTicket: signals.isTicket,
      verificationAvailable: Object.keys(signals.tools.scripts),
    },
  };
  const evaluated = await tryEvaluate(jev, state, questions);
  const choices = evaluated.accepted?.choices ?? {};
  const sources: Record<string, DecisionSource> = {};

  const heuristicKind = heuristicStrategy(signals);
  const jevStrategy = choices["strategy"]?.value as TaskStrategy | undefined;
  const strategy = jevStrategy ?? heuristicKind;
  sources["strategy"] = jevStrategy === undefined ? "heuristic" : "jev";
  const jevDifficulty = choices["difficulty"] === undefined ? undefined : difficultyFromChoice(choices["difficulty"].value);
  const heuristicValue = heuristicDifficulty(strategy, signals);
  // At intake Jev only sees the request text; the bench showed it underestimates blast radius,
  // so it may raise the deterministic difficulty but never lower it. After explore it may.
  const difficulty = jevDifficulty === undefined ? heuristicValue : jevDifficulty >= heuristicValue ? jevDifficulty : heuristicValue;
  sources["difficulty"] = jevDifficulty !== undefined && jevDifficulty > heuristicValue ? "jev" : "heuristic";

  const fallback = heuristicContextStrategy(strategy, difficulty, signals);
  const pick = <K extends "graph" | "engram" | "rules" | "read" | "verify">(key: K): ContextStrategy[K] => {
    const value = choices[key]?.value;
    sources[key] = value === undefined ? "heuristic" : "jev";
    return (value ?? fallback[key]) as ContextStrategy[K];
  };
  const classification: TaskClassification = {
    strategy,
    difficulty,
    source: jevStrategy === undefined ? "heuristic" : "jev",
    ...(choices["strategy"] === undefined ? {} : { confidence: choices["strategy"].probability }),
  };
  const draft: ContextStrategy = {
    graph: pick("graph"),
    engram: pick("engram"),
    rules: pick("rules"),
    read: pick("read"),
    verify: pick("verify"),
    size: sizeForDifficulty(difficulty),
    sources,
    floors: [],
  };
  const contextStrategy = applyTaskFloors(draft, classification, signals);
  const escalation = escalationFor(classification, contextStrategy.size, signals);
  return {
    classification,
    contextStrategy,
    ...(escalation === undefined ? {} : { escalation }),
    jev: {
      used: evaluated.accepted !== undefined,
      accepted: Object.keys(choices),
      ...(evaluated.error === undefined ? {} : { error: evaluated.error }),
      ...(evaluated.result === undefined ? {} : { usage: evaluated.result.usage }),
    },
  };
}

// ─── J2: post-explore decision ───────────────────────────────────────────────

export interface ExploreDecision {
  readonly classification: TaskClassification;
  readonly sufficient: boolean;
  readonly gaps: readonly string[];
  readonly escalation?: TaskEscalation;
  readonly jev: { readonly used: boolean; readonly error?: string; readonly usage?: DecisionEngineResult["usage"] };
}

export function heuristicSufficiency(strategy: TaskStrategy, report: ExploreReport): { readonly sufficient: boolean; readonly gaps: readonly string[] } {
  const missing = checklistGaps(strategy, report);
  const unknown = checklistUnknowns(strategy, report);
  const critical = strategy === "bugfix" ? unknown.filter((key) => key === "reproduction" || key === "failingPath")
    : strategy === "replicate" ? unknown.filter((key) => key === "reference")
      : unknown.filter((key) => key === "target");
  const gaps = [...missing.map((key) => `missing:${key}`), ...critical.map((key) => `unknown:${key}`)];
  return { sufficient: gaps.length === 0, gaps };
}

export async function decideAfterExplore(
  input: TaskInput,
  current: TaskClassification,
  report: ExploreReport,
  signals: TaskSignals,
  jev: JevRunner,
): Promise<ExploreDecision> {
  const questions = postExploreQuestions();
  const evaluated = await tryEvaluate(jev, {
    task: input.text.slice(0, 4_000),
    currentStrategy: current.strategy,
    report: {
      objective: report.objective,
      checklist: report.checklist,
      facts: report.facts.map((fact) => `${fact.file}:${String(fact.range[0])}-${String(fact.range[1])} ${fact.claim}`),
      reference: report.reference,
      filesOfInterest: report.filesOfInterest,
      unknowns: report.unknowns,
    },
  }, questions);
  const choices = evaluated.accepted?.choices ?? {};
  const booleans = evaluated.accepted?.booleans ?? {};
  const strategy = (choices["strategy"]?.value as TaskStrategy | undefined) ?? current.strategy;
  const difficulty = (choices["difficulty"] === undefined ? undefined : difficultyFromChoice(choices["difficulty"].value))
    ?? (strategy === current.strategy ? current.difficulty : heuristicDifficulty(strategy, signals));
  const classification: TaskClassification = {
    strategy,
    difficulty,
    source: choices["strategy"] === undefined ? current.source : "jev",
    ...(choices["strategy"] === undefined
      ? current.confidence === undefined ? {} : { confidence: current.confidence }
      : { confidence: choices["strategy"].probability }),
  };
  // Deterministic gaps always win: Jev may only confirm sufficiency when the checklist is complete.
  const heuristic = heuristicSufficiency(strategy, report);
  const jevSufficient = booleans["sufficient"]?.value;
  const sufficient = heuristic.sufficient && jevSufficient !== false;
  const gaps = heuristic.sufficient && jevSufficient === false ? ["jev:insufficient"] : heuristic.gaps;
  const escalation = escalationFor(classification, sizeForDifficulty(difficulty), signals);
  return {
    classification,
    sufficient,
    gaps,
    ...(escalation === undefined ? {} : { escalation }),
    jev: {
      used: evaluated.accepted !== undefined,
      ...(evaluated.error === undefined ? {} : { error: evaluated.error }),
      ...(evaluated.result === undefined ? {} : { usage: evaluated.result.usage }),
    },
  };
}

// ─── Ask ladder ──────────────────────────────────────────────────────────────

export interface AskQuestion {
  readonly id: string;
  readonly question: string;
  readonly options: Readonly<Record<string, string>>;
  readonly impact: "low" | "medium" | "high";
  readonly defaultOption: string;
}

export interface AskResolution {
  readonly id: string;
  readonly resolution: "jev" | "default" | "human";
  readonly value?: string;
  readonly probability?: number;
  readonly question: string;
  readonly options: Readonly<Record<string, string>>;
}

export async function resolveAskLadder(
  questions: readonly AskQuestion[],
  context: DecisionState,
  jev: JevRunner,
  humanBudget: number,
): Promise<{ readonly resolutions: readonly AskResolution[]; readonly error?: string; readonly usage?: DecisionEngineResult["usage"] }> {
  const decisionQuestions: DecisionQuestion[] = questions.map((question) => ({
    id: question.id,
    type: "choice",
    instructions: question.question,
    criteria: question.options,
  }));
  const evaluated = await tryEvaluate(jev, context, decisionQuestions);
  const resolved = evaluated.result === undefined ? {} : acceptAnswers(evaluated.result, decisionQuestions, TASK_ASK_RESOLVE_THRESHOLD).choices;
  let remainingHuman = Math.max(0, humanBudget);
  const ranked = [...questions].sort((left, right) => impactRank(right.impact) - impactRank(left.impact));
  const byId = new Map<string, AskResolution>();
  for (const question of ranked) {
    const answer = resolved[question.id];
    if (answer !== undefined) {
      byId.set(question.id, { id: question.id, resolution: "jev", value: answer.value, probability: answer.probability, question: question.question, options: question.options });
      continue;
    }
    if (question.impact === "high" && remainingHuman > 0) {
      remainingHuman -= 1;
      byId.set(question.id, { id: question.id, resolution: "human", question: question.question, options: question.options });
      continue;
    }
    byId.set(question.id, { id: question.id, resolution: "default", value: question.defaultOption, question: question.question, options: question.options });
  }
  return {
    resolutions: questions.map((question) => byId.get(question.id)).filter((value): value is AskResolution => value !== undefined),
    ...(evaluated.error === undefined ? {} : { error: evaluated.error }),
    ...(evaluated.result === undefined ? {} : { usage: evaluated.result.usage }),
  };
}

function impactRank(impact: AskQuestion["impact"]): number {
  return impact === "high" ? 3 : impact === "medium" ? 2 : 1;
}

export function checklistFor(strategy: TaskStrategy): readonly string[] {
  return STRATEGY_CHECKLIST[strategy];
}
