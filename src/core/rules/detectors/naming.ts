import type { RepositoryDetector } from "./types.js";
import { detectorFact, repoRelative } from "./types.js";

function casing(path: string): string | undefined {
  const name = path.split("/").pop()?.replace(/\.(?:test|spec)?\.[^.]+$/u, "").replace(/\.[^.]+$/u, "");
  if (name === undefined || ["index", "page", "layout", "route"].includes(name)) return undefined;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/u.test(name)) return "kebab-case";
  if (/^[a-z][a-zA-Z0-9]*$/u.test(name)) return "camelCase";
  if (/^[A-Z][a-zA-Z0-9]*$/u.test(name)) return "PascalCase";
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/u.test(name)) return "snake_case";
  return undefined;
}

function dominant(paths: readonly string[]): { readonly value: string; readonly confidence: number; readonly evidence: readonly string[] } | undefined {
  const rows = paths.flatMap((path) => {
    const value = casing(path);
    return value === undefined ? [] : [{ path, value }];
  });
  if (rows.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.value, (counts.get(row.value) ?? 0) + 1);
  const winner = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0];
  if (winner === undefined) return undefined;
  return {
    value: winner[0],
    confidence: rows.length < 5 ? Math.min(0.6, winner[1] / rows.length) : winner[1] / rows.length,
    evidence: rows.filter((row) => row.value === winner[0]).map((row) => row.path).slice(0, 5),
  };
}

export const detectNaming: RepositoryDetector = (context) => {
  const paths = context.paths.map((path) => repoRelative(context, path)).filter((path) => /\.(?:[jt]sx?|php|css|scss|astro)$/u.test(path));
  const result = dominant(paths);
  if (result === undefined || result.confidence < 0.55) return { gaps: ["File naming convention could not be determined with confidence."] };
  return { inferences: [detectorFact("naming.files", result.value, `Files predominantly use ${result.value}.`, result.confidence, result.evidence)] };
};
