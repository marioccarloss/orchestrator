import { z } from "zod";
import type { RuleDigest } from "../context-hydrator.js";
import type { RepositoryProfile, RuleFact } from "./profiler.js";
import { profileStackFingerprint } from "./profiler.js";
import { matchesRulePath } from "./match.js";

export const DeveloperPreferenceSchema = z.enum([
  "minimal-reversible-changes",
  "strict-typing",
  "tests-with-behavior-changes",
  "allow-justified-local-refactors",
  "no-new-dependencies-without-reason",
  "explicit-over-abstract",
  "ask-before-architecture-changes",
]);

export const RepositoryRuleSchema = z.strictObject({
  id: z.string().min(1), value: z.string().min(1).max(100), statement: z.string().min(1).max(200),
  kind: z.enum(["fact", "inferred", "confirmed"]), confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().max(200)).max(5), appliesTo: z.array(z.string()).default([]),
  severity: z.enum(["info", "warn", "block"]).default("warn"),
});

export const RepositoryRulesSchema = z.strictObject({
  schemaVersion: z.literal(1), repo: z.string().min(1), mode: z.literal("baseline"),
  generatedFromIndex: z.string().length(64), stackFingerprint: z.string().length(64).optional(), confirmedAt: z.iso.datetime().optional(), rules: z.array(RepositoryRuleSchema),
});

export const WorkspaceRulesSchema = z.strictObject({
  schemaVersion: z.literal(1), generatedAt: z.iso.datetime(), preferences: z.array(DeveloperPreferenceSchema),
  repositories: z.array(RepositoryRulesSchema),
});

export const RuleDecisionSchema = z.strictObject({
  id: z.string().regex(/^D\d+$/u), ruleId: z.string().min(1), repos: z.array(z.string()).min(1),
  question: z.string().min(1).max(200),
  options: z.array(z.strictObject({ value: z.string(), label: z.string().max(80), recommended: z.boolean().default(false) })).min(2).max(4),
});

export type DeveloperPreference = z.infer<typeof DeveloperPreferenceSchema>;
export type RepositoryRule = z.infer<typeof RepositoryRuleSchema>;
export type RepositoryRules = z.infer<typeof RepositoryRulesSchema>;
export type WorkspaceRules = z.infer<typeof WorkspaceRulesSchema>;
export type RuleDecision = z.infer<typeof RuleDecisionSchema>;

export interface RulesProposal {
  readonly rules: WorkspaceRules;
  readonly decisions: readonly RuleDecision[];
  readonly preferences: readonly DeveloperPreference[];
}

const IMPACT_ORDER = ["naming.files", "modules.barrels", "styles.approach", "testing.location", "layout.style"] as const;

function imperative(row: RuleFact): string {
  const statements: Record<string, string> = {
    "naming.files": `Name files using ${row.value}.`,
    "modules.barrels": row.value === "avoid" ? "Avoid barrel files." : "Keep barrel files only where they already exist.",
    "styles.approach": `Use ${row.value} for styles.`,
    "testing.location": `Place tests ${row.value}.`,
    "quality.strict": "Preserve strict typing; do not introduce any.",
    "styles.no-important": row.value === "forbid" ? "Do not introduce !important." : "Do not expand existing !important usage.",
  };
  return statements[row.id] ?? row.statement;
}

function appliesTo(row: RuleFact): readonly string[] {
  if (row.id === "naming.files") return ["**/*"];
  if (row.id === "modules.barrels") return ["**/index.ts", "**/index.tsx", "**/index.js", "**/index.jsx"];
  if (row.id.startsWith("styles.")) return ["**/*.css", "**/*.scss", "**/*.tsx", "**/*.jsx"];
  if (row.id.startsWith("backend.")) return ["**/*.php", "**/*.ts", "**/*.java"];
  if (row.id.startsWith("testing.")) return ["**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*"];
  return [];
}

function toRule(row: RuleFact, kind: RepositoryRule["kind"]): RepositoryRule {
  return RepositoryRuleSchema.parse({ id: row.id, value: row.value, statement: imperative(row), kind, confidence: row.confidence, evidence: row.evidence, appliesTo: appliesTo(row), severity: row.id.startsWith("commands.") ? "info" : "warn" });
}

function optionsFor(row: RuleFact): RuleDecision["options"] {
  if (row.id === "modules.barrels") return [
    { value: row.value, label: "Keep only where present", recommended: true },
    { value: "always", label: "Use in every module", recommended: false },
    { value: "avoid", label: "Avoid barrels", recommended: false },
  ];
  return [
    { value: row.value, label: `Use ${row.value}`, recommended: true },
    { value: "existing-only", label: "Keep local convention", recommended: false },
  ];
}

