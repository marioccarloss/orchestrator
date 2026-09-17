import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ModelMap } from "../src/core/schema.js";

const repositoryRoot = process.cwd();

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(home: string, arguments_: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([process.execPath, join(repositoryRoot, "src", "cli.ts"), ...arguments_], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function setupHarness(home: string): Promise<{ global: ModelMap; configRoot: string }> {
  const configRoot = join(home, "config", "mr-orchestrator");
  const global = JSON.parse(await readFile(join(repositoryRoot, "models.json"), "utf8")) as ModelMap;
  await mkdir(join(configRoot, "harnesses", "cursor"), { recursive: true });
  await writeFile(join(configRoot, "models.json"), `${JSON.stringify(global, null, 2)}\n`);
  await writeFile(join(configRoot, "workspaces.json"), `${JSON.stringify({ schemaVersion: 1, workspaces: [] }, null, 2)}\n`);
  const targets = Object.values(global.roles).flatMap((assignment) => [assignment, assignment.alternative]);
  const entries = Object.fromEntries(targets.map((target) => [target.model, {
    nativeModel: `cursor:${target.model}`,
    variants: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  }]));
  entries["cursor/composer-2.5"] = {
    nativeModel: "composer-2.5",
    variants: { low: "low", medium: "medium", high: "max", xhigh: "xhigh", max: "max" },
  };
  await writeFile(join(configRoot, "harnesses", "cursor", "catalog.json"), `${JSON.stringify({
    schemaVersion: 1,
    harness: "cursor",
    applicationMode: "per-invocation",
    models: entries,
    provenance: { source: "explicit" },
  }, null, 2)}\n`);
  return { global, configRoot };
}

void test("CLI writes, lists, validates, and resets a harness override without changing global models", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-cli-harness-models-"));
  const { global, configRoot } = await setupHarness(home);

  const set = await runCli(home, ["models", "set", "explore", "cursor/composer-2.5#high", "model", "--harness", "cursor"]);
  assert.equal(set.exitCode, 0, set.stderr);
  assert.match(set.stdout, /arnés 'cursor'/u);
  assert.deepEqual(JSON.parse(await readFile(join(configRoot, "models.json"), "utf8")), global);
  const overridePath = join(configRoot, "harnesses", "cursor", "models.json");
  const override = JSON.parse(await readFile(overridePath, "utf8")) as {
    roles: { explore?: { primary?: { model: string; variant?: string } } };
  };
  assert.deepEqual(override.roles.explore?.primary, { model: "cursor/composer-2.5", variant: "high" });

  const list = await runCli(home, ["models", "list", "--harness", "cursor", "--effective", "--origins"]);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.match(list.stdout, /cursor\/composer-2\.5#high ⇒ composer-2\.5#max \[harness:cursor\]/u);
  assert.match(list.stdout, /\[global\]/u);

  const validate = await runCli(home, ["models", "validate", "--harness", "cursor"]);
  assert.equal(validate.exitCode, 0, validate.stderr);
  assert.match(validate.stdout, /Configuración válida/u);
  await readFile(join(configRoot, "generated", "harnesses", "cursor", "effective-models.json"), "utf8");

  const reset = await runCli(home, ["models", "reset", "explore", "model", "--harness", "cursor"]);
  assert.equal(reset.exitCode, 0, reset.stderr);
  await assert.rejects(readFile(overridePath, "utf8"), { code: "ENOENT" });
});

void test("CLI rejects a harness model outside its catalog without a partial write", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-cli-harness-invalid-"));
  const { configRoot } = await setupHarness(home);
  const result = await runCli(home, ["models", "set", "explore", "unknown/not-supported", "--harness", "cursor"]);
  assert.equal(result.exitCode, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /unsupported model/u);
  await assert.rejects(readFile(join(configRoot, "harnesses", "cursor", "models.json"), "utf8"), { code: "ENOENT" });
});

void test("CLI never treats a missing harness id as a global write", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-cli-harness-missing-"));
  const { configRoot } = await setupHarness(home);
  const globalPath = join(configRoot, "models.json");
  const before = JSON.parse(await readFile(globalPath, "utf8"));

  const result = await runCli(home, ["models", "set", "explore", "github-copilot/gpt-5.6-sol", "--harness"]);

  assert.equal(result.exitCode, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /--harness requires an id/u);
  assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), before);
});
