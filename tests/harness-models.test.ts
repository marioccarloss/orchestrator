import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configuredHarnesses,
  generatedHarnessModelsPath,
  harnessCatalogPath,
  harnessOverridePath,
  legacyOpenCodeCatalog,
  loadHarnessOverride,
  logicalModelMap,
  nativeModelMap,
  removeHarnessOverride,
  resolveEffectiveModels,
  resolveStoredHarnessModels,
  saveHarnessCatalog,
  saveHarnessOverride,
  validateConfiguredHarnesses,
  writeEffectiveHarnessModels,
  HarnessModelResolutionError,
} from "../src/core/harness-models.js";
import { resolvePaths } from "../src/core/paths.js";
import { SCHEMA_VERSION, type HarnessModelCatalog, type ModelMap } from "../src/core/schema.js";
import { PRESETS, parseFxAvailableModels, setModels } from "../src/core/models.js";

const globalModels = (): ModelMap => ({
  schemaVersion: SCHEMA_VERSION,
  roles: structuredClone(PRESETS["balanced"]!.roles),
});

function identityCatalog(harness: "cursor" | "codex", models: ModelMap): HarnessModelCatalog {
  const entries: HarnessModelCatalog["models"] = {};
  for (const assignment of Object.values(models.roles)) {
    for (const target of [assignment, assignment.alternative]) {
      const current = entries[target.model];
      entries[target.model] = {
        nativeModel: `native:${target.model}`,
        variants: {
          ...(current?.variants ?? {}),
          ...(target.variant === undefined ? {} : { [target.variant]: `native-${target.variant}` }),
        },
      };
    }
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    harness,
    applicationMode: "per-invocation",
    models: entries,
    provenance: { source: "explicit", refreshedAt: "2026-09-14T00:00:00.000Z" },
  };
}

void test("resolves global inheritance and atomic per-slot harness overrides", () => {
  const global = globalModels();
  const cursorModel = "cursor/composer-2.5";
  const catalog = identityCatalog("cursor", global);
  catalog.models[cursorModel] = {
    nativeModel: "composer-2.5",
    variants: { high: "max" },
  };

  const effective = resolveEffectiveModels(global, {
    schemaVersion: SCHEMA_VERSION,
    harness: "cursor",
    roles: {
      explore: { primary: { model: cursorModel, variant: "high" } },
    },
  }, catalog, "cursor");

  assert.equal(effective.roles.explore.primary.logical.model, cursorModel);
  assert.equal(effective.roles.explore.primary.native.model, "composer-2.5");
  assert.equal(effective.roles.explore.primary.native.variant, "max");
  assert.equal(effective.roles.explore.primary.origin, "harness:cursor");
  assert.deepEqual(effective.roles.explore.alternative.logical, global.roles.explore.alternative);
  assert.equal(effective.roles.explore.alternative.origin, "global");
  assert.deepEqual(logicalModelMap(effective).roles.explore, {
    model: cursorModel,
    variant: "high",
    alternative: global.roles.explore.alternative,
  });
  assert.equal(nativeModelMap(effective).roles.explore.model, "composer-2.5");
});

void test("reports every unsupported inherited model and untranslated variant", () => {
  const global = globalModels();
  global.roles.orchestrator = { ...global.roles.orchestrator, variant: "high" };
  const catalog: HarnessModelCatalog = {
    schemaVersion: SCHEMA_VERSION,
    harness: "codex",
    applicationMode: "per-invocation",
    models: {
      [global.roles.orchestrator.model]: {
        nativeModel: "orchestrator-native",
        variants: {},
      },
    },
    provenance: { source: "explicit" },
  };

  assert.throws(
    () => resolveEffectiveModels(global, undefined, catalog, "codex"),
    (error: unknown) => {
      assert.ok(error instanceof HarnessModelResolutionError);
      assert.ok(error.issues.some((issue) => issue.rule === "variant-not-supported" && issue.role === "orchestrator"));
      assert.ok(error.issues.some((issue) => issue.rule === "model-not-supported" && issue.role === "explore"));
      assert.ok(error.message.includes("[codex]"));
      return true;
    },
  );
});

void test("rejects catalogs that cannot apply a heterogeneous role roster", () => {
  const global = globalModels();
  const catalog = { ...identityCatalog("cursor", global), applicationMode: "session-only" as const };
  assert.throws(
    () => resolveEffectiveModels(global, undefined, catalog, "cursor"),
    /applicationMode 'session-only'/u,
  );
});