export function buildRulesProposal(profiles: readonly RepositoryProfile[]): RulesProposal {
  const preferences: DeveloperPreference[] = ["minimal-reversible-changes", "no-new-dependencies-without-reason", "ask-before-architecture-changes"];
  if (profiles.some((profile) => profile.facts.some((row) => row.id === "quality.strict"))) preferences.push("strict-typing");
  if (profiles.some((profile) => [...profile.facts, ...profile.inferences].some((row) => row.id === "testing.location"))) preferences.push("tests-with-behavior-changes");
  const candidates = profiles.flatMap((profile) => profile.inferences
    .filter((row) => row.confidence < 0.85 && IMPACT_ORDER.includes(row.id as typeof IMPACT_ORDER[number]))
    .map((row) => ({ profile, row })));
  const grouped = new Map<string, typeof candidates>();
  for (const candidate of candidates) grouped.set(candidate.row.id, [...(grouped.get(candidate.row.id) ?? []), candidate]);
  const decisions = [...grouped]
    .sort((a, b) => IMPACT_ORDER.indexOf(a[0] as typeof IMPACT_ORDER[number]) - IMPACT_ORDER.indexOf(b[0] as typeof IMPACT_ORDER[number]))
    .slice(0, 3)
    .flatMap(([ruleId, rows], index) => {
      const first = rows[0];
      if (first === undefined) return [];
      return [RuleDecisionSchema.parse({
        id: `D${index + 1}`, ruleId, repos: rows.map(({ profile }) => profile.repo),
        question: `A mixed convention was detected for ${ruleId}. Which baseline should agents follow?`, options: optionsFor(first.row),
      })];
    });
  const decisionIds = new Set(decisions.map((decision) => decision.ruleId));
  const repositories = profiles.map((profile) => RepositoryRulesSchema.parse({
    schemaVersion: 1, repo: profile.repo, mode: "baseline", generatedFromIndex: profile.generatedFromIndex, stackFingerprint: profileStackFingerprint(profile),
    rules: [
      ...profile.facts.map((row) => toRule(row, "fact")),
      ...profile.inferences.map((row) => toRule(row, decisionIds.has(row.id) ? "inferred" : "inferred")),
    ],
  }));
  return { rules: WorkspaceRulesSchema.parse({ schemaVersion: 1, generatedAt: new Date().toISOString(), preferences, repositories }), decisions, preferences };
}

export function applyRuleDecisions(proposal: RulesProposal, answers: ReadonlyMap<string, string>, preferences: readonly DeveloperPreference[]): WorkspaceRules {
  const byRule = new Map(proposal.decisions.map((decision) => [decision.ruleId, { decision, value: answers.get(decision.id) ?? decision.options.find((option) => option.recommended)?.value }]));
  return WorkspaceRulesSchema.parse({
    ...proposal.rules,
    generatedAt: new Date().toISOString(),
    preferences,
    repositories: proposal.rules.repositories.map((repository) => ({
      ...repository,
      confirmedAt: new Date().toISOString(),
      rules: repository.rules.map((rule) => {
        const selected = byRule.get(rule.id);
        if (selected?.value === undefined || !selected.decision.repos.includes(repository.repo)) return rule;
        const row: RuleFact = { id: rule.id, value: selected.value, statement: rule.statement, confidence: 1, evidence: rule.evidence };
        const severity = ["naming.files", "modules.barrels", "styles.no-important"].includes(rule.id) ? "block" as const : rule.severity;
        return { ...rule, value: selected.value, statement: imperative(row), kind: "confirmed" as const, confidence: 1, severity };
      }),
    })),
  });
}

export function rulesDigest(rules: WorkspaceRules, repo: string | undefined, files: readonly string[] = []): readonly RuleDigest[] {
  const repositories = repo === undefined ? rules.repositories : rules.repositories.filter((candidate) => candidate.repo === repo);
  const digest = repositories.flatMap((repository) => repository.rules)
    .filter((rule) => files.length === 0 || rule.appliesTo.length === 0 || files.some((file) => matchesRulePath(file, rule.appliesTo)))
    .map((rule) => ({ id: rule.id, statement: rule.statement, severity: rule.severity }));
  return [...new Map(digest.map((rule) => [`${rule.id}:${rule.statement}:${rule.severity}`, rule])).values()];
}

export function ruleInvariants(rules: WorkspaceRules, repo: string | undefined, files: readonly string[]): readonly string[] {
  return rulesDigest(rules, repo, files).filter((rule) => rule.severity !== "info").map((rule) => rule.statement);
}
