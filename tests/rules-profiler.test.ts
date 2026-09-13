import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasIndexer } from "../src/core/atlas.js";
import { buildAtlasBaseline } from "../src/core/atlas-init.js";
import { buildRulesProposal } from "../src/core/rules/generator.js";
import { profileRepository } from "../src/core/rules/profiler.js";
import type { WorkspaceProfile } from "../src/core/schema.js";

test("repository profiler infers dominant naming and groups mixed barrel decisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-rules-profile-"));
  try {
    await mkdir(join(root, ".aicontext"), { recursive: true });
    await mkdir(join(root, "src", "features"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "profile-fixture",
      packageManager: "bun@1.2.21",
      scripts: { test: "bun test", lint: "eslint .", typecheck: "tsc --noEmit", build: "tsc" },
      dependencies: { react: "latest", "@tanstack/react-query": "latest", "@reduxjs/toolkit": "latest", zod: "latest" },
      devDependencies: { vitest: "latest" },
    }));
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true }, include: ["src"] }));
    for (let index = 0; index < 9; index += 1) {
      const name = `feature-${String(index)}`;
      await writeFile(join(root, "src", "features", `${name}.ts`), `export const value${String(index)} = ${String(index)};\n`);
    }
    await writeFile(join(root, "src", "features", "LegacyThing.ts"), "export const legacy = true;\n");
    for (let index = 0; index < 4; index += 1) {
      const dir = join(root, "src", "features", `group-${String(index)}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "index.ts"), `export { value${String(index)} } from '../feature-${String(index)}.js';\n`);
    }
    await writeFile(join(root, "src", "features", "state-data.ts"), `import { z } from "zod";
export const ItemSchema = z.object({ id: z.string() });
export const items = createSlice({ name: "items", initialState: [], reducers: {} });
export function useItems(){ return useQuery({ queryKey: ["items"], queryFn: loadItems }); }
`);
    await writeFile(join(root, "tests", "feature.test.ts"), "test('feature', () => {});\n");
    const graph = await new AtlasIndexer().indexWorkspace(root);
    const profile = await profileRepository(root, { name: "profile-fixture", root: ".", markers: ["package.json", ".git"] }, graph);
    const naming = profile.inferences.find((row) => row.id === "naming.files");
    assert.equal(naming?.value, "kebab-case");
    assert.ok((naming?.confidence ?? 0) >= 0.85);
    assert.equal(profile.inferences.find((row) => row.id === "modules.barrels")?.value, "existing-only");
    assert.ok(profile.facts.some((row) => row.id === "state-data.query"));
    assert.ok(profile.facts.some((row) => row.id === "state-data.client"));
    assert.ok(profile.facts.some((row) => row.id === "state-data.validation"));
    assert.ok(profile.facts.some((row) => row.id === "quality.strict"));
    const proposal = buildRulesProposal([profile]);
    assert.equal(proposal.decisions.filter((decision) => decision.ruleId === "modules.barrels").length, 1);
    assert.equal(proposal.decisions.some((decision) => decision.ruleId === "naming.files"), false);
    assert.equal(proposal.rules.repositories[0]?.rules.find((rule) => rule.id === "naming.files")?.kind, "inferred");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Atlas baseline keeps the graph usable when one repository profiler fails", async () => {
  const workspace: WorkspaceProfile = { schemaVersion: 1, id: "fixture", name: "fixture", root: "/fixture", contextRoot: "/fixture/.aicontext" };
  const graph = { schemaVersion: 2 as const, generatedAt: new Date().toISOString(), workspaceRoot: workspace.root, nodes: [], edges: [], files: [], coverage: { indexerVersion: "2.2.0", supportedLanguages: [], unsupportedFiles: [], parseErrors: [], unresolvedImports: [] }, stats: { totalFiles: 0, totalNodes: 0, totalEdges: 0, indexDurationMs: 1 } };
  const baseline = await buildAtlasBaseline(workspace, graph, {
    discover: async () => [{ name: "broken", root: "repos/broken", markers: ["package.json"] }],
    profile: async () => { throw new Error("simulated profiler failure"); },
  });
  assert.equal(baseline.graph, graph);
  assert.equal(baseline.profiles.length, 0);
  assert.match(baseline.errors[0] ?? "", /simulated profiler failure/u);
});
