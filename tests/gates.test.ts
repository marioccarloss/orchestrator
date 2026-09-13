import { test } from "bun:test";
import assert from "node:assert/strict";
import { gateAfterImplement, gateBeforeImplement, gateBeforeJudgment, gatePlan, gateRepositoryRules, gatesMode, shouldBlockGate } from "../src/core/gates.js";
import type { RepositoryRule } from "../src/core/rules/generator.js";
import type { AtlasGraph } from "../src/core/atlas.js";
import type { EvidenceStore } from "../src/core/evidence-store.js";
import type { ResearchCapsulePayload, SddTask, SpecCapsulePayload, TaskGraphPayload } from "../src/core/sdd-schema.js";
import type { VerificationReceipt } from "../src/core/verification.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const task: SddTask = {
  id: "T1",
  title: "Change target",
  dependsOn: [],
  requirements: ["R1"],
  files: [{ path: "src/target.ts", action: "modify", reason: "Change the evidenced target behavior", risk: "medium", evidenced: true }],
  doneWhen: ["The target behavior is covered"],
  status: "pending",
  targetSymbols: ["target"],
  evidenceRefs: ["ev-aaaaaaaa"],
  changeIntent: "Change target behavior",
  editBoundaries: { allowedFiles: ["src/target.ts"], forbiddenGlobs: ["src/generated/**"] },
  invariants: ["Preserve the public return type"],
  expectedDiff: { adds: ["new behavior"], removes: [], touchedTests: [] },
  verification: { commands: ["bun test tests/target.test.ts"], mustPass: true },
};

const spec: SpecCapsulePayload = {
  schemaVersion: 1,
  ticketId: "GH-1",
  goal: "Change target",
  scopeIn: ["target"],
  scopeOut: [],
  requirements: [{ id: "R1", statement: "Target changes safely", acceptance: [{ when: "target runs", then: "the result is correct" }] }],
  risks: [],
};

const tasks: TaskGraphPayload = { schemaVersion: 2, ticketId: "GH-1", tasks: [task] };
const research: ResearchCapsulePayload = {
  schemaVersion: 2,
  ticketId: "GH-1",
  objective: "Understand target",
  evidenceRefs: ["ev-aaaaaaaa"],
  coverage: { fresh: true, unsupportedFiles: [], unresolvedImports: [] },
  contracts: [],
  tests: [],
  relevantNodes: ["target"],
  constraints: [],
  unknowns: [],
};
const store: EvidenceStore = {
  schemaVersion: 1,
  ticketId: "GH-1",
  refs: [{
    id: "ev-aaaaaaaa",
    file: "src/target.ts",
    symbol: "target",
    range: [1, 3],
    fileHash: HASH_A,
    sliceHash: HASH_B,
    kind: "behavior",
    source: "atlas",
    supports: ["R1"],
    claim: "Target behavior lives here",
    createdAt: "2026-09-13T00:00:00.000Z",
  }],
};
const graph: AtlasGraph = {
  schemaVersion: 2,
  generatedAt: "2026-09-13T00:00:00.000Z",
  workspaceRoot: "/repo",
  nodes: [{ id: "target", name: "target", kind: "function", filePath: "src/target.ts", line: 1, endLine: 3, column: 0, exports: ["target"], imports: [], dependencies: [], dependents: [], metadata: {} }],
  edges: [],
  files: [{ path: "src/target.ts", contentHash: HASH_A, language: "typescript", parseStatus: "ok", nodeIds: ["target"] }],
  coverage: { indexerVersion: "2.1.0", supportedLanguages: ["typescript"], unsupportedFiles: [], parseErrors: [], unresolvedImports: [] },
  stats: { totalFiles: 1, totalNodes: 1, totalEdges: 0, indexDurationMs: 1 },
};

