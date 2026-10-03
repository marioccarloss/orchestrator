import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ToolContext } from "@opencode-ai/plugin";
import type { DecisionEngine, DecisionEngineResult, DecisionQuestion } from "../src/core/decision.js";
import { sha256 } from "../src/core/files.js";
import { resolvePaths } from "../src/core/paths.js";
import {
  ExecutionPlanSchema,
  MAX_VERIFY_FAILURES,
  newTaskId,
  transitionTask,
  type TaskState,
} from "../src/core/task/schema.js";
import {
  acceptAnswers,
  applyTaskFloors,
  collectTaskSignals,
  decideIntake,
  heuristicStrategy,
  jevRunner,
  resolveAskLadder,
  type JevRunner,
} from "../src/core/task/decide.js";
import { captureToolEvent, isMustKeep, recallEntries, redactSecrets, type JournalEntry } from "../src/core/task/journal.js";
import { buildHandoff } from "../src/core/task/handoff.js";
import { applyDeterministicSteps, validateExecutionPlan } from "../src/core/task/plan.js";
import { floorCommands, parseVerificationCommand, type VerificationTools } from "../src/core/task/verify.js";
import { createTaskTools } from "../src/task-tools.js";

const NO_TOOLS: VerificationTools = { packageManager: "bun", allScripts: [], scripts: {}, eslint: false, prettier: false };
const FULL_TOOLS: VerificationTools = {
  packageManager: "bun",
  allScripts: ["lint", "typecheck", "test"],
  scripts: { lint: "lint", typecheck: "typecheck", test: "test" },
  eslint: true,
  prettier: false,
};

function baseState(overrides: Partial<TaskState> = {}): TaskState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id: newTaskId(new Date("2026-10-03T10:00:00Z"), () => 0.5),
    workspaceId: "ws",
    phase: "explore",
    startedAt: now,
    updatedAt: now,
    input: { kind: "oneliner", text: "change the banner flag", attachments: [] },
    contextStrategy: { graph: "skip", engram: "skip", rules: "skip", read: "targeted", verify: "format-lint", size: "small", sources: {}, floors: [] },
    classification: { strategy: "tweak", difficulty: 1, source: "heuristic" },
    baselineDirtyFiles: [],
    appliedSteps: [],
    verifyFailures: 0,
    humanQuestionsAsked: 0,
    jevQuestionsAsked: 0,
    ...overrides,
  };
}

function fakeJev(answer: (questions: readonly DecisionQuestion[]) => DecisionEngineResult["answers"]): JevRunner {
  return {
    available: true,
    evaluate: async (_state, questions) => Promise.resolve({ provider: "test", model: "jev", answers: answer(questions), usage: {}, warnings: [] }),
  };
}

const UNAVAILABLE: JevRunner = jevRunner(undefined, false, { maxRetries: 0, timeoutMs: 1_000 });

// ─── FSM ─────────────────────────────────────────────────────────────────────

void test("task FSM follows explore → plan → apply → verify → done and rejects skips", () => {
  const explored = transitionTask(baseState(), { type: "explore_submitted", reportHash: "a".repeat(64), classification: { strategy: "tweak", difficulty: 1, source: "jev" } });
  assert.equal(explored.phase, "plan");
  assert.throws(() => transitionTask(explored, { type: "apply_complete" }), /Invalid \/task transition/u);
  const applying = transitionTask(explored, { type: "plan_accepted", planHash: "b".repeat(64), classification: explored.classification });
  const stepped = transitionTask(transitionTask(applying, { type: "step_applied", stepId: "S1" }), { type: "step_applied", stepId: "S1" });
  assert.deepEqual(stepped.appliedSteps, ["S1"], "step_applied is idempotent");
  const verifying = transitionTask(stepped, { type: "apply_complete" });
  const result = { ok: false, receipts: [], outOfPlanFiles: [], at: new Date().toISOString() };
  let failed = transitionTask(verifying, { type: "verify_failed", result });
  assert.equal(failed.phase, "apply");
  failed = transitionTask(transitionTask(failed, { type: "apply_complete" }), { type: "verify_failed", result });
  assert.equal(failed.verifyFailures, MAX_VERIFY_FAILURES);
  assert.equal(failed.phase, "plan", "repeated verification failure returns to the planner");
});

