import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson } from "../files.js";
import type { MrPaths } from "../paths.js";
import { spawnSync } from "node:child_process";
import { ModelTargetSchema, type ModelTarget } from "../schema.js";
import { TaskEffortRoleSchema, type TaskEffortRole } from "./effort.js";

/**
 * Developer-owned model per /task role (explore, plan, apply=general). When a role
 * has no override it inherits the /flow role of the same name. Speed is encoded
 * in the model id: OpenCode exposes faster/cheaper service tiers as sibling
 * models (e.g. openai/gpt-5.6-sol-fast with serviceTier=priority).
 */

export const TaskModelsConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  roles: z.partialRecord(TaskEffortRoleSchema, ModelTargetSchema),
});
export type TaskModelsConfig = z.infer<typeof TaskModelsConfigSchema>;

export const EMPTY_TASK_MODELS: TaskModelsConfig = { schemaVersion: 1, roles: {} };

export const TASK_ROLE_LABELS: Readonly<Record<TaskEffortRole, string>> = {
  explore: "explore · lee y registra",
  plan: "plan · razona y planifica",
  general: "apply · implementa pasos con intent",
};

export function taskModelsPath(paths: MrPaths): string {
  return join(paths.configRoot, "task-models.json");
}

export function loadTaskModelsSync(paths: MrPaths): TaskModelsConfig {
  let raw: string;
  try {
    raw = readFileSync(taskModelsPath(paths), "utf8");
  } catch {
    return EMPTY_TASK_MODELS;
  }
  const parsed = TaskModelsConfigSchema.safeParse(JSON.parse(raw) as unknown);
  if (!parsed.success) {
    console.warn(`[mr-orchestrator] Ignoring invalid ${taskModelsPath(paths)}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return EMPTY_TASK_MODELS;
  }
  return parsed.data;
}

export async function saveTaskModels(paths: MrPaths, config: TaskModelsConfig): Promise<void> {
  await atomicWrite(taskModelsPath(paths), canonicalJson(TaskModelsConfigSchema.parse(config)));
}

export function setTaskModel(config: TaskModelsConfig, role: TaskEffortRole, target: ModelTarget | undefined): TaskModelsConfig {
  const roles = Object.fromEntries(Object.entries(config.roles).filter(([key]) => key !== role));
  return TaskModelsConfigSchema.parse({ schemaVersion: 1, roles: target === undefined ? roles : { ...roles, [role]: ModelTargetSchema.parse(target) } });
}

export function parseTaskRoleArgument(value: string | undefined): TaskEffortRole {
  if (value === "apply") return "general";
  return TaskEffortRoleSchema.parse(value);
}

// ─── OpenCode verbose catalog: variants (effort) and service tiers (speed) ───

export interface CatalogEntry {
  readonly id: string;
  readonly providerID: string;
  readonly apiId: string;
  readonly name: string;
  readonly variants: readonly string[];
  readonly serviceTier?: string;
}

const MODEL_HEADER = /^([a-z0-9][\w.-]*\/\S+)$/u;

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Parses `opencode models --verbose`: a `provider/model` line followed by a JSON object. */
export function parseVerboseCatalog(output: string): readonly CatalogEntry[] {
  const lines = output.split("\n");
  const entries: CatalogEntry[] = [];
  let header: string | undefined;
  let buffer: string[] = [];
  const flush = (): void => {
    if (header === undefined || buffer.length === 0) return;
    try {
      const json = asRecord(JSON.parse(buffer.join("\n")) as unknown);
      const providerID = typeof json["providerID"] === "string" ? json["providerID"] : header.split("/")[0] ?? "";
      const api = asRecord(json["api"]);
      const options = asRecord(json["options"]);
      const serviceTier = typeof options["serviceTier"] === "string" ? options["serviceTier"] : undefined;
      entries.push({
        id: header,
        providerID,
        apiId: typeof api["id"] === "string" ? api["id"] : header.slice(providerID.length + 1),
        name: typeof json["name"] === "string" ? json["name"] : header,
        variants: Object.keys(asRecord(json["variants"])),
        ...(serviceTier === undefined ? {} : { serviceTier }),
      });
    } catch {
      // A malformed block only drops that model.
    }
  };
  for (const line of lines) {
    const match = MODEL_HEADER.exec(line.trim());
    if (match !== null && !line.startsWith(" ") && !line.startsWith("{")) {
      flush();
      header = match[1];
      buffer = [];
      continue;
    }
    if (header !== undefined) buffer.push(line);
  }
  flush();
  return entries;
}

export const SPEED_LABELS: Readonly<Record<string, string>> = {
  standard: "estándar",
  priority: "rápida (priority)",
  fast: "rápida",
  ultrafast: "ultrarrápida",
  flex: "económica (flex, más lenta)",
};

export interface SpeedOption {
  readonly id: string;
  readonly speed: string;
  readonly label: string;
}

/** Base models only: speed siblings are offered in the Velocidad tab, not in the model list. */
export function baseModels(catalog: readonly CatalogEntry[]): readonly CatalogEntry[] {
  return catalog.filter((entry) => entry.serviceTier === undefined);
}

export function speedOptions(catalog: readonly CatalogEntry[], modelId: string): readonly SpeedOption[] {
  const selected = catalog.find((entry) => entry.id === modelId);
  if (selected === undefined) return [];
  const siblings = catalog.filter((entry) => entry.providerID === selected.providerID && entry.apiId === selected.apiId);
  if (siblings.length <= 1) return [];
  return siblings
    .map((entry) => {
      const speed = entry.serviceTier ?? "standard";
      return { id: entry.id, speed, label: SPEED_LABELS[speed] ?? speed };
    })
    .sort((left, right) => (left.speed === "standard" ? -1 : right.speed === "standard" ? 1 : left.speed.localeCompare(right.speed)));
}

/** Base entry for a possibly speed-specific model id (gpt-x-fast → gpt-x). */
export function baseModelOf(catalog: readonly CatalogEntry[], modelId: string): string {
  const selected = catalog.find((entry) => entry.id === modelId);
  if (selected?.serviceTier === undefined) return modelId;
  return catalog.find((entry) => entry.providerID === selected.providerID && entry.apiId === selected.apiId && entry.serviceTier === undefined)?.id ?? modelId;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `opencode models --verbose` is slow (tens of seconds), so it is cached for a day. */
export async function loadVerboseCatalog(paths: MrPaths, refresh = false): Promise<{ readonly entries: readonly CatalogEntry[]; readonly warning?: string }> {
  const cache = join(paths.cacheRoot, "opencode-models-verbose.json");
  if (!refresh && existsSync(cache) && Date.now() - statSync(cache).mtimeMs < DAY_MS) {
    try {
      return { entries: JSON.parse(readFileSync(cache, "utf8")) as CatalogEntry[] };
    } catch {
      // Fall through to a fresh read.
    }
  }
  const result = spawnSync("opencode", ["models", "--verbose"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  const entries = result.status === 0 ? parseVerboseCatalog(result.stdout) : [];
  const detail = (result.stderr ?? result.error?.message ?? "").trim();
  if (entries.length === 0) return { entries: [], warning: `No se pudo leer el catálogo de OpenCode${detail === "" ? "" : `: ${detail.slice(0, 200)}`}` };
  await atomicWrite(cache, JSON.stringify(entries));
  return { entries };
}
