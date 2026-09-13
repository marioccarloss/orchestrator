import type { RepositoryDetector } from "./types.js";
import { detectorFact } from "./types.js";

export const detectStateData: RepositoryDetector = (context) => {
  const scoped = context.graph.nodes.filter((node) => node.filePath.startsWith(context.prefix));
  const facts = [];
  const add = (id: string, value: string, statement: string, kind: string): void => {
    const evidence = scoped.filter((node) => node.kind === kind).map((node) => node.filePath);
    if (evidence.length > 0) facts.push(detectorFact(id, value, statement, 1, evidence));
  };
  add("state-data.query", "tanstack-query", "Use TanStack Query for server state where it is already established.", "query-key");
  add("state-data.client", "redux-toolkit", "Use Redux Toolkit for shared client state where it is already established.", "slice");
  add("state-data.server-actions", "nextjs", "Preserve existing Next.js Server Action boundaries.", "server-action");
  const schemas = scoped.filter((node) => node.kind === "contract" && node.metadata["contractKind"] === "schema");
  if (schemas.length > 0) facts.push(detectorFact("state-data.validation", "zod", "Validate data at established boundaries with Zod schemas.", 1, schemas.map((node) => node.filePath)));
  return { facts };
};
