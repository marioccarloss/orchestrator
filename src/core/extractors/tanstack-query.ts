import type { FrameworkExtractor } from "./types.js";
import { edge, frameworkNode, lineAt, moduleNode } from "./utils.js";

export const tanstackQueryExtractor: FrameworkExtractor = {
  name: "tanstack-query",
  extract(graph, files) {
    const nodes = [];
    const edges = [];
    for (const file of files.filter((candidate) => /\.[jt]sx?$/u.test(candidate.path))) {
      for (const match of file.content.matchAll(/(?:(?:query|mutation)Key\s*:\s*|invalidateQueries\s*\(\s*\{?\s*queryKey\s*:\s*)\[\s*["']([^"']+)["']/gu)) {
        const key = match[1];
        if (key === undefined || match.index === undefined) continue;
        const node = frameworkNode(file.path, key, "query-key", lineAt(file.content, match.index), { library: "tanstack-query" });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "query-key");
        if (relation !== undefined) edges.push(relation);
      }
    }
    return { nodes, edges };
  },
};
