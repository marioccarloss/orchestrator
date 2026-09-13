import type { RepositoryDetector } from "./types.js";
import { detectorFact } from "./types.js";

export const detectGit: RepositoryDetector = (context) => {
  const facts = [];
  const prTemplates = context.paths.filter((path) => /(?:^|\/)PULL_REQUEST_TEMPLATE(?:\/[^/]+|\.md)$/iu.test(path));
  if (prTemplates.length > 0) facts.push(detectorFact("git.pr-template", "required", "Use the repository pull request template.", 1, prTemplates));
  if (context.paths.some((path) => /commitlint/iu.test(path))) facts.push(detectorFact("git.commits", "commitlint", "Follow the configured commit message convention.", 1, context.paths.filter((path) => /commitlint/iu.test(path))));
  const conventional = context.recentCommits.filter((message) => /^(?:feat|fix|docs|refactor|test|chore|build|ci|perf)(?:\([^)]+\))?!?:/u.test(message));
  const inferences = context.recentCommits.length >= 5 && conventional.length / context.recentCommits.length >= 0.55
    ? [detectorFact("git.commit-style", "conventional-commits", "Use Conventional Commits for commit subjects.", conventional.length / context.recentCommits.length, conventional)]
    : [];
  return { facts, inferences };
};
