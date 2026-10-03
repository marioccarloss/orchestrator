import * as p from "@clack/prompts";
import { loadModels } from "../core/config.js";
import { formatModelTarget, syncAllWorkspaces } from "../core/models.js";
import type { MrPaths } from "../core/paths.js";
import type { ModelTarget } from "../core/schema.js";
import { TaskEffortRoleSchema, type TaskEffortRole } from "../core/task/effort.js";
import {
  TASK_ROLE_LABELS,
  baseModelOf,
  baseModels,
  loadTaskModelsSync,
  loadVerboseCatalog,
  saveTaskModels,
  setTaskModel,
  speedOptions,
  type CatalogEntry,
  type TaskModelsConfig,
} from "../core/task/models.js";

const TABS = ["Modelo", "Esfuerzo", "Velocidad"] as const;
type Tab = (typeof TABS)[number];

/** Tab strip shown above each step: ● active, ✓ done, ○ pending, – not available for this model. */
export function renderTabs(active: Tab, done: readonly Tab[] = [], unavailable: readonly Tab[] = []): string {
  return TABS.map((tab) => {
    if (tab === active) return `● ${tab}`;
    if (unavailable.includes(tab)) return `– ${tab}`;
    return `${done.includes(tab) ? "✓" : "○"} ${tab}`;
  }).join("   │   ");
}

export function formatTaskModelMatrix(config: TaskModelsConfig, inherited: Readonly<Record<TaskEffortRole, ModelTarget>>): string {
  return TaskEffortRoleSchema.options.map((role) => {
    const own = config.roles[role];
    const target = own ?? inherited[role];
    return `• ${TASK_ROLE_LABELS[role].padEnd(36)} → ${formatModelTarget(target)}${own === undefined ? "  (hereda /flow)" : ""}`;
  }).join("\n");
}

const BACK = "__back__";

interface Draft {
  model: string;
  variant?: string;
}

async function chooseModelTab(role: TaskEffortRole, current: string, catalog: readonly CatalogEntry[]): Promise<string | undefined> {
  p.log.message(renderTabs("Modelo"));
  const base = baseModelOf(catalog, current);
  const options = baseModels(catalog)
    .filter((entry) => !entry.id.startsWith("openrouter/"))
    .map((entry) => ({ value: entry.id, label: entry.id, ...(entry.id === base ? { hint: "actual" } : entry.variants.length > 0 ? { hint: `${String(entry.variants.length)} esfuerzos` } : {}) }));
  const selected = await p.autocomplete<string>({
    message: `Modelo para ${TASK_ROLE_LABELS[role]}`,
    placeholder: "Escribe para filtrar por proveedor o modelo",
    options: options.length === 0 ? [{ value: base, label: base, hint: "actual" }] : options,
    maxItems: 12,
    initialValue: base,
  });
  return p.isCancel(selected) ? undefined : selected;
}

/** Returns the variant, null for the model default, BACK to return to Modelo, or undefined when cancelled. */
async function chooseEffortTab(model: string, current: string | undefined, catalog: readonly CatalogEntry[]): Promise<string | null | undefined> {
  const variants = catalog.find((entry) => entry.id === model)?.variants ?? [];
  if (variants.length === 0) {
    p.log.message(renderTabs("Esfuerzo", ["Modelo"], ["Esfuerzo"]));
    p.log.info("Este modelo no expone niveles de esfuerzo; se usa su comportamiento por defecto.");
    return null;
  }
  p.log.message(renderTabs("Esfuerzo", ["Modelo"]));
  const selected = await p.select<string>({
    message: `Esfuerzo (razonamiento) de ${model}`,
    options: [
      ...variants.map((variant) => ({ value: variant, label: variant, ...(variant === current ? { hint: "actual" } : {}) })),
      { value: "__default__", label: "por defecto del modelo" },
      { value: BACK, label: "← volver a Modelo" },
    ],
    initialValue: current !== undefined && variants.includes(current) ? current : variants.includes("high") ? "high" : variants[0] ?? "__default__",
  });
  if (p.isCancel(selected)) return undefined;
  if (selected === BACK) return BACK;
  return selected === "__default__" ? null : selected;
}

/** Returns the (speed-specific) model id, BACK to return to Esfuerzo, or undefined when cancelled. */
async function chooseSpeedTab(model: string, catalog: readonly CatalogEntry[], unavailableEffort: boolean): Promise<string | undefined> {
  const speeds = speedOptions(catalog, model);
  const done: Tab[] = unavailableEffort ? ["Modelo"] : ["Modelo", "Esfuerzo"];
  const unavailable: Tab[] = unavailableEffort ? ["Esfuerzo"] : [];
  if (speeds.length === 0) {
    p.log.message(renderTabs("Velocidad", done, [...unavailable, "Velocidad"]));
    p.log.info("Este modelo no tiene variantes de velocidad en el catálogo.");
    return model;
  }
  p.log.message(renderTabs("Velocidad", done, unavailable));
  const selected = await p.select<string>({
    message: `Velocidad de ${baseModelOf(catalog, model)}`,
    options: [
      ...speeds.map((option) => ({ value: option.id, label: option.label, hint: option.id })),
      { value: BACK, label: "← volver a Esfuerzo" },
    ],
    initialValue: model,
  });
  if (p.isCancel(selected)) return undefined;
  return selected;
}

