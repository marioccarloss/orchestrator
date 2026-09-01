import * as p from "@clack/prompts";
import type { MrPaths } from "../core/paths.js";
import { loadModels } from "../core/config.js";
import {
  ROLES,
  PRESETS,
  discoverAvailableModels,
  setModels,
  type ModelRole,
} from "../core/models.js";
import type { ModelMap } from "../core/schema.js";

export interface ModelSelectorOptions {
  readonly installation?: boolean;
  readonly sync?: boolean;
}

export function formatModelMatrix(models: ModelMap): string {
  const lines: string[] = [];
  for (const info of ROLES) {
    const currentModel = models.roles[info.role];
    const isRecommended = currentModel === info.recommendedModel;
    const badge = isRecommended ? " (recomendado)" : "";
    lines.push(`• ${info.label.padEnd(28)} → ${currentModel}${badge}\n    └ ${info.description}`);
  }
  return lines.join("\n");
}

async function chooseModel(
  role: ModelRole,
  current: string,
  availableModels: readonly string[],
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
    message: `Modelo para ${meta?.label ?? role}`,
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
    placeholder: "provider/model-id",
    validate: (value) => /^[^\s/]+\/.+$/u.test((value ?? "").trim())
      ? undefined
      : "Usa el formato provider/model-id",
  });
  return p.isCancel(custom) ? undefined : custom.trim();
}

async function chooseRole(models: ModelMap): Promise<ModelRole | undefined> {
  const role = await p.select<ModelRole>({
    message: "Proceso o step que deseas actualizar",
    options: ROLES.map((item) => ({
      value: item.role,
      label: item.label,
      hint: models.roles[item.role],
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
    : "flow-models — configuración de modelos");

  const current = await loadModels(paths);
  let draft: ModelMap = { schemaVersion: current.schemaVersion, roles: { ...current.roles } };
  let catalog = discoverAvailableModels();
  let dirty = false;
  if (catalog.warning !== undefined) p.log.warn(catalog.warning);
  else p.log.info(`${String(catalog.models.length)} modelos encontrados en OpenCode.`);

  for (;;) {
    p.note(formatModelMatrix(draft), "Modelos por proceso / step");
    const action = await p.select<string>({
      message: "¿Qué deseas hacer?",
      options: [
        { value: "all", label: "Configurar todos los procesos", hint: "recorrido guiado, uno por uno" },
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
      if (dirty) await setModels(paths, draft, options.sync ?? true);
      p.outro(dirty
        ? "Modelos guardados. Reinicia las sesiones activas de OpenCode para aplicarlos."
        : "No había cambios que guardar.");
      return dirty;
    }
    if (action === "refresh") {
      catalog = discoverAvailableModels();
      if (catalog.warning !== undefined) p.log.warn(catalog.warning);
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
          draft = { schemaVersion: draft.schemaVersion, roles: { ...selected.roles } };
          dirty = true;
        }
      }
      continue;
    }

    const roles = action === "all"
      ? ROLES.map((item) => item.role)
      : [await chooseRole(draft)].filter((role): role is ModelRole => role !== undefined);
    for (const role of roles) {
      const selected = await chooseModel(
        role,
        draft.roles[role],
        catalog.models.filter((model) => !model.startsWith("openrouter/")),
      );
      if (selected === undefined) break;
      if (selected !== draft.roles[role]) {
        draft = { ...draft, roles: { ...draft.roles, [role]: selected } };
        dirty = true;
      }
    }
  }
}
