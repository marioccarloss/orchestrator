import assert from "node:assert/strict";
import test from "node:test";
import {
  designSourceToHasFigma,
  flowRoleForPhase,
  mergeTaskText,
  normalizeDesignSource,
  renderFlowHarnessBadge,
} from "../src/core/flow-wizard.js";
import type { EffectiveHarnessModels } from "../src/core/harness-models.js";

const target = (model: string) => ({
  logical: { model },
  native: { model },
  origin: "global" as const,
});

const models: EffectiveHarnessModels = {
  schemaVersion: 1,
  harness: "opencode",
  applicationMode: "native-role",
  roles: {
    orchestrator: { primary: target("test/orchestrator"), alternative: target("test/orchestrator-alt") },
    explore: { primary: target("test/explore"), alternative: target("test/explore-alt") },
    plan: { primary: target("test/plan"), alternative: target("test/plan-alt") },
    general: { primary: target("test/general"), alternative: target("test/general-alt") },
    sddApply: { primary: target("test/sdd"), alternative: target("test/sdd-alt") },
    judgeA: { primary: target("test/judge-a"), alternative: target("test/judge-a-alt") },
    judgeB: { primary: target("test/judge-b"), alternative: target("test/judge-b-alt") },
    fix: { primary: target("test/fix"), alternative: target("test/fix-alt") },
    bpExtractor: { primary: target("test/bp-e"), alternative: target("test/bp-e-alt") },
    bpArchitect: { primary: target("test/bp-a"), alternative: target("test/bp-a-alt") },
    bpTransactor: { primary: target("test/bp-t"), alternative: target("test/bp-t-alt") },
  },
};

test("normalizeDesignSource prefers explicit source", () => {
  assert.equal(normalizeDesignSource("image", true), "image");
  assert.equal(normalizeDesignSource(undefined, true), "figma");
  assert.equal(normalizeDesignSource(undefined, false), "none");
});

test("mergeTaskText appends supplemental instructions", () => {
  const merged = mergeTaskText("Fix login", "Also cover Safari");
  assert.match(merged, /Fix login/);
  assert.match(merged, /Safari/);
});

test("flowRoleForPhase switches implementer on high difficulty", () => {
  const role = flowRoleForPhase("implement", 5);
  assert.equal(role.agent, "mr-sdd-apply");
});

test("renderFlowHarnessBadge is compact", () => {
  const badge = renderFlowHarnessBadge({
    phase: "explore",
    schemaVersion: 1,
    workspaceId: "ws",
    startedAt: new Date().toISOString(),
    difficulty: 3,
    ticket: {
      schemaVersion: 1,
      ref: { schemaVersion: 1, platform: "local", id: "LOCAL-1" },
      title: "t",
      description: "d",
      type: "feature",
      attachments: [],
      fetchedAt: new Date().toISOString(),
    },
    branch: "feature/local-1",
    baseBranch: "develop",
  }, models);
  assert.match(badge, /🔍 Explore/);
  assert.match(badge, /mr-explore/);
  assert.match(badge, /test\/explore/);
});

test("designSourceToHasFigma", () => {
  assert.equal(designSourceToHasFigma("figma"), true);
  assert.equal(designSourceToHasFigma("none"), false);
});
