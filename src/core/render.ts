import type { PlanCapsule, FlowState, MergedVerdict } from "./flow-schema.js";
import type {
  ResearchCapsulePayload,
  Requirement,
  SddTask,
  SpecCapsulePayload,
  TaskGraphPayload,
  SddValidationIssue,
} from "./sdd-schema.js";
import type { FlowUsageSummary } from "./flow-metrics.js";

function renderList(items: readonly string[], empty: string): string {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function renderFileTable(files: PlanCapsule["files"]): string {
  const lines = [
    "| Archivo | Acción | Riesgo | Razón |",
    "|---------|--------|--------|-------|",
  ];
  for (const file of files) {
    lines.push(`| \`${file.path}\` | ${file.action} | ${file.risk} | ${file.reason} |`);
  }
  return lines.join("\n");
}

function renderTestTable(tests: PlanCapsule["tests"]): string {
  if (tests.length === 0) return "_Sin tests específicos planificados._";
  const lines = [
    "| Test | Tipo | Descripción |",
    "|------|------|-------------|",
  ];
  for (const test of tests) {
    lines.push(`| \`${test.path}\` | ${test.type} | ${test.description} |`);
  }
  return lines.join("\n");
}

export function renderPlanCapsule(plan: PlanCapsule): string {
  return `# Plan de Implementación — ${plan.ticket.id}

## Resumen
${plan.summary}

${plan.rootCause !== undefined ? `## Causa Raíz\n${plan.rootCause}\n` : ""}
## Archivos Afectados
${renderFileTable(plan.files)}

## Tests
${renderTestTable(plan.tests)}

## Verificación
- Typecheck: ${plan.verification.typecheck ? "✅" : "❌"}
- Lint: ${plan.verification.lint ? "✅" : "❌"}
- Tests: ${plan.verification.test ? "✅" : "❌"}
- Build: ${plan.verification.build ? "✅" : "❌"}

---
*Generado por mr-orchestrator el ${plan.createdAt}*
`;
}

function flowProgress(state: FlowState, completed: boolean): string {
  const rank: Record<FlowState["phase"], number> = {
    init: 0,
    wizard: 0,
    context: 0,
    explore: 1,
    plan: 2,
    implement: 3,
    judgment: 4,
    fix: 4,
    finish: 5,
  };
  const labels = ["Ticket", "Research", "Planning", "Implementation", state.phase === "fix" ? "Review/Fix" : "Review", "Delivery"];
  return labels.map((label, index) => {
    if (index === 4 && "difficulty" in state && state.difficulty < 5) return `— ${label}`;
    if (index < rank[state.phase] || (index === 5 && completed)) return `✓ ${label}`;
    if (index === rank[state.phase]) return `● ${label}`;
    return `○ ${label}`;
  }).join("  →  ");
}

export function renderFlowUsage(usage: FlowUsageSummary): string {
  const tokens = usage.tokens;
  return `**Coste estimado por OpenCode**: $${usage.cost.toFixed(4)} USD · tokens in/out/reasoning: ${String(tokens.input)}/${String(tokens.output)}/${String(tokens.reasoning)} · caché: ${String(tokens.cacheRead)} read, ${String(tokens.cacheWrite)} write · ${String(usage.sessions)} sesiones`;
}

export function renderFlowStatus(
  state: FlowState,
  usage?: FlowUsageSummary,
  options: { readonly completed?: boolean } = {},
): string {
  const lines = [
    `# Estado del Flujo — ${state.phase}`,
    "",
    `**Progreso**: ${flowProgress(state, options.completed ?? false)}`,
    ...(usage === undefined ? [] : [renderFlowUsage(usage)]),
    "",
    `- **Workspace**: ${state.workspaceId}`,
    `- **Iniciado**: ${state.startedAt}`,
  ];

  if ("difficulty" in state) {
    lines.push(`- **Dificultad**: ${state.difficulty} (${state.difficulty >= 5 ? "Full" : "Lite"})`);
  }
  if ("ticket" in state) {
    lines.push(`- **Ticket**: ${state.ticket.ref.platform}:${state.ticket.ref.id}`);
    lines.push(`- **Título**: ${state.ticket.title}`);
  }
  if ("branch" in state) {
    lines.push(`- **Rama**: ${state.branch} (base: ${state.baseBranch})`);
  }
  if ("plan" in state) {
    lines.push(`- **Plan**: ${state.plan.files.length} archivos, ${state.plan.tests.length} tests`);
  }
  if ("commitHash" in state && state.commitHash !== undefined) {
    lines.push(`- **Commit**: ${state.commitHash}`);
  }
  if ("prUrl" in state && state.prUrl !== undefined) {
    lines.push(`- **PR**: ${state.prUrl}`);
  }

  return lines.join("\n");
}

function compactText(value: string, max = 180): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

export function renderPlanExplanation(plan: PlanCapsule, taskCount?: number): string {
  const paths = plan.files.slice(0, 3).map((file) => `\`${file.path}\``).join(", ");
  const extra = Math.max(0, plan.files.length - 3);
  const checks = Object.entries(plan.verification)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(" + ");
  return [
    "## Plan, en breve",
    `- **Qué**: ${compactText(plan.summary)}`,
    `- **Por qué**: ${compactText(plan.rootCause ?? plan.files[0]?.reason ?? "Cumplir los criterios de aceptación con el menor cambio seguro.")}`,
    `- **Cómo**: ${String(taskCount ?? plan.files.length)} tareas; ${String(plan.files.length)} archivos (${paths}${extra > 0 ? ` +${String(extra)}` : ""}).`,
    `- **Prueba**: ${checks === "" ? "verificación específica de cada tarea" : checks}.`,
  ].join("\n");
}

