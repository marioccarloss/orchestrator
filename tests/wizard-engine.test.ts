import assert from "node:assert/strict";
import test from "node:test";
import { applyWizardAnswer, questionForStep } from "../src/core/wizard-engine.js";
import type { WizardDraft, WizardStepId } from "../src/core/flow-schema.js";

test("wizard engine walks no-ticket happy path", () => {
  let draft: WizardDraft = {};
  let step: WizardStepId = "source";
  ({ draft, nextStep: step } = applyWizardAnswer(step, "no_ticket", draft));
  assert.equal(step, "difficulty");
  ({ draft, nextStep: step } = applyWizardAnswer(step, "1", draft));
  assert.equal(step, "design");
  ({ draft, nextStep: step } = applyWizardAnswer(step, "none", draft));
  assert.equal(step, "instructions");
  const done = applyWizardAnswer(step, "Fix login redirect", draft);
  assert.equal(done.complete, true);
  assert.equal(done.startParams?.ticketPlatform, "local");
  assert.equal(done.startParams?.taskText, "Fix login redirect");
});

test("wizard engine walks github ticket path", () => {
  let draft: WizardDraft = {};
  let step: WizardStepId = "source";
  ({ draft, nextStep: step } = applyWizardAnswer(step, "github", draft));
  assert.equal(step, "ticket_id");
  ({ draft, nextStep: step } = applyWizardAnswer(step, "GH-99", draft));
  assert.equal(step, "difficulty");
  ({ draft, nextStep: step } = applyWizardAnswer(step, "3", draft));
  ({ draft, nextStep: step } = applyWizardAnswer(step, "figma", draft));
  assert.equal(step, "design_ref");
  ({ draft, nextStep: step } = applyWizardAnswer(step, "https://figma.com/file/abc", draft));
  assert.equal(step, "instructions");
  const done = applyWizardAnswer(step, "", draft);
  assert.equal(done.startParams?.ticketPlatform, "github");
  assert.equal(done.startParams?.ticketId, "GH-99");
  assert.equal(done.startParams?.designSource, "figma");
});

test("questionForStep includes platform options", () => {
  const q = questionForStep("source", {}, "es");
  assert.ok(q.options?.some((option) => option.id === "no_ticket"));
});
