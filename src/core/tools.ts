import type { AtlasGraph } from "./atlas.js";
import { findNodeByName, getNodeDependencies, getNodeDependents } from "./atlas.js";
import { renderProposal } from "./render.js";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { MrPaths } from "./paths.js";

// ─── /trace - React Forensics ────────────────────────────────────────────────

export interface TraceIssue {
  readonly type: "stale-closure" | "missing-dependency" | "infinite-loop" | "hydration-mismatch" | "race-condition" | "unused-variable";
  readonly severity: "critical" | "warning" | "info";
  readonly node: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly suggestion: string;
}

export interface TraceReport {
  readonly schemaVersion: 1;
  readonly target: string;
  readonly issues: readonly TraceIssue[];
  readonly generatedAt: string;
  readonly durationMs: number;
}

export function traceComponent(graph: AtlasGraph, componentName: string): TraceReport {
  const start = Date.now();
  const issues: TraceIssue[] = [];

  const component = findNodeByName(graph, componentName);
  if (component === undefined) {
    return {
      schemaVersion: 1,
      target: componentName,
      issues: [{
        type: "unused-variable",
        severity: "critical",
        node: componentName,
        file: "unknown",
        line: 0,
        message: `Component '${componentName}' not found in atlas graph`,
        suggestion: "Run /atlas to index the workspace first",
      }],
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    };
  }

  // Check for common React issues
  const deps = getNodeDependencies(graph, component.id);
  const dependents = getNodeDependents(graph, component.id);

  // Detect potential stale closures (hooks without proper deps)
  if (component.kind === "component") {
    const hookDeps = deps.filter((d) => d.kind === "hook");
    if (hookDeps.length > 0) {
      issues.push({
        type: "stale-closure",
        severity: "warning",
        node: component.name,
        file: component.filePath,
        line: component.line,
        message: `Component uses ${hookDeps.length} hook(s) - verify dependency arrays`,
        suggestion: "Check useEffect and useCallback dependency arrays for stale closures",
      });
    }
  }

  // Detect unused exports
  if (component.exports.length > 0 && dependents.length === 0) {
    issues.push({
      type: "unused-variable",
      severity: "info",
      node: component.name,
      file: component.filePath,
      line: component.line,
      message: `Component '${component.name}' is exported but has no dependents`,
      suggestion: "Consider removing unused export or verify it's used via dynamic import",
    });
  }

  return {
    schemaVersion: 1,
    target: componentName,
    issues,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}

export function renderTraceReport(report: TraceReport): string {
  const lines = [
    `# Trace Report — ${report.target}`,
    "",
    `Generated: ${report.generatedAt} (${report.durationMs}ms)`,
    "",
    `## Issues Found: ${report.issues.length}`,
    "",
  ];

  if (report.issues.length === 0) {
    lines.push("✅ No issues detected.");
  } else {
    for (const issue of report.issues) {
      const icon = issue.severity === "critical" ? "🔴" : issue.severity === "warning" ? "🟡" : "🔵";
      lines.push(`${icon} **${issue.type}** (${issue.severity})`);
      lines.push(`   - File: \`${issue.file}:${issue.line}\``);
      lines.push(`   - Node: ${issue.node}`);
      lines.push(`   - ${issue.message}`);
      lines.push(`   - 💡 ${issue.suggestion}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─── /propose - Technical Proposals ──────────────────────────────────────────

export interface ProposalInput {
  readonly title: string;
  readonly context: string;
  readonly problem: string;
  readonly solution: string;
  readonly alternatives: readonly string[];
  readonly risks: readonly string[];
  readonly estimatedEffort: "XS" | "S" | "M" | "L" | "XL";
}

export async function saveProposal(
  paths: MrPaths,
  workspaceId: string,
  input: ProposalInput,
  workspaceRoot?: string,
): Promise<string> {
  const proposalsDir = workspaceRoot !== undefined
    ? join(workspaceRoot, ".aicontext", "deliverables", "mr", "proposals")
    : join(paths.dataRoot, workspaceId, "proposals");
  await mkdir(proposalsDir, { recursive: true });

  const filename = `${Date.now()}-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
  const filepath = join(proposalsDir, filename);

  const content = renderProposal(input.title, `
## Contexto
${input.context}

## Problema
${input.problem}

## Solución Propuesta
${input.solution}

## Alternativas Consideradas
${input.alternatives.map((a) => `- ${a}`).join("\n")}

## Riesgos
${input.risks.map((r) => `- ${r}`).join("\n")}

## Estimación
**Esfuerzo**: ${input.estimatedEffort}
`);

  await writeFile(filepath, content);
  return filepath;
}

// ─── /prompt - Prompt Engineering ────────────────────────────────────────────

export interface PromptTemplate {
  readonly name: string;
  readonly description: string;
  readonly template: string;
  readonly variables: readonly string[];
}

export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    name: "bugfix",
    description: "Fix a bug with root cause analysis",
    template: `Fix the following bug:

**Symptom**: {{symptom}}
**Expected**: {{expected}}
**Actual**: {{actual}}

Perform root cause analysis, implement the minimal fix, and verify with tests.`,
    variables: ["symptom", "expected", "actual"],
  },
  {
    name: "feature",
    description: "Implement a new feature",
    template: `Implement the following feature:

**Requirement**: {{requirement}}
**Acceptance Criteria**: {{criteria}}

Follow the existing patterns in the codebase. Ensure type safety and add appropriate tests.`,
    variables: ["requirement", "criteria"],
  },
  {
    name: "refactor",
    description: "Refactor existing code",
    template: `Refactor the following code:

**Current State**: {{current}}
**Desired State**: {{desired}}
**Constraints**: {{constraints}}

Preserve all existing behavior. Apply the strangler fig pattern if needed.`,
    variables: ["current", "desired", "constraints"],
  },
  {
    name: "review",
    description: "Review code changes",
    template: `Review the following changes:

**Files Changed**: {{files}}
**Context**: {{context}}

Look for bugs, security issues, performance problems, and convention violations. Be thorough and adversarial.`,
    variables: ["files", "context"],
  },
];

export function buildPrompt(templateName: string, variables: Record<string, string>): string {
  const template = PROMPT_TEMPLATES.find((t) => t.name === templateName);
  if (template === undefined) {
    throw new Error(`Unknown template: ${templateName}. Available: ${PROMPT_TEMPLATES.map((t) => t.name).join(", ")}`);
  }

  let result = template.template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }

  // Check for unresolved variables
  const unresolved = result.match(/\{\{(\w+)\}\}/g);
  if (unresolved !== null) {
    throw new Error(`Unresolved variables: ${unresolved.join(", ")}`);
  }

  return result;
}

export async function copyToClipboard(text: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const platform = process.platform;

  if (platform === "darwin") {
    const proc = spawn("pbcopy", [], { stdio: ["pipe", "inherit", "inherit"] });
    proc.stdin.write(text);
    proc.stdin.end();
  } else if (platform === "linux") {
    const proc = spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "inherit", "inherit"] });
    proc.stdin.write(text);
    proc.stdin.end();
  } else {
    throw new Error(`Clipboard not supported on ${platform}`);
  }
}
