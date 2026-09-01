import { tool, type Plugin } from "@opencode-ai/plugin";
import { loadFlowState, clearFlowState, applyEvent } from "./core/flow-state.js";
import { loadRegistry, detectWorkspace } from "./core/workspace.js";
import { resolvePaths } from "./core/paths.js";
import { renderPlanCapsule, renderFlowStatus, renderVerdict } from "./core/render.js";
import { loadModels } from "./core/config.js";
import { discoverAvailableModels, ROLES, setModelRole } from "./core/models.js";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FlowState, FlowEvent, PlanCapsule, MergedVerdict } from "./core/flow-schema.js";
import {
  AtlasIndexer,
  loadAtlasGraph,
  saveAtlasGraph,
  findNodeByName,
  findNodesByKind,
  getNodeDependencies,
  getNodeDependents,
  getImpactAnalysis,
  loadGovernanceConfig,
  checkGovernance,
  computeGitStamp,
  extractSkeleton,
  type AtlasGraph,
} from "./core/atlas.js";
import {
  ResearchCapsuleSchema,
  SpecCapsuleSchema,
  TaskGraphSchema,
  validateSddArtifacts,
  nextPendingTask,
  markTaskStatus,
  saveSddArtifact,
  loadResearch,
  loadSpec,
  loadTasks,
  formatZodIssues,
  type SddKind,
} from "./core/sdd-schema.js";
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

// ─── Plugin ──────────────────────────────────────────────────────────────────

