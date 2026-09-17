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
import { loadHarnessOverride, logicalModelMap } from "../src/core/harness-models.js";
import { loadEffectiveModels } from "../src/core/models.js";
import { runCommand } from "../src/core/process.js";
import { loadFlowState, saveFlowState } from "../src/core/flow-state.js";
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
  const initialized = runCommand("git", ["-C", workspaceRoot, "init"]);
  const staged = runCommand("git", ["-C", workspaceRoot, "add", "."]);
  const committed = runCommand("git", ["-C", workspaceRoot, "-c", "user.name=Mr Test", "-c", "user.email=mr-test@example.com", "commit", "-m", "fixture"]);
  if (!initialized.ok || !staged.ok || !committed.ok) throw new Error("Could not initialize plugin test git fixture");

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
      "mr_flow_memory_prefetch",
      "mr_flow_plan",
      "mr_flow_implement",
      "mr_flow_judge",
      "mr_flow_fix",
      "mr_flow_finish",
      "mr_flow_abort",
      "mr_models",
      "mr_atlas_index",
      "mr_atlas_profile",
      "mr_atlas_query",
      "mr_trace_component",
      "mr_propose_save",
      "mr_prompt_build",
      "mr_prompt_copy",
      "mr_evidence_add",
      "mr_evidence_list",
      "mr_internal_receipt",
      "mr_context_hydrate",
      "mr_sdd_verify",
      "mr_memory_save",
      "mr_memory_query",
    ];

    const spanishDescription = /[¿¡ñáéíóú]|\b(?:acción|alternativas|archivo|estado|plantilla|problema|riesgos|tarea|texto|título)\b/iu;
    for (const toolName of expectedTools) {
      const def = tools[toolName];
      assert.ok(def, `Tool ${toolName} must exist`);
      assert.ok(def.description, `Tool ${toolName} must have description`);
      assert.doesNotMatch(def.description, spanishDescription, `Tool ${toolName} description must stay in English`);
      for (const [argumentName, schema] of Object.entries(def.args)) {
        const description = (schema as { description?: string }).description;
        if (description !== undefined) {
          assert.doesNotMatch(description, spanishDescription, `Tool ${toolName}.${argumentName} description must stay in English`);
        }
      }
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

void test("internal execution receipts are typed, English-tagged and minified", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    const tool = hooks.tool!["mr_internal_receipt"]!;
    const accepted = await tool.execute({
      payload: JSON.stringify({
        schemaVersion: 1,
        language: "en",
        role: "mr-general",
        status: "COMPLETED",
        summary: "Implemented the bounded task",
        changedFiles: ["src/a.ts"],
        verification: [{ command: "bun test", exitCode: 0 }],
      }),
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(accepted.title, "Internal Receipt");
    assert.doesNotMatch(accepted.output, /\n/u);
    assert.equal(JSON.parse(accepted.output).language, "en");

    const rejected = await tool.execute({
      payload: JSON.stringify({ schemaVersion: 1, language: "es", role: "mr-fix", status: "BLOCKED", summary: "Blocked", blocker: "Missing scope" }),
    }, ctx.dummyToolContext) as { title: string };
    assert.equal(rejected.title, "Internal Receipt Rejected");
  } finally {
    ctx.cleanup();
  }
});

void test("mr_flow_start creates a synthetic local ticket when no external ticket exists", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    const started = await hooks.tool!["mr_flow_start"]!.execute({
      difficulty: 1,
      taskText: "Fix the broken login redirect",
      hasFigma: false,
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(started.title, "Flow Started");
    const state = await loadFlowState(ctx.paths, ctx.profile.id);
    assert.equal(state?.phase, "explore");
    if (state?.phase !== "explore") throw new Error("Expected explore state");
    assert.match(state.ticket.ref.id, /^LOCAL-\d{8}-01$/u);
    assert.equal(state.ticket.ref.platform, "local");
    assert.equal(state.ticket.source, "user");
    assert.equal(state.ticket.type, "bugfix");
    assert.equal(state.ticket.description, "Fix the broken login redirect");
    assert.equal(state.userLanguage, "en");
    assert.match(started.output, /LOCAL-/u);
    await hooks.tool!["mr_flow_plan"]!.execute({
      summary: "Fix auth redirect",
      files: [{ path: "src/Auth/Login.ts", action: "create", reason: "Implement the local task", risk: "high" }],
      tests: [],
    }, ctx.dummyToolContext);
    const planned = await loadFlowState(ctx.paths, ctx.profile.id);
    assert.equal(planned?.phase, "implement");
    assert.equal(planned?.lane, "critical");
    assert.ok(planned?.riskReasons?.some((reason) => reason.includes("auth")));
  } finally {
    ctx.cleanup();
  }
});

void test("critical flows require explicit human review before finish", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    await saveFlowState(ctx.paths, ctx.profile.id, {
      phase: "finish",
      schemaVersion: 1,
      workspaceId: ctx.profile.id,
      startedAt: new Date().toISOString(),
      difficulty: 1,
      lane: "critical",
      riskReasons: ["critical areas: auth"],
      ticket: {
        schemaVersion: 1,
        ref: { schemaVersion: 1, platform: "local", id: "LOCAL-20260913-01" },
        title: "Change auth",
        description: "Change auth",
        type: "feature",
        attachments: [],
        fetchedAt: new Date().toISOString(),
        source: "user",
      },
      branch: "feature/local-20260913-01",
      baseBranch: "develop",
      plan: {
        schemaVersion: 1,
        ticket: { schemaVersion: 1, platform: "local", id: "LOCAL-20260913-01" },
        summary: "Change auth",
        files: [{ path: "src/Auth.ts", action: "modify", reason: "Change auth", risk: "high" }],
        tests: [],
        verification: { typecheck: true, lint: true, test: true, build: false },
        createdAt: new Date().toISOString(),
      },
    });
    const rejected = await hooks.tool!["mr_flow_finish"]!.execute({}, ctx.dummyToolContext) as { title: string };
    assert.equal(rejected.title, "Human Review Required");
    const completed = await hooks.tool!["mr_flow_finish"]!.execute({ humanApproved: true }, ctx.dummyToolContext) as { title: string };
    assert.equal(completed.title, "Flow Complete");
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
      model: { providerID: "github-copilot", id: "kimi-k3" },
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

    const globalModels = await loadModels(ctx.paths);
    assert.equal(globalModels.roles.orchestrator.model, "github-copilot/kimi-k3");
    const override = await loadHarnessOverride(ctx.paths, "opencode");
    assert.equal(override?.roles.orchestrator?.primary?.model, "github-copilot/gemini-3.8-flash");
    const models = logicalModelMap(await loadEffectiveModels(ctx.paths, "opencode"));
    assert.equal(models.roles.orchestrator.model, "github-copilot/gemini-3.8-flash");
    assert.equal(models.roles.orchestrator.variant, "high");
    assert.equal(models.roles.orchestrator.alternative.model, "github-copilot/kimi-k3");
    assert.equal(models.roles.orchestrator.alternative.variant, "high");
    assert.ok(warnings.some((warning) => warning.includes("Fallback activado")));
    assert.ok(warnings.some((warning) => warning.includes("no se repite automáticamente")));
  } finally {
    console.warn = originalWarn;
    ctx.cleanup();
  }
});

