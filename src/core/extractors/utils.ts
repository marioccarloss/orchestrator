import { sha256 } from "../files.js";
import type { AtlasContract, AtlasEdge, AtlasGraph, AtlasNode } from "../atlas.js";

export function lineAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split(/\r?\n/u).length;
}

export function frameworkNode(
  filePath: string,
  name: string,
  kind: AtlasNode["kind"],
  line: number,
  metadata: Record<string, unknown> = {},
): AtlasNode {
  return {
    id: sha256(`${filePath}:framework:${kind}:${name}:${String(line)}`).slice(0, 16),
    name,
    kind,
    filePath,
    line,
    column: 0,
    exports: [],
    imports: [],
    dependencies: [],
    dependents: [],
    metadata,
  };
}

export function moduleNode(graph: AtlasGraph, filePath: string): AtlasNode | undefined {
  return graph.nodes.find((node) => node.filePath === filePath && node.kind === "module");
}

export function edge(from: AtlasNode | undefined, to: AtlasNode | undefined, type: AtlasEdge["type"]): AtlasEdge | undefined {
  return from === undefined || to === undefined ? undefined : { from: from.id, to: to.id, type };
}

export function contract(
  file: string,
  name: string,
  kind: AtlasContract["kind"],
  metadata: Record<string, unknown> = {},
): AtlasContract {
  return { id: sha256(`${file}:contract:${kind}:${name}`).slice(0, 16), file, name, kind, metadata };
}

export function compactMatches(source: string, expression: RegExp, group = 1): readonly { value: string; line: number }[] {
  return [...source.matchAll(expression)].flatMap((match) => {
    const value = match[group];
    return value === undefined || match.index === undefined ? [] : [{ value, line: lineAt(source, match.index) }];
  });
}

export function repoOf(filePath: string): string {
  const match = /^(?:repos|packages|apps)\/([^/]+)\//u.exec(filePath);
  return match?.[1] ?? ".";
}
