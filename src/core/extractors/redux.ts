import type { FrameworkExtractor } from "./types.js";
import { edge, frameworkNode, lineAt, moduleNode } from "./utils.js";

export const reduxExtractor: FrameworkExtractor = {
  name: "redux",
  extract(graph, files) {
    const nodes = [];
    const edges = [];
    for (const file of files.filter((candidate) => /\.[jt]sx?$/u.test(candidate.path))) {
      for (const match of file.content.matchAll(/createSlice\s*\(\s*\{[\s\S]*?\bname\s*:\s*["']([^"']+)["']/gu)) {
        const name = match[1];
        if (name === undefined || match.index === undefined) continue;
        const node = frameworkNode(file.path, name, "slice", lineAt(file.content, match.index), { library: "redux-toolkit" });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "calls");
        if (relation !== undefined) edges.push(relation);
      }
      for (const match of file.content.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*createAsyncThunk\s*\(\s*["']([^"']+)["']/gu)) {
        const name = match[1];
        if (name === undefined || match.index === undefined) continue;
        const node = frameworkNode(file.path, name, "slice", lineAt(file.content, match.index), { library: "redux-toolkit", role: "async-thunk", action: match[2] });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "calls");
        if (relation !== undefined) edges.push(relation);
      }
      for (const match of file.content.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*createSelector\s*\(/gu)) {
        const name = match[1];
        if (name === undefined || match.index === undefined) continue;
        const node = frameworkNode(file.path, name, "function", lineAt(file.content, match.index), { library: "redux-toolkit", role: "selector" });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "calls");
        if (relation !== undefined) edges.push(relation);
      }
    }
    return { nodes, edges };
  },
};
