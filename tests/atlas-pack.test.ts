import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AtlasGraph, AtlasNode } from "../src/core/atlas.js";
import {
  ATLAS_BLOCK_END,
  ATLAS_BLOCK_START,
  MAP_CHAR_BUDGET,
  linkAtlasPointers,
  removeManagedBlock,
  renderAtlasMap,
  renderAtlasPointer,
  runAtlasQuery,
  unlinkAtlasPointers,
  upsertManagedBlock,
} from "../src/core/atlas-pack.js";
import { runCommand } from "../src/core/process.js";

function node(id: string, name: string, filePath: string, dependents: string[] = [], dependencies: string[] = []): AtlasNode {
  return { id, name, kind: "function", filePath, line: 3, endLine: 5, column: 1, exports: [name], imports: [], dependencies, dependents, signature: `function ${name}(): void`, metadata: {} };
}

function graph(nodes: AtlasNode[]): AtlasGraph {
  return {
    schemaVersion: 2,
    generatedAt: "2026-10-03T00:00:00.000Z",
    workspaceRoot: "/repo",
    nodes,
    edges: [],
    files: [...new Set(nodes.map((item) => item.filePath))].map((path) => ({ path, contentHash: "h", language: "typescript", parseStatus: "ok" })),
    coverage: { supportedFiles: nodes.length, unsupportedFiles: [], partialFiles: [], unresolvedImports: [] },
    stats: { totalFiles: nodes.length, totalNodes: nodes.length, totalEdges: 0, indexDurationMs: 1 },
  } as unknown as AtlasGraph;
}

void test("managed block upserts idempotently and preserves the rest of the file byte for byte", () => {
  const original = "# Team rules\n\nUse tabs.\n";
  const block = renderAtlasPointer(".aicontext/atlas");
  const once = upsertManagedBlock(original, block);
  assert.ok(once.startsWith(original.trimEnd()));
  assert.equal(upsertManagedBlock(once, block), once, "second run is a no-op");
  const changed = upsertManagedBlock(once, renderAtlasPointer("../ctx/atlas"));
  assert.equal(changed.split(ATLAS_BLOCK_START).length, 2, "never duplicates the block");
  assert.match(changed, /\.\.\/ctx\/atlas\/MAP\.md/u);
  assert.equal(removeManagedBlock(changed), original, "unlink restores the original content");
  assert.ok(upsertManagedBlock("", block).startsWith(ATLAS_BLOCK_START));
  assert.ok(upsertManagedBlock("", block).trimEnd().endsWith(ATLAS_BLOCK_END));
});

void test("MAP.md ranks the most connected symbols first and stays within budget", () => {
  const nodes = [
    node("a", "leaf", "src/a.ts"),
    node("b", "hub", "src/b.ts", ["x1", "x2", "x3"], ["a"]),
    ...Array.from({ length: 2_000 }, (_, index) => node(`n${String(index)}`, `symbol${String(index)}WithAVeryLongNameForBudgetPressure`, `src/deep/folder/file${String(index)}.ts`)),
  ];
  const map = renderAtlasMap({ workspace: { id: "w", name: "shop", root: "/repo" }, graph: graph(nodes), profiles: [], hasRules: false, hasMemory: false, head: "abc123" });
  assert.ok(map.length <= MAP_CHAR_BUDGET, `map is ${String(map.length)} chars`);
  assert.ok(map.indexOf("`hub`") < map.indexOf("`leaf`") || !map.includes("`leaf`"), "hub ranks before leaf");
  assert.match(map, /at commit abc123/u);
  assert.match(map, /more symbols: use `mr atlas query`/u);
  assert.match(map, /never commit/u);
});

void test("pointers: only AGENTS.md is created when missing; CLAUDE.md is never created and is removed on unlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-atlas-claude-"));
  try {
    runCommand("git", ["-C", root, "init", "-q"]);
    const workspace = { root, contextRoot: join(root, ".aicontext") };
    const changes = await linkAtlasPointers(workspace, [root]);
    assert.deepEqual(changes.map((change) => [change.path.slice(root.length + 1), change.action]), [["AGENTS.md", "created"]]);
    await assert.rejects(readFile(join(root, "CLAUDE.md"), "utf8"));
    assert.match(await readFile(join(root, "AGENTS.md"), "utf8"), /mr-atlas:start/u);
    assert.match(await readFile(join(root, ".git", "info", "exclude"), "utf8"), /^\/AGENTS\.md$/mu);
    await unlinkAtlasPointers([root]);
    await assert.rejects(readFile(join(root, "AGENTS.md"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("an existing CLAUDE.md that already imports @AGENTS.md is left untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-atlas-claude-import-"));
  try {
    runCommand("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, "CLAUDE.md"), "# Team\n@AGENTS.md\n");
    const changes = await linkAtlasPointers({ root, contextRoot: join(root, ".aicontext") }, [root]);
    assert.equal(changes.find((change) => change.path.endsWith("CLAUDE.md"))?.action, "unchanged");
    assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8"), "# Team\n@AGENTS.md\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("pointers: AGENTS.md is created and ignored locally, an existing CLAUDE.md gets the block, unlink cleans up", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-atlas-pack-"));
  try {
    runCommand("git", ["-C", root, "init", "-q"]);
    await writeFile(join(root, "CLAUDE.md"), "# Claude notes\n");
    const workspace = { root, contextRoot: join(root, ".aicontext") };
    const changes = await linkAtlasPointers(workspace, [root]);
    assert.deepEqual(changes.map((change) => [change.path.slice(root.length + 1), change.action]), [["AGENTS.md", "created"], ["CLAUDE.md", "updated"]]);
    assert.match(await readFile(join(root, "AGENTS.md"), "utf8"), /\.aicontext\/atlas\/MAP\.md/u);
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    assert.match(exclude, /^\/AGENTS\.md$/mu);
    assert.equal((await linkAtlasPointers(workspace, [root])).every((change) => change.action === "unchanged"), true);
    await unlinkAtlasPointers([root]);
    assert.equal(await readFile(join(root, "CLAUDE.md"), "utf8"), "# Claude notes\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("atlas query answers info, dependents, find and ambiguity without reading files", async () => {
  const nodes = [node("a", "cartTotal", "src/cart.ts", ["b"]), node("b", "checkout", "src/checkout.ts", [], ["a"]), node("c", "cartItems", "src/items.ts")];
  const g = graph(nodes);
  const deps = {
    dependencies: (_graph: AtlasGraph, id: string) => nodes.filter((item) => nodes.find((candidate) => candidate.id === id)?.dependencies.includes(item.id)),
    dependents: (_graph: AtlasGraph, id: string) => nodes.filter((item) => nodes.find((candidate) => candidate.id === id)?.dependents.includes(item.id)),
    impact: () => [],
    tests: () => [],
    slice: async () => Promise.resolve("3: export function cartTotal() {}"),
  };
  assert.match(await runAtlasQuery(g, "cartTotal", "info", deps), /function cartTotal src\/cart\.ts:3-5/u);
  assert.match(await runAtlasQuery(g, "cartTotal", "dependents", deps), /checkout src\/checkout\.ts:3/u);
  assert.match(await runAtlasQuery(g, "cart", "info", deps), /ambiguous/u);
  assert.equal((await runAtlasQuery(g, "cart", "find", deps)).split("\n").length, 2);
  assert.match(await runAtlasQuery(g, "nothing", "info", deps), /No symbol or file matches/u);
});
