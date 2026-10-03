import { join } from "node:path";
import type { InstallTarget } from "./installer.js";
import type { HarnessId } from "./harness.js";

export interface AdapterArtifact {
  readonly owner: "codex" | "cursor" | "claude" | "antigravity" | "agy" | "fx" | "pi";
  readonly path: string;
  readonly content: string;
  readonly invocation: string;
}

type Workflow = "work" | "flow" | "task" | "blueprint" | "flow-models" | "choose-model";

const descriptions: Record<Workflow, string> = {
  work: "Route everyday repository work adaptively without starting a formal Flow",
  flow: "Start or continue the deterministic mr-orchestrator delivery workflow",
  task: "Fast mr-orchestrator delivery: explore, plan, apply with Jev deciding how much to read, what to hand off, and what to verify",
  blueprint: "Develop a product idea or analyze and dispatch a GitHub ticket with mr-orchestrator",
  "flow-models": "Inspect and change mr-orchestrator role model assignments with explicit confirmation",
  "choose-model": "Choose the best connected or catalog model for a role or task, checking current public prices",
};

const grounding = `Grounding contract (mandatory): use only supplied tickets, typed capsules, tool results, specifications, and inspected source/diffs. Never invent files, behavior, requirements, or command results. When essential evidence is missing, stop with {"status":"INSUFFICIENT_EVIDENCE","missing":["<specific missing evidence>"],"nextAction":"<smallest action that can obtain it>"}.`;
const security = `Security boundary (mandatory): never read, edit, copy, print, summarize, or transmit credential material from .env files, SSH keys, keychains, cloud credentials, provider auth files, certificates, or secrets directories. Do not discover or reuse ambient credentials or sessions. Remote execution or transfer requires explicit authorization naming the destination and operation; local development access is not remote authorization.`;

