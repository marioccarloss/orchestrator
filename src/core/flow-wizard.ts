import type { EffectiveHarnessModels, ModelRole } from "./harness-models.js";
import { runCommand } from "./process.js";
import type { DesignSource, FlowState, TicketPlatform } from "./flow-schema.js";

export const FLOW_DIFFICULTIES = [1, 3, 5, 8, 13, 21] as const;
export type FlowDifficultyOption = (typeof FLOW_DIFFICULTIES)[number];

export interface WizardPayload {
  readonly difficulty: FlowDifficultyOption;
  readonly ticketId: string;
  readonly ticketPlatform: TicketPlatform;
  readonly hasFigma: boolean;
  readonly designSource: DesignSource;
  readonly designRef?: string;
  readonly supplementalPrompt?: string;
  readonly taskText?: string;
}

export interface PlatformReadiness {
  readonly platform: TicketPlatform;
  readonly label: string;
  readonly ready: boolean;
  readonly detail: string;
  readonly configureHint: string;
}

export interface FlowRoleDescriptor {
  readonly phase: FlowState["phase"];
  readonly agent: string;
  readonly modelRole: ModelRole;
  readonly emoji: string;
  readonly label: string;
}

const PLATFORM_LABELS: Record<Exclude<TicketPlatform, "local">, string> = {
  github: "GitHub",
  jira: "Jira",
  gitlab: "GitLab",
};

export function designSourceToHasFigma(source: DesignSource): boolean {
  return source === "figma";
}

export function normalizeDesignSource(input: DesignSource | undefined, hasFigma?: boolean): DesignSource {
  if (input !== undefined) return input;
  return hasFigma === true ? "figma" : "none";
}

export function mergeTaskText(base: string, supplemental?: string): string {
  const trimmed = supplemental?.trim();
  if (trimmed === undefined || trimmed.length === 0) return base;
  if (base.trim().length === 0) return trimmed;
  return `${base.trim()}\n\n---\nInstrucciones complementarias:\n${trimmed}`;
}

export function assessPlatformReadiness(platform: Exclude<TicketPlatform, "local">): PlatformReadiness {
  switch (platform) {
    case "github": {
      const gh = runCommand("gh", ["auth", "status"]);
      const ready = gh.ok;
      return {
        platform,
        label: PLATFORM_LABELS.github,
        ready,
        detail: ready ? "gh CLI autenticado" : "gh CLI no disponible o sin sesión",
        configureHint: ready
          ? "Usa gh issue view o el MCP github."
          : "Ejecuta `gh auth login` o `mr capabilities install` → github. Puedes pegar el ticket manualmente y continuar.",
      };
    }
    case "jira":
      return {
        platform,
        label: PLATFORM_LABELS.jira,
        ready: false,
        detail: "Integración Jira vía MCP (OAuth en instalación)",
        configureHint: "Completa OAuth con `mr capabilities install` → jira. Si no está listo, pega título/descripción y continúa.",
      };
    case "gitlab":
      return {
        platform,
        label: PLATFORM_LABELS.gitlab,
        ready: false,
        detail: "GitLab adapter en evolución",
        configureHint: "Pega el ticket manualmente por ahora o configura el MCP cuando esté disponible.",
      };
  }
}

export function listTicketPlatformOptions(): readonly PlatformReadiness[] {
  return (["github", "jira", "gitlab"] as const).map((platform) => assessPlatformReadiness(platform));
}

export function renderPlatformStatus(language: "es" | "en" = "es"): string {
  const rows = listTicketPlatformOptions();
  const header = language === "es"
    ? "Plataformas de ticket (no bloqueante — puedes pegar el contenido manualmente):"
    : "Ticket platforms (non-blocking — paste content manually if needed):";
  return [
    header,
    ...rows.map((row) => `- ${row.label}: ${row.ready ? "✓" : "○"} ${row.detail}. ${row.configureHint}`),
    language === "es"
      ? '- Sin ticket: elige "No tengo ticket" y describe la tarea en el paso final.'
      : '- No ticket: choose "No ticket" and describe the task in the final step.',
  ].join("\n");
}

const PHASE_ROLES: Record<FlowState["phase"], FlowRoleDescriptor> = {
  init: { phase: "init", agent: "orchestrator", modelRole: "orchestrator", emoji: "🧭", label: "Wizard" },
  wizard: { phase: "wizard", agent: "orchestrator", modelRole: "orchestrator", emoji: "🧭", label: "Wizard" },
  context: { phase: "context", agent: "orchestrator", modelRole: "orchestrator", emoji: "📋", label: "Contexto" },
  intent: { phase: "intent", agent: "mr-intent", modelRole: "explore", emoji: "🎯", label: "Intención" },
  explore: { phase: "explore", agent: "mr-explore", modelRole: "explore", emoji: "🔍", label: "Explore" },
  plan: { phase: "plan", agent: "mr-plan", modelRole: "plan", emoji: "📐", label: "Plan" },
  implement: { phase: "implement", agent: "mr-general", modelRole: "general", emoji: "🛠", label: "Implement" },
  judgment: { phase: "judgment", agent: "mr-judge-a", modelRole: "judgeA", emoji: "⚖️", label: "Review" },
  fix: { phase: "fix", agent: "mr-fix", modelRole: "fix", emoji: "🔧", label: "Fix" },
  finish: { phase: "finish", agent: "orchestrator", modelRole: "orchestrator", emoji: "✅", label: "Entrega" },
};

