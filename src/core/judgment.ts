import type { JudgeVerdict, MergedVerdict } from "./flow-schema.js";
import { runCommand } from "./process.js";

// ─── Verdict Merger ──────────────────────────────────────────────────────────

export function mergeVerdicts(verdictA: JudgeVerdict, verdictB: JudgeVerdict): MergedVerdict {
  // Critical: union of both
  const critical = [...new Set([...verdictA.critical, ...verdictB.critical])];
  // Warnings: union of both
  const warnings = [...new Set([...verdictA.warnings, ...verdictB.warnings])];
  // Suggestions: union of both
  const suggestions = [...new Set([...verdictA.suggestions, ...verdictB.suggestions])];

  // Approved only if BOTH approve
  const approved = verdictA.approved && verdictB.approved;

  return {
    schemaVersion: 1,
    approved,
    critical,
    warnings,
    suggestions,
    judgeA: verdictA,
    judgeB: verdictB,
    mergedAt: new Date().toISOString(),
  };
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

export function buildJudgePrompt(diff: string, judge: "a" | "b"): string {
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

Respond with a JSON object:
{
  "approved": boolean,
  "critical": ["list of critical issues that MUST be fixed"],
  "warnings": ["list of warnings that should be addressed"],
  "suggestions": ["list of suggestions for improvement"]
}

Be thorough and adversarial. Do not approve if there are critical issues.`;
}

export function buildFixPrompt(verdict: MergedVerdict, originalDiff: string): string {
  return `You are mr-fix. Apply ONLY the corrections indicated in the merged verdict.

## Verdict
- Critical: ${verdict.critical.join(", ") || "None"}
- Warnings: ${verdict.warnings.join(", ") || "None"}
- Suggestions: ${verdict.suggestions.join(", ") || "None"}

## Original Diff
\`\`\`
${originalDiff}
\`\`\`

Apply the minimal fixes needed to address the critical issues. Do not refactor or make unrelated changes.`;
}
