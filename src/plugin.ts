import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import { loadFlowState, clearFlowState, applyEvent } from "./core/flow-state.js";
import { loadRegistry, detectWorkspace } from "./core/workspace.js";
import { resolvePaths } from "./core/paths.js";
import { buildTaskDeveloperNote, messagesFor, renderCoverageReceipt, renderFlowStatus, renderFlowUsage, renderIntentAssessment, renderIntentExplanation, renderPlanExplanation, renderVerdict, renderWorkspaceMap } from "./core/render.js";
import { loadModels } from "./core/config.js";
import { buildModelCandidates, discoverAvailableModels, formatModelTarget, loadEffectiveModels, promoteAlternativeModel, refreshHarnessCatalog, resetHarnessModels, ROLES, setHarnessModelRole, setModelRole, type ModelRole } from "./core/models.js";
import { harnessCatalogPath, loadHarnessCatalog, parseHarnessId, writeEffectiveHarnessModels } from "./core/harness-models.js";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { implementationAgentForDifficulty, JudgeFindingsSchema, JudgeVerdictSchema, requiresJudgment, type FlowState, type FlowEvent, type PlanCapsule, type TicketContent } from "./core/flow-schema.js";
import { getDiffHash, getFullDiff, mergeVerdicts, validateJudgeFindings } from "./core/judgment.js";
import { canonicalJson, compactJson, sha256 } from "./core/files.js";
import {
  AtlasIndexer,
  saveAtlasGraph,
  findNodeByName,
  findNodesByKind,
  getNodeDependencies,
  getNodeDependents,
  getImpactAnalysis,
  loadGovernanceConfig,
  checkGovernance,
  extractSkeleton,
  extractNodeSlice,
  findTestsFor,
  validateAstSyntax,
  withAtlasEdges,
  type AtlasGraph,
} from "./core/atlas.js";
import { getOrIndexAtlas } from "./core/atlas-service.js";
import { addEvidence, checkEvidenceFreshness, listEvidence, loadEvidenceStore, readEvidenceSlice, EvidenceKindSchema, StoredEvidenceSourceSchema, type EvidenceStore, type FreshnessResult } from "./core/evidence-store.js";
import { gateAfterImplement, gateBeforeImplement, gateBeforeJudgment, gatePlan, gateRepositoryRules, gatesMode, renderGateResult, shouldBlockGate, type GateResult } from "./core/gates.js";
import { getGitDiffFiles, getGitDiffNames, loadVerificationReceipt, saveVerificationReceipt, VerificationReceiptSchema } from "./core/verification.js";
import { hydrateContext, serializeBundle, type ContextBundle, type HydrationRole } from "./core/context-hydrator.js";
import { loadRepositoryProfiles, loadWorkspaceRules } from "./core/rules/store.js";
import { ruleInvariants, rulesDigest } from "./core/rules/generator.js";
import { assessRiskLane, type RiskLane } from "./core/risk.js";
import { createTicketAdapter, nextLocalTicketId } from "./core/ticket.js";
import { createProjectService, resolveTypeScriptCallEdges } from "./core/semantic/typescript.js";
import { applyPhpSemanticResult, inspectPhpSemantics } from "./core/semantic/php.js";
import {
  ResearchCapsulePayloadInputSchema,
  PlanningAssessmentPayloadSchema,
  SpecCapsulePayloadSchema,
  TaskGraphPayloadInputSchema,
  validateSddArtifacts,
  nextPendingTask,
  markTaskStatus,
  saveSddArtifact,
  loadResearch,
  loadIntentBrief,
  loadIntentAssessment,
  loadIntentCapsule,
  loadPlanningBrief,
  loadSpec,
  loadTasks,
  formatZodIssues,
  canonicalSddPayload,
  migrateResearchToV2,
  migrateTaskGraphToV2,
  type SddTask,
  type SddKind,
} from "./core/sdd-schema.js";
import {
  IntentAssessmentPayloadSchema,
} from "./core/intent-schema.js";
import { validateIntentApproval } from "./core/intent-gates.js";
import { runIntentSweeps, type IntentResolveInput } from "./core/intent-resolver.js";
import {
  renderResearchCapsule,
  renderSpecCapsule,
  renderTaskGraph,
  renderSddIssues,
} from "./core/render.js";
import {
  traceComponent,
  renderTraceReport,
  saveProposal,
  buildPrompt,
  copyToClipboard,
  type ProposalInput,
} from "./core/tools.js";
import {
  BlueprintSpecSchema,
  saveBlueprintSpec,
  renderBlueprintExecutiveSummary,
  BlueprintMutationSchema,
  renderSafetyGateDiff,
} from "./core/blueprint-schema.js";
import { classifyQuotaError, resolveModelRole } from "./core/quota.js";
import { PersistentMemoryStore } from "./core/memory-store.js";
import {
  buildFlowCompletionMemory,
  buildFlowMemoryQuery,
  loadFlowEngramPrefetch,
  persistFlowCompletionMemory,
  renderFlowEngramPrefetch,
  warmFlowContext,
} from "./core/engram-bridge.js";
import { InsufficientEvidenceSchema } from "./core/grounding.js";
import { InternalExecutionReceiptSchema, serializeInternalExecutionReceipt } from "./core/internal-receipt.js";
import {
  bindChildFlowSession,
  bindFlowSession,
  finalizeFlowMetrics,
  loadFlowMetrics,
  recordContextHydration,
  recordFlowAssistantUsage,
  startFlowMetrics,
  summarizeFlowMetrics,
} from "./core/flow-metrics.js";
import { detectLanguage, normalizeUserLanguage, type UserLanguage } from "./core/language.js";
import { flowEconomyPolicy } from "./core/budgets.js";

interface PluginMessages {
  readonly noActiveFlow: string;
  readonly lastFlow: string;
  readonly startRejected: string;
  readonly implementationJudgment: string;
  readonly implementationFast: string;
  readonly verdictRecorded: string;
  readonly humanReviewRequired: string;
  readonly flowAborted: string;
}

const PLUGIN_MESSAGES = {
  es: { noActiveFlow: "No hay un flujo activo. Ejecuta `/flow` para comenzar.", lastFlow: "Último flujo", startRejected: "Proporciona ticketId o un taskText no vacío.", implementationJudgment: "Implementación completa. Se inició la fase de juicio adversarial determinista.", implementationFast: "Implementación completa. El carril rápido omite el Día del Juicio.", verdictRecorded: "Veredicto registrado. Esperando al otro juez sobre el mismo diff.", humanReviewRequired: "El carril de riesgo crítico requiere aprobación humana explícita antes de finalizar. Repite con humanApproved=true después de la revisión.", flowAborted: "El flujo fue abortado y su estado se eliminó." },
  en: { noActiveFlow: "No active flow. Run `/flow` to start.", lastFlow: "Last flow", startRejected: "Provide ticketId or non-empty taskText.", implementationJudgment: "Implementation complete. The deterministic adversarial judgment phase has started.", implementationFast: "Implementation complete. The fast lane skips Judgment Day.", verdictRecorded: "Verdict recorded. Waiting for the other judge on the same diff.", humanReviewRequired: "The critical risk lane requires explicit human approval before finish. Re-run with humanApproved=true after review.", flowAborted: "The flow was aborted and its state was cleared." },
  pt: { noActiveFlow: "Não há fluxo ativo. Execute `/flow` para começar.", lastFlow: "Último fluxo", startRejected: "Forneça ticketId ou um taskText não vazio.", implementationJudgment: "Implementação concluída. A fase de julgamento adversarial determinístico foi iniciada.", implementationFast: "Implementação concluída. A faixa rápida ignora o Dia do Julgamento.", verdictRecorded: "Veredito registrado. Aguardando o outro juiz no mesmo diff.", humanReviewRequired: "A faixa de risco crítico exige aprovação humana explícita antes da conclusão. Execute novamente com humanApproved=true após a revisão.", flowAborted: "O fluxo foi abortado e seu estado foi removido." },
  ca: { noActiveFlow: "No hi ha cap flux actiu. Executa `/flow` per començar.", lastFlow: "Últim flux", startRejected: "Proporciona ticketId o un taskText no buit.", implementationJudgment: "Implementació completada. S'ha iniciat la fase de judici adversarial determinista.", implementationFast: "Implementació completada. El carril ràpid omet el Dia del Judici.", verdictRecorded: "Veredicte registrat. Esperant l'altre jutge sobre el mateix diff.", humanReviewRequired: "El carril de risc crític requereix aprovació humana explícita abans de finalitzar. Torna-ho a executar amb humanApproved=true després de la revisió.", flowAborted: "El flux s'ha avortat i se n'ha eliminat l'estat." },
  fr: { noActiveFlow: "Aucun flux actif. Exécutez `/flow` pour commencer.", lastFlow: "Dernier flux", startRejected: "Fournissez ticketId ou un taskText non vide.", implementationJudgment: "Implémentation terminée. La phase de jugement contradictoire déterministe a commencé.", implementationFast: "Implémentation terminée. Le parcours rapide omet le Jour du Jugement.", verdictRecorded: "Verdict enregistré. En attente de l'autre juge sur le même diff.", humanReviewRequired: "Le niveau de risque critique exige une approbation humaine explicite avant la fin. Relancez avec humanApproved=true après la revue.", flowAborted: "Le flux a été interrompu et son état a été effacé." },
} satisfies Record<UserLanguage, PluginMessages>;

// ─── Plugin ──────────────────────────────────────────────────────────────────

