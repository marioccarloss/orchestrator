import { test } from "bun:test";
import assert from "node:assert/strict";
import { hydrateContext } from "../src/core/context-hydrator.js";
import type { AtlasGraph } from "../src/core/atlas.js";
import type { EvidenceStore } from "../src/core/evidence-store.js";
import type { ResearchCapsulePayload, SpecCapsulePayload, TaskGraphPayload } from "../src/core/sdd-schema.js";
import { rulesDigest, type WorkspaceRules } from "../src/core/rules/generator.js";

const graph: AtlasGraph = {
  schemaVersion: 2, generatedAt: "2026-09-13T00:00:00.000Z", workspaceRoot: "/repo",
  nodes: [
    { id: "a", name: "target", kind: "function", filePath: "src/a.ts", line: 1, endLine: 3, column: 0, exports: ["target"], imports: [], dependencies: ["b"], dependents: [], signature: "target(): void", metadata: {} },
    { id: "b", name: "callee", kind: "function", filePath: "src/b.ts", line: 1, endLine: 2, column: 0, exports: ["callee"], imports: [], dependencies: [], dependents: ["a"], signature: "callee(): void", metadata: {} },
  ],
  edges: [{ from: "a", to: "b", type: "calls" }],
  files: [
    { path: "src/a.ts", contentHash: "a".repeat(64), language: "typescript", parseStatus: "ok", nodeIds: ["a"] },
    { path: "src/b.ts", contentHash: "b".repeat(64), language: "typescript", parseStatus: "ok", nodeIds: ["b"] },
  ],
  coverage: { indexerVersion: "2.1.0", supportedLanguages: ["typescript"], unsupportedFiles: [], parseErrors: [], unresolvedImports: [] },
  stats: { totalFiles: 2, totalNodes: 2, totalEdges: 1, indexDurationMs: 1 },
};

const store: EvidenceStore = {
  schemaVersion: 1, ticketId: "GH-1", refs: [
    { id: "ev-aaaaaaaa", file: "src/a.ts", symbol: "target", range: [1, 3], fileHash: "a".repeat(64), sliceHash: "c".repeat(64), kind: "behavior", source: "atlas", supports: ["R1"], claim: "target behavior", createdAt: "2026-09-13T00:00:00.000Z" },
    { id: "ev-bbbbbbbb", file: "tests/a.test.ts", range: [1, 4], fileHash: "d".repeat(64), sliceHash: "e".repeat(64), kind: "test", source: "read", supports: ["R1"], claim: "target test", createdAt: "2026-09-13T00:00:00.000Z" },
  ],
};

const research: ResearchCapsulePayload = {
  schemaVersion: 2, ticketId: "GH-1", objective: "change target", evidenceRefs: ["ev-aaaaaaaa", "ev-bbbbbbbb"],
  coverage: { fresh: true, unsupportedFiles: [], unresolvedImports: [] },
  contracts: [{ name: "TargetContract", file: "src/a.ts", kind: "interface" }],
  tests: [{ file: "tests/a.test.ts", covers: ["R1"] }], relevantNodes: ["target"], constraints: [], unknowns: [],
};

const spec: SpecCapsulePayload = {
  schemaVersion: 1, ticketId: "GH-1", goal: "change target", scopeIn: ["target"], scopeOut: [], risks: [],
  requirements: [{ id: "R1", statement: "target changes safely", acceptance: [{ when: "called", then: "it works" }] }],
};

const tasks: TaskGraphPayload = {
  schemaVersion: 2, ticketId: "GH-1", tasks: [{
    id: "T1", title: "Change target", dependsOn: [], requirements: ["R1"],
    files: [{ path: "src/a.ts", action: "modify", reason: "behavior", risk: "medium", evidenced: true }],
    doneWhen: ["tests pass"], status: "pending", targetSymbols: ["target"], evidenceRefs: ["ev-aaaaaaaa"],
    changeIntent: "Change target behavior", editBoundaries: { allowedFiles: ["src/a.ts"], forbiddenGlobs: [] },
    invariants: [], expectedDiff: { adds: [], removes: [], touchedTests: [] }, verification: { commands: ["bun test"], mustPass: true },
  }],
};

const freshness = async () => ({ status: "fresh" as const });

test("implement hydration uses exactly task refs and includes acceptance and callees", async () => {
  const workspaceRules: WorkspaceRules = {
    schemaVersion: 1, generatedAt: "2026-09-13T00:00:00.000Z", preferences: [], repositories: [{
      schemaVersion: 1, repo: "repo", mode: "baseline", generatedFromIndex: "a".repeat(64), rules: [
        { id: "naming.files", value: "kebab-case", statement: "Name files using kebab-case.", kind: "inferred", confidence: 0.9, evidence: [], appliesTo: ["**/*.ts"], severity: "warn" },
        { id: "styles.no-important", value: "forbid", statement: "Do not introduce !important.", kind: "inferred", confidence: 0.9, evidence: [], appliesTo: ["**/*.scss"], severity: "warn" },
      ],
    }],
  };
  const bundle = await hydrateContext({
    role: "implement", ticketId: "GH-1", taskId: "T1", research, spec, tasks, store, graph,
    readSlice: async (ref) => ref.id === "ev-aaaaaaaa" ? "function target() {}" : "test()",
    checkFreshness: freshness,
    rules: rulesDigest(workspaceRules, "repo", ["src/a.ts"]),
  });
  assert.deepEqual(bundle.slices.map((slice) => slice.ref), ["ev-aaaaaaaa"]);
  assert.equal(bundle.acceptance?.[0]?.id, "R1");
  assert.ok(bundle.neighbors.some((neighbor) => neighbor.relation === "callee" && neighbor.symbol === "callee"));
  assert.deepEqual(bundle.rules.map((rule) => rule.id), ["naming.files"]);
});

test("hydration truncates whole slices at a deterministic budget", async () => {
  const bundle = await hydrateContext({
    role: "implement", ticketId: "GH-1", taskId: "T1", research, spec, tasks, store, graph, budgetChars: 2_000,
    readSlice: async () => "x".repeat(5_000), checkFreshness: freshness,
  });
  assert.deepEqual(bundle.slices, []);
  assert.ok(bundle.budget.truncated.includes("ev-aaaaaaaa"));
  assert.ok(bundle.budget.usedChars <= bundle.budget.requestedChars);
});

test("hydration applies the centralized role-by-lane budget", async () => {
  const bundle = await hydrateContext({
    role: "implement", lane: "fast", ticketId: "GH-1", taskId: "T1", research, spec, tasks, store, graph,
    readSlice: async () => "small slice", checkFreshness: freshness,
  });
  assert.equal(bundle.budget.requestedChars, 30_000);
  assert.ok(bundle.budget.usedChars > 0);
  assert.ok(bundle.budget.usedChars <= bundle.budget.requestedChars);
});

test("fix hydration adds live line context for validated findings", async () => {
  const bundle = await hydrateContext({
    role: "fix", ticketId: "GH-1", taskId: "T1", research, spec, tasks, store, graph,
    readSlice: async () => "old", checkFreshness: freshness,
    findings: [{ severity: "critical", claim: "broken", file: "src/a.ts", line: 22, side: "new", source: "diff", evidence: "bad" }],
    readLiveRange: async (_file, start, end) => `${String(start)}-${String(end)}`,
  });
  const live = bundle.slices.find((slice) => slice.ref.startsWith("live:"));
  assert.equal(live?.range[0], 2);
  assert.equal(live?.range[1], 42);
  assert.equal(live?.text, "2-42");
});
