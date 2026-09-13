import type { RepositoryDetector } from "./types.js";
import { detectorFact, sourceEntries } from "./types.js";

export const detectBackend: RepositoryDetector = (context) => {
  const scoped = context.graph.nodes.filter((node) => node.filePath.startsWith(context.prefix));
  const sources = sourceEntries(context, /\.(?:php|ts|java)$/u);
  const facts = [];
  const patternFact = (id: string, value: string, statement: string, pattern: RegExp): void => {
    const evidence = sources.filter(([, source]) => pattern.test(source)).map(([path]) => path);
    if (evidence.length > 0) facts.push(detectorFact(id, value, statement, 1, evidence));
  };
  const entities = scoped.filter((node) => node.kind === "entity");
  if (entities.length > 0) facts.push(detectorFact("backend.persistence", "doctrine", "Preserve Doctrine entity and repository boundaries.", 1, entities.map((node) => node.filePath)));
  const messages = scoped.filter((node) => /(?:Command|Query|Handler)$/u.test(node.name));
  if (messages.length > 0) facts.push(detectorFact("backend.messaging", "cqrs", "Dispatch commands and queries through the established CQRS handlers.", 1, messages.map((node) => node.filePath)));
  patternFact("backend.domain", "ddd", "Preserve Aggregate, Value Object, and Domain Event invariants.", /\b(?:AggregateRoot|ValueObject|DomainEvent)\b/u);
  patternFact("backend.cache", "cache-aside", "Preserve the existing cache-aside behavior and invalidation path.", /\b(?:Redis|CacheInterface|cache[-_ ]aside)\b/iu);
  patternFact("backend.auth", "jwt-pkce-voters", "Preserve established authentication and authorization boundaries.", /\b(?:JWT|PKCE|Voter|AuthorizationChecker)\b/u);
  patternFact("backend.state-machine", "configured", "Use the existing state machine for lifecycle transitions.", /\b(?:StateMachine|WorkflowInterface)\b/u);
  return { facts };
};