void test("rejects an unverified Antigravity native-role claim", () => {
  const global = globalModels();
  const cursorCatalog = identityCatalog("cursor", global);
  const catalog: HarnessModelCatalog = {
    ...cursorCatalog,
    harness: "antigravity",
    applicationMode: "native-role",
  };
  assert.throws(
    () => resolveEffectiveModels(global, undefined, catalog, "antigravity"),
    /no verified managed adapter/u,
  );
});

void test("persists isolated harness catalogs, overrides, effective output, and reset", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-harness-models-"));
  const paths = resolvePaths({ HOME: home });
  const global = globalModels();
  const catalog = identityCatalog("cursor", global);
  await saveHarnessCatalog(paths, catalog);
  await saveHarnessOverride(paths, {
    schemaVersion: SCHEMA_VERSION,
    harness: "cursor",
    roles: { explore: { alternative: global.roles.plan } },
  });

  assert.deepEqual(await configuredHarnesses(paths), ["cursor"]);
  assert.equal((await loadHarnessOverride(paths, "cursor"))?.roles.explore?.alternative?.model, global.roles.plan.model);
  const effective = await resolveStoredHarnessModels(paths, global, "cursor");
  const generated = await writeEffectiveHarnessModels(paths, effective);
  assert.equal(generated, generatedHarnessModelsPath(paths, "cursor"));
  assert.equal(JSON.parse(await readFile(generated, "utf8")).harness, "cursor");
  assert.match(harnessOverridePath(paths, "cursor"), /harnesses\/cursor\/models\.json$/u);
  assert.match(harnessCatalogPath(paths, "cursor"), /harnesses\/cursor\/catalog\.json$/u);

  await removeHarnessOverride(paths, "cursor");
  assert.equal(await loadHarnessOverride(paths, "cursor"), undefined);
});

void test("keeps OpenCode backward compatible without a stored catalog", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-harness-opencode-"));
  const paths = resolvePaths({ HOME: home });
  const global = globalModels();
  const effective = await resolveStoredHarnessModels(paths, global, "opencode");
  assert.deepEqual(nativeModelMap(effective), global);
  assert.equal(legacyOpenCodeCatalog(global).provenance.source, "legacy-identity");
});

void test("rejects global updates that invalidate a configured harness", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-harness-global-"));
  const paths = resolvePaths({ HOME: home });
  const global = globalModels();
  await saveHarnessCatalog(paths, identityCatalog("cursor", global));
  const changed = structuredClone(global);
  changed.roles.explore = {
    ...changed.roles.explore,
    model: "new/model-not-in-cursor",
  };
  await assert.rejects(
    validateConfiguredHarnesses(paths, changed),
    /Global model update would invalidate configured harnesses/u,
  );
});

void test("a valid global update regenerates effective artifacts for configured harnesses", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-harness-global-effective-"));
  const paths = resolvePaths({ HOME: home });
  const global = globalModels();
  const catalog = identityCatalog("cursor", global);
  const changed = structuredClone(global);
  changed.roles.explore = {
    ...changed.roles.explore,
    model: "new/cursor-compatible",
    variant: "high",
  };
  catalog.models["new/cursor-compatible"] = {
    nativeModel: "cursor/new-compatible",
    variants: { high: "max" },
  };
  await saveHarnessCatalog(paths, catalog);
  await writeFile(paths.models, JSON.stringify(global));

  await setModels(paths, changed, false);

  const generated = JSON.parse(await readFile(generatedHarnessModelsPath(paths, "cursor"), "utf8"));
  assert.equal(generated.roles.explore.primary.native.model, "cursor/new-compatible");
  assert.equal(generated.roles.explore.primary.native.variant, "max");
});

void test("parses the documented fx JSON catalog shape", () => {
  assert.deepEqual(parseFxAvailableModels(JSON.stringify({
    kind: "models",
    models: [
      { id: "gpt-5.6-sol", source: "Codex subscription" },
      { id: "anthropic/claude-opus-4.1", source: "Vercel AI Gateway" },
    ],
  })), [
    { id: "gpt-5.6-sol", source: "Codex subscription" },
    { id: "anthropic/claude-opus-4.1", source: "Vercel AI Gateway" },
  ]);
  assert.throws(() => parseFxAvailableModels("{}"), /invalid model catalog/u);
});
