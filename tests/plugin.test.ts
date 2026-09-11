import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMrOrchestrator } from "../src/plugin.js";
import { resolvePaths } from "../src/core/paths.js";
import { addWorkspace } from "../src/core/workspace.js";
import { loadModels, seedModels } from "../src/core/config.js";
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
    rmSync(home, { recursive: true, force: true });
  };

  return { home, workspaceRoot, paths, profile, mockContext, dummyToolContext, cleanup };
}

void test("MrOrchestrator plugin exports all required tools with argument schemas", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
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
      "mr_memory_save",
      "mr_memory_query",
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
    const candidatesRes = await tools["mr_models"]!.execute({
      action: "candidates",
      role: "orchestrator",
      failedModel: "github-copilot/kimi-k3",
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(candidatesRes.title, "Model Candidates");
    assert.match(candidatesRes.output, /Rol: orchestrator/u);
    assert.doesNotMatch(candidatesRes.output, /^- github-copilot\/kimi-k3$/mu);
    assert.ok(Object.keys(tools["mr_propose_save"]!.args).length >= 5, "mr_propose_save must define arguments");
    assert.ok(Object.keys(tools["mr_prompt_build"]!.args).length >= 2, "mr_prompt_build must define arguments");
  } finally {
    ctx.cleanup();
  }
});

void test("quota exhaustion promotes the role-specific alternative without replaying the session", async () => {
  const ctx = await createPluginContext();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks["chat.params"]);
    assert.ok(hooks.event);
    await hooks["chat.params"]({
      sessionID: "quota-session",
      agent: "orchestrator",
      model: { providerID: "github-copilot", id: "gemini-3.8-flash" },
    } as never, {} as never);
    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "quota-session",
          error: {
            name: "APIError",
            data: { statusCode: 429, responseBody: '{"code":"quota_exceeded"}' },
          },
        },
      },
    } as never);

    const models = await loadModels(ctx.paths);
    assert.equal(models.roles.orchestrator.model, "openai/gpt-5.6-sol");
    assert.equal(models.roles.orchestrator.variant, "high");
    assert.equal(models.roles.orchestrator.alternative.model, "github-copilot/gemini-3.8-flash");
    assert.equal(models.roles.orchestrator.alternative.variant, "high");
    assert.ok(warnings.some((warning) => warning.includes("Fallback activado")));
    assert.ok(warnings.some((warning) => warning.includes("no se repite automáticamente")));
  } finally {
    console.warn = originalWarn;
    ctx.cleanup();
  }
});

void test("SDD tools keep audit timestamps on disk and out of model-facing JSON", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const research = {
      schemaVersion: 1,
      ticketId: "GH-CACHE",
      objective: "Stabilize SDD prompt prefixes",
      evidence: [{ claim: "Capsules are persisted by the SDD tool", file: "src/plugin.ts", line: 909, source: "read" }],
      relevantNodes: ["saveSddArtifact"],
      constraints: ["Do not expose audit timestamps to the model"],
      unknowns: [],
    };

    const submit = await tools["mr_sdd_submit"]!.execute({
      kind: "research",
      payload: JSON.stringify(research),
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(submit.title, "SDD Research Saved");

    const persistedPath = join(ctx.paths.generatedRoot, ctx.profile.id, "sdd", "research.json");
    const persisted = JSON.parse(await readFile(persistedPath, "utf8")) as Record<string, unknown>;
    assert.equal(typeof persisted["createdAt"], "string");

    const loaded = await tools["mr_sdd_get"]!.execute({ kind: "research" }, ctx.dummyToolContext) as {
      title: string;
      output: string;
    };
    assert.equal(loaded.title, "SDD Research");
    const operational = JSON.parse(loaded.output) as Record<string, unknown>;
    assert.deepEqual(operational, research);
    assert.equal("createdAt" in operational, false);
  } finally {
    ctx.cleanup();
  }
});

