import * as p from "@clack/prompts";
import type { MrPaths } from "../core/paths.js";
import { loadModels } from "../core/config.js";
import { inheritedLogicalModelMap, loadHarnessCatalog, loadHarnessOverride, logicalModelMap, type EffectiveHarnessModels } from "../core/harness-models.js";
import {
  ROLES,
  PRESETS,
  discoverAvailableModels,
  formatModelTarget,
  loadEffectiveModels,
  parseModelTarget,
  refreshHarnessCatalog,
  setHarnessModels,
  setModels,
  type ModelRole,
  type RoleCategory,
} from "../core/models.js";
import type { HarnessId, ModelMap } from "../core/schema.js";

export interface ModelSelectorOptions {
  readonly installation?: boolean;
  readonly sync?: boolean;
  readonly harness?: HarnessId;
}

export function formatModelMatrix(models: ModelMap, category?: RoleCategory): string {
  const lines: string[] = [];
  const flowRoles = ROLES.filter((r) => r.category === "flow");
  const blueprintRoles = ROLES.filter((r) => r.category === "blueprint");

  if (!category || category === "flow") {
    lines.push("── /flow (Entrega quirúrgica y juicio) ──");
    for (const info of flowRoles) {
      const assignment = models.roles[info.role];
      const currentModel = formatModelTarget(assignment);
      const isRecommended = currentModel === info.recommendedModel;
      const badge = isRecommended ? " (recomendado)" : "";
      lines.push(`• ${info.label.padEnd(28)} → ${currentModel}${badge}\n    ↳ fallback: ${formatModelTarget(assignment.alternative)}\n    └ ${info.description}`);
    }
  }

  if (!category || category === "blueprint") {
    if (lines.length > 0 && !category) lines.push("");
    lines.push("── /blueprint (Aterrizaje de ideas y tickets) ──");
    for (const info of blueprintRoles) {
      const assignment = models.roles[info.role];
      const currentModel = formatModelTarget(assignment);
      const isRecommended = currentModel === info.recommendedModel;
      const badge = isRecommended ? " (recomendado)" : "";
      lines.push(`• ${info.label.padEnd(28)} → ${currentModel}${badge}\n    ↳ fallback: ${formatModelTarget(assignment.alternative)}\n    └ ${info.description}`);
    }
  }

  return lines.join("\n");
}

export function formatEffectiveModelMatrix(effective: EffectiveHarnessModels, category?: RoleCategory): string {
  const lines = [`Arnés: ${effective.harness} · aplicación: ${effective.applicationMode}`];
  for (const info of ROLES.filter((role) => category === undefined || role.category === category)) {
    const assignment = effective.roles[info.role];
    const primaryLogical = formatModelTarget(assignment.primary.logical);
    const primaryNative = formatModelTarget(assignment.primary.native);
    const alternativeLogical = formatModelTarget(assignment.alternative.logical);
    const alternativeNative = formatModelTarget(assignment.alternative.native);
    lines.push(
      `• ${info.label.padEnd(28)} → ${primaryLogical} ⇒ ${primaryNative} [${assignment.primary.origin}]`
      + `\n    ↳ fallback: ${alternativeLogical} ⇒ ${alternativeNative} [${assignment.alternative.origin}]`,
    );
  }
  return lines.join("\n");
}

