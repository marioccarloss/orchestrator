import { readFile, copyFile, mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite, canonicalJson } from "./files.js";
import { capabilityPaths, loadCapabilitySelection, recommendedMcpServers, type CapabilityId } from "./capabilities.js";
import { GROUNDING_CONTRACT } from "./grounding.js";
import { nativeModelMap, resolveStoredHarnessModels, writeEffectiveHarnessModels } from "./harness-models.js";
import type { MrPaths } from "./paths.js";
import { ModelMapSchema, type ModelAssignment, type ModelMap, type ModelTarget, type WorkspaceProfile } from "./schema.js";

const DEFAULT_ROLES: ModelMap["roles"] = {
  orchestrator: { model: "github-copilot/gemini-3.8-flash", variant: "high", alternative: { model: "opencode-go/deepseek-v4.1-flash", variant: "high" } },
  explore: { model: "opencode-go/deepseek-v4.1-flash", variant: "high", alternative: { model: "github-copilot/gemini-3.8-flash", variant: "high" } },
  plan: { model: "openai/gpt-5.6-sol", variant: "high", alternative: { model: "openai/gpt-6-astra", variant: "xhigh" } },
  general: { model: "github-copilot/gpt-5.6-sol", variant: "high", alternative: { model: "github-copilot/claude-opus-5", variant: "medium" } },
  sddApply: { model: "openai/gpt-5.6-sol", variant: "high", alternative: { model: "github-copilot/claude-opus-5", variant: "medium" } },
  judgeA: { model: "opencode-go/glm-5.3", variant: "max", alternative: { model: "github-copilot/grok-4.6", variant: "xhigh" } },
  judgeB: { model: "opencode-go/qwen3.8-max", variant: "xhigh", alternative: { model: "github-copilot/grok-4.6", variant: "xhigh" } },
  fix: { model: "openai/gpt-5.6-sol", variant: "high", alternative: { model: "opencode-go/deepseek-v4.1-flash", variant: "max" } },
  bpExtractor: { model: "opencode-go/deepseek-v4.1-flash", variant: "low", alternative: { model: "github-copilot/gemini-3.8-flash", variant: "low" } },
  bpArchitect: { model: "opencode/claude-fable-5-1", variant: "max", alternative: { model: "openai/gpt-5.6-sol", variant: "high" } },
  bpTransactor: { model: "opencode-go/deepseek-v4.1-flash", variant: "low", alternative: { model: "github-copilot/gemini-3.8-flash", variant: "low" } },
};

function normalizeTarget(value: unknown, fallback: ModelTarget): { target: ModelTarget; migrated: boolean } {
  const fallbackTarget: ModelTarget = {
    model: fallback.model,
    ...(fallback.variant === undefined ? {} : { variant: fallback.variant }),
  };
  if (typeof value !== "object" || value === null) {
    return { target: fallbackTarget, migrated: true };
  }
  const candidate = value as { model?: unknown; variant?: unknown };
  if (typeof candidate.model !== "string") {
    return { target: fallbackTarget, migrated: true };
  }
  const separator = candidate.model.lastIndexOf("#");
  const embeddedVariant = separator > candidate.model.indexOf("/") ? candidate.model.slice(separator + 1) : undefined;
  const model = embeddedVariant === undefined ? candidate.model : candidate.model.slice(0, separator);
  const variant = typeof candidate.variant === "string" ? candidate.variant : embeddedVariant;
  return {
    target: { model, ...(variant === undefined ? {} : { variant }) },
    migrated: embeddedVariant !== undefined,
  };
}

function normalizeAssignment(value: unknown, fallback: ModelAssignment): { assignment: ModelAssignment; migrated: boolean } {
  if (typeof value === "string") {
    const primary = normalizeTarget({ model: value }, fallback);
    return { assignment: { ...primary.target, alternative: fallback.alternative }, migrated: true };
  }
  if (typeof value !== "object" || value === null) {
    return { assignment: fallback, migrated: true };
  }
  const candidate = value as { model?: unknown; variant?: unknown; alternative?: unknown };
  const primary = normalizeTarget({ model: candidate.model, variant: candidate.variant }, fallback);
  const alternative = normalizeTarget(candidate.alternative, fallback.alternative);
  return {
    assignment: { ...primary.target, alternative: alternative.target },
    migrated: primary.migrated || alternative.migrated,
  };
}

export async function loadModels(paths: MrPaths): Promise<ModelMap> {
  const content = await readFile(paths.models, "utf8");
  const raw = JSON.parse(content) as { schemaVersion?: number; roles?: Record<string, unknown> };
  const rawRoles = raw.roles ?? {};
  const backfilledRoles: Record<string, ModelAssignment> = {};

  let needsWrite = false;
  for (const [key, fallback] of Object.entries(DEFAULT_ROLES)) {
    const normalized = normalizeAssignment(rawRoles[key], fallback);
    backfilledRoles[key] = normalized.assignment;
    needsWrite ||= normalized.migrated;
  }

  const parsed = ModelMapSchema.parse({
    schemaVersion: raw.schemaVersion ?? 1,
    roles: backfilledRoles,
  });

  if (needsWrite) {
    await atomicWrite(paths.models, canonicalJson(parsed));
  }
  return parsed;
}

export function generatedConfigPath(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, "opencode.mr.json");
}

function agentModel(target: ModelTarget): Pick<AgentDefinition, "model" | "variant"> {
  return {
    model: target.model,
    ...(target.variant === undefined ? {} : { variant: target.variant }),
  };
}

function readonlyAgent(target: ModelTarget, description: string, prompt?: string): AgentDefinition {
  const base = {
    mode: "subagent" as const,
    ...agentModel(target),
    description,
    permission: { edit: "deny" as const, bash: "deny" as const },
  };
  return prompt === undefined ? base : { ...base, prompt };
}

