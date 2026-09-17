import { FLOW_DIFFICULTIES, type FlowDifficultyOption } from "./flow-wizard.js";
import {
  DesignSourceSchema,
  TicketPlatformSchema,
  type DesignSource,
  type TicketPlatform,
  type WizardDraft,
  type WizardStepId,
} from "./flow-schema.js";

export interface WizardOption {
  readonly id: string;
  readonly label: string;
}

export interface WizardQuestion {
  readonly step: WizardStepId;
  readonly prompt: string;
  readonly options?: readonly WizardOption[];
  readonly placeholder?: string;
  readonly optional?: boolean;
  readonly hint?: string;
}

export interface WizardStepResult {
  readonly draft: WizardDraft;
  readonly nextStep: WizardStepId;
  readonly question?: WizardQuestion | undefined;
  readonly complete?: boolean | undefined;
  readonly startParams?: WizardStartParams | undefined;
}

export interface WizardStartParams {
  readonly difficulty: FlowDifficultyOption;
  readonly ticketPlatform: TicketPlatform;
  readonly ticketId?: string;
  readonly taskText?: string;
  readonly designSource: DesignSource;
  readonly designRef?: string;
  readonly supplementalPrompt?: string;
  readonly hasFigma: boolean;
}

const SOURCE_OPTIONS: readonly WizardOption[] = [
  { id: "github", label: "GitHub" },
  { id: "jira", label: "Jira" },
  { id: "gitlab", label: "GitLab" },
  { id: "no_ticket", label: "No tengo ticket" },
];

const DIFFICULTY_OPTIONS: readonly WizardOption[] = FLOW_DIFFICULTIES.map((value) => ({
  id: String(value),
  label: String(value),
}));

const DESIGN_OPTIONS: readonly WizardOption[] = [
  { id: "none", label: "No" },
  { id: "figma", label: "Figma (figma-live-mcp)" },
  { id: "image", label: "Imagen" },
  { id: "other", label: "Otro" },
  { id: "skip", label: "Saltar / continuar sin diseño" },
];

function normalizeAnswer(answer: string): string {
  return answer.trim();
}

function parseSource(answer: string): TicketPlatform | "no_ticket" {
  const normalized = normalizeAnswer(answer).toLowerCase();
  if (normalized === "no_ticket" || normalized === "no tengo ticket" || normalized === "local" || normalized === "sin ticket") {
    return "no_ticket";
  }
  if (normalized.includes("github") || normalized === "gh") return "github";
  if (normalized.includes("jira")) return "jira";
  if (normalized.includes("gitlab") || normalized === "gl") return "gitlab";
  return TicketPlatformSchema.parse(normalized);
}

function parseDifficulty(answer: string): FlowDifficultyOption {
  const parsed = Number.parseInt(normalizeAnswer(answer), 10);
  if (FLOW_DIFFICULTIES.includes(parsed as FlowDifficultyOption)) return parsed as FlowDifficultyOption;
  throw new Error(`Invalid difficulty '${answer}'. Choose one of: ${FLOW_DIFFICULTIES.join(", ")}`);
}

function parseDesignSource(answer: string): DesignSource | "skip" {
  const normalized = normalizeAnswer(answer).toLowerCase();
  if (normalized === "skip" || normalized === "saltar" || normalized === "continuar") return "skip";
  if (normalized === "none" || normalized === "no" || normalized === "n") return "none";
  if (normalized.includes("figma")) return "figma";
  if (normalized.includes("image") || normalized.includes("imagen")) return "image";
  if (normalized === "other" || normalized === "otro") return "other";
  return DesignSourceSchema.parse(normalized);
}

export function initialWizardDraft(): WizardDraft {
  return {};
}

