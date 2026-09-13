import type { JudgeFinding, JudgeVerdict, MergedVerdict } from "./flow-schema.js";
import { runCommand } from "./process.js";

// ─── Verdict Merger ──────────────────────────────────────────────────────────

export function mergeVerdicts(verdictA: JudgeVerdict, verdictB: JudgeVerdict): MergedVerdict {
  const findingKeys = new Set<string>();
  const findings = [...verdictA.findings, ...verdictB.findings].filter((finding) => {
    const key = `${finding.severity}:${finding.file}:${finding.side}:${String(finding.line)}:${finding.claim}`;
    if (findingKeys.has(key)) return false;
    findingKeys.add(key);
    return true;
  });
  const claims = (severity: JudgeFinding["severity"]): string[] => [
    ...new Set(findings.filter((finding) => finding.severity === severity).map((finding) => finding.claim)),
  ];
  const critical = claims("critical");
  const warnings = claims("warning");
  const suggestions = claims("suggestion");

  // Approved only if BOTH approve
  const approved = verdictA.approved && verdictB.approved && critical.length === 0;

  return {
    schemaVersion: 1,
    approved,
    critical,
    warnings,
    suggestions,
    findings,
    judgeA: verdictA,
    judgeB: verdictB,
    mergedAt: new Date().toISOString(),
  };
}

export interface JudgeFindingValidationOptions {
  readonly approved: boolean;
  readonly requirementIds?: ReadonlySet<string>;
}

function normalizeEvidence(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

interface DiffLineMaps {
  readonly new: Map<string, Map<number, string>>;
  readonly old: Map<string, Map<number, string>>;
}

function addDiffLine(files: Map<string, Map<number, string>>, file: string | undefined, line: number, source: string): void {
  if (file === undefined) return;
  let lines = files.get(file);
  if (lines === undefined) {
    lines = new Map();
    files.set(file, lines);
  }
  lines.set(line, source);
}

function parseDiffLines(diff: string): DiffLineMaps {
  const files: DiffLineMaps = { new: new Map(), old: new Map() };
  let oldFile: string | undefined;
  let newFile: string | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("--- ")) {
      const headerPath = rawLine.slice(4).trim();
      oldFile = headerPath === "/dev/null"
        ? undefined
        : headerPath.startsWith("a/") ? headerPath.slice(2) : headerPath;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      const headerPath = rawLine.slice(4).trim();
      newFile = headerPath === "/dev/null"
        ? undefined
        : headerPath.startsWith("b/") ? headerPath.slice(2) : headerPath;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(rawLine);
    if (hunk !== null) {
      oldLine = Number.parseInt(hunk[1] ?? "0", 10);
      newLine = Number.parseInt(hunk[2] ?? "0", 10);
      continue;
    }
    if (oldLine === undefined || newLine === undefined) continue;
    if (rawLine.startsWith("+")) {
      addDiffLine(files.new, newFile, newLine, rawLine.slice(1));
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      addDiffLine(files.old, oldFile, oldLine, rawLine.slice(1));
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      addDiffLine(files.old, oldFile, oldLine, rawLine.slice(1));
      addDiffLine(files.new, newFile, newLine, rawLine.slice(1));
      oldLine += 1;
      newLine += 1;
    } else if (!rawLine.startsWith("\\")) {
      oldLine = undefined;
      newLine = undefined;
    }
  }
  return files;
}

/** Maps visible lines from one side of a unified diff to their exact source text. */
export function visibleDiffLines(
  diff: string,
  side: JudgeFinding["side"] = "new",
): ReadonlyMap<string, ReadonlyMap<number, string>> {
  return parseDiffLines(diff)[side];
}

/** Deterministically rejects findings that are not directly anchored to the supplied diff. */
export function validateJudgeFindings(
  diff: string,
  findings: readonly JudgeFinding[],
  options: JudgeFindingValidationOptions,
): readonly string[] {
  const issues: string[] = [];
  const linesBySide = parseDiffLines(diff);
  const seen = new Set<string>();

  for (const [index, finding] of findings.entries()) {
    const prefix = `finding ${String(index + 1)}`;
    const key = `${finding.severity}:${finding.file}:${finding.side}:${String(finding.line)}:${finding.claim}`;
    if (seen.has(key)) issues.push(`${prefix}: duplicate finding`);
    seen.add(key);

    const line = linesBySide[finding.side].get(finding.file)?.get(finding.line);
    if (line === undefined) {
      issues.push(`${prefix}: ${finding.file}:${String(finding.line)} is not a visible ${finding.side}-side diff line`);
    } else {
      const actual = normalizeEvidence(line);
      const cited = normalizeEvidence(finding.evidence);
      if (cited.length === 0 || !actual.includes(cited)) {
        issues.push(`${prefix}: evidence is not an exact snippet of ${finding.file}:${String(finding.line)}`);
      }
    }

    if (finding.requirementId !== undefined && !options.requirementIds?.has(finding.requirementId)) {
      issues.push(`${prefix}: unknown requirement ${finding.requirementId}`);
    }
  }

  const hasCritical = findings.some((finding) => finding.severity === "critical");
  if (options.approved === hasCritical) {
    issues.push(hasCritical
      ? "approved must be false when critical findings exist"
      : "approved must be true when no critical findings exist");
  }
  return issues;
}