function workflowBody(workflow: Workflow, input: string, harness: HarnessId, runnerCommand: readonly string[]): string {
  const server = harness === "antigravity" || harness === "agy" ? `mr-orchestrator-${harness}` : "mr-orchestrator";
  const binding = `Use only the \`${server}\` MCP server for mr-orchestrator tools. Before calling \`mr_bind_workspace\`, determine the host's current working directory from runtime context or by running \`pwd\`, then run \`mr workspace list\` and choose the registered workspace whose root is the longest path prefix of that directory. Call \`mr_bind_workspace\` with exactly one argument: \`workspaceId\` for that match, or \`workspacePath\` equal to its exact registered root. Never call it with empty arguments or both fields. If no registered workspace contains the current directory, ask the user to choose one and do not call the bind tool until they answer. Then call \`mr_models\` with action=validate and harness=${harness}; stop before role dispatch if validation fails.`;
  const decisionPlane = "When deterministic evidence leaves material ambiguity, call `mr_decision_evaluate` with one bounded profile and compact evidence. Jev is shadow-only: its probability can recommend but never override the FSM, gates, explicit denies, or human confirmation.";
  const runner = runnerCommand.map((part) => JSON.stringify(part)).join(" ");
  const usesRunner = harness === "codex" || harness === "cursor" || harness === "claude" || harness === "agy" || harness === "fx" || harness === "pi";
  const roleDispatch = usesRunner
    ? `${harness} application contract: this host is per-invocation. Execute every isolated role pass through \`${runner} run-role ${harness} <role> -- <bounded role prompt>\`. That owned runner resolves and validates the current source configuration, then launches the host CLI with the role's native model and variant; never execute a role pass with the parent session model.`
    : "";
  if (workflow === "work") {
    return `${grounding}

${security}

You are executing mr-orchestrator ODD-lite everyday work.

${binding}

1. Establish authorization first. Explanation, investigation, review, and proposal-only requests remain read-only.
2. Explore only enough to understand the bounded request, then call \`mr_work_route\` with observed file counts and honest expected scope.
3. Follow the returned route exactly:
   - read-only: do not mutate files, repository state, external services, or configuration;
   - direct: make the small understood change and run focused verification;
   - tracked: call \`mr_work_track\` before the first source write, keep its tasks/evidence/nextStep synchronized after material progress, and mark it completed only after observed verification.
4. Never start /flow automatically because work is large, risky, or uncertain. Formal Flow starts only when the user explicitly invokes or accepts it.
5. Preserve unrelated changes and named scope boundaries. Findings do not authorize scope expansion.
6. After a git/worktree/cwd incident, confusing command, or environment workaround, route again with incident=true and obtain fresh review evidence before completion.
7. Report failed, blocked, and unobserved checks honestly. Never claim success from inference.

---
[CONTEXT_INPUT_PAYLOAD]
${input}`;
  }
  if (workflow === "flow") {
    return `${grounding}

${security}

You are executing the mr-orchestrator /flow workflow.

${binding}

${decisionPlane}

1. Call \`mr_flow_status\` and resume the active phase rather than starting over.
2. If no flow exists, obtain ticketId, Fibonacci difficulty (1, 3, 5, 8, 13, or 21), and whether a Figma design exists, then call \`mr_flow_start\`. Dificultad >= 5 enforces mandatory Judgment Day.
3. Advance only through the phase reported by the state machine:
   - context: inspect the ticket and call \`mr_flow_ticket\`. Reuse its Atlas warm-up and Engram prefetch; only call \`mr_flow_memory_prefetch\` if the task scope changed materially.
   - intent: after \`mr_flow_ticket\`, review the auto-generated PROPOSED draft (sweeps S0–S4). Optionally refine with \`mr-intent\` + \`mr_flow_intent_resolve\` or \`mr_sdd_submit(kind: "intent")\`. Human questions are exceptional (NEEDS_INPUT with suggested defaults). Call \`mr_flow_intent approved=true\` after explicit confirmation; on full/critical lanes pass \`confirmMediumAssumptions=true\` when medium assumptions exist.
   - explore: reuse approved intent and prefetched Engram memory from \`mr_context_hydrate\` before any new mem_search. Gather file:line evidence with \`mr_atlas_query\` / \`mr_atlas_skeleton\` and submit a valid ResearchCapsule with \`mr_sdd_submit(kind: "research")\`.
   - plan: first run Blueprint-lite with \`mr_sdd_submit(kind: "brief")\`. Clear tickets submit READY immediately. Only material ambiguity may return NEEDS_INPUT with at most 3 risk-prioritized questions; ask once, pass answers back to planning, and persist READY. Then submit SpecCapsule and TaskGraph with kinds spec and tasks. Verify acyclic DAG, full Rn -> Tn coverage, and research evidence for every modified file in Full flows. Call \`mr_flow_plan\` with the consolidated files. Show its deterministic "Plan, en breve" once without paraphrasing it.
   - implement: repeatedly call \`mr_sdd_get(kind: "next-task")\` for the next task ("pase gol"). Show its ultra-compact developerNote (what/why/touch/prove) once without expanding it. Respect its required implementer: Fibonacci 1-3 uses only general; 5+ uses only sdd-apply. Implement within declared task files, run its verification commands, mark it done with \`mr_sdd_task_status\`, then call \`mr_flow_implement\` when no actionable task remains.
   - judgment: for difficulty >= 5, perform two independent blind adversarial reviews in parallel. Each judge retrieves the same integrity-checked frozen diff with \`mr_judgment_candidate\`, starting at offset=0 and following nextOffset until done=true, then submits through \`mr_flow_judge\`. Each finding must provide severity, claim, file, line, side=new|old, source=diff, and an exact evidence snippet; unsupported citations are rejected mechanically.
   - fix: address validated critical findings and call \`mr_flow_fix\`. Bounded loop of max 3 attempts.
   - gate: execute the authoritative test/verification command (e.g. \`npm run verify\` in code/ for frontend or \`mvn clean verify\` for backend). Fail-closed: exit code 0 required before any commit/push/PR.
   - finish: call \`mr_flow_finish\` only after the user confirms the closing action via interactive prompt. The plugin saves a compact delivery summary to Engram automatically.
4. Preserve role isolation even when this host has no native mr-orchestrator subagents. Run each phase as an independent role pass with only its required evidence. Resolve models from the host configuration; never embed a model snapshot in this prompt. ${roleDispatch}
   - explore role: read-only research and file:line evidence (edit: deny, bash: deny);
   - plan role: Blueprint-lite ambiguity assessment, specification, and dependency-ordered task graph without editing code; ask only high-impact questions, enforce Gherkin acceptance criteria and an acyclic DAG;
    - general role: sole implementer for Fibonacci 1-3; implement only the active task with minimal diff and run declared verification commands;
    - sdd-apply role: specialized implementer for Fibonacci 5+; satisfy every acceptance criterion and run strict verification;
   - judge-a role: independent adversarial review as Hardened Security & Contract Auditor; penalize ambiguous types, leaks, concurrency bugs, and side effects outside the diff;
   - judge-b role: independent adversarial review as QA & Regression Specialist; penalize missing tests, edge cases, backwards compatibility, and Gherkin non-compliance;
   - Both judges receive ONLY the same frozen CAS candidate and ticket/spec in isolated blind context. Strict consensus: approval requires both approve; any critical issue rejects and triggers fix role.
   - fix role: apply only validated critical findings, with a maximum of 3 attempts before human escalation.
5. Treat tool validation errors as authoritative, correct the payload, and retry. Never skip or invent state transitions or provider cost. Flow status is the authoritative progress/spend display. Never generate raw prose markdown for SDD capsules; payloads must validate against Zod schemas. Ask for explicit confirmation before destructive mutations, commits, pull requests, aborts, or closing actions.

---
[CONTEXT_INPUT_PAYLOAD]
${input}`;
  }

  if (workflow === "task") {
    const rolePass = usesRunner
      ? `Run each role as an isolated pass: \`${runner} run-role ${harness} <modelRole> [--variant <next.variant>] -- <role prompt>\` with modelRole explore, plan, or general; add --variant only when the last mr_task_* result returned next.variant (developer-configured effort for this strategy). Every role prompt must start with: "Use the \`${server}\` MCP server. Call \`mr_bind_workspace\` with workspaceId=<bound id> first." followed by the role contract below.`
      : "Run each role as an isolated pass with only its contract and the bound workspace id; never reuse this session's accumulated context for a role.";
    return `${grounding}

${security}

You are executing the mr-orchestrator /task fast delivery workflow. It is independent from /flow; never start /flow unless the user asks.

${binding}

${rolePass}

Role contracts (each role's final message is only the JSON returned by its last tool):
- explore (modelRole explore, read-only): read only what the brief allows (maxFilesToRead, useGraph, useRules). This host has no tool relay, so record every material read with \`mr_task_record\` kind=read (file + exact line range), plus fact, decision, discard (every ruled-out hypothesis and why), and unknown. For replicate find the existing reference first; for bugfix find a reproduction, the failing path, and ranked root causes. Finish with \`mr_task_explore_submit\` answering every requiredChecklist key concretely or as "unknown: <reason>"; if the code proves the intake strategy wrong, pass strategy and answer that strategy's checklist; if it returns gaps, close only those and resubmit.
- plan (modelRole plan, read-only): call \`mr_task_context\` role=plan first; mustKeep entries are binding, slices are live code, recover manifest ids with \`mr_task_recall\`. Ask material choices only through \`mr_task_ask\` (max 3 bounded questions). Submit \`mr_task_plan_submit\`: prefer exact \`code\` (applied without a model); replace/insertAfter/insertBefore anchors must be copied exactly and be unique; use \`intent\` + \`reference\` only when synthesis is needed; verification uses package.json scripts. Fix rejected issues exactly and resubmit.
- apply (modelRole general): for one stepId, call \`mr_task_context\` role=apply stepId=<id>, edit only that step's file, then \`mr_task_step_done\`. If the step cannot be done as written, record kind=unknown and stop.

Coordinator steps (you are the only role that talks to the developer):
1. Call \`mr_task_status\`; resume an active task from its phase.
2. Intake: fetch ticket (Jira, GitHub, GitLab) or design (Figma, image) content with the available MCP tools first, then call \`mr_task_start\` with the full text and ticketRef/designRef. If escalation.recommend=flow, tell the developer once and continue unless they choose /flow.
3. Phase explore: one explore pass with the returned brief. Do not read code yourself.
4. Phase plan: one plan pass. If \`mr_task_ask\` returned askHuman questions, ask the developer, record answers with \`mr_task_answer\`, and resume the plan pass.
5. Phase apply: call \`mr_task_apply\` (exact steps, no model). Run one apply pass per pendingModelSteps id, then call \`mr_task_apply\` again.
6. Call \`mr_task_verify\`. Phase apply after failure: apply pass for the failing step. Phase plan: new plan pass (the failure is in its handoff).
7. Call \`mr_task_finish\`. /task does not commit, push, or open PRs.

Show the developer only the plan glance, crucial questions, and the final result, in the developer's language, at most 5 lines each.

---
[CONTEXT_INPUT_PAYLOAD]
${input}`;
  }

  if (workflow === "blueprint") return `${grounding}

${security}

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

  if (workflow === "choose-model") return `${grounding}

${security}

You are executing the mr-orchestrator /choose-model workflow.

${binding}

1. The invocation text is the case: a role such as orchestrator, explore, or applying a change, or a task such as video, realistic images without a watermark, statistics, markets, or SEO.
2. Build the pool from the source the user named. Read a JSON path or attachment when they give one. Otherwise use models already available from a connected login: \`opencode models\` for OpenCode Zen and GitHub Copilot, the harness catalog for Claude or OpenAI, and the AI Gateway catalog when that login exists. Compare gpt, deepseek, qwen, glm, and claude when those families are in the pool.
3. Search the web for current public price and fit before choosing. A newer model can cost less than an older one, and catalogs go stale. Keep modality limits, including watermarks, from those pages. Do not put secrets in the brief.
4. Reduce the pool to at most 8. Each note needs the provider/model id, current price, and why it fits this case.
5. If \`mr_choose_model\` is registered, call it with the case as brief, the shortlist as candidates, and that format. If it is not registered, run \`mr choose-model --format <format> --catalog <path> --brief <case>\` and use its JSON. A missing plugin tool is not missing evidence. For a table of every orchestrator role, run that once per flow role with format \`table\`. Roles: orchestrator, explore, plan, general, sddApply, judgeA, judgeB, fix. Add blueprint roles only when the case includes blueprint.
6. Render only that shape in the user's language. scoring: id and score. boolean: id and yes-probability. json: the tool JSON unchanged. table: columns role, model, price, why. Do not change role assignments; that remains /flow-models.

---
[CONTEXT_INPUT_PAYLOAD]
${input}`;

  return `${grounding}

${security}

You are executing the mr-orchestrator /flow-models workflow.

${binding}

1. Call \`mr_models\` with action=status and harness=${harness}, then show each role's primary model, native target, origin, and configured alternative.
2. If the input identifies a role after a quota failure, call \`mr_models\` with action=candidates, harness=${harness}, that role, and failedModel when known. Otherwise call action=providers with harness=${harness}, ask which provider to inspect, then call action=models for that provider and harness.
3. Present the alternatives and state that catalog presence does not prove available quota. Never claim that a candidate has available quota.
4. Ask for explicit confirmation naming the role, target slot (model or alternative), and exact provider/model value. Cancellation or ambiguity means do not mutate anything.
5. Only after explicit confirmation, call \`mr_models\` with action=set, harness=${harness}, role, model, and target. Then call action=status with the same harness to verify that only the requested slot changed.
6. A non-recoverable quota error automatically promotes that role's configured alternative and preserves the failed primary as the next alternative. The interrupted Flow/SDD unit remains persisted; never replay it automatically because it may contain side effects.

---
[CONTEXT_INPUT_PAYLOAD]
${input}`;
}

