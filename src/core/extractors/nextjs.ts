import type { FrameworkExtractor } from "./types.js";
import { edge, frameworkNode, moduleNode } from "./utils.js";

export const nextjsExtractor: FrameworkExtractor = {
  name: "nextjs",
  extract(graph, files) {
    const nodes = [];
    const edges = [];
    for (const file of files.filter((candidate) => /(?:^|\/)app\//u.test(candidate.path) && /\.[jt]sx?$/u.test(candidate.path))) {
      const routeFile = /\/(?:route|page|layout)\.[jt]sx?$/u.test(file.path);
      const serverAction = /^["']use server["'];?/mu.test(file.content);
      const name = file.path.replace(/^.*\/app\//u, "/").replace(/\/(?:route|page|layout)\.[jt]sx?$/u, "") || "/";
      if (routeFile) {
        const node = frameworkNode(file.path, name, "route", 1, { framework: "nextjs" });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "route");
        if (relation !== undefined) edges.push(relation);
      }
      if (serverAction) {
        const actions = [...file.content.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu)];
        for (const action of actions.length === 0 ? [{ 1: name, index: 0 }] : actions) {
          const actionName = action[1];
          if (actionName === undefined || action.index === undefined) continue;
          const node = frameworkNode(file.path, actionName, "server-action", file.content.slice(0, action.index).split(/\r?\n/u).length, { framework: "nextjs", routePath: name });
          nodes.push(node);
          const relation = edge(moduleNode(graph, file.path), node, "calls");
          if (relation !== undefined) edges.push(relation);
        }
      }
    }
    return { nodes, edges };
  },
};
