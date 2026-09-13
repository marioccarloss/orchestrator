import type { MrPaths } from "./paths.js";
import { AtlasIndexer, computeWorkspaceFileHashes, isGraphFresh, loadAtlasGraph, saveAtlasGraph, type AtlasGraph } from "./atlas.js";

export interface AtlasLoadResult { readonly graph: AtlasGraph; readonly fresh: boolean; readonly reindexed: boolean }

export async function getOrIndexAtlas(paths: MrPaths, workspaceId: string, workspaceRoot: string): Promise<AtlasLoadResult> {
  const cached = await loadAtlasGraph(paths, workspaceId);
  if (cached !== undefined) {
    const current = await computeWorkspaceFileHashes(workspaceRoot);
    if (isGraphFresh(cached, current).fresh) return { graph: cached, fresh: true, reindexed: false };
  }
  const graph = await new AtlasIndexer().indexWorkspace(workspaceRoot, cached === undefined ? undefined : { previous: cached });
  await saveAtlasGraph(paths, workspaceId, graph);
  return { graph, fresh: false, reindexed: true };
}
