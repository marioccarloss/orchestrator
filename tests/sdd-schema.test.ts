import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  ResearchCapsuleSchema,
  ResearchCapsulePayloadSchema,
  ResearchCapsulePayloadInputSchema,
  PlanningAssessmentPayloadSchema,
  PlanningBriefPayloadSchema,
  PlanningBriefSchema,
  SpecCapsuleSchema,
  SpecCapsulePayloadSchema,
  TaskGraphSchema,
  TaskGraphPayloadSchema,
  validateSddArtifacts,
  nextPendingTask,
  markTaskStatus,
  formatZodIssues,
  canonicalSddPayload,
  migrateResearchToV2,
  migrateTaskGraphToV2,
  TaskGraphPayloadInputSchema,
  type ResearchCapsule,
  type PlanningBrief,
  type SpecCapsule,
  type TaskGraph,
} from "../src/core/sdd-schema.js";
import type { EvidenceStore } from "../src/core/evidence-store.js";

const NOW = new Date().toISOString();

function makeResearch(): ResearchCapsule {
  return {
    schemaVersion: 2,
    ticketId: "GH-42",
    objective: "Understand the flow state machine",
    evidenceRefs: ["ev-aaaaaaaa"],
    coverage: { fresh: true, unsupportedFiles: [], unresolvedImports: [] },
    contracts: [],
    tests: [],
    relevantNodes: ["transition"],
    constraints: ["Do not break FlowStateSchema v1"],
    unknowns: [],
    createdAt: NOW,
  };
}

function makeStore(): EvidenceStore {
  return {
    schemaVersion: 1,
    ticketId: "GH-42",
    refs: [{
      id: "ev-aaaaaaaa", file: "src/core/flow-schema.ts", symbol: "transition", range: [196, 196],
      fileHash: "a".repeat(64), sliceHash: "b".repeat(64), kind: "behavior", source: "atlas",
      supports: ["R1"], claim: "Flow transitions are defined here", createdAt: NOW,
    }],
  };
}

function makePlanningBrief(): PlanningBrief {
  return {
    schemaVersion: 1,
    ticketId: "GH-42",
    status: "READY",
    mode: "guided",
    decisions: [{ questionId: "Q1", decision: "Preserve the v1 state schema", source: "user" }],
    assumptions: [{ statement: "No UI changes are required", risk: "low" }],
    createdAt: NOW,
  };
}

function makeSpec(): SpecCapsule {
  return {
    schemaVersion: 1,
    ticketId: "GH-42",
    goal: "Add abort reason tracking",
    scopeIn: ["flow state machine"],
    scopeOut: ["UI changes"],
    requirements: [
      {
        id: "R1",
        statement: "Abort must record a reason",
        acceptance: [{ when: "the flow is aborted", then: "the reason is persisted" }],
      },
    ],
    risks: [],
    createdAt: NOW,
  };
}

function makeTasks(): TaskGraph {
  return {
    schemaVersion: 2,
    ticketId: "GH-42",
    tasks: [
      {
        id: "T1",
        title: "Extend abort event",
        dependsOn: [],
        requirements: ["R1"],
        files: [{ path: "src/core/flow-schema.ts", action: "modify", reason: "add reason field", risk: "medium", evidenced: true }],
        doneWhen: ["abort event carries reason"],
        status: "pending",
        targetSymbols: [],
        evidenceRefs: ["ev-aaaaaaaa"],
        changeIntent: "Add the abort reason field",
        editBoundaries: { allowedFiles: ["src/core/flow-schema.ts"], forbiddenGlobs: [] },
        invariants: [],
        expectedDiff: { adds: ["abort reason"], removes: [], touchedTests: [] },
        verification: { commands: ["bun run typecheck", "bun test"], mustPass: true },
      },
      {
        id: "T2",
        title: "Persist reason",
        dependsOn: ["T1"],
        requirements: ["R1"],
        files: [{ path: "src/core/flow-state.ts", action: "modify", reason: "Persist the reason despite lacking direct file evidence", risk: "low", evidenced: false }],
        doneWhen: ["reason visible in status"],
        status: "pending",
        targetSymbols: [],
        evidenceRefs: ["ev-aaaaaaaa"],
        changeIntent: "Persist the abort reason",
        editBoundaries: { allowedFiles: ["src/core/flow-state.ts"], forbiddenGlobs: [] },
        invariants: [],
        expectedDiff: { adds: ["stored reason"], removes: [], touchedTests: [] },
        verification: { commands: ["bun test"], mustPass: true },
      },
    ],
    createdAt: NOW,
  };
}

test("schemas accept valid capsules and reject unknown keys", () => {
  assert.ok(ResearchCapsuleSchema.safeParse(makeResearch()).success);
  assert.ok(PlanningBriefSchema.safeParse(makePlanningBrief()).success);
  assert.ok(SpecCapsuleSchema.safeParse(makeSpec()).success);
  assert.ok(TaskGraphSchema.safeParse(makeTasks()).success);

  const polluted = { ...makeSpec(), invented: true };
  const rejected = SpecCapsuleSchema.safeParse(polluted);
  assert.equal(rejected.success, false);
});

