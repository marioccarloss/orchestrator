/**
 * Zero-token /task simulation bench on real fixture repositories.
 *
 *   bun scripts/task-sim-bench.ts --corpus ../apps/corpus [--out bench/baselines/2026-10-task-sim.json]
 *   bun scripts/task-sim-bench.ts --corpus ../apps/corpus --jev   # real Jev decisions via TYPESAFE_API_KEY (roles stay scripted)
 *
 * Every role output (explore report, plan, model-step edits) is scripted as an
 * ideal model would produce it, so no LLM is called. What runs for real:
 * intake heuristics, the Relay journal, handoff construction, plan validation,
 * deterministic apply, verification commands (`bun test`) and the out-of-plan
 * conformance check. Each journey starts from and is reset to the fixture's
 * committed baseline. This proves the machinery, not model quality.
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";
import { resolvePaths } from "../src/core/paths.js";
import { runCommand } from "../src/core/process.js";
import { createTaskTools } from "../src/task-tools.js";
import { TYPESAFE_DEFAULT_MODEL, TypeSafeDecisionEngine, typeSafeApiKey } from "../src/adapters/decision/typesafe.js";

type Json = Record<string, unknown>;

interface ScriptedEdit {
  readonly file: string;
  readonly content: string;
}

interface Journey {
  readonly id: string;
  readonly repo: "web-shop" | "api-refs";
  readonly text: string;
  readonly explore?: {
    readonly reads: readonly { readonly file: string; readonly range: readonly [number, number] }[];
    readonly records: readonly Json[];
    readonly report: Json;
    /** Answers the scripted explorer adds when the submit reports checklist gaps (Jev may reclassify). */
    readonly checklistExtras?: Readonly<Record<string, string>>;
  };
  readonly rejectedPlan?: Json;
  readonly plan: Json;
  /** Simulated mr-task-apply output for intent-only steps. */
  readonly modelSteps?: Readonly<Record<string, readonly ScriptedEdit[]>>;
  /** Simulated correction after the first verification failure. */
  readonly fixAfterFailure?: { readonly remove: readonly string[] };
}

