import type { AtlasGraph } from "../../atlas.js";
import type { RuleFact } from "../profiler.js";

export interface RepositoryDetectorContext {
  readonly prefix: string;
  readonly paths: readonly string[];
  readonly files: ReadonlyMap<string, string>;
  readonly graph: AtlasGraph;
  readonly dependencies: ReadonlySet<string>;
  readonly scripts: Readonly<Record<string, unknown>>;
  readonly markers: readonly string[];
  readonly recentCommits: readonly string[];
}

export interface DetectorResult {
  readonly facts?: readonly RuleFact[];
  readonly inferences?: readonly RuleFact[];
  readonly gaps?: readonly string[];
}

export type RepositoryDetector = (context: RepositoryDetectorContext) => DetectorResult;

export function detectorFact(id: string, value: string, statement: string, confidence: number, evidence: readonly string[]): RuleFact {
  return { id, value, statement, confidence: Math.max(0, Math.min(1, confidence)), evidence: evidence.slice(0, 5) };
}

export function repoRelative(context: RepositoryDetectorContext, path: string): string {
  return context.prefix === "" ? path : path.replace(new RegExp(`^${context.prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"), "");
}

export function sourceEntries(context: RepositoryDetectorContext, pattern?: RegExp): readonly [string, string][] {
  return [...context.files].filter(([path]) => pattern?.test(path) ?? true);
}