export const MrOrchestrator: Plugin = async (ctx) => {
  const paths = resolvePaths();
  const registry = await loadRegistry(paths);
  const workspace = detectWorkspace(registry, ctx.directory);
  const workspaceId = workspace?.id ?? "unknown";
  const workspaceRoot = workspace?.root ?? ctx.directory;

  async function ensureFlowState(): Promise<FlowState> {
    const state = await loadFlowState(paths, workspaceId);
    if (state === undefined) {
      throw new Error("No active flow. Run `/flow` to start.");
    }
    return state;
  }

  async function getOrIndexGraph(): Promise<AtlasGraph> {
    const stamp = computeGitStamp(workspaceRoot);
    const cached = await loadAtlasGraph(paths, workspaceId);
    if (cached !== undefined && stamp !== undefined && cached.gitStamp === stamp) {
      return cached;
    }
    if (cached !== undefined && stamp === undefined) {
      // No git context: keep cache (legacy behavior)
      return cached;
    }
    const indexer = new AtlasIndexer();
    const graph = await indexer.indexWorkspace(workspaceRoot);
    await saveAtlasGraph(paths, workspaceId, graph);
    return graph;
  }

  async function writeSddMarkdown(kind: SddKind, ticketId: string, markdown: string): Promise<string> {
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
    tool: {
      // ─── Flow Tools ────────────────────────────────────────────────────────

      mr_flow_status: tool({
        description: "Get the current mr-orchestrator flow status",
        args: {},
        execute: async (_args, _context) => {
          const state = await loadFlowState(paths, workspaceId);
          if (state === undefined) {
            return { title: "Flow Status", output: "No active flow. Run `/flow` to start." };
          }
          return { title: "Flow Status", output: renderFlowStatus(state) };
        },
      }),

      mr_flow_start: tool({
        description: "Start a new mr-orchestrator flow",
        args: {
          difficulty: tool.schema.number().describe("Dificultad de la tarea (Fibonacci: 1, 3, 5, 8, 13, 21). 1-3 = Lite, >=5 = Full."),
          ticketId: tool.schema.string().describe("Identificador del ticket (ej: GH-42, 123)"),
          hasFigma: tool.schema.boolean().optional().describe("Indica si existe diseño en Figma para la tarea"),
        },
        execute: async (args, _context) => {
          const rawDifficulty = args.difficulty;
          const validDifficulties: (1 | 3 | 5 | 8 | 13 | 21)[] = [1, 3, 5, 8, 13, 21];
          const difficulty = validDifficulties.includes(rawDifficulty as 1 | 3 | 5 | 8 | 13 | 21)
            ? (rawDifficulty as 1 | 3 | 5 | 8 | 13 | 21)
            : 3;
          const ticketId = args.ticketId;
          const hasFigma = args.hasFigma ?? false;
          const event: FlowEvent = {
            type: "wizard_complete",
            difficulty,
            ticketId,
            hasFigma,
          };
          const state = await applyEvent(paths, workspaceId, event);
          return { title: "Flow Started", output: renderFlowStatus(state) };
        },
      }),

      mr_flow_ticket: tool({
        description: "Load ticket content into the flow",
        args: {
          title: tool.schema.string().describe("Título del ticket"),
          description: tool.schema.string().describe("Descripción del ticket"),
          type: tool.schema.enum(["feature", "bugfix", "hotfix", "release", "chore"]).optional().describe("Tipo de ticket"),
          platform: tool.schema.enum(["github", "jira", "gitlab"]).optional().describe("Plataforma de tickets"),
          branch: tool.schema.string().optional().describe("Rama git calculada"),
          baseBranch: tool.schema.string().optional().describe("Rama base (develop o main)"),
        },
        execute: async (args, _context) => {
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
            },
            branch,
            baseBranch,
          };
          const next = await applyEvent(paths, workspaceId, event);
          return { title: "Ticket Loaded", output: renderFlowStatus(next) };
        },
      }),

      mr_flow_plan: tool({
        description: "Submit an implementation plan for approval",
        args: {
          summary: tool.schema.string().describe("Resumen ejecutivo del plan de implementación"),
          rootCause: tool.schema.string().optional().describe("Causa raíz identificada (para bugs)"),
          files: tool.schema.array(
            tool.schema.object({
              path: tool.schema.string().describe("Ruta del archivo"),
              action: tool.schema.enum(["create", "modify", "delete", "rename"]).describe("Acción a realizar"),
              reason: tool.schema.string().describe("Motivo del cambio"),
              risk: tool.schema.enum(["low", "medium", "high"]).optional().describe("Nivel de riesgo"),
            }),
          ).describe("Archivos afectados por el plan"),
          tests: tool.schema.array(
            tool.schema.object({
              path: tool.schema.string().describe("Ruta del test"),
              type: tool.schema.enum(["unit", "integration", "e2e"]).describe("Tipo de test"),
              description: tool.schema.string().describe("Descripción del test"),
            }),
          ).optional().describe("Tests planificados"),
        },
        execute: async (args, _context) => {
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
          const event: FlowEvent = { type: "plan_approved", plan };
          const next = await applyEvent(paths, workspaceId, event);
          return { title: "Plan Approved", output: `${renderPlanCapsule(plan)}\n\n${renderFlowStatus(next)}` };
        },
      }),

      mr_flow_implement: tool({
        description: "Mark implementation as complete",
        args: {
          completedFiles: tool.schema.array(tool.schema.string()).describe("Lista de rutas de archivos modificados o creados"),
        },
        execute: async (args, _context) => {
          const state = await ensureFlowState();
          if (state.phase !== "implement") {
            return { title: "Error", output: `Cannot complete implementation in phase ${state.phase}. Expected 'implement'.` };
          }
          const completedFiles = args.completedFiles ?? [];
          const event: FlowEvent = { type: "implement_done", completedFiles };
          const next = await applyEvent(paths, workspaceId, event);
          if (next.phase === "judgment") {
            return { title: "Judgment Required", output: `Implementation complete. Difficulty ${next.difficulty} >= 5 requires judgment phase.\n\n${renderFlowStatus(next)}` };
          }
          return { title: "Implementation Complete", output: renderFlowStatus(next) };
        },
      }),

      mr_flow_judge: tool({
        description: "Submit a judge verdict for the current diff",
        args: {
          judge: tool.schema.enum(["a", "b"]).describe("Identificador del juez revisor ('a' o 'b')"),
          approved: tool.schema.boolean().describe("Si el juez aprueba los cambios sin objeciones críticas"),
          critical: tool.schema.array(tool.schema.string()).optional().describe("Problemas críticos que bloquean la aprobación"),
          warnings: tool.schema.array(tool.schema.string()).optional().describe("Advertencias no bloqueantes"),
          suggestions: tool.schema.array(tool.schema.string()).optional().describe("Sugerencias de mejora"),
        },
        execute: async (args, _context) => {
          const state = await ensureFlowState();
          if (state.phase !== "judgment") {
            return { title: "Error", output: `Cannot judge in phase ${state.phase}. Expected 'judgment'.` };
          }
          const judge = args.judge;
          const approved = args.approved;
          const critical = args.critical ?? [];
          const warnings = args.warnings ?? [];
          const suggestions = args.suggestions ?? [];

          // Store individual verdict
          const verdictDir = join(paths.generatedRoot, workspaceId);
          await mkdir(verdictDir, { recursive: true });
          const verdictPath = join(verdictDir, `verdict-${judge}.json`);
          await writeFile(verdictPath, JSON.stringify({
            schemaVersion: 1,
            judge,
            approved,
            critical,
            warnings,
            suggestions,
            reviewedAt: new Date().toISOString(),
          }, null, 2));

          // Check if both judges have voted
          const verdictAPath = join(verdictDir, "verdict-a.json");
          const verdictBPath = join(verdictDir, "verdict-b.json");
          const [verdictA, verdictB] = await Promise.all([
            readFile(verdictAPath, "utf8").then((c) => JSON.parse(c) as { approved: boolean; critical: string[]; warnings: string[]; suggestions: string[] }).catch(() => null),
            readFile(verdictBPath, "utf8").then((c) => JSON.parse(c) as { approved: boolean; critical: string[]; warnings: string[]; suggestions: string[] }).catch(() => null),
          ]);

          if (verdictA === null || verdictB === null) {
            return { title: "Verdict Recorded", output: `Judge ${judge} verdict recorded. Waiting for other judge.` };
          }

          // Merge verdicts
          const merged: MergedVerdict = {
            schemaVersion: 1,
            approved: verdictA.approved && verdictB.approved,
            critical: [...verdictA.critical, ...verdictB.critical],
            warnings: [...verdictA.warnings, ...verdictB.warnings],
            suggestions: [...verdictA.suggestions, ...verdictB.suggestions],
            judgeA: { schemaVersion: 1, judge: "a", ...verdictA, reviewedAt: new Date().toISOString() },
            judgeB: { schemaVersion: 1, judge: "b", ...verdictB, reviewedAt: new Date().toISOString() },
            mergedAt: new Date().toISOString(),
          };

          const event: FlowEvent = merged.approved
            ? { type: "judgment_passed" }
            : { type: "judgment_failed", verdict: { critical: merged.critical, warnings: merged.warnings, suggestions: merged.suggestions } };
          const next = await applyEvent(paths, workspaceId, event);

          return { title: "Judgment Complete", output: `${renderVerdict(merged)}\n\n${renderFlowStatus(next)}` };
        },
      }),

      mr_flow_fix: tool({
        description: "Mark fixes as applied and return to implementation",
        args: {},
        execute: async (_args, _context) => {
          const state = await ensureFlowState();
          if (state.phase !== "fix") {
            return { title: "Error", output: `Cannot fix in phase ${state.phase}. Expected 'fix'.` };
          }
          const event: FlowEvent = { type: "fix_done" };
          const next = await applyEvent(paths, workspaceId, event);
          return { title: "Fix Applied", output: renderFlowStatus(next) };
        },
      }),

      mr_flow_finish: tool({
        description: "Finish the flow with commit and optional PR",
        args: {
          commitHash: tool.schema.string().optional().describe("Hash del commit generado"),
          prUrl: tool.schema.string().optional().describe("URL de la Pull Request creada"),
        },
        execute: async (args, _context) => {
          const state = await ensureFlowState();
          if (state.phase !== "finish") {
            return { title: "Error", output: `Cannot finish in phase ${state.phase}. Expected 'finish'.` };
          }
          const commitHash = args.commitHash;
          const prUrl = args.prUrl;
          const event: FlowEvent = { type: "finish_confirmed", commitHash, prUrl };
          const next = await applyEvent(paths, workspaceId, event);
          await clearFlowState(paths, workspaceId);
          return { title: "Flow Complete", output: renderFlowStatus(next) };
        },
      }),

      mr_flow_abort: tool({
        description: "Abort the current flow",
        args: {},
        execute: async (_args, _context) => {
          await ensureFlowState();
          const event: FlowEvent = { type: "abort" };
          const _next = await applyEvent(paths, workspaceId, event);
          await clearFlowState(paths, workspaceId);
          return { title: "Flow Aborted", output: "Flow has been aborted and state cleared." };
        },
      }),

      mr_models: tool({
        description: "List or update mr-orchestrator model assignments for the interactive /flow-models workflow",
        args: {
          action: tool.schema.enum(["status", "providers", "models", "set"]).optional()
            .describe("status=current roster, providers=available providers, models=models for provider, set=save role/model"),
          role: tool.schema.enum(["orchestrator", "explore", "plan", "general", "sddApply", "judgeA", "judgeB", "fix"])
            .optional().describe("Process/step role to update"),
          provider: tool.schema.string().optional().describe("Provider ID used by action=models"),
          model: tool.schema.string().optional().describe("Full provider/model-id used by action=set"),
        },
        execute: async (args, _context) => {
          const action = args.action ?? "status";
          if (action === "providers" || action === "models") {
            const catalog = discoverAvailableModels();
            const available = catalog.models.filter((model) => !model.startsWith("openrouter/"));
            if (action === "providers") {
              const providers = Array.from(new Set(available.map((model) => model.split("/", 1)[0]))).sort();
              const warning = catalog.warning === undefined ? "" : `\n\nAviso: ${catalog.warning}`;
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
          if (action === "set") {
            if (args.role === undefined || args.model === undefined) {
              throw new Error("action=set requires role and model");
            }
            const model = args.model.trim();
            if (!/^[^\s/]+\/.+$/u.test(model)) throw new Error("model must use provider/model-id format");
            await setModelRole(paths, args.role, model);
            return { title: "Model Updated", output: `${args.role} → ${model}` };
          }

          const models = await loadModels(paths);
          const lines = ["# Roster de Modelos mr-orchestrator", ""];
          for (const meta of ROLES) {
            lines.push(`- **${meta.label}** (${meta.role}): \`${models.roles[meta.role]}\``);
          }
          lines.push("", "Editor directo: `mr flow-models`");
          return { title: "Model Roster", output: lines.join("\n") };
        },
      }),

      // ─── Atlas Tools ───────────────────────────────────────────────────────

      mr_atlas_index: tool({
        description: "Index workspace source (TS/TSX/Java) and configuration (JSON/YML/YAML) into the Atlas graph",
        args: {
          includePatterns: tool.schema.array(tool.schema.string()).optional().describe("Patrones glob a incluir (por defecto código y configs en src/** y repos/**)"),
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
          return { title: "Atlas Index", output: summary };
        },
      }),

      mr_atlas_query: tool({
        description: "Query Atlas graph for node details, dependencies, dependents, impact analysis, or governance checks",
        args: {
          nodeName: tool.schema.string().optional().describe("Nombre del componente, hook, función o módulo a buscar"),
          kind: tool.schema.enum(["component", "hook", "util", "service", "type", "constant", "function", "class", "interface", "module"]).optional().describe("Filtrar por tipo de nodo"),
          action: tool.schema.enum(["info", "deps", "dependents", "impact", "governance"]).optional().describe("Acción de consulta: 'info', 'deps', 'dependents', 'impact', 'governance'"),
          depth: tool.schema.number().optional().describe("Profundidad para análisis de impacto (por defecto 2)"),
          filePath: tool.schema.string().optional().describe("Ruta de archivo para verificación de gobernanza"),
        },
        execute: async (args, _context) => {
          const graph = await getOrIndexGraph();

          if (args.action === "governance" || args.filePath !== undefined) {
            const govConfig = await loadGovernanceConfig(paths, workspaceId);
            if (govConfig === undefined) {
              return { title: "Atlas Governance", output: "No governance configuration found for this workspace." };
            }
            const targetPath = args.filePath ?? "";
            const violations = checkGovernance(graph, govConfig, targetPath);
            if (violations.length === 0) {
              return { title: "Atlas Governance", output: `✅ No governance violations found for \`${targetPath}\`.` };
            }
            const lines = [`# Governance Violations for \`${targetPath}\`:`, ""];
            for (const v of violations) {
              lines.push(`- **${v.id}** (${v.action}): ${v.reason}`);
            }
            return { title: "Atlas Governance", output: lines.join("\n") };
          }

          if (args.nodeName !== undefined) {
            const node = findNodeByName(graph, args.nodeName);
            if (node === undefined) {
              const similar = graph.nodes
                .filter((n) => n.name.toLowerCase().includes((args.nodeName ?? "").toLowerCase()))
                .slice(0, 10);
              if (similar.length > 0) {
                const list = similar.map((n) => `- **${n.name}** (\`${n.kind}\` in \`${n.filePath}\`)`).join("\n");
                return { title: "Node Not Found", output: `Node '${args.nodeName}' not found. Did you mean:\n${list}` };
              }
              return { title: "Node Not Found", output: `Node '${args.nodeName}' not found in Atlas graph.` };
            }

            if (args.action === "deps") {
              const deps = getNodeDependencies(graph, node.id);
              const lines = [`# Dependencies of ${node.name} (${node.kind}):`, ""];
              if (deps.length === 0) lines.push("No dependencies detected.");
              else deps.forEach((d) => { lines.push(`- **${d.name}** (\`${d.kind}\` in \`${d.filePath}:${d.line}\`)`); });
              return { title: `Dependencies of ${node.name}`, output: lines.join("\n") };
            }

            if (args.action === "dependents") {
              const dependents = getNodeDependents(graph, node.id);
              const lines = [`# Dependents of ${node.name} (${node.kind}):`, ""];
              if (dependents.length === 0) lines.push("No dependents detected.");
              else dependents.forEach((d) => { lines.push(`- **${d.name}** (\`${d.kind}\` in \`${d.filePath}:${d.line}\`)`); });
              return { title: `Dependents of ${node.name}`, output: lines.join("\n") };
            }

            if (args.action === "impact") {
              const depth = args.depth ?? 2;
              const impact = getImpactAnalysis(graph, node.id, depth);
              const lines = [`# Impact Analysis for ${node.name} (depth: ${depth}):`, "", `Total affected nodes: ${impact.length}`, ""];
              impact.forEach((n) => { lines.push(`- **${n.name}** (\`${n.kind}\` in \`${n.filePath}\`)`); });
              return { title: `Impact Analysis: ${node.name}`, output: lines.join("\n") };
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
            return { title: `Node: ${node.name}`, output: infoLines.join("\n") };
          }

          if (args.kind !== undefined) {
            const nodes = findNodesByKind(graph, args.kind);
            const lines = [`# Nodes of kind '${args.kind}' (${nodes.length}):`, ""];
            nodes.slice(0, 30).forEach((n) => { lines.push(`- **${n.name}** (\`${n.filePath}:${n.line}\`)`); });
            if (nodes.length > 30) lines.push(`... and ${nodes.length - 30} more`);
            return { title: `Nodes: ${args.kind}`, output: lines.join("\n") };
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
          return { title: "Atlas Summary", output: summary };
        },
      }),

      // ─── Trace Tools ───────────────────────────────────────────────────────

      mr_trace_component: tool({
        description: "Perform React forensic analysis and dependency tracing for a component",
        args: {
          componentName: tool.schema.string().describe("Nombre del componente React a diagnosticar"),
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
          title: tool.schema.string().describe("Título de la propuesta técnica"),
          context: tool.schema.string().describe("Contexto del sistema o requerimiento"),
          problem: tool.schema.string().describe("Problema a resolver"),
          solution: tool.schema.string().describe("Solución técnica propuesta"),
          alternatives: tool.schema.array(tool.schema.string()).describe("Alternativas evaluadas"),
          risks: tool.schema.array(tool.schema.string()).describe("Riesgos identificados y mitigaciones"),
          estimatedEffort: tool.schema.enum(["XS", "S", "M", "L", "XL"]).describe("Estimación de esfuerzo (XS, S, M, L, XL)"),
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
          template: tool.schema.enum(["bugfix", "feature", "refactor", "review"]).describe("Plantilla a utilizar"),
          variables: tool.schema.record(tool.schema.string(), tool.schema.string()).describe("Variables clave-valor para la plantilla"),
        },
        execute: async (args, _context) => {
          const prompt = buildPrompt(args.template, args.variables);
          return { title: `Prompt: ${args.template}`, output: prompt };
        },
      }),

      mr_prompt_copy: tool({
        description: "Copy text to the OS clipboard via pbcopy or xclip (invoke ONLY after explicit user confirmation)",
        args: {
          text: tool.schema.string().describe("Texto del prompt a copiar al portapapeles"),
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

      mr_sdd_submit: tool({
        description: "Submit a typed SDD/RPI capsule as compact JSON (kind: research|spec|tasks). Validates with zod + structural guardrails; on success renders user-facing markdown BY SCRIPT and returns a compact ack. On validation failure returns the exact issues to fix — retry with corrected JSON.",
        args: {
          kind: tool.schema.enum(["research", "spec", "tasks"]).describe("Tipo de cápsula: research (evidencias explore), spec (requisitos+criterios), tasks (grafo de tareas)"),
          payload: tool.schema.string().describe("JSON compacto conforme al schema de la cápsula (sin prosa)"),
        },
        execute: async (args, _context) => {
          let raw: unknown;
          try {
            raw = JSON.parse(args.payload);
          } catch (error) {
            return { title: "SDD Invalid JSON", output: `❌ payload is not valid JSON: ${(error as Error).message}` };
          }

          const kind = args.kind as SddKind;

          if (kind === "research") {
            const parsed = ResearchCapsuleSchema.safeParse(raw);
            if (!parsed.success) {
              return { title: "SDD Research Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
            }
            const savedPath = await saveSddArtifact(paths, workspaceId, kind, parsed.data);
            const renderedPath = await writeSddMarkdown(kind, parsed.data.ticketId, renderResearchCapsule(parsed.data));
            return {
              title: "SDD Research Saved",
              output: `✅ research: ${parsed.data.evidence.length} evidencias, ${parsed.data.unknowns.length} incógnitas\njson: ${savedPath}\nmd: ${renderedPath}`,
            };
          }

          if (kind === "spec") {
            const parsed = SpecCapsuleSchema.safeParse(raw);
            if (!parsed.success) {
              return { title: "SDD Spec Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
            }
            const savedPath = await saveSddArtifact(paths, workspaceId, kind, parsed.data);
            const renderedPath = await writeSddMarkdown(kind, parsed.data.ticketId, renderSpecCapsule(parsed.data));
            return {
              title: "SDD Spec Saved",
              output: `✅ spec: ${parsed.data.requirements.length} requisitos\njson: ${savedPath}\nmd: ${renderedPath}`,
            };
          }

          const parsed = TaskGraphSchema.safeParse(raw);
          if (!parsed.success) {
            return { title: "SDD Tasks Rejected", output: `❌ schema: ${formatZodIssues(parsed.error)}` };
          }
          const spec = await loadSpec(paths, workspaceId);
          if (spec === undefined) {
            return { title: "SDD Tasks Rejected", output: "❌ No spec found. Submit kind=spec before kind=tasks." };
          }
          const research = await loadResearch(paths, workspaceId);
          const issues = validateSddArtifacts(spec, parsed.data, research);
          const errors = issues.filter((issue) => issue.severity === "error");
          if (errors.length > 0) {
            return { title: "SDD Tasks Rejected", output: `❌ guardrails:\n${renderSddIssues(errors)}` };
          }
          const savedPath = await saveSddArtifact(paths, workspaceId, kind, parsed.data);
          const renderedPath = await writeSddMarkdown(kind, parsed.data.ticketId, renderTaskGraph(parsed.data));
          const warnings = issues.filter((issue) => issue.severity === "warning");
          const warningText = warnings.length > 0 ? `\n${renderSddIssues(warnings)}` : "";
          return {
            title: "SDD Tasks Saved",
            output: `✅ tasks: ${parsed.data.tasks.length} tareas validadas contra spec\njson: ${savedPath}\nmd: ${renderedPath}${warningText}`,
          };
        },
      }),

      mr_sdd_get: tool({
        description: "Read SDD/RPI capsules as compact JSON (token-cheap). kind=next-task returns the next actionable task with its acceptance criteria pre-joined — the exact briefing to implement now.",
        args: {
          kind: tool.schema.enum(["research", "spec", "tasks", "next-task"]).describe("Cápsula a leer, o next-task para la siguiente tarea accionable"),
        },
        execute: async (args, _context) => {
          if (args.kind === "research") {
            const research = await loadResearch(paths, workspaceId);
            if (research === undefined) return { title: "SDD Research", output: "No research capsule found." };
            return { title: "SDD Research", output: JSON.stringify(research) };
          }
          if (args.kind === "spec") {
            const spec = await loadSpec(paths, workspaceId);
            if (spec === undefined) return { title: "SDD Spec", output: "No spec capsule found." };
            return { title: "SDD Spec", output: JSON.stringify(spec) };
          }
          if (args.kind === "tasks") {
            const tasks = await loadTasks(paths, workspaceId);
            if (tasks === undefined) return { title: "SDD Tasks", output: "No task graph found." };
            return { title: "SDD Tasks", output: JSON.stringify(tasks) };
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
          return {
            title: `SDD Next Task: ${next.id}`,
            output: JSON.stringify({ task: next, acceptance }),
          };
        },
      }),

      mr_sdd_task_status: tool({
        description: "Mark an SDD task status (deterministic progression). Marks done ONLY after its verify commands pass.",
        args: {
          taskId: tool.schema.string().describe("Id de la tarea (ej: T1)"),
          status: tool.schema.enum(["pending", "in_progress", "done", "blocked"]).describe("Nuevo estado"),
        },
        execute: async (args, _context) => {
          const tasks = await loadTasks(paths, workspaceId);
          if (tasks === undefined) return { title: "SDD Task Status", output: "No task graph found." };
          let updated;
          try {
            updated = markTaskStatus(tasks, args.taskId, args.status);
          } catch (error) {
            return { title: "SDD Task Status", output: `❌ ${(error as Error).message}` };
          }
          await saveSddArtifact(paths, workspaceId, "tasks", updated);
          await writeSddMarkdown("tasks", updated.ticketId, renderTaskGraph(updated));
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
        description: "Get the deterministic skeleton of a source or config file: code (.ts/.tsx/.java) → imports + signatures, bodies elided; config (.json/.yml/.yaml) → key structure with truncated values (great for application.yml / OpenAPI specs). ~85-90% fewer tokens than reading the file. Read full bodies only for the code being edited.",
        args: {
          filePath: tool.schema.string().describe("Ruta del archivo relativa a la raíz del workspace (.ts, .tsx, .java, .json, .yml, .yaml)"),
        },
        execute: async (args, _context) => {
          let source: string;
          try {
            source = await readFile(join(workspaceRoot, args.filePath), "utf8");
          } catch {
            return { title: "Skeleton", output: `❌ Cannot read ${args.filePath}` };
          }
          const skeleton = await extractSkeleton(source, args.filePath);
          if (skeleton === "") {
            return { title: "Skeleton", output: `❌ Unsupported or unparseable file: ${args.filePath}` };
          }
          const ratio = Math.round((skeleton.length / Math.max(1, source.length)) * 100);
          return {
            title: `Skeleton: ${args.filePath}`,
            output: `\`\`\`\n${skeleton}\n\`\`\`\n(${ratio}% del tamaño original)`,
          };
        },
      }),
    },
  };
};
