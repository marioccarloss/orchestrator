import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MrOrchestrator } from "../src/plugin.js";
import { resolvePaths } from "../src/core/paths.js";
import { addWorkspace } from "../src/core/workspace.js";
import { seedModels } from "../src/core/config.js";
import type { PluginInput, ToolContext } from "@opencode-ai/plugin";

const sourceRoot = process.cwd();

async function createPluginContext() {
  const rawHome = await mkdtemp(join(tmpdir(), "mr-plugin-test-"));
  const home = await realpath(rawHome);
  const workspaceRoot = join(home, "my-repo");
  await mkdir(join(workspaceRoot, ".aicontext"), { recursive: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });

  // Create sample files for Atlas indexing
  await writeFile(join(workspaceRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2023", module: "NodeNext", strict: true },
    include: ["src/**/*"],
  }, null, 2));

  await writeFile(join(workspaceRoot, "src", "helper.ts"), `
export function add(a: number, b: number): number { return a + b; }
`);

  await writeFile(join(workspaceRoot, "src", "Widget.tsx"), `
import { add } from "./helper";
export function Widget() {
  return <div>{add(1, 2)}</div>;
}
`);

  const paths = resolvePaths({ HOME: home });
  await seedModels(paths, sourceRoot);
  const profile = await addWorkspace(paths, workspaceRoot);

  // Set HOME so resolvePaths() inside plugin uses our test sandbox
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;

  const mockContext: PluginInput = {
    client: {} as unknown as PluginInput["client"],
    project: {} as unknown as PluginInput["project"],
    directory: workspaceRoot,
    worktree: workspaceRoot,
    experimental_workspace: { register: (_type, _adapter) => { /* noop */ } },
    serverUrl: new URL("http://localhost"),
    $: {} as unknown as PluginInput["$"],
  };

  const dummyToolContext: ToolContext = {
    sessionID: "test-session",
    messageID: "test-message",
    agent: "orchestrator",
    directory: workspaceRoot,
    worktree: workspaceRoot,
    abort: new AbortController().signal,
    metadata: () => { /* noop */ },
    ask: async () => { /* noop */ },
  };

  const cleanup = () => {
    if (prevHome !== undefined) process.env["HOME"] = prevHome;
  };

  return { home, workspaceRoot, paths, profile, mockContext, dummyToolContext, cleanup };
}

void test("MrOrchestrator plugin exports all required tools with argument schemas", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await MrOrchestrator(ctx.mockContext);
    assert.ok(hooks.tool, "Plugin must define tools");
    const tools = hooks.tool;

    const expectedTools = [
      "mr_flow_status",
      "mr_flow_start",
      "mr_flow_ticket",
      "mr_flow_plan",
      "mr_flow_implement",
      "mr_flow_judge",
      "mr_flow_fix",
      "mr_flow_finish",
      "mr_flow_abort",
      "mr_models",
      "mr_atlas_index",
      "mr_atlas_query",
      "mr_trace_component",
      "mr_propose_save",
      "mr_prompt_build",
      "mr_prompt_copy",
    ];

    for (const toolName of expectedTools) {
      const def = tools[toolName];
      assert.ok(def, `Tool ${toolName} must exist`);
      assert.ok(def.description, `Tool ${toolName} must have description`);
      assert.ok(typeof def.execute === "function", `Tool ${toolName} must have execute function`);
    }

    // Verify schemas are populated for parameterized tools
    assert.ok(Object.keys(tools["mr_flow_start"]!.args).length >= 2, "mr_flow_start must define arguments");
    assert.ok(Object.keys(tools["mr_flow_ticket"]!.args).length >= 2, "mr_flow_ticket must define arguments");
    assert.ok(Object.keys(tools["mr_flow_plan"]!.args).length >= 2, "mr_flow_plan must define arguments");
    assert.ok(Object.keys(tools["mr_flow_judge"]!.args).length >= 2, "mr_flow_judge must define arguments");
    assert.ok(Object.keys(tools["mr_propose_save"]!.args).length >= 5, "mr_propose_save must define arguments");
    assert.ok(Object.keys(tools["mr_prompt_build"]!.args).length >= 2, "mr_prompt_build must define arguments");
  } finally {
    ctx.cleanup();
  }
});

