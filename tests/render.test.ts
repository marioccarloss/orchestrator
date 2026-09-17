import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildTaskDeveloperNote, renderCoverageReceipt, renderPlanCapsule, renderPlanExplanation, renderFlowStatus, renderVerdict, renderProposal, renderPrompt } from "../src/core/render.js";
import type { PlanCapsule, FlowState, MergedVerdict } from "../src/core/flow-schema.js";
import type { AtlasGraph } from "../src/core/atlas.js";

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
  findings: [
    { severity: "critical", claim: "Missing error handling in edge case", file: "src/login.ts", line: 12, side: "new", source: "diff", evidence: "await login()" },
    { severity: "warning", claim: "Consider adding loading state", file: "src/login.ts", line: 13, side: "new", source: "diff", evidence: "setUser(user)" },
    { severity: "suggestion", claim: "Add aria-label for accessibility", file: "src/Login.tsx", line: 8, side: "new", source: "diff", evidence: "<button>" },
  ],
  judgeA: {
    schemaVersion: 1,
    judge: "a",
    status: "SUPPORTED",
    approved: false,
    diffHash: "a".repeat(64),
    findings: [{ severity: "critical", claim: "Missing error handling in edge case", file: "src/login.ts", line: 12, side: "new", source: "diff", evidence: "await login()" }],
    reviewedAt: "2026-08-31T12:00:00.000Z",
  },
  judgeB: {
    schemaVersion: 1,
    judge: "b",
    status: "SUPPORTED",
    approved: true,
    diffHash: "a".repeat(64),
    findings: [
      { severity: "warning", claim: "Consider adding loading state", file: "src/login.ts", line: 13, side: "new", source: "diff", evidence: "setUser(user)" },
      { severity: "suggestion", claim: "Add aria-label for accessibility", file: "src/Login.tsx", line: 8, side: "new", source: "diff", evidence: "<button>" },
    ],
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
  const md = renderFlowStatus(sampleState, {
    ticketId: "GH-42",
    status: "active",
    cost: 0.01234,
    messages: 2,
    sessions: 2,
    tokens: { input: 120, output: 30, reasoning: 10, cacheRead: 80, cacheWrite: 0 },
    context: { role: "implement", lane: "fast", requestedChars: 30_000, usedChars: 12_000, truncated: 1, hydrations: 2 },
  });
  assert.ok(md.includes("Estado del Flujo"));
  assert.ok(md.includes("plan"));
  assert.ok(md.includes("root-abc123"));
  assert.ok(md.includes("GH-42"));
  assert.ok(md.includes("bugfix/GH-42-login-button"));
  assert.ok(md.includes("✓ Ticket  →  ✓ Intención  →  ✓ Investigación  →  ● Planificación"));
  assert.ok(md.includes("— Revisión"));
  assert.ok(md.includes("$0.0123 USD"));
  assert.ok(md.includes("120/30/10"));
  assert.ok(md.includes("12000/30000 chars"));
});

test("renderFlowStatus explains a persisted risk lane", () => {
  const status = renderFlowStatus({ ...sampleState, lane: "critical", riskReasons: ["critical areas: auth"] });
  assert.match(status, /Carril de riesgo\*\*: critical/u);
  assert.match(status, /critical areas: auth/u);
  assert.doesNotMatch(status, /— Revisión/u);
});

test("renderPlanExplanation is deterministic and ultra-compact", () => {
  const explanation = renderPlanExplanation(samplePlan, 2);
  assert.ok(explanation.includes("Plan, en breve"));
  assert.ok(explanation.includes("**Qué**: Fix the login button alignment"));
  assert.ok(explanation.includes("**Por qué**: CSS flexbox misconfiguration"));
  assert.ok(explanation.includes("2 tareas; 2 archivos"));
  assert.ok(explanation.split("\n").length <= 5);
});

