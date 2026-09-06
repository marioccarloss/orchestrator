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

function workflowBody(workflow: Workflow, input: string): string {
  const binding = `First call \`mr_bind_workspace\` with exactly one registered workspaceId or workspacePath. Use the current project root only when it is registered; if binding fails, ask the user which registered workspace to use.`;
  if (workflow === "flow") {
    return `You are executing the mr-orchestrator /flow workflow.
Input: ${input}

${binding}

1. Call \`mr_flow_status\` and resume the active phase rather than starting over.
2. If no flow exists, obtain ticketId, Fibonacci difficulty (1, 3, 5, 8, 13, or 21), and whether a Figma design exists, then call \`mr_flow_start\`.
3. Advance only through the phase reported by the state machine:
   - context: inspect the ticket and call \`mr_flow_ticket\`.
   - explore: gather file:line evidence and submit a valid research capsule with \`mr_sdd_submit\`.
   - plan: submit spec and task capsules with \`mr_sdd_submit\`, then call \`mr_flow_plan\` with the consolidated files.
   - implement: repeatedly call \`mr_sdd_get\` for the next task, implement and run its verification, mark it done with \`mr_sdd_task_status\`, then call \`mr_flow_implement\` when no actionable task remains.
   - judgment: for difficulty 5 or greater, perform two independent adversarial reviews and submit both through \`mr_flow_judge\`.
   - fix: address validated findings and call \`mr_flow_fix\`.
   - finish: run final verification and call \`mr_flow_finish\` only after the user confirms the closing action.
4. Preserve role isolation even when this host has no native mr-orchestrator subagents. Run each phase as an independent role pass with only its required evidence:
   - explore role: read-only research and file:line evidence;
   - plan role: specification and dependency-ordered task graph, without editing code;
   - general role: implement only the active task;
   - judge-a role and judge-b role: separate adversarial reviews without editing;
   - fix role: apply only validated findings.
5. Treat tool validation errors as authoritative, correct the payload, and retry. Never skip or invent state transitions. Ask for explicit confirmation before destructive mutations, commits, pull requests, aborts, or closing actions.`;
  }

  if (workflow === "blueprint") return `You are executing the mr-orchestrator /blueprint workflow.
Input: ${input}

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
4. Never mutate GitHub from an inferred instruction. Preserve unanswered points as explicit assumptions rather than fabricating facts.`;

  return `You are executing the mr-orchestrator /flow-models workflow.
Input: ${input}

${binding}

1. Call \`mr_models\` with action=status and show the current role assignments.
2. If the input identifies a role after a quota failure, call \`mr_models\` with action=candidates, that role, and failedModel when known. Otherwise call action=providers, ask which provider to inspect, then call action=models for that provider.
3. Present the alternatives and state that catalog presence does not prove available quota. Never claim that a candidate has available quota.
4. Ask for explicit confirmation naming the role and exact provider/model value. Cancellation or ambiguity means do not mutate anything.
5. Only after explicit confirmation, call \`mr_models\` with action=set, role, and model. Then call action=status to verify that only the requested role changed.
6. When recovering from quota exhaustion, remind the user that the interrupted Flow/SDD unit remains persisted and must be resumed manually; never retry automatically.`;
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