function markdownCommand(workflow: Workflow, harness: HarnessId, runnerCommand: readonly string[]): string {
  return `---
description: ${descriptions[workflow]}
argument-hint: "[request, ticket, or idea]"
---

# mr-orchestrator ${workflow}

${workflowBody(workflow, "$ARGUMENTS", harness, runnerCommand)}
`;
}

function skill(workflow: Workflow, invocation: string, harness: HarnessId, runnerCommand: readonly string[], explicitOnly = false): string {
  return `---
name: ${workflow}
description: ${descriptions[workflow]}. Use when the user explicitly invokes ${invocation} or asks for this workflow.
${explicitOnly ? "disable-model-invocation: true\n" : ""}---

# mr-orchestrator ${workflow}

Treat any text following ${invocation} as the workflow input.

${workflowBody(workflow, "the text supplied with the invocation", harness, runnerCommand)}
`;
}

function geminiCommand(workflow: Workflow, harness: HarnessId, runnerCommand: readonly string[]): string {
  return `description = ${JSON.stringify(descriptions[workflow])}\nprompt = ${JSON.stringify(workflowBody(workflow, "{{args}}", harness, runnerCommand))}\n`;
}

function workflows<T>(factory: (workflow: Workflow) => T): T[] {
  return [factory("work"), factory("flow"), factory("task"), factory("blueprint"), factory("flow-models"), factory("choose-model")];
}