test("status, plan and verdict render independently in English", () => {
  const englishState: FlowState = { ...sampleState, userLanguage: "en" };
  const status = renderFlowStatus(englishState);
  const plan = renderPlanCapsule(samplePlan, "en");
  const explanation = renderPlanExplanation(samplePlan, 2, "en");
  const verdict = renderVerdict(sampleVerdict, "en");
  assert.match(status, /# Flow Status/u);
  assert.match(status, /● Planning/u);
  assert.match(plan, /# Implementation Plan/u);
  assert.match(plan, /## Affected Files/u);
  assert.match(explanation, /Plan at a glance/u);
  assert.match(verdict, /Judgment Day Verdict/u);
  assert.match(verdict, /REJECTED/u);
  assert.doesNotMatch([status, plan, explanation, verdict].join("\n"), /Estado del Flujo|Plan de Implementación|RECHAZADO/u);
});

test("coverage receipt renders in the selected language", () => {
  const graph: AtlasGraph = {
    schemaVersion: 2,
    generatedAt: "2026-09-01T00:00:00.000Z",
    workspaceRoot: "/repo",
    nodes: [],
    edges: [],
    files: [],
    coverage: {
      indexerVersion: "2.1.0",
      supportedLanguages: ["typescript"],
      unsupportedFiles: ["src/legacy.rb"],
      parseErrors: [{ path: "src/broken.ts", line: 3, message: "syntax" }],
      unresolvedImports: [{ from: "src/a.ts", specifier: "missing" }],
    },
    stats: { totalFiles: 2, totalNodes: 0, totalEdges: 0, indexDurationMs: 1 },
  };
  assert.match(renderCoverageReceipt(graph, true, {}, "es"), /--- cobertura ---[\s\S]*fresca: sí/u);
  assert.match(renderCoverageReceipt(graph, true, {}, "en"), /--- coverage ---[\s\S]*fresh: yes/u);
});

test("buildTaskDeveloperNote teaches what, why, touch and proof without prose expansion", () => {
  const note = buildTaskDeveloperNote({
    id: "T1",
    title: "Track Flow usage",
    dependsOn: [],
    requirements: ["R1"],
    files: [{ path: "src/core/flow-metrics.ts", action: "create", reason: "Persist usage", risk: "medium", evidenced: true }],
    doneWhen: ["Usage is deduplicated"],
    status: "pending",
    targetSymbols: [],
    evidenceRefs: ["ev-aaaaaaaa"],
    changeIntent: "Persist provider-reported usage",
    editBoundaries: { allowedFiles: ["src/core/flow-metrics.ts"], forbiddenGlobs: [] },
    invariants: [],
    expectedDiff: { adds: ["usage persistence"], removes: [], touchedTests: ["tests/flow-metrics.test.ts"] },
    verification: { commands: ["bun test tests/flow-metrics.test.ts"], mustPass: true },
  }, [{
    id: "R1",
    statement: "Developers can see provider-reported spend per Flow",
    acceptance: [{ when: "Flow runs", then: "usage is visible" }],
  }]);
  assert.deepEqual(note, {
    what: "Track Flow usage",
    why: "Developers can see provider-reported spend per Flow",
    touch: "src/core/flow-metrics.ts",
    prove: "bun test tests/flow-metrics.test.ts",
  });
});

test("renderVerdict produces markdown", () => {
  const md = renderVerdict(sampleVerdict);
  assert.ok(md.includes("Veredicto del Día del Juicio"));
  assert.ok(md.includes("RECHAZADO"));
  assert.ok(md.includes("Missing error handling in edge case"));
  assert.ok(md.includes("Consider adding loading state"));
  assert.ok(md.includes("src/login.ts:12"));
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
    schemaVersion: 2,
    ticketId: "GH-7",
    objective: "Map the atlas cache",
    evidenceRefs: ["ev-aaaaaaaa"],
    coverage: { fresh: true, unsupportedFiles: [], unresolvedImports: [] },
    contracts: [],
    tests: [],
    relevantNodes: ["saveAtlasGraph"],
    constraints: [],
    unknowns: ["invalidation policy"],
    createdAt: sddNow,
  };
  const md = renderResearchCapsule(research);
  assert.ok(md.includes("# Investigación — GH-7"));
  assert.ok(md.includes("`ev-aaaaaaaa`"));
  assert.ok(md.includes("invalidation policy"));
  assert.ok(md.includes("Generado por script"));
  assert.doesNotMatch(md, /2026-09-01T00:00:00\.000Z/u);
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
  assert.doesNotMatch(md, /2026-09-01T00:00:00\.000Z/u);
});

test("renderTaskGraph shows progress and file tables", () => {
  const tasks: TaskGraph = {
    schemaVersion: 2,
    ticketId: "GH-7",
    tasks: [{
      id: "T1",
      title: "Add stamp",
      dependsOn: [],
      requirements: ["R1"],
      files: [{ path: "src/core/atlas.ts", action: "modify", reason: "stamp", risk: "low", evidenced: true }],
      doneWhen: ["stamp persisted"],
      status: "done",
      targetSymbols: [],
      evidenceRefs: ["ev-aaaaaaaa"],
      changeIntent: "Persist the Atlas generation stamp",
      editBoundaries: { allowedFiles: ["src/core/atlas.ts"], forbiddenGlobs: ["docs/**"] },
      invariants: ["Preserve graph compatibility"],
      expectedDiff: { adds: ["generation stamp"], removes: [], touchedTests: [] },
      verification: { commands: ["bun test"], mustPass: true },
    }],
    createdAt: sddNow,
  };
  const md = renderTaskGraph(tasks);
  assert.ok(md.includes("(1/1 completadas)"));
  assert.ok(md.includes("✅ T1: Add stamp"));
  assert.ok(md.includes("`src/core/atlas.ts`"));
  assert.ok(md.includes("**Archivos permitidos**: src/core/atlas.ts"));
  assert.ok(md.includes("**Globs prohibidos**: docs/**"));
  assert.ok(md.includes("Preserve graph compatibility"));
  assert.doesNotMatch(md, /2026-09-01T00:00:00\.000Z/u);
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