/** Model → Effort → Speed for one role. Returns undefined when cancelled. */
async function configureRole(role: TaskEffortRole, current: ModelTarget, catalog: readonly CatalogEntry[]): Promise<ModelTarget | undefined> {
  const draft: Draft = { model: current.model, ...(current.variant === undefined ? {} : { variant: current.variant }) };
  let tab: Tab = "Modelo";
  let effortUnavailable = false;
  for (;;) {
    if (tab === "Modelo") {
      const model = await chooseModelTab(role, draft.model, catalog);
      if (model === undefined) return undefined;
      if (baseModelOf(catalog, draft.model) !== model) {
        draft.model = model;
        delete draft.variant;
      }
      tab = "Esfuerzo";
      continue;
    }
    if (tab === "Esfuerzo") {
      const effort = await chooseEffortTab(baseModelOf(catalog, draft.model), draft.variant, catalog);
      if (effort === undefined) return undefined;
      if (effort === BACK) {
        tab = "Modelo";
        continue;
      }
      effortUnavailable = effort === null && (catalog.find((entry) => entry.id === baseModelOf(catalog, draft.model))?.variants.length ?? 0) === 0;
      if (effort === null) delete draft.variant;
      else draft.variant = effort;
      tab = "Velocidad";
      continue;
    }
    const speed = await chooseSpeedTab(draft.model, catalog, effortUnavailable);
    if (speed === undefined) return undefined;
    if (speed === BACK) {
      tab = "Esfuerzo";
      continue;
    }
    draft.model = speed;
    const variants = catalog.find((entry) => entry.id === draft.model)?.variants ?? [];
    if (draft.variant !== undefined && variants.length > 0 && !variants.includes(draft.variant)) delete draft.variant;
    return { model: draft.model, ...(draft.variant === undefined ? {} : { variant: draft.variant }) };
  }
}

export async function interactiveTaskModelSelector(paths: MrPaths): Promise<boolean> {
  p.intro("task-model — modelo, esfuerzo y velocidad de los roles de /task");
  const global = await loadModels(paths);
  const inherited: Record<TaskEffortRole, ModelTarget> = { explore: global.roles.explore, plan: global.roles.plan, general: global.roles.general };
  let config = loadTaskModelsSync(paths);
  const spinner = p.spinner();
  spinner.start("Leyendo el catálogo de OpenCode (esfuerzos y velocidades)…");
  const loaded = await loadVerboseCatalog(paths);
  spinner.stop(loaded.warning ?? `${String(loaded.entries.length)} modelos en el catálogo.`);
  let catalog = loaded.entries;
  let dirty = false;

  for (;;) {
    p.note(formatTaskModelMatrix(config, inherited), "Roles de /task");
    const action = await p.select<string>({
      message: "¿Qué deseas hacer?",
      options: [
        ...TaskEffortRoleSchema.options.map((role) => ({ value: `role:${role}`, label: `Configurar ${TASK_ROLE_LABELS[role]}` })),
        { value: "all", label: "Configurar los 3 roles", hint: "explore → plan → apply" },
        { value: "reset", label: "Volver a heredar de /flow un rol" },
        { value: "refresh", label: "Actualizar catálogo desde OpenCode" },
        { value: "save", label: "Guardar y salir", hint: dirty ? "hay cambios pendientes" : "sin cambios" },
        { value: "cancel", label: "Salir sin guardar" },
      ],
    });
    if (p.isCancel(action) || action === "cancel") {
      p.cancel("Sin cambios.");
      return false;
    }
    if (action === "save") {
      if (dirty) {
        await saveTaskModels(paths, config);
        await syncAllWorkspaces(paths);
      }
      p.outro(dirty ? "Modelos de /task guardados. Reinicia las sesiones de OpenCode activas." : "No había cambios que guardar.");
      return dirty;
    }
    if (action === "refresh") {
      spinner.start("Actualizando catálogo…");
      const refreshed = await loadVerboseCatalog(paths, true);
      catalog = refreshed.entries.length > 0 ? refreshed.entries : catalog;
      spinner.stop(refreshed.warning ?? `${String(catalog.length)} modelos.`);
      continue;
    }
    if (action === "reset") {
      const role = await p.select<TaskEffortRole>({
        message: "Rol que vuelve a heredar el modelo de /flow",
        options: TaskEffortRoleSchema.options.map((item) => ({ value: item, label: TASK_ROLE_LABELS[item] })),
      });
      if (!p.isCancel(role)) {
        config = setTaskModel(config, role, undefined);
        dirty = true;
      }
      continue;
    }
    const roles: TaskEffortRole[] = action === "all" ? [...TaskEffortRoleSchema.options] : [TaskEffortRoleSchema.parse(action.replace(/^role:/u, ""))];
    for (const role of roles) {
      if (catalog.length === 0) {
        p.log.warn("Catálogo vacío: usa `mr task-model set <rol> <provider/model[#variant]>`.");
        break;
      }
      const target = await configureRole(role, config.roles[role] ?? inherited[role], catalog);
      if (target === undefined) break;
      config = setTaskModel(config, role, target);
      dirty = true;
      p.log.success(`${TASK_ROLE_LABELS[role]} → ${formatModelTarget(target)}`);
    }
  }
}