export function buildTaskDeveloperNote(
  task: SddTask,
  requirements: readonly Requirement[],
): { readonly what: string; readonly why: string; readonly touch: string; readonly prove: string } {
  const requirementWhy = requirements.map((requirement) => requirement.statement).join("; ");
  return {
    what: compactText(task.title, 120),
    why: compactText(requirementWhy === "" ? (task.doneWhen[0] ?? "Complete the bounded SDD task") : requirementWhy, 180),
    touch: task.files.map((file) => file.path).join(", "),
    prove: task.verify.join(" && "),
  };
}

export function renderVerdict(verdict: MergedVerdict): string {
  const status = verdict.approved ? "✅ APROBADO" : "❌ RECHAZADO";
  const evidenceRows = verdict.findings.map((finding) =>
    `| ${finding.severity} | ${finding.claim} | \`${finding.file}:${String(finding.line)} (${finding.side})\` | \`${finding.evidence}\` |`,
  );
  return `# Veredicto del Día del Juicio — ${status}

## Resumen
- **Juez A**: ${verdict.judgeA.approved ? "✅" : "❌"} (${verdict.judgeA.judge})
- **Juez B**: ${verdict.judgeB.approved ? "✅" : "❌"} (${verdict.judgeB.judge})

## Hallazgos Críticos
${renderList(verdict.critical, "Ninguno")}

## Advertencias
${renderList(verdict.warnings, "Ninguna")}

## Sugerencias
${renderList(verdict.suggestions, "Ninguna")}

## Evidencia Verificada
${evidenceRows.length === 0 ? "Ninguna" : `| Severidad | Hallazgo | Ubicación | Evidencia |\n|-----------|----------|-----------|-----------|\n${evidenceRows.join("\n")}`}

---
*Fusionado el ${verdict.mergedAt}*
`;
}

export function renderProposal(title: string, body: string): string {
  return `# ${title}

${body}

---
*Propuesta generada por mr-orchestrator /propose*
`;
}

export function renderPrompt(prompt: string): string {
  return `# Prompt Generado

\`\`\`
${prompt}
\`\`\`

---
*Copiado al portapapeles por mr-orchestrator /prompt*
`;
}

// ─── SDD + RPI Renderers (markdown por script, nunca por IA) ─────────────────

export function renderResearchCapsule(research: ResearchCapsulePayload): string {
  const evidenceRows = research.evidence.map((e) => {
    const location = e.line !== undefined ? `\`${e.file}:${e.line}\`` : `\`${e.file}\``;
    return `| ${e.claim} | ${location} | ${e.source} |`;
  });
  return `# Research — ${research.ticketId}

## Objetivo
${research.objective}

## Evidencia
| Hallazgo | Ubicación | Fuente |
|----------|-----------|--------|
${evidenceRows.join("\n")}

## Nodos Relevantes (Atlas)
${renderList(research.relevantNodes, "Ninguno")}

## Restricciones
${renderList(research.constraints, "Ninguna")}

## Incógnitas
${renderList(research.unknowns, "Ninguna")}

---
*Generado por script desde ResearchCapsule.*
`;
}

export function renderSpecCapsule(spec: SpecCapsulePayload): string {
  const requirementBlocks = spec.requirements.map((requirement) => {
    const criteria = requirement.acceptance.map((criterion) => {
      const given = criterion.given !== undefined ? `**Dado** ${criterion.given}, ` : "";
      return `  - ${given}**Cuando** ${criterion.when}, **Entonces** ${criterion.then}`;
    });
    return `### ${requirement.id}: ${requirement.statement}\n${criteria.join("\n")}`;
  });
  return `# Spec — ${spec.ticketId}

## Meta
${spec.goal}

## Dentro del Alcance
${renderList(spec.scopeIn, "—")}

## Fuera del Alcance
${renderList(spec.scopeOut, "—")}

## Requisitos y Criterios de Aceptación
${requirementBlocks.join("\n\n")}

## Riesgos
${renderList(spec.risks, "Ninguno")}

---
*Generado por script desde SpecCapsule.*
`;
}

const TASK_STATUS_ICONS: Record<string, string> = {
  pending: "⬜",
  in_progress: "🔄",
  done: "✅",
  blocked: "🚫",
};

export function renderTaskGraph(tasks: TaskGraphPayload): string {
  const blocks = tasks.tasks.map((task) => {
    const icon = TASK_STATUS_ICONS[task.status] ?? "⬜";
    const deps = task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "—";
    const fileRows = task.files.map((f) => `| \`${f.path}\` | ${f.action} | ${f.risk} | ${f.reason} |`);
    return `### ${icon} ${task.id}: ${task.title}
- **Depende de**: ${deps}
- **Requisitos**: ${task.requirements.join(", ")}

| Archivo | Acción | Riesgo | Razón |
|---------|--------|--------|-------|
${fileRows.join("\n")}

**Verificación**: ${task.verify.join(" · ")}
**Hecho cuando**:
${task.doneWhen.map((d) => `- ${d}`).join("\n")}`;
  });

  const doneCount = tasks.tasks.filter((t) => t.status === "done").length;
  return `# Tareas — ${tasks.ticketId} (${doneCount}/${tasks.tasks.length} completadas)

${blocks.join("\n\n")}

---
*Generado por script desde TaskGraph.*
`;
}

export function renderSddIssues(issues: readonly SddValidationIssue[]): string {
  if (issues.length === 0) return "✅ Sin problemas de validación.";
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(`## Errores (${errors.length})`);
    lines.push(...errors.map((issue) => `- ❌ ${issue.message}`));
  }
  if (warnings.length > 0) {
    lines.push(`## Advertencias (${warnings.length})`);
    lines.push(...warnings.map((issue) => `- ⚠️ ${issue.message}`));
  }
  return lines.join("\n");
}
