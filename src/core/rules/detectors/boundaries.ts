import type { RepositoryDetector } from "./types.js";
import { detectorFact } from "./types.js";

function layer(path: string, prefix: string): string | undefined {
  const relative = prefix === "" ? path : path.replace(prefix, "");
  const segments = relative.split("/").filter(Boolean);
  return ["src", "app", "lib", "code"].includes(segments[0] ?? "") ? segments[1] : segments[0];
}

export const detectBoundaries: RepositoryDetector = (context) => {
  const pairs = new Map<string, string[]>();
  const byId = new Map(context.graph.nodes.map((node) => [node.id, node]));
  for (const edge of context.graph.edges.filter((candidate) => candidate.type === "import")) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined || !from.filePath.startsWith(context.prefix) || !to.filePath.startsWith(context.prefix)) continue;
    const fromLayer = layer(from.filePath, context.prefix);
    const toLayer = layer(to.filePath, context.prefix);
    if (fromLayer === undefined || toLayer === undefined || fromLayer === toLayer) continue;
    const key = `${fromLayer}->${toLayer}`;
    pairs.set(key, [...(pairs.get(key) ?? []), `${from.filePath} -> ${to.filePath}`]);
  }
  const inferences = [...pairs]
    .filter(([, evidence]) => evidence.length >= 2)
    .sort((left, right) => right[1].length - left[1].length)
    .slice(0, 5)
    .map(([value, evidence]) => detectorFact(`boundaries.import.${value.replace("->", ".to.")}`, value, `Preserve the established ${value} import direction.`, Math.min(0.95, 0.55 + evidence.length / 20), evidence));
  const generated = context.paths.filter((path) => /(?:generated|\.gen\.|__generated__)/u.test(path));
  const facts = generated.length === 0 ? [] : [detectorFact("boundaries.generated", "do-not-edit", "Do not edit generated files manually.", 1, generated)];
  return { facts, inferences };
};