void test("MrOrchestrator flow tools execute state machine transitions", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
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

    // Implement (Lite flow skips Judgment Day)
    const impRes = await tools["mr_flow_implement"]!.execute({
      completedFiles: ["src/Widget.tsx"],
    }, dummyCtx) as { title: string; output: string };
    assert.equal(impRes.title, "Implementation Complete");
    assert.ok(impRes.output.includes("Lite flow skips Judgment Day"));

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

void test("MrOrchestrator fail-closed CAS: mr_flow_finish aborts if code modified post-approval", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    // Start full difficulty flow (difficulty 5 -> requires judgment)
    await tools["mr_flow_start"]!.execute({ difficulty: 5, ticketId: "SEC-101", hasFigma: false }, dummyCtx);
    await tools["mr_flow_ticket"]!.execute({
      title: "Enforce CAS fail-closed",
      description: "Must abort on mismatch",
      type: "feature",
      platform: "github",
    }, dummyCtx);
    const { runCommand } = await import("../src/core/process.js");
    runCommand("git", ["init", ctx.workspaceRoot]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.email", "test@test.local"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.name", "Tester"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "add", "."]);
    runCommand("git", ["-C", ctx.workspaceRoot, "commit", "-m", "init"]);

    await tools["mr_flow_plan"]!.execute({
      summary: "Add CAS check",
      files: [{ path: "src/secure.ts", action: "create", reason: "Secure CAS", risk: "high" }],
      tests: [],
    }, dummyCtx);

    const impRes = await tools["mr_flow_implement"]!.execute({ completedFiles: ["src/secure.ts"] }, dummyCtx) as { title: string };
    assert.equal(impRes.title, "Judgment Required");

    // Submit verdicts for judges A and B
    const judgeACtx = { ...dummyCtx, agent: "mr-judge-a" };
    const judgeBCtx = { ...dummyCtx, agent: "mr-judge-b" };
    await tools["mr_flow_judge"]!.execute({ judge: "a", approved: true }, judgeACtx);
    const judgeBRes = await tools["mr_flow_judge"]!.execute({ judge: "b", approved: true }, judgeBCtx) as { title: string };
    assert.equal(judgeBRes.title, "Judgment Complete");

    // Mutate file post-approval in workspaceRoot
    const targetFile = join(ctx.workspaceRoot, "src", "secure.ts");
    await mkdir(join(ctx.workspaceRoot, "src"), { recursive: true });
    await writeFile(targetFile, "// Tampered code after approval token issued\n");

    // Attempting finish MUST abort fail-closed with CAS Integrity Violation error
    await assert.rejects(
      () => tools["mr_flow_finish"]!.execute({ commitHash: "hacked" }, dummyCtx),
      /CAS Integrity Violation: Code altered post-approval/
    );
  } finally {
    ctx.cleanup();
  }
});

void test("Pillar 7 Scope Enforcement: mr_flow_implement rejects mutations outside plan.files", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    const { runCommand } = await import("../src/core/process.js");
    runCommand("git", ["init", ctx.workspaceRoot]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.email", "test@test.local"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.name", "Tester"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "add", "."]);
    runCommand("git", ["-C", ctx.workspaceRoot, "commit", "-m", "init"]);

    await tools["mr_flow_start"]!.execute({ difficulty: 3, ticketId: "SEC-SCOPE", hasFigma: false }, dummyCtx);
    await tools["mr_flow_ticket"]!.execute({ title: "Scope test", description: "desc", type: "feature", platform: "github" }, dummyCtx);
    await tools["mr_flow_plan"]!.execute({
      summary: "Plan restricted to allowed.ts",
      files: [{ path: "src/allowed.ts", action: "create", reason: "allowed only" }],
      tests: [],
    }, dummyCtx);

    // Modify an unapproved file in workspace
    await writeFile(join(ctx.workspaceRoot, "src", "unauthorized.ts"), "export const rogue = 1;\n");

    // Completing implementation must fail closed with Scope Boundary Violation
    await assert.rejects(
      () => tools["mr_flow_implement"]!.execute({ completedFiles: ["src/allowed.ts", "src/unauthorized.ts"] }, dummyCtx),
      /Scope Boundary Violation: File 'src\/unauthorized\.ts' was modified but is NOT declared in plan\.files/
    );
  } finally {
    ctx.cleanup();
  }
});

