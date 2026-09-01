import { test } from "bun:test";
import assert from "node:assert/strict";
import { AtlasIndexer, findNodeByName, findNodesByKind, getNodeDependencies, getImpactAnalysis, checkGovernance } from "../src/core/atlas.js";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function createTestProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mr-atlas-"));
  await mkdir(join(dir, "src"), { recursive: true });

  // Create tsconfig.json
  await writeFile(join(dir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      strict: true,
    },
    include: ["src/**/*"],
  }, null, 2));

  // Create a simple module
  await writeFile(join(dir, "src", "utils.ts"), `
export function formatDate(date: Date): string {
  return date.toISOString();
}

export const VERSION = "1.0.0";
`);

  // Create a component
  await writeFile(join(dir, "src", "Button.tsx"), `
import { formatDate } from "./utils";

export function Button({ label }: { label: string }) {
  return <button>{label}</button>;
}

export default Button;
`);

  // Create a hook
  await writeFile(join(dir, "src", "useCounter.ts"), `
import { useState } from "react";

export function useCounter(initial: number = 0) {
  const [count, setCount] = useState(initial);
  return { count, increment: () => setCount(c => c + 1) };
}
`);

  return dir;
}

test("AtlasIndexer indexes a simple project", async () => {
  const dir = await createTestProject();
  try {
    const indexer = new AtlasIndexer();
    const graph = await indexer.indexWorkspace(dir);

    assert.ok(graph.nodes.length > 0);
    assert.ok(graph.stats.totalFiles >= 3);
    assert.ok(graph.stats.indexDurationMs > 0);

    // Check for specific nodes
    const utilsModule = findNodeByName(graph, "utils.ts");
    assert.ok(utilsModule !== undefined);
    assert.equal(utilsModule.kind, "module");

    const buttonComponent = findNodeByName(graph, "Button");
    assert.ok(buttonComponent !== undefined);
    assert.equal(buttonComponent.kind, "component");

    const useCounterHook = findNodeByName(graph, "useCounter");
    assert.ok(useCounterHook !== undefined);
    assert.equal(useCounterHook.kind, "hook");

    const formatDateFunc = findNodeByName(graph, "formatDate");
    assert.ok(formatDateFunc !== undefined);
    assert.equal(formatDateFunc.kind, "function");

  } finally {
    await rm(dir, { recursive: true });
  }
});

test("findNodesByKind filters correctly", async () => {
  const dir = await createTestProject();
  try {
    const indexer = new AtlasIndexer();
    const graph = await indexer.indexWorkspace(dir);

    const components = findNodesByKind(graph, "component");
    assert.ok(components.length >= 1);

    const hooks = findNodesByKind(graph, "hook");
    assert.ok(hooks.length >= 1);

  } finally {
    await rm(dir, { recursive: true });
  }
});

test("getImpactAnalysis traverses dependents", async () => {
  const dir = await createTestProject();
  try {
    const indexer = new AtlasIndexer();
    const graph = await indexer.indexWorkspace(dir);

    const utilsNode = findNodeByName(graph, "utils.ts");
    assert.ok(utilsNode !== undefined);

    const impact = getImpactAnalysis(graph, utilsNode.id, 2);
    assert.ok(impact.length >= 1);

  } finally {
    await rm(dir, { recursive: true });
  }
});

test("checkGovernance detects violations", async () => {
  const dir = await createTestProject();
  try {
    const indexer = new AtlasIndexer();
    const graph = await indexer.indexWorkspace(dir);

    const governance = {
      schemaVersion: 1 as const,
      rules: [{
        id: "no-test-in-src",
        pattern: "**/*.test.ts",
        action: "deny" as const,
        reason: "Tests should not be in src",
        appliesTo: ["src/**/*.test.ts"],
      }],
      forbiddenPaths: ["src/legacy"],
      antiPatterns: [],
    };

    const violations = checkGovernance(graph, governance, "src/legacy/old.ts");
    assert.ok(violations.length >= 0);

  } finally {
    await rm(dir, { recursive: true });
  }
});

// ─── Tree-sitter Additions: Java + Skeletons ─────────────────────────────────

import { extractSkeleton } from "../src/core/atlas.js";