function receipt(overrides: Partial<VerificationReceipt> = {}): VerificationReceipt {
  return {
    schemaVersion: 1,
    taskId: "T1",
    results: [{ command: "bun test tests/target.test.ts", exitCode: 0, durationMs: 10, outputTail: "pass" }],
    changedFiles: ["src/target.ts"],
    diffHash: HASH_A,
    recordedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

test("repository rule gate catches deterministic naming, barrel and style violations", () => {
  const rule = (id: string, value: string, appliesTo: readonly string[]): RepositoryRule => ({ id, value, statement: id, kind: "confirmed", confidence: 1, evidence: [], appliesTo: [...appliesTo], severity: "block" });
  const gate = gateRepositoryRules([
    rule("naming.files", "kebab-case", ["**/*"]),
    rule("modules.barrels", "avoid", ["**/index.ts"]),
    rule("styles.no-important", "forbid", ["**/*.scss"]),
  ], [
    { path: "src/NewWidget.ts", action: "create", content: "export const x = 1;" },
    { path: "src/domain/index.ts", action: "create", content: "export * from './x.js';" },
    { path: "src/widget.scss", action: "modify", content: ".x { color: red !important; }" },
  ]);
  assert.deepEqual(gate.violations.map((violation) => violation.code), ["RULE_NAMING", "RULE_BARREL", "RULE_IMPORTANT"]);
  assert.equal(gate.ok, false);
});

test("gatePlan blocks a Full plan whose requirement lacks evidence", () => {
  const unsupportedStore: EvidenceStore = { ...store, refs: store.refs.map((ref) => ({ ...ref, supports: [] })) };
  const gate = gatePlan(spec, tasks, research, unsupportedStore, { full: true });
  assert.equal(gate.ok, false);
  assert.ok(gate.violations.some((violation) => violation.code === "REQUIREMENT_WITHOUT_EVIDENCE" && violation.severity === "block"));
});

test("gatePlan accepts a consistent evidence-backed TaskGraph", () => {
  assert.deepEqual(gatePlan(spec, tasks, research, store, { full: true }), { ok: true, violations: [] });
});

test("gateBeforeImplement rejects stale evidence and accepts a fresh receipt", () => {
  assert.equal(gateBeforeImplement(task, store, graph, new Map([["ev-aaaaaaaa", { status: "stale", reason: "file-changed" }]])).ok, false);
  assert.equal(gateBeforeImplement(task, store, graph, new Map([["ev-aaaaaaaa", { status: "fresh" }]])).ok, true);
});

test("gateAfterImplement blocks files outside boundaries and invalid receipts", () => {
  const outside = gateAfterImplement(task, ["src/target.ts", "src/other.ts"], receipt({ changedFiles: ["src/target.ts", "src/other.ts"] }), HASH_A);
  assert.equal(outside.ok, false);
  assert.ok(outside.violations.some((violation) => violation.code === "DIFF_OUTSIDE_BOUNDARY"));

  const failed = gateAfterImplement(task, ["src/target.ts"], receipt({ results: [{ command: "bun test tests/target.test.ts", exitCode: 1, durationMs: 10, outputTail: "fail" }] }), HASH_A);
  assert.ok(failed.violations.some((violation) => violation.code === "VERIFICATION_FAILED" && violation.severity === "block"));

  const wrongCommand = gateAfterImplement(task, ["src/target.ts"], receipt({ results: [{ command: "bun test", exitCode: 0, durationMs: 10, outputTail: "pass" }] }), HASH_A);
  assert.ok(wrongCommand.violations.some((violation) => violation.code === "VERIFICATION_COMMAND_MISMATCH"));
});

test("gateBeforeJudgment requires a fresh reindexed Atlas delta", () => {
  assert.equal(gateBeforeJudgment({ changed: true, reindexed: false, coverageFresh: true }).ok, false);
  assert.equal(gateBeforeJudgment({ changed: true, reindexed: true, coverageFresh: true }).ok, true);
  assert.equal(gateBeforeJudgment({ changed: false, reindexed: false, coverageFresh: false }).ok, false);
});

test("MR_GATES_MODE softens enforcement only in warn mode", () => {
  const failed = gateBeforeJudgment({ changed: true, reindexed: false, coverageFresh: true });
  assert.equal(gatesMode({}), "block");
  assert.equal(gatesMode({ MR_GATES_MODE: "warn" }), "warn");
  assert.equal(gatesMode({ MR_GATES_MODE: "block" }), "block");
  assert.equal(gatesMode({ MR_GATES_MODE: "invalid" }), "block");
  assert.equal(shouldBlockGate(failed, "warn"), false);
  assert.equal(shouldBlockGate(failed, "block"), true);
});
