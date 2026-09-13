import type { FrameworkExtractor } from "./types.js";

export const cqrsExtractor: FrameworkExtractor = {
  name: "cqrs",
  extract(graph, files) {
    const edges = [];
    const messages = graph.nodes.filter((node) => /(?:Command|Query)$/u.test(node.name));
    for (const handler of graph.nodes.filter((node) => node.name.endsWith("Handler"))) {
      const base = handler.name.replace(/Handler$/u, "");
      const target = messages.find((message) => message.name === base || message.name === `${base}Command` || message.name === `${base}Query`);
      if (target !== undefined) edges.push({ from: handler.id, to: target.id, type: "calls" as const });
    }
    for (const file of files.filter((candidate) => /\.(?:php|[jt]sx?)$/u.test(candidate.path))) {
      for (const match of file.content.matchAll(/(?:dispatch|handle|ask)\s*\(\s*new\s+([A-Za-z_][A-Za-z0-9_]*(?:Command|Query))\b/gu)) {
        const targetName = match[1];
        if (targetName === undefined || match.index === undefined) continue;
        const target = messages.find((message) => message.name === targetName);
        const line = file.content.slice(0, match.index).split(/\r?\n/u).length;
        const source = graph.nodes
          .filter((node) => node.filePath === file.path && node.kind !== "module" && node.line <= line && (node.endLine ?? node.line) >= line)
          .sort((left, right) => ((left.endLine ?? left.line) - left.line) - ((right.endLine ?? right.line) - right.line))[0]
          ?? graph.nodes.find((node) => node.filePath === file.path && node.kind === "module");
        if (source !== undefined && target !== undefined) edges.push({ from: source.id, to: target.id, type: "calls" as const });
      }
    }
    return { edges };
  },
};