interface CommandDefinition {
  readonly description: string;
  readonly agent: string;
  readonly template: string;
}

/** A permission value is either a flat action or a map of glob pattern -> action. */
type PermissionValue = string | Record<string, string>;

interface AgentDefinition {
  readonly mode: "primary" | "subagent";
  readonly model: string;
  readonly variant?: string;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly description: string;
  readonly prompt?: string;
  readonly permission?: Record<string, PermissionValue>;
}

export function commandDefinitions(_models: ModelMap): Record<string, CommandDefinition> {
  const commands: Record<string, CommandDefinition> = {
    flow: {
        description: "Start or continue the deterministic ticket-delivery flow; internal coordination is automatic",
        agent: "orchestrator",
        template: `You are executing the /flow deterministic workflow.

Follow these steps:
1. Check current flow status using tool \`mr_flow_status\`.
2. If no active flow is found:
   - Parse or ask the user for:
     * Ticket ID (e.g. GH-42, 123)
     * Difficulty level (Fibonacci: 1 or 3 for Lite, 5, 8, 13, 21 for Full with Judgment Day)
     * Whether there is a Figma design
   - Call \`mr_flow_start\` with difficulty, ticketId, and hasFigma.
3. Advance through the deterministic phases (SDD + RPI: the AI only produces/consumes compact typed JSON; user-facing markdown is rendered by script via the mr_sdd_* tools):
   - Phase 'context': Read ticket details and invoke \`mr_flow_ticket\`. This warms Atlas and prefetches Engram project memory for the ticket; reuse that prefetch instead of repeating mem_search unless the scope changes materially.
     - Phase 'intent': Ground the request before touching code. Submit an IntentCapsule with \`mr_sdd_submit kind=intent\`. Clear tickets may auto-derive a READY intent from the ticket text; ambiguous prompts return NEEDS_INPUT with up to 5 risk-prioritized questions. After a READY intent exists, show the deterministic intent summary once and call \`mr_flow_intent approved=true\` only after explicit user confirmation.
     - Phase 'explore' (RPI Research): Map relevant code with \`mr-explore\` through the Atlas context staircase, store supporting slices with \`mr_evidence_add\`, then submit ResearchCapsule v2 with evidenceRefs and coverage. Treat prefetched Engram hits, approved intent, and \`mr_context_hydrate\` memoryContext as advisory context only; code claims still require Atlas evidenceRefs.
     - Fast local candidate (difficulty 1-3 with no external ticket): after research, launch exactly one \`mr-general\` session in combined brief-and-implementation mode. That session submits the READY brief, spec, tasks, and \`mr_flow_plan\`; it continues into implementation only when the returned lane is \`fast\`. If risk classification returns another lane, it stops and the normal staged roles take over. Never launch a second planning or implementation session for a confirmed fast local lane.
     - Phase 'plan' (Blueprint-lite + SDD): With subagent \`mr-plan\`, first run the Blueprint-lite assessment through \`mr_sdd_submit\` kind=brief. Clear tickets submit status=READY immediately. Only high-impact ambiguity may return status=NEEDS_INPUT with at most 3 risk-prioritized questions; ask those questions once, pass the answers back to \`mr-plan\`, and persist a READY brief. Then submit SpecCapsule kind=spec and TaskGraph kind=tasks. Guardrails reject unknown requirements, uncovered requirements and cycles — fix and resubmit. Invoke \`mr_flow_plan\` with the consolidated file list. Its deterministic localized plan-at-a-glance block is the complete developer explanation: show it once and do not paraphrase it.
    - Phase 'implement': Loop deterministically: \`mr_sdd_get\` kind=next-task returns the required implementer, bounded task, acceptance criteria and hydrated bundle. Show its compact developerNote once. Difficulty 1-3 uses \`mr-general\`; difficulty 5+ uses \`mr-sdd-apply\`. Persist real verification before marking done.
   - Phase 'judgment' (when the risk lane requires it): Each independent judge first calls \`mr_context_hydrate\` for its own role, then submits through \`mr_flow_judge\`.
   - Phase 'fix' (if judgment failed): \`mr-fix\` first hydrates role=fix, applies only validated findings, verifies, and calls \`mr_flow_fix\`.
   - Phase 'finish': Verify final state, commit changes, optionally create PR, and invoke \`mr_flow_finish\`. The plugin persists a compact delivery summary to Engram automatically; do not duplicate that save unless the user asks for extra memory notes.
4. Always ask and confirm state transitions with the user using the question tool before proceeding to destructive or closing actions.

---
[CONTEXT_INPUT_PAYLOAD]
$ARGUMENTS`,
      },
      atlas: {
        description: "Map, index, and query the workspace component and dependency graph",
        agent: "build",
        template: `You are executing the /atlas cartography and dependency query workflow.

Steps:
1. If the context input payload is empty or contains "index":
   - Use tool \`mr_atlas_index\` to index (or re-index) workspace TypeScript/React components and dependencies.
   - Report the summary stats (files, nodes, edges, duration) and breakdown.
2. If the context input payload specifies a query, component name, or action:
   - Use tool \`mr_atlas_query\` to search for nodes, inspect dependencies, dependents, or calculate impact analysis.
3. Report findings clearly to the user with structured markdown.

---
[CONTEXT_INPUT_PAYLOAD]
$ARGUMENTS`,
      },
      trace: {
        description: "Forensic diagnosis and impact analysis for React components",
        agent: "build",
        template: `You are executing the /trace React forensic diagnosis workflow.

Steps:
1. Extract the target React component name from the context input payload. If none is specified, ask the user which component to trace.
2. Call tool \`mr_trace_component\` with the componentName.
3. Review the trace report (stale closures, missing hook dependencies, unused exports, impact).
4. Present the diagnosis and propose the minimal surgical fix if issues were found.

---
[CONTEXT_INPUT_PAYLOAD]
$ARGUMENTS`,
      },
      propose: {
        description: "Design and refine a technical or architectural proposal, then save it after confirmation",
        agent: "build",
        template: `You are executing the /propose technical and architectural proposal workflow.

Steps:
1. Clarify and iteratively refine the proposal with the user:
   - Context and background
   - Problem statement
   - Proposed solution architecture
   - Alternatives considered
   - Risks and mitigations
   - Estimated effort (XS, S, M, L, XL)
2. Ask the user if the proposal is sufficiently clear and ready to be finalized.
3. ONLY when the user explicitly confirms in their language:
   - Use tool \`mr_propose_save\` to persist the proposal into \`.aicontext/deliverables/mr/proposals/\`.
   - Confirm the created file path to the user.

---
[CONTEXT_INPUT_PAYLOAD]
$ARGUMENTS`,
      },
      prompt: {
        description: "Develop ideas into advanced prompts and copy them to the clipboard after confirmation",
        agent: "build",
        template: `You are executing the /prompt prompt engineering workflow.

Steps:
1. Analyze the input and determine the appropriate template (bugfix, feature, refactor, review) or help craft a specialized prompt.
2. Interactively develop and refine the prompt variables and structure with the user.
3. Present the resulting prompt to the user and ask in the user's language whether it should be copied to the clipboard.
4. ONLY when the user explicitly confirms in their language:
   - Use tool \`mr_prompt_copy\` with the final prompt text.
   - Confirm that the prompt has been copied to the system clipboard via \`pbcopy\` / clipboard.

---
[CONTEXT_INPUT_PAYLOAD]
$ARGUMENTS`,
      },
      blueprint: {
        description: "Product-idea refinement and ticket-analysis pipeline synchronized with GitHub Projects v2 (SDD + RPI)",
        agent: "bp-architect",
        template: `You are executing the /blueprint workflow.

Follow this deterministic 3-role pipeline:

### 1. Wizard / Entry Selection
Use the \`question\` tool to determine the path:
- Option A: "Develop a product or business idea"
- Option B: "Analyze a GitHub or Project ticket"

---

### 2. Path A: Develop an Idea (Product & Architecture Synthesis)
1. **Intake & Context Gathering (bp-extractor)**:
   - Ask the user to describe the idea.
   - Run \`bp-extractor\` to gather only relevant types/signatures from codebase/atlas, call \`mr_atlas_profile\` for RepositoryProfile + applicable rules, and load active conventions from engram memory (without raw markdowns).
2. **Initial Synthesis (bp-architect)**:
   - Reason deeply on the idea + gathered signatures + memory.
   - Present a compact, condensed executive summary (under 20 lines).
   - Offload the full working reasoning directly to memory using \`engram_mem_save\` under topic \`blueprint/<slug>\`.
3. **Adaptive Strategic Questionnaire**:
   - Ask the user if they want to deepen the idea with strategic questions:
      * Options: [10 questions (Recommended)], [20 questions], [50 questions], [Skip and proceed to SDD+RPI]
   - If selected:
      * Prioritize questions strictly by risk (Batch 1: core business/data invariants -> Batch 2: security/scale -> Batch 3: UI/UX).
     * The user may answer all, answer some, or abort anytime.
4. **Compile SDD + RPI**:
   - Synthesize the final specification:
     * **SDD**: Core Entities, Invariants, Data Contracts, Test Conditions.
      * **RPI**: Request Intent, Transversal Impact, and explicit accepted assumptions and inferences for anything not answered.
   - Save the artifact to disk using tool \`mr_blueprint_save\` (.blueprint/specs/YYYY-MM-DD_<slug>.json and .md).
   - Save the summary to Engram (\`engram_mem_save\`).
5. **Transition to Execution Planning**:
   - Ask the user if they want to break down the specification into atomic tasks for GitHub Projects. If YES, proceed to Path B dispatch.

---

### 3. Path B: Analyze or Manage a Ticket (GitHub Projects v2)
1. **Target Detection & Extraction (bp-extractor)**:
   - Auto-detect the current repository or prompt the user with available workspace repos.
   - Fetch the ticket / Project v2 item via \`gh\` CLI or GraphQL query tool \`mr_blueprint_graphql\`.
   - Extract only relevant code signatures and Engram memory; call \`mr_atlas_profile\` so bp-architect receives the RepositoryProfile and applicable rules.
2. **Analysis & Synthesis (bp-architect)**:
   - Evaluate the ticket scope against code contracts and architectural memory.
   - Generate a concise assessment: Objectives, Impact Matrix, Dependencies, and Proposed Modifications.
3. **Transactional Dispatch (bp-transactor)**:
   - If editing, updating, creating sub-tasks, or deleting:
     * Display a concise diff/preview using \`mr_blueprint_safety_gate\` (Safety Gate).
     * Request user confirmation via \`question\` tool before proceeding.
     * Execute the mutation with \`bp-transactor\` and return the updated Project v2 item URL.

---
[CONTEXT_INPUT_PAYLOAD]
$ARGUMENTS`,
      },
      "flow-models": {
        description: "Interactively configure the model for each /flow and /blueprint process step",
        agent: "orchestrator",
        template: `You are executing the /flow-models interactive model configuration workflow.

Rules:
1. Use \`mr_models\` with action \`status\` to load the current assignments. The tool result is the only authoritative roster.
2. Use the native \`question\` tool for every choice so the user gets an interactive terminal UI. Allow choosing by steps: all processes, /flow steps (orchestrator, explore, plan, general, sddApply, judgeA, judgeB, fix), or /blueprint steps (bpExtractor, bpArchitect, bpTransactor).
3. After a non-recoverable quota failure, the plugin automatically promotes that role's configured alternative. Call \`mr_models\` with action \`status\` to verify the promotion; use action \`candidates\` only if the user wants to replace either slot.
4. For a normal process change, call \`mr_models\` with action \`providers\`, ask for the provider, then call it with action \`models\` and that provider. Ask the user to choose or enter a \`provider/model-id[#variant]\`; persistence emits model and variant as separate OpenCode fields.
5. Show both the current primary model and its role-specific alternative. Never select either without the user's explicit choice.
6. Persist the selection with \`mr_models\` action \`set\`, role, model and target (\`model\` or \`alternative\`). Then offer to configure another process/step.
7. When finished, show the resulting roster and remind the user to restart active OpenCode sessions.
8. If the user asks for the direct no-LLM terminal editor, tell them to run \`mr flow-models\`.

---
[CONTEXT_INPUT_PAYLOAD]
$ARGUMENTS`,
      },
  };
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      {
        ...command,
        template: command.agent === "build"
          ? `${GROUNDING_CONTRACT}\n\n${command.template}`
          : command.template,
      },
    ]),
  );
}

