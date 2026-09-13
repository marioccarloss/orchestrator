import type { AtlasGraph } from "./atlas.js";
import type { EvidenceStore, FreshnessResult } from "./evidence-store.js";
import type { ResearchCapsulePayload, SddTask, SpecCapsulePayload, TaskGraphPayload } from "./sdd-schema.js";
import type { VerificationReceipt } from "./verification.js";
import type { RepositoryRule } from "./rules/generator.js";
import { matchesRulePath } from "./rules/match.js";

export type GateSeverity = "block" | "warn";
export type GatesMode = "warn" | "block";

export interface GateViolation {
  readonly code: string;
  readonly message: string;
  readonly severity: GateSeverity;
}

export interface GateResult {
  readonly ok: boolean;
  readonly violations: readonly GateViolation[];
}

export interface GatePlanOptions {
  readonly full?: boolean;
}

export interface AtlasDeltaStatus {
  readonly changed: boolean;
  readonly reindexed: boolean;
  readonly coverageFresh: boolean;
}

export interface RuleChangedFile {
  readonly path: string;
  readonly action: "create" | "modify" | "delete";
  readonly content?: string;
}

function result(violations: readonly GateViolation[]): GateResult {
  return { ok: !violations.some((violation) => violation.severity === "block"), violations };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function globToRegExp(pattern: string): RegExp {
  let output = "^";
  let index = 0;
  const normalized = normalizePath(pattern);
  while (index < normalized.length) {
    const character = normalized[index] ?? "";
    if (character === "*") {
      if (normalized.startsWith("**/", index)) {
        output += "(?:[^/]+/)*";
        index += 3;
        continue;
      }
      if (normalized.startsWith("**", index)) {
        output += ".*";
        index += 2;
        continue;
      }
      output += "[^/]*";
      index += 1;
      continue;
    }
    if (character === "?") {
      output += "[^/]";
      index += 1;
      continue;
    }
    output += /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
    index += 1;
  }
  return new RegExp(`${output}$`, "u");
}

function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(normalizePath(path));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function samePathSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left.map(normalizePath))].sort();
  const normalizedRight = [...new Set(right.map(normalizePath))].sort();
  return sameStrings(normalizedLeft, normalizedRight);
}

export function gatesMode(environment: NodeJS.ProcessEnv = process.env): GatesMode {
  return environment["MR_GATES_MODE"] === "warn" ? "warn" : "block";
}

export function shouldBlockGate(gate: GateResult, mode: GatesMode = gatesMode()): boolean {
  return mode === "block" && !gate.ok;
}

export function renderGateResult(gate: GateResult, mode: GatesMode = gatesMode()): string {
  if (gate.violations.length === 0) return "✅ gates passed";
  return gate.violations
    .map((violation) => `- ${mode === "warn" && violation.severity === "block" ? "WARN" : violation.severity.toUpperCase()} ${violation.code}: ${violation.message}`)
    .join("\n");
}

export function gatePlan(
  spec: SpecCapsulePayload,
  tasks: TaskGraphPayload,
  research: ResearchCapsulePayload | undefined,
  store: EvidenceStore | undefined,
  options: GatePlanOptions = {},
): GateResult {
  const violations: GateViolation[] = [];
  const evidenceSeverity: GateSeverity = options.full === false ? "warn" : "block";
  const taskIds = new Set(tasks.tasks.map((task) => task.id));
  const evidenceById = new Map(store?.refs.map((ref) => [ref.id, ref]) ?? []);
  const researchIds = new Set(research?.evidenceRefs ?? []);

  if (research === undefined || store === undefined) {
    violations.push({ code: "RESEARCH_REQUIRED", message: "Task planning requires a persisted ResearchCapsule and EvidenceStore", severity: evidenceSeverity });
  }

  for (const requirement of spec.requirements) {
    const supported = store?.refs.some((ref) => researchIds.has(ref.id) && ref.supports.includes(requirement.id)) ?? false;
    if (!supported) {
      violations.push({ code: "REQUIREMENT_WITHOUT_EVIDENCE", message: `${requirement.id} has no supporting research evidence`, severity: evidenceSeverity });
    }
  }

  const marks = new Map<string, "visiting" | "done">();
  const byId = new Map(tasks.tasks.map((task) => [task.id, task]));
  const visit = (taskId: string, trail: readonly string[]): void => {
    const mark = marks.get(taskId);
    if (mark === "done") return;
    if (mark === "visiting") {
      violations.push({ code: "TASK_CYCLE", message: `Task dependency cycle: ${[...trail, taskId].join(" → ")}`, severity: "block" });
      return;
    }
    marks.set(taskId, "visiting");
    for (const dependency of byId.get(taskId)?.dependsOn ?? []) {
      if (byId.has(dependency)) visit(dependency, [...trail, taskId]);
    }
    marks.set(taskId, "done");
  };

  for (const task of tasks.tasks) {
    visit(task.id, []);
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        violations.push({ code: "UNKNOWN_TASK_DEPENDENCY", message: `${task.id} depends on unknown task ${dependency}`, severity: "block" });
      }
    }
    for (const refId of task.evidenceRefs) {
      if (!evidenceById.has(refId)) {
        violations.push({ code: "MISSING_TASK_EVIDENCE", message: `${task.id} references missing evidence ${refId}`, severity: "block" });
      }
    }
    const allowedFiles = new Set(task.editBoundaries.allowedFiles.map(normalizePath));
    for (const file of task.files) {
      const normalized = normalizePath(file.path);
      const evidenced = task.evidenceRefs.some((refId) => evidenceById.get(refId)?.file === file.path);
      if (!allowedFiles.has(normalized)) {
        violations.push({ code: "FILE_OUTSIDE_BOUNDARY", message: `${task.id} file '${file.path}' is absent from editBoundaries.allowedFiles`, severity: "block" });
      }
      if (!evidenced && file.reason.length < 40) {
        violations.push({ code: "UNEXPLAINED_UNEVIDENCED_FILE", message: `${task.id} file '${file.path}' has no evidence and its reason is shorter than 40 characters`, severity: "block" });
      }
      if (file.evidenced !== evidenced) {
        violations.push({ code: "INVALID_EVIDENCE_FLAG", message: `${task.id} file '${file.path}' has an evidence flag inconsistent with the EvidenceStore`, severity: "block" });
      }
    }
  }
  return result(violations);
}

