import type { AtlasContract, AtlasEdge, AtlasGraph, AtlasNode } from "../atlas.js";
import { astroExpoExtractor } from "./astro-expo.js";
import { cqrsExtractor } from "./cqrs.js";
import { doctrineExtractor } from "./doctrine.js";
import { moduleFederationExtractor } from "./module-federation.js";
import { nextjsExtractor } from "./nextjs.js";
import { reduxExtractor } from "./redux.js";
import { scssExtractor } from "./scss.js";
import { symfonyExtractor } from "./symfony.js";
import { tanstackQueryExtractor } from "./tanstack-query.js";
import type { ExtractorFile, FrameworkExtractor } from "./types.js";
import { zodExtractor } from "./zod.js";

export const EXTRACTORS: readonly FrameworkExtractor[] = [
  moduleFederationExtractor,
  symfonyExtractor,
  doctrineExtractor,
  cqrsExtractor,
  tanstackQueryExtractor,
  reduxExtractor,
  nextjsExtractor,
  zodExtractor,
  scssExtractor,
  astroExpoExtractor,
];

export interface ExtractorRun {
  readonly nodes: readonly AtlasNode[];
  readonly edges: readonly AtlasEdge[];
  readonly contracts: readonly AtlasContract[];
  readonly errors: readonly { readonly extractor: string; readonly message: string }[];
}

export function runExtractors(graph: AtlasGraph, files: readonly ExtractorFile[]): ExtractorRun {
  const nodes: AtlasNode[] = [];
  const edges: AtlasEdge[] = [];
  const contracts: AtlasContract[] = [];
  const errors: { extractor: string; message: string }[] = [];
  for (const extractor of EXTRACTORS) {
    try {
      const output = extractor.extract({ ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges] }, files);
      nodes.push(...(output.nodes ?? []));
      edges.push(...(output.edges ?? []));
      contracts.push(...(output.contracts ?? []));
    } catch (error: unknown) {
      errors.push({ extractor: extractor.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { nodes, edges, contracts, errors };
}

export type { ExtractorFile, ExtractorResult, FrameworkExtractor } from "./types.js";
