import assert from "node:assert/strict";
import test from "node:test";
import { runIntentSweeps } from "../src/core/intent-resolver.js";
import { validateIntentApproval } from "../src/core/intent-gates.js";
import type { TicketContent } from "../src/core/flow-schema.js";

const clearTicket: TicketContent = {
  schemaVersion: 1,
  ref: { schemaVersion: 1, platform: "github", id: "GH-42" },
  title: "Fix login redirect loop in WebView",
  description: "When authDebug=1 the callback should return to /home.\n- Given an authenticated user\n- When the callback completes\n- Then the app lands on /home",
  type: "bugfix",
  attachments: [],
  fetchedAt: new Date().toISOString(),
};

void test("runIntentSweeps auto-ready on fast lane for clear tickets", () => {
  const result = runIntentSweeps({ ticket: clearTicket, difficulty: 3 });
  assert.equal(result.assessment.status, "READY");
  assert.ok(result.sweepLog.some((line) => line.includes("S4 result: READY")));
});

void test("runIntentSweeps proposes draft on higher difficulty", () => {
  const result = runIntentSweeps({ ticket: clearTicket, difficulty: 8 });
  assert.equal(result.assessment.status, "PROPOSED");
  if (result.assessment.status === "PROPOSED") {
    assert.equal(result.assessment.resolution.sweepsCompleted, 4);
    assert.ok(result.assessment.resolution.fields["problem"]?.confidence === "high");
  }
});

void test("runIntentSweeps enriches from engram hits", () => {
  const result = runIntentSweeps({
    ticket: clearTicket,
    difficulty: 8,
    engramHits: [{
      id: "mem-1",
      title: "WebView redirect policy",
      excerpt: "Always land authenticated users on /home after OAuth callback.",
    }],
  });
  assert.equal(result.assessment.status, "PROPOSED");
  if (result.assessment.status === "PROPOSED") {
    assert.ok(result.assessment.decisions.some((decision) => decision.source === "engram"));
  }
});

void test("runIntentSweeps returns NEEDS_INPUT for extremely vague tickets", () => {
  const vague: TicketContent = {
    schemaVersion: 1,
    ref: { schemaVersion: 1, platform: "github", id: "GH-99" },
    title: "Fix",
    description: "Broken",
    type: "bugfix",
    attachments: [],
    fetchedAt: new Date().toISOString(),
  };
  const result = runIntentSweeps({ ticket: vague, difficulty: 3 });
  assert.equal(result.assessment.status, "NEEDS_INPUT");
  if (result.assessment.status === "NEEDS_INPUT") {
    assert.ok(result.assessment.questions.length <= 2);
  }
});

void test("validateIntentApproval blocks medium assumptions on critical lane", () => {
  const proposed = runIntentSweeps({ ticket: clearTicket, difficulty: 8 }).assessment;
  assert.equal(proposed.status, "PROPOSED");
  if (proposed.status !== "PROPOSED") return;
  const withMedium = {
    ...proposed,
    assumptions: [...proposed.assumptions, { statement: "Scope limited to mobile WebView only", risk: "medium" as const }],
  };
  const blocked = validateIntentApproval({ assessment: withMedium, lane: "critical", approved: true });
  assert.equal(blocked.ok, false);
  const allowed = validateIntentApproval({
    assessment: withMedium,
    lane: "critical",
    approved: true,
    confirmMediumAssumptions: true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.ready?.status, "READY");
});