void test("Flow status tracks order-style progress and provider-reported usage across child sessions", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    assert.ok(hooks.event);
    const tools = hooks.tool;
    await tools["mr_flow_start"]!.execute({ difficulty: 5, ticketId: "GH-USAGE", hasFigma: false }, ctx.dummyToolContext);

    const assistantMessage = {
      id: "message-root",
      sessionID: "test-session",
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      parentID: "user-message",
      modelID: "gpt-5.6-sol",
      providerID: "openai",
      mode: "orchestrator",
      path: { cwd: ctx.workspaceRoot, root: ctx.workspaceRoot },
      cost: 0.01,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 40, write: 0 } },
    };
    await hooks.event({ event: { type: "message.updated", properties: { info: assistantMessage } } } as never);
    await hooks.event({ event: { type: "message.updated", properties: { info: { ...assistantMessage, cost: 0.012, tokens: { ...assistantMessage.tokens, output: 25 } } } } } as never);
    await hooks.event({ event: { type: "session.created", properties: { info: { id: "child-session", parentID: "test-session" } } } } as never);
    await hooks.event({ event: { type: "message.updated", properties: { info: {
      ...assistantMessage,
      id: "message-child",
      sessionID: "child-session",
      cost: 0.02,
      tokens: { input: 80, output: 10, reasoning: 0, cache: { read: 10, write: 2 } },
    } } } } as never);

    await tools["mr_flow_ticket"]!.execute({ title: "Track Flow usage", description: "Show progress and spend" }, ctx.dummyToolContext);
    const status = await tools["mr_flow_status"]!.execute({}, ctx.dummyToolContext) as { output: string };
    assert.match(status.output, /✓ Ticket {2}→ {2}● Research/u);
    assert.match(status.output, /\$0\.0320 USD/u);
    assert.match(status.output, /180\/35\/5/u);
    assert.match(status.output, /2 sessions/u);
  } finally {
    ctx.cleanup();
  }
});

