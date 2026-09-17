import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { agentDefinitions, buildGlobalDefinitionFiles, buildOpenCodeConfig, commandDefinitions } from "../src/core/config.js";
import { resolvePaths } from "../src/core/paths.js";
import type { ModelMap, WorkspaceProfile } from "../src/core/schema.js";

const model = "github-copilot/gpt-5.6-sol";
const assignment = (value: string) => ({
  model: value,
  variant: "high",
  alternative: { model: "opencode-go/deepseek-v4-pro", variant: "high" },
});
const models: ModelMap = {
  schemaVersion: 1,
  roles: {
    orchestrator: assignment(model),
    explore: assignment(model),
    plan: assignment(model),
    general: assignment(model),
    sddApply: assignment(model),
    judgeA: assignment(model),
    judgeB: assignment(model),
    fix: assignment(model),
    bpExtractor: assignment(model),
    bpArchitect: assignment(model),
    bpTransactor: assignment(model),
  },
};
const profile: WorkspaceProfile = {
  schemaVersion: 1,
  id: "sample-12345678",
  name: "sample",
  root: "/workspace",
  contextRoot: "/workspace/.aicontext",
};

void test("generated opencode config keeps normal development as default and exposes the internal roster", () => {
  const config = buildOpenCodeConfig(profile, models, "/generated") as {
    default_agent: string;
    disabled_providers?: string[];
    command: Record<string, { description?: string; agent?: string; template?: string }>;
    agent: Record<string, { mode: string; variant?: string; temperature?: number; top_p?: number; permission?: Record<string, string | Record<string, string>> }>;
  };
  const orchestrator = config.agent["orchestrator"];
  assert.ok(orchestrator);
  assert.equal(config.default_agent, "build");
  assert.deepEqual(config.disabled_providers, ["openrouter"]);
  assert.equal(orchestrator.mode, "primary");
  assert.equal(orchestrator.variant, "high");
  assert.equal(orchestrator.temperature, 0);
  assert.equal(orchestrator.top_p, 1);
  assert.equal(orchestrator.permission?.["*"], "allow");
  assert.equal(Object.keys(config.agent).length, 11);
  assert.equal(config.command["flow"]?.agent, "orchestrator", "/flow must dispatch internally without a manual mode switch");

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

void test("all command templates keep one variable payload at the final cache boundary", () => {
  const alternateModels: ModelMap = {
    ...models,
    roles: Object.fromEntries(
      Object.keys(models.roles).map((role) => [role, assignment(`alternate/${role}`)]),
    ) as ModelMap["roles"],
  };
  const commands = commandDefinitions(models);
  const alternateCommands = commandDefinitions(alternateModels);
  const suffix = "---\n[CONTEXT_INPUT_PAYLOAD]\n$ARGUMENTS";

  for (const [name, command] of Object.entries(commands)) {
    assert.equal(command.template.match(/\$ARGUMENTS/gu)?.length, 1, `/${name} must contain one payload variable`);
    assert.ok(command.template.endsWith(suffix), `/${name} must place the variable payload at the end`);
    if (command.agent === "build") {
      assert.ok(command.template.includes("INSUFFICIENT_EVIDENCE"), `/${name} must ground the built-in build agent`);
    }
    assert.equal(command.template, alternateCommands[name]?.template, `/${name} must not embed model assignments`);
  }
});

void test("flow agent prompts are defined and invariant across model assignments", () => {
  const alternateModels: ModelMap = {
    ...models,
    roles: Object.fromEntries(
      Object.keys(models.roles).map((role) => [role, assignment(`alternate/${role}`)]),
    ) as ModelMap["roles"],
  };
  const agents = agentDefinitions(models);
  const alternateAgents = agentDefinitions(alternateModels);
  const names = [
    "orchestrator",
    "mr-explore",
    "mr-plan",
    "mr-general",
    "mr-sdd-apply",
    "mr-judge-a",
    "mr-judge-b",
    "mr-fix",
  ];

  for (const name of names) {
    assert.ok(agents[name]?.prompt, `${name} must define a frozen prompt`);
    assert.equal(agents[name]?.prompt, alternateAgents[name]?.prompt, `${name} prompt must not embed model state`);
    assert.equal(agents[name]?.temperature, 0, `${name} must use deterministic temperature`);
    assert.equal(agents[name]?.top_p, 1, `${name} must avoid extra nucleus sampling constraints`);
    assert.ok(agents[name]?.prompt?.includes("INSUFFICIENT_EVIDENCE"), `${name} must include the grounding sentinel`);
  }

  assert.ok(agents["mr-explore"]?.prompt?.includes("Controlled output examples"));
  assert.ok(agents["mr-plan"]?.prompt?.includes("Blueprint-lite"));
  assert.ok(agents["mr-plan"]?.prompt?.includes("NEEDS_INPUT"));
  assert.ok(agents["orchestrator"]?.prompt?.includes("OpenCode-estimated spend"));
  assert.ok(agents["orchestrator"]?.prompt?.includes("ONLY Flow role allowed to explain"));
  assert.ok(agents["orchestrator"]?.prompt?.includes("lead with the next action"));
  assert.ok(commandDefinitions(models)["flow"]?.template.includes("exactly one `mr-general` session"));
  assert.ok(agents["orchestrator"]?.prompt?.includes("A confirmed fast lane never launches judges or a second planning/implementation child session"));
  assert.ok(agents["mr-general"]?.prompt?.includes("Fast-local combined mode"));
  for (const name of ["mr-general", "mr-sdd-apply", "mr-judge-a", "mr-judge-b", "mr-fix"]) {
    assert.ok(agents[name]?.prompt?.includes("not a user-facing narrator"), `${name} must stay internal`);
  }
  for (const name of ["mr-general", "mr-sdd-apply", "mr-fix"]) {
    assert.ok(agents[name]?.prompt?.includes("mr_internal_receipt"), `${name} must use a typed internal receipt`);
    assert.ok(agents[name]?.prompt?.includes("exactly the minified JSON"), `${name} must not add prose to its receipt`);
  }
  assert.ok(commandDefinitions(models)["flow"]?.template.includes("developerNote"));
  assert.ok(agents["mr-judge-a"]?.prompt?.includes("Controlled verdict examples"));
  assert.ok(agents["mr-judge-b"]?.prompt?.includes("Controlled verdict examples"));
  assert.ok(agents["bp-extractor"]?.prompt?.includes("mr_atlas_profile"));
});

void test("internal command and agent prompts stay in English and delegate user-facing language", () => {
  const spanishLiteral = /[¿¡ñáéíóú]|\b(?:aterrizar|analizar|preguntas|supuestos|guardar|copiar|tarea|flujo)\b/iu;
  const commands = commandDefinitions(models);
  for (const [name, command] of Object.entries(commands)) {
    assert.doesNotMatch(command.template, spanishLiteral, `/${name} template must stay in English`);
    assert.doesNotMatch(command.description, spanishLiteral, `/${name} description must stay in English`);
  }
  const agents = agentDefinitions(models);
  for (const [name, agent] of Object.entries(agents)) {
    if (agent.prompt !== undefined) assert.doesNotMatch(agent.prompt, spanishLiteral, `${name} prompt must stay in English`);
  }
  assert.match(agents["orchestrator"]?.prompt ?? "", /Explain to the user in FlowState\.userLanguage/u);
  assert.match(agents["bp-architect"]?.prompt ?? "", /pass it as userLanguage/u);
});

void test("global agent definitions serialize deterministic sampling settings", () => {
  const paths = resolvePaths({ HOME: "/tmp/mr-grounding-config" });
  const files = buildGlobalDefinitionFiles(paths, models);
  const explore = files.get(join(paths.opencodeAgentsRoot, "mr-explore.md"));
  assert.ok(explore);
  assert.match(explore, /^temperature: 0$/mu);
  assert.match(explore, /^top_p: 1$/mu);
  assert.ok(explore.includes("INSUFFICIENT_EVIDENCE"));
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

void test("workspace config installs recommended MCPs while preserving user overrides", () => {
  const paths = resolvePaths({ HOME: "/tmp/mr-config-capabilities" });
  const config = buildOpenCodeConfig(profile, models, paths.generatedRoot, {
    mcp: {
      github: { type: "remote", url: "https://custom.example/mcp", headers: { Authorization: "preserved" } },
    },
  }, paths) as {
    mcp: Record<string, { url?: string; command?: string[]; headers?: Record<string, string> }>;
    plugin: string[];
  };
  assert.equal(Object.keys(config.mcp).length, 7);
  assert.equal(config.mcp["github"]?.url, "https://custom.example/mcp");
  assert.equal(config.mcp["github"]?.headers?.["Authorization"], "preserved");
  assert.match(config.mcp["figma-live"]?.command?.[0] ?? "", /figma-live-mcp/u);
  assert.match(config.plugin[0] ?? "", /i-have-adhd/u);
});

void test("workspace config omits deferred capabilities", () => {
  const paths = resolvePaths({ HOME: "/tmp/mr-config-deferred" });
  const config = buildOpenCodeConfig(profile, models, paths.generatedRoot, {}, paths, ["engram"]) as {
    mcp: Record<string, unknown>;
    plugin: string[];
  };
  assert.deepEqual(Object.keys(config.mcp), ["engram"]);
  assert.doesNotMatch(config.plugin.join("\n"), /i-have-adhd/u);
});
