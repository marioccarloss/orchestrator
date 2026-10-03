import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { DecisionEngine, DecisionEngineResult } from "./core/decision.js";
import { compactJson, sha256 } from "./core/files.js";
import type { MrPaths } from "./core/paths.js";
import { runCommand } from "./core/process.js";
import type { WorkspaceProfile } from "./core/schema.js";
import { loadAtlasGraph } from "./core/atlas.js";
import { loadWorkspaceRules } from "./core/rules/store.js";
import { rulesDigest } from "./core/rules/generator.js";
import { detectLanguage } from "./core/language.js";
import { isEngramEnabled, resolveEngramBinary, saveEngramMemory, searchEngramMemories } from "./core/engram-bridge.js";
import {
  ExecutionPlanSchema,
  ExploreReportSchema,
  TaskInputSchema,
  isDeterministicStep,
  newTaskId,
  transitionTask,
  type TaskEvent,
  type TaskState,
} from "./core/task/schema.js";
import { clearTaskState, isTaskActive, loadExecutionPlan, loadExploreReport, loadTaskState, saveExecutionPlan, saveExploreReport, saveTaskState } from "./core/task/store.js";
import { appendJournal, captureToolEvent, loadJournal, recallEntries, workspaceRelative, type JournalDraft } from "./core/task/journal.js";
import {
  MAX_HUMAN_QUESTIONS,
  MAX_JEV_QUESTIONS,
  checklistFor,
  collectTaskSignals,
  decideAfterExplore,
  decideIntake,
  jevRunner,
  resolveAskLadder,
  type JevRunner,
  type TaskSignals,
} from "./core/task/decide.js";
import { buildHandoff, compactHandoff } from "./core/task/handoff.js";
import { loadTaskEffortSync, resolveTaskRoute, type TaskEffortConfig, type TaskRoleRoute } from "./core/task/effort.js";
import { applyDeterministicSteps, planFiles, renderPlanGlance, validateExecutionPlan } from "./core/task/plan.js";
import { detectVerificationTools, floorCommands, outOfPlanFiles, runVerification, type CommandRunner } from "./core/task/verify.js";

export interface TaskToolDeps {
  readonly paths: MrPaths;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly workspace?: WorkspaceProfile;
  readonly decision: () => { readonly engine?: DecisionEngine; readonly enabled: boolean; readonly maxRetries: number; readonly timeoutMs: number };
  readonly roleOf?: (sessionID: string) => string | undefined;
  readonly runner?: CommandRunner;
  readonly gitChangedFiles?: (root: string) => readonly string[] | undefined;
  readonly engramSearch?: (query: string) => Promise<readonly { readonly title: string; readonly excerpt: string }[]>;
  readonly engramSave?: (title: string, content: string, topic: string) => Promise<void>;
}

const EXPLORE_READ_BUDGET = { none: 0, targeted: 8, broad: 25 } as const;

/** Changed paths (tracked and untracked) without mutating the index. Undefined outside git. */
export function gitStatusFiles(root: string): readonly string[] | undefined {
  const result = runCommand("git", ["-C", root, "status", "--porcelain=v1", "-uall"]);
  if (!result.ok) return undefined;
  return [...new Set(result.stdout.split(/\r?\n/u).flatMap((line) => {
    if (line.length < 4) return [];
    const path = line.slice(3).trim();
    const renamed = path.includes(" -> ") ? path.split(" -> ").at(-1) ?? path : path;
    return [renamed.replace(/^"|"$/gu, "")];
  }))].sort();
}

function agentForPhase(state: TaskState, effort: TaskEffortConfig): ({ readonly role: string } & Partial<TaskRoleRoute>) | undefined {
  const strategy = state.classification.strategy;
  if (state.phase === "explore") return { role: "explore", ...resolveTaskRoute(effort, strategy, "explore") };
  if (state.phase === "plan") return { role: "plan", ...resolveTaskRoute(effort, strategy, "plan") };
  if (state.phase === "apply") return { role: "apply", ...resolveTaskRoute(effort, strategy, "general") };
  if (state.phase === "verify") return { role: "verify", agent: "orchestrator" };
  return undefined;
}

function text(value: unknown): string {
  return compactJson(value);
}

export interface TaskTools {
  readonly tools: Readonly<Record<string, ToolDefinition>>;
  relay(input: { readonly tool: string; readonly sessionID: string; readonly args: unknown }, output: { readonly output: string; readonly metadata?: unknown }): Promise<void>;
}

