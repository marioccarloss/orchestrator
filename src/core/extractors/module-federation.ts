import type { FrameworkExtractor } from "./types.js";
import { compactMatches, contract, edge, frameworkNode, moduleNode } from "./utils.js";

function objectBlock(source: string, key: string): string {
  return new RegExp(`${key}\\s*:\\s*\\{([\\s\\S]*?)\\}`, "u").exec(source)?.[1] ?? "";
}

export const moduleFederationExtractor: FrameworkExtractor = {
  name: "module-federation",
  extract(graph, files) {
    const nodes = [];
    const edges = [];
    const contracts = [];
    for (const file of files.filter((candidate) => /(?:vite|webpack)\.config\.[^/]+$/u.test(candidate.path) && /federation\s*\(/u.test(candidate.content))) {
      const container = /\bname\s*:\s*["']([^"']+)["']/u.exec(file.content)?.[1] ?? file.path;
      for (const match of compactMatches(objectBlock(file.content, "exposes"), /["']([^"']+)["']\s*:\s*["']([^"']+)["']/gu)) {
        const node = frameworkNode(file.path, `${container}:${match.value}`, "federation-contract", match.line, { role: "expose", container, key: match.value });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "exposes");
        if (relation !== undefined) edges.push(relation);
        contracts.push(contract(file.path, `${container}:${match.value}`, "federation", { role: "expose", container, key: match.value }));
      }
      for (const match of compactMatches(objectBlock(file.content, "remotes"), /(?:["']?)([\w-]+)(?:["']?)\s*:\s*["']([^"']+)["']/gu)) {
        const node = frameworkNode(file.path, match.value, "federation-contract", match.line, { role: "remote", container: match.value });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "consumes");
        if (relation !== undefined) edges.push(relation);
        contracts.push(contract(file.path, match.value, "federation", { role: "remote", container: match.value }));
      }
    }
    return { nodes, edges, contracts };
  },
};