export function gateBeforeImplement(
  task: SddTask,
  store: EvidenceStore,
  atlas: AtlasGraph,
  freshness?: ReadonlyMap<string, FreshnessResult>,
): GateResult {
  const violations: GateViolation[] = [];
  const refsById = new Map(store.refs.map((ref) => [ref.id, ref]));
  const atlasFiles = new Map(atlas.files.map((file) => [normalizePath(file.path), file]));
  for (const refId of task.evidenceRefs) {
    const ref = refsById.get(refId);
    if (ref === undefined) {
      violations.push({ code: "MISSING_TASK_EVIDENCE", message: `${task.id} references missing evidence ${refId}`, severity: "block" });
      continue;
    }
    const checked = freshness?.get(refId);
    if (checked?.status === "stale") {
      violations.push({ code: "STALE_TASK_EVIDENCE", message: `${refId} for '${ref.file}' is stale (${checked.reason})`, severity: "block" });
      continue;
    }
    if (checked?.status === "relocated") {
      violations.push({ code: "RELOCATED_TASK_EVIDENCE", message: `${refId} moved to ${checked.range[0]}-${checked.range[1]}; register the relocated slice before implementation`, severity: "block" });
      continue;
    }
    if (checked?.status === "fresh") continue;
    const indexed = atlasFiles.get(normalizePath(ref.file));
    if (indexed === undefined || indexed.contentHash !== ref.fileHash) {
      violations.push({ code: "STALE_TASK_EVIDENCE", message: `${refId} for '${ref.file}' is not fresh; relocate and register it again before implementation`, severity: "block" });
    }
  }
  for (const allowed of task.editBoundaries.allowedFiles) {
    const taskFile = task.files.find((file) => normalizePath(file.path) === normalizePath(allowed));
    if (taskFile?.action === "create") continue;
    const representedByEvidence = store.refs.some((ref) => normalizePath(ref.file) === normalizePath(allowed));
    if (!atlasFiles.has(normalizePath(allowed)) && !representedByEvidence) {
      violations.push({ code: "ALLOWED_FILE_MISSING", message: `Allowed file '${allowed}' does not exist in Atlas or the EvidenceStore`, severity: "block" });
    }
  }
  return result(violations);
}

