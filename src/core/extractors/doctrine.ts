import type { FrameworkExtractor } from "./types.js";
import { compactMatches, edge, frameworkNode, lineAt, moduleNode } from "./utils.js";

export const doctrineExtractor: FrameworkExtractor = {
  name: "doctrine",
  extract(graph, files) {
    const nodes = [];
    const edges = [];
    for (const file of files.filter((candidate) => candidate.path.endsWith(".php") && /#\[\s*(?:ORM\\Entity|ODM\\Document)\b/u.test(candidate.content))) {
      const className = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/u.exec(file.content)?.[1] ?? file.path.split("/").pop()?.replace(/\.php$/u, "") ?? "Entity";
      const marker = compactMatches(file.content, /#\[\s*((?:ORM\\Entity|ODM\\Document))\b[^\]]*\]/gu)[0];
      const node = frameworkNode(file.path, className, "entity", marker?.line ?? 1, { doctrine: marker?.value ?? "entity" });
      nodes.push(node);
      const owner = graph.nodes.find((candidate) => candidate.filePath === file.path && candidate.name === className);
      const relation = edge(owner, node, "entity");
      if (relation !== undefined) edges.push(relation);
      const repositoryName = /repositoryClass\s*:\s*([A-Za-z_\\][A-Za-z0-9_\\]*)::class/u.exec(file.content)?.[1]?.split("\\").pop();
      const repository = repositoryName === undefined ? undefined : graph.nodes.find((candidate) => candidate.name === repositoryName);
      const repositoryEdge = edge(repository, node, "entity");
      if (repositoryEdge !== undefined) edges.push(repositoryEdge);
    }
    for (const file of files.filter((candidate) => /(?:doctrine|mapping|mappings)/iu.test(candidate.path) && /\.(?:xml|ya?ml)$/u.test(candidate.path))) {
      const mappings = file.path.endsWith(".xml")
        ? [...file.content.matchAll(/<(?:entity|document)\s+name=["']([^"']+)["']/gu)].map((match) => ({ name: match[1], index: match.index }))
        : [...file.content.matchAll(/^\s*([A-Z][A-Za-z0-9_\\]+)\s*:\s*\n\s+type\s*:\s*(?:entity|document)\s*$/gmu)].map((match) => ({ name: match[1], index: match.index }));
      for (const mapping of mappings) {
        if (mapping.name === undefined || mapping.index === undefined) continue;
        const name = mapping.name.split("\\").pop() ?? mapping.name;
        const node = frameworkNode(file.path, name, "entity", lineAt(file.content, mapping.index), { doctrine: "mapping", mappedClass: mapping.name });
        nodes.push(node);
        const relation = edge(moduleNode(graph, file.path), node, "entity");
        if (relation !== undefined) edges.push(relation);
      }
    }
    return { nodes, edges };
  },
};
