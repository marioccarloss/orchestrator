import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { withAtlasEdges, type AtlasEdge, type AtlasGraph, type AtlasNode } from "../atlas.js";
import { frameworkNode } from "../extractors/utils.js";

export interface PhpDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly tool: "phpstan" | "psalm";
}

export interface PhpSemanticResult {
  readonly mode: "full" | "syntactic-only";
  readonly tool?: "phpstan" | "psalm";
  readonly diagnostics: readonly PhpDiagnostic[];
  readonly routes: readonly Record<string, unknown>[];
  readonly services: readonly Record<string, unknown>[];
  readonly errors: readonly string[];
}

export interface PhpSemanticOptions {
  readonly symfonyConsoleIntrospection?: boolean;
  readonly timeoutMs?: number;
}

function nestedRecord(row: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = row[key];
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function shortPhpName(value: string): string {
  return value.replace(/::.*$/u, "").split("\\").pop() ?? value;
}

/** Attach bounded PHP analyzer/console results to Atlas without requiring optional tooling. */
export function applyPhpSemanticResult(graph: AtlasGraph, result: PhpSemanticResult, fallbackFile: string): AtlasGraph {
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];
  for (const row of result.routes) {
    const detail = nestedRecord(row, "detail");
    const defaults = nestedRecord(detail, "defaults");
    const routePath = row["path"] ?? detail["path"];
    if (typeof routePath !== "string") continue;
    const controllerValue = row["controller"] ?? detail["controller"] ?? defaults["_controller"];
    const controller = typeof controllerValue === "string"
      ? graph.nodes.find((candidate) => candidate.name === shortPhpName(controllerValue))
      : undefined;
    const existing = graph.nodes.find((candidate) => candidate.kind === "route" && candidate.metadata["routePath"] === routePath);
    const route = existing ?? frameworkNode(controller?.filePath ?? fallbackFile, routePath, "route", 1, { routePath, framework: "symfony", source: "console" });
    if (existing === undefined) nodes.push(route);
    if (controller !== undefined) edges.push({ from: route.id, to: controller.id, type: "calls" });
  }
  for (const row of result.services) {
    const detail = nestedRecord(row, "detail");
    const serviceId = row["id"] ?? row["name"];
    const classValue = row["class"] ?? detail["class"] ?? detail["alias"];
    if (typeof serviceId !== "string") continue;
    const implementation = typeof classValue === "string"
      ? graph.nodes.find((candidate) => candidate.name === shortPhpName(classValue))
      : graph.nodes.find((candidate) => candidate.name === shortPhpName(serviceId));
    const binding = frameworkNode(implementation?.filePath ?? fallbackFile, serviceId, "contract", 1, { contractKind: "di-binding", framework: "symfony", source: "console" });
    nodes.push(binding);
    if (implementation !== undefined) edges.push({ from: implementation.id, to: binding.id, type: "implements" });
  }
  const known = new Set(graph.nodes.map((node) => node.id));
  const mergedNodes = [...graph.nodes, ...nodes.filter((node) => !known.has(node.id))];
  return withAtlasEdges({
    ...graph,
    nodes: mergedNodes,
    coverage: {
      ...graph.coverage,
      semantic: result.mode,
      ...(result.diagnostics.length === 0 ? {} : { semanticDiagnostics: result.diagnostics }),
      ...(result.errors.length === 0 ? {} : { semanticErrors: result.errors }),
    },
  }, edges);
}

function executeJson(command: string, arguments_: readonly string[], root: string, timeout: number): { readonly value?: unknown; readonly error?: string } {
  const result = spawnSync(command, [...arguments_], { cwd: root, encoding: "utf8", timeout, maxBuffer: 10 * 1024 * 1024 });
  const text = result.stdout?.trim() ?? "";
  if (result.status !== 0 && text === "") return { error: result.stderr?.trim() || `${command} exited ${String(result.status)}` };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { error: `${command} returned non-JSON output` };
  }
}

function phpStanDiagnostics(value: unknown, tool: "phpstan" | "psalm"): PhpDiagnostic[] {
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (tool === "phpstan") {
    const files = record["files"];
    if (files === null || typeof files !== "object") return [];
    return Object.entries(files as Record<string, unknown>).flatMap(([file, detail]) => {
      const messages = detail !== null && typeof detail === "object" ? (detail as Record<string, unknown>)["messages"] : undefined;
      return Array.isArray(messages) ? messages.flatMap((message) => {
        if (message === null || typeof message !== "object") return [];
        const row = message as Record<string, unknown>;
        return typeof row["message"] === "string"
          ? [{ file, line: typeof row["line"] === "number" ? row["line"] : 1, message: row["message"], tool }]
          : [];
      }) : [];
    });
  }
  const issues = Array.isArray(record["issues"]) ? record["issues"] : Array.isArray(value) ? value : [];
  return issues.flatMap((issue) => {
    if (issue === null || typeof issue !== "object") return [];
    const row = issue as Record<string, unknown>;
    const message = row["message"] ?? row["description"];
    const file = row["file_name"] ?? row["file"];
    if (typeof message !== "string" || typeof file !== "string") return [];
    return [{ file, line: typeof row["line_from"] === "number" ? row["line_from"] : 1, message, tool }];
  });
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
  if (value !== null && typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([name, detail]) => ({ name, detail }));
  return [];
}

export function inspectPhpSemantics(root: string, targetFiles: readonly string[], options: PhpSemanticOptions = {}): PhpSemanticResult {
  const timeout = Math.min(60_000, options.timeoutMs ?? 60_000);
  const phpStan = join(root, "vendor", "bin", "phpstan");
  const psalm = join(root, "vendor", "bin", "psalm");
  const selected = existsSync(phpStan) ? { tool: "phpstan" as const, path: phpStan } : existsSync(psalm) ? { tool: "psalm" as const, path: psalm } : undefined;
  const errors: string[] = [];
  const diagnostics: PhpDiagnostic[] = [];
  if (selected !== undefined && targetFiles.length > 0) {
    const arguments_ = selected.tool === "phpstan"
      ? ["analyse", "--error-format=json", "--no-progress", ...targetFiles]
      : ["--output-format=json", "--no-progress", ...targetFiles];
    const output = executeJson(selected.path, arguments_, root, timeout);
    if (output.error === undefined) diagnostics.push(...phpStanDiagnostics(output.value, selected.tool));
    else errors.push(output.error);
  }

  let routes: readonly Record<string, unknown>[] = [];
  let services: readonly Record<string, unknown>[] = [];
  const consolePath = join(root, "bin", "console");
  if (options.symfonyConsoleIntrospection === true && existsSync(consolePath)) {
    const routeResult = executeJson(consolePath, ["debug:router", "--format=json"], root, timeout);
    const serviceResult = executeJson(consolePath, ["debug:container", "--format=json"], root, timeout);
    if (routeResult.error === undefined) routes = records(routeResult.value); else errors.push(routeResult.error);
    if (serviceResult.error === undefined) services = records(serviceResult.value); else errors.push(serviceResult.error);
  }
  return {
    mode: selected === undefined ? "syntactic-only" : "full",
    ...(selected === undefined ? {} : { tool: selected.tool }),
    diagnostics,
    routes,
    services,
    errors,
  };
}