export function adapterArtifacts(targets: InstallTarget[], home: string, runnerCommand: readonly string[] = ["mr-clients"]): AdapterArtifact[] {
  const selected = new Set(targets);
  const artifacts: AdapterArtifact[] = [];

  if (selected.has("codex-cli") || selected.has("codex-desktop")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "codex" as const,
      path: join(home, ".codex", "skills", workflow, "SKILL.md"),
      content: skill(workflow, `$${workflow}`, "codex", runnerCommand),
      invocation: `$${workflow}`,
    })));
  }
  if (selected.has("cursor-cli") || selected.has("cursor-desktop")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "cursor" as const,
      path: join(home, ".cursor", "skills", workflow, "SKILL.md"),
      content: skill(workflow, `/${workflow}`, "cursor", runnerCommand, workflow !== "work"),
      invocation: `/${workflow}`,
    })));
  }
  if (selected.has("claude-code")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "claude" as const,
      path: join(home, ".claude", "commands", `${workflow}.md`),
      content: markdownCommand(workflow, "claude", runnerCommand),
      invocation: `/${workflow}`,
    })));
  }
  if (selected.has("antigravity-desktop")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "antigravity" as const,
      path: join(home, ".gemini", "config", "skills", workflow, "SKILL.md"),
      content: skill(workflow, workflow, "antigravity", runnerCommand),
      invocation: workflow,
    })));
  }
  if (selected.has("agy-cli")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "agy" as const,
      path: join(home, ".gemini", "commands", `${workflow}.toml`),
      content: geminiCommand(workflow, "agy", runnerCommand),
      invocation: `/${workflow}`,
    })));
  }
  if (selected.has("fx-cli")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "fx" as const,
      path: join(home, ".fx", "skills", workflow, "SKILL.md"),
      content: skill(workflow, `$${workflow}`, "fx", runnerCommand, workflow !== "work"),
      invocation: `$${workflow}`,
    })));
  }
  if (selected.has("pi-cli")) {
    artifacts.push(...workflows((workflow) => ({
      owner: "pi" as const,
      path: join(home, ".pi", "agent", "prompts", `${workflow}.md`),
      content: markdownCommand(workflow, "pi", runnerCommand),
      invocation: `/${workflow}`,
    })));
  }

  return artifacts;
}
