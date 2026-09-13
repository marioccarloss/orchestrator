import type { RepositoryDetector } from "./types.js";
import { detectorFact, repoRelative, sourceEntries } from "./types.js";

export const detectModules: RepositoryDetector = (context) => {
  const inferences = [];
  const facts = [];
  const sourcePaths = context.paths.map((path) => repoRelative(context, path)).filter((path) => /\.[jt]sx?$/u.test(path));
  const barrels = sourcePaths.filter((path) => /(?:^|\/)index\.[jt]sx?$/u.test(path));
  if (sourcePaths.length >= 3) {
    const ratio = barrels.length / sourcePaths.length;
    const value = barrels.length === 0 ? "avoid" : ratio >= 0.8 ? "use" : "existing-only";
    const confidence = barrels.length === 0 ? Math.min(0.98, 0.7 + sourcePaths.length / 100) : ratio >= 0.8 ? ratio : 0.7;
    inferences.push(detectorFact("modules.barrels", value, value === "avoid" ? "Barrel files are not part of the current module layout." : `Barrel files are ${value === "use" ? "common" : "used selectively"}.`, confidence, barrels.length > 0 ? barrels : sourcePaths.slice(0, 5)));
  }
  const configs = sourceEntries(context, /(?:tsconfig[^/]*\.json|eslint[^/]*\.(?:js|cjs|mjs|json))$/u);
  if (configs.some(([, content]) => /"paths"\s*:/u.test(content))) facts.push(detectorFact("modules.aliases", "configured", "Use the repository's configured import aliases.", 1, configs.map(([path]) => path)));
  if (configs.some(([, content]) => /(?:sort-imports|import\/order)/u.test(content))) facts.push(detectorFact("modules.import-order", "configured", "Preserve the configured import ordering.", 1, configs.map(([path]) => path)));
  const exported = context.graph.nodes.filter((node) => node.filePath.startsWith(context.prefix) && node.kind !== "module" && node.exports.length > 0);
  if (exported.length >= 5) {
    const defaults = sourceEntries(context, /\.[jt]sx?$/u).filter(([, content]) => /export\s+default\b/u.test(content));
    const value = defaults.length / exported.length > 0.5 ? "default" : "named";
    inferences.push(detectorFact("modules.exports", value, `Exports predominantly use ${value} exports.`, Math.max(0.55, 1 - Math.min(defaults.length, exported.length - defaults.length) / exported.length), (value === "default" ? defaults.map(([path]) => path) : exported.map((node) => node.filePath)).slice(0, 5)));
  }
  return { facts, inferences };
};
