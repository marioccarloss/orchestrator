import { join } from "node:path";
import type { InstallTarget } from "./installer.js";

export interface AdapterArtifact {
  readonly owner: "codex" | "cursor" | "claude" | "antigravity" | "agy";
  readonly path: string;
  readonly content: string;
  readonly invocation: string;
}

type Workflow = "flow" | "blueprint" | "flow-models";

const descriptions: Record<Workflow, string> = {
  flow: "Start or continue the deterministic mr-orchestrator delivery workflow",
  blueprint: "Develop a product idea or analyze and dispatch a GitHub ticket with mr-orchestrator",
  "flow-models": "Inspect and change mr-orchestrator role model assignments with explicit confirmation",
};

const grounding = `Grounding contract (mandatory): use only supplied tickets, typed capsules, tool results, specifications, and inspected source/diffs. Never invent files, behavior, requirements, or command results. When essential evidence is missing, stop with {"status":"INSUFFICIENT_EVIDENCE","missing":["<specific missing evidence>"],"nextAction":"<smallest action that can obtain it>"}.`;

function workflowBody(workflow: Workflow, input: string): string {
  const binding = `First call \`mr_bind_workspace\` with exactly one registered workspaceId or workspacePath. Use the current project root only when it is registered; if binding fails, ask the user which registered workspace to use.`;
  if (workflow === "flow") {
    return `${grounding}

You are executing the mr-orchestrator /flow workflow.

${binding}

1. Call \`mr_flow_status\` and resume the active phase rather than starting over.
2. If no flow exists, obtain ticketId, Fibonacci difficulty (1, 3, 5, 8, 13, or 21), and whether a Figma design exists, then call \`mr_flow_start\`. Dificultad >= 5 enforces mandatory Judgment Day.
3. Advance only through the phase reported by the state machine:
   - context: inspect the ticket and call \`mr_flow_ticket\`.
   - explore: gather file:line evidence with \`mr_atlas_query\` / \`mr_atlas_skeleton\` and submit a valid ResearchCapsule with \`mr_sdd_submit(kind: "research")\`.
   - plan: first run Blueprint-lite with \`mr_sdd_submit(kind: "brief")\`. Clear tickets submit READY immediately. Only material ambiguity may return NEEDS_INPUT with at most 3 risk-prioritized questions; ask once, pass answers back to planning, and persist READY. Then submit SpecCapsule and TaskGraph with kinds spec and tasks. Verify acyclic DAG, full Rn -> Tn coverage, and research evidence for every modified file in Full flows. Call \`mr_flow_plan\` with the consolidated files. Show its deterministic "Plan, en breve" once without paraphrasing it.
   - implement: repeatedly call \`mr_sdd_get(kind: "next-task")\` for the next task ("pase gol"). Show its ultra-compact developerNote (what/why/touch/prove) once without expanding it. Respect its required implementer: Fibonacci 1-3 uses only general; 5+ uses only sdd-apply. Implement within declared task files, run its verification commands, mark it done with \`mr_sdd_task_status\`, then call \`mr_flow_implement\` when no actionable task remains.
   - judgment: for difficulty >= 5, perform two independent blind adversarial reviews in parallel and submit both through \`mr_flow_judge\`. Each finding must provide severity, claim, file, line, side=new|old, source=diff, and an exact evidence snippet; unsupported citations are rejected mechanically.
   - fix: address validated critical findings and call \`mr_flow_fix\`. Bounded loop of max 3 attempts.
   - gate: execute the authoritative test/verification command (e.g. \`npm run verify\` in code/ for frontend or \`mvn clean verify\` for backend). Fail-closed: exit code 0 required before any commit/push/PR.
   - finish: call \`mr_flow_finish\` only after the user confirms the closing action via interactive prompt.
4. Preserve role isolation even when this host has no native mr-orchestrator subagents. Run each phase as an independent role pass with only its required evidence. Resolve models from the host configuration; never embed a model snapshot in this prompt:
   - explore role: read-only research and file:line evidence (edit: deny, bash: deny);
   - plan role: Blueprint-lite ambiguity assessment, specification, and dependency-ordered task graph without editing code; ask only high-impact questions, enforce Gherkin acceptance criteria and an acyclic DAG;
    - general role: sole implementer for Fibonacci 1-3; implement only the active task with minimal diff and run declared verification commands;
    - sdd-apply role: specialized implementer for Fibonacci 5+; satisfy every acceptance criterion and run strict verification;
   - judge-a role: independent adversarial review as Hardened Security & Contract Auditor; penalize ambiguous types, leaks, concurrency bugs, and side effects outside the diff;
   - judge-b role: independent adversarial review as QA & Regression Specialist; penalize missing tests, edge cases, backwards compatibility, and Gherkin non-compliance;
   - Both judges receive ONLY CAS diff (git diff HEAD) and ticket/spec in isolated blind context. Strict consensus: approval requires both approve; any critical issue rejects and triggers fix role.
   - fix role: apply only validated critical findings, with a maximum of 3 attempts before human escalation.
5. Treat tool validation errors as authoritative, correct the payload, and retry. Never skip or invent state transitions or provider cost. Flow status is the authoritative progress/spend display. Never generate raw prose markdown for SDD capsules; payloads must validate against Zod schemas. Ask for explicit confirmation before destructive mutations, commits, pull requests, aborts, or closing actions.

---
[CONTEXT_INPUT_PAYLOAD]
${input}`;
  }

  if (workflow === "blueprint") return `${grounding}

You are executing the mr-orchestrator /blueprint workflow.

${binding}

1. Determine whether the user wants to develop a product/business idea or analyze a GitHub/Project v2 ticket.
2. For an idea:
   - gather only relevant context and code evidence;
   - produce a concise product and architecture synthesis;
   - optionally ask 10, 20, or 50 risk-prioritized strategic questions;
   - compile SDD entities, invariants, contracts, test conditions, RPI intent, transversal impact, explicit assumptions, and optional atomic tasks;
   - call \`mr_blueprint_save\` and report the generated JSON and Markdown paths.
3. For a ticket:
   - detect or ask for the repository and retrieve the issue or Project v2 item;
   - assess objectives, impact, dependencies, relevant code evidence, and proposed modifications;
   - before every create, update, or delete, call \`mr_blueprint_safety_gate\`, show its preview, and obtain explicit user confirmation;
   - execute confirmed GraphQL operations with \`mr_blueprint_graphql\` and return the resulting URL.
4. Never mutate GitHub from an inferred instruction. Preserve unanswered points as explicit assumptions rather than fabricating facts.

---
[CONTEXT_INPUT_PAYLOAD]
${input}`;

  return `${grounding}

You are executing the mr-orchestrator /flow-models workflow.

${binding}

1. Call \`mr_models\` with action=status and show each role's primary model and configured alternative.
2. If the input identifies a role after a quota failure, call \`mr_models\` with action=candidates, that role, and failedModel when known. Otherwise call action=providers, ask which provider to inspect, then call action=models for that provider.
3. Present the alternatives and state that catalog presence does not prove available quota. Never claim that a candidate has available quota.
4. Ask for explicit confirmation naming the role, target slot (model or alternative), and exact provider/model value. Cancellation or ambiguity means do not mutate anything.
5. Only after explicit confirmation, call \`mr_models\` with action=set, role, model, and target. Then call action=status to verify that only the requested slot changed.
6. A non-recoverable quota error automatically promotes that role's configured alternative and preserves the failed primary as the next alternative. The interrupted Flow/SDD unit remains persisted; never replay it automatically because it may contain side effects.

---
[CONTEXT_INPUT_PAYLOAD]
${input}`;
}

