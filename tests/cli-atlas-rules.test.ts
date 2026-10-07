import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolvePaths } from "../src/core/paths.js";

const repositoryRoot = process.cwd();

interface Fixture {
  readonly workspace: string;
  readonly atlas: string;
  readonly cacheRoot: string;
  readonly run: (arguments_: readonly string[], cwd?: string) => SpawnSyncReturns<string>;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "mr-cli-atlas-rules-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "mr-cli-atlas-rules-workspace-"));
  try {
    await mkdir(join(workspace, ".aicontext"), { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "atlas-rules-fixture", scripts: { test: "bun test", build: "tsc" } }));
    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
    for (let index = 0; index < 6; index += 1) await writeFile(join(workspace, "src", `feature-${String(index)}.ts`), `export const value${String(index)} = ${String(index)};\n`);
    const paths = resolvePaths({ HOME: home });
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(paths.models, await readFile(join(repositoryRoot, "models.json"), "utf8"));
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"), MR_SKIP_PLUGIN_INSTALL: "1", MR_ATLAS_MEMORY: "off" };
    const run = (arguments_: readonly string[], cwd = workspace) => spawnSync(process.execPath, [join(repositoryRoot, "src", "cli.ts"), ...arguments_], { cwd, env, encoding: "utf8" });
    const registered = run(["workspace", "add", workspace]);
    assert.equal(registered.status, 0, registered.stderr);
    await body({ workspace, atlas: join(workspace, ".aicontext", "atlas"), cacheRoot: resolvePaths(env).cacheRoot, run });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Every file under `root` with its content; used to prove a command wrote nothing. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path); else files[relative(root, path)] = await readFile(path, "utf8");
    }
  };
  await walk(root);
  return files;
}

const ok = (result: SpawnSyncReturns<string>): SpawnSyncReturns<string> => {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
};

async function generatedRepo(atlas: string): Promise<string> {
  const rules = JSON.parse(await readFile(join(atlas, "rules.json"), "utf8")) as { repositories: { repo: string }[] };
  const repo = rules.repositories[0]?.repo;
  assert.ok(repo !== undefined, "fixture generates one repository");
  return repo;
}

const writeLocal = async (atlas: string, repo: string): Promise<void> => {
  await writeFile(join(atlas, "rules.local.json"), JSON.stringify({ schemaVersion: 1, repositories: [{ repo, rules: [
    { id: "user.no-css", value: "forbid", statement: "Never edit CSS files.", severity: "block", appliesTo: ["**/*.css"] },
    { id: "user.hexagonal", value: "required", statement: "Keep hexagonal layers.", severity: "warn" },
  ] }] }));
};

test("mr atlas rules show prints merged rules read-only, filtered by repo and file", async () => {
  await withFixture(async ({ workspace, atlas, run }) => {
    const empty = ok(run(["atlas", "rules", "show"]));
    assert.match(empty.stdout, /No Atlas rules/u);
    ok(run(["atlas", "init"]));
    const repo = await generatedRepo(atlas);
    await writeLocal(atlas, repo);
    const before = await snapshot(workspace);
    const human = ok(run(["atlas", "rules", "show"], join(workspace, "src")));
    assert.match(human.stdout, new RegExp(repo, "u"));
    assert.match(human.stdout, /\[block\] user\.no-css — Never edit CSS files\. \(user\)/u);
    assert.match(human.stdout, /\[warn\] naming\.files — /u);
    const json = JSON.parse(ok(run(["atlas", "rules", "show", "--json", "--repo", repo])).stdout) as { repo: string; id: string; severity: string; statement: string; kind: string }[];
    assert.deepEqual(json.find((rule) => rule.id === "user.no-css"), { repo, id: "user.no-css", severity: "block", statement: "Never edit CSS files.", kind: "user" });
    assert.ok(json.every((rule) => rule.repo === repo));
    const tsOnly = JSON.parse(ok(run(["atlas", "rules", "show", "--json", "--file", "src/feature-0.ts"])).stdout) as { id: string }[];
    assert.ok(tsOnly.some((rule) => rule.id === "user.hexagonal"), "rules without appliesTo always apply");
    assert.ok(!tsOnly.some((rule) => rule.id === "user.no-css"), "--file filters by appliesTo");
    const other = JSON.parse(ok(run(["atlas", "rules", "show", "--json", "--repo", "missing-repo"])).stdout) as unknown[];
    assert.deepEqual(other, []);
    assert.deepEqual(await snapshot(workspace), before, "show never writes");
    await writeFile(join(atlas, "rules.local.json"), JSON.stringify({ schemaVersion: 1, repositories: [{ repo, rules: [{ id: "x", value: "v", statement: "s", severity: "error" }] }] }));
    const invalid = run(["atlas", "rules", "show"]);
    assert.notEqual(invalid.status, 0);
    assert.match(`${invalid.stdout}${invalid.stderr}`, /rules\.local\.json.*severity/su);
  });
});

test("mr atlas rules render rewrites only the internal AGENTS.md projections", async () => {
  await withFixture(async ({ workspace, atlas, cacheRoot, run }) => {
    ok(run(["atlas", "init"]));
    const repo = await generatedRepo(atlas);
    await writeLocal(atlas, repo);
    const repoAgents = join(atlas, "repos", repo, "AGENTS.md");
    await rm(join(atlas, "AGENTS.md"));
    await rm(repoAgents);
    const workspaceBefore = await snapshot(workspace);
    const cacheBefore = await snapshot(cacheRoot);
    ok(run(["atlas", "rules", "render"]));
    const workspaceAfter = await snapshot(workspace);
    const changed = Object.keys(workspaceAfter).filter((path) => workspaceAfter[path] !== workspaceBefore[path]).sort();
    assert.deepEqual(changed, [join(".aicontext", "atlas", "AGENTS.md"), relative(workspace, repoAgents)].sort());
    assert.match(await readFile(repoAgents, "utf8"), /Never edit CSS files\./u);
    assert.match(await readFile(join(atlas, "AGENTS.md"), "utf8"), /# Workspace Rules/u);
    assert.deepEqual(await snapshot(cacheRoot), cacheBefore, "render never reindexes");
    ok(run(["atlas", "rules", "render", "--lang", "es"]));
    assert.match(await readFile(join(atlas, "AGENTS.md"), "utf8"), /# Reglas del workspace/u);
    await rm(join(atlas, "profile.json"));
    const missing = run(["atlas", "rules", "render"]);
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}${missing.stderr}`, /profile\.json/u);
  });
});

test("mr atlas rules --diff is a dry run that writes nothing", async () => {
  await withFixture(async ({ workspace, atlas, cacheRoot, run }) => {
    ok(run(["atlas", "init"]));
    const repo = await generatedRepo(atlas);
    await writeLocal(atlas, repo);
    await writeFile(join(workspace, "CLAUDE.md"), "claude notes\n");
    ok(run(["atlas", "unlink"]));
    await rm(join(atlas, "rules.json"));
    const workspaceBefore = await snapshot(workspace);
    const cacheBefore = await snapshot(cacheRoot);
    const diff = ok(run(["atlas", "rules", "--diff"]));
    assert.match(diff.stdout, /Dry run/u);
    assert.match(diff.stdout, /\+ .*Never edit CSS files\./u);
    assert.doesNotMatch(diff.stdout, /Atlas rules saved|Pointer /u);
    assert.deepEqual(await snapshot(workspace), workspaceBefore, "no rules.json, profile.json, AGENTS.md or pointer writes");
    assert.deepEqual(await snapshot(cacheRoot), cacheBefore, "no graph cache writes");
  });
});
