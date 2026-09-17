import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install, loadManifest, planUninstall, uninstall } from "../src/core/install.js";
import { defaultCapabilitySelection, saveCapabilitySelection } from "../src/core/capabilities.js";
import { seedModels } from "../src/core/config.js";
import { sha256 } from "../src/core/files.js";
import { setModelRole } from "../src/core/models.js";
import { resolvePaths } from "../src/core/paths.js";

const sourceRoot = process.cwd();

void test("install is idempotent and uninstall preserves modified owned files", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-install-"));
  const paths = resolvePaths({ HOME: home });
  await mkdir(join(paths.bunRoot, "bin"), { recursive: true });
  await writeFile(paths.bunBinary, "bun fixture");
  await chmod(paths.bunBinary, 0o755);
  await seedModels(paths, sourceRoot);

  const first = await install(paths, sourceRoot, "0.1.0");
  const second = await install(paths, sourceRoot, "0.1.0");
  // 3 launchers + 1 loader + 1 MCP catalog + 12 agent md + 7 command md
  assert.equal(first.changedFiles.length, 24);
  assert.equal(second.changedFiles.length, 0);
  assert.match(await readFile(join(paths.binRoot, "mrcode"), "utf8"), /bun' '.+cli\.js' launch "\$@"/u);
  const loader = await readFile(join(paths.opencodePluginsRoot, "mr-orchestrator-loader.ts"), "utf8");
  assert.match(loader, /MrOrchestratorLoader/u);
  assert.match(loader, /opencode\.mr\.json/u);
  const orchestratorMd = await readFile(join(paths.opencodeAgentsRoot, "orchestrator.md"), "utf8");
  assert.match(orchestratorMd, /mode: primary/u);
  assert.match(orchestratorMd, /variant: high/u);
  const flowMd = await readFile(join(paths.opencodeCommandsRoot, "flow.md"), "utf8");
  assert.match(flowMd, /agent: orchestrator/u);
  const catalog = await readFile(join(paths.configRoot, "recommended-mcps.json"), "utf8");
  assert.match(catalog, /figma-live/u);
  assert.match(catalog, /codebase-memory/u);

  const launcher = join(paths.binRoot, "mr");
  await writeFile(launcher, `${await readFile(launcher, "utf8")}# local edit\n`);
  const plan = await planUninstall(paths);
  assert.equal(plan.find((item) => item.path === launcher)?.action, "preserve-modified");

  await uninstall(paths, false);
  assert.match(await readFile(launcher, "utf8"), /local edit/u);
});

void test("model updates refresh global definitions and their installer hashes without workspaces", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-install-model-refresh-"));
  const paths = resolvePaths({ HOME: home });
  await mkdir(join(paths.bunRoot, "bin"), { recursive: true });
  await writeFile(paths.bunBinary, "bun fixture");
  await chmod(paths.bunBinary, 0o755);
  await seedModels(paths, sourceRoot);
  await install(paths, sourceRoot, "0.1.0");

  await setModelRole(paths, "orchestrator", "openai/gpt-5.6-sol#high");

  const definitionPath = join(paths.opencodeAgentsRoot, "orchestrator.md");
  const definition = await readFile(definitionPath, "utf8");
  assert.match(definition, /model: openai\/gpt-5\.6-sol/u);
  assert.match(definition, /variant: high/u);
  const manifest = await loadManifest(paths);
  assert.equal(manifest.files.find((item) => item.path === definitionPath)?.sha256, sha256(definition));
  assert.equal((await planUninstall(paths)).find((item) => item.path === definitionPath)?.action, "remove");
});

void test("install refuses to overwrite a foreign launcher", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-install-collision-"));
  const paths = resolvePaths({ HOME: home });
  await mkdir(join(paths.bunRoot, "bin"), { recursive: true });
  await writeFile(paths.bunBinary, "bun fixture");
  await chmod(paths.bunBinary, 0o755);
  await seedModels(paths, sourceRoot);
  await mkdir(paths.binRoot, { recursive: true });
  await writeFile(join(paths.binRoot, "mr"), "foreign\n");

  await assert.rejects(install(paths, sourceRoot, "0.1.0"), /Refusing to overwrite/u);
  assert.equal(await readFile(join(paths.binRoot, "mr"), "utf8"), "foreign\n");
});

void test("install catalog follows the resumable capability selection", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-install-capability-selection-"));
  const paths = resolvePaths({ HOME: home });
  await mkdir(join(paths.bunRoot, "bin"), { recursive: true });
  await writeFile(paths.bunBinary, "bun fixture");
  await chmod(paths.bunBinary, 0o755);
  await seedModels(paths, sourceRoot);
  await saveCapabilitySelection(paths, {
    ...defaultCapabilitySelection(),
    selected: ["context7"],
  });

  await install(paths, sourceRoot, "0.1.0");
  const catalog = await readFile(join(paths.configRoot, "recommended-mcps.json"), "utf8");
  assert.match(catalog, /context7/u);
  assert.doesNotMatch(catalog, /codebase-memory/u);
  assert.doesNotMatch(catalog, /figma-live/u);
});