export function questionForStep(step: WizardStepId, draft: WizardDraft, language: "es" | "en" = "es"): WizardQuestion {
  const es = language === "es";
  switch (step) {
    case "source":
      return {
        step,
        prompt: es
          ? "¿De dónde viene el trabajo? Elige una plataforma o continúa sin ticket."
          : "Where does the work come from? Pick one platform or continue without a ticket.",
        options: SOURCE_OPTIONS,
        hint: es
          ? "Puedes llamar mr_flow_platform_status antes; no bloquea si gh/MCP no está listo."
          : "You may call mr_flow_platform_status first; missing gh/MCP is non-blocking.",
      };
    case "ticket_id":
      return {
        step,
        prompt: es
          ? `Identificador del ticket en ${draft.ticketPlatform ?? "la plataforma"} (ej. GH-42, PROJ-105):`
          : `Ticket identifier on ${draft.ticketPlatform ?? "the platform"} (e.g. GH-42, PROJ-105):`,
        placeholder: "GH-42",
      };
    case "difficulty":
      return {
        step,
        prompt: es
          ? "Dificultad Fibonacci (1-3 Lite, 5+ Full con juicio si el carril lo exige):"
          : "Fibonacci difficulty (1-3 Lite, 5+ Full with judgment when the lane requires it):",
        options: DIFFICULTY_OPTIONS,
      };
    case "design":
      return {
        step,
        prompt: es ? "¿Tienes diseño?" : "Do you have a design?",
        options: DESIGN_OPTIONS,
        hint: es
          ? "Figma no bloquea: si figma-live-mcp falla, elige Saltar y continúa."
          : "Figma is non-blocking: if figma-live-mcp fails, choose Skip and continue.",
      };
    case "design_ref":
      return {
        step,
        prompt: es
          ? "Referencia de diseño (URL Figma, ruta de imagen u otra nota). Vacío = continuar sin referencia."
          : "Design reference (Figma URL, image path, or note). Empty = continue without reference.",
        placeholder: es ? "https://www.figma.com/file/..." : "https://www.figma.com/file/...",
        optional: true,
      };
    case "instructions":
      return {
        step,
        prompt: es
          ? draft.ticketPlatform === "local"
            ? "Describe la tarea. Se analizará antes de explorar código."
            : "Se analizará el ticket. Complementa instrucciones aquí si hace falta (Enter vacío = continuar)."
          : draft.ticketPlatform === "local"
            ? "Describe the task. It will be analyzed before code exploration."
            : "The ticket will be analyzed. Add complements here if needed (empty = continue).",
        placeholder: es ? "Opcional: alcance, restricciones, pruebas..." : "Optional: scope, constraints, tests...",
        optional: true,
      };
    default:
      return { step: "done", prompt: es ? "Wizard completo." : "Wizard complete." };
  }
}

function nextStepAfterSource(draft: WizardDraft): WizardStepId {
  return draft.ticketPlatform === "local" ? "difficulty" : "ticket_id";
}

function needsDesignRef(source: DesignSource | undefined): boolean {
  return source === "figma" || source === "image" || source === "other";
}

function buildStartParams(draft: WizardDraft): WizardStartParams {
  if (draft.difficulty === undefined) throw new Error("Wizard draft missing difficulty.");
  const platform = draft.ticketPlatform ?? "local";
  const designSource = draft.designSource ?? "none";
  if (platform === "local") {
    if (draft.taskText === undefined || draft.taskText.trim() === "") {
      throw new Error("Local flow requires task text from the instructions step.");
    }
    return {
      difficulty: draft.difficulty,
      ticketPlatform: "local",
      taskText: draft.taskText.trim(),
      designSource,
      ...(draft.designRef === undefined || draft.designRef.trim() === "" ? {} : { designRef: draft.designRef.trim() }),
      ...(draft.supplementalPrompt === undefined || draft.supplementalPrompt.trim() === ""
        ? {}
        : { supplementalPrompt: draft.supplementalPrompt.trim() }),
      hasFigma: designSource === "figma",
    };
  }
  if (draft.ticketId === undefined || draft.ticketId.trim() === "") {
    throw new Error("Remote flow requires ticketId.");
  }
  return {
    difficulty: draft.difficulty,
    ticketPlatform: platform,
    ticketId: draft.ticketId.trim(),
    designSource,
    ...(draft.designRef === undefined || draft.designRef.trim() === "" ? {} : { designRef: draft.designRef.trim() }),
    ...(draft.supplementalPrompt === undefined || draft.supplementalPrompt.trim() === ""
      ? {}
      : { supplementalPrompt: draft.supplementalPrompt.trim() }),
    hasFigma: designSource === "figma",
  };
}

