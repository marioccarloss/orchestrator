import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHarnessModelRosters } from "../src/core/doctor.js";
import type { MrPaths } from "../src/core/paths.js";

function makePaths(root: string): MrPaths {
  return {
    configRoot: join(root, "config"),
    dataRoot: join(root, "data"),
    cacheRoot: join(root, "cache"),
    binRoot: join(root, "bin"),
    registry: join(root, "config", "workspaces.json"),
    models: join(root, "config", "models.json"),
    generatedRoot: join(root, "config", "generated"),
    manifest: join(root, "config", "install-manifest.json"),
    bunRoot: join(root, "data", "toolchains", "bun"),
    bunBinary: join(root, "data", "toolchains", "bun", "bin", "bun"),
    opencodePluginsRoot: join(root, "config", "opencode-plugins"),
    opencodeAgentsRoot: join(root, "config", "opencode-agents"),
    opencodeCommandsRoot: join(root, "config", "opencode-commands"),
  };
}

test("model doctor reports valid OpenCode and invalid configured harnesses independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-doctor-models-"));
  const paths = makePaths(root);
  try {
    await mkdir(join(paths.configRoot, "harnesses", "cursor"), { recursive: true });
    await writeFile(paths.models, await readFile(join(process.cwd(), "models.json"), "utf8"));
    await writeFile(join(paths.configRoot, "harnesses", "cursor", "catalog.json"), JSON.stringify({
      schemaVersion: 1,
      harness: "cursor",
      applicationMode: "unsupported",
      provenance: { source: "explicit" },
      models: {},
    }));

    const checks = await checkHarnessModelRosters(paths);

    assert.equal(checks.find((check) => check.name === "opencode model roster")?.ok, true);
    const cursor = checks.find((check) => check.name === "cursor model roster");
    assert.equal(cursor?.ok, false);
    assert.match(cursor?.detail ?? "", /applicationMode 'unsupported'/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