// ─── Intake decisions ────────────────────────────────────────────────────────

void test("heuristics: one-line tweak on an existing file skips explore; floors protect bugfixes", async () => {
  const tweak = collectTaskSignals({ kind: "oneliner", text: "cambia showBanner a false en src/home.ts", attachments: [] }, {
    fileExists: (file) => file === "src/home.ts",
    tools: FULL_TOOLS,
  });
  assert.deepEqual(tweak.mentionedFiles, ["src/home.ts"]);
  assert.equal(heuristicStrategy(tweak), "tweak");
  const intake = await decideIntake({ kind: "oneliner", text: "cambia showBanner a false en src/home.ts", attachments: [] }, tweak, UNAVAILABLE);
  assert.equal(intake.contextStrategy.read, "none");
  assert.equal(intake.contextStrategy.graph, "skip");
  assert.equal(intake.jev.used, false);

  const bug = collectTaskSignals({ kind: "prompt", text: "el login falla con error 500 en el checkout", attachments: [] }, { fileExists: () => false, tools: FULL_TOOLS });
  const bugIntake = await decideIntake({ kind: "prompt", text: "el login falla con error 500 en el checkout", attachments: [] }, bug, fakeJev(() => ({
    strategy: { type: "choice", choice: "bugfix", probabilities: { bugfix: 0.95 } },
    read: { type: "choice", choice: "none", probabilities: { none: 0.99 } },
    verify: { type: "choice", choice: "format-lint", probabilities: { "format-lint": 0.99 } },
  })));
  assert.equal(bugIntake.classification.strategy, "bugfix");
  assert.equal(bugIntake.contextStrategy.read, "targeted", "Jev cannot lower the bugfix read floor");
  assert.equal(bugIntake.contextStrategy.verify, "tests", "Jev cannot lower the bugfix verification floor");
  assert.equal(bugIntake.contextStrategy.sources["verify"], "floor");
});

void test("critical areas recommend /flow without forcing it", async () => {
  const signals = collectTaskSignals({ kind: "prompt", text: "add a new payment method to the checkout", attachments: [] }, { fileExists: () => false, tools: NO_TOOLS });
  const intake = await decideIntake({ kind: "prompt", text: "add a new payment method to the checkout", attachments: [] }, signals, UNAVAILABLE);
  assert.equal(intake.escalation?.recommend, "flow");
  assert.match(intake.escalation?.reasons.join(" ") ?? "", /payment/u);
});

void test("Jev answers below the acceptance threshold fall back to heuristics", () => {
  const questions: DecisionQuestion[] = [{ id: "read", type: "choice", instructions: "x", criteria: { none: "a", broad: "b" } }];
  const low = acceptAnswers({ provider: "t", model: "m", answers: { read: { type: "choice", choice: "broad", probabilities: { broad: 0.6 } } }, usage: {}, warnings: [] }, questions);
  assert.deepEqual(low.choices, {});
  const high = acceptAnswers({ provider: "t", model: "m", answers: { read: { type: "choice", choice: "broad", probabilities: { broad: 0.8 } } }, usage: {}, warnings: [] }, questions);
  assert.equal(high.choices["read"]?.value, "broad");
});

void test("floors force rules when blocking rules cover a mentioned path", () => {
  const signals = { ...collectTaskSignals({ kind: "oneliner", text: "x", attachments: [] }, { fileExists: () => false, tools: NO_TOOLS }), blockRules: ["R1"] };
  const floored = applyTaskFloors(baseState().contextStrategy, { strategy: "tweak", difficulty: 1, source: "heuristic" }, signals);
  assert.equal(floored.rules, "applicable");
  assert.ok(floored.floors.some((floor) => floor.includes("R1")));
});

void test("ask ladder: Jev resolves confident questions, high impact goes to the human, the rest take defaults", async () => {
  const jev = fakeJev(() => ({
    color: { type: "choice", choice: "red", probabilities: { red: 0.95 } },
    migrate: { type: "choice", choice: "yes", probabilities: { yes: 0.55 } },
    copy: { type: "choice", choice: "b", probabilities: { b: 0.5 } },
  }));
  const { resolutions } = await resolveAskLadder([
    { id: "color", question: "Which color?", options: { red: "r", blue: "b" }, impact: "low", defaultOption: "blue" },
    { id: "migrate", question: "Migrate data?", options: { yes: "y", no: "n" }, impact: "high", defaultOption: "no" },
    { id: "copy", question: "Which copy?", options: { a: "a", b: "b" }, impact: "medium", defaultOption: "a" },
  ], "ctx", jev, 1);
  assert.deepEqual(resolutions.map((resolution) => [resolution.id, resolution.resolution, resolution.value]), [
    ["color", "jev", "red"],
    ["migrate", "human", undefined],
    ["copy", "default", "a"],
  ]);
});