void test("MrOrchestrator flow tools execute state machine transitions", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await MrOrchestrator(ctx.mockContext);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    // Start flow
    const startRes = await tools["mr_flow_start"]!.execute({ difficulty: 3, ticketId: "GH-42", hasFigma: false }, dummyCtx) as { title: string; output: string };
    assert.equal(startRes.title, "Flow Started");
    assert.ok(startRes.output.includes("context") || startRes.output.includes("GH-42"));

    // Status
    const statusRes = await tools["mr_flow_status"]!.execute({}, dummyCtx) as { title: string; output: string };
    assert.equal(statusRes.title, "Flow Status");

    // Ticket
    const ticketRes = await tools["mr_flow_ticket"]!.execute({
      title: "Add awesome button",
      description: "Needs to be awesome",
      type: "feature",
      platform: "github",
    }, dummyCtx) as { title: string; output: string };
    assert.equal(ticketRes.title, "Ticket Loaded");

    // Plan
    const planRes = await tools["mr_flow_plan"]!.execute({
      summary: "Add Widget component",
      files: [{ path: "src/Widget.tsx", action: "create", reason: "New component", risk: "low" }],
      tests: [{ path: "tests/Widget.test.ts", type: "unit", description: "Test rendering" }],
    }, dummyCtx) as { title: string; output: string };
    assert.equal(planRes.title, "Plan Approved");

    // Implement (difficulty 3 -> Lite -> moves to finish)
    const impRes = await tools["mr_flow_implement"]!.execute({
      completedFiles: ["src/Widget.tsx"],
    }, dummyCtx) as { title: string; output: string };
    assert.equal(impRes.title, "Implementation Complete");

    // Finish
    const finRes = await tools["mr_flow_finish"]!.execute({
      commitHash: "abc1234",
      prUrl: "https://github.com/org/repo/pull/1",
    }, dummyCtx) as { title: string; output: string };
    assert.equal(finRes.title, "Flow Complete");

    // State cleared after finish
    const finalStatus = await tools["mr_flow_status"]!.execute({}, dummyCtx) as { title: string; output: string };
    assert.ok(finalStatus.output.includes("No active flow"));
  } finally {
    ctx.cleanup();
  }
});

void test("MrOrchestrator atlas and trace tools index and inspect codebase", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await MrOrchestrator(ctx.mockContext);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    // Index
    const indexRes = await tools["mr_atlas_index"]!.execute({}, dummyCtx) as { title: string; output: string };
    assert.equal(indexRes.title, "Atlas Index");
    assert.ok(indexRes.output.includes("Files indexed"));

    // Query node
    const queryRes = await tools["mr_atlas_query"]!.execute({ nodeName: "Widget" }, dummyCtx) as { title: string; output: string };
    assert.ok(queryRes.output.includes("Widget"));

    // Trace component
    const traceRes = await tools["mr_trace_component"]!.execute({ componentName: "Widget" }, dummyCtx) as { title: string; output: string };
    assert.ok(traceRes.output.includes("Widget"));
    assert.ok(traceRes.output.includes("Trace Report"));
  } finally {
    ctx.cleanup();
  }
});

void test("MrOrchestrator propose and prompt tools function correctly", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await MrOrchestrator(ctx.mockContext);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    // Propose save
    const propRes = await tools["mr_propose_save"]!.execute({
      title: "Add Microfrontend Federation",
      context: "Monolith needs split",
      problem: "Deployments are slow",
      solution: "Module Federation 2.0",
      alternatives: ["Iframe", "Monorepo only"],
      risks: ["Version mismatch"],
      estimatedEffort: "L",
    }, dummyCtx) as { title: string; output: string };

    assert.equal(propRes.title, "Proposal Saved");
    assert.ok(propRes.output.includes(".aicontext/deliverables/mr/proposals"));

    // Prompt build
    const promptRes = await tools["mr_prompt_build"]!.execute({
      template: "bugfix",
      variables: { symptom: "Crash on load", expected: "App loads", actual: "White screen" },
    }, dummyCtx) as { title: string; output: string };

    assert.equal(promptRes.title, "Prompt: bugfix");
    assert.ok(promptRes.output.includes("Crash on load"));
  } finally {
    ctx.cleanup();
  }
});
