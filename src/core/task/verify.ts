import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandReceipt, VerifyTier } from "./schema.js";

export type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

export interface VerificationTools {
  readonly packageManager: PackageManager;
  /** Every script name declared in package.json (trusted: authored by the repository). */
  readonly allScripts: readonly string[];
  readonly scripts: Readonly<Partial<Record<"lint" | "typecheck" | "test" | "format", string>>>;
  readonly eslint: boolean;
  readonly prettier: boolean;
}

const SCRIPT_ALIASES: Readonly<Record<"lint" | "typecheck" | "test" | "format", readonly string[]>> = {
  lint: ["lint"],
  typecheck: ["typecheck", "type-check", "check-types", "tsc", "types"],
  test: ["test", "test:unit"],
  format: ["format:check", "prettier:check", "format"],
};

function readPackageJson(root: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function keysOf(value: unknown): readonly string[] {
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

export function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

export function detectVerificationTools(root: string): VerificationTools {
  const pkg = readPackageJson(root);
  const scriptNames = keysOf(pkg?.["scripts"]);
  const scripts: Partial<Record<"lint" | "typecheck" | "test" | "format", string>> = {};
  for (const [kind, aliases] of Object.entries(SCRIPT_ALIASES) as ["lint" | "typecheck" | "test" | "format", readonly string[]][]) {
    const found = aliases.find((alias) => scriptNames.includes(alias));
    if (found !== undefined) scripts[kind] = found;
  }
  const deps = new Set([...keysOf(pkg?.["dependencies"]), ...keysOf(pkg?.["devDependencies"])]);
  return {
    packageManager: detectPackageManager(root),
    allScripts: scriptNames,
    scripts,
    eslint: deps.has("eslint"),
    prettier: deps.has("prettier"),
  };
}

// ─── Command policy ──────────────────────────────────────────────────────────

const FORBIDDEN_CHARS = /[;&|`$<>(){}\\\n\r*?!~]/u;
const SAFE_TOKEN = /^[\w@.:=/,+-]+$/u;
const KNOWN_BINARIES = new Set(["eslint", "prettier", "tsc", "vitest", "jest", "biome", "stylelint", "vue-tsc", "svelte-check", "astro"]);
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/**
 * Parses a verification command into argv. Allowed shapes, without shell or metacharacters:
 * `<pm> run <script>` for scripts declared in package.json, `<pm> test`, `bun test`,
 * and `npx|bunx|pnpm exec|yarn <known-binary>` for well-known verification binaries.
 */
export function parseVerificationCommand(command: string, scripts: ReadonlySet<string> = new Set()): readonly string[] | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0 || trimmed.length > 300 || FORBIDDEN_CHARS.test(trimmed)) return undefined;
  const argv = trimmed.split(/\s+/u);
  if (!argv.every((token) => SAFE_TOKEN.test(token) && !token.split("/").includes(".."))) return undefined;
  const [binary, first, second] = argv;
  if (binary === undefined || first === undefined) return undefined;
  if ((binary === "npx" || binary === "bunx") && KNOWN_BINARIES.has(first)) return argv;
  if (binary === "pnpm" && first === "exec" && second !== undefined && KNOWN_BINARIES.has(second)) return argv;
  if (!PACKAGE_MANAGERS.has(binary)) return undefined;
  if (first === "test") return argv;
  if (first === "run" && second !== undefined && scripts.has(second)) return argv;
  if (binary === "yarn" && (scripts.has(first) || KNOWN_BINARIES.has(first))) return argv;
  return undefined;
}

function runScript(tools: VerificationTools, script: string): string {
  if (tools.packageManager === "npm") return `npm run ${script}`;
  if (tools.packageManager === "yarn") return `yarn ${script}`;
  return `${tools.packageManager} run ${script}`;
}

function execBinary(tools: VerificationTools, binary: string): string {
  if (tools.packageManager === "bun") return `bunx ${binary}`;
  if (tools.packageManager === "pnpm") return `pnpm exec ${binary}`;
  if (tools.packageManager === "yarn") return `yarn ${binary}`;
  return `npx ${binary}`;
}

const LINTABLE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/u;
const FORMATTABLE = /\.(?:[cm]?[jt]sx?|json|css|scss|md|html|vue|svelte|astro|ya?ml)$/u;

const COVERS_TESTS = /\b(?:test|vitest|jest|phpunit)\b/u;
const COVERS_TYPECHECK = /\b(?:typecheck|type-check|check-types|tsc|vue-tsc|svelte-check)\b/u;

/**
 * Commands that the tier requires; lint/format are scoped to touched files.
 * A floor test or typecheck is skipped when the plan already declares an equivalent command.
 */
export function floorCommands(tier: VerifyTier, tools: VerificationTools, touchedFiles: readonly string[], planCommands: readonly string[] = []): readonly string[] {
  const planTests = planCommands.some((command) => COVERS_TESTS.test(command));
  const planTypecheck = planCommands.some((command) => COVERS_TYPECHECK.test(command));
  const commands: string[] = [];
  const safeFiles = touchedFiles.filter((file) => SAFE_TOKEN.test(file) && !file.split("/").includes(".."));
  const lintFiles = safeFiles.filter((file) => LINTABLE.test(file));
  const formatFiles = safeFiles.filter((file) => FORMATTABLE.test(file));
  if (tools.prettier && formatFiles.length > 0) commands.push(`${execBinary(tools, "prettier")} --check ${formatFiles.join(" ")}`);
  if (tools.eslint && lintFiles.length > 0) commands.push(`${execBinary(tools, "eslint")} ${lintFiles.join(" ")}`);
  else if (!tools.eslint && tools.scripts.lint !== undefined) commands.push(runScript(tools, tools.scripts.lint));
  if ((tier === "typecheck" || tier === "tests") && tools.scripts.typecheck !== undefined && !planTypecheck) commands.push(runScript(tools, tools.scripts.typecheck));
  if (tier === "tests" && tools.scripts.test !== undefined && !planTests) commands.push(runScript(tools, tools.scripts.test));
  return commands;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export type CommandRunner = (argv: readonly string[], cwd: string, timeoutMs: number) => Promise<{ readonly exitCode: number | null; readonly output: string }>;

export const spawnRunner: CommandRunner = (argv, cwd, timeoutMs) => new Promise((resolve) => {
  const [binary, ...args] = argv;
  if (binary === undefined) {
    resolve({ exitCode: null, output: "empty command" });
    return;
  }
  const child = spawn(binary, args, { cwd, shell: false, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
  let output = "";
  const collect = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
    if (output.length > 200_000) output = output.slice(-100_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timer = setTimeout(() => {
    output += `\n[mr] timed out after ${String(timeoutMs)} ms`;
    child.kill("SIGKILL");
  }, timeoutMs);
  child.once("error", (error) => {
    clearTimeout(timer);
    resolve({ exitCode: null, output: `${output}\n${error.message}` });
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve({ exitCode: code, output });
  });
});

export async function runVerification(
  commands: readonly { readonly command: string; readonly origin: CommandReceipt["origin"] }[],
  cwd: string,
  scripts: ReadonlySet<string>,
  runner: CommandRunner = spawnRunner,
  timeoutMs = 300_000,
): Promise<readonly CommandReceipt[]> {
  const receipts: CommandReceipt[] = [];
  const seen = new Set<string>();
  for (const { command, origin } of commands) {
    const normalized = command.trim().replace(/\s+/gu, " ");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const argv = parseVerificationCommand(normalized, scripts);
    if (argv === undefined) {
      receipts.push({ command: normalized, ok: false, exitCode: null, durationMs: 0, outputTail: "rejected by verification command policy", origin });
      continue;
    }
    const started = Date.now();
    const result = await runner(argv, cwd, timeoutMs);
    const outputTail = result.output.length > 4_000 ? `…${result.output.slice(-3_999)}` : result.output;
    receipts.push({ command: normalized, ok: result.exitCode === 0, exitCode: result.exitCode, durationMs: Date.now() - started, outputTail, origin });
  }
  return receipts;
}

export function outOfPlanFiles(changed: readonly string[], planned: readonly string[], baselineDirty: readonly string[]): readonly string[] {
  const allowed = new Set([...planned, ...baselineDirty]);
  return changed.filter((file) => !allowed.has(file));
}