function markdownCommand(workflow: Workflow): string {
  return `---
description: ${descriptions[workflow]}
argument-hint: "[request, ticket, or idea]"
---

# mr-orchestrator ${workflow}

${workflowBody(workflow, "$ARGUMENTS")}
`;
}

function skill(workflow: Workflow, invocation: string, explicitOnly = false): string {
  return `---
name: ${workflow}
description: ${descriptions[workflow]}. Use when the user explicitly invokes ${invocation} or asks for this workflow.
${explicitOnly ? "disable-model-invocation: true\n" : ""}---

# mr-orchestrator ${workflow}

Treat any text following ${invocation} as the workflow input.

${workflowBody(workflow, "the text supplied with the invocation")}
`;
}

function geminiCommand(workflow: Workflow): string {
  return `description = ${JSON.stringify(descriptions[workflow])}\nprompt = ${JSON.stringify(workflowBody(workflow, "{{args}}"))}\n`;
}

function workflows<T>(factory: (workflow: Workflow) => T): T[] {
  return [factory("flow"), factory("blueprint"), factory("flow-models")];
}

export function adapterArtifacts(targets: InstallTarget[], home: string): AdapterArtifact[] {
  const selected = new Set(targets);
  const artifacts: AdapterArtifact[] = [];

  if (selected.has("codex-cli") || selected.has("codex-desktop")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "codex" as const,
      path: join(home, ".codex", "skills", workflow, "SKILL.md"),
      content: skill(workflow, `$${workflow}`),
      invocation: `$${workflow}`,
    })));
  }
  if (selected.has("cursor-cli") || selected.has("cursor-desktop")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "cursor" as const,
      path: join(home, ".cursor", "skills", workflow, "SKILL.md"),
      content: skill(workflow, `/${workflow}`, true),
      invocation: `/${workflow}`,
    })));
  }
  if (selected.has("claude-code")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "claude" as const,
      path: join(home, ".claude", "commands", `${workflow}.md`),
      content: markdownCommand(workflow),
      invocation: `/${workflow}`,
    })));
  }
  if (selected.has("antigravity-desktop")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "antigravity" as const,
      path: join(home, ".gemini", "config", "skills", workflow, "SKILL.md"),
      content: skill(workflow, workflow),
      invocation: workflow,
    })));
  }
  if (selected.has("agy-cli")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "agy" as const,
      path: join(home, ".gemini", "commands", `${workflow}.toml`),
      content: geminiCommand(workflow),
      invocation: `/${workflow}`,
    })));
  }

  return artifacts;
}
