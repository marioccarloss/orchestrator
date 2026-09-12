import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { capabilityPaths, defaultCapabilitySelection, loadCapabilitySelection, recommendedMcpServers, saveCapabilitySelection } from "../src/core/capabilities.js";
import { resolvePaths } from "../src/core/paths.js";

test("recommended capability catalog is complete and uses isolated absolute binaries", () => {
  const paths = resolvePaths({ HOME: "/tmp/mr-capabilities-home" });
  const servers = recommendedMcpServers(paths);
  assert.deepEqual(Object.keys(servers), [
    "codebase-memory", "codegraph", "context7", "engram", "github", "jira", "figma-live",
  ]);
  for (const name of ["codebase-memory", "codegraph", "engram", "figma-live"]) {
    assert.match(servers[name]?.command?.[0] ?? "", /^\/tmp\/mr-capabilities-home\/\.local\/share\/mr-orchestrator\/capabilities\//u);
  }
  assert.equal(servers["context7"]?.url, "https://mcp.context7.com/mcp");
  assert.equal(servers["github"]?.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(servers["jira"]?.url, "https://mcp.atlassian.com/v1/mcp/authv2");
});

test("capability installer pins sources and verifies every download", async () => {
  const script = await readFile(new URL("../scripts/install-capabilities.sh", import.meta.url), "utf8");
  assert.match(script, /v0\.10\.8/u);
  assert.match(script, /v1\.6\.0/u);
  assert.match(script, /v1\.20\.0/u);
  assert.match(script, /download_verified/u);
  assert.match(script, /marioccarloss\/figma-live-mcp/u);
  assert.match(script, /ayghri\/i-have-adhd/u);
  assert.doesNotMatch(script, /releases\/latest/u);
});

test("ADHD and Figma paths remain inside the isolated capability root", () => {
  const paths = resolvePaths({ HOME: "/tmp/mr-capabilities-home" });
  const capability = capabilityPaths(paths);
  assert.match(capability.adhdSkill, /capabilities\/i-have-adhd\/.+\/skills\/i-have-adhd\/SKILL\.md$/u);
  assert.match(capability.figmaPluginManifest, /capabilities\/figma-live-mcp\/.+\/packages\/figma-plugin\/manifest\.json$/u);
});

test("capability selection persists deferred services and credential readiness", async () => {
  const home = await mkdtemp(join(tmpdir(), "mr-capability-selection-"));
  const paths = resolvePaths({ HOME: home });
  const selection = {
    ...defaultCapabilitySelection(new Date("2026-09-12T00:00:00.000Z")),
    selected: ["i-have-adhd", "github"] as const,
    credentials: { github: "ready" as const, jira: "pending" as const },
  };
  await saveCapabilitySelection(paths, selection);
  assert.deepEqual(await loadCapabilitySelection(paths), selection);
  assert.deepEqual(Object.keys(recommendedMcpServers(paths, selection.selected)), ["github"]);
});
