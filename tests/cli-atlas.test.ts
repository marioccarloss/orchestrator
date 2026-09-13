import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePaths } from "../src/core/paths.js";
import { loadRegistry } from "../src/core/workspace.js";

const repositoryRoot = process.cwd();

test("mr atlas init supports profile-only mode and persists rules outside generated source", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-cli-atlas-home-"));
  const workspace = await mkdtemp(join(tmpdir(), "mr-cli-atlas-workspace-"));
  try {
    await mkdir(join(workspace, ".aicontext"), { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "atlas-cli-fixture", scripts: { test: "bun test", build: "tsc" } }));
    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
    for (let index = 0; index < 6; index += 1) await writeFile(join(workspace, "src", `feature-${String(index)}.ts`), `export const value${String(index)} = ${String(index)};\n`);
    const paths = resolvePaths({ HOME: home });
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(paths.models, await readFile(join(repositoryRoot, "models.json"), "utf8"));
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_CACHE_HOME: join(home, ".cache"), MR_SKIP_PLUGIN_INSTALL: "1" };
    const run = (arguments_: readonly string[]) => spawnSync(process.execPath, [join(repositoryRoot, "src", "cli.ts"), ...arguments_], { cwd: workspace, env, encoding: "utf8" });
    const registered = run(["workspace", "add", workspace]);
    assert.equal(registered.status, 0, registered.stderr);
    const profileOnly = run(["atlas", "init", "--no-rules"]);
    assert.equal(profileOnly.status, 0, profileOnly.stderr);
    assert.match(await readFile(join(workspace, ".aicontext", "atlas", "profile.json"), "utf8"), /naming\.files/u);
    await assert.rejects(readFile(join(workspace, ".aicontext", "atlas", "rules.json"), "utf8"));
    const initialized = run(["atlas", "init"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(await readFile(join(workspace, ".aicontext", "atlas", "rules.json"), "utf8"), /naming\.files/u);
    const registry = await loadRegistry(paths);
    const generated = await readFile(join(paths.generatedRoot, registry.workspaces[0]?.id ?? "missing", "opencode.mr.json"), "utf8");
    assert.match(generated, /\.aicontext\/atlas\/AGENTS\.md/u);
    const refreshed = run(["atlas", "rules", "--diff"]);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.match(refreshed.stdout, /Atlas rules saved/u);
    await writeFile(join(workspace, "AGENTS.md"), "preserve me\n");
    const declined = run(["atlas", "rules", "--write-repo-agents"]);
    assert.equal(declined.status, 0, declined.stderr);
    assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "preserve me\n");
    assert.match(declined.stdout, /Proposed .*AGENTS\.md/u);
    const accepted = run(["atlas", "rules", "--write-repo-agents", "--yes"]);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(await readFile(join(workspace, "AGENTS.md"), "utf8"), /Agent Rules/u);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
