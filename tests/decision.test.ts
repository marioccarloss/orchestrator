import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_DECISION_PLANE_CONFIG,
  applyDecisionPolicy,
  loadDecisionPlaneConfig,
  questionsForDecisionProfile,
  setDecisionPlaneMode,
  type DecisionEngineResult,
} from "../src/core/decision.js";
import { resolvePaths } from "../src/core/paths.js";

const result = (answer: DecisionEngineResult["answers"][string], confidence?: number): DecisionEngineResult => ({
  provider: "test",
  model: "typesafe-ai/jev",
  answers: { contextEnough: answer },
  ...(confidence === undefined ? {} : { confidence: { contextEnough: confidence } }),
  usage: { inputTokens: 12, outputTokens: 0, totalTokens: 12 },
  warnings: [],
});

test("decision profiles use bounded, provider-neutral questions", () => {
  assert.deepEqual(questionsForDecisionProfile("routing").map((question) => question.id), ["modelTier"]);
  assert.deepEqual(questionsForDecisionProfile("context").map((question) => question.id), ["retention"]);
  assert.equal(questionsForDecisionProfile("intent")[0]?.type, "boolean");
});

test("boolean policy accepts calibrated extremes and escalates uncertainty", () => {
  const yes = applyDecisionPolicy("intent", result({ type: "boolean", probability: 0.96 }), DEFAULT_DECISION_PLANE_CONFIG);
  assert.equal(yes.status, "accepted");
  assert.equal(yes.recommendations[0]?.value, true);

  const unknown = applyDecisionPolicy("intent", result({ type: "boolean", probability: 0.51 }), DEFAULT_DECISION_PLANE_CONFIG);
  assert.equal(unknown.status, "escalate");
  assert.equal(unknown.authority, "deterministic-fsm");
});

test("decision plane remains opt-in and persists shadow mode without credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-decision-"));
  const paths = resolvePaths({ HOME: home });
  try {
    const initial = await loadDecisionPlaneConfig(paths, {});
    assert.equal(initial.mode, "off");
    const enabled = await setDecisionPlaneMode(paths, "shadow");
    assert.equal(enabled.mode, "shadow");
    const stored = JSON.parse(await readFile(join(paths.configRoot, "decision-plane.json"), "utf8")) as { mode: string };
    assert.equal(stored.mode, "shadow");
    const overridden = await loadDecisionPlaneConfig(paths, { MR_DECISION_MODE: "off" });
    assert.equal(overridden.mode, "off");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