export function createTaskTools(deps: TaskToolDeps): TaskTools {
  const { paths, workspaceId, workspaceRoot } = deps;
  const changedFiles = deps.gitChangedFiles ?? gitStatusFiles;
  let queue: Promise<void> = Promise.resolve();

  async function locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queue;
    let release = (): void => { /* assigned below */ };
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  function jev(taskId: string, profile: string): JevRunner {
    const config = deps.decision();
    const runner = jevRunner(config.engine, config.enabled, config);
    if (!runner.available) return runner;
    return {
      available: true,
      async evaluate(decisionState, questions): Promise<DecisionEngineResult> {
        const started = Date.now();
        try {
          const result = await runner.evaluate(decisionState, questions);
          await appendJournal(paths, workspaceId, taskId, [{
            kind: "jev",
            summary: `${profile}: ${String(questions.length)} question(s) in ${String(Date.now() - started)} ms; tokens in=${String(result.usage.inputTokens ?? 0)} out=${String(result.usage.outputTokens ?? 0)}`,
          }]);
          return result;
        } catch (error: unknown) {
          await appendJournal(paths, workspaceId, taskId, [{
            kind: "jev",
            summary: `${profile}: error after ${String(Date.now() - started)} ms: ${error instanceof Error ? error.message : String(error)}`,
          }]);
          throw error;
        }
      },
    };
  }

  async function signalsFor(state: Pick<TaskState, "input">): Promise<TaskSignals> {
    const tools = detectVerificationTools(workspaceRoot);
    const graph = await loadAtlasGraph(paths, workspaceId).catch(() => undefined);
    const rules = deps.workspace === undefined ? undefined : await loadWorkspaceRules(deps.workspace).catch(() => undefined);
    return collectTaskSignals(state.input, {
      fileExists: (file) => existsSync(join(workspaceRoot, file)),
      ...(graph === undefined ? {} : { knownSymbols: new Set(graph.nodes.map((node) => node.name)) }),
      ...(rules === undefined ? {} : {
        blockRulesFor: (files: readonly string[]) => rulesDigest(rules, undefined, files).filter((rule) => rule.severity === "block").map((rule) => rule.id),
      }),
      tools,
    });
  }

  async function rulesFor(state: TaskState, files: readonly string[]) {
    if (state.contextStrategy.rules === "skip" || deps.workspace === undefined) return [];
    const rules = await loadWorkspaceRules(deps.workspace).catch(() => undefined);
    return rules === undefined ? [] : rulesDigest(rules, undefined, files);
  }

  async function advance(state: TaskState, event: TaskEvent, journal: readonly JournalDraft[] = []): Promise<TaskState> {
    const next = transitionTask(state, event);
    await saveTaskState(paths, next);
    await appendJournal(paths, workspaceId, next.id, [
      ...journal,
      ...(next.phase === state.phase ? [] : [{ kind: "phase" as const, summary: `${state.phase} → ${next.phase} (${event.type})` }]),
    ]);
    return next;
  }

  async function active(): Promise<TaskState | undefined> {
    const state = await loadTaskState(paths, workspaceId);
    return isTaskActive(state) ? state : undefined;
  }

  function reject(title: string, reason: string, extra: Record<string, unknown> = {}): { title: string; output: string } {
    return { title, output: text({ ok: false, reason, ...extra }) };
  }

  function statusPayload(state: TaskState) {
    return {
      taskId: state.id,
      phase: state.phase,
      classification: state.classification,
      contextStrategy: state.contextStrategy,
      ...(state.escalation === undefined ? {} : { escalation: state.escalation }),
      appliedSteps: state.appliedSteps,
      verifyFailures: state.verifyFailures,
      next: agentForPhase(state, loadTaskEffortSync(paths)),
    };
  }

  function shaOf(file: string): string | undefined {
    try {
      return sha256(readFileSync(join(workspaceRoot, file)));
    } catch {
      return undefined;
    }
  }

  /** Relay: journal one harness tool call when a /task is active. Never throws. */
  async function relay(input: { readonly tool: string; readonly sessionID: string; readonly args: unknown }, output: { readonly output: string; readonly metadata?: unknown }): Promise<void> {
    try {
      if (input.tool.startsWith("mr_task_")) return;
      const state = await active();
      if (state === undefined) return;
      const role = deps.roleOf?.(input.sessionID);
      const draft = captureToolEvent(
        { tool: input.tool, args: input.args, output: output.output, metadata: output.metadata, ...(role === undefined ? {} : { role }) },
        workspaceRoot,
        shaOf,
      );
      if (draft === undefined) return;
      await locked(async () => { await appendJournal(paths, workspaceId, state.id, [draft]); });
    } catch {
      // The relay is observational; it must never break the harness.
    }
  }

  const tools: Record<string, ToolDefinition> = {
    mr_task_start: tool({
      description: "Start a fast /task: deterministic intake + Jev context strategy (how much to read, graph, memory, rules, verification). Returns the explore brief.",
      args: {
        text: tool.schema.string().min(1).max(20_000).describe("The task: one line, a detailed prompt, or the ticket/design content already fetched via MCP"),
        kind: tool.schema.enum(["oneliner", "prompt", "ticket", "design"]).optional(),
        ticketRef: tool.schema.string().max(200).optional().describe("Ticket key or URL when the task comes from Jira/GitHub/GitLab"),
        designRef: tool.schema.string().max(1_000).optional().describe("Figma URL/node or image path when the task has a design"),
        attachments: tool.schema.array(tool.schema.string().max(1_000)).max(20).optional(),
      },
      execute: async (args) => locked(async () => {
        const existing = await active();
        if (existing !== undefined) return reject("Task Rejected", "a /task is already active; finish or abort it first", { status: statusPayload(existing) });
        const kind = args.kind ?? (args.ticketRef !== undefined ? "ticket" : args.designRef !== undefined ? "design" : args.text.trim().split(/\s+/u).length <= 25 ? "oneliner" : "prompt");
        const input = TaskInputSchema.parse({
          kind,
          text: args.text,
          ...(args.ticketRef === undefined ? {} : { ticketRef: args.ticketRef }),
          ...(args.designRef === undefined ? {} : { designRef: args.designRef }),
          attachments: args.attachments ?? [],
        });
        const now = new Date().toISOString();
        const id = newTaskId();
        const signals = await signalsFor({ input });
        await appendJournal(paths, workspaceId, id, [{ kind: "input", role: "user", summary: input.text.slice(0, 380), detail: input.text.slice(0, 4_000) }]);
        const decision = await decideIntake(input, signals, jev(id, "intake"));
        const state: TaskState = {
          schemaVersion: 1,
          id,
          workspaceId,
          phase: decision.contextStrategy.read === "none" ? "plan" : "explore",
          startedAt: now,
          updatedAt: now,
          userLanguage: detectLanguage(input.text),
          input,
          contextStrategy: decision.contextStrategy,
          classification: decision.classification,
          ...(decision.escalation === undefined ? {} : { escalation: decision.escalation }),
          baselineDirtyFiles: [...(changedFiles(workspaceRoot) ?? [])],
          appliedSteps: [],
          verifyFailures: 0,
          humanQuestionsAsked: 0,
          jevQuestionsAsked: 0,
        };
        await saveTaskState(paths, state);
        const memory: JournalDraft[] = [];
        if (state.contextStrategy.engram === "prefetch" && deps.engramSearch !== undefined) {
          const hits = await deps.engramSearch(input.text.slice(0, 400)).catch(() => []);
          memory.push(...hits.slice(0, 5).map((hit) => ({ kind: "note" as const, role: "engram", summary: `memory: ${hit.title}`, detail: hit.excerpt })));
        }
        // read=none skips explore: hand the planner the explicit targets as live slices so it needs no extra round trip.
        const targets: JournalDraft[] = state.phase !== "plan" ? [] : signals.mentionedFiles.slice(0, 3).flatMap((file) => {
          try {
            const content = readFileSync(join(workspaceRoot, file), "utf8");
            const lines = Math.max(1, Math.min(400, content.split(/\r?\n/u).length));
            return [{ kind: "read" as const, role: "intake", summary: `target ${file}:1-${String(lines)}`, file, range: [1, lines] as [number, number], fileSha: sha256(content) }];
          } catch {
            return [];
          }
        });
        await appendJournal(paths, workspaceId, id, [
          ...targets,
          {
            kind: "decision",
            role: "jev",
            summary: `strategy=${state.classification.strategy} d=${String(state.classification.difficulty)} read=${state.contextStrategy.read} graph=${state.contextStrategy.graph} verify=${state.contextStrategy.verify} (${decision.jev.used ? `jev:${decision.jev.accepted.join(",") || "none"}` : "heuristic"})`,
          },
          ...memory,
          { kind: "phase", summary: `start → ${state.phase}` },
        ]);
        return {
          title: `⚡ /task ${state.classification.strategy} · d${String(state.classification.difficulty)}`,
          output: text({
            ok: true,
            ...statusPayload(state),
            jev: decision.jev,
            signals: { mentionedFiles: signals.mentionedFiles, mentionedSymbols: signals.mentionedSymbols, criticalAreas: signals.criticalAreas },
            brief: {
              objective: input.text.slice(0, 1_000),
              requiredChecklist: checklistFor(state.classification.strategy),
              maxFilesToRead: EXPLORE_READ_BUDGET[state.contextStrategy.read],
              useGraph: state.contextStrategy.graph,
              useRules: state.contextStrategy.rules,
              memoryNotes: memory.length,
            },
          }),
        };
      }),
    }),

    mr_task_status: tool({
      description: "Current /task phase, classification, context strategy and next role",
      args: {},
      execute: async () => {
        const state = await loadTaskState(paths, workspaceId);
        if (state === undefined) return { title: "/task", output: text({ active: false }) };
        const journal = await loadJournal(paths, workspaceId, state.id);
        const counts = journal.reduce<Record<string, number>>((total, entry) => ({ ...total, [entry.kind]: (total[entry.kind] ?? 0) + 1 }), {});
        return { title: `/task ${state.phase}`, output: text({ active: isTaskActive(state), ...statusPayload(state), journal: counts }) };
      },
    }),

    mr_task_record: tool({
      description: "Record knowledge that is not a tool call so the next role never loses it: facts (with file:range), decisions, DISCARDED hypotheses (and why), unknowns, notes.",
      args: {
        entries: tool.schema.array(tool.schema.object({
          kind: tool.schema.enum(["read", "fact", "decision", "discard", "unknown", "note"])
            .describe("read = pointer to a file range you inspected (hosts without the tool relay must record reads this way)"),
          summary: tool.schema.string().min(1).max(400),
          file: tool.schema.string().max(500).optional(),
          range: tool.schema.tuple([tool.schema.number().int().positive(), tool.schema.number().int().positive()]).optional(),
          detail: tool.schema.string().max(4_000).optional(),
        })).min(1).max(20),
      },
      execute: async (args, context) => locked(async () => {
        const state = await active();
        if (state === undefined) return reject("Task Record Rejected", "no active /task");
        const role = deps.roleOf?.(context.sessionID) ?? context.agent;
        const invalidReads = args.entries.filter((entry) => entry.kind === "read" && (entry.file === undefined || entry.range === undefined));
        if (invalidReads.length > 0) return reject("Task Record Rejected", "kind=read requires file and range");
        const entries = await appendJournal(paths, workspaceId, state.id, args.entries.map((entry) => {
          const file = entry.file === undefined ? undefined : workspaceRelative(workspaceRoot, entry.file);
          const fileSha = entry.kind === "read" && file !== undefined ? shaOf(file) : undefined;
          return {
            kind: entry.kind,
            role,
            summary: entry.summary,
            ...(file === undefined ? {} : { file }),
            ...(entry.range === undefined ? {} : { range: entry.range }),
            ...(fileSha === undefined ? {} : { fileSha }),
            ...(entry.detail === undefined ? {} : { detail: entry.detail }),
          };
        }));
        return { title: "Task Recorded", output: text({ ok: true, ids: entries.map((entry) => entry.id) }) };
      }),
    }),

    mr_task_explore_submit: tool({
      description: "Submit the explore report. Validates the strategy checklist, lets Jev reclassify strategy/difficulty and judge sufficiency, then hands off to the planner.",
      args: {
        objective: tool.schema.string().min(1).max(1_000),
        strategy: tool.schema.enum(["tweak", "replicate", "ui", "feature", "bugfix", "refactor"]).optional()
          .describe("Set only when the code shows the intake strategy was wrong (e.g. an existing reference makes it replicate); the checklist is then validated for this strategy"),
        checklist: tool.schema.record(tool.schema.string(), tool.schema.string().min(1).max(1_000))
          .describe("Every key of requiredChecklist with a concrete answer or 'unknown: <reason>'"),
        facts: tool.schema.array(tool.schema.object({
          claim: tool.schema.string().min(1).max(400),
          file: tool.schema.string().min(1).max(500),
          range: tool.schema.tuple([tool.schema.number().int().positive(), tool.schema.number().int().positive()]),
        })).max(40).optional(),
        reference: tool.schema.object({
          file: tool.schema.string().min(1).max(500),
          range: tool.schema.tuple([tool.schema.number().int().positive(), tool.schema.number().int().positive()]),
          why: tool.schema.string().min(1).max(300),
        }).optional().describe("Existing code that already solves the same thing (replicate strategy)"),
        filesOfInterest: tool.schema.array(tool.schema.string().min(1).max(500)).max(30).optional(),
        unknowns: tool.schema.array(tool.schema.string().min(1).max(300)).max(10).optional(),
      },
      execute: async (args) => locked(async () => {
        const state = await active();
        if (state?.phase !== "explore") return reject("Explore Rejected", `phase must be explore (current: ${state?.phase ?? "none"})`);
        const parsed = ExploreReportSchema.safeParse({
          objective: args.objective,
          checklist: args.checklist,
          facts: args.facts ?? [],
          ...(args.reference === undefined ? {} : { reference: args.reference }),
          filesOfInterest: args.filesOfInterest ?? [],
          unknowns: args.unknowns ?? [],
        });
        if (!parsed.success) return reject("Explore Rejected", "invalid report", { issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
        const report = parsed.data;
        const missingFiles = [...report.facts.map((fact) => fact.file), ...(report.reference === undefined ? [] : [report.reference.file])]
          .filter((file) => !existsSync(join(workspaceRoot, file)));
        if (missingFiles.length > 0) return reject("Explore Rejected", "facts cite files that do not exist", { missingFiles });
        const signals = await signalsFor(state);
        const proposed = args.strategy === undefined || args.strategy === state.classification.strategy
          ? state.classification
          : { ...state.classification, strategy: args.strategy, source: "heuristic" as const };
        const decision = await decideAfterExplore(state.input, proposed, report, signals, jev(state.id, "post-explore"));
        if (!decision.sufficient) {
          await appendJournal(paths, workspaceId, state.id, [{ kind: "unknown", role: "jev", summary: `report insufficient: ${decision.gaps.join(", ")}` }]);
          return reject("Explore Incomplete", "close these gaps with a targeted read, then resubmit", {
            gaps: decision.gaps,
            requiredChecklist: checklistFor(decision.classification.strategy),
            classification: decision.classification,
          });
        }
        const reportHash = await saveExploreReport(paths, state, report);
        const next = await advance(state, {
          type: "explore_submitted",
          reportHash,
          classification: decision.classification,
          ...(decision.escalation === undefined ? {} : { escalation: decision.escalation }),
        }, [{ kind: "decision", role: "jev", summary: `after explore: strategy=${decision.classification.strategy} d=${String(decision.classification.difficulty)} sufficient` }]);
        return { title: `⚡ /task plan · ${next.classification.strategy}`, output: text({ ok: true, ...statusPayload(next), jev: decision.jev }) };
      }),
    }),

    mr_task_ask: tool({
      description: "Ask ladder: up to 3 bounded choice questions. Jev resolves confident ones; high-impact unresolved ones go to the developer (max 2 per task); the rest take the default and are recorded as assumptions.",
      args: {
        questions: tool.schema.array(tool.schema.object({
          id: tool.schema.string().regex(/^[a-zA-Z][\w-]{0,40}$/u),
          question: tool.schema.string().min(5).max(400),
          options: tool.schema.record(tool.schema.string().regex(/^[\w-]{1,40}$/u), tool.schema.string().min(1).max(300)),
          impact: tool.schema.enum(["low", "medium", "high"]),
          defaultOption: tool.schema.string().min(1).max(40),
        })).min(1).max(3),
      },
      execute: async (args) => locked(async () => {
        const state = await active();
        if (state === undefined) return reject("Ask Rejected", "no active /task");
        for (const question of args.questions) {
          const count = Object.keys(question.options).length;
          if (count < 2 || count > 5) return reject("Ask Rejected", `${question.id}: provide 2-5 options`);
          if (!(question.defaultOption in question.options)) return reject("Ask Rejected", `${question.id}: defaultOption must be one of the options`);
        }
        if (state.jevQuestionsAsked + args.questions.length > MAX_JEV_QUESTIONS) return reject("Ask Rejected", "question budget exhausted; decide with the recorded assumptions");
        const report = await loadExploreReport(paths, state);
        const humanBudget = MAX_HUMAN_QUESTIONS - state.humanQuestionsAsked;
        const result = await resolveAskLadder(args.questions, {
          task: state.input.text.slice(0, 4_000),
          strategy: state.classification.strategy,
          ...(report === undefined ? {} : { checklist: report.checklist, unknowns: report.unknowns }),
        }, jev(state.id, "ask"), humanBudget);
        const human = result.resolutions.filter((resolution) => resolution.resolution === "human");
        const decided = result.resolutions.filter((resolution) => resolution.resolution !== "human");
        await appendJournal(paths, workspaceId, state.id, decided.map((resolution) => ({
          kind: "decision" as const,
          role: resolution.resolution === "jev" ? "jev" : "assumption",
          summary: `${resolution.question} → ${resolution.value ?? ""}${resolution.resolution === "default" ? " (default assumption)" : ""}`,
        })));
        await saveTaskState(paths, {
          ...state,
          updatedAt: new Date().toISOString(),
          jevQuestionsAsked: state.jevQuestionsAsked + args.questions.length,
          humanQuestionsAsked: state.humanQuestionsAsked + human.length,
        });
        return {
          title: human.length === 0 ? "Ask resolved" : `Ask: ${String(human.length)} for the developer`,
          output: text({
            ok: true,
            resolved: decided.map((resolution) => ({ id: resolution.id, value: resolution.value, by: resolution.resolution, ...(resolution.probability === undefined ? {} : { p: Number(resolution.probability.toFixed(3)) }) })),
            askHuman: human.map((resolution) => ({ id: resolution.id, question: resolution.question, options: resolution.options })),
            ...(result.error === undefined ? {} : { jevError: result.error }),
          }),
        };
      }),
    }),

    mr_task_answer: tool({
      description: "Record the developer's answer to an askHuman question from mr_task_ask",
      args: {
        id: tool.schema.string().min(1).max(41),
        question: tool.schema.string().min(1).max(400),
        answer: tool.schema.string().min(1).max(1_000),
      },
      execute: async (args) => locked(async () => {
        const state = await active();
        if (state === undefined) return reject("Answer Rejected", "no active /task");
        await appendJournal(paths, workspaceId, state.id, [{ kind: "decision", role: "developer", summary: `${args.question} → ${args.answer}`.slice(0, 400), detail: args.answer }]);
        return { title: "Answer recorded", output: text({ ok: true }) };
      }),
    }),

    mr_task_context: tool({
      description: "Lossless handoff bundle for a role: must-keep entries verbatim, Jev-selected entries, live code slices with stale flags, and a manifest of everything else (recover it with mr_task_recall).",
      args: {
        role: tool.schema.enum(["explore", "plan", "apply"]),
        stepId: tool.schema.string().regex(/^S\d+$/u).optional().describe("Required for role=apply"),
      },
      execute: async (args) => locked(async () => {
        const state = await active();
        if (state === undefined) return reject("Context Rejected", "no active /task");
        const [journal, report, plan] = await Promise.all([
          loadJournal(paths, workspaceId, state.id),
          loadExploreReport(paths, state),
          loadExecutionPlan(paths, state),
        ]);
        if (args.role === "apply" && (args.stepId === undefined || plan?.steps.some((step) => step.id === args.stepId) !== true)) {
          return reject("Context Rejected", "role=apply requires a valid stepId from the accepted plan");
        }
        const files = args.role === "apply"
          ? plan?.steps.filter((step) => step.id === args.stepId).map((step) => step.file) ?? []
          : report?.filesOfInterest ?? [];
        const bundle = await buildHandoff({
          role: args.role,
          state,
          journal,
          workspaceRoot,
          ...(report === undefined ? {} : { report }),
          ...(plan === undefined ? {} : { plan }),
          ...(args.stepId === undefined ? {} : { stepId: args.stepId }),
          rules: await rulesFor(state, files),
          jev: jev(state.id, `handoff:${args.role}`),
        });
        return { title: `Handoff → ${args.role}`, output: text(compactHandoff(bundle)) };
      }),
    }),

    mr_task_recall: tool({
      description: "Recover full journal entries listed in a handoff manifest; reads are re-read from disk and flagged stale if the file changed",
      args: { ids: tool.schema.array(tool.schema.string().regex(/^J\d+$/u)).min(1).max(30) },
      execute: async (args) => {
        const state = await loadTaskState(paths, workspaceId);
        if (state === undefined) return reject("Recall Rejected", "no /task");
        const journal = await loadJournal(paths, workspaceId, state.id);
        return { title: "Recall", output: text(await recallEntries(journal, args.ids, workspaceRoot)) };
      },
    }),

    mr_task_plan_submit: tool({
      description: "Submit the ExecutionPlan. Steps with exact `code` are applied by the plugin without a model; steps with only `intent` go to mr-task-apply. Anchors must be copied exactly and be unique.",
      args: {
        summary: tool.schema.string().min(1).max(1_000),
        strategy: tool.schema.enum(["tweak", "replicate", "ui", "feature", "bugfix", "refactor"]),
        difficulty: tool.schema.union([tool.schema.literal(1), tool.schema.literal(2), tool.schema.literal(3), tool.schema.literal(5), tool.schema.literal(8), tool.schema.literal(13)]),
        assumptions: tool.schema.array(tool.schema.string().min(1).max(300)).max(10).optional(),
        steps: tool.schema.array(tool.schema.object({
          id: tool.schema.string().regex(/^S\d+$/u),
          file: tool.schema.string().min(1).max(500),
          op: tool.schema.enum(["replace", "insertAfter", "insertBefore", "create", "deleteFile"]),
          anchor: tool.schema.object({
            snippet: tool.schema.string().min(1).max(4_000),
            fileSha: tool.schema.string().regex(/^[a-f0-9]{64}$/u).optional(),
          }).optional(),
          code: tool.schema.string().max(40_000).optional(),
          intent: tool.schema.string().min(20).max(2_000).optional(),
          reference: tool.schema.object({
            file: tool.schema.string().min(1).max(500),
            lines: tool.schema.tuple([tool.schema.number().int().positive(), tool.schema.number().int().positive()]),
          }).optional(),
          mustNotTouch: tool.schema.array(tool.schema.string().min(1).max(300)).max(10).optional(),
          dependsOn: tool.schema.array(tool.schema.string().regex(/^S\d+$/u)).max(20).optional(),
        })).min(1).max(40),
        verification: tool.schema.array(tool.schema.string().min(1).max(300)).max(10).optional(),
      },
      execute: async (args) => locked(async () => {
        const state = await active();
        if (state?.phase !== "plan") return reject("Plan Rejected", `phase must be plan (current: ${state?.phase ?? "none"})`);
        const parsed = ExecutionPlanSchema.safeParse({
          ...args,
          assumptions: args.assumptions ?? [],
          verification: args.verification ?? [],
          steps: args.steps.map((step) => ({ ...step, mustNotTouch: step.mustNotTouch ?? [], dependsOn: step.dependsOn ?? [] })),
        });
        if (!parsed.success) return reject("Plan Rejected", "invalid plan", { issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) });
        const tools = detectVerificationTools(workspaceRoot);
        const issues = await validateExecutionPlan(parsed.data, workspaceRoot, new Set(tools.allScripts));
        if (issues.length > 0) return reject("Plan Rejected", "fix exactly these issues and resubmit", { issues });
        const planHash = await saveExecutionPlan(paths, state, parsed.data);
        const next = await advance(state, {
          type: "plan_accepted",
          planHash,
          classification: { ...state.classification, strategy: parsed.data.strategy, difficulty: parsed.data.difficulty },
        }, parsed.data.assumptions.map((assumption) => ({ kind: "decision" as const, role: "plan", summary: `assumption: ${assumption}` })));
        const deterministic = parsed.data.steps.filter(isDeterministicStep).map((step) => step.id);
        const model = parsed.data.steps.filter((step) => !isDeterministicStep(step)).map((step) => step.id);
        return {
          title: `⚡ /task plan accepted · ${String(parsed.data.steps.length)} step(s)`,
          output: text({ ok: true, ...statusPayload(next), glance: renderPlanGlance(parsed.data), deterministicSteps: deterministic, modelSteps: model }),
        };
      }),
    }),

    mr_task_apply: tool({
      description: "Apply every ready deterministic plan step (exact code) without a model. Returns the model steps that still need mr-task-apply.",
      args: {},
      execute: async () => locked(async () => {
        const state = await active();
        if (state?.phase !== "apply") return reject("Apply Rejected", `phase must be apply (current: ${state?.phase ?? "none"})`);
        const plan = await loadExecutionPlan(paths, state);
        if (plan === undefined) return reject("Apply Rejected", "accepted plan not found");
        const outcome = await applyDeterministicSteps(plan, workspaceRoot, state.appliedSteps);
        let next = state;
        for (const stepId of outcome.applied) {
          const step = plan.steps.find((candidate) => candidate.id === stepId);
          next = await advance(next, { type: "step_applied", stepId }, [{ kind: "edit", role: "relay", summary: `auto-applied ${stepId} ${step?.op ?? ""} ${step?.file ?? ""}`, ...(step === undefined ? {} : { file: step.file }) }]);
        }
        if (outcome.failed.length > 0) {
          await appendJournal(paths, workspaceId, state.id, outcome.failed.map((issue) => ({ kind: "error" as const, role: "relay", summary: `${issue.step ?? ""} ${issue.message}` })));
        }
        if (next.appliedSteps.length === plan.steps.length) next = await advance(next, { type: "apply_complete" });
        return {
          title: `/task apply · ${String(outcome.applied.length)} auto`,
          output: text({ ok: outcome.failed.length === 0, applied: outcome.applied, failed: outcome.failed, pendingModelSteps: outcome.pendingModelSteps, phase: next.phase }),
        };
      }),
    }),

    mr_task_step_done: tool({
      description: "mr-task-apply marks one model step as done after editing exactly that step",
      args: { stepId: tool.schema.string().regex(/^S\d+$/u), note: tool.schema.string().max(400).optional() },
      execute: async (args, context) => locked(async () => {
        const state = await active();
        if (state?.phase !== "apply") return reject("Step Rejected", `phase must be apply (current: ${state?.phase ?? "none"})`);
        const plan = await loadExecutionPlan(paths, state);
        const step = plan?.steps.find((candidate) => candidate.id === args.stepId);
        if (plan === undefined || step === undefined) return reject("Step Rejected", `unknown step ${args.stepId}`);
        if (isDeterministicStep(step)) return reject("Step Rejected", "deterministic steps are applied by mr_task_apply");
        const missing = step.dependsOn.filter((dependency) => !state.appliedSteps.includes(dependency));
        if (missing.length > 0) return reject("Step Rejected", `dependencies not applied: ${missing.join(", ")}`);
        const changed = changedFiles(workspaceRoot);
        if (changed !== undefined && !changed.includes(step.file)) return reject("Step Rejected", `${step.file} shows no change in git status`);
        let next = await advance(state, { type: "step_applied", stepId: step.id }, [{
          kind: "edit",
          role: deps.roleOf?.(context.sessionID) ?? context.agent,
          summary: `model-applied ${step.id} ${step.op} ${step.file}${args.note === undefined ? "" : `: ${args.note}`}`,
          file: step.file,
        }]);
        const followUp = await applyDeterministicSteps(plan, workspaceRoot, next.appliedSteps);
        for (const stepId of followUp.applied) next = await advance(next, { type: "step_applied", stepId });
        if (next.appliedSteps.length === plan.steps.length) next = await advance(next, { type: "apply_complete" });
        return { title: `Step ${step.id} done`, output: text({ ok: true, autoApplied: followUp.applied, failed: followUp.failed, pendingModelSteps: followUp.pendingModelSteps, phase: next.phase }) };
      }),
    }),

    mr_task_verify: tool({
      description: "Run plan + floor verification (lint/format scoped to touched files, typecheck, tests per Jev tier) without a shell, and check the diff only touches planned files",
      args: {},
      execute: async () => locked(async () => {
        let state = await active();
        if (state === undefined) return reject("Verify Rejected", "no active /task");
        const plan = await loadExecutionPlan(paths, state);
        if (plan === undefined) return reject("Verify Rejected", "accepted plan not found");
        if (state.phase === "apply") {
          if (state.appliedSteps.length !== plan.steps.length) {
            return reject("Verify Rejected", "apply every step first", { pending: plan.steps.filter((step) => !state?.appliedSteps.includes(step.id)).map((step) => step.id) });
          }
          state = await advance(state, { type: "apply_complete" });
        }
        if (state.phase !== "verify") return reject("Verify Rejected", `phase must be verify (current: ${state.phase})`);
        const tools = detectVerificationTools(workspaceRoot);
        const changed = changedFiles(workspaceRoot);
        const planned = planFiles(plan);
        const touched = changed === undefined
          ? planned.filter((file) => existsSync(join(workspaceRoot, file)))
          : changed.filter((file) => !state?.baselineDirtyFiles.includes(file) || planned.includes(file)).filter((file) => existsSync(join(workspaceRoot, file)));
        const commands = [
          ...floorCommands(state.contextStrategy.verify, tools, touched, plan.verification).map((command) => ({ command, origin: "floor" as const })),
          ...plan.verification.map((command) => ({ command, origin: "plan" as const })),
        ];
        const receipts = await runVerification(commands, workspaceRoot, new Set(tools.allScripts), deps.runner);
        const outOfPlan = changed === undefined ? [] : outOfPlanFiles(changed, planned, state.baselineDirtyFiles);
        const ok = receipts.every((receipt) => receipt.ok) && outOfPlan.length === 0;
        const result = { ok, receipts: [...receipts], outOfPlanFiles: [...outOfPlan], at: new Date().toISOString() };
        const journal: JournalDraft[] = [
          ...receipts.map((receipt) => ({
            kind: "command" as const,
            role: "verify",
            summary: `$ ${receipt.command} → ${receipt.exitCode === null ? "no exit" : `exit ${String(receipt.exitCode)}`}`,
            failed: !receipt.ok,
            ...(receipt.ok ? {} : { detail: receipt.outputTail }),
          })),
          ...(outOfPlan.length === 0 ? [] : [{ kind: "error" as const, role: "verify", summary: `diff touches files outside the plan: ${outOfPlan.join(", ")}` }]),
        ];
        const next = await advance(state, ok ? { type: "verify_passed", result } : { type: "verify_failed", result }, journal);
        return {
          title: ok ? "✅ /task verified" : `❌ /task verify failed (${String(next.verifyFailures)})`,
          output: text({
            ok,
            phase: next.phase,
            receipts: receipts.map((receipt) => ({ command: receipt.command, ok: receipt.ok, exitCode: receipt.exitCode, ms: receipt.durationMs, ...(receipt.ok ? {} : { tail: receipt.outputTail.slice(-1_500) }) })),
            outOfPlanFiles: outOfPlan,
            next: ok ? "mr_task_finish" : next.phase === "plan" ? "replan: mr-task-plan with mr_task_context role=plan" : "fix with mr-task-apply, then mr_task_verify",
          }),
        };
      }),
    }),

    mr_task_replan: tool({
      description: "Send the task back to the planner with a failure capsule (the reason is journaled as a must-keep error)",
      args: { reason: tool.schema.string().min(5).max(1_000) },
      execute: async (args) => locked(async () => {
        const state = await active();
        if (state === undefined || (state.phase !== "apply" && state.phase !== "verify")) return reject("Replan Rejected", "replan is only possible during apply or verify");
        const next = await advance(state, { type: "replan" }, [{ kind: "error", role: "orchestrator", summary: `replan: ${args.reason}`.slice(0, 400), detail: args.reason }]);
        return { title: "/task replan", output: text({ ok: true, ...statusPayload(next) }) };
      }),
    }),

    mr_task_finish: tool({
      description: "Close a verified /task, store a compact Engram memory (best-effort) and clear the active pointer. Does not commit, push or open PRs.",
      args: { summary: tool.schema.string().max(1_000).optional() },
      execute: async (args) => locked(async () => {
        const state = await loadTaskState(paths, workspaceId);
        if (state?.phase !== "done") return reject("Finish Rejected", `phase must be done (current: ${state?.phase ?? "none"}); run mr_task_verify first`);
        const plan = await loadExecutionPlan(paths, state);
        const journal = await loadJournal(paths, workspaceId, state.id);
        const discards = journal.filter((entry) => entry.kind === "discard").map((entry) => entry.summary).slice(0, 5);
        const decisions = journal.filter((entry) => entry.kind === "decision" && entry.role !== "jev").map((entry) => entry.summary).slice(0, 5);
        const content = [
          `**What**: ${args.summary ?? plan?.summary ?? state.input.text.slice(0, 300)}`,
          `**Why**: /task ${state.classification.strategy} d${String(state.classification.difficulty)}`,
          `**Where**: ${(plan === undefined ? [] : planFiles(plan)).join(", ")}`,
          ...(decisions.length === 0 && discards.length === 0 ? [] : [`**Learned**: ${[...decisions, ...discards.map((item) => `discarded ${item}`)].join("; ")}`]),
        ].join("\n");
        if (deps.engramSave !== undefined) await deps.engramSave(`Task: ${(plan?.summary ?? state.input.text).slice(0, 80)}`, content, `task/${state.id}`).catch(() => undefined);
        await clearTaskState(paths, workspaceId);
        const jevCalls = journal.filter((entry) => entry.kind === "jev").length;
        return {
          title: "✅ /task done",
          output: text({
            ok: true,
            taskId: state.id,
            files: plan === undefined ? [] : planFiles(plan),
            verification: state.lastVerification?.receipts.map((receipt) => `${receipt.ok ? "✓" : "✗"} ${receipt.command}`) ?? [],
            jevCalls,
            humanQuestions: state.humanQuestionsAsked,
          }),
        };
      }),
    }),

    mr_task_abort: tool({
      description: "Abort the active /task and clear it (journal kept for audit). Does not revert file changes.",
      args: {},
      execute: async () => locked(async () => {
        const state = await active();
        if (state === undefined) return reject("Abort Rejected", "no active /task");
        await advance(state, { type: "abort" });
        await clearTaskState(paths, workspaceId);
        return { title: "/task aborted", output: text({ ok: true, taskId: state.id }) };
      }),
    }),
  };

  return { tools, relay };
}

export async function defaultEngramPorts(paths: MrPaths, workspaceRoot: string): Promise<Pick<TaskToolDeps, "engramSearch" | "engramSave">> {
  if (!await isEngramEnabled(paths).catch(() => false)) return {};
  const binary = await resolveEngramBinary(paths).catch(() => undefined);
  if (binary === undefined) return {};
  return {
    engramSearch: async (query) => searchEngramMemories(binary, query, { cwd: workspaceRoot, limit: 5 }),
    engramSave: async (title, content, topic) => {
      await saveEngramMemory(binary, title, content, { cwd: workspaceRoot, topic, type: "decision" });
    },
  };
}