test("operational capsule schemas exclude volatile persistence timestamps", () => {
  const { createdAt: _researchCreatedAt, ...research } = makeResearch();
  const { createdAt: _briefCreatedAt, ...brief } = makePlanningBrief();
  const { createdAt: _specCreatedAt, ...spec } = makeSpec();
  const { createdAt: _tasksCreatedAt, ...tasks } = makeTasks();

  assert.ok(ResearchCapsulePayloadSchema.safeParse(research).success);
  assert.ok(PlanningBriefPayloadSchema.safeParse(brief).success);
  assert.ok(SpecCapsulePayloadSchema.safeParse(spec).success);
  assert.ok(TaskGraphPayloadSchema.safeParse(tasks).success);
  assert.equal(ResearchCapsulePayloadSchema.safeParse(makeResearch()).success, false);
  assert.equal(PlanningBriefPayloadSchema.safeParse(makePlanningBrief()).success, false);
  assert.equal(SpecCapsulePayloadSchema.safeParse(makeSpec()).success, false);
  assert.equal(TaskGraphPayloadSchema.safeParse(makeTasks()).success, false);

  const source = makeResearch();
  const shuffled: ResearchCapsule = {
    createdAt: "2026-09-11T12:34:56.000Z",
    unknowns: source.unknowns,
    constraints: source.constraints,
    relevantNodes: source.relevantNodes,
    evidenceRefs: source.evidenceRefs,
    coverage: source.coverage,
    contracts: source.contracts,
    tests: source.tests,
    objective: source.objective,
    ticketId: source.ticketId,
    schemaVersion: source.schemaVersion,
  };
  const first = canonicalSddPayload(source);
  const second = canonicalSddPayload(shuffled);
  assert.equal(first, second);
  assert.doesNotMatch(first, /createdAt/u);
  assert.doesNotMatch(first, /\n| {2}/u);

  const briefPayload = canonicalSddPayload(makePlanningBrief());
  assert.equal(JSON.parse(briefPayload).status, "READY");
  assert.doesNotMatch(briefPayload, /createdAt/u);
});

test("Blueprint-lite accepts at most three material questions and forbids high-risk assumptions", () => {
  const needsInput = PlanningAssessmentPayloadSchema.safeParse({
    schemaVersion: 1,
    ticketId: "GH-42",
    status: "NEEDS_INPUT",
    questions: [
      { id: "Q1", question: "Should this change preserve v1 clients?", reason: "It changes the public contract", risk: "high", options: ["yes", "no"] },
    ],
  });
  assert.equal(needsInput.success, true);

  const tooManyQuestions = PlanningAssessmentPayloadSchema.safeParse({
    schemaVersion: 1,
    ticketId: "GH-42",
    status: "NEEDS_INPUT",
    questions: Array.from({ length: 4 }, (_, index) => ({
      id: `Q${index + 1}`,
      question: `Question ${index + 1}`,
      reason: "Material planning decision",
      risk: "medium",
      options: [],
    })),
  });
  assert.equal(tooManyQuestions.success, false);

  const wrongRiskOrder = PlanningAssessmentPayloadSchema.safeParse({
    schemaVersion: 1,
    ticketId: "GH-42",
    status: "NEEDS_INPUT",
    questions: [
      { id: "Q1", question: "Medium question", reason: "Material decision", risk: "medium", options: [] },
      { id: "Q2", question: "High question", reason: "Contract decision", risk: "high", options: [] },
    ],
  });
  assert.equal(wrongRiskOrder.success, false);

  const { createdAt: _createdAt, ...readyBrief } = makePlanningBrief();
  const unsafeAssumption = PlanningBriefPayloadSchema.safeParse({
    ...readyBrief,
    assumptions: [{ statement: "Authentication is unnecessary", risk: "high" }],
  });
  assert.equal(unsafeAssumption.success, false);
});

test("ResearchCapsule v1 migrates to v2 without losing claims", async () => {
  const legacy = ResearchCapsulePayloadInputSchema.parse({
    schemaVersion: 1,
    ticketId: "GH-42",
    objective: "Map legacy evidence",
    evidence: [{ claim: "Legacy claim", file: "src/a.ts", line: 4, source: "read" }],
    relevantNodes: ["a"], constraints: ["keep behavior"], unknowns: [],
  });
  const seen: string[] = [];
  const migrated = await migrateResearchToV2(legacy, async (evidence) => {
    seen.push(evidence.claim);
    return "ev-aaaaaaaa";
  }, { fresh: true, unsupportedFiles: [], unresolvedImports: [] });
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.evidenceRefs, ["ev-aaaaaaaa"]);
  assert.deepEqual(seen, ["Legacy claim"]);
  assert.deepEqual(migrated.constraints, ["keep behavior"]);
});

