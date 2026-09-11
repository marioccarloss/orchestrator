import { expect, test } from "bun:test";
import { adapterArtifacts } from "../src/adapters.js";

test("creates native workflow adapters for every selected client without duplicates", () => {
  const artifacts = adapterArtifacts([
    "codex-cli",
    "codex-desktop",
    "cursor-cli",
    "claude-code",
    "antigravity-desktop",
    "agy-cli",
  ], "/home/tester");

  expect(artifacts).toHaveLength(15);
  expect(new Set(artifacts.map((artifact) => artifact.path)).size).toBe(15);
  expect(artifacts.map((artifact) => artifact.invocation)).toContain("$flow");
  expect(artifacts.map((artifact) => artifact.path)).toContain("/home/tester/.cursor/skills/flow/SKILL.md");
  expect(artifacts.map((artifact) => artifact.path)).toContain("/home/tester/.codex/skills/flow/SKILL.md");
  expect(artifacts.map((artifact) => artifact.path)).toContain("/home/tester/.gemini/commands/flow.toml");
  expect(artifacts.map((artifact) => artifact.path)).toContain("/home/tester/.gemini/config/skills/blueprint/SKILL.md");
});

test("all adapters bind a workspace and delegate state to mr-orchestrator tools", () => {
  const artifacts = adapterArtifacts([
    "codex-cli",
    "cursor-cli",
    "claude-code",
    "antigravity-desktop",
    "agy-cli",
  ], "/home/tester");

  for (const artifact of artifacts) {
    expect(artifact.content).toContain("mr_bind_workspace");
    if (artifact.path.includes("flow-models")) {
      expect(artifact.content).toContain("mr_models");
    } else if (artifact.path.includes("flow")) {
      expect(artifact.content).toContain("mr_flow_status");
      expect(artifact.content).toContain("mr_sdd_submit");
    } else {
      expect(artifact.content).toContain("mr_blueprint_save");
      expect(artifact.content).toContain("mr_blueprint_safety_gate");
    }
  }
});

test("uses each host's native argument placeholder", () => {
  const artifacts = adapterArtifacts(["cursor-cli", "claude-code", "agy-cli"], "/home/tester");
  const cursorFlow = artifacts.find((artifact) => artifact.path === "/home/tester/.cursor/skills/flow/SKILL.md");
  const claudeFlow = artifacts.find((artifact) => artifact.path === "/home/tester/.claude/commands/flow.md");
  const agyFlow = artifacts.find((artifact) => artifact.path === "/home/tester/.gemini/commands/flow.toml");

  expect(cursorFlow?.content).toContain("disable-model-invocation: true");
  expect(cursorFlow?.invocation).toBe("/flow");
  expect(claudeFlow?.content).toContain("$ARGUMENTS");
  expect(agyFlow?.content).toContain("{{args}}");
  expect(claudeFlow?.content.trimEnd()).toEndWith("---\n[CONTEXT_INPUT_PAYLOAD]\n$ARGUMENTS");
  expect(agyFlow?.content).toContain("[CONTEXT_INPUT_PAYLOAD]\\n{{args}}");
});

test("all native workflow adapters keep context input after static instructions", () => {
  const artifacts = adapterArtifacts([
    "codex-cli",
    "cursor-cli",
    "claude-code",
    "antigravity-desktop",
    "agy-cli",
  ], "/home/tester");

  for (const artifact of artifacts) {
    expect(artifact.content).toContain("[CONTEXT_INPUT_PAYLOAD]");
    expect(artifact.content).not.toContain("Input:");
  }
});

test("creates an explicit model recovery workflow for every host", () => {
  const artifacts = adapterArtifacts([
    "codex-cli",
    "cursor-cli",
    "claude-code",
    "antigravity-desktop",
    "agy-cli",
  ], "/home/tester");
  const modelAdapters = artifacts.filter((artifact) => artifact.path.includes("flow-models"));

  expect(modelAdapters).toHaveLength(5);
  for (const artifact of modelAdapters) {
    expect(artifact.content).toContain("mr_models");
    expect(artifact.content).toContain("action=candidates");
    expect(artifact.content).toContain("explicit confirmation");
    expect(artifact.content).toContain("Never claim that a candidate has available quota");
  }
});

test("preserves isolated role responsibilities in flow adapters", () => {
  const artifacts = adapterArtifacts(["codex-cli", "cursor-cli", "antigravity-desktop", "agy-cli"], "/home/tester");
  const flowAdapters = artifacts.filter((artifact) => /(?:\/|^)flow(?:\.|\/)/.test(artifact.path));

  for (const artifact of flowAdapters) {
    expect(artifact.content).toContain("independent role pass");
    expect(artifact.content).toContain("explore role");
    expect(artifact.content).toContain("plan role");
    expect(artifact.content).toContain("judge-a role");
    expect(artifact.content).toContain("judge-b role");
    expect(artifact.content).toContain("fix role");
  }
});