const AGENT_ROLES: Record<string, FlowRoleDescriptor> = {
  orchestrator: PHASE_ROLES.wizard,
  "mr-intent": PHASE_ROLES.intent,
  "mr-explore": PHASE_ROLES.explore,
  "mr-plan": PHASE_ROLES.plan,
  "mr-general": PHASE_ROLES.implement,
  "mr-sdd-apply": { phase: "implement", agent: "mr-sdd-apply", modelRole: "sddApply", emoji: "🛠", label: "Implement" },
  "mr-judge-a": PHASE_ROLES.judgment,
  "mr-judge-b": { phase: "judgment", agent: "mr-judge-b", modelRole: "judgeB", emoji: "⚖️", label: "Review B" },
  "mr-fix": PHASE_ROLES.fix,
};

export function flowRoleForAgent(agent: string): FlowRoleDescriptor | undefined {
  return AGENT_ROLES[agent];
}

export function flowRoleForPhase(phase: FlowState["phase"], difficulty?: number, lane?: string): FlowRoleDescriptor {
  if (phase === "implement" && difficulty !== undefined && difficulty >= 5) {
    return { phase, agent: "mr-sdd-apply", modelRole: "sddApply", emoji: "🛠", label: "Implement" };
  }
  if (phase === "judgment" && lane === "critical") {
    return { ...PHASE_ROLES.judgment, emoji: "🚨", label: "Review crítica" };
  }
  return PHASE_ROLES[phase];
}

export function resolveModelLabel(models: EffectiveHarnessModels, role: ModelRole): string {
  const target = models.roles[role].primary.logical;
  const variant = target.variant === undefined ? "" : `#${target.variant}`;
  return `${target.model}${variant}`;
}

export function renderFlowHarnessBadge(
  state: FlowState,
  models: EffectiveHarnessModels,
  override?: { readonly agent?: string; readonly model?: string },
): string {
  const difficulty = state.phase === "wizard"
    ? state.wizardDraft.difficulty
    : "difficulty" in state
      ? state.difficulty
      : undefined;
  const phaseRole = flowRoleForPhase(state.phase, difficulty, state.lane);
  const role = override?.agent === undefined
    ? phaseRole
    : override.agent === "orchestrator"
      ? phaseRole
      : (flowRoleForAgent(override.agent) ?? phaseRole);
  const agent = override?.agent ?? role.agent;
  const modelRole = override?.agent === undefined
    ? role.modelRole
    : (flowRoleForAgent(override.agent)?.modelRole ?? role.modelRole);
  const model = override?.model ?? resolveModelLabel(models, modelRole);
  return `${role.emoji} ${role.label} · ${agent} · ${model}`;
}

export function flowToolTitle(
  state: FlowState | undefined,
  models: EffectiveHarnessModels,
  fallback = "mr-orchestrator /flow",
  override?: { readonly agent?: string; readonly model?: string },
): string {
  if (state === undefined) return fallback;
  return renderFlowHarnessBadge(state, models, override);
}

export const FLOW_WIZARD_STEPS = `Wizard /flow (deterministic — call \`mr_flow_wizard_begin\` then \`mr_flow_wizard_step\` with each answer; mirror with \`question\` for UX):

0. **Begin** — \`mr_flow_wizard_begin\` returns the first prompt/options (step=source).
1. **Repeat** — \`mr_flow_wizard_step answer=<selection>\` until \`complete: true\`; then call \`mr_flow_start\` with returned \`startParams\` OR rely on auto-start when the tool returns \`autoStarted: true\`.

Manual fallback (use the native \`question\` tool at each step; single-select only):

1. **Work source** — GitHub | Jira | GitLab | **No ticket**
   - With a platform: call \`mr_flow_platform_status\` (informational, non-blocking). If MCP/gh is unavailable, warn in one line and offer manual title+description paste or \`mr capabilities install\`.
   - With a platform: ask for the **identifier only** (GH-42, PROJ-105, #123) and fetch the ticket (gh CLI, MCP, or manual paste).
   - **No ticket**: skip remote id; describe the task in step 4.

2. **Fibonacci difficulty** — 1 | 3 | 5 | 8 | 13 | 21 (1-3 Lite, 5+ Full with judgment when the lane requires it).

3. **Design** — one question: **No** | **Figma** (figma-live-mcp) | **Image** | **Other**
   - Do not ask whether the user is frontend or add extra design sub-steps.
   - Figma: if figma-live-mcp fails, do not block — continue without design and mention \`mr doctor\` + manifest import.
   - Image/Other: optional URL, path, or short reference.

4. **Final instructions** — placeholder: "The ticket (or your description) will be analyzed. Add complements here if needed." Empty input continues.

5. **Start** — call \`mr_flow_start\` with ticketPlatform, difficulty, ticketId or taskText, designSource, optional designRef, optional supplementalPrompt.
   - After start, delegate without restating role/model in prose; the harness badge lives on mr_flow_* tool titles and \`mr_flow_status\`.`;

/** User-facing wizard copy for Spanish docs and CLI description. */
export const FLOW_WIZARD_STEPS_ES = `Wizard /flow (usa la herramienta nativa \`question\` en cada paso; una sola selección por paso):

1. **Origen del trabajo** — GitHub | Jira | GitLab | **No tengo ticket**
2. **Dificultad Fibonacci** — 1 | 3 | 5 | 8 | 13 | 21
3. **Diseño** — No | Figma | Imagen | Otro (no bloqueante)
4. **Instrucciones finales** — complemento opcional al ticket
5. **Arranque** — \`mr_flow_start\``;