void test("Pillar 7 Bounded Fix Loop: mr_flow_fix aborts after 3 attempts and escalates to human", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    const { runCommand } = await import("../src/core/process.js");
    runCommand("git", ["init", ctx.workspaceRoot]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.email", "test@test.local"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.name", "Tester"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "add", "."]);
    runCommand("git", ["-C", ctx.workspaceRoot, "commit", "-m", "init"]);

    await tools["mr_flow_start"]!.execute({ difficulty: 5, ticketId: "SEC-LOOP", hasFigma: false }, dummyCtx);
    await tools["mr_flow_ticket"]!.execute({ title: "Loop test", description: "desc", type: "bugfix", platform: "github" }, dummyCtx);
    await tools["mr_flow_plan"]!.execute({
      summary: "Bug fix plan",
      files: [{ path: "src/Widget.tsx", action: "modify", reason: "fix bug" }],
      tests: [],
    }, dummyCtx);

    const judgeACtx = { ...dummyCtx, agent: "mr-judge-a" };
    const judgeBCtx = { ...dummyCtx, agent: "mr-judge-b" };

    // Round 1
    await tools["mr_flow_implement"]!.execute({ completedFiles: ["src/Widget.tsx"] }, dummyCtx);
    await tools["mr_flow_judge"]!.execute({ judge: "a", approved: false, critical: ["Bug still present"] }, judgeACtx);
    await tools["mr_flow_judge"]!.execute({ judge: "b", approved: false, critical: ["Bug still present"] }, judgeBCtx);
    await tools["mr_flow_fix"]!.execute({}, dummyCtx);

    // Round 2
    await tools["mr_flow_implement"]!.execute({ completedFiles: ["src/Widget.tsx"] }, dummyCtx);
    await tools["mr_flow_judge"]!.execute({ judge: "a", approved: false, critical: ["Bug still present"] }, judgeACtx);
    await tools["mr_flow_judge"]!.execute({ judge: "b", approved: false, critical: ["Bug still present"] }, judgeBCtx);
    await tools["mr_flow_fix"]!.execute({}, dummyCtx);

    // Round 3 (Attempt 3 rejected by judgment)
    await tools["mr_flow_implement"]!.execute({ completedFiles: ["src/Widget.tsx"] }, dummyCtx);
    await tools["mr_flow_judge"]!.execute({ judge: "a", approved: false, critical: ["Bug still present"] }, judgeACtx);
    await tools["mr_flow_judge"]!.execute({ judge: "b", approved: false, critical: ["Bug still present"] }, judgeBCtx);

    // Calling mr_flow_fix at attempt 3 MUST throw and escalate to human review
    await assert.rejects(
      () => tools["mr_flow_fix"]!.execute({}, dummyCtx),
      /Bounded Fix Ceiling Exceeded: Maximum fix attempts \(3\) reached/
    );
  } finally {
    ctx.cleanup();
  }
});

void test("Pillar 3 Fail-Closed Safety Gate: mr_blueprint_graphql aborts mutations without safetyGateTicket", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    process.env["GITHUB_PERSONAL_ACCESS_TOKEN"] = "mock_token";

    // Mutation without safety ticket must abort fail closed
    await assert.rejects(
      () => tools["mr_blueprint_graphql"]!.execute({
        query: "mutation CreateIssue { createIssue(input: {}) { clientMutationId } }",
      }, dummyCtx),
      /Fail-Closed Safety Gate: GraphQL mutations require a valid 'safetyGateTicket'/
    );
  } finally {
    delete process.env["GITHUB_PERSONAL_ACCESS_TOKEN"];
    ctx.cleanup();
  }
});

