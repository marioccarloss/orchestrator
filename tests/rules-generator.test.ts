import { test } from "bun:test";
import assert from "node:assert/strict";
import { buildRulesProposal, ruleInvariants, rulesDigest, type WorkspaceRules } from "../src/core/rules/generator.js";
import { renderAgentsMarkdown, renderWorkspaceAgentsMarkdown } from "../src/core/rules/render.js";
import { staleRuleRepositories } from "../src/core/rules/store.js";
import { profileStackFingerprint, type RepositoryProfile } from "../src/core/rules/profiler.js";

const profile: RepositoryProfile = {
  schemaVersion: 1, repo: "web", root: "repos/web", generatedFromIndex: "a".repeat(64), kind: "spa",
  stack: { languages: ["typescript"], frameworks: ["React"], packageManager: "bun", build: "bun run build" },
  layout: { style: "feature", roots: ["src"] }, commands: { test: "bun run test" }, criticalAreas: [], gaps: [],
  facts: [{ id: "styles.no-important", value: "forbid", statement: "No important", confidence: 1, evidence: ["src/a.css"] }],
  inferences: [
    { id: "naming.files", value: "kebab-case", statement: "Kebab", confidence: 0.9, evidence: ["src/user-card.tsx"] },
    { id: "modules.barrels", value: "existing-only", statement: "Mixed", confidence: 0.7, evidence: ["src/index.ts"] },
  ],
};

test("rules generator keeps high-confidence inference automatic and groups medium-impact decisions", () => {
  const proposal = buildRulesProposal([profile]);
  assert.deepEqual(proposal.decisions.map((decision) => decision.ruleId), ["modules.barrels"]);
  const repository = proposal.rules.repositories[0];
  assert.equal(repository?.rules.find((rule) => rule.id === "naming.files")?.kind, "inferred");
  assert.equal(repository?.stackFingerprint, profileStackFingerprint(profile));
});

test("rules digest filters appliesTo paths and AGENTS projection supports Spanish and English", () => {
  const proposal = buildRulesProposal([profile]);
  const rules = proposal.rules;
  assert.ok(rulesDigest(rules, "web", ["repos/web/src/user-card.tsx"]).some((rule) => rule.id === "naming.files"));
  assert.equal(rulesDigest(rules, "web", ["repos/web/src/user-card.tsx"]).some((rule) => rule.id === "styles.no-important"), true);
  assert.equal(rulesDigest(rules, "web", ["repos/web/src/service.php"]).some((rule) => rule.id === "styles.no-important"), false);
  assert.ok(ruleInvariants(rules, "web", ["repos/web/src/user-card.tsx"]).includes("Name files using kebab-case."));
  assert.equal(ruleInvariants(rules, "web", ["repos/web/src/user-card.tsx"]).some((statement) => statement.startsWith("Use bun")), false);
  assert.match(renderAgentsMarkdown(profile, rules.repositories[0]!, "es", rules.preferences), /Cómo trabajar/u);
  assert.match(renderWorkspaceAgentsMarkdown(rules, [profile], "en"), /How agents should work here/u);
});

test("rules become stale only when both the index and detected stack change", () => {
  const rules: WorkspaceRules = buildRulesProposal([profile]).rules;
  const contentOnly = { ...profile, generatedFromIndex: "b".repeat(64) };
  assert.deepEqual(staleRuleRepositories(rules, [contentOnly]), []);
  const stackChanged = { ...contentOnly, stack: { ...contentOnly.stack, frameworks: ["Next.js"] } };
  assert.deepEqual(staleRuleRepositories(rules, [stackChanged]), ["web"]);
});
