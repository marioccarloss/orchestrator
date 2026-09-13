import type { RepositoryDetector } from "./types.js";
import { detectorFact, repoRelative, sourceEntries } from "./types.js";

export const detectTesting: RepositoryDetector = (context) => {
  const testPaths = context.paths.filter((path) => /(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\./u.test(repoRelative(context, path)));
  if (testPaths.length === 0) return { gaps: ["Testing location could not be determined."] };
  const values = testPaths.map((path) => path.includes("/__tests__/") ? "__tests__" : /(?:^|\/)tests\//u.test(repoRelative(context, path)) ? "tests" : "colocated");
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const winner = [...counts].sort((left, right) => right[1] - left[1])[0];
  const inferences = winner === undefined ? [] : [detectorFact("testing.location", winner[0], `Tests are predominantly ${winner[0]}.`, Math.max(0.55, winner[1] / values.length), testPaths)];
  const facts = [];
  const frameworks: readonly [string, boolean][] = [
    ["vitest", context.dependencies.has("vitest")], ["jest", context.dependencies.has("jest")], ["bun", sourceEntries(context, /\.(?:test|spec)\.[jt]sx?$/u).some(([, source]) => /from\s+["']bun:test["']/u.test(source))],
    ["phpunit", context.markers.includes("composer.json") && context.paths.some((path) => /phpunit(?:\.xml|\/)/u.test(path))],
  ];
  const framework = frameworks.find(([, present]) => present)?.[0];
  if (framework !== undefined) facts.push(detectorFact("testing.framework", framework, `Use ${framework} for repository tests.`, 1, testPaths));
  if (context.dependencies.has("msw")) facts.push(detectorFact("testing.network", "msw", "Use MSW for network-level test doubles.", 1, ["package.json"]));
  if (context.dependencies.has("storybook" ) || context.dependencies.has("@storybook/react")) facts.push(detectorFact("testing.components", "storybook", "Preserve Storybook coverage for reusable components.", 1, ["package.json"]));
  return { facts, inferences };
};
