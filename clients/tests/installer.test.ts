import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let sandbox = "";
let environment: Record<string, string> = {};
const customCursorFlow = "User-owned Cursor flow command\n";
const oldManagedCodexFlow = "Old mr-orchestrator managed Codex flow\n";

async function runInstaller(expression: string): Promise<void> {
  const installerUrl = pathToFileURL(resolve("src/installer.ts")).href;
  const processHandle = Bun.spawn([
    process.execPath,
    "--eval",
    `import { install, uninstall } from ${JSON.stringify(installerUrl)}; ${expression}`,
  ], {
    cwd: resolve("."),
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "mr-clients-"));
  environment = {
    ...process.env,
    HOME: sandbox,
    XDG_CONFIG_HOME: join(sandbox, "config"),
    XDG_DATA_HOME: join(sandbox, "data"),
  };
  const cursorFlowPath = join(sandbox, ".cursor", "skills", "flow", "SKILL.md");
  const codexFlowPath = join(sandbox, ".codex", "skills", "flow", "SKILL.md");
  const manifestPath = join(sandbox, "data", "mr-orchestrator-clients", "manifest.json");
  await mkdir(dirname(cursorFlowPath), { recursive: true });
  await mkdir(dirname(codexFlowPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(cursorFlowPath, customCursorFlow);
  await writeFile(codexFlowPath, oldManagedCodexFlow);
  await writeFile(manifestPath, `${JSON.stringify({
    version: 1,
    entries: [{
      kind: "artifact",
      target: "codex",
      path: codexFlowPath,
      fingerprint: createHash("sha256").update(oldManagedCodexFlow).digest("hex"),
    }],
  }, null, 2)}\n`);
});

afterAll(async () => {
  if (sandbox.length > 0) await rm(sandbox, { recursive: true, force: true });
});

test("installs and uninstalls only owned unchanged adapters", async () => {
  await mkdir(join(sandbox, ".pi", "agent"), { recursive: true });
  await writeFile(join(sandbox, ".pi", "agent", "mcp.json"), '{"mcpServers":{"user":{"command":"user-mcp"}}}\n');
  await runInstaller(`await install(["codex-cli", "cursor-cli", "claude-code", "antigravity-desktop", "agy-cli", "fx-cli", "pi-cli"]);`);

  expect(await readFile(join(sandbox, ".cursor", "skills", "flow", "SKILL.md"), "utf8")).toBe(customCursorFlow);
  expect(await readFile(join(sandbox, ".cursor", "skills", "blueprint", "SKILL.md"), "utf8")).toContain("/blueprint");
  expect(await readFile(join(sandbox, ".cursor", "skills", "work", "SKILL.md"), "utf8")).toContain("mr_work_route");
  expect(await readFile(join(sandbox, ".claude", "commands", "flow.md"), "utf8")).toContain("mr_flow_status");
  expect(await readFile(join(sandbox, ".codex", "skills", "blueprint", "SKILL.md"), "utf8")).toContain("$blueprint");
  expect(await readFile(join(sandbox, ".codex", "skills", "flow", "SKILL.md"), "utf8")).toContain("$flow");
  expect(await readFile(join(sandbox, ".gemini", "commands", "flow.toml"), "utf8")).toContain("{{args}}");
  expect(await readFile(join(sandbox, ".fx", "skills", "flow", "SKILL.md"), "utf8")).toContain("$flow");
  expect(await readFile(join(sandbox, ".pi", "agent", "prompts", "flow.md"), "utf8")).toContain("run-role pi <role>");
  expect(await readFile(join(sandbox, ".pi", "agent", "prompts", "work.md"), "utf8")).toContain("$ARGUMENTS");
  expect(await readFile(join(sandbox, ".cursor", "skills", "flow-models", "SKILL.md"), "utf8")).toContain("mr_models");
  const cursorConfig = JSON.parse(await readFile(join(sandbox, ".cursor", "mcp.json"), "utf8")) as {
    mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }>;
  };
  expect(cursorConfig.mcpServers["mr-orchestrator"]?.args?.slice(-2)).toEqual(["--harness", "cursor"]);
  expect(cursorConfig.mcpServers["mr-orchestrator"]?.env?.["MR_HARNESS_ID"]).toBe("cursor");
  const codexConfig = await readFile(join(sandbox, ".codex", "config.toml"), "utf8");
  expect(codexConfig).toContain('"--harness", "codex"');
  expect(codexConfig).toContain('MR_HARNESS_ID = "codex"');
  const geminiConfig = JSON.parse(await readFile(join(sandbox, ".gemini", "config", "mcp_config.json"), "utf8")) as {
    mcpServers: Record<string, { args?: string[] }>;
  };
  expect(geminiConfig.mcpServers["mr-orchestrator-antigravity"]?.args?.slice(-2)).toEqual(["--harness", "antigravity"]);
  expect(geminiConfig.mcpServers["mr-orchestrator-agy"]?.args?.slice(-2)).toEqual(["--harness", "agy"]);
  const fxConfig = JSON.parse(await readFile(join(sandbox, ".fx", "mcp.json"), "utf8")) as {
    mcp: Record<string, { command?: string[]; environment?: Record<string, string> }>;
  };
  expect(fxConfig.mcp["mr-orchestrator"]?.command?.slice(-2)).toEqual(["--harness", "fx"]);
  expect(fxConfig.mcp["mr-orchestrator"]?.environment?.["MR_HARNESS_ID"]).toBe("fx");
  const piConfigPath = join(sandbox, ".pi", "agent", "mcp.json");
  const piConfig = JSON.parse(await readFile(piConfigPath, "utf8")) as {
    mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };
  expect(piConfig.mcpServers["user"]).toEqual({ command: "user-mcp" });
  expect(piConfig.mcpServers["mr-orchestrator"]?.args?.slice(-2)).toEqual(["--harness", "pi"]);
  expect(piConfig.mcpServers["mr-orchestrator"]?.env?.["MR_HARNESS_ID"]).toBe("pi");
  const fxSettings = JSON.parse(await readFile(join(sandbox, ".fx", "settings.json"), "utf8")) as {
    provider?: string;
    review_model?: string;
    permission_mode?: string;
  };
  expect(fxSettings).toEqual({
    provider: "gateway",
    review_model: "typesafeai/jev",
    permission_mode: "auto",
  });

  const manifest = JSON.parse(await readFile(join(sandbox, "data", "mr-orchestrator-clients", "manifest.json"), "utf8")) as {
    entries: Array<{ kind?: string; path: string }>;
  };
  expect(manifest.entries.filter((entry) => entry.kind === "config")).toHaveLength(7);
  // 7 hosts × 6 workflows, minus the user-customized Cursor flow skill that stays unowned.
  expect(manifest.entries.filter((entry) => entry.kind === "artifact")).toHaveLength(41);

  piConfig.mcpServers["later"] = { args: ["later"] };
  await writeFile(piConfigPath, `${JSON.stringify(piConfig, null, 2)}\n`);

  await runInstaller("await uninstall(false);");

  expect(await readFile(join(sandbox, ".cursor", "skills", "flow", "SKILL.md"), "utf8")).toBe(customCursorFlow);
  await expect(readFile(join(sandbox, ".claude", "commands", "flow.md"), "utf8")).rejects.toThrow();
  const remainingPiConfig = JSON.parse(await readFile(piConfigPath, "utf8")) as { mcpServers: Record<string, unknown> };
  expect(remainingPiConfig.mcpServers["user"]).toEqual({ command: "user-mcp" });
  expect(remainingPiConfig.mcpServers["later"]).toEqual({ args: ["later"] });
  expect(remainingPiConfig.mcpServers["mr-orchestrator"]).toBeUndefined();
  const remainingManifest = JSON.parse(await readFile(join(sandbox, "data", "mr-orchestrator-clients", "manifest.json"), "utf8")) as {
    entries: unknown[];
  };
  expect(remainingManifest.entries).toEqual([]);
});

test("reports a missing user-managed pi-mcp-adapter without installing it", async () => {
  const installerUrl = pathToFileURL(resolve("src/installer.ts")).href;
  const processHandle = Bun.spawn([process.execPath, "--eval", `import { install, doctor } from ${JSON.stringify(installerUrl)}; console.log(JSON.stringify([...(await install(["pi-cli"])), ...(await doctor())]));`], {
    cwd: resolve("."),
    env: { ...environment, PATH: join(sandbox, "empty-bin") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("pi-mcp-adapter");
  expect(stdout).toContain("must be installed and managed by the user");
});
