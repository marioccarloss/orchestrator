import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenCodeConfig } from "../src/core/config.js";
import type { ModelMap, WorkspaceProfile } from "../src/core/schema.js";

const model = "github-copilot/gpt-5.6-sol";
const models: ModelMap = {
  schemaVersion: 1,
  roles: {
    orchestrator: model,
    explore: model,
    plan: model,
    general: model,
    sddApply: model,
    judgeA: model,
    judgeB: model,
    fix: model,
    bpExtractor: model,
    bpArchitect: model,
    bpTransactor: model,
  },
};
const profile: WorkspaceProfile = {
  schemaVersion: 1,
  id: "sample-12345678",
  name: "sample",
  root: "/workspace",
  contextRoot: "/workspace/.aicontext",
};

void test("generated opencode config exposes a primary orchestrator and internal roster", () => {
  const config = buildOpenCodeConfig(profile, models, "/generated") as {
    default_agent: string;
    disabled_providers?: string[];
    command: Record<string, { description?: string; agent?: string; template?: string }>;
    agent: Record<string, { mode: string; permission?: Record<string, string | Record<string, string>> }>;
  };
  const orchestrator = config.agent["orchestrator"];
  assert.ok(orchestrator);
  assert.equal(config.default_agent, "orchestrator");
  assert.deepEqual(config.disabled_providers, ["openrouter"]);
  assert.equal(orchestrator.mode, "primary");
  assert.equal(orchestrator.permission?.["*"], "allow");
  assert.equal(Object.keys(config.agent).length, 11);

  const subagents = [
    "mr-explore",
    "mr-plan",
    "mr-general",
    "mr-sdd-apply",
    "mr-judge-a",
    "mr-judge-b",
    "mr-fix",
    "bp-extractor",
    "bp-transactor",
  ];
  for (const name of subagents) {
    assert.equal(config.agent[name]?.mode, "subagent", `${name} should be subagent`);
  }
  assert.equal(config.agent["bp-architect"]?.mode, "primary", "bp-architect should be primary");
});

void test("orchestrator has full autonomy except push and ticket commenting", () => {
  const config = buildOpenCodeConfig(profile, models, "/generated") as {
    agent: Record<string, { permission?: Record<string, string | Record<string, string>> }>;
  };
  const permission = config.agent["orchestrator"]?.permission;
  assert.ok(permission);

  // Broad allow must come first so the narrower "ask" rules win (last match).
  assert.equal(Object.keys(permission)[0], "*");
  assert.equal(permission["*"], "allow");
  assert.equal(permission["external_directory"], "allow");
  assert.equal(permission["*comment*"], "ask");

  const bash = permission["bash"] as Record<string, string>;
  assert.equal(Object.keys(bash)[0], "*");
  assert.equal(bash["*"], "allow");
  assert.equal(bash["git push*"], "ask");
  assert.equal(bash["gh pr comment*"], "ask");
  assert.equal(bash["gh issue comment*"], "ask");
});

void test("generated opencode config registers all 7 commands with correct agent assignments", () => {
  const config = buildOpenCodeConfig(profile, models, "/generated") as {
    command: Record<string, { description?: string; agent?: string; template?: string }>;
  };

  const expectedCommands: Record<string, string> = {
    "flow": "orchestrator",
    "blueprint": "bp-architect",
    "atlas": "build",
    "trace": "build",
    "propose": "build",
    "prompt": "build",
    "flow-models": "orchestrator",
  };

  for (const [cmd, expectedAgent] of Object.entries(expectedCommands)) {
    const cmdConfig = config.command[cmd];
    assert.ok(cmdConfig, `Command /${cmd} must be registered in generated config`);
    assert.equal(cmdConfig.agent, expectedAgent, `Command /${cmd} must be mapped to agent '${expectedAgent}'`);
    assert.ok(cmdConfig.description && cmdConfig.description.length > 0, `Command /${cmd} must have a description`);
    assert.ok(cmdConfig.template && cmdConfig.template.length > 0, `Command /${cmd} must have a template`);
  }
});

void test("generated config safely merges workspace MCPs and resolves workspace instructions", () => {
  const mcp = {
    engram: { type: "local", command: ["engram", "mcp"], enabled: true },
  };
  const config = buildOpenCodeConfig(profile, models, "/generated", {
    instructions: [".opencode/instructions/*.md", "/shared/AGENTS.md", 42],
    mcp,
  }) as { instructions: string[]; mcp: unknown; agent: Record<string, unknown> };

  assert.deepEqual(config.instructions, [
    "/workspace/AGENTS.md",
    "/workspace/.opencode/instructions/*.md",
    "/shared/AGENTS.md",
  ]);
  assert.deepEqual(config.mcp, mcp);
  assert.ok(config.agent["orchestrator"]);
});