export function gateAfterImplement(
  task: SddTask,
  gitDiffNames: readonly string[],
  receipt: VerificationReceipt | undefined,
  currentDiffHash?: string,
): GateResult {
  const violations: GateViolation[] = [];
  const allowed = new Set(task.editBoundaries.allowedFiles.map(normalizePath));
  for (const file of gitDiffNames) {
    const normalized = normalizePath(file);
    if (!allowed.has(normalized)) {
      violations.push({ code: "DIFF_OUTSIDE_BOUNDARY", message: `Diff file '${file}' is outside ${task.id} edit boundaries`, severity: "block" });
    }
    const forbidden = task.editBoundaries.forbiddenGlobs.find((pattern) => matchesGlob(normalized, pattern));
    if (forbidden !== undefined) {
      violations.push({ code: "FORBIDDEN_DIFF", message: `Diff file '${file}' matches forbidden glob '${forbidden}'`, severity: "block" });
    }
  }
  if (receipt === undefined) {
    violations.push({ code: "VERIFICATION_RECEIPT_MISSING", message: `${task.id} has no persisted verification receipt`, severity: "block" });
    return result(violations);
  }
  if (receipt.taskId !== task.id) {
    violations.push({ code: "VERIFICATION_TASK_MISMATCH", message: `Receipt belongs to ${receipt.taskId}, not ${task.id}`, severity: "block" });
  }
  const commands = receipt.results.map((entry) => entry.command);
  if (!sameStrings(commands, task.verification.commands)) {
    violations.push({ code: "VERIFICATION_COMMAND_MISMATCH", message: `Receipt commands do not exactly match ${task.id} verification.commands`, severity: "block" });
  }
  if (!samePathSet(receipt.changedFiles, gitDiffNames)) {
    violations.push({ code: "VERIFICATION_DIFF_MISMATCH", message: `Receipt changed files do not match the current diff`, severity: "block" });
  }
  if (currentDiffHash !== undefined && receipt.diffHash !== currentDiffHash) {
    violations.push({ code: "VERIFICATION_RECEIPT_STALE", message: `Receipt diff hash does not match the current diff`, severity: "block" });
  }
  const failed = receipt.results.filter((entry) => entry.exitCode !== 0);
  if (failed.length > 0) {
    violations.push({
      code: "VERIFICATION_FAILED",
      message: `Verification failed: ${failed.map((entry) => `${entry.command} (${entry.exitCode})`).join(", ")}`,
      severity: task.verification.mustPass ? "block" : "warn",
    });
  }
  return result(violations);
}

export function gateBeforeJudgment(delta: AtlasDeltaStatus): GateResult {
  const violations: GateViolation[] = [];
  if (delta.changed && !delta.reindexed) {
    violations.push({ code: "ATLAS_DELTA_NOT_REINDEXED", message: "The implementation diff has not been reindexed before judgment", severity: "block" });
  }
  if (!delta.coverageFresh) {
    violations.push({ code: "ATLAS_COVERAGE_STALE", message: "Atlas coverage is not fresh for the judgment diff", severity: "block" });
  }
  return result(violations);
}

function fileStem(path: string): string {
  return path.split("/").pop()?.replace(/\.[^.]+$/u, "") ?? path;
}

function namingMatches(stem: string, convention: string): boolean {
  if (["index", "page", "layout", "route"].includes(stem)) return true;
  if (convention === "kebab-case") return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(stem);
  if (convention === "camelCase") return /^[a-z][a-zA-Z0-9]*$/u.test(stem);
  if (convention === "PascalCase") return /^[A-Z][a-zA-Z0-9]*$/u.test(stem);
  if (convention === "snake_case") return /^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(stem);
  return true;
}

/** Enforce only conventions that can be proven from file names or changed content. */
export function gateRepositoryRules(rules: readonly RepositoryRule[], files: readonly RuleChangedFile[]): GateResult {
  const violations: GateViolation[] = [];
  const add = (rule: RepositoryRule, code: string, message: string): void => {
    violations.push({ code, message, severity: rule.severity === "block" ? "block" : "warn" });
  };
  for (const rule of rules) {
    const relevant = files.filter((file) => matchesRulePath(file.path, rule.appliesTo));
    if (rule.id === "naming.files") {
      for (const file of relevant.filter((candidate) => candidate.action === "create")) {
        if (!namingMatches(fileStem(file.path), rule.value)) add(rule, "RULE_NAMING", `New file '${file.path}' does not use ${rule.value}`);
      }
    }
    if (rule.id === "modules.barrels" && rule.value === "avoid") {
      for (const file of relevant.filter((candidate) => candidate.action === "create" && /^index\.[jt]sx?$/u.test(candidate.path.split("/").pop() ?? ""))) {
        add(rule, "RULE_BARREL", `New barrel '${file.path}' is forbidden by ${rule.id}`);
      }
    }
    if (rule.id === "styles.no-important" && rule.value === "forbid") {
      for (const file of relevant.filter((candidate) => candidate.action !== "delete" && /!important\b/u.test(candidate.content ?? ""))) {
        add(rule, "RULE_IMPORTANT", `'${file.path}' introduces !important`);
      }
    }
    if (rule.id === "boundaries.generated" && rule.value === "do-not-edit") {
      for (const file of relevant.filter((candidate) => /(?:^|\/)(?:generated|__generated__)(?:\/|$)|\.gen\./u.test(candidate.path))) {
        add(rule, "RULE_GENERATED_FILE", `'${file.path}' is generated and must not be edited manually`);
      }
    }
  }
  return result(violations);
}