const JOURNEYS: readonly Journey[] = [
  {
    id: "A1-tweak",
    repo: "web-shop",
    text: "Desactiva promoBanner en src/config/flags.ts",
    plan: {
      summary: "Turn the promo banner flag off",
      strategy: "tweak",
      difficulty: 1,
      steps: [{ id: "S1", file: "src/config/flags.ts", op: "replace", anchor: { snippet: "promoBanner: true" }, code: "promoBanner: false" }],
    },
  },
  {
    id: "A2-replicate",
    repo: "web-shop",
    text: "Muestra el banner de promociones en la home igual que ya lo hace la página about",
    explore: {
      reads: [{ file: "src/pages/about.ts", range: [1, 7] }, { file: "src/pages/home.ts", range: [1, 3] }],
      records: [{ kind: "discard", summary: "There is no shared layout; each page renders its own banner, so layout changes are out of scope" }],
      report: {
        objective: "Render the promo banner on the home page exactly like the about page",
        checklist: {
          reference: "src/pages/about.ts:1-7 renders renderBanner behind flags.promoBanner",
          target: "src/pages/home.ts:1-3 renderHome",
          deltas: "import renderBanner and flags; same message; keep the <h1>",
        },
        reference: { file: "src/pages/about.ts", range: [1, 7], why: "same banner behind the same flag" },
        facts: [{ claim: "home renders only its title", file: "src/pages/home.ts", range: [1, 3] }],
        filesOfInterest: ["src/pages/home.ts", "src/pages/about.ts"],
      },
    },
    plan: {
      summary: "Mirror the about page banner on home and cover it with a test",
      strategy: "replicate",
      difficulty: 2,
      steps: [
        {
          id: "S1", file: "src/pages/home.ts", op: "insertBefore", anchor: { snippet: "export function renderHome(): string {" },
          code: "import { renderBanner } from \"../components/banner.js\";\nimport { flags } from \"../config/flags.js\";\n\n",
        },
        {
          id: "S2", file: "src/pages/home.ts", op: "replace", anchor: { snippet: "  return `<main><h1>Inicio</h1></main>`;" },
          code: "  const banner = flags.promoBanner ? renderBanner({ message: \"Envío gratis este mes\" }) : \"\";\n  return `<main>${banner}<h1>Inicio</h1></main>`;",
          dependsOn: ["S1"],
        },
        {
          id: "S3", file: "tests/home-banner.test.ts", op: "create",
          intent: "Create a bun test asserting renderHome contains the banner aside when flags.promoBanner is true",
          reference: { file: "tests/pages.test.ts", lines: [1, 11] },
          dependsOn: ["S2"],
        },
      ],
      verification: ["bun test"],
    },
    modelSteps: {
      S3: [{
        file: "tests/home-banner.test.ts",
        content: "import { expect, test } from \"bun:test\";\nimport { renderHome } from \"../src/pages/home.js\";\n\ntest(\"home shows the promo banner\", () => {\n  expect(renderHome()).toContain(\"<aside class=\\\"banner\\\">\");\n});\n",
      }],
    },
  },
  {
    id: "A3-bugfix",
    repo: "web-shop",
    text: "El total del carrito no tiene en cuenta la cantidad de cada producto, es un bug",
    explore: {
      reads: [{ file: "src/cart/cart.ts", range: [1, 9] }, { file: "tests/cart.test.ts", range: [1, 6] }],
      records: [
        { kind: "fact", summary: "cartTotal adds price without quantity", file: "src/cart/cart.ts", range: [7, 9] },
        { kind: "discard", summary: "Prices are integers in the fixture; no rounding issue involved" },
      ],
      report: {
        objective: "cartTotal must multiply price by quantity",
        checklist: {
          reproduction: "cartTotal([{ sku: 'a', price: 5, quantity: 2 }]) returns 5 instead of 10",
          rootCauseCandidates: "1) reduce adds item.price ignoring item.quantity",
          failingPath: "src/cart/cart.ts:7-9 cartTotal",
          tests: "tests/cart.test.ts covers only the empty cart",
        },
        facts: [{ claim: "reduce ignores quantity", file: "src/cart/cart.ts", range: [7, 9] }],
        filesOfInterest: ["src/cart/cart.ts", "tests/cart.test.ts"],
      },
    },
    plan: {
      summary: "Multiply by quantity and add a regression test",
      strategy: "bugfix",
      difficulty: 2,
      steps: [
        { id: "S1", file: "src/cart/cart.ts", op: "replace", anchor: { snippet: "total + item.price, 0" }, code: "total + item.price * item.quantity, 0" },
        {
          id: "S2", file: "tests/cart.test.ts", op: "insertAfter", anchor: { snippet: "  expect(cartTotal([])).toBe(0);\n});" },
          code: "\n\ntest(\"multiplies price by quantity\", () => {\n  expect(cartTotal([{ sku: \"a\", price: 5, quantity: 2 }])).toBe(10);\n});",
        },
      ],
      verification: ["bun test"],
    },
  },
  {
    id: "B1-feature",
    repo: "api-refs",
    text: "Añade validación de título obligatorio al endpoint POST de artículos conservando el esquema de respuesta",
    explore: {
      reads: [{ file: "src/routes/article.ts", range: [1, 11] }, { file: "tests/article.test.ts", range: [1, 8] }],
      records: [{ kind: "decision", summary: "Invalid payloads return 400 with body.error; success keeps 201 with body.data" }],
      report: {
        objective: "Reject missing or blank titles with 400 while preserving ApiResponse",
        checklist: {
          entrypoints: "src/routes/article.ts postArticle",
          contracts: "ApiResponse<T> { status, body: { data?, error? } } must not change",
          tests: "tests/article.test.ts",
        },
        facts: [{ claim: "postArticle stringifies title without validation", file: "src/routes/article.ts", range: [8, 11] }],
      },
    },
    plan: {
      summary: "Validate title before creating the article",
      strategy: "feature",
      difficulty: 3,
      steps: [
        {
          id: "S1", file: "src/routes/article.ts", op: "replace", anchor: { snippet: "  const article = createArticle(String(payload.title));" },
          code: "  if (typeof payload.title !== \"string\" || payload.title.trim() === \"\") {\n    return { status: 400, body: { error: \"title is required\" } };\n  }\n  const article = createArticle(payload.title);",
        },
        {
          id: "S2", file: "tests/article.test.ts", op: "insertAfter", anchor: { snippet: "  expect(response.body.data?.slug).toBe(\"hello-world\");\n});" },
          code: "\n\ntest(\"rejects a blank title with 400\", () => {\n  const response = postArticle({ title: \"  \" });\n  expect(response.status).toBe(400);\n  expect(response.body.error).toBe(\"title is required\");\n});",
        },
      ],
      verification: ["bun test"],
    },
  },
  {
    id: "B2-bugfix",
    repo: "api-refs",
    text: "slugify no elimina acentos: 'Canción Única' debería ser 'cancion-unica'",
    explore: {
      reads: [{ file: "src/utils/slugify.ts", range: [1, 7] }],
      records: [{ kind: "discard", summary: "Not a locale issue in toLowerCase; accents are stripped as non [a-z0-9] characters" }],
      report: {
        objective: "Strip diacritics before slugifying",
        checklist: {
          reproduction: "slugify('Canción Única') returns 'canci-n-nica'",
          rootCauseCandidates: "1) no Unicode normalization before the [^a-z0-9] replacement",
          failingPath: "src/utils/slugify.ts:2-6",
          tests: "tests/slugify.test.ts",
        },
        facts: [{ claim: "no normalization step", file: "src/utils/slugify.ts", range: [1, 7] }],
      },
    },
    plan: {
      summary: "Normalize to NFD and drop combining marks",
      strategy: "bugfix",
      difficulty: 2,
      steps: [
        { id: "S1", file: "src/utils/slugify.ts", op: "replace", anchor: { snippet: "    .toLowerCase()" }, code: "    .normalize(\"NFD\")\n    .replace(/[\\u0300-\\u036f]/g, \"\")\n    .toLowerCase()" },
        {
          id: "S2", file: "tests/slugify.test.ts", op: "insertAfter", anchor: { snippet: "  expect(slugify(\"Hello  World\")).toBe(\"hello-world\");\n});" },
          code: "\n\ntest(\"slugify strips accents\", () => {\n  expect(slugify(\"Canción Única\")).toBe(\"cancion-unica\");\n});",
        },
      ],
      verification: ["bun test"],
    },
  },
  {
    id: "B3-recovery",
    repo: "api-refs",
    text: "Haz que createArticle recorte los espacios del título antes de guardarlo",
    explore: {
      reads: [{ file: "src/services/articles.ts", range: [1, 15] }],
      records: [],
      checklistExtras: { target: "src/services/articles.ts:11-15 createArticle" },
      report: {
        objective: "Trim the title inside createArticle",
        checklist: {
          entrypoints: "src/services/articles.ts createArticle",
          contracts: "Article shape unchanged",
          tests: "tests/article.test.ts",
        },
      },
    },
    rejectedPlan: {
      summary: "Trim title",
      strategy: "feature",
      difficulty: 1,
      steps: [{ id: "S1", file: "src/services/articles.ts", op: "replace", anchor: { snippet: "const article = {id: store.length + 1, title}" }, code: "x" }],
    },
    plan: {
      summary: "Trim the title before storing it",
      strategy: "feature",
      difficulty: 1,
      steps: [{
        id: "S1", file: "src/services/articles.ts", op: "replace",
        anchor: { snippet: "export function createArticle(title: string): Article {" },
        intent: "Trim the incoming title once at the start of createArticle and use the trimmed value for both title and slug",
      }],
      verification: ["bun test"],
    },
    modelSteps: {
      S1: [
        {
          file: "src/services/articles.ts",
          content: "import { slugify } from \"../utils/slugify.js\";\n\nexport interface Article {\n  readonly id: number;\n  readonly title: string;\n  readonly slug: string;\n}\n\nconst store: Article[] = [];\n\nexport function createArticle(rawTitle: string): Article {\n  const title = rawTitle.trim();\n  const article = { id: store.length + 1, title, slug: slugify(title) };\n  store.push(article);\n  return article;\n}\n",
        },
        // A sloppy applier also leaves a stray debug file: conformance must catch it.
        { file: "src/utils/debug.ts", content: "export const debug = true;\n" },
      ],
    },
    fixAfterFailure: { remove: ["src/utils/debug.ts"] },
  },
];

