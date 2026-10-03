/**
 * Low-cost /task intake benchmark over bench/corpus.json.
 *
 *   bun scripts/task-intake-bench.ts            # heuristics only, zero tokens
 *   bun scripts/task-intake-bench.ts --jev      # also one real Jev call per journey (needs AI_GATEWAY_API_KEY)
 *   bun scripts/task-intake-bench.ts --jev --out bench/baselines/2026-10-task-intake.json
 *   bun scripts/task-intake-bench.ts --jev --no-zdr ...   # Gateway plans without Zero Data Retention (corpus is anonymized)
 *
 * It measures only the deterministic + Jev intake layer (strategy, difficulty,
 * context strategy, escalation). The corpus repositories are anonymized and not
 * present, so file mentions cannot be resolved and no model executes a journey.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { JevDecisionEngine } from "../src/adapters/decision/jev.js";
import { TYPESAFE_DEFAULT_MODEL, TypeSafeDecisionEngine, typeSafeApiKey } from "../src/adapters/decision/typesafe.js";
import { JourneyRecordSchema, type JourneyRecord } from "../src/core/bench.js";
import { DEFAULT_DECISION_PLANE_CONFIG, hasGatewayCredentials } from "../src/core/decision.js";
import { collectTaskSignals, decideIntake, jevRunner, type IntakeDecision } from "../src/core/task/decide.js";
import { TASK_DIFFICULTIES, type TaskInput } from "../src/core/task/schema.js";
import type { VerificationTools } from "../src/core/task/verify.js";

const args = process.argv.slice(2);
const useJev = args.includes("--jev");
// The anonymized corpus contains no customer data, so the bench may opt out of ZDR explicitly
// (Gateway hobby plans reject ZDR). Runtime /task and /flow keep requesting ZDR.
const noZdr = args.includes("--no-zdr");
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;

function toolsFor(journey: JourneyRecord): VerificationTools {
  const commands = journey.expectedVerify.join(" ");
  const packageManager = commands.startsWith("pnpm") ? "pnpm" : commands.startsWith("npm") ? "npm" : "bun";
  const scripts: Partial<Record<"lint" | "typecheck" | "test" | "format", string>> = {};
  if (/\btest\b|phpunit/u.test(commands)) scripts.test = "test";
  if (commands.includes('typecheck')) scripts.typecheck = "typecheck";
  return { packageManager, allScripts: Object.values(scripts), scripts, eslint: false, prettier: false };
}

function inputFor(journey: JourneyRecord): TaskInput {
  const words = journey.taskText.trim().split(/\s+/u).length;
  return {
    kind: journey.hasTicket ? "ticket" : words <= 25 ? "oneliner" : "prompt",
    text: journey.taskText,
    ...(journey.hasTicket ? { ticketRef: `BENCH-${journey.id}` } : {}),
    attachments: [],
  };
}

const lane = (difficulty: number): "lite" | "full" => (difficulty <= 3 ? "lite" : "full");
const fibIndex = (difficulty: number): number => {
  const index = TASK_DIFFICULTIES.findIndex((candidate) => candidate >= difficulty);
  return index === -1 ? TASK_DIFFICULTIES.length : index;
};

interface Row {
  readonly id: string;
  readonly corpusDifficulty: number;
  readonly mode: "heuristic" | "jev";
  readonly strategy: string;
  readonly difficulty: number;
  readonly laneMatch: boolean;
  readonly fibDistance: number;
  readonly read: string;
  readonly graph: string;
  readonly verify: string;
  readonly escalation: boolean;
  readonly jevAccepted: readonly string[];
  readonly jevError?: string;
  readonly tokens: number;
  readonly latencyMs: number;
}

function row(journey: JourneyRecord, mode: Row["mode"], decision: IntakeDecision, latencyMs: number): Row {
  return {
    id: journey.id,
    corpusDifficulty: journey.difficulty,
    mode,
    strategy: decision.classification.strategy,
    difficulty: decision.classification.difficulty,
    laneMatch: lane(decision.classification.difficulty) === lane(journey.difficulty),
    fibDistance: Math.abs(fibIndex(decision.classification.difficulty) - fibIndex(journey.difficulty)),
    read: decision.contextStrategy.read,
    graph: decision.contextStrategy.graph,
    verify: decision.contextStrategy.verify,
    escalation: decision.escalation !== undefined,
    jevAccepted: decision.jev.accepted,
    ...(decision.jev.error === undefined ? {} : { jevError: decision.jev.error }),
    tokens: (decision.jev.usage?.inputTokens ?? 0) + (decision.jev.usage?.outputTokens ?? 0),
    latencyMs,
  };
}

function summarize(rows: readonly Row[], corpus: readonly JourneyRecord[]) {
  const heavy = new Set(corpus.filter((journey) => journey.difficulty >= 13 || /auth|jwt|token|payment|migration/iu.test(journey.taskText)).map((journey) => journey.id));
  const count = rows.length || 1;
  return {
    journeys: rows.length,
    laneAgreement: Number((rows.filter((item) => item.laneMatch).length / count).toFixed(3)),
    meanFibDistance: Number((rows.reduce((total, item) => total + item.fibDistance, 0) / count).toFixed(3)),
    escalationRecallOnRiskyJourneys: Number((rows.filter((item) => heavy.has(item.id) && item.escalation).length / Math.max(1, heavy.size)).toFixed(3)),
    escalationsOnOthers: rows.filter((item) => !heavy.has(item.id) && item.escalation).map((item) => item.id),
    strategies: rows.reduce<Record<string, number>>((total, item) => ({ ...total, [item.strategy]: (total[item.strategy] ?? 0) + 1 }), {}),
    jevTokens: rows.reduce((total, item) => total + item.tokens, 0),
    jevErrors: rows.filter((item) => item.jevError !== undefined && item.jevError !== "jev-unavailable").length,
    meanLatencyMs: Math.round(rows.reduce((total, item) => total + item.latencyMs, 0) / count),
  };
}

const raw = JSON.parse(await readFile(join(process.cwd(), "bench", "corpus.json"), "utf8")) as unknown;
const list = Array.isArray(raw) ? raw : (raw as { journeys: unknown[] }).journeys;
const corpus = list.map((journey) => JourneyRecordSchema.parse(journey));

const heuristicRows: Row[] = [];
const jevRows: Row[] = [];
const unavailable = jevRunner(undefined, false, { maxRetries: 0, timeoutMs: 1_000 });
// --jev prefers the direct TypeSafe API (TYPESAFE_API_KEY); --gateway forces Vercel AI Gateway.
const viaGateway = args.includes("--gateway") || typeSafeApiKey() === undefined;
const engine = !useJev
  ? undefined
  : viaGateway
    ? new JevDecisionEngine(process.env["MR_DECISION_MODEL"] ?? DEFAULT_DECISION_PLANE_CONFIG.model, process.env, undefined, noZdr ? { zeroDataRetention: false } : {})
    : new TypeSafeDecisionEngine(process.env["TYPESAFE_DEFAULT_MODEL"]?.trim() ?? TYPESAFE_DEFAULT_MODEL);
if (useJev && viaGateway && !hasGatewayCredentials()) throw new Error("--jev needs TYPESAFE_API_KEY, or AI_GATEWAY_API_KEY with --gateway");
const jev = jevRunner(engine, useJev, { maxRetries: 1, timeoutMs: 15_000 });

for (const journey of corpus) {
  const input = inputFor(journey);
  const signals = collectTaskSignals(input, { fileExists: () => false, tools: toolsFor(journey) });
  let started = Date.now();
  heuristicRows.push(row(journey, "heuristic", await decideIntake(input, signals, unavailable), Date.now() - started));
  if (useJev) {
    started = Date.now();
    jevRows.push(row(journey, "jev", await decideIntake(input, signals, jev), Date.now() - started));
  }
}

const report = {
  schemaVersion: 1,
  kind: "task-intake",
  generatedAt: new Date().toISOString(),
  scope: "intake only (strategy, difficulty, context strategy, escalation); corpus repositories absent, no model executes a journey",
  model: engine?.model,
  provider: engine?.provider,
  zeroDataRetention: useJev && viaGateway ? !noZdr : undefined,
  heuristic: { summary: summarize(heuristicRows, corpus), rows: heuristicRows },
  ...(useJev ? { jev: { summary: summarize(jevRows, corpus), rows: jevRows } } : {}),
};

const text = `${JSON.stringify(report, null, 2)}\n`;
if (out !== undefined) await writeFile(out, text, "utf8");
console.log(JSON.stringify({ heuristic: report.heuristic.summary, ...(useJev ? { jev: summarize(jevRows, corpus) } : {}) }, null, 2));
for (const [index, item] of heuristicRows.entries()) {
  const other = jevRows[index];
  console.log([
    item.id,
    `corpus=d${String(item.corpusDifficulty)}`,
    `heur=${item.strategy}/d${String(item.difficulty)}/${item.read}${item.escalation ? "/flow" : ""}`,
    ...(other === undefined ? [] : [`jev=${other.strategy}/d${String(other.difficulty)}/${other.read}${other.escalation ? "/flow" : ""} [${other.jevAccepted.join(",")}]${other.jevError === undefined ? "" : ` ERR ${other.jevError}`}`]),
  ].join("  "));
}
