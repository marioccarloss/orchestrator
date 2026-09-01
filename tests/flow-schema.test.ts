import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  FlowStateSchema,
  FlowEventSchema,
  PlanCapsuleSchema,
  transition,
  canTransition,
  MigrationRegistry,
  type FlowState,
  type FlowEvent,
} from "../src/core/flow-schema.js";

const baseInit: FlowState = {
  phase: "init",
  schemaVersion: 1,
  workspaceId: "test-ws",
  startedAt: new Date().toISOString(),
};

const baseWizard: FlowState = {
  phase: "wizard",
  schemaVersion: 1,
  workspaceId: "test-ws",
  startedAt: new Date().toISOString(),
  difficulty: 3,
  ticketId: "GH-123",
  hasFigma: false,
};

const baseContext: FlowState = {
  phase: "context",
  schemaVersion: 1,
  workspaceId: "test-ws",
  startedAt: new Date().toISOString(),
  difficulty: 3,
  ticket: {
    schemaVersion: 1,
    ref: { schemaVersion: 1, platform: "github", id: "GH-123" },
    title: "Test ticket",
    description: "Test description",
    type: "feature",
    attachments: [],
    fetchedAt: new Date().toISOString(),
  },
  branch: "feature/GH-123-test",
  baseBranch: "develop",
};

const basePlan: FlowState = {
  phase: "plan",
  schemaVersion: 1,
  workspaceId: "test-ws",
  startedAt: new Date().toISOString(),
  difficulty: 3,
  ticket: baseContext.ticket,
  branch: "feature/GH-123-test",
  baseBranch: "develop",
  plan: {
    schemaVersion: 1,
    ticket: { schemaVersion: 1, platform: "github", id: "GH-123" },
    summary: "Test plan",
    files: [
      { path: "src/foo.ts", action: "modify", reason: "Fix bug", risk: "low" },
    ],
    tests: [],
    verification: { typecheck: true, lint: true, test: true, build: false },
    createdAt: new Date().toISOString(),
  },
};

test("FlowStateSchema validates init state", () => {
  const parsed = FlowStateSchema.parse(baseInit);
  assert.equal(parsed.phase, "init");
});

test("FlowStateSchema validates wizard state", () => {
  const parsed = FlowStateSchema.parse(baseWizard);
  assert.equal(parsed.phase, "wizard");
  assert.equal(parsed.difficulty, 3);
});

test("FlowStateSchema validates context state", () => {
  const parsed = FlowStateSchema.parse(baseContext);
  assert.equal(parsed.phase, "context");
  assert.equal(parsed.ticket.title, "Test ticket");
});

test("FlowStateSchema validates plan state", () => {
  const parsed = FlowStateSchema.parse(basePlan);
  assert.equal(parsed.phase, "plan");
  assert.equal(parsed.plan.files.length, 1);
});

test("PlanCapsuleSchema validates minimal plan", () => {
  const plan = PlanCapsuleSchema.parse(basePlan.plan);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0]!.path, "src/foo.ts");
});

test("canTransition allows valid transitions", () => {
  assert.equal(canTransition(baseInit, "wizard"), true);
  assert.equal(canTransition(baseWizard, "context"), true);
  assert.equal(canTransition(baseContext, "explore"), true);
  assert.equal(canTransition(basePlan, "implement"), true);
  assert.equal(canTransition(basePlan, "plan"), true);
});

test("canTransition rejects invalid transitions", () => {
  assert.equal(canTransition(baseInit, "implement"), false);
  assert.equal(canTransition(baseWizard, "plan"), false);
  assert.equal(canTransition(basePlan, "wizard"), false);
});

test("transition from init to wizard", () => {
  const event: FlowEvent = { type: "start", workspaceId: "test-ws" };
  const next = transition(baseInit, event);
  assert.equal(next.phase, "wizard");
});

test("transition from wizard to context", () => {
  const event: FlowEvent = {
    type: "wizard_complete",
    difficulty: 3,
    ticketId: "GH-123",
    hasFigma: false,
  };
  const next = transition(baseWizard, event);
  assert.equal(next.phase, "context");
});

test("transition from plan to implement on approval", () => {
  const event: FlowEvent = { type: "plan_approved", plan: basePlan.plan };
  const next = transition(basePlan, event);
  assert.equal(next.phase, "implement");
});

test("transition from plan back to explore on rejection", () => {
  const event: FlowEvent = { type: "plan_rejected" };
  const next = transition(basePlan, event);
  assert.equal(next.phase, "explore");
});

test("transition from implement to finish for lite difficulty", () => {
  const implementState: FlowState = {
    ...basePlan,
    phase: "implement",
    completedFiles: [],
  };
  const event: FlowEvent = { type: "implement_done", completedFiles: ["src/foo.ts"] };
  const next = transition(implementState, event);
  assert.equal(next.phase, "finish");
});

test("transition from implement to judgment for full difficulty", () => {
  const implementState: FlowState = {
    ...basePlan,
    phase: "implement",
    difficulty: 5,
    completedFiles: [],
  };
  const event: FlowEvent = { type: "implement_done", completedFiles: ["src/foo.ts"] };
  const next = transition(implementState, event);
  assert.equal(next.phase, "judgment");
});

test("abort from any state goes to finish", () => {
  const event: FlowEvent = { type: "abort" };
  const next = transition(basePlan, event);
  assert.equal(next.phase, "finish");
});

test("MigrationRegistry applies migrations in order", () => {
  const registry = new MigrationRegistry();
  registry.register({
    fromVersion: 1,
    toVersion: 2,
    migrate: (state: unknown) => ({ ...(state as Record<string, unknown>), schemaVersion: 2, newField: "added" }),
  });
  registry.register({
    fromVersion: 2,
    toVersion: 3,
    migrate: (state: unknown) => ({ ...(state as Record<string, unknown>), schemaVersion: 3 }),
  });
  const result = registry.migrate({ schemaVersion: 1 }, 3);
  assert.equal(result["schemaVersion"], 3);
  assert.equal(result["newField"], "added");
});

test("MigrationRegistry throws on missing migration", () => {
  const registry = new MigrationRegistry();
  assert.throws(() => registry.migrate({ schemaVersion: 1 }, 2), /No migration registered/);
});
