import * as p from "@clack/prompts";
import { applyRuleDecisions, type DeveloperPreference, type RulesProposal, type WorkspaceRules } from "../core/rules/generator.js";
import type { RepositoryProfile } from "../core/rules/profiler.js";
import type { AgentsLanguage } from "../core/rules/render.js";

export interface AtlasOnboardingOptions { readonly guided?: boolean; readonly language?: AgentsLanguage }
export type AtlasOnboardingResult = { readonly action: "skip" } | { readonly action: "accept"; readonly rules: WorkspaceRules };

const PREFERENCE_OPTIONS: Record<AgentsLanguage, readonly { value: DeveloperPreference; label: string }[]> = {
  en: [
    { value: "minimal-reversible-changes", label: "Minimal reversible changes" }, { value: "strict-typing", label: "Strict typing, no any" },
    { value: "tests-with-behavior-changes", label: "Tests with behavior changes" }, { value: "allow-justified-local-refactors", label: "Justified local refactors" },
    { value: "no-new-dependencies-without-reason", label: "No unjustified dependencies" }, { value: "explicit-over-abstract", label: "Explicit before abstract" },
    { value: "ask-before-architecture-changes", label: "Ask before architecture changes" },
  ],
  es: [
    { value: "minimal-reversible-changes", label: "Cambios mínimos y reversibles" }, { value: "strict-typing", label: "Tipado estricto, sin any" },
    { value: "tests-with-behavior-changes", label: "Tests con cambios de comportamiento" }, { value: "allow-justified-local-refactors", label: "Refactors locales justificados" },
    { value: "no-new-dependencies-without-reason", label: "Evitar dependencias sin justificación" }, { value: "explicit-over-abstract", label: "Código explícito antes que abstracciones" },
    { value: "ask-before-architecture-changes", label: "Preguntar antes de cambios arquitectónicos" },
  ],
};

export async function runAtlasOnboarding(proposal: RulesProposal, profiles: readonly RepositoryProfile[], options: AtlasOnboardingOptions = {}): Promise<AtlasOnboardingResult> {
  const language = options.language ?? "en";
  const es = language === "es";
  p.note(profiles.map((profile) => `${profile.repo.padEnd(12)} ${profile.kind} · ${profile.layout.style} · ${profile.stack.frameworks.join(", ") || profile.stack.languages.join(", ")}`).join("\n"), es ? "Propuesta de reglas para agentes" : "Agent rules proposal");
  const action = await p.select({
    message: es ? "¿Qué quieres hacer?" : "What would you like to do?",
    initialValue: "accept",
    options: [
      { value: "accept", label: es ? "Aceptar propuesta" : "Accept proposal", hint: "Enter" },
      ...(proposal.decisions.length > 0 || options.guided === true ? [{ value: "review", label: `${es ? "Revisar decisiones" : "Review decisions"} (${proposal.decisions.length})` }] : []),
      { value: "preferences", label: es ? "Ajustar estilo de trabajo" : "Adjust working style" },
      { value: "diagnostic", label: es ? "Ver diagnóstico" : "View diagnostics" },
      { value: "skip", label: es ? "Saltar por ahora" : "Skip for now" },
    ],
  });
  if (p.isCancel(action) || action === "skip") return { action: "skip" };
  if (action === "diagnostic") {
    p.note(profiles.flatMap((profile) => [...profile.facts, ...profile.inferences].map((row) => `${profile.repo}: ${row.id}=${row.value} (${row.confidence.toFixed(2)})`)).join("\n"), es ? "Diagnóstico Atlas" : "Atlas diagnostics");
    return runAtlasOnboarding(proposal, profiles, options);
  }
  let preferences = proposal.preferences;
  const answers = new Map<string, string>();
  if (action === "review") {
    for (const decision of proposal.decisions) {
      const answer = await p.select({ message: decision.question, options: decision.options.map((option) => ({
        value: option.value,
        label: option.label,
          ...(option.recommended ? { hint: es ? "recomendado" : "recommended" } : {}),
      })) });
      if (p.isCancel(answer)) return { action: "skip" };
      answers.set(decision.id, answer);
    }
  }
  if (action === "preferences" || options.guided === true) {
    const selected = await p.multiselect({ message: es ? "¿Cómo quieres que trabajen los agentes?" : "How should agents work?", options: [...PREFERENCE_OPTIONS[language]], initialValues: [...preferences], required: false });
    if (p.isCancel(selected)) return { action: "skip" };
    preferences = selected;
  }
  return { action: "accept", rules: applyRuleDecisions(proposal, answers, preferences) };
}
