import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePaths } from "../src/core/paths.js";
import { formatModelMatrix } from "../src/tui/models.js";
import {
  fetchAvailableModels,
  parseAvailableModels,
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
    for (const [role, model] of Object.entries(preset.roles)) {
      assert.ok(model.includes("/"), `Model for role ${role} in preset ${key} must have provider prefix`);
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
  assert.equal(initial.roles.orchestrator, "github-copilot/kimi-k3");
  assert.equal(initial.roles.explore, "github-copilot/gemini-3.7-flash");
  assert.equal(initial.roles.judgeB, "github-copilot/claude-opus-5");

  // Update a single role and verify the generated config file in the workspace
  await setModelRole(paths, "orchestrator", "github-copilot/gpt-5.6-sol");
  const updated = await loadModels(paths);
  assert.equal(updated.roles.orchestrator, "github-copilot/gpt-5.6-sol");
  assert.equal(updated.roles.explore, "github-copilot/gemini-3.7-flash"); // other roles intact

  const generatedFile = generatedConfigPath(paths, profile.id);
  const generatedContent = await readFile(generatedFile, "utf8");
  assert.match(generatedContent, /github-copilot\/gpt-5\.6-sol/u);

  // Apply a preset
  await setModelPreset(paths, "claude-opus");
  const presetApplied = await loadModels(paths);
  assert.equal(presetApplied.roles.orchestrator, "github-copilot/claude-opus-5");
  assert.equal(presetApplied.roles.general, "github-copilot/claude-sonnet-4.6");

  // Format matrix includes recommended badges
  const formatted = formatModelMatrix(presetApplied);
  assert.match(formatted, /claude-opus-5/u);
  assert.match(formatted, /\(recomendado\)/u);
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
    orchestrator: "no-provider-model",
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
  assert.equal(config.agent["orchestrator"]?.model, "github-copilot/kimi-k3");
  assert.equal(config.agent["mr-judge-a"]?.model, "github-copilot/grok-4.6");
  assert.equal(config.agent["mr-judge-b"]?.model, "github-copilot/claude-opus-5");
});
