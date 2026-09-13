import type { FrameworkExtractor } from "./types.js";
import { compactMatches, contract, edge, frameworkNode, moduleNode } from "./utils.js";

export const zodExtractor: FrameworkExtractor = {
  name: "zod",
  extract(graph, files) {
    const nodes = [];
    const edges = [];
    const contracts = [];
    for (const file of files.filter((candidate) => /\.[jt]sx?$/u.test(candidate.path))) {
      for (const match of compactMatches(file.content, /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*z\.(?:strictObject|object)\s*\(/gu)) {
        const node = frameworkNode(file.path, match.value, "contract", match.line, { contractKind: "schema", library: "zod" });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "export");
        if (relation !== undefined) edges.push(relation);
        contracts.push(contract(file.path, match.value, "schema", { library: "zod" }));
      }
    }
    return { nodes, edges, contracts };
  },
};
