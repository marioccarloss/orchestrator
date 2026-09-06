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
  await runInstaller(`await install(["codex-cli", "cursor-cli", "claude-code", "antigravity-desktop", "agy-cli"]);`);

  expect(await readFile(join(sandbox, ".cursor", "skills", "flow", "SKILL.md"), "utf8")).toBe(customCursorFlow);
  expect(await readFile(join(sandbox, ".cursor", "skills", "blueprint", "SKILL.md"), "utf8")).toContain("/blueprint");
  expect(await readFile(join(sandbox, ".claude", "commands", "flow.md"), "utf8")).toContain("mr_flow_status");
  expect(await readFile(join(sandbox, ".codex", "skills", "blueprint", "SKILL.md"), "utf8")).toContain("$blueprint");
  expect(await readFile(join(sandbox, ".codex", "skills", "flow", "SKILL.md"), "utf8")).toContain("$flow");
  expect(await readFile(join(sandbox, ".gemini", "commands", "flow.toml"), "utf8")).toContain("{{args}}");
  expect(await readFile(join(sandbox, ".cursor", "skills", "flow-models", "SKILL.md"), "utf8")).toContain("mr_models");

  const manifest = JSON.parse(await readFile(join(sandbox, "data", "mr-orchestrator-clients", "manifest.json"), "utf8")) as {
    entries: Array<{ kind?: string; path: string }>;
  };
  expect(manifest.entries.filter((entry) => entry.kind === "config")).toHaveLength(4);
  expect(manifest.entries.filter((entry) => entry.kind === "artifact")).toHaveLength(14);

  await runInstaller("await uninstall(false);");

  expect(await readFile(join(sandbox, ".cursor", "skills", "flow", "SKILL.md"), "utf8")).toBe(customCursorFlow);
  await expect(readFile(join(sandbox, ".claude", "commands", "flow.md"), "utf8")).rejects.toThrow();
  const remainingManifest = JSON.parse(await readFile(join(sandbox, "data", "mr-orchestrator-clients", "manifest.json"), "utf8")) as {
    entries: unknown[];
  };
  expect(remainingManifest.entries).toEqual([]);
});
