import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import {
  HARNESS_IDS,
  HarnessIdSchema,
  HarnessModelCatalogSchema,
  HarnessModelOverrideSchema,
  MODEL_ROLES,
  SCHEMA_VERSION,
  type HarnessApplicationMode,
  type HarnessId,
  type HarnessModelCatalog,
  type HarnessModelOverride,
  type ModelMap,
  type ModelRoleSchema,
  type ModelTarget,
} from "./schema.js";
import type { z } from "zod";

export type ModelRole = z.infer<typeof ModelRoleSchema>;
export type EffectiveModelOrigin = "global" | `harness:${HarnessId}`;
export type EffectiveModelSlot = "primary" | "alternative";

export interface EffectiveModelTarget {
  readonly logical: ModelTarget;
  readonly native: ModelTarget;
  readonly origin: EffectiveModelOrigin;
}

export interface EffectiveModelAssignment {
  readonly primary: EffectiveModelTarget;
  readonly alternative: EffectiveModelTarget;
}

export interface EffectiveHarnessModels {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly harness: HarnessId;
  readonly applicationMode: HarnessApplicationMode;
  readonly roles: Record<ModelRole, EffectiveModelAssignment>;
}

export interface HarnessModelIssue {
  readonly harness: HarnessId;
  readonly role: ModelRole | "*";
  readonly slot: EffectiveModelSlot | "*";
  readonly origin: EffectiveModelOrigin | "catalog";
  readonly value: string;
  readonly rule: "application-mode" | "model-not-supported" | "variant-not-supported";
  readonly message: string;
}

export class HarnessModelResolutionError extends Error {
  readonly issues: readonly HarnessModelIssue[];

  constructor(issues: readonly HarnessModelIssue[]) {
    super(issues.map((issue) => issue.message).join("\n"));
    this.name = "HarnessModelResolutionError";
    this.issues = issues;
  }
}

const MANAGED_APPLICATION_MODES: Partial<Record<HarnessId, HarnessApplicationMode>> = {
  opencode: "native-role",
  codex: "per-invocation",
  cursor: "per-invocation",
  claude: "per-invocation",
  agy: "per-invocation",
  fx: "per-invocation",
};

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function parseHarnessId(value: string | undefined, fallback: HarnessId = "opencode"): HarnessId {
  return HarnessIdSchema.parse(value ?? fallback);
}

export function harnessModelsRoot(paths: MrPaths): string {
  return join(paths.configRoot, "harnesses");
}

export function harnessRoot(paths: MrPaths, harness: HarnessId): string {
  return join(harnessModelsRoot(paths), harness);
}

export function harnessOverridePath(paths: MrPaths, harness: HarnessId): string {
  return join(harnessRoot(paths, harness), "models.json");
}

export function harnessCatalogPath(paths: MrPaths, harness: HarnessId): string {
  return join(harnessRoot(paths, harness), "catalog.json");
}

export function generatedHarnessModelsPath(paths: MrPaths, harness: HarnessId): string {
  return join(paths.generatedRoot, "harnesses", harness, "effective-models.json");
}