void test("MrOrchestrator atlas and trace tools index and inspect codebase", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
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

void test("Pillar 4 Role Segregation: orchestrator or wrong judge cannot submit verdict", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    const { runCommand } = await import("../src/core/process.js");
    runCommand("git", ["init", ctx.workspaceRoot]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.email", "test@test.local"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.name", "Tester"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "add", "."]);
    runCommand("git", ["-C", ctx.workspaceRoot, "commit", "-m", "init"]);

    await tools["mr_flow_start"]!.execute({ difficulty: 5, ticketId: "SEC-ROLES", hasFigma: false }, dummyCtx);
    await tools["mr_flow_ticket"]!.execute({ title: "Role test", description: "desc", type: "feature", platform: "github" }, dummyCtx);
    await tools["mr_flow_plan"]!.execute({
      summary: "Role plan",
      files: [{ path: "src/Widget.tsx", action: "modify", reason: "role test" }],
      tests: [],
    }, dummyCtx);

    await tools["mr_flow_implement"]!.execute({ completedFiles: ["src/Widget.tsx"] }, dummyCtx);

    // Orchestrator or worker trying to vote as Judge A MUST throw Role Segregation Violation
    const orchestratorCtx = { ...dummyCtx, agent: "orchestrator" };
    await assert.rejects(
      () => tools["mr_flow_judge"]!.execute({ judge: "a", approved: true }, orchestratorCtx),
      /Role Segregation Violation: Caller 'orchestrator' is unauthorized to submit verdict for Judge A/
    );

    // Judge B trying to vote as Judge A MUST throw Role Segregation Violation
    const judgeBCtx = { ...dummyCtx, agent: "mr-judge-b" };
    await assert.rejects(
      () => tools["mr_flow_judge"]!.execute({ judge: "a", approved: true }, judgeBCtx),
      /Role Segregation Violation: Caller 'mr-judge-b' is unauthorized to submit verdict for Judge A/
    );

    // Authorized Judge A succeeds
    const judgeACtx = { ...dummyCtx, agent: "mr-judge-a" };
    const resA = await tools["mr_flow_judge"]!.execute({ judge: "a", approved: true }, judgeACtx) as { title: string };
    assert.equal(resA.title, "Verdict Recorded");
  } finally {
    ctx.cleanup();
  }
});

void test("Pillar 6 Structural AST Analysis: mr_flow_implement rejects files with syntax/parse errors", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const dummyCtx = ctx.dummyToolContext;

    const { runCommand } = await import("../src/core/process.js");
    runCommand("git", ["init", ctx.workspaceRoot]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.email", "test@test.local"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "config", "user.name", "Tester"]);
    runCommand("git", ["-C", ctx.workspaceRoot, "add", "."]);
    runCommand("git", ["-C", ctx.workspaceRoot, "commit", "-m", "init"]);

    await tools["mr_flow_start"]!.execute({ difficulty: 3, ticketId: "SEC-AST", hasFigma: false }, dummyCtx);
    await tools["mr_flow_ticket"]!.execute({ title: "AST test", description: "desc", type: "feature", platform: "github" }, dummyCtx);
    await tools["mr_flow_plan"]!.execute({
      summary: "AST syntax check plan",
      files: [{ path: "src/broken.ts", action: "create", reason: "test ast" }],
      tests: [],
    }, dummyCtx);

    // Write a TypeScript file with invalid syntax
    await writeFile(join(ctx.workspaceRoot, "src", "broken.ts"), "const x = ; // syntax error\n");

    // Completing implementation MUST fail closed with Structural AST Validation Failed
    await assert.rejects(
      () => tools["mr_flow_implement"]!.execute({ completedFiles: ["src/broken.ts"] }, dummyCtx),
      /Structural AST Validation Failed: Syntax\/parse error in 'src\/broken\.ts'/
    );
  } finally {
    ctx.cleanup();
  }
});