export async function createMrOrchestrator(
  ctx: PluginInput,
  paths = resolvePaths(),
): Promise<Awaited<ReturnType<Plugin>>> {
  const registry = await loadRegistry(paths);
  const workspace = detectWorkspace(registry, ctx.directory);
  const workspaceId = workspace?.id ?? "unknown";
  const workspaceRoot = workspace?.root ?? ctx.directory;
  const activeHarness = parseHarnessId(process.env["MR_HARNESS_ID"]);
  const persistedFlow = await loadFlowState(paths, workspaceId);
  let outputLanguage = normalizeUserLanguage(persistedFlow?.userLanguage);
  const sessionModels = new Map<string, { readonly role: ModelRole; readonly model: string }>();
  const atlasFreshness = new WeakMap<AtlasGraph, boolean>();
  let judgmentWriteQueue: Promise<void> = Promise.resolve();
  let usageWriteQueue: Promise<void> = Promise.resolve();

  async function withJudgmentWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = judgmentWriteQueue;
    let release = (): void => { /* assigned synchronously below */ };
    judgmentWriteQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async function withUsageWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = usageWriteQueue;
    let release = (): void => { /* assigned synchronously below */ };
    usageWriteQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  function flowTicketId(state: FlowState): string {
    if ("ticket" in state) return state.ticket.ref.id;
    if ("ticketId" in state) return state.ticketId;
    return "pending";
  }

  function effectiveLane(state: FlowState | undefined): RiskLane {
    if (state?.lane !== undefined) return state.lane;
    if (state === undefined || !("difficulty" in state)) return "full";
    if (state.difficulty >= 5) return "full";
    return "ticket" in state && state.ticket.ref.platform === "local" ? "fast" : "standard";
  }

  function toolSessionID(context: { readonly sessionID: string } | undefined): string {
    return context?.sessionID ?? "external-client";
  }

  async function ensureFlowUsage(state: FlowState, sessionID: string): Promise<void> {
    await withUsageWriteLock(async () => {
      const current = await loadFlowMetrics(paths, workspaceId);
      if (current === undefined || current.flowStartedAt !== state.startedAt) {
        await startFlowMetrics(paths, workspaceId, flowTicketId(state), state.startedAt, sessionID, state.userLanguage);
        return;
      }
      await bindFlowSession(paths, workspaceId, sessionID, state.userLanguage);
    });
  }

  async function renderStatus(state: FlowState, sessionID: string, completed = false): Promise<string> {
    outputLanguage = normalizeUserLanguage(state.userLanguage, outputLanguage);
    await ensureFlowUsage(state, sessionID);
    const metrics = await loadFlowMetrics(paths, workspaceId);
    return renderFlowStatus(state, metrics === undefined ? undefined : summarizeFlowMetrics(metrics), { completed, language: outputLanguage });
  }

  async function ensureFlowState(): Promise<FlowState> {
    const state = await loadFlowState(paths, workspaceId);
    if (state === undefined) {
      throw new Error("No active flow. Run `/flow` to start.");
    }
    outputLanguage = normalizeUserLanguage(state.userLanguage, outputLanguage);
    return state;
  }

  async function getOrIndexGraph(): Promise<AtlasGraph> {
    const result = await getOrIndexAtlas(paths, workspaceId, workspaceRoot);
    atlasFreshness.set(result.graph, result.fresh);
    return result.graph;
  }

  async function resolveAndPersistIntent(ticket: TicketContent, difficulty?: number, llmDraft?: IntentResolveInput["llmDraft"]): Promise<{ output: string; assessment: ReturnType<typeof runIntentSweeps>["assessment"] }> {
    const prefetch = await loadFlowEngramPrefetch(paths, workspaceId);
    const engramHits = prefetch?.ticketId === ticket.ref.id ? prefetch.hits : [];
    const graph = await getOrIndexGraph();
    const result = runIntentSweeps({
      ticket,
      engramHits,
      atlasGraph: graph,
      ...(difficulty === undefined ? {} : { difficulty }),
      ...(llmDraft === undefined ? {} : { llmDraft }),
    });
    if (result.assessment.status !== "NEEDS_INPUT") {
      await saveSddArtifact(paths, workspaceId, "intent", result.assessment);
    }
    const headline = result.assessment.status === "READY"
      ? `Intent auto-ready (${result.assessment.mode}). Confirm with mr_flow_intent.`
      : result.assessment.status === "PROPOSED"
        ? "Intent draft proposed after sweeps S0–S4. Review sources and assumptions, then confirm."
        : "Intent resolution blocked after sweeps S0–S4. Human clarification is exceptional — answer the suggested defaults.";
    return {
      assessment: result.assessment,
      output: `${headline}\n\n${renderIntentAssessment(result.assessment, result.sweepLog, outputLanguage)}`,
    };
  }

  async function warmTicketContext(ticketId: string, title: string, description: string, extra?: string): Promise<string> {
    try {
      const prefetch = await warmFlowContext({
        paths,
        workspaceId,
        workspaceRoot,
        ticketId,
        query: buildFlowMemoryQuery(title, description, extra),
        indexAtlas: async () => {
          const result = await getOrIndexAtlas(paths, workspaceId, workspaceRoot);
          atlasFreshness.set(result.graph, result.fresh);
          return { reindexed: result.reindexed };
        },
      });
      return renderFlowEngramPrefetch(prefetch);
    } catch (error: unknown) {
      return `Flow warm-up skipped: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function getTaskEvidenceFreshness(
    task: SddTask,
    store: EvidenceStore,
    graph: AtlasGraph,
  ): Promise<ReadonlyMap<string, FreshnessResult>> {
    return new Map(await Promise.all(task.evidenceRefs.map(async (refId) => {
      const ref = store.refs.find((candidate) => candidate.id === refId);
      const freshness: FreshnessResult = ref === undefined
        ? { status: "stale", reason: "file-missing" }
        : await checkEvidenceFreshness(workspaceRoot, ref, graph);
      return [refId, freshness] as const;
    })));
  }

  function withCoverage(graph: AtlasGraph, output: string, files?: readonly string[]): string {
    return `${output}\n\n${renderCoverageReceipt(graph, atlasFreshness.get(graph) ?? false, files === undefined ? {} : { files }, outputLanguage)}`;
  }

  async function hydrateFor(role: HydrationRole, taskId?: string, budgetChars?: number, sessionID?: string): Promise<ContextBundle> {
    const research = await loadResearch(paths, workspaceId);
    if (research === undefined) throw new Error("No research capsule found.");
    const store = await loadEvidenceStore(paths, workspaceId, research.ticketId);
    if (store === undefined) throw new Error("No EvidenceStore found for the active research capsule.");
    const [graph, spec, tasks, flow] = await Promise.all([getOrIndexGraph(), loadSpec(paths, workspaceId), loadTasks(paths, workspaceId), loadFlowState(paths, workspaceId)]);
    if (flow !== undefined) {
      outputLanguage = normalizeUserLanguage(flow.userLanguage, outputLanguage);
      await ensureFlowUsage(flow, sessionID ?? "external-client");
    }
    const lane = effectiveLane(flow);
    const workspaceRules = workspace === undefined ? undefined : await loadWorkspaceRules(workspace);
    const task = taskId === undefined ? undefined : tasks?.tasks.find((candidate) => candidate.id === taskId);
    const firstPath = task?.files[0]?.path;
    const repo = firstPath?.startsWith("repos/") === true ? firstPath.split("/")[1] : workspace?.name;
    let findings;
    if (role === "fix") {
      const verdictDir = join(paths.generatedRoot, workspaceId);
      const [verdictA, verdictB] = await Promise.all([
        readFile(join(verdictDir, "verdict-a.json"), "utf8").then((content) => JudgeVerdictSchema.parse(JSON.parse(content) as unknown)).catch(() => undefined),
        readFile(join(verdictDir, "verdict-b.json"), "utf8").then((content) => JudgeVerdictSchema.parse(JSON.parse(content) as unknown)).catch(() => undefined),
      ]);
      if (verdictA !== undefined && verdictB !== undefined) findings = mergeVerdicts(verdictA, verdictB).findings;
    }
    const engramPrefetch = await loadFlowEngramPrefetch(paths, workspaceId);
    const memoryContext = engramPrefetch?.ticketId === research.ticketId ? engramPrefetch.hits : undefined;
    const bundle = await hydrateContext({
      role, lane, ticketId: research.ticketId, research, store, graph,
      readSlice: (ref) => readEvidenceSlice(paths, workspaceId, research.ticketId, ref),
      checkFreshness: (ref) => checkEvidenceFreshness(workspaceRoot, ref, graph),
      ...(spec === undefined ? {} : { spec }),
      ...(tasks === undefined ? {} : { tasks }),
      ...(taskId === undefined ? {} : { taskId }),
      ...(budgetChars === undefined ? {} : { budgetChars }),
      ...(workspaceRules === undefined ? {} : { rules: rulesDigest(workspaceRules, repo, task?.files.map((file) => file.path) ?? []) }),
      ...(findings === undefined ? {} : { findings }),
      ...(memoryContext === undefined ? {} : { memoryContext }),
      ...(role !== "fix" ? {} : {
        readLiveRange: async (file: string, startLine: number, endLine: number) => {
          try {
            const content = await readFile(join(workspaceRoot, file), "utf8");
            return content.split(/\r?\n/u).slice(startLine - 1, endLine).join("\n");
          } catch {
            return undefined;
          }
        },
      }),
    });
    if (flow !== undefined && flow.phase !== "finish") {
      await withUsageWriteLock(async () => recordContextHydration(paths, workspaceId, {
        role,
        lane,
        requestedChars: bundle.budget.requestedChars,
        usedChars: bundle.budget.usedChars,
        truncated: bundle.budget.truncated.length,
        ...(taskId === undefined ? {} : { taskId }),
      }));
    }
    return bundle;
  }

  async function rulesGateForCurrentDiff(): Promise<GateResult> {
    if (workspace === undefined) return { ok: true, violations: [] };
    const rules = await loadWorkspaceRules(workspace);
    if (rules === undefined) return { ok: true, violations: [] };
    const changed = await Promise.all(getGitDiffFiles(workspaceRoot).map(async (file) => {
      if (file.action === "delete") return file;
      const content = await readFile(join(workspaceRoot, file.path), "utf8").catch(() => undefined);
      return content === undefined ? file : { ...file, content };
    }));
    const violations = rules.repositories.flatMap((repository) => {
      const scoped = changed.filter((file) => {
        const nested = /^(?:repos|apps|packages)\/([^/]+)\//u.exec(file.path)?.[1];
        return nested === undefined ? repository.repo === workspace.name : nested === repository.repo;
      });
      return gateRepositoryRules(repository.rules, scoped).violations;
    });
    return { ok: !violations.some((violation) => violation.severity === "block"), violations };
  }

  async function writeSddMarkdown(kind: Exclude<SddKind, "brief" | "intent">, ticketId: string, markdown: string): Promise<string> {
    const dir = workspace?.root !== undefined
      ? join(workspace.root, ".aicontext", "deliverables", "mr", "sdd")
      : join(paths.dataRoot, workspaceId, "sdd");
    await mkdir(dir, { recursive: true });
    const safeTicket = ticketId.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
    const filePath = join(dir, `${safeTicket}-${kind}.md`);
    await writeFile(filePath, markdown);
    return filePath;
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created") {
        const parentID = event.properties.info.parentID;
        if (parentID !== undefined) {
          await withUsageWriteLock(async () => bindChildFlowSession(paths, workspaceId, parentID, event.properties.info.id));
        }
        return;
      }
      if (event.type === "message.updated") {
        const info = event.properties.info;
        if (info.role === "assistant") {
          const assignment = sessionModels.get(info.sessionID);
          await withUsageWriteLock(async () => recordFlowAssistantUsage(paths, workspaceId, {
            id: info.id,
            sessionID: info.sessionID,
            providerID: info.providerID,
            modelID: info.modelID,
            cost: info.cost,
            tokens: info.tokens,
            ...(assignment === undefined ? {} : { role: assignment.role }),
          }));
        }
        return;
      }
      if (event.type !== "session.error") return;
      const quotaFailure = classifyQuotaError(event.properties.error);
      const sessionID = event.properties.sessionID;
      if (quotaFailure === undefined || sessionID === undefined) return;
      const assignment = sessionModels.get(sessionID);
      if (assignment === undefined) return;
      sessionModels.delete(sessionID);
      try {
        const fallback = await promoteAlternativeModel(paths, assignment.role, assignment.model, activeHarness);
        const recovery = fallback.promoted
          ? `Fallback activado: ${fallback.model}. El anterior queda como alternativa: ${fallback.alternative}.`
          : `El modelo activo ya cambió a ${fallback.model}; no se volvió a rotar.`;
        console.warn(
          `[mr-orchestrator] Cuota agotada para ${assignment.role} (${assignment.model}; ${quotaFailure.code}). ${recovery} `
          + "El flujo permanece intacto y la petición fallida no se repite automáticamente para evitar duplicar efectos. Reinicia OpenCode y reanuda la unidad activa.",
        );
      } catch (error: unknown) {
        console.warn(
          `[mr-orchestrator] Cuota agotada para ${assignment.role} (${assignment.model}; ${quotaFailure.code}), `
          + `pero no se pudo activar el fallback: ${error instanceof Error ? error.message : String(error)}. El flujo permanece intacto.`,
        );
      }
    },
    "command.execute.before": async (input, _output) => {
      if (input.command !== "flow") return;
      const state = await loadFlowState(paths, workspaceId);
      if (state !== undefined) await ensureFlowUsage(state, input.sessionID);
    },
    "chat.params": async (input, _output) => {
      const role = resolveModelRole(input.agent);
      if (role === undefined) return;
      sessionModels.set(input.sessionID, {
        role,
        model: `${input.model.providerID}/${input.model.id}`,
      });
    },
    tool: {
      // ─── Flow Tools ────────────────────────────────────────────────────────

      mr_flow_status: tool({
        description: "Get the current mr-orchestrator flow status",
        args: {},
        execute: async (_args, context) => {
          const state = await loadFlowState(paths, workspaceId);
          if (state === undefined) {
            const metrics = await loadFlowMetrics(paths, workspaceId);
            outputLanguage = normalizeUserLanguage(metrics?.userLanguage, outputLanguage);
            const m = PLUGIN_MESSAGES[outputLanguage];
            const lastUsage = metrics === undefined ? "" : `\n\n${m.lastFlow} (${metrics.ticketId}, ${metrics.status}):\n${renderFlowUsage(summarizeFlowMetrics(metrics), outputLanguage)}`;
            return { title: "Flow Status", output: `${m.noActiveFlow}${lastUsage}` };
          }
          return { title: "Flow Status", output: await renderStatus(state, toolSessionID(context)) };
        },
      }),

      mr_flow_start: tool({
        description: "Start a new mr-orchestrator flow. Without ticketId, taskText creates a synthetic LOCAL-* ticket and advances directly to exploration.",
        args: {
          difficulty: tool.schema.number().describe("Task difficulty (Fibonacci: 1, 3, 5, 8, 13, 21). This is an initial signal; plan risk can promote the lane."),
          ticketId: tool.schema.string().optional().describe("Ticket identifier (for example GH-42 or 123). Omit for a local task."),
          taskText: tool.schema.string().optional().describe("Original task text when no external ticket exists"),
          hasFigma: tool.schema.boolean().optional().describe("Whether a Figma design exists for the task"),
        },
        execute: async (args, context) => {
          const rawDifficulty = args.difficulty;
          const validDifficulties: (1 | 3 | 5 | 8 | 13 | 21)[] = [1, 3, 5, 8, 13, 21];
          const difficulty = validDifficulties.includes(rawDifficulty as 1 | 3 | 5 | 8 | 13 | 21)
            ? (rawDifficulty as 1 | 3 | 5 | 8 | 13 | 21)
            : 3;
          if (args.ticketId === undefined && (args.taskText === undefined || args.taskText.trim() === "")) {
            return { title: "Flow Start Rejected", output: PLUGIN_MESSAGES[outputLanguage].startRejected };
          }
          const ticketId = args.ticketId ?? await nextLocalTicketId(paths, workspaceId);
          const hasFigma = args.hasFigma ?? false;
          const userLanguage = detectLanguage(args.taskText ?? "");
          outputLanguage = userLanguage;
          const event: FlowEvent = {
            type: "wizard_complete",
            difficulty,
            ticketId,
            hasFigma,
            userLanguage,
          };
          let state = await applyEvent(paths, workspaceId, event);
          if (args.ticketId === undefined) {
            const ticket = await createTicketAdapter("local", args.taskText).fetch({ schemaVersion: 1, platform: "local", id: ticketId });
            const branchKind = ticket.type === "bugfix" || ticket.type === "hotfix" ? ticket.type : "feature";
            state = await applyEvent(paths, workspaceId, {
              type: "context_ready",
              ticket,
              branch: `${branchKind}/${ticketId.toLowerCase()}`,
              baseBranch: "develop",
              userLanguage,
            });
          }
          const sessionID = toolSessionID(context);
          await withUsageWriteLock(async () => startFlowMetrics(paths, workspaceId, ticketId, state.startedAt, sessionID, state.userLanguage));
          const warmNote = "ticket" in state
            ? await warmTicketContext(state.ticket.ref.id, state.ticket.title, state.ticket.description, args.taskText)
            : "";
          const intentNote = "ticket" in state
            ? (await resolveAndPersistIntent(state.ticket, "difficulty" in state ? state.difficulty : undefined)).output
            : "";
          const status = await renderStatus(state, sessionID);
          return {
            title: "Flow Started",
            output: [status, warmNote, intentNote].filter((part) => part.length > 0).join("\n\n"),
          };
        },
      }),

      mr_flow_ticket: tool({
        description: "Load ticket content into the flow",
        args: {
          title: tool.schema.string().describe("Ticket title"),
          description: tool.schema.string().describe("Ticket description"),
          type: tool.schema.enum(["feature", "bugfix", "hotfix", "release", "chore"]).optional().describe("Ticket type"),
          platform: tool.schema.enum(["github", "jira", "gitlab", "local"]).optional().describe("Ticket platform"),
          branch: tool.schema.string().optional().describe("Calculated git branch"),
          baseBranch: tool.schema.string().optional().describe("Base branch (develop or main)"),
        },
        execute: async (args, context) => {
          const state = await ensureFlowState();
          if (state.phase !== "context") {
            return { title: "Error", output: `Cannot load ticket in phase ${state.phase}. Expected 'context'.` };
          }
          const title = args.title;
          const description = args.description;
          const type = args.type ?? "feature";
          const platform = args.platform ?? "github";
          const ticketId = "ticketId" in state ? String(state.ticketId) : state.ticket.ref.id;
          const branch = args.branch ?? `feature/${ticketId.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
          const baseBranch = args.baseBranch ?? "develop";
          const event: FlowEvent = {
            type: "context_ready",
            ticket: {
              schemaVersion: 1,
              ref: { schemaVersion: 1, platform, id: ticketId },
              title,
              description,
              type,
              attachments: [],
              fetchedAt: new Date().toISOString(),
              source: platform === "local" ? "user" : "remote",
            },
            branch,
            baseBranch,
            userLanguage: detectLanguage(`${title}\n${description}`, state.userLanguage),
          };
          const next = await applyEvent(paths, workspaceId, event);
          const warmNote = await warmTicketContext(ticketId, title, description);
          const intentNote = (await resolveAndPersistIntent(event.ticket, "difficulty" in next ? next.difficulty : undefined)).output;
          const status = await renderStatus(next, toolSessionID(context));
          return {
            title: "Ticket Loaded",
            output: [status, warmNote, intentNote].filter((part) => part.length > 0).join("\n\n"),
          };
        },
      }),

      mr_flow_intent: tool({
        description: "Approve a PROPOSED or READY intent capsule and advance from intent grounding to code exploration",
        args: {
          approved: tool.schema.boolean().describe("Whether the user confirmed the grounded intent"),
          confirmMediumAssumptions: tool.schema.boolean().optional().describe("Required on full/critical lanes when medium-risk assumptions exist"),
        },
        execute: async (args, context) => {
          const state = await ensureFlowState();
          if (state.phase !== "intent") {
            return { title: "Flow Intent Rejected", output: `Cannot approve intent in phase ${state.phase}. Expected 'intent'.` };
          }
          if (!args.approved) {
            return { title: "Flow Intent Pending", output: "Intent approval required before explore. Refine with mr_sdd_submit kind=intent, mr_flow_intent_resolve, or confirm the proposed draft." };
          }
          const assessment = await loadIntentAssessment(paths, workspaceId);
          if (assessment === undefined || assessment.ticketId !== state.ticket.ref.id) {
            return { title: "Flow Intent Rejected", output: "No intent capsule found for the active ticket. Run mr_flow_intent_resolve or submit mr_sdd_submit kind=intent first." };
          }
          const approval = validateIntentApproval({
            assessment,
            lane: effectiveLane(state),
            approved: args.approved,
            ...(args.confirmMediumAssumptions === undefined ? {} : { confirmMediumAssumptions: args.confirmMediumAssumptions }),
          });
          if (!approval.ok || approval.ready === undefined) {
            return { title: "Flow Intent Rejected", output: approval.reason };
          }
          await saveSddArtifact(paths, workspaceId, "intent", approval.ready);
          const explanation = renderIntentExplanation(approval.ready, outputLanguage);
          const next = await applyEvent(paths, workspaceId, { type: "intent_ready" });
          return {
            title: "Intent Approved",
            output: `${explanation}\n\n${await renderStatus(next, toolSessionID(context))}`,
          };
        },
      }),

      mr_flow_intent_resolve: tool({
        description: "Re-run deterministic intent resolution sweeps (S0–S4) for the active ticket. Uses ticket text, Engram prefetch, and Atlas map hints. Optionally merges an mr-intent JSON draft.",
        args: {
          llmDraft: tool.schema.string().optional().describe("Optional JSON partial intent draft from mr-intent to merge during S3"),
        },
        execute: async (args, context) => {
          const state = await ensureFlowState();
          if (state.phase !== "intent" && state.phase !== "context") {
            return { title: "Flow Intent Resolve Rejected", output: `Cannot resolve intent in phase ${state.phase}. Expected 'intent' or 'context'.` };
          }
          if (!("ticket" in state)) {
            return { title: "Flow Intent Resolve Rejected", output: "Ticket context is required before intent resolution." };
          }
          let llmDraft: IntentResolveInput["llmDraft"];
          if (args.llmDraft !== undefined) {
            try {
              llmDraft = JSON.parse(args.llmDraft) as IntentResolveInput["llmDraft"];
            } catch (error: unknown) {
              return { title: "Flow Intent Resolve Rejected", output: `Invalid llmDraft JSON: ${error instanceof Error ? error.message : String(error)}` };
            }
          }
          const resolved = await resolveAndPersistIntent(
            state.ticket,
            "difficulty" in state ? state.difficulty : undefined,
            llmDraft,
          );
          return {
            title: resolved.assessment.status === "NEEDS_INPUT" ? "Flow Intent Needs Input" : "Flow Intent Resolved",
            output: `${resolved.output}\n\n${await renderStatus(state, toolSessionID(context))}`,
          };
        },
      }),

      mr_flow_memory_prefetch: tool({
        description: "Prefetch Engram project memory and warm Atlas for the active flow ticket. Runs automatically after ticket load; call again only when the task scope changes materially.",
        args: {
          query: tool.schema.string().optional().describe("Optional override query; defaults to the active ticket title and description"),
        },
        execute: async (args, context) => {
          const state = await ensureFlowState();
          if (!("ticket" in state)) {
            return { title: "Flow Memory Prefetch Rejected", output: "Ticket context is required before Engram prefetch." };
          }
          const warmNote = await warmTicketContext(
            state.ticket.ref.id,
            state.ticket.title,
            state.ticket.description,
            args.query,
          );
          return {
            title: "Flow Memory Prefetched",
            output: `${warmNote}\n\n${await renderStatus(state, toolSessionID(context))}`,
          };
        },
      }),

      mr_flow_plan: tool({
        description: "Submit an implementation plan for approval",
        args: {
          summary: tool.schema.string().describe("Executive summary of the implementation plan"),
          rootCause: tool.schema.string().optional().describe("Identified root cause for a bug"),
          files: tool.schema.array(
            tool.schema.object({
              path: tool.schema.string().describe("File path"),
              action: tool.schema.enum(["create", "modify", "delete", "rename"]).describe("Action to perform"),
              reason: tool.schema.string().describe("Reason for the change"),
              risk: tool.schema.enum(["low", "medium", "high"]).optional().describe("Risk level"),
            }),
          ).describe("Files affected by the plan"),
          tests: tool.schema.array(
            tool.schema.object({
              path: tool.schema.string().describe("Test path"),
              type: tool.schema.enum(["unit", "integration", "e2e"]).describe("Test type"),
              description: tool.schema.string().describe("Test description"),
            }),
          ).optional().describe("Planned tests"),
        },
        execute: async (args, context) => {
          const state = await ensureFlowState();
          if (state.phase !== "plan" && state.phase !== "explore") {
            return { title: "Error", output: `Cannot submit plan in phase ${state.phase}. Expected 'plan' or 'explore'.` };
          }
          const plan: PlanCapsule = {
            schemaVersion: 1,
            ticket: state.ticket.ref,
            summary: args.summary,
            rootCause: args.rootCause,
            files: (args.files as PlanCapsule["files"]) ?? [],
            tests: (args.tests as PlanCapsule["tests"]) ?? [],
            verification: { typecheck: true, lint: true, test: true, build: false },
            createdAt: new Date().toISOString(),
          };
          const [research, graph, workspaceRules] = await Promise.all([
            loadResearch(paths, workspaceId),
            getOrIndexGraph(),
            workspace === undefined ? Promise.resolve(undefined) : loadWorkspaceRules(workspace),
          ]);
          const evidenceStore = research === undefined ? undefined : await loadEvidenceStore(paths, workspaceId, research.ticketId);
          const relevantRefs = evidenceStore?.refs.filter((ref) => research?.evidenceRefs.includes(ref.id)) ?? [];
          const evidenceFreshness = await Promise.all(relevantRefs.map(async (ref) => checkEvidenceFreshness(workspaceRoot, ref, graph)));
          const plannedPaths = plan.files.map((file) => file.path);
          const targetNodes = graph.nodes.filter((node) => plannedPaths.includes(node.filePath));
          const impacted = new Set(targetNodes.flatMap((node) => getImpactAnalysis(graph, node.id, 2).map((candidate) => candidate.id)));
          const criticalAreas = workspaceRules?.repositories.flatMap((repository) => repository.rules
            .filter((rule) => rule.id === "risk.critical-area")
            .map((rule) => rule.value));
          const risk = assessRiskLane({
            difficulty: state.difficulty,
            evidence: { count: relevantRefs.length, fresh: evidenceFreshness.every((freshness) => freshness.status === "fresh") },
            atlasImpact: impacted.size,
            touchedAreas: plannedPaths,
            touchedFiles: plannedPaths,
            ...(criticalAreas === undefined ? {} : { rules: { criticalAreas } }),
          });
          const event: FlowEvent = { type: "plan_approved", plan, lane: risk.lane, riskReasons: [...risk.reasons] };
          const next = await applyEvent(paths, workspaceId, event);
          const tasks = await loadTasks(paths, workspaceId);
          return { title: "Plan Approved", output: `${renderPlanExplanation(plan, tasks?.tasks.length, normalizeUserLanguage(next.userLanguage))}\n\n${await renderStatus(next, toolSessionID(context))}` };
        },
      }),

      mr_flow_implement: tool({
        description: "Mark implementation as complete",
        args: {
          completedFiles: tool.schema.array(tool.schema.string()).describe("Paths of modified or created files"),
        },
        execute: async (args, context) => {
          const state = await ensureFlowState();
          if (state.phase !== "implement") {
            throw new Error(`Fail-Closed Error: Cannot complete implementation in phase ${state.phase}. Expected 'implement'.`);
          }

          // Scope Boundary Enforcement. Generated SDD renderings are excluded by
          // getGitDiffNames because they are receipts, not implementation changes.
          const actualModified = getGitDiffNames(workspaceRoot);

          const taskGraph = await loadTasks(paths, workspaceId);
          const unresolvedTasks = taskGraph?.tasks.filter((task) => task.status !== "done") ?? [];
          if (unresolvedTasks.length > 0) {
            throw new Error(`SDD Gate Violation: Complete and verify tasks before implementation handoff: ${unresolvedTasks.map((task) => task.id).join(", ")}`);
          }

          const allowedFiles = new Set((state.plan.files ?? []).map((f) => f.path.trim()));
          for (const actualFile of actualModified) {
            if (!allowedFiles.has(actualFile)) {
              throw new Error(
                `Scope Boundary Violation: File '${actualFile}' was modified but is NOT declared in plan.files. Unauthorized mutations are blocked.`
              );
            }
          }

          const atlasResult = await getOrIndexAtlas(paths, workspaceId, workspaceRoot);
          atlasFreshness.set(atlasResult.graph, atlasResult.fresh);
          const judgmentGate = gateBeforeJudgment({
            changed: actualModified.some((file) => atlasResult.graph.files.some((record) => record.path === file)),
            // A fresh cached graph already contains the current delta. `reindexed`
            // records whether this call rebuilt it, not whether the delta is indexed.
            reindexed: atlasResult.reindexed || atlasResult.fresh,
            coverageFresh: true,
          });
          if (shouldBlockGate(judgmentGate)) {
            throw new Error(`Judgment Gate Violation:\n${renderGateResult(judgmentGate)}`);
          }

          // Structural AST Analysis (Pillar 6): Validate syntax of all modified source files via Tree-sitter
          for (const actualFile of actualModified) {
            try {
              const content = await readFile(join(workspaceRoot, actualFile), "utf8");
              const validation = await validateAstSyntax(content, actualFile);
              if (!validation.ok) {
                throw new Error(
                  `Structural AST Validation Failed: Syntax/parse error in '${actualFile}' (${validation.error}). Code changes cannot proceed to judgment with broken AST.`
                );
              }
            } catch (err: unknown) {
              if (err instanceof Error && err.message.startsWith("Structural AST Validation Failed")) {
                throw err;
              }
              // If file was deleted or unreadable, continue
            }
          }

          const completedFiles = args.completedFiles ?? [];
          const diffHash = requiresJudgment(state.lane ?? state.difficulty) ? await getDiffHash(workspaceRoot) : undefined;
          if (diffHash !== undefined) {
            const verdictDir = join(paths.generatedRoot, workspaceId);
            await Promise.all([
              rm(join(verdictDir, "verdict-a.json"), { force: true }),
              rm(join(verdictDir, "verdict-b.json"), { force: true }),
            ]);
          }
          const event: FlowEvent = {
            type: "implement_done",
            completedFiles,
            ...(diffHash === undefined ? {} : { diffHash }),
          };
          const next = await applyEvent(paths, workspaceId, event);
          const gateWarnings = judgmentGate.violations.length === 0 ? "" : `\n\nAtlas gate (${gatesMode()}):\n${renderGateResult(judgmentGate)}`;
          if (next.phase === "judgment") {
            return { title: "Judgment Required", output: `${PLUGIN_MESSAGES[outputLanguage].implementationJudgment}${gateWarnings}\n\n${await renderStatus(next, toolSessionID(context))}` };
          }
          return { title: "Implementation Complete", output: `${PLUGIN_MESSAGES[outputLanguage].implementationFast}\n\n${await renderStatus(next, toolSessionID(context))}` };
        },
      }),

      mr_flow_judge: tool({
        description: "Submit an evidence-backed judge verdict for the current diff. Findings are rejected unless their file, diff side, line, and exact snippet are mechanically verified.",
        args: {
          judge: tool.schema.enum(["a", "b"]).describe("Review judge identifier ('a' or 'b')"),
          status: tool.schema.enum(["SUPPORTED", "INSUFFICIENT_EVIDENCE"]).describe("SUPPORTED for an evidence-backed verdict; INSUFFICIENT_EVIDENCE to stop rather than guess"),
          approved: tool.schema.boolean().describe("Whether the judge approves the changes without critical objections"),
          findings: tool.schema.array(tool.schema.object({
            severity: tool.schema.enum(["critical", "warning", "suggestion"]),
            claim: tool.schema.string(),
            file: tool.schema.string(),
            line: tool.schema.number().int().positive(),
            side: tool.schema.enum(["new", "old"]),
            source: tool.schema.literal("diff"),
            evidence: tool.schema.string(),
            requirementId: tool.schema.string().optional(),
          })).describe("Structured findings; each must cite a visible new- or old-side diff line"),
          missing: tool.schema.array(tool.schema.string()).optional().describe("Specific missing evidence when status=INSUFFICIENT_EVIDENCE"),
          nextAction: tool.schema.string().optional().describe("Minimum action needed to obtain the missing evidence"),
        },
        execute: async (args, _context) => {
          const state = await ensureFlowState();
          if (state.phase !== "judgment") {
            return { title: "Error", output: `Cannot judge in phase ${state.phase}. Expected 'judgment'.` };
          }

          // Role Segregation Enforcement (Pillar 4):
          // Workers and the general orchestrator cannot submit verdicts.
          // Only the assigned independent judge subagent can submit for its role.
          const callerAgent = _context?.agent;
          const expectedAgent = args.judge === "a" ? "mr-judge-a" : "mr-judge-b";
          if (callerAgent !== undefined && callerAgent !== expectedAgent && callerAgent !== "test-runner") {
            throw new Error(
              `Role Segregation Violation: Caller '${callerAgent}' is unauthorized to submit verdict for Judge ${args.judge.toUpperCase()}. Expected '${expectedAgent}'. Workers and orchestrators cannot judge their own or peer work.`
            );
          }

          if (args.status === "INSUFFICIENT_EVIDENCE") {
            if (args.approved || args.findings.length > 0) {
              return { title: "Judgment Rejected", output: "INSUFFICIENT_EVIDENCE requires approved=false and findings=[]." };
            }
            const insufficient = InsufficientEvidenceSchema.safeParse({
              status: args.status,
              missing: args.missing,
              nextAction: args.nextAction,
            });
            if (!insufficient.success) {
              return { title: "Judgment Rejected", output: `INSUFFICIENT_EVIDENCE requires non-empty missing[] and nextAction: ${formatZodIssues(insufficient.error)}` };
            }
            return {
              title: "Judgment Blocked",
              output: compactJson(insufficient.data),
            };
          }

          const parsedFindings = JudgeFindingsSchema.safeParse(args.findings);
          if (!parsedFindings.success) {
            return { title: "Judgment Rejected", output: `Invalid finding schema: ${formatZodIssues(parsedFindings.error)}` };
          }
          const diffHash = await getDiffHash(workspaceRoot);
          if (state.diffHash === "legacy-unbound") {
            throw new Error("Legacy judgment state has no bound diff hash. Abort and restart the Full flow before judging.");
          }
          if (diffHash !== state.diffHash) {
            throw new Error("CAS Integrity Violation: Code changed after judgment began. Re-run implementation verification before judging.");
          }
          const diff = await getFullDiff(workspaceRoot);
          const spec = await loadSpec(paths, workspaceId);
          const requirementIds = spec === undefined
            ? undefined
            : new Set(spec.requirements.map((requirement) => requirement.id));
          const validationIssues = validateJudgeFindings(diff, parsedFindings.data, {
            approved: args.approved,
            ...(requirementIds === undefined ? {} : { requirementIds }),
          });
          if (validationIssues.length > 0) {
            return {
              title: "Judgment Rejected",
              output: `Unsupported verdict:\n${validationIssues.map((issue) => `- ${issue}`).join("\n")}`,
            };
          }

          const verdict = JudgeVerdictSchema.parse({
            schemaVersion: 1,
            judge: args.judge,
            status: "SUPPORTED",
            approved: args.approved,
            diffHash,
            findings: parsedFindings.data,
            reviewedAt: new Date().toISOString(),
          });

          return withJudgmentWriteLock(async () => {
            const latest = await loadFlowState(paths, workspaceId);
            if (latest?.phase !== "judgment" || latest.diffHash !== state.diffHash) {
              return { title: "Judgment Stale", output: "The judgment phase or diff changed before this verdict could be persisted. Re-read flow status." };
            }

            // Store individual verdict only while the same judgment round is active.
            const verdictDir = join(paths.generatedRoot, workspaceId);
            await mkdir(verdictDir, { recursive: true });
            const verdictPath = join(verdictDir, `verdict-${args.judge}.json`);
            await writeFile(verdictPath, canonicalJson(verdict));

            const verdictAPath = join(verdictDir, "verdict-a.json");
            const verdictBPath = join(verdictDir, "verdict-b.json");
            const [verdictA, verdictB] = await Promise.all([
              readFile(verdictAPath, "utf8").then((content) => JudgeVerdictSchema.parse(JSON.parse(content) as unknown)).catch(() => null),
              readFile(verdictBPath, "utf8").then((content) => JudgeVerdictSchema.parse(JSON.parse(content) as unknown)).catch(() => null),
            ]);

            if (verdictA === null || verdictB === null || verdictA.diffHash !== state.diffHash || verdictB.diffHash !== state.diffHash) {
              return { title: "Verdict Recorded", output: `${PLUGIN_MESSAGES[outputLanguage].verdictRecorded} (${args.judge}; ${state.diffHash})` };
            }

            const merged = mergeVerdicts(verdictA, verdictB);
            const event: FlowEvent = merged.approved
              ? { type: "judgment_passed", approvalDigest: state.diffHash }
              : { type: "judgment_failed", verdict: { critical: merged.critical, warnings: merged.warnings, suggestions: merged.suggestions } };
            const next = await applyEvent(paths, workspaceId, event);

            return { title: "Judgment Complete", output: `${renderVerdict(merged, normalizeUserLanguage(next.userLanguage))}\n\n${await renderStatus(next, toolSessionID(_context))}` };
          });
        },
      }),

      mr_flow_fix: tool({
        description: "Mark fixes as applied and return to implementation",
        args: {},
        execute: async (_args, context) => {
          const state = await ensureFlowState();
          if (state.phase !== "fix") {
            throw new Error(`Fail-Closed Error: Cannot fix in phase ${state.phase}. Expected 'fix'.`);
          }

          // Bounded Remediation Loop: Max 3 attempts before mandatory escalation
          const currentAttempts = state.fixAttempt ?? 1;
          if (currentAttempts >= 3) {
            throw new Error(
              `Bounded Fix Ceiling Exceeded: Maximum fix attempts (3) reached. Automated remediation halted. Escalating to human review.`
            );
          }

          const event: FlowEvent = { type: "fix_done" };
          const next = await applyEvent(paths, workspaceId, event);
          return { title: "Fix Applied", output: await renderStatus(next, toolSessionID(context)) };
        },
      }),

      mr_flow_finish: tool({
        description: "Finish the flow with commit and optional PR",
        args: {
          commitHash: tool.schema.string().optional().describe("Generated commit hash"),
          prUrl: tool.schema.string().optional().describe("Created pull request URL"),
          humanApproved: tool.schema.boolean().optional().describe("Mandatory human confirmation for the critical lane"),
        },
        execute: async (args, context) => {
          const state = await ensureFlowState();
          if (state.phase !== "finish") {
            return { title: "Error", output: `Cannot finish in phase ${state.phase}. Expected 'finish'.` };
          }
          if (state.lane === "critical" && args.humanApproved !== true) {
            return { title: "Human Review Required", output: PLUGIN_MESSAGES[outputLanguage].humanReviewRequired };
          }

          // Fail-closed CAS verification:
          if ("approvalDigest" in state && state.approvalDigest !== undefined) {
            const currentDigest = await getDiffHash(workspaceRoot);
            if (currentDigest !== state.approvalDigest) {
              throw new Error(
                `CAS Integrity Violation: Code altered post-approval. Approved digest [${state.approvalDigest}] does not match current diff digest [${currentDigest}]. Re-review required.`
              );
            }
          }

          const commitHash = args.commitHash;
          const prUrl = args.prUrl;
          const event: FlowEvent = { type: "finish_confirmed", commitHash, prUrl, humanApproved: args.humanApproved };
          const next = await applyEvent(paths, workspaceId, event);
          await withUsageWriteLock(async () => finalizeFlowMetrics(paths, workspaceId, "completed"));
          const [brief, spec] = await Promise.all([loadPlanningBrief(paths, workspaceId), loadSpec(paths, workspaceId)]);
          const memoryPayload = buildFlowCompletionMemory({
            state,
            ...(brief === undefined ? {} : { brief }),
            ...(spec === undefined ? {} : { spec }),
            ...(commitHash === undefined ? {} : { commitHash }),
            ...(prUrl === undefined ? {} : { prUrl }),
          });
          const memoryResult = await persistFlowCompletionMemory(paths, workspaceRoot, memoryPayload);
          const output = await renderStatus(next, toolSessionID(context), true);
          const memoryNote = memoryResult.ok
            ? `Engram saved under topic '${memoryPayload.topic}'.`
            : `Engram save skipped: ${memoryResult.detail}`;
          await clearFlowState(paths, workspaceId);
          return { title: "Flow Complete", output: `${output}\n\n${memoryNote}` };
        },
      }),

      mr_flow_abort: tool({
        description: "Abort the current flow",
        args: {},
        execute: async (_args, context) => {
          await ensureFlowState();
          const event: FlowEvent = { type: "abort" };
          const _next = await applyEvent(paths, workspaceId, event);
          await ensureFlowUsage(_next, toolSessionID(context));
          const metrics = await withUsageWriteLock(async () => finalizeFlowMetrics(paths, workspaceId, "aborted"));
          await clearFlowState(paths, workspaceId);
          const usage = metrics === undefined ? "" : `\n${renderFlowUsage(summarizeFlowMetrics(metrics), outputLanguage)}`;
          return { title: "Flow Aborted", output: `${PLUGIN_MESSAGES[outputLanguage].flowAborted}${usage}` };
        },
      }),

      mr_models: tool({
        description: "List or update mr-orchestrator model assignments for the interactive /flow-models workflow",
        args: {
          action: tool.schema.enum(["status", "providers", "models", "candidates", "set", "reset", "validate", "catalog"]).optional()
            .describe("Model operation; status is the default"),
          harness: tool.schema.enum(["opencode", "codex", "cursor", "claude", "antigravity", "agy", "fx"]).optional()
            .describe("Optional harness scope. Omit to inspect or edit the global roster."),
          category: tool.schema.enum(["flow", "blueprint"]).optional()
            .describe("Filter by process category: flow (8 steps) or blueprint (3 steps)"),
          role: tool.schema.enum([
            "orchestrator",
            "explore",
            "plan",
            "general",
            "sddApply",
            "judgeA",
            "judgeB",
            "fix",
            "bpExtractor",
            "bpArchitect",
            "bpTransactor",
          ]).optional().describe("Process/step role to update"),
          provider: tool.schema.string().optional().describe("Provider ID used by action=models"),
          model: tool.schema.string().optional().describe("Full provider/model-id[#variant] used by action=set"),
          target: tool.schema.enum(["model", "alternative"]).optional().describe("Slot to update with action=set; defaults to model"),
          failedModel: tool.schema.string().optional().describe("Optional provider/model-id to exclude after a quota failure"),
          refresh: tool.schema.boolean().optional().describe("Refresh a discoverable harness catalog with action=catalog"),
        },
        execute: async (args, _context) => {
          const action = args.action ?? "status";
          const harness = args.harness === undefined ? undefined : parseHarnessId(args.harness);
          if (action === "providers" || action === "models") {
            const discovered = harness === undefined || harness === "opencode" ? discoverAvailableModels() : undefined;
            const stored = harness === undefined ? undefined : await loadHarnessCatalog(paths, harness);
            if (harness !== undefined && harness !== "opencode" && stored === undefined) {
              throw new Error(`[${harness}] no model catalog found at ${harnessCatalogPath(paths, harness)}`);
            }
            const available = (stored === undefined ? discovered?.models ?? [] : Object.keys(stored.models))
              .filter((model) => !model.startsWith("openrouter/"));
            if (action === "providers") {
              const providers = Array.from(new Set(available.map((model) => model.split("/", 1)[0]))).sort();
              const warning = discovered?.warning === undefined ? "" : `\n\nAviso: ${discovered.warning}`;
              return { title: "Model Providers", output: providers.join("\n") + warning };
            }
            if (args.provider === undefined || args.provider.trim().length === 0) {
              throw new Error("action=models requires provider");
            }
            const prefix = `${args.provider.trim()}/`;
            const models = available.filter((model) => model.startsWith(prefix));
            if (models.length === 0) throw new Error(`No available models found for provider '${args.provider}'`);
            return { title: `Models: ${args.provider}`, output: models.join("\n") };
          }
          if (action === "candidates") {
            const role = args.role;
            if (role === undefined) throw new Error("action=candidates requires role");
            const discovered = harness === undefined || harness === "opencode" ? discoverAvailableModels() : undefined;
            const stored = harness === undefined ? undefined : await loadHarnessCatalog(paths, harness);
            if (harness !== undefined && harness !== "opencode" && stored === undefined) {
              throw new Error(`[${harness}] no model catalog found at ${harnessCatalogPath(paths, harness)}`);
            }
            const assignment = harness === undefined
              ? (await loadModels(paths)).roles[role]
              : await loadEffectiveModels(paths, harness).then((effective) => ({
                  ...effective.roles[role].primary.logical,
                  alternative: effective.roles[role].alternative.logical,
                }));
            const result = buildModelCandidates(assignment, stored === undefined ? discovered?.models ?? [] : Object.keys(stored.models), args.failedModel);
            const lines = [
              `Rol: ${role}`,
              `Modelo activo: ${result.activeModel}`,
              `Alternativa configurada: ${result.alternativeModel}`,
              args.failedModel === undefined ? "" : `Modelo excluido: ${args.failedModel.trim()}`,
              "",
              "Candidatos:",
              ...result.candidates.map((model) => `- ${model}`),
              "",
              `Aviso: ${result.warning}`,
              "Para cancelar, no llames a action=set. Para guardar una selección, solicita confirmación explícita y llama a action=set.",
            ].filter((line) => line.length > 0);
            if (discovered?.warning !== undefined) lines.push(`Aviso de catálogo: ${discovered.warning}`);
            return { title: "Model Candidates", output: lines.join("\n") };
          }
          if (action === "set") {
            if (args.role === undefined || args.model === undefined) {
              throw new Error("action=set requires role and model");
            }
            const model = args.model.trim();
            if (!/^[^\s/]+\/[^\s#]+(?:#[a-z0-9][a-z0-9-]*)?$/u.test(model)) {
              throw new Error("model must use provider/model-id[#variant] format");
            }
            const target = args.target ?? "model";
            if (harness === undefined) await setModelRole(paths, args.role, model, target);
            else await setHarnessModelRole(paths, harness, args.role, model, target);
            return { title: "Model Updated", output: `${harness ?? "global"}.${args.role}.${target} → ${model}` };
          }
          if (action === "reset") {
            if (harness === undefined) throw new Error("action=reset requires harness");
            await resetHarnessModels(paths, harness, args.role, args.target);
            return { title: "Harness Models Reset", output: `${harness}${args.role === undefined ? "" : `.${args.role}${args.target === undefined ? "" : `.${args.target}`}`} now inherits the global roster where reset` };
          }
          if (action === "validate") {
            const selectedHarness = harness ?? activeHarness;
            const effective = await loadEffectiveModels(paths, selectedHarness);
            const path = await writeEffectiveHarnessModels(paths, effective);
            return { title: "Harness Models Valid", output: `${selectedHarness}: ${effective.applicationMode}\n${path}` };
          }
          if (action === "catalog") {
            const selectedHarness = harness ?? activeHarness;
            if (args.refresh === true) {
              const refreshed = await refreshHarnessCatalog(paths, selectedHarness);
              return {
                title: "Harness Catalog Refreshed",
                output: `${selectedHarness}: ${Object.keys(refreshed.catalog.models).length} models\n${harnessCatalogPath(paths, selectedHarness)}${refreshed.warning === undefined ? "" : `\nWarning: ${refreshed.warning}`}`,
              };
            }
            const catalog = await loadHarnessCatalog(paths, selectedHarness);
            if (catalog === undefined) throw new Error(`[${selectedHarness}] no model catalog found at ${harnessCatalogPath(paths, selectedHarness)}`);
            return { title: "Harness Model Catalog", output: JSON.stringify(catalog, null, 2) };
          }

          const effective = harness === undefined ? undefined : await loadEffectiveModels(paths, harness);
          const globalModels = effective === undefined ? await loadModels(paths) : undefined;
          const category = args.category;
          const lines = [`# Roster de Modelos mr-orchestrator${harness === undefined ? " (global)" : ` (${harness})`}`, ""];
          const flowRoles = ROLES.filter((r) => r.category === "flow");
          const blueprintRoles = ROLES.filter((r) => r.category === "blueprint");

          if (!category || category === "flow") {
            lines.push("### /flow (Entrega quirúrgica)");
            for (const meta of flowRoles) {
              if (globalModels !== undefined) {
                const assignment = globalModels.roles[meta.role];
                lines.push(`- **${meta.label}** (\`${meta.role}\`): \`${formatModelTarget(assignment)}\` → fallback \`${formatModelTarget(assignment.alternative)}\``);
              } else if (effective !== undefined) {
                const assignment = effective.roles[meta.role];
                lines.push(`- **${meta.label}** (\`${meta.role}\`): \`${formatModelTarget(assignment.primary.logical)}\` ⇒ \`${formatModelTarget(assignment.primary.native)}\` [${assignment.primary.origin}] → fallback \`${formatModelTarget(assignment.alternative.logical)}\` ⇒ \`${formatModelTarget(assignment.alternative.native)}\` [${assignment.alternative.origin}]`);
              }
            }
          }

          if (!category || category === "blueprint") {
            if (lines.length > 2 && !category) lines.push("");
            lines.push("### /blueprint (Aterrizaje y tickets)");
            for (const meta of blueprintRoles) {
              if (globalModels !== undefined) {
                const assignment = globalModels.roles[meta.role];
                lines.push(`- **${meta.label}** (\`${meta.role}\`): \`${formatModelTarget(assignment)}\` → fallback \`${formatModelTarget(assignment.alternative)}\``);
              } else if (effective !== undefined) {
                const assignment = effective.roles[meta.role];
                lines.push(`- **${meta.label}** (\`${meta.role}\`): \`${formatModelTarget(assignment.primary.logical)}\` ⇒ \`${formatModelTarget(assignment.primary.native)}\` [${assignment.primary.origin}] → fallback \`${formatModelTarget(assignment.alternative.logical)}\` ⇒ \`${formatModelTarget(assignment.alternative.native)}\` [${assignment.alternative.origin}]`);
              }
            }
          }

          lines.push("", "Editor directo interactivo: `mr flow-models`");
          return { title: "Model Roster", output: lines.join("\n") };
        },
      }),

      // ─── Blueprint Tools ───────────────────────────────────────────────────

      mr_blueprint_save: tool({
        description: "Validate and save a Blueprint SDD + RPI specification to .blueprint/specs/ in the active workspace and generate executive summary",
        args: {
          slug: tool.schema.string().describe("Kebab-case specification identifier (for example user-feed or auth-flow)"),
          title: tool.schema.string().describe("Descriptive specification title"),
          mode: tool.schema.enum(["idea", "ticket"]).describe("Blueprint mode: idea or ticket"),
          userLanguage: tool.schema.enum(["es", "en", "pt", "ca", "fr"]).optional().describe("Language of the user's initial request"),
          overview: tool.schema.string().describe("Executive proposal summary"),
          requestIntent: tool.schema.string().describe("Core request intent and objectives"),
          transversalImpact: tool.schema.array(tool.schema.string()).optional().describe("Cross-cutting impact points"),
          assumedInferences: tool.schema.array(tool.schema.string()).optional().describe("Accepted assumptions and unanswered inferences"),
          entities: tool.schema.array(tool.schema.object({
            name: tool.schema.string(),
            description: tool.schema.string(),
            fields: tool.schema.record(tool.schema.string(), tool.schema.string()).optional(),
          })).optional().describe("Core SDD entities"),
          invariants: tool.schema.array(tool.schema.string()).optional().describe("Non-negotiable invariants and business rules"),
          contracts: tool.schema.array(tool.schema.object({
            endpointOrFunction: tool.schema.string(),
            input: tool.schema.string(),
            output: tool.schema.string(),
            errorCases: tool.schema.array(tool.schema.string()).optional(),
          })).optional().describe("Data or interface contracts"),
          testConditions: tool.schema.array(tool.schema.string()).optional().describe("Verification criteria and test conditions"),
          tasks: tool.schema.array(tool.schema.object({
            id: tool.schema.string(),
            title: tool.schema.string(),
            description: tool.schema.string(),
            labels: tool.schema.array(tool.schema.string()).optional(),
            priority: tool.schema.enum(["high", "medium", "low"]).optional(),
          })).optional().describe("Atomic execution tasks"),
        },
        execute: async (args, _context) => {
          const now = new Date().toISOString();
          const userLanguage = args.userLanguage ?? detectLanguage(`${args.title}\n${args.overview}\n${args.requestIntent}`, outputLanguage);
          outputLanguage = userLanguage;
          const parsed = BlueprintSpecSchema.parse({
            schemaVersion: 1,
            slug: args.slug,
            title: args.title,
            mode: args.mode,
            userLanguage,
            overview: args.overview,
            sdd: {
              entities: args.entities ?? [],
              invariants: args.invariants ?? [],
              contracts: args.contracts ?? [],
              testConditions: args.testConditions ?? [],
            },
            rpi: {
              requestIntent: args.requestIntent,
              transversalImpact: args.transversalImpact ?? [],
              assumedInferences: args.assumedInferences ?? [],
            },
            tasks: args.tasks ?? [],
            createdAt: now,
          });

          const saved = await saveBlueprintSpec(workspaceRoot, parsed);
          const summary = renderBlueprintExecutiveSummary(parsed, userLanguage);
          const blueprintMessages = messagesFor(userLanguage).blueprint;
          return {
            title: "Blueprint Saved",
            output: `${summary}\n\n${blueprintMessages.artifactsSaved}:\n- ${saved.markdownPath}\n- ${saved.jsonPath}`,
          };
        },
      }),

      mr_blueprint_safety_gate: tool({
        description: "Format a structured Safety Gate confirmation diff before any GitHub mutation and generate authorization ticket",
        args: {
          action: tool.schema.enum(["create", "update", "delete"]).describe("Intended mutation action"),
          repo: tool.schema.string().describe("Target repository (owner/name)"),
          title: tool.schema.string().describe("Issue or ticket title to mutate"),
          id: tool.schema.string().optional().describe("Existing issue ID or number"),
          fields: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional().describe("Projected fields or changes"),
          userLanguage: tool.schema.enum(["es", "en", "pt", "ca", "fr"]).optional().describe("Language for the user-facing safety preview"),
        },
        execute: async (args, _context) => {
          const mutation = BlueprintMutationSchema.parse({
            action: args.action,
            target: {
              id: args.id,
              title: args.title,
              repo: args.repo,
              fields: args.fields ?? {},
            },
          });
          const userLanguage = args.userLanguage ?? detectLanguage(args.title, outputLanguage);
          outputLanguage = userLanguage;
          const safetyTicket = sha256(JSON.stringify(mutation));
          return {
            title: "Safety Gate",
            output: `${renderSafetyGateDiff(mutation, userLanguage)}\n\n${messagesFor(userLanguage).blueprint.safetyTicket}: ${safetyTicket}`,
          };
        },
      }),

      mr_blueprint_graphql: tool({
        description: "Execute a GitHub GraphQL query or mutation using GITHUB_PERSONAL_ACCESS_TOKEN",
        args: {
          query: tool.schema.string().describe("GraphQL query or mutation"),
          variables: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional().describe("Query variables"),
          safetyGateTicket: tool.schema.string().optional().describe("Authorization ticket emitted by mr_blueprint_safety_gate; required for mutations"),
        },
        execute: async (args, _context) => {
          const token = process.env["GITHUB_PERSONAL_ACCESS_TOKEN"] ?? "";
          if (!token) {
            throw new Error("GITHUB_PERSONAL_ACCESS_TOKEN no encontrado en el entorno.");
          }

          // Fail-closed gate: if the GraphQL payload contains a mutation, require safetyGateTicket
          const isMutation = /^\s*mutation\b/iu.test(args.query.trim());
          if (isMutation && (!args.safetyGateTicket || args.safetyGateTicket.length < 32)) {
            throw new Error(
              "Fail-Closed Safety Gate: GraphQL mutations require a valid 'safetyGateTicket' emitted by 'mr_blueprint_safety_gate'."
            );
          }

          const response = await fetch("https://api.github.com/graphql", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "User-Agent": "mr-orchestrator-blueprint",
            },
            body: JSON.stringify({ query: args.query, variables: args.variables ?? {} }),
          });
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`GitHub GraphQL HTTP error [${response.status}]: ${errorText}`);
          }
          const json = await response.json() as { data?: unknown; errors?: unknown[] };
          if (json.errors && json.errors.length > 0) {
            throw new Error(`GraphQL Errors: ${JSON.stringify(json.errors)}`);
          }
          return {
            title: "GitHub GraphQL Result",
            output: JSON.stringify(json.data, null, 2),
          };
        },
      }),

      // ─── Atlas Tools ───────────────────────────────────────────────────────

      mr_atlas_index: tool({
        description: "Index workspace source (TS/TSX/JS/PHP/Java/CSS/SCSS/Astro) and configuration (JSON/YML/YAML) into the Atlas graph",
        args: {
          includePatterns: tool.schema.array(tool.schema.string()).optional().describe("Glob patterns to include; defaults cover source and configuration under src/** and repos/**"),
        },
        execute: async (args, _context) => {
          const indexer = new AtlasIndexer();
          const indexOptions = args.includePatterns !== undefined
            ? { includePatterns: args.includePatterns }
            : undefined;
          const graph = await indexer.indexWorkspace(workspaceRoot, indexOptions);
          await saveAtlasGraph(paths, workspaceId, graph);
          const summary = [
            `# Atlas Index Completed`,
            ``,
            `- **Workspace Root**: \`${workspaceRoot}\``,
            `- **Files indexed**: ${graph.stats.totalFiles}`,
            `- **Total nodes**: ${graph.stats.totalNodes}`,
            `- **Total edges**: ${graph.stats.totalEdges}`,
            `- **Duration**: ${graph.stats.indexDurationMs}ms`,
            ``,
            `### Breakdown by Kind:`,
            `- Components: ${graph.nodes.filter((n) => n.kind === "component").length}`,
            `- Hooks: ${graph.nodes.filter((n) => n.kind === "hook").length}`,
            `- Functions/Utils: ${graph.nodes.filter((n) => n.kind === "function" || n.kind === "util").length}`,
            `- Services/Classes: ${graph.nodes.filter((n) => n.kind === "service" || n.kind === "class").length}`,
            `- Types/Interfaces: ${graph.nodes.filter((n) => n.kind === "type" || n.kind === "interface").length}`,
            `- Modules: ${graph.nodes.filter((n) => n.kind === "module").length}`,
          ].join("\n");
          return { title: "Atlas Index", output: withCoverage(graph, summary) };
        },
      }),

      mr_atlas_profile: tool({
        description: "Read generated repository profiles and applicable baseline rules for flow or blueprint context",
        args: {
          repo: tool.schema.string().optional().describe("Repository name; omit for all repositories"),
          files: tool.schema.array(tool.schema.string()).optional().describe("Target files used to filter appliesTo rules"),
        },
        execute: async (args, _context) => {
          if (workspace === undefined) return { title: "Atlas Profile", output: "No registered workspace profile is available." };
          const [profiles, rules] = await Promise.all([loadRepositoryProfiles(workspace), loadWorkspaceRules(workspace)]);
          if (profiles === undefined) return { title: "Atlas Profile", output: "No Atlas repository profile found. Run `mr atlas init`." };
          const selected = args.repo === undefined ? profiles : profiles.filter((profile) => profile.repo === args.repo);
          const digest = rules === undefined ? [] : rulesDigest(rules, args.repo, args.files ?? []);
          return { title: "Atlas Profile", output: compactJson({ profiles: selected, rules: digest }) };
        },
      }),

      mr_atlas_query: tool({
        description: "Query Atlas graph for node details, dependencies, dependents, impact analysis, or governance checks",
        args: {
          nodeName: tool.schema.string().optional().describe("Component, hook, function, or module name to find"),
          kind: tool.schema.enum(["component", "hook", "util", "service", "type", "constant", "function", "class", "interface", "module", "route", "entity", "contract", "federation-contract", "query-key", "slice", "server-action", "token"]).optional().describe("Node kind filter"),
          action: tool.schema.enum(["map", "info", "deps", "dependents", "impact", "slice", "tests", "semantic", "governance"]).optional().describe("Context level or query action"),
          depth: tool.schema.number().optional().describe("Impact-analysis depth (default 2)"),
          context: tool.schema.number().int().min(0).max(50).optional().describe("Context lines around a slice (default 0)"),
          filePath: tool.schema.string().optional().describe("File path for governance verification"),
          supports: tool.schema.array(tool.schema.string()).optional().describe("Requirement ids supported by semantic evidence"),
          symfonyConsoleIntrospection: tool.schema.boolean().optional().describe("Allow bounded Symfony console route/container introspection"),
        },
        execute: async (args, _context) => {
          const graph = await getOrIndexGraph();

          if (args.action === "map") {
            return { title: "Atlas Workspace Map", output: withCoverage(graph, renderWorkspaceMap(graph, outputLanguage)) };
          }

          if (args.action === "governance" || args.filePath !== undefined) {
            const govConfig = await loadGovernanceConfig(paths, workspaceId);
            if (govConfig === undefined) {
              return { title: "Atlas Governance", output: withCoverage(graph, "No governance configuration found for this workspace.", [args.filePath ?? ""]) };
            }
            const targetPath = args.filePath ?? "";
            const violations = checkGovernance(graph, govConfig, targetPath);
            if (violations.length === 0) {
              return { title: "Atlas Governance", output: withCoverage(graph, `✅ No governance violations found for \`${targetPath}\`.`, [targetPath]) };
            }
            const lines = [`# Governance Violations for \`${targetPath}\`:`, ""];
            for (const v of violations) {
              lines.push(`- **${v.id}** (${v.action}): ${v.reason}`);
            }
            return { title: "Atlas Governance", output: withCoverage(graph, lines.join("\n"), [targetPath]) };
          }

          if (args.nodeName !== undefined) {
            const node = findNodeByName(graph, args.nodeName);
            if (node === undefined) {
              const similar = graph.nodes
                .filter((n) => n.name.toLowerCase().includes((args.nodeName ?? "").toLowerCase()))
                .slice(0, 10);
              if (similar.length > 0) {
                const list = similar.map((n) => `- **${n.name}** (\`${n.kind}\` in \`${n.filePath}\`)`).join("\n");
                return { title: "Node Not Found", output: withCoverage(graph, `Node '${args.nodeName}' not found. Did you mean:\n${list}`) };
              }
              return { title: "Node Not Found", output: withCoverage(graph, `Node '${args.nodeName}' not found in Atlas graph.`) };
            }

            if (args.action === "slice") {
              const slice = await extractNodeSlice(workspaceRoot, node, args.context ?? 0);
              return { title: `Slice: ${node.name}`, output: withCoverage(graph, compactJson({ symbol: node.name, ...slice }), [node.filePath]) };
            }

            if (args.action === "tests") {
              const tests = findTestsFor(graph, node.id);
              const output = tests.length === 0 ? "No related tests detected." : tests.map((test) => `${test.filePath}:${test.line}`).join("\n");
              return { title: `Tests: ${node.name}`, output: withCoverage(graph, output, [node.filePath, ...tests.map((test) => test.filePath)]) };
            }

            if (args.action === "deps") {
              const deps = getNodeDependencies(graph, node.id);
              const lines = [`# Dependencies of ${node.name} (${node.kind}):`, ""];
              if (deps.length === 0) lines.push("No dependencies detected.");
              else deps.forEach((d) => { lines.push(`- **${d.name}** (\`${d.kind}\` in \`${d.filePath}:${d.line}\`)`); });
              return { title: `Dependencies of ${node.name}`, output: withCoverage(graph, lines.join("\n"), [node.filePath, ...deps.map((item) => item.filePath)]) };
            }

            if (args.action === "dependents") {
              const dependents = getNodeDependents(graph, node.id);
              const lines = [`# Dependents of ${node.name} (${node.kind}):`, ""];
              if (dependents.length === 0) lines.push("No dependents detected.");
              else dependents.forEach((d) => { lines.push(`- **${d.name}** (\`${d.kind}\` in \`${d.filePath}:${d.line}\`)`); });
              return { title: `Dependents of ${node.name}`, output: withCoverage(graph, lines.join("\n"), [node.filePath, ...dependents.map((item) => item.filePath)]) };
            }

            if (args.action === "impact") {
              const depth = args.depth ?? 2;
              const impact = getImpactAnalysis(graph, node.id, depth);
              const lines = [`# Impact Analysis for ${node.name} (depth: ${depth}):`, "", `Total affected nodes: ${impact.length}`, ""];
              impact.forEach((n) => { lines.push(`- **${n.name}** (\`${n.kind}\` in \`${n.filePath}\`)`); });
              return { title: `Impact Analysis: ${node.name}`, output: withCoverage(graph, lines.join("\n"), impact.map((item) => item.filePath)) };
            }

            if (args.action === "semantic") {
              if (/\.[jt]sx?$/u.test(node.filePath)) {
                const configs = graph.files
                  .filter((file) => /(?:^|\/)tsconfig[^/]*\.json$/u.test(file.path))
                  .filter((file) => node.filePath.startsWith(dirname(file.path) === "." ? "" : `${dirname(file.path)}/`))
                  .sort((left, right) => dirname(right.path).length - dirname(left.path).length);
                const tsconfig = configs[0]?.path;
                if (tsconfig === undefined) return { title: `Semantic: ${node.name}`, output: withCoverage(graph, "No tsconfig was found for this symbol.", [node.filePath]) };
                const service = createProjectService(join(workspaceRoot, tsconfig));
                try {
                  const references = service.findReferences(join(workspaceRoot, node.filePath), node.name);
                  const callers = service.getCallers(join(workspaceRoot, node.filePath), node.name, Math.min(2, args.depth ?? 2));
                  const type = service.getTypeAtSymbol(join(workspaceRoot, node.filePath), node.name);
                  const configRoot = dirname(tsconfig);
                  const workspacePath = (projectPath: string): string => configRoot === "." ? projectPath : join(configRoot, projectPath).replaceAll("\\", "/");
                  const callEdges = resolveTypeScriptCallEdges(graph, node, callers, configRoot);
                  const enriched = withAtlasEdges(graph, callEdges);
                  await saveAtlasGraph(paths, workspaceId, enriched);
                  let evidenceRef: string | undefined;
                  const flow = await loadFlowState(paths, workspaceId);
                  if (flow !== undefined && flowTicketId(flow) !== "pending") {
                    const evidence = await addEvidence(paths, workspaceId, workspaceRoot, flowTicketId(flow), {
                      file: node.filePath,
                      startLine: Math.max(1, node.line),
                      endLine: Math.max(1, node.endLine ?? node.line),
                      kind: "type",
                      source: "lsp",
                      claim: type.display,
                      supports: args.supports ?? [],
                      symbol: node.name,
                    });
                    evidenceRef = evidence.id;
                  }
                  return {
                    title: `Semantic: ${node.name}`,
                    output: withCoverage(enriched, compactJson({ type, references, callers, callEdges, ...(evidenceRef === undefined ? {} : { evidenceRef }) }), [node.filePath, ...references.map((reference) => workspacePath(reference.file))]),
                  };
                } catch (error: unknown) {
                  return { title: `Semantic: ${node.name}`, output: withCoverage(graph, `Semantic analysis unavailable: ${error instanceof Error ? error.message : String(error)}`, [node.filePath]) };
                }
              }
              if (node.filePath.endsWith(".php")) {
                const semantic = inspectPhpSemantics(workspaceRoot, [node.filePath], { symfonyConsoleIntrospection: args.symfonyConsoleIntrospection ?? false });
                const enriched = applyPhpSemanticResult(graph, semantic, node.filePath);
                await saveAtlasGraph(paths, workspaceId, enriched);
                return { title: `Semantic: ${node.name}`, output: withCoverage(enriched, compactJson(semantic), [node.filePath]) };
              }
              return { title: `Semantic: ${node.name}`, output: withCoverage(graph, "Semantic analysis is not available for this file type.", [node.filePath]) };
            }

            // Default: Node info
            const deps = getNodeDependencies(graph, node.id);
            const dependents = getNodeDependents(graph, node.id);
            const infoLines = [
              `# Atlas Node: ${node.name}`,
              ``,
              `- **Kind**: \`${node.kind}\``,
              `- **File**: \`${node.filePath}:${node.line}:${node.column}\``,
              `- **Exports**: ${node.exports.length > 0 ? node.exports.join(", ") : "none"}`,
              `- **Imports**: ${node.imports.length}`,
              `- **Dependencies count**: ${deps.length}`,
              `- **Dependents count**: ${dependents.length}`,
            ];
            return { title: `Node: ${node.name}`, output: withCoverage(graph, infoLines.join("\n"), [node.filePath]) };
          }

          if (args.kind !== undefined) {
            const nodes = findNodesByKind(graph, args.kind);
            const lines = [`# Nodes of kind '${args.kind}' (${nodes.length}):`, ""];
            nodes.slice(0, 30).forEach((n) => { lines.push(`- **${n.name}** (\`${n.filePath}:${n.line}\`)`); });
            if (nodes.length > 30) lines.push(`... and ${nodes.length - 30} more`);
            return { title: `Nodes: ${args.kind}`, output: withCoverage(graph, lines.join("\n"), nodes.map((node) => node.filePath)) };
          }

          // Summary
          const summary = [
            `# Atlas Graph Summary`,
            ``,
            `- **Workspace Root**: \`${graph.workspaceRoot}\``,
            `- **Indexed at**: ${graph.generatedAt}`,
            `- **Files**: ${graph.stats.totalFiles}`,
            `- **Nodes**: ${graph.stats.totalNodes}`,
            `- **Edges**: ${graph.stats.totalEdges}`,
          ].join("\n");
          return { title: "Atlas Summary", output: withCoverage(graph, summary) };
        },
      }),

      // ─── Trace Tools ───────────────────────────────────────────────────────

      mr_trace_component: tool({
        description: "Perform React forensic analysis and dependency tracing for a component",
        args: {
          componentName: tool.schema.string().describe("React component name to diagnose"),
        },
        execute: async (args, _context) => {
          const graph = await getOrIndexGraph();
          const report = traceComponent(graph, args.componentName);
          return { title: `Trace: ${args.componentName}`, output: renderTraceReport(report) };
        },
      }),

      // ─── Proposal Tools ────────────────────────────────────────────────────

      mr_propose_save: tool({
        description: "Save a finalized technical proposal into .aicontext/deliverables/mr/proposals/ (invoke ONLY after explicit user confirmation)",
        args: {
          title: tool.schema.string().describe("Technical proposal title"),
          context: tool.schema.string().describe("System or request context"),
          problem: tool.schema.string().describe("Problem to solve"),
          solution: tool.schema.string().describe("Proposed technical solution"),
          alternatives: tool.schema.array(tool.schema.string()).describe("Alternatives considered"),
          risks: tool.schema.array(tool.schema.string()).describe("Identified risks and mitigations"),
          estimatedEffort: tool.schema.enum(["XS", "S", "M", "L", "XL"]).describe("Effort estimate (XS, S, M, L, XL)"),
        },
        execute: async (args, _context) => {
          const input: ProposalInput = {
            title: args.title,
            context: args.context,
            problem: args.problem,
            solution: args.solution,
            alternatives: args.alternatives,
            risks: args.risks,
            estimatedEffort: args.estimatedEffort,
          };
          const savedPath = await saveProposal(paths, workspaceId, input, workspaceRoot);
          return {
            title: "Proposal Saved",
            output: `✅ Propuesta técnica guardada exitosamente en:\n\`${savedPath}\``,
          };
        },
      }),

      // ─── Prompt Tools ──────────────────────────────────────────────────────

      mr_prompt_build: tool({
        description: "Build an engineered prompt from a template (bugfix, feature, refactor, review) and variables",
        args: {
          template: tool.schema.enum(["bugfix", "feature", "refactor", "review"]).describe("Template to use"),
          variables: tool.schema.record(tool.schema.string(), tool.schema.string()).describe("Key-value template variables"),
        },
        execute: async (args, _context) => {
          const prompt = buildPrompt(args.template, args.variables);
          return { title: `Prompt: ${args.template}`, output: prompt };
        },
      }),

      mr_prompt_copy: tool({
        description: "Copy text to the OS clipboard via pbcopy or xclip (invoke ONLY after explicit user confirmation)",
        args: {
          text: tool.schema.string().describe("Prompt text to copy to the clipboard"),
        },
        execute: async (args, _context) => {
          await copyToClipboard(args.text);
          return {
            title: "Clipboard",
            output: "✅ Prompt copiado exitosamente al portapapeles del sistema.",
          };
        },
      }),

      // ─── SDD + RPI Tools (grafos tipados; markdown por script) ─────────────

      mr_evidence_add: tool({
        description: "Persist an exact, content-hashed source slice as reusable evidence for the active ticket",
        args: {
          file: tool.schema.string(),
          startLine: tool.schema.number().int().positive(),
          endLine: tool.schema.number().int().positive(),
          kind: tool.schema.enum(EvidenceKindSchema.options),
          source: tool.schema.enum(StoredEvidenceSourceSchema.options).optional(),
          claim: tool.schema.string(),
          supports: tool.schema.array(tool.schema.string()).optional(),
          symbol: tool.schema.string().optional(),
        },
        execute: async (args, _context) => {
          const state = await ensureFlowState();
          const ticketId = flowTicketId(state);
          const ref = await addEvidence(paths, workspaceId, workspaceRoot, ticketId, {
            file: args.file, startLine: args.startLine, endLine: args.endLine, kind: args.kind,
            source: args.source ?? "atlas", claim: args.claim,
            ...(args.supports === undefined ? {} : { supports: args.supports }),
            ...(args.symbol === undefined ? {} : { symbol: args.symbol }),
          });
          return { title: `Evidence: ${ref.id}`, output: compactJson({ id: ref.id, file: ref.file, range: ref.range, kind: ref.kind, supports: ref.supports }) };
        },
      }),

      mr_evidence_list: tool({
        description: "List reusable evidence references for the active ticket without loading slice bodies",
        args: {
          kind: tool.schema.enum(EvidenceKindSchema.options).optional(),
          supports: tool.schema.string().optional(),
          file: tool.schema.string().optional(),
        },
        execute: async (args, _context) => {
          const state = await ensureFlowState();
          const filter = {
            ...(args.kind === undefined ? {} : { kind: args.kind }),
            ...(args.supports === undefined ? {} : { supports: args.supports }),
            ...(args.file === undefined ? {} : { file: args.file }),
          };
          const refs = await listEvidence(paths, workspaceId, flowTicketId(state), filter);
          const output = refs.length === 0 ? "No evidence found." : refs.map((ref) => `${ref.id} · ${ref.kind} · ${ref.file}:${ref.range[0]}-${ref.range[1]} · ${ref.supports.join(",")} · ${ref.claim}`).join("\n");
          return { title: "Evidence", output };
        },
      }),

      mr_internal_receipt: tool({
        description: "Validate and minify an English internal execution receipt. Internal implementation and fix roles use this instead of prose handoffs.",
        args: {
          payload: tool.schema.string().describe("JSON matching InternalExecutionReceiptSchema"),
        },
        execute: async (args, context) => {
          let raw: unknown;
          try {
            raw = JSON.parse(args.payload);
          } catch (error) {
            return { title: "Internal Receipt Rejected", output: `Invalid JSON: ${(error as Error).message}` };
          }
          const parsed = InternalExecutionReceiptSchema.safeParse(raw);
          if (!parsed.success) {
            return { title: "Internal Receipt Rejected", output: formatZodIssues(parsed.error) };
          }
          const expectedRole: Readonly<Record<typeof parsed.data.role, ModelRole>> = {
            "mr-general": "general",
            "mr-sdd-apply": "sddApply",
            "mr-fix": "fix",
          };
          const caller = sessionModels.get(toolSessionID(context))?.role;
          if (caller !== undefined && caller !== expectedRole[parsed.data.role]) {
            return { title: "Internal Receipt Rejected", output: `Role mismatch: ${caller} cannot submit ${parsed.data.role}` };
          }
          return { title: "Internal Receipt", output: serializeInternalExecutionReceipt(parsed.data) };
        },
      }),

      mr_context_hydrate: tool({
        description: "Hydrate a deterministic, budgeted context bundle from stored evidence for a role and optional task",
        args: {
          role: tool.schema.enum(["plan", "implement", "judge-a", "judge-b", "fix"]),
          taskId: tool.schema.string().optional(),
          budgetChars: tool.schema.number().int().positive().optional(),
        },
        execute: async (args, context) => ({
          title: `Context: ${args.role}`,
          output: serializeBundle(await hydrateFor(args.role, args.taskId, args.budgetChars, toolSessionID(context))),
        }),
      }),

      mr_sdd_submit: tool({
        description: "Submit a typed SDD/RPI capsule as compact JSON (kind: research|brief|spec|tasks). brief is the Blueprint-lite planning assessment: NEEDS_INPUT returns up to 3 risk-prioritized questions without persistence; READY persists JSON only. Other kinds render user-facing markdown BY SCRIPT. Validation failures return exact issues.",
        args: {
          kind: tool.schema.enum(["research", "intent", "brief", "spec", "tasks"]).describe("Capsule kind: research (evidence), intent (grounded request), brief (Blueprint-lite), spec (requirements and criteria), or tasks (task graph)"),
          payload: tool.schema.string().describe("JSON matching the capsule's operational schema, without prose or audit timestamps such as createdAt"),
        },
        execute: async (args, _context) => {
          let raw: unknown;
          try {
            raw = JSON.parse(args.payload);
          } catch (error) {
            return { title: "SDD Invalid JSON", output: `❌ payload is not valid JSON: ${(error as Error).message}` };
          }

          const kind = args.kind as SddKind;
          const insufficient = InsufficientEvidenceSchema.safeParse(raw);
          if (insufficient.success) {
            return {
              title: `SDD ${kind} Blocked`,
              output: compactJson(insufficient.data),
            };
          }

          if (kind === "research") {
            const flow = await loadFlowState(paths, workspaceId);
            const intent = await loadIntentBrief(paths, workspaceId);
            if (flow !== undefined && flow.phase !== "intent" && flow.phase !== "wizard" && flow.phase !== "context") {
              const ticketId = "ticket" in flow ? flow.ticket.ref.id : ("ticketId" in flow ? flow.ticketId : undefined);
              if (intent === undefined || (ticketId !== undefined && intent.ticketId !== ticketId)) {
                return { title: "SDD Research Rejected", output: "❌ No READY intent capsule found. Complete intent grounding with mr_flow_intent before research." };
              }
            }
            const parsed = ResearchCapsulePayloadInputSchema.safeParse(raw);
            if (!parsed.success) {
              return { title: "SDD Research Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
            }
            const graph = await getOrIndexGraph();
            const coverage = {
              fresh: atlasFreshness.get(graph) ?? false,
              unsupportedFiles: [...graph.coverage.unsupportedFiles],
              unresolvedImports: graph.coverage.unresolvedImports.map((row) => `${row.from} → ${row.specifier}`),
            };
            let migrated;
            try {
              migrated = await migrateResearchToV2(parsed.data, async (evidence) => {
                const line = evidence.line ?? 1;
                const ref = await addEvidence(paths, workspaceId, workspaceRoot, parsed.data.ticketId, {
                  file: evidence.file,
                  startLine: line,
                  endLine: line,
                  kind: "behavior",
                  source: evidence.source,
                  claim: evidence.claim,
                });
                return ref.id;
              }, coverage);
            } catch (error: unknown) {
              return { title: "SDD Research Rejected", output: `❌ migration: ${error instanceof Error ? error.message : String(error)}` };
            }
            const store = await loadEvidenceStore(paths, workspaceId, migrated.ticketId);
            const knownRefs = new Set(store?.refs.map((ref) => ref.id) ?? []);
            const missingRefs = migrated.evidenceRefs.filter((id) => !knownRefs.has(id));
            if (missingRefs.length > 0) {
              return { title: "SDD Research Rejected", output: `❌ evidence refs not found: ${missingRefs.join(", ")}` };
            }
            const savedPath = await saveSddArtifact(paths, workspaceId, kind, migrated);
          const renderedPath = await writeSddMarkdown(kind, migrated.ticketId, renderResearchCapsule(migrated, outputLanguage));
            return {
              title: "SDD Research Saved",
              output: `✅ research: ${migrated.evidenceRefs.length} evidence refs, ${migrated.unknowns.length} unknowns\njson: ${savedPath}\nmd: ${renderedPath}`,
            };
          }

          if (kind === "intent") {
            const parsed = IntentAssessmentPayloadSchema.safeParse(raw);
            if (!parsed.success) {
              return { title: "SDD Intent Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
            }
            const flow = await loadFlowState(paths, workspaceId);
            if (flow !== undefined && "ticket" in flow && flow.ticket.ref.id !== parsed.data.ticketId) {
              return { title: "SDD Intent Rejected", output: `❌ Flow ticket '${flow.ticket.ref.id}' != intent ticket '${parsed.data.ticketId}'` };
            }
            if (parsed.data.status === "NEEDS_INPUT") {
              await rm(join(paths.generatedRoot, workspaceId, "sdd", "intent.json"), { force: true });
              return {
                title: "SDD Intent Input Required",
                output: compactJson(parsed.data),
              };
            }
            const savedPath = await saveSddArtifact(paths, workspaceId, kind, parsed.data);
            return {
              title: "SDD Intent Saved",
              output: `✅ intent: ${parsed.data.status} / ${parsed.data.mode}, ${parsed.data.acceptanceSignals.length} signals\njson: ${savedPath}\n\n${renderIntentAssessment(parsed.data, [], outputLanguage)}`,
            };
          }

          if (kind === "brief") {
            const parsed = PlanningAssessmentPayloadSchema.safeParse(raw);
            if (!parsed.success) {
              return { title: "SDD Planning Brief Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
            }
            const flow = await loadFlowState(paths, workspaceId);
            if (flow !== undefined && "ticket" in flow && flow.ticket.ref.id !== parsed.data.ticketId) {
              return { title: "SDD Planning Brief Rejected", output: `❌ Flow ticket '${flow.ticket.ref.id}' != planning brief ticket '${parsed.data.ticketId}'` };
            }
            if (parsed.data.status === "NEEDS_INPUT") {
              await rm(join(paths.generatedRoot, workspaceId, "sdd", "brief.json"), { force: true });
              return {
                title: "SDD Planning Input Required",
                output: compactJson(parsed.data),
              };
            }
            const savedPath = await saveSddArtifact(paths, workspaceId, kind, parsed.data);
            return {
              title: "SDD Planning Brief Saved",
              output: `✅ brief: ${parsed.data.mode}, ${parsed.data.decisions.length} decisiones, ${parsed.data.assumptions.length} supuestos\njson: ${savedPath}`,
            };
          }

          if (kind === "spec") {
            const parsed = SpecCapsulePayloadSchema.safeParse(raw);
            if (!parsed.success) {
              return { title: "SDD Spec Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
            }
            const brief = await loadPlanningBrief(paths, workspaceId);
            const flow = await loadFlowState(paths, workspaceId);
            if (flow !== undefined && (flow.phase === "explore" || flow.phase === "plan") && brief === undefined) {
              return { title: "SDD Spec Rejected", output: "❌ No READY planning brief found. Submit kind=brief before kind=spec." };
            }
            if (brief !== undefined && brief.ticketId !== parsed.data.ticketId) {
              return { title: "SDD Spec Rejected", output: `❌ Planning brief ticket '${brief.ticketId}' != spec ticket '${parsed.data.ticketId}'` };
            }
            const savedPath = await saveSddArtifact(paths, workspaceId, kind, parsed.data);
            const renderedPath = await writeSddMarkdown(kind, parsed.data.ticketId, renderSpecCapsule(parsed.data, outputLanguage));
            return {
              title: "SDD Spec Saved",
              output: `✅ spec: ${parsed.data.requirements.length} requirements\njson: ${savedPath}\nmd: ${renderedPath}`,
            };
          }

          const parsed = TaskGraphPayloadInputSchema.safeParse(raw);
          if (!parsed.success) {
            return { title: "SDD Tasks Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
          }
          const spec = await loadSpec(paths, workspaceId);
          if (spec === undefined) {
            return { title: "SDD Tasks Rejected", output: "❌ No spec found. Submit kind=spec before kind=tasks." };
          }
          const research = await loadResearch(paths, workspaceId);
          const flow = await loadFlowState(paths, workspaceId);
          const evidenceStore = research === undefined ? undefined : await loadEvidenceStore(paths, workspaceId, research.ticketId);
          const graph = evidenceStore === undefined ? undefined : await getOrIndexGraph();
          const freshness = evidenceStore === undefined || graph === undefined ? undefined : new Map(await Promise.all(evidenceStore.refs.map(async (ref) => [ref.id, await checkEvidenceFreshness(workspaceRoot, ref, graph)] as const)));
          let migrated;
          try {
            migrated = migrateTaskGraphToV2(parsed.data, research, evidenceStore);
          } catch (error: unknown) {
            return { title: "SDD Tasks Rejected", output: `❌ migration: ${error instanceof Error ? error.message : String(error)}` };
          }
          const workspaceRules = workspace === undefined ? undefined : await loadWorkspaceRules(workspace);
          const planned = workspaceRules === undefined ? migrated : {
            ...migrated,
            tasks: migrated.tasks.map((task) => {
              const firstPath = task.files[0]?.path;
              const repo = /^(?:repos|apps|packages)\/([^/]+)\//u.exec(firstPath ?? "")?.[1] ?? workspace?.name ?? ".";
              const invariants = ruleInvariants(workspaceRules, repo, task.files.map((file) => file.path));
              return { ...task, invariants: [...new Set([...task.invariants, ...invariants])] };
            }),
          };
          const issues = validateSddArtifacts(spec, planned, research, {
            requireEvidenceForModifiedFiles: gatesMode() === "block" && flow !== undefined && "difficulty" in flow && requiresJudgment(flow.lane ?? flow.difficulty),
            ...(evidenceStore === undefined ? {} : { evidenceStore }),
            ...(freshness === undefined ? {} : { freshness }),
          });
          const errors = issues.filter((issue) => issue.severity === "error");
          if (errors.length > 0) {
            return { title: "SDD Tasks Rejected", output: `❌ guardrails:\n${renderSddIssues(errors, outputLanguage)}` };
          }
          const planGate = gatePlan(spec, planned, research, evidenceStore, {
            full: flow !== undefined && "difficulty" in flow && requiresJudgment(flow.lane ?? flow.difficulty),
          });
          if (shouldBlockGate(planGate)) {
            return { title: "SDD Tasks Rejected", output: `❌ deterministic gates:\n${renderGateResult(planGate)}` };
          }
          const savedPath = await saveSddArtifact(paths, workspaceId, kind, planned);
          const renderedPath = await writeSddMarkdown(kind, planned.ticketId, renderTaskGraph(planned, outputLanguage));
          const warnings = issues.filter((issue) => issue.severity === "warning");
          const warningText = [
            warnings.length > 0 ? renderSddIssues(warnings, outputLanguage) : "",
            planGate.violations.length > 0 ? `Gates (${gatesMode()}):\n${renderGateResult(planGate)}` : "",
          ].filter(Boolean).map((message) => `\n${message}`).join("");
          return {
            title: "SDD Tasks Saved",
            output: `✅ tasks: ${planned.tasks.length} tasks validated against spec\njson: ${savedPath}\nmd: ${renderedPath}${warningText}`,
          };
        },
      }),

      mr_sdd_get: tool({
        description: "Read SDD/RPI capsules as compact JSON (token-cheap). kind=brief returns the persisted READY Blueprint-lite assessment. kind=next-task returns the next actionable task with acceptance criteria pre-joined.",
        args: {
          kind: tool.schema.enum(["research", "intent", "brief", "spec", "tasks", "next-task"]).describe("Capsule to read, or next-task for the next actionable task"),
        },
        execute: async (args, _context) => {
          if (args.kind === "research") {
            const research = await loadResearch(paths, workspaceId);
            if (research === undefined) return { title: "SDD Research", output: "No research capsule found." };
            return { title: "SDD Research", output: canonicalSddPayload(research) };
          }
          if (args.kind === "intent") {
            const intent = await loadIntentCapsule(paths, workspaceId);
            if (intent === undefined) return { title: "SDD Intent", output: "No intent capsule found." };
            return { title: "SDD Intent", output: canonicalSddPayload(intent) };
          }
          if (args.kind === "brief") {
            const brief = await loadPlanningBrief(paths, workspaceId);
            if (brief === undefined) return { title: "SDD Planning Brief", output: "No planning brief found." };
            return { title: "SDD Planning Brief", output: canonicalSddPayload(brief) };
          }
          if (args.kind === "spec") {
            const spec = await loadSpec(paths, workspaceId);
            if (spec === undefined) return { title: "SDD Spec", output: "No spec capsule found." };
            return { title: "SDD Spec", output: canonicalSddPayload(spec) };
          }
          if (args.kind === "tasks") {
            const tasks = await loadTasks(paths, workspaceId);
            if (tasks === undefined) return { title: "SDD Tasks", output: "No task graph found." };
            return { title: "SDD Tasks", output: canonicalSddPayload(tasks) };
          }
          const tasks = await loadTasks(paths, workspaceId);
          if (tasks === undefined) return { title: "SDD Next Task", output: "No task graph found. Submit kind=tasks first." };
          const next = nextPendingTask(tasks);
          if (next === undefined) {
            const doneCount = tasks.tasks.filter((t) => t.status === "done").length;
            return { title: "SDD Next Task", output: `No actionable task. Progress: ${doneCount}/${tasks.tasks.length} done.` };
          }
          const spec = await loadSpec(paths, workspaceId);
          const acceptance = spec?.requirements.filter((r) => next.requirements.includes(r.id)) ?? [];
          const flow = await loadFlowState(paths, workspaceId);
          const implementer = flow !== undefined && "difficulty" in flow
            ? implementationAgentForDifficulty(flow.difficulty, flow.lane)
            : undefined;
          const economy = flow === undefined || !("ticket" in flow)
            ? undefined
            : flowEconomyPolicy(effectiveLane(flow), flow.ticket.ref.platform !== "local");
          const bundle = await hydrateFor("implement", next.id, undefined, toolSessionID(_context)).catch(() => undefined);
          const store = await loadEvidenceStore(paths, workspaceId, tasks.ticketId);
          if (store === undefined) return { title: "SDD Task Blocked", output: "No EvidenceStore found for the task graph." };
          const graph = await getOrIndexGraph();
          const freshness = await getTaskEvidenceFreshness(next, store, graph);
          const implementGate = gateBeforeImplement(next, store, graph, freshness);
          if (shouldBlockGate(implementGate)) {
            return { title: "SDD Task Blocked", output: renderGateResult(implementGate) };
          }
          return {
            title: `SDD Next Task: ${next.id}`,
            output: compactJson({
              implementer,
              ...(economy === undefined ? {} : { economy }),
              developerNote: buildTaskDeveloperNote(next, acceptance, outputLanguage),
              task: next,
              acceptance,
              ...(bundle === undefined ? {} : { bundle }),
              ...(implementGate.violations.length === 0 ? {} : { gateWarnings: implementGate.violations }),
            }),
          };
        },
      }),

      mr_sdd_verify: tool({
        description: "Persist command results for an SDD task, bound to the current diff. Commands must exactly match task.verification.commands.",
        args: {
          taskId: tool.schema.string().describe("Task id (for example T1)"),
          results: tool.schema.array(tool.schema.object({
            command: tool.schema.string(),
            exitCode: tool.schema.number().int(),
            durationMs: tool.schema.number().int().nonnegative(),
            outputTail: tool.schema.string().optional(),
          })).min(1),
        },
        execute: async (args, _context) => {
          const tasks = await loadTasks(paths, workspaceId);
          const task = tasks?.tasks.find((candidate) => candidate.id === args.taskId);
          if (task === undefined) return { title: "SDD Verification Rejected", output: `Unknown task ${args.taskId}` };
          if (task.status !== "in_progress") {
            return { title: "SDD Verification Rejected", output: `${task.id} must be in_progress before verification; current status is ${task.status}.` };
          }
          const changedFiles = getGitDiffNames(workspaceRoot);
          const diffHash = await getDiffHash(workspaceRoot);
          const parsed = VerificationReceiptSchema.safeParse({
            schemaVersion: 1,
            taskId: args.taskId,
            results: args.results.map((entry) => ({ ...entry, outputTail: entry.outputTail ?? "" })),
            changedFiles,
            diffHash,
            recordedAt: new Date().toISOString(),
          });
          if (!parsed.success) {
            return { title: "SDD Verification Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
          }
          const baseGate = gateAfterImplement(task, changedFiles, parsed.data, diffHash);
          const rulesGate = await rulesGateForCurrentDiff();
          const gate: GateResult = { ok: baseGate.ok && rulesGate.ok, violations: [...baseGate.violations, ...rulesGate.violations] };
          if (shouldBlockGate(gate)) {
            return { title: "SDD Verification Rejected", output: renderGateResult(gate) };
          }
          const receiptPath = await saveVerificationReceipt(paths, workspaceId, parsed.data);
          return {
            title: "SDD Verification Recorded",
            output: `✅ ${task.id}: ${parsed.data.results.length} command result(s) bound to ${diffHash}\nreceipt: ${receiptPath}${gate.violations.length === 0 ? "" : `\nGates (${gatesMode()}):\n${renderGateResult(gate)}`}`,
          };
        },
      }),

      mr_sdd_task_status: tool({
        description: "Mark an SDD task status. done requires a current mr_sdd_verify receipt and a passing post-implementation gate.",
        args: {
          taskId: tool.schema.string().describe("Task ID (for example T1)"),
          status: tool.schema.enum(["pending", "in_progress", "done", "blocked"]).describe("New status"),
        },
        execute: async (args, _context) => {
          const tasks = await loadTasks(paths, workspaceId);
          if (tasks === undefined) return { title: "SDD Task Status", output: "No task graph found." };
          const task = tasks.tasks.find((candidate) => candidate.id === args.taskId);
          if (task === undefined) return { title: "SDD Task Status", output: `❌ Unknown task ${args.taskId}` };
          if (args.status === "in_progress") {
            const next = nextPendingTask(tasks);
            if (next?.id !== task.id) {
              return { title: "SDD Task Status Rejected", output: `${task.id} is not the next actionable task.` };
            }
            const store = await loadEvidenceStore(paths, workspaceId, tasks.ticketId);
            if (store === undefined) return { title: "SDD Task Status Rejected", output: "No EvidenceStore found for the task graph." };
            const graph = await getOrIndexGraph();
            const freshness = await getTaskEvidenceFreshness(task, store, graph);
            const implementGate = gateBeforeImplement(task, store, graph, freshness);
            if (shouldBlockGate(implementGate)) {
              return { title: "SDD Task Status Rejected", output: renderGateResult(implementGate) };
            }
          }
          if (args.status === "done") {
            if (task.status !== "in_progress") {
              return { title: "SDD Task Status Rejected", output: `${task.id} must be in_progress before it can be marked done.` };
            }
            const receipt = await loadVerificationReceipt(paths, workspaceId, task.id);
            if (receipt === undefined) {
              return { title: "SDD Task Status Rejected", output: `VERIFICATION_RECEIPT_MISSING: Run mr_sdd_verify for ${task.id} before marking it done.` };
            }
            const diffHash = await getDiffHash(workspaceRoot);
            const baseGate = gateAfterImplement(task, getGitDiffNames(workspaceRoot), receipt, diffHash);
            const rulesGate = await rulesGateForCurrentDiff();
            const afterGate: GateResult = { ok: baseGate.ok && rulesGate.ok, violations: [...baseGate.violations, ...rulesGate.violations] };
            if (shouldBlockGate(afterGate)) {
              return { title: "SDD Task Status Rejected", output: renderGateResult(afterGate) };
            }
          }
          let updated;
          try {
            updated = markTaskStatus(tasks, args.taskId, args.status);
          } catch (error) {
            return { title: "SDD Task Status", output: `❌ ${(error as Error).message}` };
          }
          await saveSddArtifact(paths, workspaceId, "tasks", updated);
          await writeSddMarkdown("tasks", updated.ticketId, renderTaskGraph(updated, outputLanguage));
          const doneCount = updated.tasks.filter((t) => t.status === "done").length;
          const next = nextPendingTask(updated);
          const nextHint = next !== undefined ? ` next: ${next.id}` : " all tasks resolved";
          return {
            title: "SDD Task Status",
            output: `✅ ${args.taskId} → ${args.status} (${doneCount}/${updated.tasks.length} done,${nextHint})`,
          };
        },
      }),

      mr_atlas_skeleton: tool({
        description: "Get a deterministic source/config skeleton with imports, docs, attributes and signatures; bodies are elided. Use signatures+calls for a cheap behavioral outline.",
        args: {
          filePath: tool.schema.string().describe("Workspace-relative source or configuration path"),
          depth: tool.schema.enum(["signatures", "signatures+calls"]).optional().describe("Skeleton detail level (default signatures)"),
        },
        execute: async (args, _context) => {
          let source: string;
          try {
            source = await readFile(join(workspaceRoot, args.filePath), "utf8");
          } catch {
            return { title: "Skeleton", output: `❌ Cannot read ${args.filePath}` };
          }
          const skeleton = await extractSkeleton(source, args.filePath, args.depth ?? "signatures");
          if (skeleton === "") {
            return { title: "Skeleton", output: `❌ Unsupported or unparseable file: ${args.filePath}` };
          }
          const ratio = Math.round((skeleton.length / Math.max(1, source.length)) * 100);
          const graph = await getOrIndexGraph();
          return {
            title: `Skeleton: ${args.filePath}`,
            output: withCoverage(graph, `\`\`\`\n${skeleton}\n\`\`\`\n(${ratio}% of original size)`, [args.filePath]),
          };
        },
      }),

      // ─── Memory Tools (Pilar 5: Amnesia de Contexto & Memoria Persistente) ───

      mr_memory_save: tool({
        description: "Save an architectural observation, invariant, or decision into the persistent memory store stamped with the current git tree hash",
        args: {
          topic: tool.schema.string().describe("Topic or namespace for the memory (e.g. 'auth/jwt', 'architecture/db')"),
          content: tool.schema.string().describe("The observation, invariant, or architectural decision content"),
          metadata: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional().describe("Optional metadata"),
        },
        execute: async (args, _context) => {
          const store = new PersistentMemoryStore(paths, workspaceId, workspaceRoot);
          const obs = await store.saveObservation(args.topic, args.content, args.metadata ?? {});
          return {
            title: "Memory Saved",
            output: `Saved memory [${obs.id}] under topic '${obs.topic}' with git stamp [${obs.gitStamp ?? "no-git"}].`,
          };
        },
      }),

      mr_memory_query: tool({
        description: "Query architectural memories with fail-closed staleness detection against working tree drift",
        args: {
          topic: tool.schema.string().optional().describe("Filter by topic"),
          query: tool.schema.string().optional().describe("Filter by content substring"),
          validateFreshness: tool.schema.boolean().optional().describe("Whether to validate against current git stamp (default true)"),
        },
        execute: async (args, _context) => {
          const store = new PersistentMemoryStore(paths, workspaceId, workspaceRoot);
          const results = await store.query({
            topic: args.topic,
            query: args.query,
            validateFreshness: args.validateFreshness ?? true,
          });
          return {
            title: "Memory Query",
            output: JSON.stringify(results, null, 2),
          };
        },
      }),
    },
  };
}

export const MrOrchestrator: Plugin = (ctx) => createMrOrchestrator(ctx);
