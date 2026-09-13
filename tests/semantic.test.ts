import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectService, resolveTypeScriptCallEdges } from "../src/core/semantic/typescript.js";
import { applyPhpSemanticResult, inspectPhpSemantics } from "../src/core/semantic/php.js";
import type { AtlasGraph, AtlasNode } from "../src/core/atlas.js";

test("TypeScript project service resolves references, callers and types for a target symbol", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-semantic-ts-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", target: "ES2023" }, include: ["src/**/*.ts"] }));
    await writeFile(join(root, "src", "target.ts"), "export function target(value: number): string { return String(value); }\n");
    await writeFile(join(root, "src", "caller.ts"), "import { target } from './target.js';\nexport function caller(): string { return target(1); }\n");
    const startedAt = Date.now();
    const service = createProjectService(join(root, "tsconfig.json"));
    const references = service.findReferences("src/target.ts", "target");
    assert.ok(references.some((reference) => reference.file === "src/caller.ts"));
    const callers = service.getCallers("src/target.ts", "target");
    assert.ok(callers.some((caller) => caller.name === "caller" && caller.file === "src/caller.ts"));
    assert.match(service.getTypeAtSymbol("src/target.ts", "target").display, /function target|target\(value/u);
    const atlasNode = (id: string, name: string, filePath: string): AtlasNode => ({ id, name, kind: "function", filePath, line: 1, column: 0, exports: [], imports: [], dependencies: [], dependents: [], metadata: {} });
    const target = atlasNode("target", "target", "repo/src/target.ts");
    const caller = atlasNode("caller", "caller", "repo/src/caller.ts");
    const graph: AtlasGraph = {
      schemaVersion: 2, generatedAt: "2026-09-13T00:00:00.000Z", workspaceRoot: root,
      nodes: [target, caller], edges: [], files: [],
      coverage: { indexerVersion: "2.2.0", supportedLanguages: [], unsupportedFiles: [], parseErrors: [], unresolvedImports: [] },
      stats: { totalFiles: 2, totalNodes: 2, totalEdges: 0, indexDurationMs: 1 },
    };
    assert.deepEqual(resolveTypeScriptCallEdges(graph, target, callers, "repo"), [{ from: "caller", to: "target", type: "calls" }]);
    assert.ok(Date.now() - startedAt < 3_000, "bounded semantic lookup should complete within 3 seconds");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(join(root, "src", "target.ts"), "export function target(value: string): number { return value.length; }\n");
    assert.match(service.getTypeAtSymbol("src/target.ts", "target").display, /value: string/u);
    service.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PHP semantic inspection degrades explicitly without optional tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-semantic-php-none-"));
  try {
    assert.deepEqual(inspectPhpSemantics(root, ["src/A.php"]), {
      mode: "syntactic-only",
      diagnostics: [],
      routes: [],
      services: [],
      errors: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PHP semantic inspection parses available phpstan JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "mr-semantic-phpstan-"));
  try {
    const executable = join(root, "vendor", "bin", "phpstan");
    await mkdir(join(root, "vendor", "bin"), { recursive: true });
    await writeFile(executable, `#!/bin/sh
printf '%s' '{"files":{"src/A.php":{"messages":[{"message":"Bad type","line":7}]}}}'
`);
    await chmod(executable, 0o755);
    const result = inspectPhpSemantics(root, ["src/A.php"], { timeoutMs: 1_000 });
    assert.equal(result.mode, "full");
    assert.equal(result.tool, "phpstan");
    assert.deepEqual(result.diagnostics, [{ file: "src/A.php", line: 7, message: "Bad type", tool: "phpstan" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PHP console introspection adds route and DI edges and semantic coverage", async () => {
  const node = (id: string, name: string): AtlasNode => ({ id, name, kind: "class", filePath: `src/${name}.php`, line: 1, column: 0, exports: [], imports: [], dependencies: [], dependents: [], metadata: {} });
  const controller = node("controller", "OrderController");
  const service = node("service", "OrderService");
  const graph: AtlasGraph = {
    schemaVersion: 2, generatedAt: "2026-09-13T00:00:00.000Z", workspaceRoot: "/repo", nodes: [controller, service], edges: [], files: [],
    coverage: { indexerVersion: "2.2.0", supportedLanguages: ["php"], unsupportedFiles: [], parseErrors: [], unresolvedImports: [], semantic: "syntactic-only" },
    stats: { totalFiles: 2, totalNodes: 2, totalEdges: 0, indexDurationMs: 1 },
  };
  const enriched = applyPhpSemanticResult(graph, {
    mode: "full", tool: "phpstan", diagnostics: [{ file: "src/OrderController.php", line: 4, message: "Example", tool: "phpstan" }], errors: [],
    routes: [{ name: "orders", detail: { path: "/api/orders", defaults: { _controller: "App\\Controller\\OrderController::index" } } }],
    services: [{ name: "App\\OrderService", detail: { class: "App\\OrderService" } }],
  }, "src/OrderController.php");
  const route = enriched.nodes.find((candidate) => candidate.kind === "route" && candidate.name === "/api/orders");
  const binding = enriched.nodes.find((candidate) => candidate.kind === "contract" && candidate.name === "App\\OrderService");
  assert.ok(route);
  assert.ok(binding);
  assert.ok(enriched.edges.some((edge) => edge.from === route.id && edge.to === controller.id && edge.type === "calls"));
  assert.ok(enriched.edges.some((edge) => edge.from === service.id && edge.to === binding.id && edge.type === "implements"));
  assert.equal(enriched.coverage.semantic, "full");
  assert.equal(enriched.coverage.semanticDiagnostics?.length, 1);
});