async function chooseModel(
  role: ModelRole,
  current: string,
  availableModels: readonly string[],
  slot: "principal" | "alternativo",
): Promise<string | undefined> {
  const meta = ROLES.find((item) => item.role === role);
  const choices = Array.from(new Set([current, ...availableModels])).map((model) => ({
    value: model,
    label: model,
    ...(model === current
      ? { hint: "actual" }
      : model === meta?.recommendedModel
        ? { hint: "recomendado" }
        : {}),
  }));
  const selected = await p.autocomplete<string>({
    message: `Modelo ${slot} para ${meta?.label ?? role}`,
    placeholder: "Escribe para filtrar por proveedor o modelo",
    options: [
      ...choices,
      { value: "__custom__", label: "Ingresar otro provider/model manualmente" },
    ],
    maxItems: 12,
    initialValue: current,
  });
  if (p.isCancel(selected)) return undefined;
  if (selected !== "__custom__") return selected;

  const custom = await p.text({
    message: "Identificador del modelo",
    placeholder: "provider/model-id[#variant]",
    validate: (value) => /^[^\s/]+\/[^\s#]+(?:#[a-z0-9][a-z0-9-]*)?$/u.test((value ?? "").trim())
      ? undefined
      : "Usa el formato provider/model-id[#variant]",
  });
  return p.isCancel(custom) ? undefined : custom.trim();
}

async function chooseRole(models: ModelMap): Promise<ModelRole | undefined> {
  const role = await p.select<ModelRole>({
    message: "Proceso o step que deseas actualizar",
    options: ROLES.map((item) => ({
      value: item.role,
      label: `[${item.category === "flow" ? "Flow" : "Blueprint"}] ${item.label}`,
      hint: formatModelTarget(models.roles[item.role]),
    })),
  });
  return p.isCancel(role) ? undefined : role;
}

export async function interactiveModelSelector(
  paths: MrPaths,
  options: ModelSelectorOptions = {},
): Promise<boolean> {
  p.intro(options.installation
    ? "Configuración inicial de modelos de mr-orchestrator"
    : `flow-models — configuración ${options.harness === undefined ? "global" : `del arnés ${options.harness}`} por steps`);

  const global = await loadModels(paths);
  const override = options.harness === undefined ? undefined : await loadHarnessOverride(paths, options.harness);
  let currentEffective: EffectiveHarnessModels | undefined;
  let resolutionWarning: string | undefined;
  if (options.harness !== undefined) {
    try {
      currentEffective = await loadEffectiveModels(paths, options.harness);
    } catch (error: unknown) {
      resolutionWarning = error instanceof Error ? error.message : String(error);
    }
  }
  const current = currentEffective === undefined
    ? (options.harness === undefined ? global : inheritedLogicalModelMap(global, override))
    : logicalModelMap(currentEffective);
  let draft: ModelMap = structuredClone(current);
  const storedCatalog = options.harness === undefined ? undefined : await loadHarnessCatalog(paths, options.harness);
  let catalog = storedCatalog === undefined
    ? (options.harness === undefined || options.harness === "opencode"
        ? discoverAvailableModels()
        : { models: [], source: options.harness })
    : { models: Object.keys(storedCatalog.models), source: options.harness };
  let dirty = false;
  if (resolutionWarning !== undefined) p.log.warn(`El roster actual todavía no es válido: ${resolutionWarning}`);
  if ("warning" in catalog && catalog.warning !== undefined) p.log.warn(catalog.warning);
  else p.log.info(`${String(catalog.models.length)} modelos encontrados en ${options.harness ?? "OpenCode"}.`);

  for (;;) {
    p.note(
      !dirty && currentEffective !== undefined ? formatEffectiveModelMatrix(currentEffective) : formatModelMatrix(draft),
      "Modelos por proceso / step",
    );
    const action = await p.select<string>({
      message: "¿Qué deseas hacer?",
      options: [
        { value: "all", label: "Configurar todos los procesos", hint: "recorrido guiado completo (11 steps)" },
        { value: "flow", label: "Configurar steps de /flow", hint: "8 steps: orchestrator, explore, plan, etc." },
        { value: "blueprint", label: "Configurar steps de /blueprint", hint: "3 steps: extractor, architect, transactor" },
        { value: "role", label: "Cambiar un proceso concreto" },
        { value: "preset", label: "Aplicar un preset" },
        { value: "refresh", label: "Actualizar catálogo desde OpenCode" },
        { value: "save", label: "Guardar y salir", hint: dirty ? "hay cambios pendientes" : "sin cambios" },
        { value: "cancel", label: "Salir sin guardar" },
      ],
    });

    if (p.isCancel(action) || action === "cancel") {
      p.cancel("Configuración cancelada; no se guardaron cambios.");
      return false;
    }
    if (action === "save") {
      if (dirty) {
        if (options.harness === undefined) await setModels(paths, draft, options.sync ?? true);
        else await setHarnessModels(paths, options.harness, draft, options.sync ?? true);
      }
      p.outro(dirty
        ? `Modelos guardados en ${options.harness === undefined ? "el roster global" : `el override de ${options.harness}`}. Reinicia las sesiones activas para aplicarlos.`
        : "No había cambios que guardar.");
      return dirty;
    }
    if (action === "refresh") {
      if (options.harness === undefined) {
        catalog = discoverAvailableModels();
      } else {
        const refreshed = await refreshHarnessCatalog(paths, options.harness);
        catalog = {
          models: Object.keys(refreshed.catalog.models),
          source: options.harness,
          ...(refreshed.warning === undefined ? {} : { warning: refreshed.warning }),
        };
      }
      if ("warning" in catalog && catalog.warning !== undefined) p.log.warn(catalog.warning);
      else p.log.success(`Catálogo actualizado: ${String(catalog.models.length)} modelos.`);
      continue;
    }
    if (action === "preset") {
      const preset = await p.select<string>({
        message: "Preset",
        options: Object.entries(PRESETS).map(([key, value]) => ({
          value: key,
          label: value.name,
          hint: value.description,
        })),
      });
      if (!p.isCancel(preset)) {
        const selected = PRESETS[preset];
        if (selected !== undefined) {
          draft = structuredClone({ schemaVersion: draft.schemaVersion, roles: selected.roles });
          dirty = true;
        }
      }
      continue;
    }

    let roles: ModelRole[] = [];
    if (action === "all") {
      roles = ROLES.map((item) => item.role);
    } else if (action === "flow") {
      roles = ROLES.filter((item) => item.category === "flow").map((item) => item.role);
    } else if (action === "blueprint") {
      roles = ROLES.filter((item) => item.category === "blueprint").map((item) => item.role);
    } else {
      const single = await chooseRole(draft);
      if (single !== undefined) roles = [single];
    }

    for (const role of roles) {
      const selected = await chooseModel(
        role,
        formatModelTarget(draft.roles[role]),
        catalog.models.filter((model) => !model.startsWith("openrouter/")),
        "principal",
      );
      if (selected === undefined) break;
      const alternative = await chooseModel(
        role,
        formatModelTarget(draft.roles[role].alternative),
        catalog.models.filter((model) => !model.startsWith("openrouter/")),
        "alternativo",
      );
      if (alternative === undefined) break;
      const currentAssignment = draft.roles[role];
      if (selected !== formatModelTarget(currentAssignment) || alternative !== formatModelTarget(currentAssignment.alternative)) {
        draft = {
          ...draft,
          roles: {
            ...draft.roles,
            [role]: { ...parseModelTarget(selected), alternative: parseModelTarget(alternative) },
          },
        };
        dirty = true;
      }
    }
  }
}
