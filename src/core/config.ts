import { readFile, copyFile, mkdir, cp } from "node:fs/promises";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { atomicWrite, canonicalJson, readJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import { ModelMapSchema, type ModelMap, type WorkspaceProfile } from "./schema.js";

export async function loadModels(paths: MrPaths): Promise<ModelMap> {
  return readJson(paths.models, ModelMapSchema);
}

export function generatedConfigPath(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, "opencode.mr.json");
}

function readonlyAgent(model: string, description: string, prompt?: string): AgentDefinition {
  const base = {
    mode: "subagent" as const,
    model,
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
  readonly description: string;
  readonly prompt?: string;
  readonly permission?: Record<string, PermissionValue>;
}

export function commandDefinitions(models: ModelMap): Record<string, CommandDefinition> {
  return {
    flow: {
        description: "Inicia o continúa el flujo determinista de entrega quirúrgica de tickets con el Orchestrator",
        agent: "orchestrator",
        template: `You are executing the /flow deterministic workflow.
Input: $ARGUMENTS

Follow these steps:
1. Check current flow status using tool \`mr_flow_status\`.
2. If no active flow is found:
   - Parse or ask the user for:
     * Ticket ID (e.g. GH-42, 123)
     * Difficulty level (Fibonacci: 1 or 3 for Lite, 5, 8, 13, 21 for Full with Judgment Day)
     * Whether there is a Figma design
   - Call \`mr_flow_start\` with difficulty, ticketId, and hasFigma.
3. Advance through the deterministic phases (SDD + RPI: the AI only produces/consumes compact typed JSON; user-facing markdown is rendered by script via the mr_sdd_* tools):
   - Phase 'context': Read ticket details and invoke \`mr_flow_ticket\`.
   - Phase 'explore' (RPI Research): Map relevant code with subagent \`mr-explore\` using \`mr_atlas_query\` and \`mr_atlas_skeleton\` (never read full files when a skeleton suffices). The result MUST be submitted as a ResearchCapsule via \`mr_sdd_submit\` kind=research (compact JSON: evidence with file:line, constraints, unknowns). If validation fails, fix the reported issues and resubmit.
   - Phase 'plan' (SDD Spec + Tasks): With subagent \`mr-plan\`, submit a SpecCapsule via \`mr_sdd_submit\` kind=spec (requirements R1..Rn with acceptance criteria), then a TaskGraph via \`mr_sdd_submit\` kind=tasks (tasks T1..Tn with dependsOn, files, verify, doneWhen). Guardrails reject unknown requirements, uncovered requirements and cycles — fix and resubmit. Then invoke \`mr_flow_plan\` with the consolidated file list. Show the user the RENDERED markdown paths (do not re-write the plan in prose).
   - Phase 'implement': Loop deterministically: \`mr_sdd_get\` kind=next-task → hand that exact briefing (task + acceptance criteria) to \`mr-general\` or \`mr-sdd-apply\` → run the task's verify commands → \`mr_sdd_task_status\` taskId done. Repeat until no actionable task remains, then invoke \`mr_flow_implement\`.
   - Phase 'judgment' (if difficulty >= 5): Request independent adversarial reviews from \`mr-judge-a\` and \`mr-judge-b\`, submit their verdicts via \`mr_flow_judge\`.
   - Phase 'fix' (if judgment failed): Use \`mr-fix\` to address issues and call \`mr_flow_fix\`.
   - Phase 'finish': Verify final state, commit changes, optionally create PR, and invoke \`mr_flow_finish\`.
4. Always ask and confirm state transitions with the user using the question tool before proceeding to destructive or closing actions.`,
      },
      atlas: {
        description: "Mapea, indexa y consulta el grafo de componentes y dependencias del workspace",
        agent: "build",
        template: `You are executing the /atlas cartography and dependency query workflow.
Input: $ARGUMENTS

Steps:
1. If $ARGUMENTS is empty or contains "index":
   - Use tool \`mr_atlas_index\` to index (or re-index) workspace TypeScript/React components and dependencies.
   - Report the summary stats (files, nodes, edges, duration) and breakdown.
2. If $ARGUMENTS specifies a query, component name, or action:
   - Use tool \`mr_atlas_query\` to search for nodes, inspect dependencies, dependents, or calculate impact analysis.
3. Report findings clearly to the user with structured markdown.`,
      },
      trace: {
        description: "Diagnóstico forense y análisis de impacto para componentes React",
        agent: "build",
        template: `You are executing the /trace React forensic diagnosis workflow.
Input: $ARGUMENTS

Steps:
1. Extract the target React component name from $ARGUMENTS. If none is specified, ask the user which component to trace.
2. Call tool \`mr_trace_component\` with the componentName.
3. Review the trace report (stale closures, missing hook dependencies, unused exports, impact).
4. Present the diagnosis and propose the minimal surgical fix if issues were found.`,
      },
      propose: {
        description: "Diseña y refina una propuesta técnica/arquitectónica y la guarda tras confirmación",
        agent: "build",
        template: `You are executing the /propose technical and architectural proposal workflow.
Input: $ARGUMENTS

Steps:
1. Clarify and iteratively refine the proposal with the user:
   - Context and background
   - Problem statement
   - Proposed solution architecture
   - Alternatives considered
   - Risks and mitigations
   - Estimated effort (XS, S, M, L, XL)
2. Ask the user if the proposal is sufficiently clear and ready to be finalized.
3. ONLY when the user explicitly confirms (yes / sí / guardar):
   - Use tool \`mr_propose_save\` to persist the proposal into \`.aicontext/deliverables/mr/proposals/\`.
   - Confirm the created file path to the user.`,
      },
      prompt: {
        description: "Evoluciona y aterriza ideas en prompts avanzados y los copia al portapapeles tras confirmación",
        agent: "build",
        template: `You are executing the /prompt prompt engineering workflow.
Input: $ARGUMENTS

Steps:
1. Analyze the input and determine the appropriate template (bugfix, feature, refactor, review) or help craft a specialized prompt.
2. Interactively develop and refine the prompt variables and structure with the user.
3. Present the resulting prompt to the user and ask: "¿Deseas copiar este prompt al portapapeles? (sí / no)".
4. ONLY when the user explicitly confirms (yes / sí / copiar):
   - Use tool \`mr_prompt_copy\` with the final prompt text.
   - Confirm that the prompt has been copied to the system clipboard via \`pbcopy\` / clipboard.`,
      },
      "flow-models": {
        description: "Configura interactivamente el modelo de cada proceso interno de /flow",
        agent: "orchestrator",
        template: `You are executing the /flow-models interactive model configuration workflow.

Current assignments at command generation time:
${Object.entries(models.roles).map(([role, model]) => `- ${role}: ${model}`).join("\n")}

Rules:
1. Use \`mr_models\` with action \`status\` to load the current assignments. Do not rely on the snapshot above after this point.
2. Use the native \`question\` tool for every choice so the user gets an interactive terminal UI. Let the user choose a process/step or finish.
3. For a process change, call \`mr_models\` with action \`providers\`, ask for the provider, then call it with action \`models\` and that provider. Ask the user to choose or enter a \`provider/model-id\`.
4. Show the current assignment and mark it clearly. Never select a model without the user's explicit choice.
5. Persist the selection with \`mr_models\` action \`set\`, role and model. Then offer to configure another process/step.
6. When finished, show the resulting roster and remind the user to restart active OpenCode sessions.
7. If the user asks for the direct no-LLM terminal editor, tell them to run \`mr flow-models\`.`,
      },
  };
}

export function agentDefinitions(models: ModelMap): Record<string, AgentDefinition> {
  return {
    "orchestrator": {
        mode: "primary",
        model: models.roles.orchestrator,
        description: "Coordinates deterministic mr-orchestrator flows for the active workspace.",
        prompt: `You are Orchestrator, the deterministic flow orchestrator for this workspace.

Your role is to coordinate the /flow lifecycle:
1. Wizard: Determine difficulty (1-3 = Lite, 5+ = Full), ticket ID, and Figma presence
2. Context: Load ticket content and create branch
3. Explore: Map relevant code with mr-explore → ResearchCapsule via mr_sdd_submit kind=research
4. Plan: mr-plan submits SpecCapsule + TaskGraph (mr_sdd_submit kind=spec, kind=tasks), then mr_flow_plan
5. Implement: Loop mr_sdd_get kind=next-task → mr-general/mr-sdd-apply → verify → mr_sdd_task_status done
6. Judgment (Full only): Parallel review by mr-judge-a and mr-judge-b
7. Fix: Apply corrections with mr-fix if needed
8. Finish: Commit, push, and optionally create PR

The AI layer exchanges ONLY compact typed JSON capsules; user-facing markdown is always rendered by script (mr_sdd_* tools). Use the mr_flow_* tools to manage state transitions. Always confirm with the user before major transitions.`,
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
      "mr-explore": readonlyAgent(
        models.roles.explore,
        "Maps relevant workspace context without editing.",
        `You are the RPI Research agent. You map ONLY what is relevant to the ticket — you never edit.

Contract (token discipline):
1. Navigate with mr_atlas_query (info/deps/dependents/impact) instead of reading files.
2. When you need file context, use mr_atlas_skeleton (signatures only). Read a full file ONLY if the skeleton is insufficient, and prefer the smallest range.
3. Every claim you make must carry evidence: file path + line when known, and its source (atlas|grep|read|memory|ticket).
4. Your ONLY output is a ResearchCapsule submitted via mr_sdd_submit kind=research as compact JSON. No prose reports, no markdown — the tool renders the user-facing document by script.
5. If mr_sdd_submit rejects the payload, fix exactly the reported issues and resubmit once corrected.
6. List real unknowns in 'unknowns' instead of guessing. Never invent files, symbols or behavior.`,
      ),
      "mr-plan": readonlyAgent(
        models.roles.plan,
        "Produces a typed implementation plan without editing.",
        `You are the SDD Spec+Tasks planner. You design the smallest correct change — you never edit.

Contract (determinism):
1. Start from the ResearchCapsule (mr_sdd_get kind=research). Plan only over files with evidence; if you must touch an unevidenced file, state why in the task reason.
2. Submit a SpecCapsule via mr_sdd_submit kind=spec: goal, scopeIn/scopeOut, requirements R1..Rn each with acceptance criteria (when/then, optionally given).
3. Submit a TaskGraph via mr_sdd_submit kind=tasks: bounded tasks T1..Tn with dependsOn (no cycles), requirements coverage (every Rn covered), files (path/action/reason/risk), verify commands proportional to risk, and doneWhen.
4. Your ONLY output is those two JSON payloads. No prose plans, no markdown — rendering is done by script.
5. If a submission is rejected, fix exactly the reported issues and resubmit. Do not weaken requirements to pass validation.
6. Prefer the minimal diff: fewer files, reversible steps, preserve unrelated changes.`,
      ),
      "mr-general": {
        mode: "subagent",
        model: models.roles.general,
        description: "Implements a bounded task from an approved plan.",
        prompt: `You implement EXACTLY ONE SDD task per invocation — the briefing you receive (task + acceptance criteria) is your full scope.

Contract:
1. Touch only the files listed in the task. If the task is wrong or insufficient, STOP and report why instead of improvising.
2. Preserve unrelated changes in the working tree; never revert or reformat code you did not need to touch.
3. Use mr_atlas_skeleton for context; read full bodies only for the code you are editing.
4. After editing, run the task's verify commands. Report their real results — never claim success without running them.
5. Do not mark the task done yourself; the orchestrator calls mr_sdd_task_status after verification.`,
      },
      "mr-sdd-apply": {
        mode: "subagent",
        model: models.roles.sddApply,
        description: "Applies a bounded SDD task with verification.",
        prompt: `You apply EXACTLY ONE SDD task with strict verification — the briefing (task + acceptance criteria) is your full scope.

Contract:
1. Touch only the files listed in the task; smallest correct diff; preserve unrelated changes.
2. Satisfy every acceptance criterion (when/then) of the task's requirements — they are the definition of done.
3. Run the task's verify commands and report real output. If verification fails, fix within scope or report the blocker; never fake results.
4. Do not mark the task done yourself; the orchestrator calls mr_sdd_task_status after verification.`,
      },
      "mr-judge-a": readonlyAgent(models.roles.judgeA, "Reviews a change adversarially without editing."),
      "mr-judge-b": readonlyAgent(models.roles.judgeB, "Performs an independent adversarial review without editing."),
      "mr-fix": {
        mode: "subagent",
        model: models.roles.fix,
        description: "Applies only validated review findings.",
      },
  };
}

interface WorkspaceOpenCodeOverlay {
  readonly instructions?: unknown;
  readonly mcp?: unknown;
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
): object {
  const pluginPath = join(generatedRoot, profile.id, "plugin.js");
  return {
    $schema: "https://opencode.ai/config.json",
    default_agent: "orchestrator",
    disabled_providers: ["openrouter"],
    instructions: [join(profile.root, "AGENTS.md"), ...overlayInstructions(profile, overlay)],
    ...(overlay.mcp === undefined ? {} : { mcp: overlay.mcp }),
    plugin: [pluginPath],
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
  const models = await loadModels(paths);
  let overlay: WorkspaceOpenCodeOverlay = {};
  try {
    overlay = JSON.parse(await readFile(join(profile.root, ".opencode", "opencode.json"), "utf8")) as WorkspaceOpenCodeOverlay;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const config = buildOpenCodeConfig(profile, models, paths.generatedRoot, overlay);
  const output = generatedConfigPath(paths, profile.id);
  await atomicWrite(output, canonicalJson(config));
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