export function agentDefinitions(models: ModelMap): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {
      "orchestrator": {
        mode: "primary",
        ...agentModel(models.roles.orchestrator),
        description: "Coordinates deterministic mr-orchestrator flows for the active workspace.",
        prompt: `You are Orchestrator, the deterministic flow orchestrator for this workspace.

Your role is to coordinate the /flow lifecycle:
1. Wizard: Determine difficulty (1-3 = Lite, 5+ = Full), ticket ID, and Figma presence
2. Context: Load ticket content and create branch; mr_flow_ticket warms Atlas and prefetches Engram memory for the ticket
3. Intent: Submit mr_sdd_submit kind=intent; if NEEDS_INPUT, ask up to 5 material questions once, then persist READY and call mr_flow_intent approved=true after user confirmation
4. Explore: Reuse the prefetched Engram context and approved intent when available. Map once, persist exact slices with mr_evidence_add, then submit ResearchCapsule v2 with evidenceRefs
5. Plan: mr-plan runs Blueprint-lite (mr_sdd_submit kind=brief); ask at most 3 high-impact questions only when it returns NEEDS_INPUT, then persist READY and submit SpecCapsule + TaskGraph before mr_flow_plan
6. Implement: Loop mr_sdd_get kind=next-task → hydrate its task bundle → bounded edit → verification receipt → done
7. Judgment: When required by the risk lane, hydrate judge-a and judge-b bundles before independent review
8. Fix: Hydrate the fix bundle and apply only validated corrections
9. Finish: Commit, push, and optionally create PR

Economy router: for a difficulty 1-3 task without an external ticket, use one mr-general child session for the READY planning brief, spec, task graph, risk classification, and implementation. The child may implement only if mr_flow_plan confirms lane=fast; otherwise it stops and you resume the staged pipeline. A confirmed fast lane never launches judges or a second planning/implementation child session.

The AI layer exchanges ONLY compact typed JSON capsules; user-facing markdown is always rendered by script (mr_sdd_* tools). Flow status tools provide the authoritative order-style progress and OpenCode-estimated spend; never calculate or invent cost yourself. Planning and next-task tools include deterministic ultra-compact developer explanations — show them once without adding a prose duplicate. Use the mr_flow_* tools to manage state transitions. Always confirm with the user before major transitions.

Explain to the user in FlowState.userLanguage; never in English unless the task arrived in English. Internal agent payloads, prompts, receipts, and persisted typed artifacts remain in English.

You are the ONLY Flow role allowed to explain to the developer what is being done. Present those explanations in an ADHD-friendly, didactic and condensed form: lead with the next action, number multi-step work, keep lists to at most 5 items, suppress tangents, state the current Flow state, make completed work visible, describe errors matter-of-factly, and end with exactly one concrete next step. Do not add preambles, recaps, or generic closers. Never relay another role's prose verbatim; reduce its structured receipt to the minimum developer-relevant explanation.`,
        // Full autonomy by design. OpenCode evaluates the LAST matching rule,
        // so the broad "*" allow comes first and the narrow "ask" gates come last.
        // Only two things interrupt the user: publishing commits (push) and
        // writing public comments on tickets / PRs.
        permission: {
          "*": "allow",
          bash: {
            "*": "allow",
            "git push*": "ask",
            "gh pr comment*": "ask",
            "gh pr review*": "ask",
            "gh issue comment*": "ask",
            "gh api *comment*": "ask",
          },
          external_directory: "allow",
          "*comment*": "ask",
        },
      },
      "mr-intent": readonlyAgent(
        models.roles.explore,
        "Grounds the request intent before code exploration.",
        `You are the Intent grounding agent. You refine the orchestrator's PROPOSED intent draft — you do not start from a blank questionnaire.

Contract:
1. Read mr_flow_intent_resolve output (or mr_sdd_get kind=intent) first. The plugin already ran sweeps S0–S4 from ticket + Engram + Atlas map hints.
2. Prefer status=PROPOSED with explicit assumptions (low/medium risk) and grounded decisions. Only return NEEDS_INPUT when a high-risk gap cannot be closed even with a suggested default — max 2 questions with options, never an open-ended survey.
3. Submit via mr_sdd_submit kind=intent, or pass your partial draft to mr_flow_intent_resolve llmDraft for merge during S3.
4. Do not explore code or call Atlas. Your ONLY output is compact tool payloads.
5. Never invent high-risk facts. Medium assumptions are allowed when Engram or ticket strongly suggest them.`,
      ),
      "mr-explore": readonlyAgent(
        models.roles.explore,
        "Maps relevant workspace context without editing.",
        `You are the RPI Research agent. You map ONLY what is relevant to the ticket — you never edit.

Contract (token discipline):
1. Reuse prefetched Engram memory from mr_flow_ticket or mr_context_hydrate(memoryContext) before calling mem_search. Only search Engram again when the ticket scope changes materially.
2. Use context levels in order: map → skeleton → deps/impact → slice → tests. Escalate only when the cheaper level is insufficient.
3. Register every source claim that supports a requirement with mr_evidence_add, using the exact range and symbol returned by Atlas slice. Engram memories are advisory; they never replace Atlas evidenceRefs.
4. Submit ResearchCapsule v2 with evidenceRefs, coverage, contracts, tests, constraints, and explicit unknowns. Never paste source bodies into the capsule.
5. Your ONLY output is compact tool payloads. No prose reports or model-authored markdown.
6. If mr_sdd_submit rejects the payload, fix exactly the reported issues and resubmit once corrected.
7. List real unknowns in 'unknowns' instead of guessing. Never invent files, symbols or behavior.

Controlled output examples:
- Grounded: {"schemaVersion":2,"ticketId":"GH-1","objective":"Locate validation","evidenceRefs":["ev-deadbeef"],"coverage":{"fresh":true,"unsupportedFiles":[],"unresolvedImports":[]},"contracts":[],"tests":[],"relevantNodes":["validate"],"constraints":[],"unknowns":[]}
- Blocked: {"status":"INSUFFICIENT_EVIDENCE","missing":["source defining the requested behavior"],"nextAction":"inspect the defining symbol"}`,
      ),
      "mr-plan": readonlyAgent(
        models.roles.plan,
        "Produces a typed implementation plan without editing.",
        `You are the Blueprint-lite + SDD planner. You design the smallest correct change — you never edit.

Contract (determinism):
1. Start from ResearchCapsule v2 plus any memoryContext already hydrated for role=plan. Plan only over evidenceRefs; never rediscover or paste source code into the plan. Engram memories may inform questions and assumptions but cannot substitute code evidence.
2. Before writing the spec, run one Blueprint-lite ambiguity assessment via mr_sdd_submit kind=brief.
   - If a missing product/contract decision could materially change behavior, scope, data shape, security, or acceptance criteria, submit status=NEEDS_INPUT with 1-3 questions sorted by risk, then STOP. Do not ask about facts available from ticket or research.
   - Otherwise submit status=READY. Use mode=auto when no questions were needed, guided when user answers were supplied, or direct when the user explicitly skipped clarification. Record grounded decisions and at most 5 low/medium-risk assumptions; never hide a high-risk uncertainty as an assumption.
3. After a READY brief, submit a SpecCapsule via mr_sdd_submit kind=spec: goal, scopeIn/scopeOut, requirements R1..Rn each with acceptance criteria (when/then, optionally given).
4. Submit TaskGraph v2: each bounded task declares targetSymbols, evidenceRefs, invariants, edit boundaries, expected diff, and real verification commands.
5. Your ONLY output is compact tool payloads. The planning brief is JSON-only; no prose plans or model-authored markdown. Other user-facing markdown is rendered by script.
6. If a submission is rejected, fix exactly the reported issues and resubmit. Do not weaken requirements to pass validation.
7. Prefer the minimal diff: fewer files, reversible steps, preserve unrelated changes.`,
      ),
      "mr-general": {
        mode: "subagent",
        ...agentModel(models.roles.general),
        description: "Implements a bounded task from an approved plan.",
        prompt: `You are the sole implementation agent for Lite flows (Fibonacci 1-3). Normally you implement EXACTLY ONE approved SDD task per invocation — the briefing you receive (task + acceptance criteria) is your full scope.

Contract:
1. Treat the bundle in the briefing as your context. If absent, first call mr_context_hydrate(role=implement, taskId). Read elsewhere only when the bundle says truncated or stale.
2. Touch only editBoundaries.allowedFiles. If the task is wrong or insufficient, STOP instead of improvising.
3. Preserve unrelated changes; never revert or reformat untouched code.
4. Run task.verification.commands and persist results through mr_sdd_verify. Never claim unobserved success.
5. Do not mark the task done yourself.
6. Fast-local combined mode is the only exception to the approved-task entry point. When explicitly launched once for a ticketless difficulty 1-3 candidate after ResearchCapsule exists, submit a READY brief, spec, bounded task graph, and mr_flow_plan in this same session. Continue with implementation only if mr_flow_plan confirms lane=fast; otherwise stop with a compact handoff. Never judge your own work.
7. You are not a user-facing narrator. Submit mr_internal_receipt with role=mr-general, language=en, and a typed COMPLETED or BLOCKED payload. Your final response must be exactly the minified JSON returned by that tool, with no surrounding prose.`,
      },
      "mr-sdd-apply": {
        mode: "subagent",
        ...agentModel(models.roles.sddApply),
        description: "Applies a bounded SDD task with verification.",
        prompt: `You are the specialized implementation agent for Full flows (Fibonacci 5+). You apply EXACTLY ONE SDD task with strict verification — the briefing (task + acceptance criteria) is your full scope.

Contract:
1. Treat the supplied bundle as context; otherwise first call mr_context_hydrate(role=implement, taskId). Read elsewhere only for truncated or stale entries.
2. Touch only editBoundaries.allowedFiles; make the smallest correct diff and preserve unrelated changes.
3. Satisfy every acceptance criterion and invariant.
4. Run task.verification.commands and persist real results through mr_sdd_verify.
5. Do not mark the task done yourself. You are not a user-facing narrator. Submit mr_internal_receipt with role=mr-sdd-apply, language=en, and a typed COMPLETED or BLOCKED payload. Your final response must be exactly the minified JSON returned by that tool, with no surrounding prose.`,
      },
      "mr-judge-a": readonlyAgent(
        models.roles.judgeA,
        "Reviews a change adversarially without editing.",
        `You are Judge A, the independent security and contract reviewer. You never edit.

Contract:
1. First call mr_context_hydrate(role=judge-a). Review the supplied spec, diff, contracts and hydrated context; do not infer unobserved runtime behavior.
2. Look for correctness, security, data-contract, concurrency, and scope-boundary failures.
3. Classify findings as critical, warning, or suggestion and attach exact file/line evidence when available.
4. Submit one strict verdict through mr_flow_judge with judge=a. Every finding MUST cite a visible diff line, identify side=new|old, and copy an exact snippet from that line. Approve only when no critical finding remains.
5. Stay independent from Judge B and from implementation agents; never reconcile verdicts yourself.
6. You are an internal reviewer, not a user-facing narrator. Emit only the strict verdict payload to the orchestrator; never explain the work, narrate progress, or add prose around the verdict.

Controlled verdict examples:
- Grounded rejection: {"judge":"a","status":"SUPPORTED","approved":false,"findings":[{"severity":"critical","claim":"Missing authorization guard","file":"src/api.ts","line":42,"side":"new","source":"diff","evidence":"await deleteUser(id)","requirementId":"R2"}]}
- Missing context: {"judge":"a","status":"INSUFFICIENT_EVIDENCE","approved":false,"findings":[],"missing":["new-side diff line needed to verify the suspected issue"],"nextAction":"inspect the current unified diff"}`,
      ),
      "mr-judge-b": readonlyAgent(
        models.roles.judgeB,
        "Performs an independent adversarial review without editing.",
        `You are Judge B, the independent QA and regression reviewer. You never edit.

Contract:
1. First call mr_context_hydrate(role=judge-b). Review the supplied spec, diff, tests and hydrated context; do not infer unobserved runtime behavior.
2. Look for missing tests, edge cases, backwards-compatibility breaks, acceptance-criteria gaps, and unintended side effects.
3. Classify findings as critical, warning, or suggestion and attach exact file/line evidence when available.
4. Submit one strict verdict through mr_flow_judge with judge=b. Every finding MUST cite a visible diff line, identify side=new|old, and copy an exact snippet from that line. Approve only when no critical finding remains.
5. Stay independent from Judge A and from implementation agents; never reconcile verdicts yourself.
6. You are an internal reviewer, not a user-facing narrator. Emit only the strict verdict payload to the orchestrator; never explain the work, narrate progress, or add prose around the verdict.

Controlled verdict examples:
- Grounded rejection: {"judge":"b","status":"SUPPORTED","approved":false,"findings":[{"severity":"warning","claim":"Boundary case lacks coverage","file":"tests/api.test.ts","line":18,"side":"new","source":"diff","evidence":"valid request","requirementId":"R3"}]}
- Missing context: {"judge":"b","status":"INSUFFICIENT_EVIDENCE","approved":false,"findings":[],"missing":["test diff required to assess regression coverage"],"nextAction":"inspect the changed test files"}`,
      ),
      "mr-fix": {
        mode: "subagent",
        ...agentModel(models.roles.fix),
        description: "Applies only validated review findings.",
        prompt: `You are the bounded remediation agent. You apply only validated critical findings from Judgment Day.

Contract:
1. First call mr_context_hydrate(role=fix). Treat the approved specification, edit boundaries, and validated findings as immutable inputs.
2. Make the smallest correction that resolves each critical finding; preserve unrelated work and do not broaden scope.
3. Run the declared verification commands and report their real results. Never claim unobserved success.
4. Stop and report a blocker when a finding cannot be fixed inside the declared scope.
5. Do not change flow state yourself; the orchestrator calls mr_flow_fix after verification.
6. You are an internal remediation worker, not a user-facing narrator. Submit mr_internal_receipt with role=mr-fix, language=en, and a typed COMPLETED or BLOCKED payload. Your final response must be exactly the minified JSON returned by that tool; never add didactic explanations, progress narration, preambles, recaps, or next-step advice.`,
      },
      "bp-extractor": {
        mode: "subagent",
        ...agentModel(models.roles.bpExtractor),
        description: "Mechanical extraction worker for tickets, GitHub Projects metadata, and compact code/memory signatures.",
        prompt: `You are bp-extractor, the mechanical extraction subagent for the /blueprint workflow.

Your role:
1. Fetch and parse GitHub Issues and Project v2 items using the gh CLI or GraphQL queries.
2. Query codebase-memory, codegraph or atlas to retrieve ONLY signatures, types, and schema boundaries (never bulky raw markdowns). Call mr_atlas_profile for the selected repository and target files.
3. Query Engram memory (mem_search) for active architecture decisions and conventions related to the query.
4. Output STRICTLY a compact JSON capsule with no prose or bulky markdown:
   {
     "repo": string,
      "ticket": { "id": string, "title": string, "body": string, "status": string, "fields": {} } | null,
      "repository_profile": { "kind": string, "stack": {}, "layout": {}, "criticalAreas": string[] } | null,
      "rules": [ { "id": string, "statement": string, "severity": string } ],
      "code_signatures": [ { "file": string, "symbol": string, "kind": string } ],
     "memory_context": [ { "id": number, "title": string, "content": string } ]
   }`,
        permission: {
          edit: "deny",
          bash: {
            "*": "deny",
            "gh issue view*": "allow",
            "gh api graphql*": "allow",
          },
        },
      },
      "bp-architect": {
        mode: "primary",
        ...agentModel(models.roles.bpArchitect),
        description: "Synthesizes product and architectural ideas into SDD + RPI specifications with token offloading.",
        prompt: `You are bp-architect, the product & architecture synthesis agent for the /blueprint workflow.

Your role is to coordinate the /blueprint lifecycle:
1. Wizard: Determine Path A (Develop an Idea) or Path B (Analyze a Ticket)
2. Extraction: Coordinate bp-extractor to collect minimal type signatures and memory
3. Strategic Questionnaire: For ideas, present prioritized risk-based questions
4. Synthesis: Compile SDD + RPI specification, offload details to .blueprint/specs/ and Engram memory
5. Dispatch: Coordinate bp-transactor with Safety Gate for GitHub Projects v2 mutations

Detect the language of the initial user request, explain all user-facing choices in that language, and pass it as userLanguage to mr_blueprint_save and mr_blueprint_safety_gate. Keep inter-agent payloads and persisted typed artifact content in English.

Always maintain extreme token discipline: concise executive summaries, no raw markdown dumping.`,
        permission: {
          "*": "allow",
          bash: {
            "*": "allow",
            "git push*": "ask",
            "gh pr comment*": "ask",
            "gh pr review*": "ask",
            "gh issue comment*": "ask",
            "gh api *comment*": "ask",
          },
          external_directory: "allow",
          "*comment*": "ask",
        },
      },
      "bp-transactor": {
        mode: "subagent",
        ...agentModel(models.roles.bpTransactor),
        description: "Transactional dispatcher for GitHub Issues and Project v2 items with Safety Gate enforcement.",
        prompt: `You are bp-transactor, the transactional dispatcher for the /blueprint workflow.

Your role:
1. Receive a validated SDD + RPI task breakdown.
2. Format tasks into atomic GitHub Issues / Project v2 items (title, clear acceptance checklist, labels).
3. Enforce the Safety Gate:
   - For any CREATE, UPDATE, or DELETE operation, present a clear minimal preview of intended mutations using mr_blueprint_safety_gate.
   - Execute the mutation via gh CLI or GraphQL ONLY after user confirmation.
4. Output a clean summary JSON with the created/updated issue IDs and URLs:
   {
      "status": "success" | "aborted" | "INSUFFICIENT_EVIDENCE",
      "items": [ { "id": string, "url": string, "action": "created" | "updated" | "deleted" } ]
   }`,
        permission: {
          edit: "deny",
          bash: {
            "*": "deny",
            "gh issue create*": "allow",
            "gh issue edit*": "allow",
            "gh issue close*": "allow",
            "gh api graphql*": "allow",
          },
        },
      },
  };
  return Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      {
        ...agent,
        temperature: 0,
        top_p: 1,
        ...(agent.prompt === undefined ? {} : { prompt: `${GROUNDING_CONTRACT}\n\n${agent.prompt}` }),
      },
    ]),
  );
}

