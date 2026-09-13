import type { RepositoryDetector } from "./types.js";
import { detectorFact, sourceEntries } from "./types.js";

export const detectQuality: RepositoryDetector = (context) => {
  const facts = [];
  const configs = sourceEntries(context, /(?:tsconfig[^/]*\.json|eslint|prettier|phpstan|php-cs-fixer)/iu);
  const strict = configs.filter(([, source]) => /"strict"\s*:\s*true/u.test(source));
  if (strict.length > 0) facts.push(detectorFact("quality.strict", "true", "Preserve strict typing; do not introduce any.", 1, strict.map(([path]) => path)));
  const exact = configs.filter(([, source]) => /"(?:noUncheckedIndexedAccess|exactOptionalPropertyTypes)"\s*:\s*true/u.test(source));
  if (exact.length > 0) facts.push(detectorFact("quality.strict-flags", "preserve", "Preserve enabled strict TypeScript compiler flags.", 1, exact.map(([path]) => path)));
  if (configs.some(([path]) => /eslint/iu.test(path))) facts.push(detectorFact("quality.lint", "eslint", "Run and preserve the repository ESLint configuration.", 1, configs.filter(([path]) => /eslint/iu.test(path)).map(([path]) => path)));
  if (configs.some(([path]) => /prettier/iu.test(path))) facts.push(detectorFact("quality.format", "prettier", "Use the repository Prettier configuration.", 1, configs.filter(([path]) => /prettier/iu.test(path)).map(([path]) => path)));
  if (configs.some(([path]) => /phpstan/iu.test(path))) facts.push(detectorFact("quality.phpstan", "configured", "Preserve the configured PHPStan level and checks.", 1, configs.filter(([path]) => /phpstan/iu.test(path)).map(([path]) => path)));
  return { facts };
};
