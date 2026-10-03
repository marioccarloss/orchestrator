import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { agentDefinitions } from "../src/core/config.js";
import { ModelMapSchema } from "../src/core/schema.js";
import { EMPTY_TASK_EFFORT, setTaskEffort } from "../src/core/task/effort.js";
import {
  EMPTY_TASK_MODELS,
  baseModelOf,
  baseModels,
  parseTaskRoleArgument,
  parseVerboseCatalog,
  setTaskModel,
  speedOptions,
} from "../src/core/task/models.js";
import { formatTaskModelMatrix, renderTabs } from "../src/tui/task-models.js";

const VERBOSE = `openai/gpt-5.6-sol
{
  "id": "gpt-5.6-sol",
  "providerID": "openai",
  "name": "GPT-5.6 Sol",
  "api": { "id": "gpt-5.6-sol", "npm": "@ai-sdk/openai" },
  "options": {},
  "variants": { "low": {}, "medium": {}, "high": {}, "xhigh": {} }
}
openai/gpt-5.6-sol-fast
{
  "id": "gpt-5.6-sol-fast",
  "providerID": "openai",
  "name": "GPT-5.6 Sol Fast",
  "api": { "id": "gpt-5.6-sol", "npm": "@ai-sdk/openai" },
  "options": { "serviceTier": "priority" },
  "variants": { "low": {}, "high": {} }
}
openai/gpt-5.6-sol-flex
{
  "id": "gpt-5.6-sol-flex",
  "providerID": "openai",
  "name": "GPT-5.6 Sol Flex",
  "api": { "id": "gpt-5.6-sol" },
  "options": { "serviceTier": "flex" },
  "variants": {}
}
github-copilot/claude-opus-5.5
{
  "id": "claude-opus-5.5",
  "providerID": "github-copilot",
  "name": "Claude Opus 5.5",
  "api": { "id": "claude-opus-5.5" },
  "options": {},
  "variants": { "low": {}, "max": {} }
}`;

void test("verbose catalog exposes effort (variants) and speed (service-tier siblings)", () => {
  const catalog = parseVerboseCatalog(VERBOSE);
  assert.equal(catalog.length, 4);
  assert.deepEqual(baseModels(catalog).map((entry) => entry.id), ["openai/gpt-5.6-sol", "github-copilot/claude-opus-5.5"]);
  assert.deepEqual(catalog[0]?.variants, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(speedOptions(catalog, "openai/gpt-5.6-sol").map((option) => [option.id, option.speed]), [
    ["openai/gpt-5.6-sol", "standard"],
    ["openai/gpt-5.6-sol-flex", "flex"],
    ["openai/gpt-5.6-sol-fast", "priority"],
  ]);
  assert.deepEqual(speedOptions(catalog, "github-copilot/claude-opus-5.5"), [], "no speed tab when there are no siblings");
  assert.equal(baseModelOf(catalog, "openai/gpt-5.6-sol-fast"), "openai/gpt-5.6-sol");
});

void test("task-model overrides /task agents only; per-strategy effort agents inherit the overridden model", async () => {
  const models = ModelMapSchema.parse(JSON.parse(await readFile(join(process.cwd(), "models.json"), "utf8")));
  const taskModels = setTaskModel(EMPTY_TASK_MODELS, parseTaskRoleArgument("plan"), { model: "openai/gpt-5.6-sol-fast", variant: "high" });
  const agents = agentDefinitions(models, setTaskEffort(EMPTY_TASK_EFFORT, "replicate", "plan", "low"), taskModels);
  assert.equal(agents["mr-task-plan"]?.model, "openai/gpt-5.6-sol-fast");
  assert.equal(agents["mr-task-plan"]?.variant, "high");
  assert.equal(agents["mr-task-plan-low"]?.model, "openai/gpt-5.6-sol-fast");
  assert.equal(agents["mr-task-plan-low"]?.variant, "low");
  assert.equal(agents["mr-plan"]?.model, models.roles.plan.model, "/flow keeps its own planner");
  assert.equal(agents["mr-task-explore"]?.model, models.roles.explore.model, "roles without override inherit /flow");
  assert.deepEqual(setTaskModel(taskModels, "plan", undefined).roles, {});
  assert.equal(parseTaskRoleArgument("apply"), "general");
});

void test("tab strip and role matrix render the Modelo │ Esfuerzo │ Velocidad flow", () => {
  assert.equal(renderTabs("Esfuerzo", ["Modelo"]), "✓ Modelo   │   ● Esfuerzo   │   ○ Velocidad");
  assert.equal(renderTabs("Velocidad", ["Modelo"], ["Esfuerzo"]), "✓ Modelo   │   – Esfuerzo   │   ● Velocidad");
  const matrix = formatTaskModelMatrix(
    { schemaVersion: 1, roles: { plan: { model: "openai/gpt-5.6-sol-fast", variant: "high" } } },
    { explore: { model: "a/explore" }, plan: { model: "a/plan" }, general: { model: "a/general", variant: "high" } },
  );
  assert.match(matrix, /plan · razona y planifica\s+→ openai\/gpt-5\.6-sol-fast#high$/mu);
  assert.match(matrix, /explore · lee y registra\s+→ a\/explore {2}\(hereda \/flow\)/u);
});
