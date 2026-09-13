import type { FrameworkExtractor } from "./types.js";
import { edge, frameworkNode, moduleNode } from "./utils.js";

export const astroExpoExtractor: FrameworkExtractor = {
  name: "astro-expo",
  extract(graph, files) {
    const nodes = [];
    const edges = [];
    for (const file of files) {
      const astro = /(?:^|\/)src\/pages\/.*\.astro$/u.test(file.path);
      const expo = /(?:^|\/)app\/.*\.[jt]sx?$/u.test(file.path) && !/(?:^|\/)app\/(?:api|actions)\//u.test(file.path);
      if (!astro && !expo) continue;
      const name = file.path
        .replace(/^.*\/(?:src\/pages|app)\//u, "/")
        .replace(/\.(?:astro|[jt]sx?)$/u, "")
        .replace(/\/index$/u, "/");
      const node = frameworkNode(file.path, name, "route", 1, { framework: astro ? "astro" : "expo" });
      nodes.push(node);
      const relation = edge(moduleNode(graph, file.path), node, "route");
      if (relation !== undefined) edges.push(relation);
    }
    return { nodes, edges };
  },
};