export function applyWizardAnswer(
  step: WizardStepId,
  answer: string,
  draft: WizardDraft,
  language: "es" | "en" = "es",
): WizardStepResult {
  const trimmed = normalizeAnswer(answer);
  let nextDraft = { ...draft };

  switch (step) {
    case "source": {
      const source = parseSource(trimmed.length === 0 ? "no_ticket" : trimmed);
      if (source === "no_ticket") {
        nextDraft = { ...nextDraft, ticketPlatform: "local" };
      } else {
        nextDraft = { ...nextDraft, ticketPlatform: source };
      }
      const nextStep = nextStepAfterSource(nextDraft);
      const question = nextStep === "done" ? undefined : questionForStep(nextStep, nextDraft, language);
      return question === undefined
        ? { draft: nextDraft, nextStep }
        : { draft: nextDraft, nextStep, question };
    }
    case "ticket_id": {
      if (trimmed.length === 0) throw new Error("Ticket id is required.");
      nextDraft = { ...nextDraft, ticketId: trimmed };
      return { draft: nextDraft, nextStep: "difficulty", question: questionForStep("difficulty", nextDraft, language) };
    }
    case "difficulty": {
      nextDraft = { ...nextDraft, difficulty: parseDifficulty(trimmed.length === 0 ? "3" : trimmed) };
      return { draft: nextDraft, nextStep: "design", question: questionForStep("design", nextDraft, language) };
    }
    case "design": {
      const parsed = parseDesignSource(trimmed.length === 0 ? "none" : trimmed);
      if (parsed === "skip") {
        nextDraft = { ...nextDraft, designSource: "none" };
        return {
          draft: nextDraft,
          nextStep: "instructions",
          question: questionForStep("instructions", nextDraft, language),
        };
      }
      nextDraft = { ...nextDraft, designSource: parsed };
      if (needsDesignRef(parsed)) {
        return { draft: nextDraft, nextStep: "design_ref", question: questionForStep("design_ref", nextDraft, language) };
      }
      return { draft: nextDraft, nextStep: "instructions", question: questionForStep("instructions", nextDraft, language) };
    }
    case "design_ref": {
      if (trimmed.length > 0) nextDraft = { ...nextDraft, designRef: trimmed };
      return { draft: nextDraft, nextStep: "instructions", question: questionForStep("instructions", nextDraft, language) };
    }
    case "instructions": {
      if (nextDraft.ticketPlatform === "local") {
        if (trimmed.length === 0) throw new Error("Task description is required when there is no ticket.");
        nextDraft = { ...nextDraft, taskText: trimmed };
      } else if (trimmed.length > 0) {
        nextDraft = { ...nextDraft, supplementalPrompt: trimmed };
      }
      const startParams = buildStartParams(nextDraft);
      return { draft: nextDraft, nextStep: "done", complete: true, startParams };
    }
    default:
      throw new Error(`Wizard step '${step}' does not accept answers.`);
  }
}

export function serializeWizardQuestion(question: WizardQuestion): string {
  const lines = [
    `step: ${question.step}`,
    `prompt: ${question.prompt}`,
    ...(question.hint === undefined ? [] : [`hint: ${question.hint}`]),
    ...(question.placeholder === undefined ? [] : [`placeholder: ${question.placeholder}`]),
    ...(question.optional === true ? ["optional: true"] : []),
    ...(question.options === undefined
      ? []
      : ["options:", ...question.options.map((option) => `- ${option.id}: ${option.label}`)]),
  ];
  return lines.join("\n");
}
