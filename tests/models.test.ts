import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePaths } from "../src/core/paths.js";
import { formatModelMatrix } from "../src/tui/models.js";
import {
  fetchAvailableModels,
  buildModelCandidates,
  parseAvailableModels,
  promoteAlternativeModel,
  setModelPreset,
  setModelRole,
  saveModels,
  PRESETS,
  ROLES,
  type ModelRole,
} from "../src/core/models.js";
import { loadModels, buildOpenCodeConfig, generatedConfigPath } from "../src/core/config.js";
import { addWorkspace } from "../src/core/workspace.js";
import type { WorkspaceProfile } from "../src/core/schema.js";
import { classifyQuotaError, resolveModelRole } from "../src/core/quota.js";

void test("repository models.json keeps the governed role roster", async () => {
  const configured = JSON.parse(await readFile(join(process.cwd(), "models.json"), "utf8")) as {
    roles: Record<string, { model: string; variant?: string; alternative: { model: string; variant?: string } }>;
  };
  assert.deepEqual(configured.roles, {
    orchestrator: { model: "github-copilot/gemini-3.8-flash", variant: "high", alternative: { model: "opencode-go/deepseek-v4.1-flash", variant: "high" } },
    explore: { model: "opencode-go/deepseek-v4.1-flash", variant: "high", alternative: { model: "github-copilot/gemini-3.8-flash", variant: "high" } },
    plan: { model: "openai/gpt-5.6-sol", variant: "high", alternative: { model: "openai/gpt-6-astra", variant: "xhigh" } },
    general: { model: "github-copilot/gpt-5.6-sol", variant: "high", alternative: { model: "github-copilot/claude-opus-5", variant: "medium" } },
    sddApply: { model: "openai/gpt-5.6-sol", variant: "high", alternative: { model: "github-copilot/claude-opus-5", variant: "medium" } },
    judgeA: { model: "opencode-go/glm-5.3", variant: "max", alternative: { model: "github-copilot/grok-4.6", variant: "xhigh" } },
    judgeB: { model: "opencode-go/qwen3.8-max", variant: "xhigh", alternative: { model: "github-copilot/grok-4.6", variant: "xhigh" } },
    fix: { model: "openai/gpt-5.6-sol", variant: "high", alternative: { model: "opencode-go/deepseek-v4.1-flash", variant: "max" } },
    bpExtractor: { model: "opencode-go/deepseek-v4.1-flash", variant: "low", alternative: { model: "github-copilot/gemini-3.8-flash", variant: "low" } },
    bpArchitect: { model: "opencode/claude-fable-5-1", variant: "max", alternative: { model: "openai/gpt-5.6-sol", variant: "high" } },
    bpTransactor: { model: "opencode-go/deepseek-v4.1-flash", variant: "low", alternative: { model: "github-copilot/gemini-3.8-flash", variant: "low" } },
  });
});

void test("all 11 roles are defined with labels, descriptions, and recommended models", () => {
  const expectedRoles: ModelRole[] = [
    "orchestrator",
    "explore",
    "plan",
    "general",
    "sddApply",
    "judgeA",
    "judgeB",
    "fix",
    "bpExtractor",
    "bpArchitect",
    "bpTransactor",
  ];

  assert.equal(ROLES.length, 11);
  for (const roleKey of expectedRoles) {
    const meta = ROLES.find((r) => r.role === roleKey);
    assert.ok(meta, `Role ${roleKey} must exist in ROLES metadata`);
    assert.ok(meta.label.length > 0);
    assert.ok(meta.description.length > 0);
    assert.ok(meta.recommendedModel.includes("/"));
    assert.ok(meta.category === "flow" || meta.category === "blueprint");
  }
});

void test("presets registry contains valid presets covering all 11 roles", () => {
  const presetKeys = Object.keys(PRESETS);
  assert.ok(presetKeys.includes("balanced"));
  assert.ok(presetKeys.includes("gpt-sol"));
  assert.ok(presetKeys.includes("claude-opus"));

  for (const key of presetKeys) {
    const preset = PRESETS[key]!;
    assert.ok(preset.name.length > 0);
    assert.ok(preset.description.length > 0);
    assert.equal(Object.keys(preset.roles).length, 11);
    for (const [role, assignment] of Object.entries(preset.roles)) {
      assert.ok(assignment.model.includes("/"), `Model for role ${role} in preset ${key} must have provider prefix`);
      assert.ok(assignment.alternative.model.includes("/"), `Alternative for role ${role} in preset ${key} must have provider prefix`);
    }
  }
});