function context(agent: string): ToolContext {
  return {
    sessionID: `sim-${agent}`,
    messageID: "m",
    agent,
    directory: "/",
    worktree: "/",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => Promise.resolve(),
  };
}

async function repoChars(root: string): Promise<number> {
  let total = 0;
  for (const directory of ["src", "tests"]) {
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path)) {
        const full = join(path, entry);
        if ((await stat(full)).isDirectory()) await walk(full);
        else total += (await readFile(full, "utf8")).length;
      }
    };
    await walk(join(root, directory));
  }
  return total;
}

function resetRepo(root: string): void {
  runCommand("git", ["-C", root, "checkout", "--", "."]);
  runCommand("git", ["-C", root, "clean", "-fdq"]);
}

const args = process.argv.slice(2);
const corpusIndex = args.indexOf("--corpus");
const corpus = resolve(corpusIndex >= 0 ? args[corpusIndex + 1] ?? "" : join(process.cwd(), "..", "apps", "corpus"));
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
const useJev = args.includes("--jev");
if (useJev && typeSafeApiKey() === undefined) throw new Error("--jev needs TYPESAFE_API_KEY");
const engine = useJev ? new TypeSafeDecisionEngine(process.env["TYPESAFE_DEFAULT_MODEL"]?.trim() ?? TYPESAFE_DEFAULT_MODEL) : undefined;
const home = await mkdtemp(join(tmpdir(), "mr-task-sim-"));
const results: Json[] = [];

