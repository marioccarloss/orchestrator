import { spawn } from "node:child_process";
import { z } from "zod";
import { loadEffectiveHarnessModels } from "./facade.js";

export const MODEL_ROLES = [
  "orchestrator",
  "explore",
  "plan",
  "general",
  "sddApply",
  "judgeA",
  "judgeB",
  "fix",
  "bpExtractor",
  "bpArchitect",
  "bpTransactor",
] as const;

export const ModelRoleSchema = z.enum(MODEL_ROLES);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export const RUNNER_HARNESSES = ["codex", "cursor", "claude", "agy", "fx"] as const;
export const RunnerHarnessSchema = z.enum(RUNNER_HARNESSES);
export type RunnerHarness = z.infer<typeof RunnerHarnessSchema>;

const EffectiveRunnerModelsSchema = z.object({
  harness: RunnerHarnessSchema,
  applicationMode: z.literal("per-invocation"),
  roles: z.record(ModelRoleSchema, z.object({
    primary: z.object({
      native: z.object({
        model: z.string().min(1),
        variant: z.string().min(1).optional(),
      }),
    }),
  })),
});

export interface RoleCommand {
  readonly command: string;
  readonly arguments: readonly string[];
}

export function roleCommand(
  effective: z.infer<typeof EffectiveRunnerModelsSchema>,
  role: ModelRole,
  prompt: string,
): RoleCommand {
  const target = effective.roles[role].primary.native;
  if (effective.harness === "codex") {
    return {
      command: "codex",
      arguments: [
        "exec",
        "--model",
        target.model,
        ...(target.variant === undefined ? [] : ["--config", `model_reasoning_effort=${JSON.stringify(target.variant)}`]),
        prompt,
      ],
    };
  }
  if (effective.harness === "cursor") {
    const model = target.variant === undefined ? target.model : `${target.model}[effort=${target.variant}]`;
    return { command: "agent", arguments: ["--print", "--model", model, prompt] };
  }
  if (effective.harness === "claude") {
    return {
      command: "claude",
      arguments: ["--print", "--model", target.model, ...(target.variant === undefined ? [] : ["--effort", target.variant]), prompt],
    };
  }
  if (effective.harness === "agy") {
    return {
      command: "agy",
      arguments: ["--model", target.model, ...(target.variant === undefined ? [] : ["--effort", target.variant]), "--print", prompt],
    };
  }
  return {
    command: "fx",
    arguments: ["ask", "--model", target.model, ...(target.variant === undefined ? [] : ["--effort", target.variant]), prompt],
  };
}

export async function runRole(
  harness: RunnerHarness,
  role: ModelRole,
  prompt: string,
  environment: NodeJS.ProcessEnv = process.env,
  loadEffective: (harness: RunnerHarness) => Promise<unknown> = loadEffectiveHarnessModels,
): Promise<number> {
  if (prompt.trim().length === 0) throw new Error("run-role requires a non-empty prompt after --");
  const effective = EffectiveRunnerModelsSchema.parse(await loadEffective(harness));
  if (effective.harness !== harness) throw new Error(`Effective model artifact declares '${effective.harness}', expected '${harness}'`);
  const invocation = roleCommand(effective, role, prompt);
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.arguments, { env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) reject(new Error(`${harness} role '${role}' terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}
