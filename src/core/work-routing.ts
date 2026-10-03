import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite } from "./files.js";

export const WorkIntentSchema = z.enum(["explain", "investigate", "propose", "implement"]);
export type WorkIntent = z.infer<typeof WorkIntentSchema>;

export const WorkRouteSchema = z.enum(["read-only", "direct", "tracked"]);
export type WorkRoute = z.infer<typeof WorkRouteSchema>;

export const WorkRoutingInputSchema = z.strictObject({
  intent: WorkIntentSchema,
  writeAuthorized: z.boolean(),
  observedReadFiles: z.number().int().min(0),
  expectedWriteFiles: z.number().int().min(0),
  meaningfulSteps: z.number().int().min(0),
  incident: z.boolean().default(false),
});
export type WorkRoutingInput = z.infer<typeof WorkRoutingInputSchema>;

export interface WorkRoutingDecision {
  readonly route: WorkRoute;
  readonly reasons: readonly string[];
  readonly trackingRequired: boolean;
  readonly flowSelected: false;
}

/**
 * ODD-lite routing is deterministic and never selects /flow implicitly.
 * Formal Flow remains an explicit user decision.
 */
export function classifyWork(inputValue: WorkRoutingInput): WorkRoutingDecision {
  const input = WorkRoutingInputSchema.parse(inputValue);
  if (input.intent !== "implement" || !input.writeAuthorized) {
    return {
      route: "read-only",
      reasons: [input.intent !== "implement" ? `intent:${input.intent}` : "write-not-authorized"],
      trackingRequired: false,
      flowSelected: false,
    };
  }

  const reasons: string[] = [];
  if (input.incident) reasons.push("incident-requires-recoverable-state");
  if (input.observedReadFiles >= 4) reasons.push("broad-exploration");
  if (input.expectedWriteFiles >= 2) reasons.push("multi-file-write");
  if (input.meaningfulSteps >= 2) reasons.push("multi-step-change");

  if (reasons.length > 0) {
    return { route: "tracked", reasons, trackingRequired: true, flowSelected: false };
  }
  return { route: "direct", reasons: ["small-understood-change"], trackingRequired: false, flowSelected: false };
}

export const WorkTaskSchema = z.strictObject({
  id: z.string().regex(/^W\d+$/u),
  title: z.string().trim().min(1).max(200),
  status: z.enum(["pending", "in_progress", "done", "blocked"]),
});

export const WorkDocumentInputSchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(1_000),
  scope: z.array(z.string().trim().min(1).max(300)).max(20),
  tasks: z.array(WorkTaskSchema).min(2).max(30),
  evidence: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  nextStep: z.string().trim().min(1).max(500),
  status: z.enum(["active", "blocked", "completed"]),
});
export type WorkDocumentInput = z.infer<typeof WorkDocumentInputSchema>;

function taskMark(status: z.infer<typeof WorkTaskSchema>["status"]): string {
  if (status === "done") return "x";
  if (status === "blocked") return "!";
  if (status === "in_progress") return ">";
  return " ";
}

export function renderWorkDocument(inputValue: WorkDocumentInput): string {
  const input = WorkDocumentInputSchema.parse(inputValue);
  const lines = [
    `# ${input.title}`,
    "",
    `Status: ${input.status}`,
    "",
    "## Objective",
    input.objective,
    "",
    "## Scope",
    ...(input.scope.length === 0 ? ["- No additional scope declared."] : input.scope.map((item) => `- ${item}`)),
    "",
    "## Tasks",
    ...input.tasks.map((task) => `- [${taskMark(task.status)}] ${task.id}: ${task.title}`),
    "",
    "## Evidence",
    ...(input.evidence.length === 0 ? ["- Pending."] : input.evidence.map((item) => `- ${item}`)),
    "",
    "## Next Step",
    input.nextStep,
    "",
  ];
  return lines.join("\n");
}

export async function saveWorkDocument(workspaceRoot: string, inputValue: WorkDocumentInput): Promise<string> {
  const input = WorkDocumentInputSchema.parse(inputValue);
  const directory = join(workspaceRoot, ".mr", "odd", "tasks");
  const path = join(directory, `${input.slug}.md`);
  await mkdir(directory, { recursive: true });
  await atomicWrite(path, renderWorkDocument(input));
  return path;
}

export const WORK_ROUTING_CONTRACT = `Everyday work routing (ODD-lite, mandatory outside an explicit /flow, /task, or /blueprint):
1. Establish authorization first. Explanation, investigation, review, and proposal-only requests remain read-only.
2. Explore proportionately before the first write. Then call mr_work_route with observed counts; never estimate success or invent scope.
3. A direct route keeps a small understood change small. A tracked route requires mr_work_track before the first source write and after material progress so another session can resume it.
4. Never select /flow automatically because of size, uncertainty, or risk. Formal Flow starts only when the user explicitly invokes or accepts it.
5. Findings do not authorize scope expansion. Preserve unrelated changes and report failed or unobserved checks honestly.
6. After a git/worktree/cwd incident, confusing test command, or environment workaround, route as incident=true and obtain fresh review evidence before completion.`;
