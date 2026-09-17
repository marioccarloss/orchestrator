import assert from "node:assert/strict";
import test from "node:test";
import { deriveIntentBriefFromTicket } from "../src/core/intent-schema.js";
import { renderIntentExplanation } from "../src/core/render.js";

void test("deriveIntentBriefFromTicket accepts bounded tickets with acceptance signals", () => {
  const intent = deriveIntentBriefFromTicket({
    schemaVersion: 1,
    ref: { schemaVersion: 1, platform: "github", id: "GH-9" },
    title: "Fix login redirect loop in WebView",
    description: "When authDebug=1 the callback should return to /home.\n- Given an authenticated user\n- When the callback completes\n- Then the app lands on /home",
    type: "bugfix",
    attachments: [],
    fetchedAt: new Date().toISOString(),
  });
  assert.ok(intent);
  assert.equal(intent?.ticketId, "GH-9");
  assert.equal(intent?.mode, "auto");
  assert.ok(intent?.acceptanceSignals.length >= 1);
});

void test("deriveIntentBriefFromTicket rejects vague one-word tickets", () => {
  const intent = deriveIntentBriefFromTicket({
    schemaVersion: 1,
    ref: { schemaVersion: 1, platform: "github", id: "GH-10" },
    title: "Fix",
    description: "Broken",
    type: "bugfix",
    attachments: [],
    fetchedAt: new Date().toISOString(),
  });
  assert.equal(intent, undefined);
});

void test("renderIntentExplanation is deterministic and localized", () => {
  const rendered = renderIntentExplanation({
    schemaVersion: 1,
    ticketId: "GH-9",
    status: "READY",
    mode: "auto",
    problem: "Broken redirect",
    outcome: "Land on /home",
    nonGoals: [],
    acceptanceSignals: ["Callback completes", "User reaches /home"],
    constraints: [],
    decisions: [],
    assumptions: [],
  }, "es");
  assert.match(rendered, /Intención, en breve/u);
  assert.match(rendered, /Broken redirect/u);
});