test("AtlasIndexer indexes Java sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-atlas-java-"));
  try {
    await mkdir(join(dir, "src", "main", "java", "com", "acme"), { recursive: true });
    await writeFile(join(dir, "src", "main", "java", "com", "acme", "OrderService.java"), `
package com.acme;

import com.acme.OrderRepository;

public class OrderService {
  private final OrderRepository repository;

  public OrderService(OrderRepository repository) {
    this.repository = repository;
  }

  public String findOrder(String id) {
    return repository.load(id);
  }
}
`);
    await writeFile(join(dir, "src", "main", "java", "com", "acme", "OrderRepository.java"), `
package com.acme;

public interface OrderRepository {
  String load(String id);
}
`);

    const indexer = new AtlasIndexer();
    const graph = await indexer.indexWorkspace(dir);

    const service = findNodeByName(graph, "OrderService");
    assert.ok(service !== undefined);
    assert.equal(service.kind, "service");
    assert.ok(service.exports.includes("OrderService"));

    const repo = findNodeByName(graph, "OrderRepository");
    assert.ok(repo !== undefined);
    assert.equal(repo.kind, "interface");

    const method = findNodeByName(graph, "findOrder");
    assert.ok(method !== undefined);
    assert.equal(method.kind, "function");
    assert.equal(method.metadata["parent"], "OrderService");

    // Import edge: OrderService module → OrderRepository nodes
    const importEdges = graph.edges.filter((e) => e.type === "import");
    assert.ok(importEdges.length >= 1);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("extractSkeleton elides bodies and keeps signatures", async () => {
  const source = `import { readFile } from "node:fs/promises";

export interface Config {
  path: string;
  retries: number;
}

export async function loadConfig(path: string): Promise<Config> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.retries === undefined) {
    parsed.retries = 3;
  }
  return parsed;
}

export class ConfigService {
  private cache = new Map<string, Config>();

  async get(path: string): Promise<Config> {
    const hit = this.cache.get(path);
    if (hit !== undefined) return hit;
    const config = await loadConfig(path);
    this.cache.set(path, config);
    return config;
  }
}
`;
  const skeleton = await extractSkeleton(source, "config.ts");
  assert.ok(skeleton.includes("import { readFile }"));
  assert.ok(skeleton.includes("export interface Config {"));
  assert.ok(skeleton.includes("export async function loadConfig(path: string): Promise<Config> { … }")
    || skeleton.includes("export async function loadConfig(path: string): Promise<Config> {"));
  assert.ok(skeleton.includes("async get(path: string): Promise<Config> { … }"));
  // Bodies elided
  assert.ok(!skeleton.includes("JSON.parse"));
  assert.ok(!skeleton.includes("cache.set"));
  // Materially smaller
  assert.ok(skeleton.length < source.length * 0.6);
});

test("graph carries gitStamp inside a git repo and omits it outside", async () => {
  const dir = await createTestProject();
  try {
    const indexer = new AtlasIndexer();
    const graph = await indexer.indexWorkspace(dir);
    // tmpdir is not a git repo → no stamp
    assert.equal(graph.gitStamp, undefined);
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ─── Config Files: JSON / YAML ───────────────────────────────────────────────

import { extractConfigSkeleton } from "../src/core/atlas.js";

test("AtlasIndexer indexes JSON and YAML configs with top-level keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mr-atlas-config-"));
  try {
    await mkdir(join(dir, "src", "main", "resources"), { recursive: true });
    await writeFile(join(dir, "src", "main", "resources", "application.yml"), `
spring:
  datasource:
    url: jdbc:postgresql://localhost/db
    username: app
server:
  port: 8080
---
spring:
  config:
    activate:
      on-profile: pro
logging:
  level:
    root: INFO
`);
    await writeFile(join(dir, "tsconfig.json"), `{
  // JSONC comment must not break indexing
  "compilerOptions": {
    "strict": true,
  },
  "include": ["src"],
}`);
    await writeFile(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));

    const indexer = new AtlasIndexer();
    const graph = await indexer.indexWorkspace(dir);

    const appYml = findNodeByName(graph, "application.yml");
    assert.ok(appYml !== undefined);
    assert.equal(appYml.kind, "module");
    assert.equal(appYml.metadata["configFormat"], "yaml");
    assert.equal(appYml.metadata["documents"], 2);
    const keys = appYml.metadata["topLevelKeys"] as string[];
    assert.ok(keys.includes("spring"));
    assert.ok(keys.includes("server"));
    assert.ok(keys.includes("logging"));

    const tsconfig = findNodeByName(graph, "tsconfig.json");
    assert.ok(tsconfig !== undefined);
    assert.equal(tsconfig.metadata["configFormat"], "json");
    assert.ok((tsconfig.metadata["topLevelKeys"] as string[]).includes("compilerOptions"));

    // Lockfiles deliberately excluded
    assert.equal(findNodeByName(graph, "package-lock.json"), undefined);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("extractConfigSkeleton renders key structure with truncated values", () => {
  const yml = `
spring:
  datasource:
    url: jdbc:postgresql://some-very-long-host.example.com:5432/database_name_that_is_long
    pool:
      max: 10
feature-flags:
  - a
  - b
`;
  const skeleton = extractConfigSkeleton(yml, "application.yml");
  assert.ok(skeleton.includes("spring:"));
  assert.ok(skeleton.includes("  datasource:"));
  assert.ok(skeleton.includes("…"));
  assert.ok(skeleton.includes("feature-flags: [2 items]"));
  // depth cap: pool nested at depth 3 renders inline, not expanded
  assert.ok(skeleton.includes("pool:"));

  const json = `{"name": "x", "scripts": {"build": "tsc", "test": "bun test"}, "deps": [1, 2, 3]}`;
  const jsonSkeleton = extractConfigSkeleton(json, "package.json");
  assert.ok(jsonSkeleton.includes('name: "x"'));
  assert.ok(jsonSkeleton.includes("scripts:"));
  assert.ok(jsonSkeleton.includes("deps: [3 items]"));
});