void test("models module allows setting roles and presets with workspace sync", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-models-"));
  const workspaceDir = join(home, "my-workspace");
  await mkdir(join(workspaceDir, ".aicontext"), { recursive: true });
  const paths = resolvePaths({ HOME: home });
  await mkdir(paths.configRoot, { recursive: true });

  await saveModels(paths, {
    schemaVersion: 1,
    roles: PRESETS["balanced"]!.roles,
  });

  // Register workspace so syncAllWorkspaces actually generates files
  const profile = await addWorkspace(paths, workspaceDir);

  const initial = await loadModels(paths);
  assert.equal(initial.roles.orchestrator.model, "github-copilot/kimi-k3");
  assert.equal(initial.roles.explore.model, "github-copilot/gemini-3.7-flash");
  assert.equal(initial.roles.judgeB.model, "github-copilot/claude-opus-5");

  // Update a single role and verify the generated config file in the workspace
  await setModelRole(paths, "orchestrator", "github-copilot/gpt-5.6-sol");
  const updated = await loadModels(paths);
  assert.equal(updated.roles.orchestrator.model, "github-copilot/gpt-5.6-sol");
  assert.equal(updated.roles.explore.model, "github-copilot/gemini-3.7-flash"); // other roles intact

  await setModelRole(paths, "orchestrator", "opencode-go/kimi-k2.7-code", "alternative");
  const withAlternative = await loadModels(paths);
  assert.equal(withAlternative.roles.orchestrator.model, "github-copilot/gpt-5.6-sol");
  assert.equal(withAlternative.roles.orchestrator.alternative.model, "opencode-go/kimi-k2.7-code");

  const generatedFile = generatedConfigPath(paths, profile.id);
  const generatedContent = await readFile(generatedFile, "utf8");
  assert.match(generatedContent, /github-copilot\/gpt-5\.6-sol/u);

  // Apply a preset
  await setModelPreset(paths, "claude-opus");
  const presetApplied = await loadModels(paths);
  assert.equal(presetApplied.roles.orchestrator.model, "github-copilot/claude-opus-5");
  assert.equal(presetApplied.roles.general.model, "github-copilot/claude-sonnet-4.6");

  // Format matrix includes primary and role-specific fallback
  const formatted = formatModelMatrix(presetApplied);
  assert.match(formatted, /claude-opus-5/u);
  assert.match(formatted, /fallback:/u);
});

void test("setModelPreset throws descriptive error for unknown preset", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-models-err-"));
  const paths = resolvePaths({ HOME: home });
  await mkdir(paths.configRoot, { recursive: true });
  await saveModels(paths, { schemaVersion: 1, roles: PRESETS["balanced"]!.roles });

  await assert.rejects(
    setModelPreset(paths, "non-existent-preset"),
    /Preset desconocido 'non-existent-preset'/u,
  );
});

void test("saveModels rejects models without provider prefix", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-models-inv-"));
  const paths = resolvePaths({ HOME: home });
  await mkdir(paths.configRoot, { recursive: true });

  const invalidRoles = {
    ...PRESETS["balanced"]!.roles,
    orchestrator: { ...PRESETS["balanced"]!.roles.orchestrator, model: "no-provider-model" },
  };

  await assert.rejects(
    saveModels(paths, { schemaVersion: 1, roles: invalidRoles }),
  );
});

void test("fetchAvailableModels returns non-empty list and filters invalid lines", () => {
  const models = fetchAvailableModels();
  assert.ok(models.length > 0);
  for (const model of models) {
    assert.ok(model.includes("/"));
    assert.ok(!model.includes("\n"));
  }
});

void test("parseAvailableModels strips terminal colors, invalid lines, and duplicates", () => {
  assert.deepEqual(parseAvailableModels([
    "\u001B[32mopenai/gpt-5.6-sol\u001B[0m",
    "not-a-model",
    "openai/gpt-5.6-sol",
    "opencode/kimi-k3",
  ].join("\n")), ["openai/gpt-5.6-sol", "opencode/kimi-k3"]);
});

