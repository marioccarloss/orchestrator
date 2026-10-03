import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { sha256 } from "../files.js";
import { isDeterministicStep, type ExecutionPlan, type PlanStep } from "./schema.js";
import { parseVerificationCommand } from "./verify.js";

export interface PlanIssue {
  readonly step?: string;
  readonly code: string;
  readonly message: string;
}

const SENSITIVE_PATH = /(?:^|\/)(?:\.env[^/]*|\.git|node_modules|secrets)(?:\/|$)|\.(?:pem|key|p12|pfx)$/iu;

export function unsafePlanPath(file: string): string | undefined {
  if (isAbsolute(file)) return "path must be workspace-relative";
  const normalized = normalize(file).replaceAll("\\", "/");
  if (normalized.startsWith("../") || normalized === ".." || normalized.split("/").includes("..")) return "path escapes the workspace";
  if (SENSITIVE_PATH.test(normalized)) return "path is sensitive or generated";
  return undefined;
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function cycleIn(steps: readonly PlanStep[]): string | undefined {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string): string | undefined => {
    if (state.get(id) === "done") return undefined;
    if (state.get(id) === "visiting") return id;
    state.set(id, "visiting");
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      const found = visit(dependency);
      if (found !== undefined) return found;
    }
    state.set(id, "done");
    return undefined;
  };
  for (const step of steps) {
    const found = visit(step.id);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Deterministic plan validation against the live workspace. Steps are evaluated in
 * order on a virtual file system so later anchors may target earlier steps' output.
 */
export async function validateExecutionPlan(plan: ExecutionPlan, workspaceRoot: string, scripts: ReadonlySet<string>): Promise<readonly PlanIssue[]> {
  const issues: PlanIssue[] = [];
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) issues.push({ step: step.id, code: "duplicate-id", message: `duplicate step id ${step.id}` });
    ids.add(step.id);
  }
  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) issues.push({ step: step.id, code: "unknown-dependency", message: `dependsOn ${dependency} does not exist` });
    }
  }
  const cycle = cycleIn(plan.steps);
  if (cycle !== undefined) issues.push({ step: cycle, code: "dependency-cycle", message: `dependency cycle through ${cycle}` });

  const virtual = new Map<string, string | null>();
  const load = async (file: string): Promise<string | null> => {
    if (virtual.has(file)) return virtual.get(file) ?? null;
    try {
      const content = await readFile(join(workspaceRoot, file), "utf8");
      virtual.set(file, content);
      return content;
    } catch {
      virtual.set(file, null);
      return null;
    }
  };

  for (const step of plan.steps) {
    const unsafe = unsafePlanPath(step.file);
    if (unsafe !== undefined) {
      issues.push({ step: step.id, code: "unsafe-path", message: `${step.file}: ${unsafe}` });
      continue;
    }
    if (step.code === undefined && step.intent === undefined && step.op !== "deleteFile") {
      issues.push({ step: step.id, code: "missing-content", message: "provide exact code or an intent of at least 20 characters" });
    }
    if (step.reference !== undefined) {
      const unsafeReference = unsafePlanPath(step.reference.file);
      if (unsafeReference !== undefined) issues.push({ step: step.id, code: "unsafe-reference", message: `${step.reference.file}: ${unsafeReference}` });
      else if (!existsSync(join(workspaceRoot, step.reference.file))) issues.push({ step: step.id, code: "missing-reference", message: `reference ${step.reference.file} does not exist` });
    }
    const content = await load(step.file);
    if (step.op === "create") {
      if (content !== null) issues.push({ step: step.id, code: "create-exists", message: `${step.file} already exists; use replace or insert` });
      if (step.code === undefined && step.intent === undefined) continue;
      virtual.set(step.file, step.code ?? "");
      continue;
    }
    if (content === null) {
      issues.push({ step: step.id, code: "missing-file", message: `${step.file} does not exist` });
      continue;
    }
    if (step.op === "deleteFile") {
      virtual.set(step.file, null);
      continue;
    }
    if (step.anchor === undefined) {
      issues.push({ step: step.id, code: "missing-anchor", message: `${step.op} requires anchor.snippet copied exactly from ${step.file}` });
      continue;
    }
    if (step.anchor.fileSha !== undefined && !virtual.has(`sha:${step.file}`) && sha256(content) !== step.anchor.fileSha) {
      issues.push({ step: step.id, code: "stale-anchor", message: `${step.file} changed since it was planned (fileSha mismatch)` });
    }
    const count = occurrences(content, step.anchor.snippet);
    if (count !== 1) {
      issues.push({
        step: step.id,
        code: count === 0 ? "anchor-not-found" : "anchor-ambiguous",
        message: count === 0
          ? `anchor snippet not found in ${step.file}; copy it exactly, including indentation`
          : `anchor snippet appears ${String(count)} times in ${step.file}; extend it until it is unique`,
      });
      continue;
    }
    virtual.set(`sha:${step.file}`, "");
    if (step.code !== undefined) virtual.set(step.file, applyEdit(content, step));
  }

  for (const command of plan.verification) {
    if (parseVerificationCommand(command, scripts) === undefined) {
      issues.push({ code: "verification-command", message: `verification command not allowed: ${command}` });
    }
  }
  return issues;
}

