import type { AtlasContract, AtlasEdge, AtlasGraph } from "./atlas.js";
import type { ExtractorFile } from "./extractors/index.js";
import { moduleNode, repoOf } from "./extractors/utils.js";

export interface ContractMatchResult {
  readonly edges: readonly AtlasEdge[];
  readonly contracts: readonly AtlasContract[];
}

function normalizeEndpoint(value: string): string {
  const withoutQuery = value.split("?")[0] ?? value;
  return `/${withoutQuery.replace(/^https?:\/\/[^/]+/u, "").replace(/^\/+|\/+$/gu, "")}`;
}

/** Match only explicit contracts across repository boundaries; never infer by prose. */
export function matchCrossRepoContracts(
  graph: AtlasGraph,
  files: readonly ExtractorFile[],
  contracts: readonly AtlasContract[] = graph.contracts ?? [],
): ContractMatchResult {
  const edges: AtlasEdge[] = [];
  const routes = graph.nodes.filter((node) => node.kind === "route" && typeof node.metadata["routePath"] === "string");
  for (const file of files.filter((candidate) => /\.[jt]sx?$/u.test(candidate.path))) {
    const source = moduleNode(graph, file.path);
    if (source === undefined) continue;
    const endpoints = [...file.content.matchAll(/(?:fetch|axios\.(?:get|post|put|patch|delete))\s*\(\s*["']([^"']+)["']/gu)]
      .map((match) => match[1])
      .filter((endpoint): endpoint is string => endpoint !== undefined)
      .map(normalizeEndpoint);
    for (const endpoint of endpoints) {
      const target = routes.find((route) => normalizeEndpoint(String(route.metadata["routePath"])) === endpoint && repoOf(route.filePath) !== repoOf(file.path));
      if (target !== undefined) edges.push({ from: source.id, to: target.id, type: "consumes" });
    }
  }

  const federationNodes = graph.nodes.filter((node) => node.kind === "federation-contract");
  for (const remote of federationNodes.filter((node) => node.metadata["role"] === "remote")) {
    const remoteContainer = String(remote.metadata["container"] ?? remote.name);
    const exposed = federationNodes.find((node) =>
      node.metadata["role"] === "expose"
      && String(node.metadata["container"] ?? "") === remoteContainer
      && repoOf(node.filePath) !== repoOf(remote.filePath));
    if (exposed !== undefined) edges.push({ from: remote.id, to: exposed.id, type: "consumes" });
  }

  const schemas = graph.nodes.filter((node) => node.kind === "contract" && node.metadata["contractKind"] === "schema");
  for (const schema of schemas) {
    const providerIds = new Set(graph.nodes.filter((node) => node.filePath === schema.filePath).map((node) => node.id));
    const entryIds = new Set(providerIds);
    for (const exported of graph.edges.filter((edge) => edge.type === "export" && providerIds.has(edge.to))) entryIds.add(exported.from);
    for (const imported of graph.edges.filter((edge) => edge.type === "import" && entryIds.has(edge.to))) {
      const source = graph.nodes.find((node) => node.id === imported.from);
      if (source !== undefined && repoOf(source.filePath) !== repoOf(schema.filePath)) edges.push({ from: source.id, to: schema.id, type: "consumes" });
    }
  }
  for (const consumer of schemas) {
    const provider = schemas.find((candidate) => candidate.id !== consumer.id && candidate.name === consumer.name && repoOf(candidate.filePath) !== repoOf(consumer.filePath));
    if (provider !== undefined) edges.push({ from: consumer.id, to: provider.id, type: "consumes" });
  }

  const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.from}:${edge.to}:${edge.type}`, edge])).values()];
  const uniqueContracts = [...new Map(contracts.map((item) => [item.id, item])).values()];
  return { edges: uniqueEdges, contracts: uniqueContracts };
}
