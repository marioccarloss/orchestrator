import { test } from "bun:test";
import assert from "node:assert/strict";
import { traceComponent, renderTraceReport, buildPrompt, saveProposal, PROMPT_TEMPLATES } from "../src/core/tools.js";
import type { AtlasGraph } from "../src/core/atlas.js";
import { resolvePaths } from "../src/core/paths.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockGraph: AtlasGraph = {
  schemaVersion: 1,
  generatedAt: "2026-08-31T12:00:00.000Z",
  workspaceRoot: "/test",
  nodes: [
    {
      id: "node1",
      name: "Button",
      kind: "component",
      filePath: "src/Button.tsx",
      line: 5,
      column: 0,
      exports: ["Button"],
      imports: ["react"],
      dependencies: ["node2"],
      dependents: [],
      metadata: {},
    },
    {
      id: "node2",
      name: "useCounter",
      kind: "hook",
      filePath: "src/useCounter.ts",
      line: 3,
      column: 0,
      exports: ["useCounter"],
      imports: ["react"],
      dependencies: [],
      dependents: ["node1"],
      metadata: {},
    },
  ],
  edges: [
    { from: "node1", to: "node2", type: "import" },
  ],
  stats: { totalFiles: 2, totalNodes: 2, totalEdges: 1, indexDurationMs: 100 },
};

test("traceComponent finds existing component", () => {
  const report = traceComponent(mockGraph, "Button");
  assert.equal(report.target, "Button");
  assert.equal(report.issues.length, 2); // hook warning + unused export
});

test("traceComponent reports missing component", () => {
  const report = traceComponent(mockGraph, "NonExistent");
  assert.equal(report.issues.length, 1);
  assert.equal(report.issues[0]!.severity, "critical");
  assert.ok(report.issues[0]!.message.includes("not found"));
});

test("renderTraceReport produces markdown", () => {
  const report = traceComponent(mockGraph, "Button");
  const md = renderTraceReport(report);
  assert.ok(md.includes("Trace Report"));
  assert.ok(md.includes("Button"));
  assert.ok(md.includes("stale-closure"));
});

test("buildPrompt fills template variables", () => {
  const prompt = buildPrompt("bugfix", {
    symptom: "Button does not respond",
    expected: "Click should work",
    actual: "Nothing happens",
  });
  assert.ok(prompt.includes("Button does not respond"));
  assert.ok(prompt.includes("Click should work"));
  assert.ok(prompt.includes("Nothing happens"));
  assert.ok(!prompt.includes("{{"));
});

test("buildPrompt throws on unknown template", () => {
  assert.throws(() => buildPrompt("unknown", {}), /Unknown template/);
});

test("buildPrompt throws on unresolved variables", () => {
  assert.throws(() => buildPrompt("bugfix", { symptom: "test" }), /Unresolved variables/);
});

test("PROMPT_TEMPLATES has expected templates", () => {
  const names = PROMPT_TEMPLATES.map((t) => t.name);
  assert.ok(names.includes("bugfix"));
  assert.ok(names.includes("feature"));
  assert.ok(names.includes("refactor"));
  assert.ok(names.includes("review"));
});

test("saveProposal saves to .aicontext/deliverables/mr/proposals when workspaceRoot is provided", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-proposal-"));
  const workspaceRoot = join(home, "my-workspace");
  const paths = resolvePaths({ HOME: home });

  const savedPath = await saveProposal(paths, "ws-123", {
    title: "Migrate Auth Module",
    context: "Legacy JWT auth needs update",
    problem: "Tokens expire without refresh",
    solution: "Implement refresh token rotation",
    alternatives: ["Session cookies", "OAuth only"],
    risks: ["Token leakage", "Clock skew"],
    estimatedEffort: "M",
  }, workspaceRoot);

  assert.ok(savedPath.startsWith(join(workspaceRoot, ".aicontext", "deliverables", "mr", "proposals")));
  assert.ok(savedPath.endsWith(".md"));

  const content = await readFile(savedPath, "utf8");
  assert.ok(content.includes("Migrate Auth Module"));
  assert.ok(content.includes("Implement refresh token rotation"));
  assert.ok(content.includes("Esfuerzo**: M"));
});
