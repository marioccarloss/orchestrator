import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEvidence, checkEvidenceFreshness, listEvidence, pruneEvidence, readEvidenceSlice } from "../src/core/evidence-store.js";
import { resolvePaths } from "../src/core/paths.js";
import { AtlasIndexer, findNodeByName } from "../src/core/atlas.js";

test("EvidenceStore adds, merges, reads, detects stale and prunes slices", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-evidence-"));
  const root = join(home, "repo");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "value.ts"), "export function value() {\n  return 1;\n}\n");
  const paths = resolvePaths({ HOME: home });
  try {
    const first = await addEvidence(paths, "ws", root, "GH-1", {
      file: "src/value.ts", startLine: 1, endLine: 3, kind: "behavior", source: "read", claim: "Returns one", supports: ["R1"], symbol: "value",
    });
    const duplicate = await addEvidence(paths, "ws", root, "GH-1", {
      file: "src/value.ts", startLine: 1, endLine: 3, kind: "behavior", source: "atlas", claim: "Value behavior", supports: ["R2"], symbol: "value",
    });
    assert.equal(duplicate.id, first.id);
    assert.deepEqual(duplicate.supports, ["R1", "R2"]);
    assert.ok((await readEvidenceSlice(paths, "ws", "GH-1", duplicate))?.includes("return 1"));
    assert.equal((await listEvidence(paths, "ws", "GH-1", { supports: "R2" })).length, 1);
    await writeFile(join(root, "src", "value.ts"), "\nexport function value() {\n  return 1;\n}\n");
    assert.equal((await checkEvidenceFreshness(root, duplicate)).status, "stale");
    const graph = await new AtlasIndexer().indexWorkspace(root);
    const node = findNodeByName(graph, "value");
    assert.ok(node);
    const relocated = await checkEvidenceFreshness(root, duplicate, graph);
    assert.equal(relocated.status, "relocated");
    if (relocated.status === "relocated") assert.equal(relocated.range[0], 2);
    const result = await pruneEvidence(paths, "ws", "GH-1", new Set());
    assert.deepEqual(result.removed, [first.id]);
    assert.equal(await readEvidenceSlice(paths, "ws", "GH-1", duplicate), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("EvidenceStore rejects traversal and symlinks outside the workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-evidence-safe-"));
  const root = join(home, "repo");
  await mkdir(root, { recursive: true });
  await writeFile(join(home, "secret.txt"), "secret\n");
  const paths = resolvePaths({ HOME: home });
  try {
    await assert.rejects(addEvidence(paths, "ws", root, "GH-2", {
      file: "../secret.txt", startLine: 1, endLine: 1, kind: "doc", source: "read", claim: "must not escape",
    }), /escapes the workspace/u);
    assert.equal(await readFile(join(home, "secret.txt"), "utf8"), "secret\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