export async function loadHarnessOverride(paths: MrPaths, harness: HarnessId): Promise<HarnessModelOverride | undefined> {
  try {
    const parsed = HarnessModelOverrideSchema.parse(JSON.parse(await readFile(harnessOverridePath(paths, harness), "utf8")) as unknown);
    if (parsed.harness !== harness) {
      throw new Error(`Harness override at ${harnessOverridePath(paths, harness)} declares '${parsed.harness}', expected '${harness}'`);
    }
    return parsed;
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function loadHarnessCatalog(paths: MrPaths, harness: HarnessId): Promise<HarnessModelCatalog | undefined> {
  try {
    const parsed = HarnessModelCatalogSchema.parse(JSON.parse(await readFile(harnessCatalogPath(paths, harness), "utf8")) as unknown);
    if (parsed.harness !== harness) {
      throw new Error(`Harness catalog at ${harnessCatalogPath(paths, harness)} declares '${parsed.harness}', expected '${harness}'`);
    }
    return parsed;
  } catch (error: unknown) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export async function saveHarnessCatalog(paths: MrPaths, catalog: HarnessModelCatalog): Promise<HarnessModelCatalog> {
  const parsed = HarnessModelCatalogSchema.parse(catalog);
  await atomicWrite(harnessCatalogPath(paths, parsed.harness), canonicalJson(parsed));
  return parsed;
}

export async function saveHarnessOverride(paths: MrPaths, override: HarnessModelOverride): Promise<HarnessModelOverride> {
  const parsed = HarnessModelOverrideSchema.parse(override);
  await atomicWrite(harnessOverridePath(paths, parsed.harness), canonicalJson(parsed));
  return parsed;
}

export async function removeHarnessOverride(paths: MrPaths, harness: HarnessId): Promise<void> {
  try {
    await rm(harnessOverridePath(paths, harness));
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
}

function targetKey(target: ModelTarget): string {
  return target.variant === undefined ? target.model : `${target.model}#${target.variant}`;
}

function collectIdentityTarget(
  models: Record<string, { nativeModel: string; variants?: Record<string, string> }>,
  target: ModelTarget,
): void {
  const existing = models[target.model];
  const variants = { ...(existing?.variants ?? {}) };
  if (target.variant !== undefined) variants[target.variant] = target.variant;
  models[target.model] = {
    nativeModel: target.model,
    ...(Object.keys(variants).length === 0 ? {} : { variants }),
  };
}

/** Compatibility catalog for existing OpenCode installs that predate catalog files. */
export function legacyOpenCodeCatalog(global: ModelMap, override?: HarnessModelOverride): HarnessModelCatalog {
  const models: Record<string, { nativeModel: string; variants?: Record<string, string> }> = {};
  for (const role of MODEL_ROLES) {
    const assignment = global.roles[role];
    collectIdentityTarget(models, assignment);
    collectIdentityTarget(models, assignment.alternative);
    const roleOverride = override?.roles[role];
    if (roleOverride?.primary !== undefined) collectIdentityTarget(models, roleOverride.primary);
    if (roleOverride?.alternative !== undefined) collectIdentityTarget(models, roleOverride.alternative);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    harness: "opencode",
    applicationMode: "native-role",
    models,
    provenance: { source: "legacy-identity" },
  };
}

function logicalTarget(global: ModelMap, override: HarnessModelOverride | undefined, role: ModelRole, slot: EffectiveModelSlot): {
  target: ModelTarget;
  origin: EffectiveModelOrigin;
} {
  const roleOverride = override?.roles[role];
  const overridden = slot === "primary" ? roleOverride?.primary : roleOverride?.alternative;
  if (override !== undefined && overridden !== undefined) return { target: overridden, origin: `harness:${override.harness}` };
  const assignment = global.roles[role];
  return { target: slot === "primary" ? assignment : assignment.alternative, origin: "global" };
}

function translateTarget(
  catalog: HarnessModelCatalog,
  role: ModelRole,
  slot: EffectiveModelSlot,
  logical: ModelTarget,
  origin: EffectiveModelOrigin,
  issues: HarnessModelIssue[],
): EffectiveModelTarget | undefined {
  const entry = catalog.models[logical.model];
  if (entry === undefined) {
    const value = targetKey(logical);
    issues.push({
      harness: catalog.harness,
      role,
      slot,
      origin,
      value,
      rule: "model-not-supported",
      message: `[${catalog.harness}] ${role}.${slot} from ${origin} uses unsupported model '${value}'`,
    });
    return undefined;
  }
  let nativeVariant: string | undefined;
  if (logical.variant !== undefined) {
    nativeVariant = entry.variants?.[logical.variant];
    if (nativeVariant === undefined) {
      const value = targetKey(logical);
      issues.push({
        harness: catalog.harness,
        role,
        slot,
        origin,
        value,
        rule: "variant-not-supported",
        message: `[${catalog.harness}] ${role}.${slot} from ${origin} uses variant '${logical.variant}' without an explicit catalog translation for '${logical.model}'`,
      });
      return undefined;
    }
  }
  return {
    logical,
    native: {
      model: entry.nativeModel,
      ...(nativeVariant === undefined ? {} : { variant: nativeVariant }),
    },
    origin,
  };
}

export function resolveEffectiveModels(
  global: ModelMap,
  override: HarnessModelOverride | undefined,
  catalog: HarnessModelCatalog,
  harness: HarnessId,
): EffectiveHarnessModels {
  if (override !== undefined && override.harness !== harness) {
    throw new Error(`Harness override declares '${override.harness}', expected '${harness}'`);
  }
  if (catalog.harness !== harness) {
    throw new Error(`Harness catalog declares '${catalog.harness}', expected '${harness}'`);
  }
  const issues: HarnessModelIssue[] = [];
  const managedMode = MANAGED_APPLICATION_MODES[harness];
  if (managedMode === undefined || catalog.applicationMode !== managedMode) {
    issues.push({
      harness,
      role: "*",
      slot: "*",
      origin: "catalog",
      value: catalog.applicationMode,
      rule: "application-mode",
      message: managedMode === undefined
        ? `[${harness}] no verified managed adapter can apply a heterogeneous role roster; catalog applicationMode is '${catalog.applicationMode}'`
        : `[${harness}] catalog applicationMode '${catalog.applicationMode}' does not match the verified managed adapter mode '${managedMode}'`,
    });
  }
  const roles = {} as Record<ModelRole, EffectiveModelAssignment>;
  for (const role of MODEL_ROLES) {
    const primary = logicalTarget(global, override, role, "primary");
    const alternative = logicalTarget(global, override, role, "alternative");
    const translatedPrimary = translateTarget(catalog, role, "primary", primary.target, primary.origin, issues);
    const translatedAlternative = translateTarget(catalog, role, "alternative", alternative.target, alternative.origin, issues);
    if (translatedPrimary !== undefined && translatedAlternative !== undefined) {
      roles[role] = { primary: translatedPrimary, alternative: translatedAlternative };
    }
  }
  if (issues.length > 0) throw new HarnessModelResolutionError(issues);
  return { schemaVersion: SCHEMA_VERSION, harness, applicationMode: catalog.applicationMode, roles };
}

export async function resolveStoredHarnessModels(
  paths: MrPaths,
  global: ModelMap,
  harness: HarnessId,
): Promise<EffectiveHarnessModels> {
  const override = await loadHarnessOverride(paths, harness);
  const storedCatalog = await loadHarnessCatalog(paths, harness);
  if (storedCatalog === undefined && harness !== "opencode") {
    throw new Error(`[${harness}] no model catalog found at ${harnessCatalogPath(paths, harness)}`);
  }
  return resolveEffectiveModels(global, override, storedCatalog ?? legacyOpenCodeCatalog(global, override), harness);
}

export function nativeModelMap(effective: EffectiveHarnessModels): ModelMap {
  const roles = {} as ModelMap["roles"];
  for (const role of MODEL_ROLES) {
    const assignment = effective.roles[role];
    roles[role] = {
      ...assignment.primary.native,
      alternative: assignment.alternative.native,
    };
  }
  return { schemaVersion: SCHEMA_VERSION, roles };
}

export function logicalModelMap(effective: EffectiveHarnessModels): ModelMap {
  const roles = {} as ModelMap["roles"];
  for (const role of MODEL_ROLES) {
    const assignment = effective.roles[role];
    roles[role] = {
      ...assignment.primary.logical,
      alternative: assignment.alternative.logical,
    };
  }
  return { schemaVersion: SCHEMA_VERSION, roles };
}

export function inheritedLogicalModelMap(global: ModelMap, override: HarnessModelOverride | undefined): ModelMap {
  const roles = {} as ModelMap["roles"];
  for (const role of MODEL_ROLES) {
    const primary = logicalTarget(global, override, role, "primary").target;
    const alternative = logicalTarget(global, override, role, "alternative").target;
    roles[role] = { ...primary, alternative };
  }
  return { schemaVersion: SCHEMA_VERSION, roles };
}

export async function writeEffectiveHarnessModels(paths: MrPaths, effective: EffectiveHarnessModels): Promise<string> {
  const path = generatedHarnessModelsPath(paths, effective.harness);
  await atomicWrite(path, canonicalJson(effective));
  return path;
}

export async function configuredHarnesses(paths: MrPaths): Promise<readonly HarnessId[]> {
  try {
    const entries = await readdir(harnessModelsRoot(paths), { withFileTypes: true });
    const configured = new Set(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => HarnessIdSchema.safeParse(entry.name))
      .filter((result) => result.success)
      .map((result) => result.data));
    return HARNESS_IDS.filter((harness) => configured.has(harness));
  } catch (error: unknown) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

export async function validateConfiguredHarnesses(paths: MrPaths, global: ModelMap): Promise<readonly EffectiveHarnessModels[]> {
  const issues: string[] = [];
  const effectiveHarnesses: EffectiveHarnessModels[] = [];
  const harnesses = new Set<HarnessId>(["opencode", ...await configuredHarnesses(paths)]);
  for (const harness of harnesses) {
    try {
      effectiveHarnesses.push(await resolveStoredHarnessModels(paths, global, harness));
    } catch (error: unknown) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (issues.length > 0) {
    throw new Error(`Global model update would invalidate configured harnesses:\n${issues.join("\n")}`);
  }
  return effectiveHarnesses;
}
