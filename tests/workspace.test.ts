import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePaths } from "../src/core/paths.js";
import { addWorkspace, detectWorkspace, loadRegistry } from "../src/core/workspace.js";

void test("workspace add is idempotent and detection uses the deepest root", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-workspace-"));
  const outer = join(home, "outer");
  const inner = join(outer, "inner");
  await mkdir(join(outer, ".aicontext"), { recursive: true });
  await mkdir(join(inner, ".aicontext"), { recursive: true });
  await mkdir(join(inner, "code"), { recursive: true });
  const paths = resolvePaths({ HOME: home });

  const first = await addWorkspace(paths, outer);
  const duplicate = await addWorkspace(paths, outer);
  const nested = await addWorkspace(paths, inner);
  const registry = await loadRegistry(paths);

  assert.equal(first.id, duplicate.id);
  assert.equal(registry.workspaces.length, 2);
  assert.equal(detectWorkspace(registry, await realpath(join(inner, "code")))?.id, nested.id);
});