// ─── Relay journal ───────────────────────────────────────────────────────────

void test("relay maps harness tools to typed journal entries and redacts secrets", () => {
  const read = captureToolEvent({ tool: "read", args: { filePath: "/repo/src/a.ts", offset: 10, limit: 5 }, output: "x" }, "/repo", () => "f".repeat(64));
  assert.deepEqual([read?.kind, read?.file, read?.range, read?.fileSha], ["read", "src/a.ts", [10, 14], "f".repeat(64)]);
  const bash = captureToolEvent({ tool: "bash", args: { command: "bun test" }, output: "1 failed", metadata: { exit: 1 } }, "/repo");
  assert.equal(bash?.failed, true);
  assert.equal(captureToolEvent({ tool: "mr_task_record", args: {}, output: "" }, "/repo"), undefined);
  assert.match(redactSecrets("token=abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz"), /^\[REDACTED\] and \[REDACTED\]$/u);
  const entry = (kind: JournalEntry["kind"], failed?: boolean): JournalEntry => ({ id: "J1", at: new Date().toISOString(), kind, summary: "s", ...(failed === undefined ? {} : { failed }) });
  assert.equal(isMustKeep(entry("discard")), true);
  assert.equal(isMustKeep(entry("command", true)), true);
  assert.equal(isMustKeep(entry("command", false)), false);
  assert.equal(isMustKeep(entry("read")), false);
});