try {
  for (const journey of JOURNEYS) {
    const root = join(corpus, journey.repo);
    resetRepo(root);
    const started = Date.now();
    const phases: string[] = [];
    const taskTools = createTaskTools({
      paths: resolvePaths({ HOME: home }),
      workspaceId: `sim-${journey.repo}`,
      workspaceRoot: root,
      decision: () => (engine === undefined ? { enabled: false, maxRetries: 0, timeoutMs: 1_000 } : { engine, enabled: true, maxRetries: 1, timeoutMs: 10_000 }),
      roleOf: (sessionID) => sessionID.replace(/^sim-/u, ""),
    });
    const { tools } = taskTools;
    const relay = async (...relayArgs: Parameters<typeof taskTools.relay>): Promise<void> => taskTools.relay(...relayArgs);
    const run = async (name: string, input: Json, agent = "orchestrator"): Promise<Json> => {
      const definition = tools[name] as unknown as { execute: (value: Json, ctx: ToolContext) => Promise<{ output: string }> };
      const result = JSON.parse((await definition.execute(input, context(agent))).output) as Json;
      if (typeof result["phase"] === "string") phases.push(`${name.replace("mr_task_", "")}→${result["phase"]}`);
      return result;
    };
    const record: Json = { id: journey.id, repo: journey.repo };
    try {
      const startedTask = await run("mr_task_start", { text: journey.text });
      record["intake"] = { classification: startedTask["classification"], read: (startedTask["contextStrategy"] as Json)["read"], verify: (startedTask["contextStrategy"] as Json)["verify"], escalation: startedTask["escalation"] };
      if (startedTask["phase"] === "explore") {
        if (journey.explore === undefined) throw new Error("intake asked for explore but the journey has no scripted explore");
        for (const read of journey.explore.reads) {
          const text = (await readFile(join(root, read.file), "utf8")).split("\n").slice(read.range[0] - 1, read.range[1]).join("\n");
          await relay({ tool: "read", sessionID: "sim-mr-task-explore", args: { filePath: join(root, read.file), offset: read.range[0], limit: read.range[1] - read.range[0] + 1 } }, { output: text });
        }
        if (journey.explore.records.length > 0) await run("mr_task_record", { entries: journey.explore.records }, "mr-task-explore");
        let explored = await run("mr_task_explore_submit", journey.explore.report, "mr-task-explore");
        const gaps = (explored["gaps"] as string[] | undefined) ?? [];
        if (explored["ok"] !== true && gaps.length > 0 && journey.explore.checklistExtras !== undefined) {
          // Contract: close only the reported gaps and resubmit.
          const checklist = { ...(journey.explore.report["checklist"] as Json), ...journey.explore.checklistExtras };
          explored = await run("mr_task_explore_submit", { ...journey.explore.report, checklist }, "mr-task-explore");
          record["exploreResubmitted"] = gaps;
        }
        if (explored["ok"] !== true) throw new Error(`explore rejected: ${JSON.stringify(explored)}`);
      }
      const handoff = await run("mr_task_context", { role: "plan" }, "mr-task-plan");
      const handoffChars = JSON.stringify(handoff).length;
      record["handoff"] = {
        chars: handoffChars,
        approxTokens: Math.round(handoffChars / 4),
        repoChars: await repoChars(root),
        mustKeep: (handoff["mustKeep"] as unknown[] | undefined)?.length ?? 0,
        slices: (handoff["slices"] as unknown[] | undefined)?.length ?? 0,
        manifest: (handoff["manifest"] as unknown[] | undefined)?.length ?? 0,
      };
      if (journey.rejectedPlan !== undefined) {
        const rejected = await run("mr_task_plan_submit", journey.rejectedPlan, "mr-task-plan");
        record["rejectedPlanIssues"] = (rejected["issues"] as { code: string }[] | undefined)?.map((issue) => issue.code) ?? [];
      }
      const accepted = await run("mr_task_plan_submit", journey.plan, "mr-task-plan");
      if (accepted["ok"] !== true) throw new Error(`plan rejected: ${JSON.stringify(accepted)}`);
      let applied = await run("mr_task_apply", {});
      const autoSteps = [...(applied["applied"] as string[])];
      const modelSteps: string[] = [];
      for (const stepId of applied["pendingModelSteps"] as string[]) {
        const applyHandoff = await run("mr_task_context", { role: "apply", stepId }, "mr-task-apply");
        record["applyHandoffChars"] = JSON.stringify(applyHandoff).length;
        for (const edit of journey.modelSteps?.[stepId] ?? []) {
          await writeFile(join(root, edit.file), edit.content, "utf8");
          await relay({ tool: "write", sessionID: "sim-mr-task-apply", args: { filePath: join(root, edit.file) } }, { output: "ok" });
        }
        const done = await run("mr_task_step_done", { stepId, note: "simulated applier" }, "mr-task-apply");
        if (done["ok"] !== true) throw new Error(`step ${stepId} rejected: ${JSON.stringify(done)}`);
        modelSteps.push(stepId);
        autoSteps.push(...(done["autoApplied"] as string[]));
      }
      if (applied["phase"] === "apply" && modelSteps.length === 0) applied = await run("mr_task_apply", {});
      let verify = await run("mr_task_verify", {});
      let attempts = 1;
      const failures: Json[] = [];
      if (verify["ok"] !== true) {
        failures.push({ outOfPlanFiles: verify["outOfPlanFiles"], failedCommands: (verify["receipts"] as { ok: boolean; command: string }[]).filter((receipt) => !receipt.ok).map((receipt) => receipt.command) });
        for (const file of journey.fixAfterFailure?.remove ?? []) await rm(join(root, file), { force: true });
        verify = await run("mr_task_verify", {});
        attempts += 1;
      }
      const status = await run("mr_task_status", {});
      record["jevCalls"] = (status["journal"] as Record<string, number> | undefined)?.["jev"] ?? 0;
      const journalText = await readFile(join(resolvePaths({ HOME: home }).generatedRoot, `sim-${journey.repo}`, "task", String(startedTask["taskId"]), "journal.jsonl"), "utf8").catch(() => "");
      record["jevTokens"] = [...journalText.matchAll(/tokens in=(\d+) out=(\d+)/gu)].reduce((total, match) => total + Number(match[1]) + Number(match[2]), 0);
      const finished = verify["ok"] === true ? await run("mr_task_finish", {}) : await run("mr_task_abort", {});
      Object.assign(record, {
        ok: verify["ok"] === true && finished["ok"] === true,
        autoSteps,
        modelSteps,
        verifyAttempts: attempts,
        verificationFailuresCaught: failures,
        commands: (verify["receipts"] as { command: string; ok: boolean; ms: number }[]).map((receipt) => `${receipt.ok ? "✓" : "✗"} ${receipt.command} (${String(receipt.ms)} ms)`),
        phases,
        ms: Date.now() - started,
      });
    } catch (error: unknown) {
      Object.assign(record, { ok: false, error: error instanceof Error ? error.message : String(error), phases, ms: Date.now() - started });
      await run("mr_task_abort", {}).catch(() => undefined);
    } finally {
      resetRepo(root);
    }
    results.push(record);
  }
} finally {
  await rm(home, { recursive: true, force: true });
}