import { sha256 } from "./files.js";

// ─── Diff Utilities (CAS with SHA-256) ─────────────────────────────────────────

export async function getDiffHash(root: string): Promise<string> {
  // Ensure untracked files are staged as intent-to-add so they appear in diff
  runCommand("git", ["-C", root, "add", "-N", "."]);
  const result = runCommand("git", ["-C", root, "diff", "HEAD"]);
  if (!result.ok) {
    // If not in a git repo with HEAD, try unstaged diff or empty
    const unstaged = runCommand("git", ["-C", root, "diff"]);
    if (!unstaged.ok || unstaged.stdout.length === 0) return sha256("");
    return sha256(unstaged.stdout);
  }
  return sha256(result.stdout);
}

export async function getFullDiff(root: string): Promise<string> {
  runCommand("git", ["-C", root, "add", "-N", "."]);
  const result = runCommand("git", ["-C", root, "diff", "HEAD"]);
  if (!result.ok) return "";
  return result.stdout;
}

// ─── Fix Loop (Bounded Correction) ───────────────────────────────────────────

export interface FixAttempt {
  readonly attempt: number;
  readonly verdict: MergedVerdict;
  readonly fixedAt: string;
  readonly diffHash: string;
}

export interface FixLoopState {
  readonly maxAttempts: number;
  readonly attempts: FixAttempt[];
  readonly currentAttempt: number;
}

export function createFixLoop(maxAttempts = 3): FixLoopState {
  return {
    maxAttempts,
    attempts: [],
    currentAttempt: 0,
  };
}

export function canContinueFixLoop(state: FixLoopState): boolean {
  return state.currentAttempt < state.maxAttempts;
}

export function recordFixAttempt(state: FixLoopState, verdict: MergedVerdict, diffHash: string): FixLoopState {
  const attempt: FixAttempt = {
    attempt: state.currentAttempt + 1,
    verdict,
    fixedAt: new Date().toISOString(),
    diffHash,
  };
  return {
    ...state,
    attempts: [...state.attempts, attempt],
    currentAttempt: state.currentAttempt + 1,
  };
}

export function shouldEscalateToHuman(state: FixLoopState): boolean {
  // Escalate if max attempts reached or if same critical issues persist
  if (state.currentAttempt >= state.maxAttempts) return true;
  if (state.attempts.length >= 2) {
    const last = state.attempts[state.attempts.length - 1];
    const prev = state.attempts[state.attempts.length - 2];
    if (last === undefined || prev === undefined) return false;
    const lastCritical = new Set(last.verdict.critical);
    const prevCritical = new Set(prev.verdict.critical);
    // If same critical issues appear twice, escalate
    if (lastCritical.size === prevCritical.size && [...lastCritical].every((c) => prevCritical.has(c))) {
      return true;
    }
  }
  return false;
}

// ─── Judge Prompts ───────────────────────────────────────────────────────────

export function buildJudgePrompt(diff: string, judge: "a" | "b", contextBundle?: string): string {
  const judgeName = judge === "a" ? "Judge A" : "Judge B";
  return `You are ${judgeName}, an adversarial code reviewer. Your job is to find problems in the following diff.

Review this diff critically. Look for:
- Bugs, logic errors, edge cases
- Security vulnerabilities
- Performance issues
- Missing error handling
- Violations of project conventions
- Missing tests
- Accessibility issues

Diff:
\`\`\`
${diff}
\`\`\`

${contextBundle === undefined ? "" : `## Context bundle\n${contextBundle}\n`}

Use only the supplied diff. Every finding must cite a visible line, identify side=new|old, and copy an exact snippet from that line.
If evidence is missing, return the standardized insufficient-evidence object instead of guessing.
Return only the strict verdict object to the orchestrator. You are not user-facing: do not explain the work, narrate progress, or add prose around the object.

Supported example:
{
  "status": "SUPPORTED",
  "approved": boolean,
  "findings": [{
    "severity": "critical" | "warning" | "suggestion",
    "claim": "specific finding",
    "file": "src/file.ts",
    "line": 12,
    "side": "new",
    "source": "diff",
    "evidence": "exact snippet from line 12",
    "requirementId": "R1"
  }]
}

Insufficient-evidence example:
{"status":"INSUFFICIENT_EVIDENCE","missing":["specific missing evidence"],"nextAction":"inspect the required source"}

Be thorough and adversarial. Do not approve if there are critical issues.`;
}

export function buildFixPrompt(verdict: MergedVerdict, originalDiff: string, contextBundle?: string): string {
  const validatedCritical = verdict.findings.filter((finding) => finding.severity === "critical");
  return `You are mr-fix. Apply ONLY the corrections indicated in the merged verdict.

## Validated critical findings
${validatedCritical.length === 0 ? "None" : JSON.stringify(validatedCritical, null, 2)}

## Original Diff
\`\`\`
${originalDiff}
\`\`\`

${contextBundle === undefined ? "" : `## Context bundle\n${contextBundle}\n`}

Apply the minimal fixes needed to address the critical issues. Do not refactor or make unrelated changes.
Return only a compact execution receipt to the orchestrator. You are not user-facing: do not add didactic explanations, progress narration, preambles, recaps, or next-step advice.`;
}
