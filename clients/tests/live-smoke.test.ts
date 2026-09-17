import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const initialRoles = {
  orchestrator: "github-copilot/kimi-k3",
  explore: "github-copilot/gemini-3.7-flash",
  plan: "github-copilot/gpt-5.6-sol",
  general: "github-copilot/kimi-k3",
  sddApply: "github-copilot/gpt-5.6-sol",
  judgeA: "github-copilot/grok-4.6",
  judgeB: "github-copilot/claude-opus-5",
  fix: "github-copilot/gpt-5.6-sol",
  bpExtractor: "github-copilot/gpt-4o-mini",
  bpArchitect: "github-copilot/gemini-3.8-flash",
  bpTransactor: "github-copilot/gpt-4o-mini",
};

test("persists a confirmed model change after recreating the real plugin bridge", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "mr-clients-live-smoke-"));
  const configRoot = join(sandbox, "config", "mr-orchestrator");
  const workspacePath = join(sandbox, "workspace");
  await mkdir(configRoot, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  const repositoryModels = JSON.parse(await readFile(resolve("..", "models.json"), "utf8")) as {
    roles: Record<string, { model: string; variant?: string; alternative: { model: string; variant?: string } }>;
  };
  const fixtureRoles = Object.fromEntries(Object.entries(repositoryModels.roles).map(([role, assignment]) => [
    role,
    { ...assignment, model: initialRoles[role as keyof typeof initialRoles] },
  ]));
  await writeFile(join(configRoot, "models.json"), `${JSON.stringify({ schemaVersion: 1, roles: fixtureRoles }, null, 2)}\n`);
  const modelIds = new Set([
    ...Object.values(initialRoles),
    ...Object.values(repositoryModels.roles).flatMap((assignment) => [assignment.model, assignment.alternative.model]),
  ]);
  const catalogPath = join(configRoot, "harnesses", "cursor", "catalog.json");
  await mkdir(join(configRoot, "harnesses", "cursor"), { recursive: true });
  await writeFile(catalogPath, `${JSON.stringify({
    schemaVersion: 1,
    harness: "cursor",
    applicationMode: "per-invocation",
    models: Object.fromEntries([...modelIds].map((model) => [model, {
      nativeModel: model,
      variants: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
    }])),
    provenance: { source: "explicit" },
  }, null, 2)}\n`);

  try {
    const bridgeUrl = pathToFileURL(resolve("src/bridge.ts")).href;
    const facadeUrl = pathToFileURL(resolve("src/facade.ts")).href;
    const script = `
      import { createBridge } from ${JSON.stringify(bridgeUrl)};
      import { loadPluginFacade } from ${JSON.stringify(facadeUrl)};
      const workspaces = [{ id: "smoke", path: ${JSON.stringify(workspacePath)} }];
      const first = createBridge(loadPluginFacade, "cursor", workspaces);
      await first.call("mr_bind_workspace", { workspaceId: "smoke" });
      const candidates = await first.call("mr_models", {
        action: "candidates",
        role: "explore",
        failedModel: "github-copilot/gemini-3.7-flash",
      });
      await first.call("mr_models", {
        action: "set",
        role: "explore",
        model: "github-copilot/gpt-5.6-sol",
      });
      const second = createBridge(loadPluginFacade, "cursor", workspaces);
      await second.call("mr_bind_workspace", { workspacePath: ${JSON.stringify(workspacePath)} });
      const status = await second.call("mr_models", { action: "status" });
      console.log(JSON.stringify({ candidates, status }));
    `;
    const processHandle = Bun.spawn([process.execPath, "--eval", script], {
      cwd: resolve("."),
      env: {
        ...process.env,
        HOME: sandbox,
        XDG_CONFIG_HOME: join(sandbox, "config"),
        XDG_DATA_HOME: join(sandbox, "data"),
        XDG_CACHE_HOME: join(sandbox, "cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Model Candidates");
    expect(stdout).toContain("github-copilot/gpt-5.6-sol");

    const persisted = JSON.parse(await readFile(join(configRoot, "models.json"), "utf8")) as {
      roles: Record<string, { model: string }>;
    };
    expect(persisted.roles["explore"]?.model).toBe(initialRoles.explore);
    expect(persisted.roles["plan"]?.model).toBe(initialRoles.plan);
    expect(persisted.roles["fix"]?.model).toBe(initialRoles.fix);
    const override = JSON.parse(await readFile(join(configRoot, "harnesses", "cursor", "models.json"), "utf8")) as {
      roles: Record<string, { primary?: { model: string } }>;
    };
    expect(override.roles["explore"]?.primary?.model).toBe("github-copilot/gpt-5.6-sol");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
