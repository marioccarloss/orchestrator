import type { RepositoryDetector } from "./types.js";
import { detectorFact, sourceEntries } from "./types.js";

export const detectStyles: RepositoryDetector = (context) => {
  const styleFiles = sourceEntries(context, /\.(?:css|scss|tsx|jsx)$/u);
  if (styleFiles.length === 0) return {};
  const facts = [];
  const inferences = [];
  const approaches: readonly [string, boolean][] = [
    ["css-modules", context.paths.some((path) => /\.module\.(?:css|scss)$/u.test(path))],
    ["tailwind", context.dependencies.has("tailwindcss")],
    ["emotion", context.dependencies.has("@emotion/react") || context.dependencies.has("@emotion/styled")],
    ["styled-components", context.dependencies.has("styled-components")],
    ["mui", context.dependencies.has("@mui/material") || context.dependencies.has("@mui/joy")],
  ];
  const selected = approaches.find(([, present]) => present)?.[0];
  if (selected !== undefined) facts.push(detectorFact("styles.approach", selected, `Use ${selected} where the repository already does.`, 1, styleFiles.map(([path]) => path)));
  const important = styleFiles.filter(([, source]) => /!important\b/u.test(source));
  if (styleFiles.length >= 3) {
    const value = important.length === 0 ? "forbid" : "existing-only";
    inferences.push(detectorFact("styles.no-important", value, important.length === 0 ? "Do not introduce !important." : "Do not expand existing !important usage.", important.length === 0 ? Math.min(0.98, 0.75 + styleFiles.length / 100) : Math.max(0.55, 1 - important.length / styleFiles.length), (important.length > 0 ? important : styleFiles).map(([path]) => path)));
  }
  const bem = styleFiles.filter(([, source]) => /\.[a-z][\w-]*__(?:[a-z][\w-]*)(?:--[a-z][\w-]*)?/u.test(source));
  if (bem.length > 0) facts.push(detectorFact("styles.naming", "bem", "Preserve BEM class naming in stylesheet modules.", 1, bem.map(([path]) => path)));
  const tokens = context.graph.nodes.filter((node) => node.filePath.startsWith(context.prefix) && node.kind === "token");
  if (tokens.length > 0) facts.push(detectorFact("styles.tokens", "existing-location", "Reuse the existing style tokens instead of duplicating values.", 1, tokens.map((node) => node.filePath)));
  return { facts, inferences };
};
