import type { FrameworkExtractor } from "./types.js";
import { compactMatches, contract, edge, frameworkNode, lineAt, moduleNode } from "./utils.js";

export const symfonyExtractor: FrameworkExtractor = {
  name: "symfony",
  extract(graph, files) {
    const nodes = [];
    const edges = [];
    const contracts = [];
    for (const file of files.filter((candidate) => candidate.path.endsWith(".php"))) {
      const owner = moduleNode(graph, file.path);
      for (const match of file.content.matchAll(/#\[\s*(?:\\?Symfony\\Component\\Routing\\Annotation\\)?Route\s*\(\s*["']([^"']+)["'][^\]]*\]/gu)) {
        const routePath = match[1];
        if (routePath === undefined || match.index === undefined) continue;
        const node = frameworkNode(file.path, routePath, "route", lineAt(file.content, match.index), { routePath, framework: "symfony" });
        nodes.push(node);
        const relation = edge(owner, node, "route");
        if (relation !== undefined) edges.push(relation);
        const className = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(file.content.slice(match.index + match[0].length))?.[1];
        const controller = className === undefined ? undefined : graph.nodes.find((candidate) => candidate.filePath === file.path && candidate.name === className);
        const dispatch = edge(node, controller, "calls");
        if (dispatch !== undefined) edges.push(dispatch);
        contracts.push(contract(file.path, routePath, "route", { path: routePath, framework: "symfony", ...(className === undefined ? {} : { controller: className }) }));
      }
      for (const match of compactMatches(file.content, /#\[\s*(AsMessageHandler|AsEventListener)\b[^\]]*\]/gu)) {
        const node = frameworkNode(file.path, match.value, "contract", match.line, { framework: "symfony", attribute: match.value });
        nodes.push(node);
        const relation = edge(owner, node, "event");
        if (relation !== undefined) edges.push(relation);
        contracts.push(contract(file.path, match.value, "event", { framework: "symfony" }));
      }
    }
    for (const file of files.filter((candidate) => /(?:^|\/)services\.ya?ml$/u.test(candidate.path))) {
      const owner = moduleNode(graph, file.path);
      for (const match of compactMatches(file.content, /^\s{2,}([A-Z][A-Za-z0-9_\\]+)\s*:(?:\s*["']?@?([A-Z][A-Za-z0-9_\\]+)["']?)?\s*$/gmu)) {
        const node = frameworkNode(file.path, match.value, "contract", match.line, { framework: "symfony", contractKind: "di-binding" });
        nodes.push(node);
        const relation = edge(owner, node, "implements");
        if (relation !== undefined) edges.push(relation);
        const shortName = match.value.split("\\").pop();
        const implementation = graph.nodes.find((candidate) => candidate.name === shortName && candidate.kind !== "module");
        const implementationEdge = edge(implementation, node, "implements");
        if (implementationEdge !== undefined) edges.push(implementationEdge);
      }
    }
    return { nodes, edges, contracts };
  },
};
