import { test } from "bun:test";
import assert from "node:assert/strict";
import { renderPlanCapsule, renderFlowStatus, renderVerdict, renderProposal, renderPrompt } from "../src/core/render.js";
import type { PlanCapsule, FlowState, MergedVerdict } from "../src/core/flow-schema.js";

const samplePlan: PlanCapsule = {
  schemaVersion: 1,
  ticket: { schemaVersion: 1, platform: "github", id: "GH-42" },
  summary: "Fix the login button alignment",
  rootCause: "CSS flexbox misconfiguration",
  files: [
    { path: "src/components/Login.tsx", action: "modify", reason: "Fix flex alignment", risk: "low" },
    { path: "src/styles/login.css", action: "modify", reason: "Update flex rules", risk: "low" },
  ],
  tests: [
    { path: "src/components/Login.test.tsx", type: "unit", description: "Test login renders" },
  ],
  verification: { typecheck: true, lint: true, test: true, build: false },
  createdAt: "2026-08-31T12:00:00.000Z",
};

const sampleState: FlowState = {
  phase: "plan",
  schemaVersion: 1,
  workspaceId: "root-abc123",
  startedAt: "2026-08-31T11:00:00.000Z",
  difficulty: 3,
  ticket: {
    schemaVersion: 1,
    ref: { schemaVersion: 1, platform: "github", id: "GH-42" },
    title: "Fix login button",
    description: "The button is misaligned",
    type: "bugfix",
    attachments: [],
    fetchedAt: "2026-08-31T11:00:00.000Z",
  },
  branch: "bugfix/GH-42-login-button",
  baseBranch: "develop",
  plan: samplePlan,
};

const sampleVerdict: MergedVerdict = {
  schemaVersion: 1,
  approved: false,
  critical: ["Missing error handling in edge case"],
  warnings: ["Consider adding loading state"],
  suggestions: ["Add aria-label for accessibility"],
  judgeA: {
    schemaVersion: 1,
    judge: "a",
    approved: false,
    critical: ["Missing error handling"],
    warnings: [],
    suggestions: [],
    reviewedAt: "2026-08-31T12:00:00.000Z",
  },
  judgeB: {
    schemaVersion: 1,
    judge: "b",
    approved: true,
    critical: [],
    warnings: ["Add loading state"],
    suggestions: ["Add aria-label"],
    reviewedAt: "2026-08-31T12:00:00.000Z",
  },
  mergedAt: "2026-08-31T12:00:00.000Z",
};

test("renderPlanCapsule produces markdown", () => {
  const md = renderPlanCapsule(samplePlan);
  assert.ok(md.includes("Plan de Implementación"));
  assert.ok(md.includes("GH-42"));
  assert.ok(md.includes("Fix the login button alignment"));
  assert.ok(md.includes("src/components/Login.tsx"));
  assert.ok(md.includes("CSS flexbox misconfiguration"));
});

test("renderFlowStatus produces markdown", () => {
  const md = renderFlowStatus(sampleState);
  assert.ok(md.includes("Estado del Flujo"));
  assert.ok(md.includes("plan"));
  assert.ok(md.includes("root-abc123"));
  assert.ok(md.includes("GH-42"));
  assert.ok(md.includes("bugfix/GH-42-login-button"));
});

test("renderVerdict produces markdown", () => {
  const md = renderVerdict(sampleVerdict);
  assert.ok(md.includes("Veredicto del Día del Juicio"));
  assert.ok(md.includes("RECHAZADO"));
  assert.ok(md.includes("Missing error handling in edge case"));
  assert.ok(md.includes("Consider adding loading state"));
});

test("renderProposal produces markdown", () => {
  const md = renderProposal("My Title", "My body content");
  assert.ok(md.includes("My Title"));
  assert.ok(md.includes("My body content"));
  assert.ok(md.includes("mr-orchestrator /propose"));
});

test("renderPrompt produces markdown", () => {
  const md = renderPrompt("test prompt content");
  assert.ok(md.includes("Prompt Generado"));
  assert.ok(md.includes("test prompt content"));
  assert.ok(md.includes("portapapeles"));
});

// ─── SDD + RPI Renderers ──────────────────────────────────────────────────────

import { renderResearchCapsule, renderSpecCapsule, renderTaskGraph, renderSddIssues } from "../src/core/render.js";
import type { ResearchCapsule, SpecCapsule, TaskGraph } from "../src/core/sdd-schema.js";

const sddNow = "2026-09-01T00:00:00.000Z";

test("renderResearchCapsule produces evidence table", () => {
  const research: ResearchCapsule = {
    schemaVersion: 1,
    ticketId: "GH-7",
    objective: "Map the atlas cache",
    evidence: [{ claim: "Cache lives in cacheRoot", file: "src/core/atlas.ts", line: 700, source: "read" }],
    relevantNodes: ["saveAtlasGraph"],
    constraints: [],
    unknowns: ["invalidation policy"],
    createdAt: sddNow,
  };
  const md = renderResearchCapsule(research);
  assert.ok(md.includes("# Research — GH-7"));
  assert.ok(md.includes("`src/core/atlas.ts:700`"));
  assert.ok(md.includes("invalidation policy"));
  assert.ok(md.includes("Generado por script"));
});

test("renderSpecCapsule produces EARS acceptance criteria", () => {
  const spec: SpecCapsule = {
    schemaVersion: 1,
    ticketId: "GH-7",
    goal: "Deterministic cache",
    scopeIn: ["atlas"],
    scopeOut: ["engram"],
    requirements: [{
      id: "R1",
      statement: "Cache invalidates on git changes",
      acceptance: [{ given: "a cached graph", when: "HEAD changes", then: "the graph reindexes" }],
    }],
    risks: ["stale cache"],
    createdAt: sddNow,
  };
  const md = renderSpecCapsule(spec);
  assert.ok(md.includes("### R1: Cache invalidates on git changes"));
  assert.ok(md.includes("**Dado** a cached graph"));
  assert.ok(md.includes("**Cuando** HEAD changes"));
  assert.ok(md.includes("**Entonces** the graph reindexes"));
});

test("renderTaskGraph shows progress and file tables", () => {
  const tasks: TaskGraph = {
    schemaVersion: 1,
    ticketId: "GH-7",
    tasks: [{
      id: "T1",
      title: "Add stamp",
      dependsOn: [],
      requirements: ["R1"],
      files: [{ path: "src/core/atlas.ts", action: "modify", reason: "stamp", risk: "low" }],
      verify: ["bun test"],
      doneWhen: ["stamp persisted"],
      status: "done",
    }],
    createdAt: sddNow,
  };
  const md = renderTaskGraph(tasks);
  assert.ok(md.includes("(1/1 completadas)"));
  assert.ok(md.includes("✅ T1: Add stamp"));
  assert.ok(md.includes("`src/core/atlas.ts`"));
});

test("renderSddIssues separates errors and warnings", () => {
  const md = renderSddIssues([
    { severity: "error", message: "boom" },
    { severity: "warning", message: "careful" },
  ]);
  assert.ok(md.includes("## Errores (1)"));
  assert.ok(md.includes("❌ boom"));
  assert.ok(md.includes("⚠️ careful"));
  assert.equal(renderSddIssues([]), "✅ Sin problemas de validación.");
});
