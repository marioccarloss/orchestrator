import { atomicWrite, canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import { runCommand } from "./process.js";
import { refreshInstallManifestFiles } from "./install.js";
import {
  ModelMapSchema,
  type ModelAssignment,
  type ModelMap,
  type ModelTarget,
  type ModelRoleSchema,
  SCHEMA_VERSION,
} from "./schema.js";
import type { z } from "zod";
import { loadRegistry } from "./workspace.js";
import { buildGlobalDefinitionFiles, syncWorkspace, loadModels, writeGlobalDefinitions } from "./config.js";

export type ModelRole = z.infer<typeof ModelRoleSchema>;

export type RoleCategory = "flow" | "blueprint";

export interface RoleMetadata {
  readonly role: ModelRole;
  readonly label: string;
  readonly category: RoleCategory;
  readonly description: string;
  readonly recommendedModel: string;
}

export const ROLES: readonly RoleMetadata[] = [
  {
    role: "orchestrator",
    label: "Orchestrator",
    category: "flow",
    description: "Dirección, razonamiento inicial y FSM de /flow",
    recommendedModel: "github-copilot/gemini-3.8-flash#high",
  },
  {
    role: "explore",
    label: "Explore",
    category: "flow",
    description: "Mapeo rápido de archivos y lectura de contexto (read-only)",
    recommendedModel: "opencode-go/deepseek-v4.1-flash#high",
  },
  {
    role: "plan",
    label: "Plan (SDD+RPI)",
    category: "flow",
    description: "Planificación estructurada en cápsula JSON (read-only)",
    recommendedModel: "openai/gpt-5.6-sol#high",
  },
  {
    role: "general",
    label: "General (Implementador)",
    category: "flow",
    description: "Implementación quirúrgica de código",
    recommendedModel: "github-copilot/gpt-5.6-sol#high",
  },
  {
    role: "sddApply",
    label: "SDD Apply",
    category: "flow",
    description: "Aplicación y verificación de cambios SDD",
    recommendedModel: "openai/gpt-5.6-sol#high",
  },
  {
    role: "judgeA",
    label: "Día del Juicio - Juez A",
    category: "flow",
    description: "Revisión adversarial ciega A (read-only)",
    recommendedModel: "opencode-go/glm-5.3#max",
  },
  {
    role: "judgeB",
    label: "Día del Juicio - Juez B",
    category: "flow",
    description: "Revisión adversarial ciega B (read-only)",
    recommendedModel: "opencode-go/qwen3.8-max#xhigh",
  },
  {
    role: "fix",
    label: "Fix Agent",
    category: "flow",
    description: "Corrección quirúrgica de hallazgos del veredicto",
    recommendedModel: "openai/gpt-5.6-sol#high",
  },
  {
    role: "bpExtractor",
    label: "Blueprint Extractor",
    category: "blueprint",
    description: "Extracción mecánica de tickets, metadatos y firmas mínimas",
    recommendedModel: "opencode-go/deepseek-v4.1-flash#low",
  },
  {
    role: "bpArchitect",
    label: "Blueprint Architect",
    category: "blueprint",
    description: "Razonamiento y síntesis de producto/arquitectura (SDD+RPI)",
    recommendedModel: "opencode/claude-fable-5-1#max",
  },
  {
    role: "bpTransactor",
    label: "Blueprint Transactor",
    category: "blueprint",
    description: "Despacho transaccional en GitHub con Safety Gate",
    recommendedModel: "opencode-go/deepseek-v4.1-flash#low",
  },
];

export function getRolesByCategory(category?: RoleCategory): readonly RoleMetadata[] {
  if (!category) return ROLES;
  return ROLES.filter((r) => r.category === category);
}

export function parseModelTarget(reference: string): ModelTarget {
  const separator = reference.lastIndexOf("#");
  if (separator <= reference.indexOf("/")) return { model: reference };
  return { model: reference.slice(0, separator), variant: reference.slice(separator + 1) };
}

export function formatModelTarget(target: ModelTarget): string {
  return target.variant === undefined ? target.model : `${target.model}#${target.variant}`;
}

function configured(model: string, alternative?: string): ModelAssignment {
  const fallback = alternative ?? (model.startsWith("openai/")
    ? "opencode-go/deepseek-v4-pro#high"
    : "openai/gpt-5.6-sol#high");
  return { ...parseModelTarget(model), alternative: parseModelTarget(fallback) };
}

export const PRESETS: Record<string, { readonly name: string; readonly description: string; readonly roles: ModelMap["roles"] }> = {
  "balanced": {
    name: "Balanced Orchestrator Preset",
    description: "Kimi K3 (dir/gen) + Gemini 3.7 Flash (explore) + Grok 4.6 & Opus 5 (jueces) + GPT-5.6 Sol (plan/fix) + Blueprint",
    roles: {
      orchestrator: configured("github-copilot/kimi-k3"),
      explore: configured("github-copilot/gemini-3.7-flash"),
      plan: configured("github-copilot/gpt-5.6-sol"),
      general: configured("github-copilot/kimi-k3"),
      sddApply: configured("github-copilot/gpt-5.6-sol"),
      judgeA: configured("github-copilot/grok-4.6"),
      judgeB: configured("github-copilot/claude-opus-5"),
      fix: configured("github-copilot/gpt-5.6-sol"),
      bpExtractor: configured("github-copilot/gpt-4o-mini"),
      bpArchitect: configured("github-copilot/gemini-3.8-flash"),
      bpTransactor: configured("github-copilot/gpt-4o-mini"),
    },
  },
  "gpt-sol": {
    name: "GPT-5.6 Sol All-Round",
    description: "Modelo homogéneo GPT-5.6 Sol en todos los roles con subagentes mecánicos mini",
    roles: {
      orchestrator: configured("github-copilot/gpt-5.6-sol"),
      explore: configured("github-copilot/gpt-5.6-sol"),
      plan: configured("github-copilot/gpt-5.6-sol"),
      general: configured("github-copilot/gpt-5.6-sol"),
      sddApply: configured("github-copilot/gpt-5.6-sol"),
      judgeA: configured("github-copilot/gpt-5.6-sol"),
      judgeB: configured("github-copilot/gpt-5.6-sol"),
      fix: configured("github-copilot/gpt-5.6-sol"),
      bpExtractor: configured("github-copilot/gpt-4o-mini"),
      bpArchitect: configured("github-copilot/gpt-5.6-sol"),
      bpTransactor: configured("github-copilot/gpt-4o-mini"),
    },
  },
  "claude-opus": {
    name: "Claude Opus / Sonnet Power",
    description: "Claude Sonnet 4.6 (gen/plan) + Opus 5 (orchestrator/jueces) + Gemini Flash (explore)",
    roles: {
      orchestrator: configured("github-copilot/claude-opus-5"),
      explore: configured("github-copilot/gemini-3.7-flash"),
      plan: configured("github-copilot/claude-sonnet-4.6"),
      general: configured("github-copilot/claude-sonnet-4.6"),
      sddApply: configured("github-copilot/claude-sonnet-4.6"),
      judgeA: configured("github-copilot/claude-opus-5"),
      judgeB: configured("github-copilot/grok-4.6"),
      fix: configured("github-copilot/claude-sonnet-4.6"),
      bpExtractor: configured("github-copilot/gpt-4o-mini"),
      bpArchitect: configured("github-copilot/claude-sonnet-4.6"),
      bpTransactor: configured("github-copilot/gpt-4o-mini"),
    },
  },
};

export const FALLBACK_MODELS: readonly string[] = [
  "openai/gpt-5.6-sol",
  "openai/gpt-6-astra",
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/glm-5.3",
  "opencode-go/glm-5.3-flash",
  "opencode-go/qwen3.8-max",
  "opencode-go/qwen3.8-flash",
  "github-copilot/gpt-5.6-sol",
  "github-copilot/gemini-3.8-flash",
  "github-copilot/grok-4.6",
  "github-copilot/claude-opus-5",
  "opencode/claude-fable-5-1",
  "opencode/muse-spark-1.3",
];

export interface AvailableModels {
  readonly models: readonly string[];
  readonly source: "opencode" | "fallback";
  readonly warning?: string;
}

export interface ModelCandidates {
  readonly activeModel: string;
  readonly alternativeModel: string;
  readonly candidates: readonly string[];
  readonly warning: string;
}

export function buildModelCandidates(
  assignment: ModelAssignment,
  availableModels: readonly string[],
  failedModel?: string,
): ModelCandidates {
  const failed = failedModel?.trim();
  const candidates = Array.from(new Set(availableModels))
    .filter((model) => !model.startsWith("openrouter/"))
    .filter((model) => failed === undefined || baseModel(model) !== baseModel(failed))
    .sort();

  return {
    activeModel: formatModelTarget(assignment),
    alternativeModel: formatModelTarget(assignment.alternative),
    candidates,
    warning: "El catálogo no confirma cuota ni disponibilidad real. Elige explícitamente antes de guardar el cambio.",
  };
}

function stripTerminalSequences(output: string): string {
  let clean = "";
  for (let index = 0; index < output.length; index += 1) {
    if (output.charCodeAt(index) === 27 && output[index + 1] === "[") {
      index += 2;
      while (index < output.length) {
        const code = output.charCodeAt(index);
        if (code >= 64 && code <= 126) break;
        index += 1;
      }
      continue;
    }
    clean += output.charAt(index);
  }
  return clean;
}

export function parseAvailableModels(output: string): readonly string[] {
  return Array.from(new Set(
    stripTerminalSequences(output)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[^\s/]+\/.+$/u.test(line)),
  )).sort();
}

