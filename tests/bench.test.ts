import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JourneyRecordSchema, summarizeBench } from "../src/core/bench.js";

test("bench corpus contains representative valid journeys", async () => {
  const raw = JSON.parse(await readFile(new URL("../bench/corpus.json", import.meta.url), "utf8")) as unknown;
  assert.ok(Array.isArray(raw));
  const journeys = raw.map((row) => JourneyRecordSchema.parse(row));
  assert.ok(journeys.length >= 15);
  const ecosystems = {
    inditex: journeys.filter((row) => row.repoProfile === "inditex-mfe").length,
    prensa: journeys.filter((row) => row.repoProfile.startsWith("prensa-")).length,
    openreferences: journeys.filter((row) => row.repoProfile.startsWith("openreferences-")).length,
  };
  assert.ok(Object.values(ecosystems).every((count) => count >= 3));
});

test("summarizeBench aggregates success, precision, tokens and role totals", () => {
  const report = summarizeBench([
    {
      journeyId: "J01", oneShot: true, failureCause: "none",
      tokens: { input: 100, output: 20, byRole: { explore: { input: 60, output: 10 } } },
      insufficientEvidenceStops: 1, necessaryInsufficientEvidenceStops: 1,
      filesReadUnnecessarily: 0, languageCompliant: true, staleContextIncidents: 0,
    },
    {
      journeyId: "J02", oneShot: false, failureCause: "wrong_plan",
      tokens: { input: 80, output: 10, byRole: { explore: { input: 30, output: 5 }, plan: { input: 50, output: 5 } } },
      insufficientEvidenceStops: 1, necessaryInsufficientEvidenceStops: 0,
      filesReadUnnecessarily: 2, languageCompliant: false, staleContextIncidents: 1,
    },
  ], "2026-09-13T00:00:00.000Z");
  assert.equal(report.metrics.oneShotRate, 0.5);
  assert.equal(report.metrics.insufficientEvidencePrecision, 0.5);
  assert.equal(report.metrics.tokensPerAcceptedDelivery, 210);
  assert.deepEqual(report.tokensByRole["explore"], { input: 90, output: 15 });
  assert.equal(report.failuresByCause.wrong_plan, 1);
});
