import type { FrameworkExtractor } from "./types.js";
import { edge } from "./utils.js";

export const scssExtractor: FrameworkExtractor = {
  name: "scss",
  extract(graph, files) {
    const edges = [];
    const styleModules = graph.nodes.filter((node) => node.kind === "module" && /\.(?:css|scss)$/u.test(node.filePath));
    const tokens = graph.nodes.filter((node) => node.kind === "token");
    for (const module of styleModules) {
      for (const token of tokens.filter((candidate) => candidate.filePath !== module.filePath)) {
        if (module.imports.some((specifier) => token.filePath.includes(specifier.replace(/^.*\//u, "").replace(/^_/u, "").replace(/\.scss$/u, "")))) {
          const relation = edge(module, token, "style-use");
          if (relation !== undefined) edges.push(relation);
        }
      }
      const source = files.find((file) => file.path === module.filePath)?.content ?? "";
      const usedNames = new Set([
        ...[...source.matchAll(/@include\s+([\w-]+)/gu)].map((match) => match[1]),
        ...[...source.matchAll(/\$([\w-]+)/gu)].map((match) => match[1]),
      ].filter((name): name is string => name !== undefined));
      for (const target of graph.nodes.filter((candidate) => candidate.filePath !== module.filePath && usedNames.has(candidate.name) && (candidate.kind === "token" || candidate.metadata["style"] === "mixin"))) {
        const relation = edge(module, target, "style-use");
        if (relation !== undefined) edges.push(relation);
      }
    }
    return { edges };
  },
};
