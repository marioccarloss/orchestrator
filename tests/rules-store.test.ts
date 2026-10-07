import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRulesProposal, rulesDigest, type RepositoryRule } from "../src/core/rules/generator.js";
import type { RepositoryProfile } from "../src/core/rules/profiler.js";
import { inspectAtlasRuleFiles, loadLocalRules, loadWorkspaceRules, saveWorkspaceRules } from "../src/core/rules/store.js";
import type { WorkspaceProfile } from "../src/core/schema.js";

const profile: RepositoryProfile = {
  schemaVersion: 1, repo: "web", root: "repos/web", generatedFromIndex: "a".repeat(64), kind: "spa",
  stack: { languages: ["typescript"], frameworks: ["React"], packageManager: "bun", build: "bun run build" },
  layout: { style: "feature", roots: ["src"] }, commands: { test: "bun run test" }, criticalAreas: [], gaps: [],
  facts: [{ id: "styles.no-important", value: "forbid", statement: "No important", confidence: 1, evidence: ["src/a.css"] }],
  inferences: [{ id: "naming.files", value: "kebab-case", statement: "Kebab", confidence: 0.9, evidence: ["src/user-card.tsx"] }],
};

const userRule = (id: string, statement: string): RepositoryRule => ({
  id, value: "user", statement, kind: "user", confidence: 1, evidence: [], appliesTo: [], severity: "block",
});

async function withWorkspace(run: (workspace: WorkspaceProfile, atlas: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mr-rules-store-"));
  const workspace: WorkspaceProfile = { schemaVersion: 1, id: "ws", name: "ws", root, contextRoot: join(root, ".aicontext") };
  const atlas = join(workspace.contextRoot, "atlas");
  await mkdir(atlas, { recursive: true });
  try { await run(workspace, atlas); } finally { await rm(root, { recursive: true, force: true }); }
}

const writeLocal = async (atlas: string, value: unknown): Promise<void> => {
  await writeFile(join(atlas, "rules.local.json"), typeof value === "string" ? value : JSON.stringify(value));
};

test("generated rules load unchanged when no local rules exist", async () => {
  await withWorkspace(async (workspace) => {
    const rules = buildRulesProposal([profile]).rules;
    await saveWorkspaceRules(workspace, rules, [profile]);
    assert.deepEqual(await loadWorkspaceRules(workspace), rules);
    assert.equal(await loadLocalRules(workspace), undefined);
  });
});

test("local rules override generated ids, append new ids, and serve local-only repositories", async () => {
  await withWorkspace(async (workspace, atlas) => {
    await saveWorkspaceRules(workspace, buildRulesProposal([profile]).rules, [profile]);
    await writeLocal(atlas, { schemaVersion: 1, repositories: [
      { repo: "web", rules: [userRule("naming.files", "Name files using PascalCase."), userRule("styles.no-css-edits", "Do not edit CSS files.")] },
      { repo: "api", rules: [{ id: "arch.hexagonal", value: "hexagonal", statement: "Keep hexagonal layers.", severity: "block" }] },
    ] });
    const merged = await loadWorkspaceRules(workspace);
    assert.ok(merged !== undefined);
    const web = merged.repositories.find((repository) => repository.repo === "web");
    assert.deepEqual(web?.rules.filter((rule) => rule.id === "naming.files").map((rule) => [rule.statement, rule.kind]), [["Name files using PascalCase.", "user"]]);
    assert.ok(web?.rules.some((rule) => rule.id === "styles.no-important"));
    assert.ok(rulesDigest(merged, "web").some((rule) => rule.id === "styles.no-css-edits"));
    const api = merged.repositories.find((repository) => repository.repo === "api");
    assert.equal(api?.rules[0]?.kind, "user");
    assert.deepEqual(rulesDigest(merged, "api"), [{ id: "arch.hexagonal", statement: "Keep hexagonal layers.", severity: "block" }]);
  });
});

test("local rules still load when rules.json is missing or invalid", async () => {
  await withWorkspace(async (workspace, atlas) => {
    await writeLocal(atlas, { schemaVersion: 1, repositories: [{ repo: "web", rules: [userRule("a", "Rule A.")] }] });
    assert.deepEqual(rulesDigest((await loadWorkspaceRules(workspace))!, "web").map((rule) => rule.id), ["a"]);
    await writeFile(join(atlas, "rules.json"), JSON.stringify({ schemaVersion: 1, repositories: "broken" }));
    assert.deepEqual(rulesDigest((await loadWorkspaceRules(workspace))!, "web").map((rule) => rule.id), ["a"]);
  });
});

test("an invalid rules.local.json is ignored and generated rules still load", async () => {
  await withWorkspace(async (workspace, atlas) => {
    const rules = buildRulesProposal([profile]).rules;
    await saveWorkspaceRules(workspace, rules, [profile]);
    await writeLocal(atlas, { schemaVersion: 1, repositories: [{ repo: "web", rules: [{ ...userRule("a", "A."), severity: "error" }] }] });
    assert.deepEqual(await loadWorkspaceRules(workspace), rules);
    await writeLocal(atlas, "{ not json");
    assert.deepEqual(await loadWorkspaceRules(workspace), rules);
  });
});

test("saving generated rules renders merged AGENTS.md and never touches rules.local.json", async () => {
  await withWorkspace(async (workspace, atlas) => {
    const local = `${JSON.stringify({ schemaVersion: 1, repositories: [
      { repo: "web", rules: [userRule("naming.files", "Name files using PascalCase."), userRule("styles.no-css-edits", "Do not edit CSS files.")] },
    ] }, null, 4)}\n`;
    await writeLocal(atlas, local);
    const rules = buildRulesProposal([profile]).rules;
    await saveWorkspaceRules(workspace, rules, [profile]);
    assert.equal(await readFile(join(atlas, "rules.local.json"), "utf8"), local);
    const generated = JSON.parse(await readFile(join(atlas, "rules.json"), "utf8")) as unknown;
    assert.deepEqual(generated, rules);
    const repoAgents = await readFile(join(atlas, "repos", "web", "AGENTS.md"), "utf8");
    assert.match(repoAgents, /Do not edit CSS files\./u);
    assert.match(repoAgents, /Name files using PascalCase\./u);
    assert.doesNotMatch(repoAgents, /Name files using kebab-case\./u);
    assert.match(await readFile(join(atlas, "AGENTS.md"), "utf8"), /rules\.local\.json/u);
  });
});

test("rule file inspection reports missing, valid, and invalid files with the first zod issue", async () => {
  await withWorkspace(async (workspace, atlas) => {
    assert.deepEqual((await inspectAtlasRuleFiles(workspace)).map((file) => [file.file, file.status]), [
      ["profile.json", "missing"], ["rules.json", "missing"], ["rules.local.json", "missing"],
    ]);
    await saveWorkspaceRules(workspace, buildRulesProposal([profile]).rules, [profile]);
    await writeLocal(atlas, { schemaVersion: 1, repositories: [{ repo: "web", rules: [{ ...userRule("a", "A."), severity: "error" }] }] });
    const inspected = await inspectAtlasRuleFiles(workspace);
    assert.deepEqual(inspected.map((file) => [file.file, file.status]), [["profile.json", "valid"], ["rules.json", "valid"], ["rules.local.json", "invalid"]]);
    const invalid = inspected[2];
    assert.equal(invalid?.path, join(atlas, "rules.local.json"));
    assert.match(invalid?.status === "invalid" ? invalid.issue : "", /^repositories\.0\.rules\.0\.severity: /u);
  });
});
