import { atomicWrite, canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import { runCommand } from "./process.js";
import { refreshInstallManifestFiles } from "./install.js";
import {
  ModelMapSchema,
  type ModelMap,
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
    recommendedModel: "github-copilot/kimi-k3",
  },
  {
    role: "explore",
    label: "Explore",
    category: "flow",
    description: "Mapeo rápido de archivos y lectura de contexto (read-only)",
    recommendedModel: "github-copilot/gemini-3.7-flash",
  },
  {
    role: "plan",
    label: "Plan (SDD+RPI)",
    category: "flow",
    description: "Planificación estructurada en cápsula JSON (read-only)",
    recommendedModel: "github-copilot/gpt-5.6-sol",
  },
  {
    role: "general",
    label: "General (Implementador)",
    category: "flow",
    description: "Implementación quirúrgica de código",
    recommendedModel: "github-copilot/kimi-k3",
  },
  {
    role: "sddApply",
    label: "SDD Apply",
    category: "flow",
    description: "Aplicación y verificación de cambios SDD",
    recommendedModel: "github-copilot/gpt-5.6-sol",
  },
  {
    role: "judgeA",
    label: "Día del Juicio - Juez A",
    category: "flow",
    description: "Revisión adversarial ciega A (read-only)",
    recommendedModel: "github-copilot/grok-4.6",
  },
  {
    role: "judgeB",
    label: "Día del Juicio - Juez B",
    category: "flow",
    description: "Revisión adversarial ciega B (read-only)",
    recommendedModel: "github-copilot/claude-opus-5",
  },
  {
    role: "fix",
    label: "Fix Agent",
    category: "flow",
    description: "Corrección quirúrgica de hallazgos del veredicto",
    recommendedModel: "github-copilot/gpt-5.6-sol",
  },
  {
    role: "bpExtractor",
    label: "Blueprint Extractor",
    category: "blueprint",
    description: "Extracción mecánica de tickets, metadatos y firmas mínimas",
    recommendedModel: "github-copilot/gpt-4o-mini",
  },
  {
    role: "bpArchitect",
    label: "Blueprint Architect",
    category: "blueprint",
    description: "Razonamiento y síntesis de producto/arquitectura (SDD+RPI)",
    recommendedModel: "github-copilot/gemini-3.8-flash",
  },
  {
    role: "bpTransactor",
    label: "Blueprint Transactor",
    category: "blueprint",
    description: "Despacho transaccional en GitHub con Safety Gate",
    recommendedModel: "github-copilot/gpt-4o-mini",
  },
];

export function getRolesByCategory(category?: RoleCategory): readonly RoleMetadata[] {
  if (!category) return ROLES;
  return ROLES.filter((r) => r.category === category);
}

export const PRESETS: Record<string, { readonly name: string; readonly description: string; readonly roles: ModelMap["roles"] }> = {
  "balanced": {
    name: "Balanced Orchestrator Preset",
    description: "Kimi K3 (dir/gen) + Gemini 3.7 Flash (explore) + Grok 4.6 & Opus 5 (jueces) + GPT-5.6 Sol (plan/fix) + Blueprint",
    roles: {
      orchestrator: "github-copilot/kimi-k3",
      explore: "github-copilot/gemini-3.7-flash",
      plan: "github-copilot/gpt-5.6-sol",
      general: "github-copilot/kimi-k3",
      sddApply: "github-copilot/gpt-5.6-sol",
      judgeA: "github-copilot/grok-4.6",
      judgeB: "github-copilot/claude-opus-5",
      fix: "github-copilot/gpt-5.6-sol",
      bpExtractor: "github-copilot/gpt-4o-mini",
      bpArchitect: "github-copilot/gemini-3.8-flash",
      bpTransactor: "github-copilot/gpt-4o-mini",
    },
  },
  "gpt-sol": {
    name: "GPT-5.6 Sol All-Round",
    description: "Modelo homogéneo GPT-5.6 Sol en todos los roles con subagentes mecánicos mini",
    roles: {
      orchestrator: "github-copilot/gpt-5.6-sol",
      explore: "github-copilot/gpt-5.6-sol",
      plan: "github-copilot/gpt-5.6-sol",
      general: "github-copilot/gpt-5.6-sol",
      sddApply: "github-copilot/gpt-5.6-sol",
      judgeA: "github-copilot/gpt-5.6-sol",
      judgeB: "github-copilot/gpt-5.6-sol",
      fix: "github-copilot/gpt-5.6-sol",
      bpExtractor: "github-copilot/gpt-4o-mini",
      bpArchitect: "github-copilot/gpt-5.6-sol",
      bpTransactor: "github-copilot/gpt-4o-mini",
    },
  },
  "claude-opus": {
    name: "Claude Opus / Sonnet Power",
    description: "Claude Sonnet 4.6 (gen/plan) + Opus 5 (orchestrator/jueces) + Gemini Flash (explore)",
    roles: {
      orchestrator: "github-copilot/claude-opus-5",
      explore: "github-copilot/gemini-3.7-flash",
      plan: "github-copilot/claude-sonnet-4.6",
      general: "github-copilot/claude-sonnet-4.6",
      sddApply: "github-copilot/claude-sonnet-4.6",
      judgeA: "github-copilot/claude-opus-5",
      judgeB: "github-copilot/grok-4.6",
      fix: "github-copilot/claude-sonnet-4.6",
      bpExtractor: "github-copilot/gpt-4o-mini",
      bpArchitect: "github-copilot/claude-sonnet-4.6",
      bpTransactor: "github-copilot/gpt-4o-mini",
    },
  },
};

export const FALLBACK_MODELS: readonly string[] = [
  "github-copilot/kimi-k3",
  "github-copilot/gemini-3.7-flash",
  "github-copilot/gpt-5.6-sol",
  "github-copilot/grok-4.6",
  "github-copilot/claude-opus-5",
  "github-copilot/claude-sonnet-4.6",
  "github-copilot/claude-sonnet-5",
  "github-copilot/gpt-5.4",
  "github-copilot/gpt-5.5",
  "github-copilot/kimi-k2.7-code",
];

export interface AvailableModels {
  readonly models: readonly string[];
  readonly source: "opencode" | "fallback";
  readonly warning?: string;
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

export async function setModelRole(paths: MrPaths, role: ModelRole, model: string): Promise<ModelMap> {
  const current = await loadModels(paths);
  const updated: ModelMap = {
    schemaVersion: SCHEMA_VERSION,
    roles: {
      ...current.roles,
      [role]: model,
    },
  };
  return setModels(paths, updated);
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
