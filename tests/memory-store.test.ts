import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistentMemoryStore } from "../src/core/memory-store.js";
import { resolvePaths } from "../src/core/paths.js";
import { runCommand } from "../src/core/process.js";

void test("Pillar 5 Context Amnesia Resilience: PersistentMemoryStore saves observations and invalidates stale records on git tree changes", async () => {
  const rawHome = await mkdtemp(join(tmpdir(), "mr-mem-test-"));
  const home = await realpath(rawHome);
  const workspaceRoot = join(home, "repo");
  await mkdir(workspaceRoot, { recursive: true });

  // Initialize git repo
  runCommand("git", ["init", workspaceRoot]);
  runCommand("git", ["-C", workspaceRoot, "config", "user.email", "test@test.local"]);
  runCommand("git", ["-C", workspaceRoot, "config", "user.name", "Tester"]);
  await writeFile(join(workspaceRoot, "README.md"), "# Initial\n");
  runCommand("git", ["-C", workspaceRoot, "add", "."]);
  runCommand("git", ["-C", workspaceRoot, "commit", "-m", "init"]);

  const paths = resolvePaths({ HOME: home });
  const store = new PersistentMemoryStore(paths, "test-ws", workspaceRoot);

  // 1. Save an architectural decision / ADR observation
  const obs = await store.saveObservation(
    "auth/jwt",
    "We use RS256 with key rotation for microservice authentication.",
    { decision: "accepted", adrId: "ADR-001" }
  );
  assert.ok(obs.id.startsWith("mem-"));
  assert.equal(obs.topic, "auth/jwt");
  assert.ok(obs.gitStamp && obs.gitStamp.length >= 8);

  // 2. Query while git tree is fresh -> isStale must be false
  const freshResults = await store.query({ topic: "auth" });
  assert.equal(freshResults.length, 1);
  assert.equal(freshResults[0]!.observation.content, "We use RS256 with key rotation for microservice authentication.");
  assert.equal(freshResults[0]!.isStale, false, "Observation must be fresh when workspace tree matches");

  // 3. Mutate workspace (modify file and commit new git state)
  await writeFile(join(workspaceRoot, "README.md"), "# Mutated tree state\n");
  runCommand("git", ["-C", workspaceRoot, "add", "."]);
  runCommand("git", ["-C", workspaceRoot, "commit", "-m", "tree drift"]);

  // 4. Query after tree drift -> isStale must deterministically be true (Fail-Closed Context Invalidation)
  const driftedResults = await store.query({ topic: "auth" });
  assert.equal(driftedResults.length, 1);
  assert.equal(driftedResults[0]!.isStale, true, "Memory must be invalidated as stale when gitStamp does not match HEAD");

  // 5. Query without freshness validation still returns historical data
  const rawResults = await store.query({ topic: "auth", validateFreshness: false });
  assert.equal(rawResults.length, 1);
  assert.equal(rawResults[0]!.isStale, false);
});
