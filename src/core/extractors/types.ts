import type { AtlasContract, AtlasEdge, AtlasGraph, AtlasNode } from "../atlas.js";

export interface ExtractorFile {
  readonly path: string;
  readonly content: string;
}

export interface ExtractorResult {
  readonly nodes?: readonly AtlasNode[];
  readonly edges?: readonly AtlasEdge[];
  readonly contracts?: readonly AtlasContract[];
}

export interface FrameworkExtractor {
  readonly name: string;
  extract(graph: AtlasGraph, files: readonly ExtractorFile[]): ExtractorResult;
}