function applyEdit(content: string, step: PlanStep): string {
  const snippet = step.anchor?.snippet ?? "";
  const code = step.code ?? "";
  if (step.op === "replace") return content.replace(snippet, () => code);
  if (step.op === "insertAfter") return content.replace(snippet, () => `${snippet}${code}`);
  if (step.op === "insertBefore") return content.replace(snippet, () => `${code}${snippet}`);
  return content;
}

export function planFiles(plan: ExecutionPlan): readonly string[] {
  return [...new Set(plan.steps.map((step) => step.file))];
}

/** Steps whose dependencies are all applied, in plan order. */
export function readySteps(plan: ExecutionPlan, applied: readonly string[]): readonly PlanStep[] {
  const done = new Set(applied);
  return plan.steps.filter((step) => !done.has(step.id) && step.dependsOn.every((dependency) => done.has(dependency)));
}

export interface ApplyOutcome {
  readonly applied: readonly string[];
  readonly failed: readonly PlanIssue[];
  readonly pendingModelSteps: readonly string[];
}

/**
 * Applies every deterministic step (exact code or deleteFile) whose dependencies are met,
 * re-validating its anchor immediately before writing. Model steps (intent only) are left
 * for the apply agent; deterministic steps that depend on them wait for a later call.
 */
export async function applyDeterministicSteps(plan: ExecutionPlan, workspaceRoot: string, alreadyApplied: readonly string[]): Promise<ApplyOutcome> {
  const applied: string[] = [];
  const failed: PlanIssue[] = [];
  const done = new Set(alreadyApplied);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const step of readySteps(plan, [...done])) {
      if (!isDeterministicStep(step) || failed.some((issue) => issue.step === step.id)) continue;
      const path = join(workspaceRoot, step.file);
      try {
        if (step.op === "create") {
          if (existsSync(path)) throw new Error(`${step.file} already exists`);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, step.code ?? "", "utf8");
        } else if (step.op === "deleteFile") {
          await rm(path);
        } else {
          const content = await readFile(path, "utf8");
          const count = occurrences(content, step.anchor?.snippet ?? "");
          if (count !== 1) throw new Error(count === 0 ? "anchor not found at apply time" : "anchor ambiguous at apply time");
          await writeFile(path, applyEdit(content, step), "utf8");
        }
        done.add(step.id);
        applied.push(step.id);
        progressed = true;
      } catch (error: unknown) {
        failed.push({ step: step.id, code: "apply-failed", message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const pendingModelSteps = plan.steps.filter((step) => !done.has(step.id) && !isDeterministicStep(step)).map((step) => step.id);
  return { applied, failed, pendingModelSteps };
}

export function renderPlanGlance(plan: ExecutionPlan): string {
  const lines = plan.steps.map((step) => {
    const mode = isDeterministicStep(step) ? "auto" : "model";
    return `${step.id} ${step.op} ${step.file} [${mode}]`;
  });
  return [
    `${plan.strategy} · d${String(plan.difficulty)} · ${String(plan.steps.length)} step(s)`,
    plan.summary,
    ...lines.slice(0, 12),
    ...(lines.length > 12 ? [`… +${String(lines.length - 12)}`] : []),
  ].join("\n");
}