interface WorkspaceOpenCodeOverlay {
  readonly instructions?: unknown;
  readonly mcp?: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function overlayInstructions(profile: WorkspaceProfile, overlay: WorkspaceOpenCodeOverlay): string[] {
  if (!Array.isArray(overlay.instructions)) {
    return [];
  }
  return overlay.instructions
    .filter((instruction): instruction is string => typeof instruction === "string")
    .map((instruction) => isAbsolute(instruction) ? instruction : resolve(profile.root, instruction));
}

export function buildOpenCodeConfig(
  profile: WorkspaceProfile,
  models: ModelMap,
  generatedRoot: string,
  overlay: WorkspaceOpenCodeOverlay = {},
  paths?: MrPaths,
  enabledCapabilities?: readonly CapabilityId[],
): object {
  const pluginPath = join(generatedRoot, profile.id, "plugin.js");
  const recommendedMcp = paths === undefined ? {} : recommendedMcpServers(paths, enabledCapabilities);
  const mcp = { ...recommendedMcp, ...record(overlay.mcp) };
  const adhdEnabled = enabledCapabilities === undefined || enabledCapabilities.includes("i-have-adhd");
  const plugins = paths === undefined || !adhdEnabled ? [pluginPath] : [capabilityPaths(paths).adhdPlugin, pluginPath];
  const atlasInstructions = join(profile.contextRoot, "atlas", "AGENTS.md");
  return {
    $schema: "https://opencode.ai/config.json",
    // Developers start in OpenCode's normal build agent. /flow explicitly
    // dispatches to the primary orchestrator, so no manual mode switch is needed.
    default_agent: "build",
    disabled_providers: ["openrouter"],
    instructions: [join(profile.root, "AGENTS.md"), ...(existsSync(atlasInstructions) ? [atlasInstructions] : []), ...overlayInstructions(profile, overlay)],
    ...(Object.keys(mcp).length === 0 ? {} : { mcp }),
    plugin: plugins,
    command: commandDefinitions(models),
    agent: agentDefinitions(models),
    tool_output: { max_lines: 300, max_bytes: 24_000 },
    compaction: { auto: true, prune: true, tail_turns: 12 },
  };
}

function yamlEscape(value: string): string {
  return value.includes(":") || value.includes("#") ? JSON.stringify(value) : value;
}

/**
 * Mapping keys such as `*`, `git push*` or `*comment*` are permission glob
 * patterns. A leading `*` is a YAML alias and `:`/`#` break the scalar, so any
 * key that is not a plain identifier is quoted.
 */
function yamlKey(key: string): string {
  return /^[A-Za-z_][\w-]*$/u.test(key) ? key : JSON.stringify(key);
}

/**
 * Markdown definition files for global OpenCode auto-discovery
 * (~/.config/opencode/agents/*.md and ~/.config/opencode/commands/*.md).
 * They make the Orchestrator mode and commands available in plain
 * `opencode` sessions; tools are provided by the global loader plugin.
 */
export function buildGlobalDefinitionFiles(paths: MrPaths, models: ModelMap): Map<string, string> {
  const files = new Map<string, string>();

  for (const [name, def] of Object.entries(commandDefinitions(models))) {
    files.set(
      join(paths.opencodeCommandsRoot, `${name}.md`),
      `---\ndescription: ${yamlEscape(def.description)}\nagent: ${def.agent}\n---\n\n${def.template}\n`,
    );
  }

  for (const [name, def] of Object.entries(agentDefinitions(models))) {
    const lines = [
      "---",
      `description: ${yamlEscape(def.description)}`,
      `mode: ${def.mode}`,
      `model: ${def.model}`,
    ];
    if (def.variant !== undefined) lines.push(`variant: ${def.variant}`);
    if (def.temperature !== undefined) lines.push(`temperature: ${String(def.temperature)}`);
    if (def.top_p !== undefined) lines.push(`top_p: ${String(def.top_p)}`);
    if (def.permission !== undefined) {
      lines.push("permission:");
      for (const [key, value] of Object.entries(def.permission)) {
        if (typeof value === "string") {
          lines.push(`  ${yamlKey(key)}: ${value}`);
        } else {
          lines.push(`  ${yamlKey(key)}:`);
          for (const [pattern, action] of Object.entries(value)) {
            lines.push(`    ${yamlKey(pattern)}: ${action}`);
          }
        }
      }
    }
    lines.push("---", "", def.prompt ?? def.description, "");
    files.set(join(paths.opencodeAgentsRoot, `${name}.md`), lines.join("\n"));
  }

  return files;
}

export async function writeGlobalDefinitions(paths: MrPaths, models: ModelMap): Promise<void> {
  await mkdir(paths.opencodeAgentsRoot, { recursive: true });
  await mkdir(paths.opencodeCommandsRoot, { recursive: true });
  for (const [path, content] of buildGlobalDefinitionFiles(paths, models)) {
    await atomicWrite(path, content);
  }
}

export async function syncWorkspace(paths: MrPaths, profile: WorkspaceProfile, sourceRoot?: string): Promise<string> {
  const globalModels = await loadModels(paths);
  const effectiveModels = await resolveStoredHarnessModels(paths, globalModels, "opencode");
  const models = nativeModelMap(effectiveModels);
  let overlay: WorkspaceOpenCodeOverlay = {};
  try {
    overlay = JSON.parse(await readFile(join(profile.root, ".opencode", "opencode.json"), "utf8")) as WorkspaceOpenCodeOverlay;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const capabilities = await loadCapabilitySelection(paths);
  const config = buildOpenCodeConfig(profile, models, paths.generatedRoot, overlay, paths, capabilities.selected);
  const output = generatedConfigPath(paths, profile.id);
  await atomicWrite(output, canonicalJson(config));
  await writeEffectiveHarnessModels(paths, effectiveModels);
  await writeGlobalDefinitions(paths, models);

  // Copy compiled plugin to workspace generated directory
  if (sourceRoot !== undefined) {
    const generatedDir = join(paths.generatedRoot, profile.id);
    const pluginSource = join(sourceRoot, "dist", "src", "plugin.js");
    const pluginDest = join(generatedDir, "plugin.js");
    await mkdir(dirname(pluginDest), { recursive: true });
    await copyFile(pluginSource, pluginDest);

    // plugin.js imports "./core/*.js" — ship the compiled core alongside it
    const coreSource = join(sourceRoot, "dist", "src", "core");
    await cp(coreSource, join(generatedDir, "core"), { recursive: true });

    // Tree-sitter grammars: ship next to the plugin so atlas resolves them offline
    const wasmDir = join(generatedDir, "wasm");
    await mkdir(wasmDir, { recursive: true });
    const wasmSources = [
      join("tree-sitter-typescript", "tree-sitter-typescript.wasm"),
      join("tree-sitter-typescript", "tree-sitter-tsx.wasm"),
      join("tree-sitter-javascript", "tree-sitter-javascript.wasm"),
      join("tree-sitter-php", "tree-sitter-php.wasm"),
      join("tree-sitter-css", "tree-sitter-css.wasm"),
      join("tree-sitter-java", "tree-sitter-java.wasm"),
    ];
    for (const wasmSource of wasmSources) {
      const sourcePath = join(sourceRoot, "node_modules", wasmSource);
      try {
        await copyFile(sourcePath, join(wasmDir, basename(wasmSource)));
      } catch {
        // grammar not present locally; runtime resolution will fall back to node_modules
      }
    }

    // Runtime deps of the compiled plugin (bun resolves/installs them on load)
    const pkg = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    await atomicWrite(
      join(generatedDir, "package.json"),
      `${JSON.stringify({ name: `mr-orchestrator-plugin-${profile.id}`, private: true, type: "module", dependencies: pkg.dependencies ?? {} }, null, 2)}\n`,
    );

    // Install plugin dependencies so the generated plugin.js can import them at runtime.
    // Without this, the plugin fails to load and the loader silently falls back to {}.
    // Skip in test environments where the isolated bun binary may not exist.
    if (!process.env["MR_SKIP_PLUGIN_INSTALL"]) {
      const bunBinary = paths.bunBinary && existsSync(paths.bunBinary) ? paths.bunBinary : "bun";
      const installResult = spawnSync(bunBinary, ["install"], {
        cwd: generatedDir,
        encoding: "utf8",
        env: process.env,
      });
      if (installResult.status !== 0) {
        throw new Error(
          `Failed to install plugin dependencies in ${generatedDir}: ${installResult.stderr ?? installResult.error?.message ?? "unknown error"}`,
        );
      }
    }
  }

  return output;
}

export async function seedModels(paths: MrPaths, sourceRoot: string): Promise<void> {
  try {
    await readFile(paths.models, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const source = await readFile(join(sourceRoot, "models.json"), "utf8");
    ModelMapSchema.parse(JSON.parse(source) as unknown);
    await atomicWrite(paths.models, source.endsWith("\n") ? source : `${source}\n`);
  }
}