export function discoverAvailableModels(): AvailableModels {
  const result = runCommand("opencode", ["models"]);
  if (result.ok && result.stdout.trim().length > 0) {
    const models = parseAvailableModels(result.stdout);
    if (models.length > 0) {
      return { models, source: "opencode" };
    }
  }
  const detail = result.stderr.trim();
  return {
    models: FALLBACK_MODELS,
    source: "fallback",
    warning: detail.length > 0
      ? `No se pudo consultar OpenCode (${detail}). Se muestra el catálogo de respaldo.`
      : "OpenCode no devolvió modelos. Se muestra el catálogo de respaldo.",
  };
}

export function fetchAvailableModels(): readonly string[] {
  return discoverAvailableModels().models;
}

export async function saveModels(paths: MrPaths, models: ModelMap): Promise<void> {
  const valid = ModelMapSchema.parse(models);
  await atomicWrite(paths.models, canonicalJson(valid));
}

export async function syncAllWorkspaces(paths: MrPaths): Promise<readonly string[]> {
  const registry = await loadRegistry(paths);
  const synced: string[] = [];
  for (const workspace of registry.workspaces) {
    const configPath = await syncWorkspace(paths, workspace);
    synced.push(configPath);
  }
  // Model definitions are global and must also refresh when there are no
  // registered workspaces. syncWorkspace writes them too, but this final write
  // makes the zero-workspace case correct and deterministic.
  const models = await loadModels(paths);
  await writeGlobalDefinitions(paths, models);
  await refreshInstallManifestFiles(paths, buildGlobalDefinitionFiles(paths, models));
  return synced;
}