test("TaskGraph v1 migrates to v2 without relabeling the legacy schema", () => {
  const legacy = TaskGraphPayloadInputSchema.parse({
    schemaVersion: 1,
    ticketId: "GH-42",
    tasks: [{
      id: "T1",
      title: "Extend abort event",
      dependsOn: [],
      requirements: ["R1"],
      files: [{ path: "src/core/flow-schema.ts", action: "modify", reason: "add reason field", risk: "medium" }],
      verify: ["bun test"],
      doneWhen: ["abort event carries reason"],
      status: "pending",
    }],
  });
  const migrated = migrateTaskGraphToV2(legacy, makeResearch(), makeStore());
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.tasks[0]?.changeIntent, "add reason field");
  assert.deepEqual(migrated.tasks[0]?.editBoundaries.allowedFiles, ["src/core/flow-schema.ts"]);
  assert.deepEqual(migrated.tasks[0]?.verification.commands, ["bun test"]);
  assert.equal(migrated.tasks[0]?.files[0]?.evidenced, true);
  assert.deepEqual(migrated.tasks[0]?.evidenceRefs, ["ev-aaaaaaaa"]);
});

test("TaskGraph v2 rejects a short reason for an unevidenced file", () => {
  const tasks = makeTasks();
  const { createdAt: _createdAt, ...payload } = tasks;
  const rejected = TaskGraphPayloadSchema.safeParse({
    ...payload,
    tasks: [{ ...tasks.tasks[0], files: [{ ...tasks.tasks[0]!.files[0], evidenced: false, reason: "too short" }] }],
  });
  assert.equal(rejected.success, false);
  if (!rejected.success) assert.match(formatZodIssues(rejected.error), /at least 40 characters/u);
});

test("schema rejects malformed requirement and task ids", () => {
  const badSpec = makeSpec();
  const parsed = SpecCapsuleSchema.safeParse({
    ...badSpec,
    requirements: [{ ...badSpec.requirements[0], id: "REQ-1" }],
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.ok(formatZodIssues(parsed.error).includes("R<number>"));
  }
});

test("validateSddArtifacts detects unknown requirement, uncovered requirement and cycles", () => {
  const spec = makeSpec();
  const tasks = makeTasks();

  // Unknown requirement
  const badReq: TaskGraph = {
    ...tasks,
    tasks: [{ ...tasks.tasks[0]!, requirements: ["R9"] }],
  };
  const issues1 = validateSddArtifacts(spec, badReq);
  assert.ok(issues1.some((issue) => issue.severity === "error" && issue.message.includes("unknown requirement R9")));
  assert.ok(issues1.some((issue) => issue.severity === "error" && issue.message.includes("R1 is not covered")));

  // Cycle
  const cyclic: TaskGraph = {
    ...tasks,
    tasks: [
      { ...tasks.tasks[0]!, dependsOn: ["T2"] },
      { ...tasks.tasks[1]!, dependsOn: ["T1"] },
    ],
  };
  const issues2 = validateSddArtifacts(spec, cyclic);
  assert.ok(issues2.some((issue) => issue.message.includes("cycle")));
});

test("validateSddArtifacts warns when modifying files without research evidence", () => {
  const issues = validateSddArtifacts(makeSpec(), makeTasks(), makeResearch(), { evidenceStore: makeStore() });
  const warnings = issues.filter((issue) => issue.severity === "warning");
  assert.equal(warnings.length, 1);
  assert.ok(warnings.some((warning) => warning.message.includes("src/core/flow-state.ts")));
  assert.equal(issues.filter((issue) => issue.severity === "error").length, 0);
});

test("validateSddArtifacts rejects research from another ticket", () => {
  const research = { ...makeResearch(), ticketId: "GH-OTHER" };
  const issues = validateSddArtifacts(makeSpec(), makeTasks(), research, { evidenceStore: makeStore() });
  assert.ok(issues.some((issue) => issue.severity === "error" && issue.message.includes("Research ticket 'GH-OTHER'")));
});

test("validateSddArtifacts blocks unevidenced modified files in Full flows", () => {
  const issues = validateSddArtifacts(makeSpec(), makeTasks(), makeResearch(), {
    requireEvidenceForModifiedFiles: true,
    evidenceStore: makeStore(),
  });
  const groundingError = issues.find((issue) => issue.message.includes("src/core/flow-state.ts"));
  assert.equal(groundingError?.severity, "error");

  const missingResearch = validateSddArtifacts(makeSpec(), makeTasks(), undefined, {
    requireEvidenceForModifiedFiles: true,
  });
  assert.ok(missingResearch.some((issue) => issue.severity === "error" && issue.message.includes("Research capsule is required")));
});

test("nextPendingTask respects dependency order and markTaskStatus advances", () => {
  let tasks = makeTasks();
  assert.equal(nextPendingTask(tasks)?.id, "T1");

  tasks = markTaskStatus(tasks, "T1", "done");
  assert.equal(nextPendingTask(tasks)?.id, "T2");

  tasks = markTaskStatus(tasks, "T2", "done");
  assert.equal(nextPendingTask(tasks), undefined);

  assert.throws(() => markTaskStatus(tasks, "T99", "done"), /Unknown task T99/u);
});
