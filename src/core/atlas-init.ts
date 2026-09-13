import { AtlasIndexer, loadAtlasGraph, saveAtlasGraph, type AtlasGraph } from "./atlas.js";
import type { MrPaths } from "./paths.js";
import type { WorkspaceProfile } from "./schema.js";
import { buildRulesProposal, type RulesProposal } from "./rules/generator.js";
import { discoverRepositories, type DiscoveredRepository } from "./rules/discover.js";
import { profileRepository, type RepositoryProfile } from "./rules/profiler.js";

export interface AtlasBaseline {
  readonly graph: AtlasGraph;
  readonly profiles: readonly RepositoryProfile[];
  readonly proposal?: RulesProposal;
  readonly errors: readonly string[];
}

export interface AtlasBaselineDependencies {
  readonly discover?: (workspaceRoot: string) => Promise<readonly DiscoveredRepository[]>;
  readonly profile?: (workspaceRoot: string, repository: DiscoveredRepository, graph: AtlasGraph) => Promise<RepositoryProfile>;
  readonly generate?: (profiles: readonly RepositoryProfile[]) => RulesProposal;
}

export async function indexAtlasWorkspace(paths: MrPaths, workspace: WorkspaceProfile): Promise<AtlasGraph> {
  const previous = await loadAtlasGraph(paths, workspace.id);
  const graph = await new AtlasIndexer().indexWorkspace(workspace.root, previous === undefined ? undefined : { previous });
  await saveAtlasGraph(paths, workspace.id, graph);
  return graph;
}

/** Profile repositories best-effort: one broken profiler never makes Atlas indexing unusable. */
export async function buildAtlasBaseline(
  workspace: WorkspaceProfile,
  graph: AtlasGraph,
  dependencies: AtlasBaselineDependencies = {},
): Promise<AtlasBaseline> {
  const discover = dependencies.discover ?? discoverRepositories;
  const profile = dependencies.profile ?? profileRepository;
  const generate = dependencies.generate ?? buildRulesProposal;
  const errors: string[] = [];
  let repositories: readonly DiscoveredRepository[] = [];
  try {
    repositories = await discover(workspace.root);
  } catch (error: unknown) {
    errors.push(`repository discovery: ${error instanceof Error ? error.message : String(error)}`);
  }
  const profiles: RepositoryProfile[] = [];
  for (const repository of repositories) {
    try {
      profiles.push(await profile(workspace.root, repository, graph));
    } catch (error: unknown) {
      errors.push(`${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    const proposal = profiles.length === 0 ? undefined : generate(profiles);
    return { graph, profiles, ...(proposal === undefined ? {} : { proposal }), errors };
  } catch (error: unknown) {
    errors.push(`rules generator: ${error instanceof Error ? error.message : String(error)}`);
    return { graph, profiles, errors };
  }
}
