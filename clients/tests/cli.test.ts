import { expect, test } from "bun:test";
import { resolve } from "node:path";

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
