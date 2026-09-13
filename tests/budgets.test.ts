import { test } from "bun:test";
import assert from "node:assert/strict";
import { CONTEXT_BUDGET_CHARS, contextBudgetChars, flowEconomyPolicy } from "../src/core/budgets.js";

test("context budgets vary deterministically by role and risk lane", () => {
  assert.equal(contextBudgetChars("plan", "full"), 50_000);
  assert.equal(contextBudgetChars("implement", "full"), 60_000);
  assert.equal(contextBudgetChars("judge-a", "full"), 40_000);
  assert.equal(contextBudgetChars("fix", "full"), 30_000);
  assert.ok(CONTEXT_BUDGET_CHARS.fast.implement < CONTEXT_BUDGET_CHARS.standard.implement);
  assert.ok(CONTEXT_BUDGET_CHARS.standard.implement < CONTEXT_BUDGET_CHARS.full.implement);
  assert.ok(CONTEXT_BUDGET_CHARS.full.implement < CONTEXT_BUDGET_CHARS.critical.implement);
  assert.equal(contextBudgetChars("implement", "fast", 1_234), 1_234);
  assert.throws(() => contextBudgetChars("plan", "full", 0), /positive safe integer/u);
});

test("only ticketless fast work combines planning and implementation in one session", () => {
  assert.deepEqual(flowEconomyPolicy("fast", false), {
    lane: "fast",
    sessionMode: "single",
    planner: "mr-general",
    implementer: "mr-general",
    judges: false,
    combineBriefAndImplementation: true,
  });
  assert.equal(flowEconomyPolicy("fast", true).sessionMode, "staged");
  assert.equal(flowEconomyPolicy("standard", false).sessionMode, "staged");
  assert.equal(flowEconomyPolicy("full", false).implementer, "mr-sdd-apply");
  assert.equal(flowEconomyPolicy("critical", false).judges, true);
});