void test("buildModelCandidates excludes the failed model and disabled providers", () => {
  const result = buildModelCandidates(
    { model: "github-copilot/gpt-5.6-sol", alternative: { model: "opencode-go/deepseek-v4-pro" } },
    [
      "github-copilot/gpt-5.6-sol",
      "github-copilot/kimi-k3",
      "github-copilot/kimi-k3",
      "openrouter/forbidden-model",
    ],
    "github-copilot/gpt-5.6-sol",
  );

  assert.equal(result.activeModel, "github-copilot/gpt-5.6-sol");
  assert.equal(result.alternativeModel, "opencode-go/deepseek-v4-pro");
  assert.deepEqual(result.candidates, ["github-copilot/kimi-k3"]);
  assert.match(result.warning, /no confirma cuota/u);
});

void test("loadModels migrates legacy string roles and alternative promotion is atomic", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-models-migrate-"));
  const paths = resolvePaths({ HOME: home });
  await mkdir(paths.configRoot, { recursive: true });
  const legacyRoles = Object.fromEntries(
    ROLES.map(({ role }) => [role, `legacy/${role}`]),
  );
  legacyRoles["general"] = "legacy/general#max";
  await Bun.write(paths.models, JSON.stringify({ schemaVersion: 1, roles: legacyRoles }));
  await Bun.write(paths.registry, JSON.stringify({ schemaVersion: 1, workspaces: [] }));

  const migrated = await loadModels(paths);
  assert.equal(migrated.roles.general.model, "legacy/general");
  assert.equal(migrated.roles.general.variant, "max");
  assert.equal(migrated.roles.general.alternative.model, "github-copilot/claude-opus-5");
  assert.equal(migrated.roles.general.alternative.variant, "medium");

  const promotion = await promoteAlternativeModel(paths, "general", "legacy/general#high");
  assert.equal(promotion.promoted, true);
  assert.equal(promotion.model, "github-copilot/claude-opus-5#medium");
  assert.equal(promotion.alternative, "legacy/general#max");

  const persisted = await loadModels(paths);
  assert.equal(persisted.roles.general.model, "github-copilot/claude-opus-5");
  assert.equal(persisted.roles.general.variant, "medium");
  assert.equal(persisted.roles.general.alternative.model, "legacy/general");
  assert.equal(persisted.roles.general.alternative.variant, "max");
});

void test("classifies only non-recoverable quota failures and maps OpenCode agents to roles", () => {
  assert.deepEqual(classifyQuotaError({
    name: "APIError",
    data: { statusCode: 429, responseBody: '{"code":"insufficient_quota"}' },
  }), { code: "insufficient_quota", statusCode: 429 });
  assert.deepEqual(classifyQuotaError({
    name: "APIError",
    data: { statusCode: 429, responseBody: '{"code":"rate_limit_exceeded"}' },
  }), undefined);
  assert.equal(resolveModelRole("mr-sdd-apply"), "sddApply");
  assert.equal(resolveModelRole("unknown-agent"), undefined);
});

void test("buildOpenCodeConfig includes the interactive flow-models workflow and disables openrouter", () => {
  const sampleProfile: WorkspaceProfile = {
    schemaVersion: 1,
    id: "ws-test",
    name: "ws-test",
    root: "/tmp/ws",
    contextRoot: "/tmp/ws/.aicontext",
  };

  const config = buildOpenCodeConfig(sampleProfile, {
    schemaVersion: 1,
    roles: PRESETS["balanced"]!.roles,
  }, "/generated") as {
    disabled_providers: string[];
    command: Record<string, { description: string; template: string }>;
    agent: Record<string, { model: string }>;
  };

  assert.deepEqual(config.disabled_providers, ["openrouter"]);
  assert.match(config.command["flow-models"]?.template ?? "", /native `question` tool/u);
  assert.match(config.command["flow-models"]?.template ?? "", /mr_models/u);
  assert.match(config.command["flow-models"]?.template ?? "", /action `candidates`/u);
  assert.equal(config.agent["orchestrator"]?.model, "github-copilot/kimi-k3");
  assert.equal(config.agent["mr-judge-a"]?.model, "github-copilot/grok-4.6");
  assert.equal(config.agent["mr-judge-b"]?.model, "github-copilot/claude-opus-5");
});