const handoffs = results.map((item) => item["handoff"] as Json | undefined).filter((item): item is Json => item !== undefined);
const summary = {
  journeys: results.length,
  delivered: results.filter((item) => item["ok"] === true).length,
  modelTokens: 0,
  jev: useJev ? "typesafe" : "off",
  jevCalls: results.reduce((total, item) => total + Number(item["jevCalls"] ?? 0), 0),
  jevTokens: results.reduce((total, item) => total + Number(item["jevTokens"] ?? 0), 0),
  autoAppliedSteps: results.reduce((total, item) => total + ((item["autoSteps"] as unknown[] | undefined)?.length ?? 0), 0),
  modelSteps: results.reduce((total, item) => total + ((item["modelSteps"] as unknown[] | undefined)?.length ?? 0), 0),
  failuresCaught: results.reduce((total, item) => total + ((item["verificationFailuresCaught"] as unknown[] | undefined)?.length ?? 0), 0),
  meanPlanHandoffTokens: Math.round(handoffs.reduce((total, item) => total + Number(item["approxTokens"]), 0) / Math.max(1, handoffs.length)),
  meanHandoffVsRepo: Number((handoffs.reduce((total, item) => total + Number(item["chars"]) / Number(item["repoChars"]), 0) / Math.max(1, handoffs.length)).toFixed(2)),
  meanMs: Math.round(results.reduce((total, item) => total + Number(item["ms"]), 0) / Math.max(1, results.length)),
};
const report = {
  schemaVersion: 1,
  kind: "task-simulation",
  generatedAt: new Date().toISOString(),
  scope: "scripted role outputs on real fixture repos; zero model tokens; verifies machinery, not model quality",
  corpus,
  summary,
  journeys: results,
};
if (out !== undefined) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));
for (const item of results) {
  console.log(`${String(item["id"])}: ${item["ok"] === true ? "OK" : `FAIL ${String(item["error"] ?? "")}`}  ${(item["phases"] as string[]).join(" ")}`);
}