export async function setModels(paths: MrPaths, models: ModelMap, sync = true): Promise<ModelMap> {
  const valid = ModelMapSchema.parse(models);
  await saveModels(paths, valid);
  if (sync) {
    await syncAllWorkspaces(paths);
  }
  return valid;
}

export type ModelSlot = "model" | "alternative";

export async function setModelRole(
  paths: MrPaths,
  role: ModelRole,
  model: string,
  slot: ModelSlot = "model",
): Promise<ModelMap> {
  const current = await loadModels(paths);
  const assignment = current.roles[role];
  const target = parseModelTarget(model);
  const updated: ModelMap = {
    schemaVersion: SCHEMA_VERSION,
    roles: {
      ...current.roles,
      [role]: slot === "model"
        ? { ...target, alternative: assignment.alternative }
        : { ...assignment, alternative: target },
    },
  };
  return setModels(paths, updated);
}

function baseModel(model: string): string {
  return model.split("#", 1)[0] ?? model;
}

export interface AlternativePromotion {
  readonly promoted: boolean;
  readonly model: string;
  readonly alternative: string;
}

export async function promoteAlternativeModel(
  paths: MrPaths,
  role: ModelRole,
  failedModel: string,
): Promise<AlternativePromotion> {
  const current = await loadModels(paths);
  const assignment = current.roles[role];
  if (baseModel(assignment.model) !== baseModel(failedModel)) {
    return {
      promoted: false,
      model: formatModelTarget(assignment),
      alternative: formatModelTarget(assignment.alternative),
    };
  }
  const promoted: ModelAssignment = {
    ...assignment.alternative,
    alternative: { model: assignment.model, ...(assignment.variant === undefined ? {} : { variant: assignment.variant }) },
  };
  await setModels(paths, {
    schemaVersion: SCHEMA_VERSION,
    roles: { ...current.roles, [role]: promoted },
  });
  return {
    promoted: true,
    model: formatModelTarget(promoted),
    alternative: formatModelTarget(promoted.alternative),
  };
}

export async function setModelPreset(paths: MrPaths, presetKey: string): Promise<ModelMap> {
  const preset = PRESETS[presetKey];
  if (preset === undefined) {
    throw new Error(`Preset desconocido '${presetKey}'. Presets disponibles: ${Object.keys(PRESETS).join(", ")}`);
  }
  const updated: ModelMap = {
    schemaVersion: SCHEMA_VERSION,
    roles: preset.roles,
  };
  return setModels(paths, updated);
}