void test("handoff keeps must-keep entries over budget, defers Jev-dropped entries to the manifest, and recall flags stale reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-task-handoff-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    const at = new Date().toISOString();
    const journal: JournalEntry[] = [
      { id: "J1", at, kind: "input", summary: "change a" },
      { id: "J2", at, kind: "discard", summary: "b is unrelated" },
      { id: "J3", at, kind: "read", summary: "read src/a.ts:1-2", file: "src/a.ts", range: [1, 2], fileSha: "0".repeat(64) },
      { id: "J4", at, kind: "search", summary: "grep foo → 0 line(s)" },
    ];
    const jev = fakeJev((questions) => Object.fromEntries(questions.map((question) => [question.id, { type: "boolean" as const, probability: question.id === "J4" ? 0.05 : 0.9 }])));
    const bundle = await buildHandoff({ role: "plan", state: baseState({ phase: "plan" }), journal, workspaceRoot: root, jev, budgetChars: 100 });
    assert.deepEqual(bundle.mustKeep.map((item) => item.id), ["J1", "J2"], "must-keep survives a tiny budget");
    assert.ok(bundle.manifest.some((item) => item.id === "J4"), "dropped entries stay recoverable");
    assert.equal(bundle.selection.by, "jev");
    const recalled = await recallEntries(journal, ["J3"], root);
    assert.equal(recalled[0]?.stale, true);
    assert.match(recalled[0]?.content ?? "", /1: export const a = 1;/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ─── Plan validation and deterministic apply ────────────────────────────────

void test("plan validation rejects missing, ambiguous and unsafe anchors and disallowed commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-task-plan-"));
  try {
    await writeFile(join(root, "a.ts"), "const x = 1;\nconst x2 = 1;\n");
    const plan = ExecutionPlanSchema.parse({
      summary: "s", strategy: "tweak", difficulty: 1,
      steps: [
        { id: "S1", file: "a.ts", op: "replace", anchor: { snippet: "= 1;" }, code: "= 2;" },
        { id: "S2", file: "a.ts", op: "replace", anchor: { snippet: "missing" }, code: "y" },
        { id: "S3", file: "../etc/passwd", op: "replace", anchor: { snippet: "x" }, code: "y" },
        { id: "S4", file: ".env", op: "create", code: "SECRET=1" },
        { id: "S5", file: "a.ts", op: "replace", code: "y" },
      ],
      verification: ["bun run typecheck; rm -rf /", "npx some-random-package"],
    });
    const codes = (await validateExecutionPlan(plan, root, new Set(["typecheck"]))).map((issue) => `${issue.step ?? "-"}:${issue.code}`);
    assert.deepEqual(codes, [
      "S1:anchor-ambiguous",
      "S2:anchor-not-found",
      "S3:unsafe-path",
      "S4:unsafe-path",
      "S5:missing-anchor",
      "-:verification-command",
      "-:verification-command",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("deterministic steps apply without a model; intent steps wait for mr-task-apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-task-apply-"));
  try {
    await writeFile(join(root, "a.ts"), "export const enabled = true;\n");
    const plan = ExecutionPlanSchema.parse({
      summary: "s", strategy: "replicate", difficulty: 2,
      steps: [
        { id: "S1", file: "a.ts", op: "replace", anchor: { snippet: "enabled = true", fileSha: sha256("export const enabled = true;\n") }, code: "enabled = false" },
        { id: "S2", file: "b.ts", op: "create", intent: "Create a banner component mirroring the reference component" },
        { id: "S3", file: "a.ts", op: "insertAfter", anchor: { snippet: "enabled = false;" }, code: "\nexport const banner = true;", dependsOn: ["S2"] },
      ],
    });
    assert.deepEqual(await validateExecutionPlan(plan, root, new Set()), []);
    const first = await applyDeterministicSteps(plan, root, []);
    assert.deepEqual(first.applied, ["S1"]);
    assert.deepEqual(first.pendingModelSteps, ["S2"]);
    await writeFile(join(root, "b.ts"), "export const Banner = 1;\n");
    const second = await applyDeterministicSteps(plan, root, ["S1", "S2"]);
    assert.deepEqual(second.applied, ["S3"]);
    assert.equal(await readFile(join(root, "a.ts"), "utf8"), "export const enabled = false;\nexport const banner = true;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("verification policy allows repository scripts and known binaries only", () => {
  const scripts = new Set(["typecheck", "test"]);
  assert.ok(parseVerificationCommand("bun run typecheck", scripts));
  assert.ok(parseVerificationCommand("npm test", scripts));
  assert.ok(parseVerificationCommand("npx eslint src/a.ts", scripts));
  assert.equal(parseVerificationCommand("bun run deploy", scripts), undefined);
  assert.equal(parseVerificationCommand("npx evil-package", scripts), undefined);
  assert.equal(parseVerificationCommand("bun run typecheck && curl x", scripts), undefined);
  assert.equal(parseVerificationCommand("bash -c ls", scripts), undefined);
  assert.deepEqual(floorCommands("tests", FULL_TOOLS, ["src/a.ts", "README.md"]), ["bunx eslint src/a.ts", "bun run typecheck", "bun run test"]);
  assert.deepEqual(floorCommands("format-lint", NO_TOOLS, ["src/a.ts"]), []);
  assert.deepEqual(floorCommands("tests", FULL_TOOLS, ["src/a.ts"], ["bun test src/a.test.ts"]), ["bunx eslint src/a.ts", "bun run typecheck"], "plan test command replaces the floor test");
});

// ─── End to end through the tools ───────────────────────────────────────────

function toolContext(agent: string): ToolContext {
  return {
    sessionID: `s-${agent}`,
    messageID: "m",
    agent,
    directory: "/",
    worktree: "/",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => Promise.resolve(),
  };
}

void test("/task end to end: start → explore → plan → auto apply → verify → finish, with the relay journaling", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-task-e2e-"));
  const root = join(home, "repo");
  try {
    await mkdir(join(root, "src", "pages"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
    await writeFile(join(root, "bun.lock"), "");
    await writeFile(join(root, "src", "pages", "home.tsx"), "export const showBanner = false;\n");
    await writeFile(join(root, "src", "pages", "about.tsx"), "export const showBanner = true;\n");
    const paths = resolvePaths({ HOME: home });
    const commands: string[] = [];
    let changed: readonly string[] = [];
    const saved: string[] = [];
    const engine: DecisionEngine = {
      provider: "test",
      model: "jev",
      status: () => ({ available: true }),
      evaluate: async ({ questions }) => Promise.resolve({
        provider: "test",
        model: "jev",
        answers: Object.fromEntries(questions.map((question) => [question.id, question.type === "boolean"
          ? { type: "boolean" as const, probability: 0.95 }
          : question.id === "strategy"
            ? { type: "choice" as const, choice: "replicate", probabilities: { replicate: 0.9 } }
            : { type: "choice" as const, choice: Object.keys(question.type === "choice" ? question.criteria : {})[0] ?? "", probabilities: {} }])),
        usage: { inputTokens: 10, outputTokens: 1 },
        warnings: [],
      }),
    };
    const { tools, relay } = createTaskTools({
      paths,
      workspaceId: "ws",
      workspaceRoot: root,
      decision: () => ({ engine, enabled: true, maxRetries: 0, timeoutMs: 1_000 }),
      roleOf: (sessionID) => sessionID.replace(/^s-/u, ""),
      gitChangedFiles: () => changed,
      runner: async (argv) => {
        commands.push(argv.join(" "));
        return Promise.resolve({ exitCode: 0, output: "ok" });
      },
      engramSave: async (title) => { saved.push(title); },
    });
    const run = async (name: string, args: Record<string, unknown>, agent = "orchestrator"): Promise<Record<string, unknown>> => {
      const definition = tools[name] as unknown as { execute: (input: Record<string, unknown>, context: ToolContext) => Promise<{ output: string }> };
      return JSON.parse((await definition.execute(args, toolContext(agent))).output) as Record<string, unknown>;
    };

    const started = await run("mr_task_start", { text: "show the banner in the home page like the about page does" });
    assert.equal(started["ok"], true);
    assert.equal(started["phase"], "explore");
    assert.equal((started["classification"] as { strategy: string }).strategy, "replicate");

    await relay({ tool: "read", sessionID: "s-mr-task-explore", args: { filePath: join(root, "src", "pages", "about.tsx") } }, { output: "1: export const showBanner = true;" });
    await run("mr_task_record", { entries: [{ kind: "discard", summary: "layout.tsx does not control the banner" }] }, "mr-task-explore");
    const incomplete = await run("mr_task_explore_submit", { objective: "show banner on home", checklist: { reference: "src/pages/about.tsx" } }, "mr-task-explore");
    assert.equal(incomplete["ok"], false);
    assert.deepEqual(incomplete["gaps"], ["missing:target", "missing:deltas"]);
    const explored = await run("mr_task_explore_submit", {
      objective: "show banner on home",
      checklist: { reference: "src/pages/about.tsx", target: "src/pages/home.tsx:1", deltas: "flag true" },
      reference: { file: "src/pages/about.tsx", range: [1, 1], why: "same banner flag" },
      facts: [{ claim: "home hides the banner", file: "src/pages/home.tsx", range: [1, 1] }],
    }, "mr-task-explore");
    assert.equal(explored["phase"], "plan");

    const handoff = await run("mr_task_context", { role: "plan" }, "mr-task-plan");
    const mustKeep = handoff["mustKeep"] as { kind: string }[];
    assert.ok(mustKeep.some((entry) => entry.kind === "discard"), "discarded hypotheses reach the planner");
    assert.ok((handoff["slices"] as { file: string }[]).some((slice) => slice.file === "src/pages/about.tsx"), "the reference travels as live code");

    const rejected = await run("mr_task_plan_submit", {
      summary: "enable banner", strategy: "replicate", difficulty: 1,
      steps: [{ id: "S1", file: "src/pages/home.tsx", op: "replace", anchor: { snippet: "showBanner = maybe" }, code: "showBanner = true" }],
    }, "mr-task-plan");
    assert.equal(rejected["ok"], false);
    const accepted = await run("mr_task_plan_submit", {
      summary: "enable banner", strategy: "replicate", difficulty: 1,
      steps: [{ id: "S1", file: "src/pages/home.tsx", op: "replace", anchor: { snippet: "showBanner = false" }, code: "showBanner = true" }],
      verification: ["bun run typecheck"],
    }, "mr-task-plan");
    assert.equal(accepted["phase"], "apply");
    assert.deepEqual(accepted["deterministicSteps"], ["S1"]);

    const applied = await run("mr_task_apply", {});
    assert.deepEqual(applied["applied"], ["S1"]);
    assert.equal(applied["phase"], "verify");
    assert.equal(await readFile(join(root, "src", "pages", "home.tsx"), "utf8"), "export const showBanner = true;\n");

    changed = ["src/pages/home.tsx", "src/pages/stray.ts"];
    const outOfPlan = await run("mr_task_verify", {});
    assert.equal(outOfPlan["ok"], false);
    assert.deepEqual(outOfPlan["outOfPlanFiles"], ["src/pages/stray.ts"]);
    assert.equal(outOfPlan["phase"], "apply", "first failure returns to apply");
    changed = ["src/pages/home.tsx"];
    const verified = await run("mr_task_verify", {});
    assert.equal(verified["ok"], true);
    assert.equal(verified["phase"], "done");
    assert.ok(commands.includes("bun run typecheck"));

    const finished = await run("mr_task_finish", {});
    assert.equal(finished["ok"], true);
    assert.equal(saved.length, 1);
    const journalFile = join(paths.generatedRoot, "ws", "task", String(started["taskId"]), "journal.jsonl");
    const journal = await readFile(journalFile, "utf8");
    assert.match(journal, /"kind":"read".*"role":"mr-task-explore"/u);
    assert.match(journal, /"kind":"jev"/u);
    assert.equal(existsSync(join(paths.generatedRoot, "ws", "task", "state.json")), false, "finish clears the active pointer");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test("/task tweak with an explicit file skips explore and hands the planner the target as live code", { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-task-tweak-"));
  const root = join(home, "repo");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "flags.ts"), "export const showBanner = true;\n");
    const { tools } = createTaskTools({
      paths: resolvePaths({ HOME: home }),
      workspaceId: "ws",
      workspaceRoot: root,
      decision: () => ({ enabled: false, maxRetries: 0, timeoutMs: 1_000 }),
      gitChangedFiles: () => [],
    });
    const run = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const definition = tools[name] as unknown as { execute: (input: Record<string, unknown>, context: ToolContext) => Promise<{ output: string }> };
      return JSON.parse((await definition.execute(args, toolContext("orchestrator"))).output) as Record<string, unknown>;
    };
    const started = await run("mr_task_start", { text: "cambia showBanner a false en src/flags.ts" });
    assert.equal(started["phase"], "plan");
    const handoff = await run("mr_task_context", { role: "plan" });
    const slices = handoff["slices"] as { file: string; text: string }[];
    assert.match(slices.find((slice) => slice.file === "src/flags.ts")?.text ?? "", /showBanner = true/u);
    assert.equal((handoff["selection"] as { by: string }).by, "recency", "without Jev nothing is dropped");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

void test("per-strategy effort generates variant agents and routes the next role to them", async () => {
  const { setTaskEffort, resolveTaskRoute, taskAgentModelRole, EMPTY_TASK_EFFORT } = await import("../src/core/task/effort.js");
  const { agentDefinitions } = await import("../src/core/config.js");
  const { resolveModelRole } = await import("../src/core/quota.js");
  const { ModelMapSchema } = await import("../src/core/schema.js");
  const DEFAULT_MODELS_FOR_TESTS = ModelMapSchema.parse(JSON.parse(await readFile(join(process.cwd(), "models.json"), "utf8")));
  let effort = setTaskEffort(EMPTY_TASK_EFFORT, "replicate", "plan", "low");
  effort = setTaskEffort(effort, "bugfix", "plan", "xhigh");
  const agents = agentDefinitions(DEFAULT_MODELS_FOR_TESTS, effort);
  assert.equal(agents["mr-task-plan-low"]?.variant, "low");
  assert.equal(agents["mr-task-plan-xhigh"]?.variant, "xhigh");
  assert.equal(agents["mr-task-plan-low"]?.model, agents["mr-task-plan"]?.model, "effort changes the variant, never the model");
  assert.deepEqual(resolveTaskRoute(effort, "replicate", "plan"), { modelRole: "plan", agent: "mr-task-plan-low", variant: "low" });
  assert.deepEqual(resolveTaskRoute(effort, "feature", "plan"), { modelRole: "plan", agent: "mr-task-plan" });
  assert.equal(taskAgentModelRole("mr-task-apply-low"), "general");
  assert.equal(resolveModelRole("mr-task-plan-xhigh"), "plan");
  assert.deepEqual(setTaskEffort(effort, "replicate", "plan", undefined).strategies, { bugfix: { plan: "xhigh" } });
});
