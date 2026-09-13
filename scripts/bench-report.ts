import { readFile } from "node:fs/promises";
import { FlowMetricsSchema } from "../src/core/flow-metrics.js";
import { JourneyOutcomeSchema, summarizeBench, type JourneyOutcome } from "../src/core/bench.js";
import { canonicalJson } from "../src/core/files.js";

const HELP = `Usage: bun scripts/bench-report.ts --journey J01 --metrics FILE --events FILE [options]

Options:
  --one-shot                    mark the delivery accepted in one pass
  --failure CAUSE               failure cause (default: none)
  --unnecessary-reads N         downstream rediscovery count
  --necessary-stops N           justified INSUFFICIENT_EVIDENCE stops
  --language-compliant BOOL     whether human output used the requested language
  --help                        show this help
`;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function countStops(events: string): number {
  return events.split(/\r?\n/u).filter((line) => line.includes("INSUFFICIENT_EVIDENCE")).length;
}

export async function outcomeFromFiles(args: readonly string[]): Promise<JourneyOutcome> {
  const journeyId = option(args, "--journey");
  const metricsPath = option(args, "--metrics");
  const eventsPath = option(args, "--events");
  if (journeyId === undefined || metricsPath === undefined || eventsPath === undefined) throw new Error("--journey, --metrics and --events are required");
  const metrics = FlowMetricsSchema.parse(JSON.parse(await readFile(metricsPath, "utf8")) as unknown);
  const events = await readFile(eventsPath, "utf8");
  const byRole: Record<string, { input: number; output: number }> = {};
  let input = 0;
  let output = 0;
  for (const message of Object.values(metrics.messages)) {
    input += message.tokens.input;
    output += message.tokens.output;
    const role = message.role ?? "unknown";
    const current = byRole[role] ?? { input: 0, output: 0 };
    byRole[role] = { input: current.input + message.tokens.input, output: current.output + message.tokens.output };
  }
  return JourneyOutcomeSchema.parse({
    journeyId,
    oneShot: args.includes("--one-shot"),
    failureCause: option(args, "--failure") ?? "none",
    tokens: { input, output, byRole },
    insufficientEvidenceStops: countStops(events),
    necessaryInsufficientEvidenceStops: Number(option(args, "--necessary-stops") ?? 0),
    filesReadUnnecessarily: Number(option(args, "--unnecessary-reads") ?? 0),
    languageCompliant: option(args, "--language-compliant") !== "false",
    staleContextIncidents: events.includes("stale_context") ? 1 : 0,
  });
}

const args = process.argv.slice(2);
if (args.includes("--help")) {
  process.stdout.write(HELP);
} else {
  outcomeFromFiles(args)
    .then((outcome) => { process.stdout.write(canonicalJson(summarizeBench([outcome]))); })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${HELP}`);
      process.exitCode = 1;
    });
}
