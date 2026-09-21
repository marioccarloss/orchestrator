import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveHarnessIdentity } from "../src/harness.js";

test("requires one consistent trusted harness identity", () => {
  expect(resolveHarnessIdentity("cursor", "cursor")).toBe("cursor");
  expect(resolveHarnessIdentity(undefined, "codex")).toBe("codex");
  expect(resolveHarnessIdentity("pi", undefined)).toBe("pi");
  expect(() => resolveHarnessIdentity("cursor", "codex")).toThrow("Conflicting harness identities");
  expect(() => resolveHarnessIdentity(undefined, undefined)).toThrow("A valid --harness is required");
});

test("rejects an unknown non-interactive install target without opening a prompt", async () => {
  const processHandle = Bun.spawn([process.execPath, resolve("src/cli.ts"), "install", "unknown-client"], {
    cwd: resolve("."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);

  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("Unknown install target: unknown-client");
});

test("accepts pi-cli as a non-interactive install target", async () => {
  const sandbox = await Bun.$`mktemp -d`.text();
  const processHandle = Bun.spawn([process.execPath, resolve("src/cli.ts"), "install", "pi-cli"], {
    cwd: resolve("."),
    env: { ...process.env, HOME: sandbox.trim(), XDG_DATA_HOME: `${sandbox.trim()}/data`, XDG_CONFIG_HOME: `${sandbox.trim()}/config`, PATH: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("Unknown install target");
  expect(stdout).toContain("pi-mcp-adapter");
  await Bun.$`rm -rf ${sandbox.trim()}`;
});