void test("Flow status remains available through MCP facades that omit ToolContext", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    await hooks.tool["mr_flow_start"]!.execute({ difficulty: 3, ticketId: "GH-MCP", hasFigma: false }, undefined as never);
    const status = await hooks.tool["mr_flow_status"]!.execute({}, undefined as never) as { output: string };
    assert.match(status.output, /Coste estimado por OpenCode/u);
    assert.match(status.output, /1 sesiones/u);
  } finally {
    ctx.cleanup();
  }
});

void test("SDD tools keep audit timestamps on disk and out of model-facing JSON", async () => {
  const ctx = await createPluginContext();
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    const blocked = await tools["mr_sdd_submit"]!.execute({
      kind: "research",
      payload: JSON.stringify({
        status: "INSUFFICIENT_EVIDENCE",
        missing: ["source defining the requested behavior"],
        nextAction: "inspect the defining symbol",
      }),
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(blocked.title, "SDD research Blocked");
    assert.ok(blocked.output.includes("INSUFFICIENT_EVIDENCE"));

    const research = {
      schemaVersion: 1,
      ticketId: "GH-CACHE",
      objective: "Stabilize SDD prompt prefixes",
      evidence: [{ claim: "Helper is indexed by the SDD tool", file: "src/helper.ts", line: 1, source: "read" }],
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
    assert.equal(operational["schemaVersion"], 2);
    assert.equal(operational["ticketId"], research.ticketId);
    assert.ok(Array.isArray(operational["evidenceRefs"]));
    assert.equal((operational["evidenceRefs"] as unknown[]).length, 1);
    assert.equal("createdAt" in operational, false);

    const needsInput = await tools["mr_sdd_submit"]!.execute({
      kind: "brief",
      payload: JSON.stringify({
        schemaVersion: 1,
        ticketId: "GH-CACHE",
        status: "NEEDS_INPUT",
        questions: [{
          id: "Q1",
          question: "Must existing clients remain compatible?",
          reason: "The answer changes the public contract",
          risk: "high",
          options: ["yes", "no"],
        }],
      }),
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(needsInput.title, "SDD Planning Input Required");
    assert.equal(JSON.parse(needsInput.output).status, "NEEDS_INPUT");

    const readyBrief = {
      schemaVersion: 1,
      ticketId: "GH-CACHE",
      status: "READY",
      mode: "guided",
      decisions: [{ questionId: "Q1", decision: "Preserve existing clients", source: "user" }],
      assumptions: [],
    };
    const briefSubmit = await tools["mr_sdd_submit"]!.execute({
      kind: "brief",
      payload: JSON.stringify(readyBrief),
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(briefSubmit.title, "SDD Planning Brief Saved");
    assert.doesNotMatch(briefSubmit.output, /\.md/u);

    const loadedBrief = await tools["mr_sdd_get"]!.execute({ kind: "brief" }, ctx.dummyToolContext) as {
      title: string;
      output: string;
    };
    assert.equal(loadedBrief.title, "SDD Planning Brief");
    assert.deepEqual(JSON.parse(loadedBrief.output), readyBrief);

    await tools["mr_sdd_submit"]!.execute({
      kind: "brief",
      payload: needsInput.output,
    }, ctx.dummyToolContext);
    const clearedBrief = await tools["mr_sdd_get"]!.execute({ kind: "brief" }, ctx.dummyToolContext) as { output: string };
    assert.equal(clearedBrief.output, "No planning brief found.");
  } finally {
    ctx.cleanup();
  }
});

void test("active Flow planning requires a READY Blueprint-lite brief before the spec", async () => {
  const ctx = await createPluginContext();
  const previousGateMode = process.env["MR_GATES_MODE"];
  try {
    const hooks = await createMrOrchestrator(ctx.mockContext, ctx.paths);
    assert.ok(hooks.tool);
    const tools = hooks.tool;
    await tools["mr_flow_start"]!.execute({ difficulty: 3, ticketId: "GH-BRIEF", hasFigma: false }, ctx.dummyToolContext);
    await tools["mr_flow_ticket"]!.execute({
      title: "Require planning brief",
      description: "Exercise the adaptive planning gate",
      platform: "github",
    }, ctx.dummyToolContext);

    const evidenceResult = await tools["mr_evidence_add"]!.execute({
      file: "src/helper.ts",
      startLine: 1,
      endLine: 2,
      kind: "behavior",
      source: "read",
      claim: "The helper is the bounded fixture used by this planning task",
      supports: ["R1"],
      symbol: "add",
    }, ctx.dummyToolContext) as { output: string };
    const evidenceId = (JSON.parse(evidenceResult.output) as { id: string }).id;
    const researchResult = await tools["mr_sdd_submit"]!.execute({
      kind: "research",
      payload: JSON.stringify({
        schemaVersion: 2,
        ticketId: "GH-BRIEF",
        objective: "Ground the planning task",
        evidenceRefs: [evidenceId],
        coverage: { fresh: true, unsupportedFiles: [], unresolvedImports: [] },
        contracts: [],
        tests: [],
        relevantNodes: ["add"],
        constraints: [],
        unknowns: [],
      }),
    }, ctx.dummyToolContext) as { title: string };
    assert.equal(researchResult.title, "SDD Research Saved");

    const spec = {
      schemaVersion: 1,
      ticketId: "GH-BRIEF",
      goal: "Require an assessed planning brief",
      scopeIn: ["Flow planning"],
      scopeOut: [],
      requirements: [{
        id: "R1",
        statement: "Planning must be assessed before specification",
        acceptance: [{ when: "a Flow submits a spec", then: "a READY brief already exists" }],
      }],
      risks: [],
    };
    const rejected = await tools["mr_sdd_submit"]!.execute({ kind: "spec", payload: JSON.stringify(spec) }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(rejected.title, "SDD Spec Rejected");
    assert.match(rejected.output, /No READY planning brief/u);

    await tools["mr_sdd_submit"]!.execute({
      kind: "brief",
      payload: JSON.stringify({
        schemaVersion: 1,
        ticketId: "GH-BRIEF",
        status: "READY",
        mode: "auto",
        decisions: [],
        assumptions: [],
      }),
    }, ctx.dummyToolContext);
    const accepted = await tools["mr_sdd_submit"]!.execute({ kind: "spec", payload: JSON.stringify(spec) }, ctx.dummyToolContext) as { title: string };
    assert.equal(accepted.title, "SDD Spec Saved");

    await tools["mr_sdd_submit"]!.execute({
      kind: "tasks",
      payload: JSON.stringify({
        schemaVersion: 1,
        ticketId: "GH-BRIEF",
        tasks: [{
          id: "T1",
          title: "Enforce planning gate",
          dependsOn: [],
          requirements: ["R1"],
          files: [{ path: "src/helper.ts", action: "modify", reason: "Reject specs without briefs", risk: "medium" }],
          verify: ["bun test tests/plugin.test.ts"],
          doneWhen: ["Specs require a READY brief"],
          status: "pending",
        }],
      }),
    }, ctx.dummyToolContext);
    const nextTask = await tools["mr_sdd_get"]!.execute({ kind: "next-task" }, ctx.dummyToolContext) as { output: string };
    const nextPayload = JSON.parse(nextTask.output) as {
      developerNote: { what: string; why: string; touch: string; prove: string };
      bundle: { budget: { requestedChars: number; usedChars: number } };
      economy: { sessionMode: string; judges: boolean };
    };
    assert.deepEqual(nextPayload.developerNote, {
      what: "Enforce planning gate",
      why: "Planning must be assessed before specification",
      touch: "src/helper.ts",
      prove: "bun test tests/plugin.test.ts",
    });
    assert.equal(nextPayload.bundle.budget.requestedChars, 45_000);
    assert.ok(nextPayload.bundle.budget.usedChars > 0);
    assert.doesNotMatch(nextTask.output, /\n/u);
    assert.equal(nextPayload.economy.sessionMode, "staged");
    assert.equal(nextPayload.economy.judges, false);
    const budgetStatus = await tools["mr_flow_status"]!.execute({}, ctx.dummyToolContext) as { output: string };
    assert.match(budgetStatus.output, /Hydrated context \(implement\/standard\).*\/45000 chars/u);

    const startedTask = await tools["mr_sdd_task_status"]!.execute({ taskId: "T1", status: "in_progress" }, ctx.dummyToolContext) as { title: string };
    assert.equal(startedTask.title, "SDD Task Status");
    const missingReceipt = await tools["mr_sdd_task_status"]!.execute({ taskId: "T1", status: "done" }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(missingReceipt.title, "SDD Task Status Rejected");
    assert.match(missingReceipt.output, /VERIFICATION_RECEIPT_MISSING/u);

    const originalWidget = await readFile(join(ctx.workspaceRoot, "src", "Widget.tsx"), "utf8");
    await writeFile(join(ctx.workspaceRoot, "src", "Widget.tsx"), `${originalWidget}\n// unauthorized task edit\n`);
    process.env["MR_GATES_MODE"] = "block";
    const outsideBoundary = await tools["mr_sdd_verify"]!.execute({
      taskId: "T1",
      results: [{ command: "bun test tests/plugin.test.ts", exitCode: 0, durationMs: 10, outputTail: "pass" }],
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(outsideBoundary.title, "SDD Verification Rejected");
    assert.match(outsideBoundary.output, /DIFF_OUTSIDE_BOUNDARY/u);
    await writeFile(join(ctx.workspaceRoot, "src", "Widget.tsx"), originalWidget);

    const verified = await tools["mr_sdd_verify"]!.execute({
      taskId: "T1",
      results: [{ command: "bun test tests/plugin.test.ts", exitCode: 0, durationMs: 10, outputTail: "pass" }],
    }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(verified.title, "SDD Verification Recorded", verified.output);
    await writeFile(join(ctx.workspaceRoot, "src", "Widget.tsx"), `${originalWidget}\n// changed after receipt\n`);
    const outsideDone = await tools["mr_sdd_task_status"]!.execute({ taskId: "T1", status: "done" }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(outsideDone.title, "SDD Task Status Rejected");
    assert.match(outsideDone.output, /DIFF_OUTSIDE_BOUNDARY/u);
    await writeFile(join(ctx.workspaceRoot, "src", "Widget.tsx"), originalWidget);
    const completedTask = await tools["mr_sdd_task_status"]!.execute({ taskId: "T1", status: "done" }, ctx.dummyToolContext) as { title: string; output: string };
    assert.equal(completedTask.title, "SDD Task Status");
    assert.match(completedTask.output, /T1 → done/u);
  } finally {
    if (previousGateMode === undefined) delete process.env["MR_GATES_MODE"];
    else process.env["MR_GATES_MODE"] = previousGateMode;
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
    assert.ok(impRes.output.includes("fast lane skips Judgment Day"));

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
    const judgeResults = await Promise.all([
      tools["mr_flow_judge"]!.execute({ judge: "a", status: "SUPPORTED", approved: true, findings: [] }, judgeACtx),
      tools["mr_flow_judge"]!.execute({ judge: "b", status: "SUPPORTED", approved: true, findings: [] }, judgeBCtx),
    ]) as { title: string }[];
    assert.deepEqual(new Set(judgeResults.map((result) => result.title)), new Set(["Verdict Recorded", "Judgment Complete"]));

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
    await writeFile(join(ctx.workspaceRoot, "src", "Widget.tsx"), "export const bug = true;\n");
    const findings = [{
      severity: "critical" as const,
      claim: "Bug still present",
      file: "src/Widget.tsx",
      line: 1,
      side: "new" as const,
      source: "diff" as const,
      evidence: "export const bug = true;",
    }];

    // Round 1
    await tools["mr_flow_implement"]!.execute({ completedFiles: ["src/Widget.tsx"] }, dummyCtx);
    await tools["mr_atlas_index"]!.execute({}, dummyCtx);
    await tools["mr_flow_judge"]!.execute({ judge: "a", status: "SUPPORTED", approved: false, findings }, judgeACtx);
    await tools["mr_flow_judge"]!.execute({ judge: "b", status: "SUPPORTED", approved: false, findings }, judgeBCtx);
    await tools["mr_flow_fix"]!.execute({}, dummyCtx);

    // Round 2
    await tools["mr_flow_implement"]!.execute({ completedFiles: ["src/Widget.tsx"] }, dummyCtx);
    await tools["mr_atlas_index"]!.execute({}, dummyCtx);
    await tools["mr_flow_judge"]!.execute({ judge: "a", status: "SUPPORTED", approved: false, findings }, judgeACtx);
    await tools["mr_flow_judge"]!.execute({ judge: "b", status: "SUPPORTED", approved: false, findings }, judgeBCtx);
    await tools["mr_flow_fix"]!.execute({}, dummyCtx);

    // Round 3 (Attempt 3 rejected by judgment)
    await tools["mr_flow_implement"]!.execute({ completedFiles: ["src/Widget.tsx"] }, dummyCtx);
    await tools["mr_atlas_index"]!.execute({}, dummyCtx);
    await tools["mr_flow_judge"]!.execute({ judge: "a", status: "SUPPORTED", approved: false, findings }, judgeACtx);
    await tools["mr_flow_judge"]!.execute({ judge: "b", status: "SUPPORTED", approved: false, findings }, judgeBCtx);

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

    // Bounded Language Service lookup persists resolved caller edges.
    const semanticRes = await tools["mr_atlas_query"]!.execute({ nodeName: "add", action: "semantic", depth: 1 }, dummyCtx) as { title: string; output: string };
    assert.equal(semanticRes.title, "Semantic: add");
    assert.ok(semanticRes.output.includes('"type":"calls"'));
    const dependentsRes = await tools["mr_atlas_query"]!.execute({ nodeName: "add", action: "dependents" }, dummyCtx) as { output: string };
    assert.ok(dependentsRes.output.includes("Widget"));

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
      () => tools["mr_flow_judge"]!.execute({ judge: "a", status: "SUPPORTED", approved: true, findings: [] }, orchestratorCtx),
      /Role Segregation Violation: Caller 'orchestrator' is unauthorized to submit verdict for Judge A/
    );

    // Judge B trying to vote as Judge A MUST throw Role Segregation Violation
    const judgeBCtx = { ...dummyCtx, agent: "mr-judge-b" };
    await assert.rejects(
      () => tools["mr_flow_judge"]!.execute({ judge: "a", status: "SUPPORTED", approved: true, findings: [] }, judgeBCtx),
      /Role Segregation Violation: Caller 'mr-judge-b' is unauthorized to submit verdict for Judge A/
    );

    // Authorized Judge A succeeds
    const judgeACtx = { ...dummyCtx, agent: "mr-judge-a" };
    const blocked = await tools["mr_flow_judge"]!.execute({
      judge: "a",
      status: "INSUFFICIENT_EVIDENCE",
      approved: false,
      findings: [],
      missing: ["current runtime trace"],
      nextAction: "collect the trace",
    }, judgeACtx) as { title: string };
    assert.equal(blocked.title, "Judgment Blocked");

    const unsupported = await tools["mr_flow_judge"]!.execute({
      judge: "a",
      status: "SUPPORTED",
      approved: false,
      findings: [{
        severity: "critical",
        claim: "Invented issue",
        file: "src/missing.ts",
        line: 99,
        side: "new",
        source: "diff",
        evidence: "invented",
      }],
    }, judgeACtx) as { title: string; output: string };
    assert.equal(unsupported.title, "Judgment Rejected");
    assert.ok(unsupported.output.includes("not a visible new-side diff line"));

    const resA = await tools["mr_flow_judge"]!.execute({ judge: "a", status: "SUPPORTED", approved: true, findings: [] }, judgeACtx) as { title: string };
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
