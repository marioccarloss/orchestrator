import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CAPABILITY_VERSIONS, capabilityPaths } from "../src/core/capabilities.js";
import { assessFigmaSetup, publishFigmaManifest } from "../src/core/figma-setup.js";
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
    capabilitiesRoot: join(root, "data", "capabilities"),
  };
}

test("publishFigmaManifest copies source manifest to config path", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-figma-setup-"));
  const paths = makePaths(root);
  const sourceDir = join(paths.capabilitiesRoot!, "figma-live-mcp", CAPABILITY_VERSIONS.figmaLive, "packages", "figma-plugin");
  await mkdir(sourceDir, { recursive: true });
  const source = join(sourceDir, "manifest.json");
  await writeFile(source, "{\"name\":\"mr-figma\"}");
  const published = await publishFigmaManifest(paths);
  assert.equal(published, join(paths.configRoot, "figma-live", "manifest.json"));
  const status = await assessFigmaSetup(paths);
  assert.equal(status.manifestPublishedOk, true);
  await rm(root, { recursive: true, force: true });
});
