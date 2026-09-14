import { Parser, Language, type Node as SyntaxNode } from "web-tree-sitter";
import { parseAllDocuments } from "yaml";
import { createHash } from "node:crypto";
import { readFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.js";
import type { MrPaths } from "./paths.js";
import { atomicWrite, canonicalJson, sha256 } from "./files.js";
import { buildResolverContext, resolveJsSpecifier, resolvePhpClass, type ResolverContext } from "./atlas-resolve.js";
import { runExtractors, type ExtractorFile } from "./extractors/index.js";
import { matchCrossRepoContracts } from "./contracts.js";

// ─── Atlas Graph Types ───────────────────────────────────────────────────────

export interface AtlasNode {
  readonly id: string;
  readonly name: string;
  readonly kind: "component" | "hook" | "util" | "service" | "type" | "constant" | "function" | "class" | "interface" | "module" | "route" | "entity" | "contract" | "federation-contract" | "query-key" | "slice" | "server-action" | "token";
  readonly filePath: string;
  readonly line: number;
  readonly endLine?: number;
  readonly column: number;
  readonly exports: readonly string[];
  readonly imports: readonly string[];
  readonly dependencies: readonly string[];
  readonly dependents: readonly string[];
  readonly signature?: string;
  readonly metadata: Record<string, unknown>;
}

export interface AtlasEdge {
  readonly from: string;
  readonly to: string;
  readonly type: "import" | "export" | "dependency" | "reference" | "calls" | "extends" | "implements" | "exposes" | "consumes" | "route" | "entity" | "event" | "query-key" | "style-use";
}

export interface AtlasFileRecord {
  readonly path: string;
  readonly contentHash: string;
  readonly language: "typescript" | "tsx" | "javascript" | "jsx" | "php" | "java" | "css" | "scss" | "astro" | "json" | "yaml" | "unsupported";
  readonly parseStatus: "ok" | "partial" | "error" | "unsupported";
  readonly nodeIds: readonly string[];
  readonly errorRanges?: readonly [number, number][];
}

export interface AtlasContract {
  readonly id: string;
  readonly name: string;
  readonly file: string;
  readonly kind: "dto" | "interface" | "schema" | "route" | "event" | "federation";
  readonly metadata: Record<string, unknown>;
}

export interface AtlasCoverage {
  readonly indexerVersion: string;
  readonly supportedLanguages: readonly string[];
  readonly unsupportedFiles: readonly string[];
  readonly parseErrors: readonly { readonly path: string; readonly line: number; readonly message: string }[];
  readonly unresolvedImports: readonly { readonly from: string; readonly specifier: string }[];
  readonly extractorErrors?: readonly { readonly extractor: string; readonly message: string }[];
  readonly semantic?: "full" | "syntactic-only";
  readonly semanticDiagnostics?: readonly { readonly file: string; readonly line: number; readonly message: string; readonly tool: "phpstan" | "psalm" }[];
  readonly semanticErrors?: readonly string[];
}

export interface AtlasGraph {
  readonly schemaVersion: 2;
  readonly generatedAt: string;
  readonly workspaceRoot: string;
  readonly gitStamp?: string;
  readonly nodes: readonly AtlasNode[];
  readonly edges: readonly AtlasEdge[];
  readonly files: readonly AtlasFileRecord[];
  readonly contracts?: readonly AtlasContract[];
  readonly coverage: AtlasCoverage;
  readonly stats: {
    readonly totalFiles: number;
    readonly totalNodes: number;
    readonly totalEdges: number;
    readonly indexDurationMs: number;
  };
}

export interface GovernanceRule {
  readonly id: string;
  readonly pattern: string;
  readonly action: "deny" | "warn" | "allow";
  readonly reason: string;
  readonly appliesTo: readonly string[];
}

export interface GovernanceConfig {
  readonly schemaVersion: 1;
  readonly rules: readonly GovernanceRule[];
  readonly forbiddenPaths: readonly string[];
  readonly antiPatterns: readonly string[];
}

// ─── Git Stamp (cache invalidation) ──────────────────────────────────────────

/**
 * Deterministic stamp of the working tree: HEAD hash + porcelain status digest.
 * Returns undefined outside a git repo (cache then never auto-invalidates).
 */
export function computeGitStamp(root: string): string | undefined {
  const head = runCommand("git", ["-C", root, "rev-parse", "HEAD"]);
  if (!head.ok) return undefined;
  const status = runCommand("git", ["-C", root, "status", "--porcelain"]);
  const dirty = status.ok ? status.stdout : "";
  return createHash("sha256").update(`${head.stdout.trim()}\n${dirty}`).digest("hex").slice(0, 16);
}

// ─── Tree-sitter Runtime ─────────────────────────────────────────────────────

type LangKind = "typescript" | "tsx" | "javascript" | "php" | "java" | "css";

const WASM_SOURCES: Record<LangKind, { pkg: string; file: string }> = {
  typescript: { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  tsx: { pkg: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  javascript: { pkg: "tree-sitter-javascript", file: "tree-sitter-javascript.wasm" },
  php: { pkg: "tree-sitter-php", file: "tree-sitter-php.wasm" },
  java: { pkg: "tree-sitter-java", file: "tree-sitter-java.wasm" },
  css: { pkg: "tree-sitter-css", file: "tree-sitter-css.wasm" },
};

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function resolveWasmPath(kind: LangKind): string {
  const { pkg, file } = WASM_SOURCES[kind];
  const candidates: string[] = [];
  const envDir = process.env["MR_WASM_DIR"];
  if (envDir !== undefined && envDir.length > 0) {
    candidates.push(join(envDir, file));
  }
  try {
    const require = createRequire(import.meta.url);
    candidates.push(require.resolve(`${pkg}/${file}`));
  } catch {
    // package not resolvable from here; fall through to directory walks
  }
  // Deployed layout: <generated>/core/atlas.js next to <generated>/wasm/*.wasm
  candidates.push(join(moduleDir(), "..", "wasm", file));
  candidates.push(join(moduleDir(), "wasm", file));
  // Dev layout: walk up looking for node_modules
  let dir = moduleDir();
  for (let index = 0; index < 6; index += 1) {
    candidates.push(join(dir, "node_modules", pkg, file));
    dir = dirname(dir);
  }
  candidates.push(join(process.cwd(), "node_modules", pkg, file));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot locate ${file}. Searched:\n${candidates.join("\n")}\nSet MR_WASM_DIR to override.`);
}

let parserInitialized = false;
const languageCache = new Map<LangKind, Language>();

async function getLanguage(kind: LangKind): Promise<Language> {
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }
  const cached = languageCache.get(kind);
  if (cached !== undefined) return cached;
  const language = await Language.load(resolveWasmPath(kind));
  languageCache.set(kind, language);
  return language;
}

function langForFile(filePath: string): LangKind | undefined {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts")) return "typescript";
  if (/\.(?:js|jsx|mjs|cjs)$/u.test(filePath)) return "javascript";
  if (filePath.endsWith(".php")) return "php";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".css")) return "css";
  return undefined;
}

function languageForFile(filePath: string): AtlasFileRecord["language"] {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts")) return "typescript";
  if (filePath.endsWith(".jsx")) return "jsx";
  if (/\.(?:js|mjs|cjs)$/u.test(filePath)) return "javascript";
  if (filePath.endsWith(".php")) return "php";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".scss")) return "scss";
  if (filePath.endsWith(".astro")) return "astro";
  return configFormatFor(filePath) ?? "unsupported";
}

export async function validateAstSyntax(source: string, filePath: string): Promise<{ ok: true } | { ok: false; error: string; line: number; column: number }> {
  const kind = langForFile(filePath);
  if (kind === undefined) {
    return { ok: true };
  }
  const result = await withParsedRoot(source, kind, (rootNode) => {
    if (rootNode.hasError) {
      // Find the first error node
      const findError = (n: SyntaxNode): SyntaxNode | undefined => {
        if (n.type === "ERROR" || n.isMissing) return n;
        for (let i = 0; i < n.childCount; i++) {
          const child = n.child(i);
          if (child?.hasError) {
            const res = findError(child);
            if (res) return res;
          }
        }
        return undefined;
      };
      const errNode = findError(rootNode);
      const row = (errNode?.startPosition.row ?? 0) + 1;
      const col = errNode?.startPosition.column ?? 0;
      return {
        ok: false as const,
        error: `Syntax error at line ${row}, column ${col}${errNode?.text ? `: "${errNode.text.slice(0, 40)}"` : ""}`,
        line: row,
        column: col,
      };
    }
    return { ok: true as const };
  });
  return result ?? { ok: true };
}

async function withParsedRoot<T>(
  source: string,
  kind: LangKind,
  extract: (rootNode: SyntaxNode) => T,
): Promise<T | undefined> {
  const language = await getLanguage(kind);
  const parser = new Parser();
  let tree = null;
  try {
    parser.setLanguage(language);
    tree = parser.parse(source);
    if (tree === null) return undefined;
    return extract(tree.rootNode);
  } finally {
    tree?.delete();
    parser.delete();
  }
}

// ─── File Discovery ──────────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set(["node_modules", "vendor", ".git", "dist", "build", "out", "coverage", "target", ".next", ".turbo", "var", ".astro", ".expo", "storybook-static", "public/build", "runtimes"]);

export const DEFAULT_INCLUDE_PATTERNS: readonly string[] = [
  // Single-repo layout: code
  "src/**/*.ts",
  "src/**/*.tsx",
  "src/**/*.js",
  "src/**/*.jsx",
  "src/**/*.mjs",
  "src/**/*.cjs",
  "src/**/*.php",
  "src/**/*.css",
  "src/**/*.scss",
  "src/**/*.astro",
  "src/**/*.java",
  // Single-repo layout: configuration
  "*.json",
  "*.yml",
  "*.yaml",
  "composer.json",
  "pnpm-workspace.yaml",
  "tsconfig*.json",
  "vite.config.*",
  "webpack.config.*",
  "astro.config.*",
  "app.json",
  "app.config.*",
  "eslint.config.*",
  ".eslintrc*",
  "prettier.config.*",
  ".prettierrc*",
  "commitlint.config.*",
  "phpstan*.neon",
  "phpunit*.xml",
  ".php-cs-fixer.php",
  ".github/**/*.md",
  ".github/**/*.yml",
  ".github/**/*.yaml",
  "src/**/*.json",
  "src/**/*.yml",
  "src/**/*.yaml",
  "config/**/*.php",
  "config/**/*.yml",
  "config/**/*.yaml",
  "config/**/*.xml",
  // Nested workspaces may place sources under repositories/<project>/code[/<module>]/src/.
  "repos/**/src/**/*.ts",
  "repos/**/src/**/*.tsx",
  "repos/**/src/**/*.js",
  "repos/**/src/**/*.jsx",
  "repos/**/src/**/*.mjs",
  "repos/**/src/**/*.cjs",
  "repos/**/src/**/*.php",
  "repos/**/src/**/*.css",
  "repos/**/src/**/*.scss",
  "repos/**/src/**/*.astro",
  "repos/**/src/**/*.java",
  // Configuration inside workspaces: Spring resources, i18n, OpenAPI specs, repo/root configs
  "repos/**/src/**/*.json",
  "repos/**/src/**/*.yml",
  "repos/**/src/**/*.yaml",
  "repos/*/*.yml",
  "repos/*/*.yaml",
  "repos/*/*.json",
  "repos/*/code/*.json",
  "repos/*/code/*.yml",
  "repos/*/code/*.yaml",
  // OpenAPI specifications stored outside source/resource trees
  "repos/**/apis/**/*.yml",
  "repos/**/apis/**/*.yaml",
  "repos/**/apis/**/*.json",
  "repos/**/config/**/*.php",
  "repos/**/config/**/*.yml",
  "repos/**/config/**/*.yaml",
  "repos/**/config/**/*.xml",
  "repos/**/composer.json",
  "repos/**/tsconfig*.json",
  "repos/**/vite.config.*",
  "repos/**/webpack.config.*",
  "repos/**/eslint.config.*",
  "repos/**/.eslintrc*",
  "repos/**/prettier.config.*",
  "repos/**/.prettierrc*",
  "repos/**/commitlint.config.*",
  "repos/**/phpstan*.neon",
  "repos/**/phpunit*.xml",
  "repos/**/.github/**/*.md",
  "packages/**/src/**/*.ts",
  "packages/**/src/**/*.tsx",
  "packages/**/src/**/*.js",
  "packages/**/src/**/*.jsx",
  "packages/**/src/**/*.php",
  "packages/**/src/**/*.css",
  "packages/**/src/**/*.scss",
  "packages/**/src/**/*.astro",
  "packages/**/package.json",
  "packages/**/tsconfig*.json",
  "packages/**/config/**/*.xml",
  "packages/**/config/**/*.php",
  "packages/**/config/**/*.yml",
  "packages/**/config/**/*.yaml",
  "packages/**/vite.config.*",
  "packages/**/webpack.config.*",
  "packages/**/eslint.config.*",
  "packages/**/prettier.config.*",
  "apps/**/src/**/*.ts",
  "apps/**/src/**/*.tsx",
  "apps/**/src/**/*.js",
  "apps/**/src/**/*.jsx",
  "apps/**/src/**/*.php",
  "apps/**/src/**/*.css",
  "apps/**/src/**/*.scss",
  "apps/**/src/**/*.astro",
  "apps/**/package.json",
  "apps/**/tsconfig*.json",
  "apps/**/config/**/*.xml",
  "apps/**/config/**/*.php",
  "apps/**/config/**/*.yml",
  "apps/**/config/**/*.yaml",
  "apps/**/vite.config.*",
  "apps/**/webpack.config.*",
  "apps/**/eslint.config.*",
  "apps/**/prettier.config.*",
  "apps/**/app/**/*.ts",
  "apps/**/app/**/*.tsx",
  "apps/**/app/**/*.js",
  "apps/**/app/**/*.jsx",
  "app/**/*.ts",
  "app/**/*.tsx",
  "app/**/*.js",
  "app/**/*.jsx",
];

/** Lockfiles and generated blobs: deliberately not indexed as configuration. */
const CONFIG_SKIP_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "composer.lock",
  "flake.lock",
]);

const CONFIG_MAX_BYTES = 2_000_000;
const SOURCE_MAX_BYTES = 1_500_000;

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  let index = 0;
  while (index < pattern.length) {
    const ch = pattern[index] ?? "";
    if (ch === "*") {
      if (pattern.startsWith("**/", index)) {
        out += "(?:[^/]+/)*";
        index += 3;
        continue;
      }
      if (pattern.startsWith("**", index)) {
        out += ".*";
        index += 2;
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }
    out += /[.+^${}()|[\]\\?]/u.test(ch) ? `\\${ch}` : ch;
    index += 1;
  }
  return new RegExp(`${out}$`, "u");
}

async function collectSourceFiles(
  root: string,
  includePatterns: readonly string[],
  excludePatterns: readonly string[],
): Promise<readonly string[]> {
  const includes = includePatterns.map(globToRegExp);
  const excludes = excludePatterns.map(globToRegExp);
  const found: string[] = [];
  const stack: string[] = [""];
  const visitedDirs = new Set<string>();
  const rootRealPath = await realpath(root);
  while (stack.length > 0) {
    const relDir = stack.pop();
    if (relDir === undefined) break;
    const absDir = join(root, relDir);
    try {
      const realDir = await realpath(absDir);
      const fromRoot = relative(rootRealPath, realDir);
      if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) continue;
      if (visitedDirs.has(realDir)) continue;
      visitedDirs.add(realDir);
    } catch {
      continue;
    }
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          const realTarget = await realpath(join(root, relPath));
          const fromRoot = relative(rootRealPath, realTarget);
          if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) continue;
          const target = await stat(realTarget);
          isDirectory = target.isDirectory();
          isFile = target.isFile();
        } catch {
          continue;
        }
      }
      if (isDirectory) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(relPath);
        continue;
      }
      if (!isFile) continue;
      if (CONFIG_SKIP_FILES.has(entry.name)) continue;
      if (!includes.some((re) => re.test(relPath))) continue;
      if (excludes.some((re) => re.test(relPath))) continue;
      found.push(relPath);
    }
  }
  return found.sort();
}

export async function computeWorkspaceFileHashes(
  root: string,
  includePatterns: readonly string[] = DEFAULT_INCLUDE_PATTERNS,
  excludePatterns: readonly string[] = [],
): Promise<ReadonlyMap<string, string>> {
  const files = await collectSourceFiles(root, includePatterns, excludePatterns);
  const hashes = new Map<string, string>();
  for (const file of files) {
    try {
      hashes.set(file, sha256(await readFile(join(root, file))));
    } catch {
      // A disappearing file is represented by its absence and invalidates freshness.
    }
  }
  return hashes;
}

export function isGraphFresh(
  graph: AtlasGraph,
  currentHashes: ReadonlyMap<string, string>,
): { readonly fresh: boolean; readonly changed: readonly string[]; readonly added: readonly string[]; readonly removed: readonly string[] } {
  const previous = new Map(graph.files.map((file) => [file.path, file.contentHash]));
  const changed = [...currentHashes].filter(([path, hash]) => previous.has(path) && previous.get(path) !== hash).map(([path]) => path);
  const added = [...currentHashes.keys()].filter((path) => !previous.has(path));
  const removed = [...previous.keys()].filter((path) => !currentHashes.has(path));
  return { fresh: changed.length === 0 && added.length === 0 && removed.length === 0, changed, added, removed };
}

// ─── Extraction Helpers ──────────────────────────────────────────────────────

interface FileExtraction {
  readonly nodes: AtlasNode[];
  readonly imports: string[];
  readonly reexports: string[];
  readonly javaPackage?: string;
  readonly phpNamespace?: string;
  readonly relationships?: readonly {
    readonly from: string;
    readonly target: string;
    readonly type: "extends" | "implements" | "calls" | "style-use";
  }[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function relationshipArray(value: unknown): NonNullable<FileExtraction["relationships"]> {
  if (!Array.isArray(value)) return [];
  const types = new Set(["extends", "implements", "calls", "style-use"]);
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    if (typeof row["from"] !== "string" || typeof row["target"] !== "string" || typeof row["type"] !== "string" || !types.has(row["type"])) return [];
    return [{ from: row["from"], target: row["target"], type: row["type"] as "extends" | "implements" | "calls" | "style-use" }];
  });
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  visit(node);
  for (const child of named(node)) walk(child, visit);
}

function callTarget(node: SyntaxNode): string | undefined {
  if (!["call_expression", "function_call_expression", "member_call_expression", "scoped_call_expression"].includes(node.type)) return undefined;
  const target = node.childForFieldName("function") ?? node.childForFieldName("name");
  if (target === null) return undefined;
  const text = target.text.replace(/^.*(?:\.|::|->)/u, "");
  return /^[A-Za-z_$][\w$]*$/u.test(text) ? text : undefined;
}

function callRelationships(rootNode: SyntaxNode, nodes: readonly AtlasNode[]): NonNullable<FileExtraction["relationships"]> {
  const relationships: NonNullable<FileExtraction["relationships"]>[number][] = [];
  walk(rootNode, (candidate) => {
    const target = callTarget(candidate);
    if (target === undefined) return;
    const line = candidate.startPosition.row + 1;
    const owner = nodes
      .filter((node) => node.kind !== "module" && node.line <= line && (node.endLine ?? node.line) >= line)
      .sort((a, b) => ((a.endLine ?? a.line) - a.line) - ((b.endLine ?? b.line) - b.line))[0];
    if (owner !== undefined && owner.name !== target) relationships.push({ from: owner.id, target, type: "calls" });
  });
  return relationships;
}

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function fieldText(node: SyntaxNode, field: string): string | undefined {
  const child = node.childForFieldName(field);
  return child?.text;
}

function membersFromClause(node: SyntaxNode, clauseType: string): string[] {
  const clause = named(node).find((child) => child.type === clauseType);
  if (clause === undefined) return [];
  return named(clause)
    .filter((child) => ["name", "qualified_name", "relative_name"].includes(child.type))
    .map((child) => child.text.replace(/^\\/u, ""));
}

function collapse(text: string, max = 200): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)} …` : flat;
}

function signatureOf(node: SyntaxNode): string {
  const body = node.childForFieldName("body");
  const end = body !== null ? body.startIndex : node.endIndex;
  return collapse(node.text.slice(0, Math.max(0, end - node.startIndex)));
}

function stripQuotes(text: string): string {
  return text.replace(/^["'`]/u, "").replace(/["'`]$/u, "");
}

// ─── Config Extraction (json / yml / yaml) ───────────────────────────────────

type ConfigFormat = "json" | "yaml";

function configFormatFor(filePath: string): ConfigFormat | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  return undefined;
}

/** Naive JSONC support (tsconfig-style comments); JSON.parse is tried first. */
function stripJsonComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/,\s*([}\]])/gu, "$1");
}

/** Parses a config source into one value per document (YAML can be multi-doc). */
function parseConfigDocuments(source: string, format: ConfigFormat): unknown[] | undefined {
  if (format === "json") {
    try {
      return [JSON.parse(source)];
    } catch {
      try {
        return [JSON.parse(stripJsonComments(source))];
      } catch {
        return undefined;
      }
    }
  }
  try {
    const documents = parseAllDocuments(source);
    if (documents.length === 0) return undefined;
    if (documents.some((document) => document.errors.length > 0)) return undefined;
    return documents.map((document) => document.toJS() as unknown);
  } catch {
    return undefined;
  }
}

function topLevelKeysOf(documents: readonly unknown[]): string[] {
  const keys: string[] = [];
  for (const value of documents) {
    if (Array.isArray(value)) {
      keys.push(`[${value.length} items]`);
      continue;
    }
    if (value !== null && typeof value === "object") {
      keys.push(...Object.keys(value));
    }
  }
  return [...new Set(keys)].slice(0, 60);
}

const CONFIG_SKELETON_MAX_LINES = 150;
const CONFIG_SKELETON_MAX_DEPTH = 3;

function renderConfigValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") return "{…}";
  const raw = typeof value === "string" ? JSON.stringify(value) : String(value);
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
}

function renderConfigTree(value: unknown, depth: number, indent: string, lines: string[]): void {
  if (lines.length >= CONFIG_SKELETON_MAX_LINES) return;
  if (Array.isArray(value)) {
    lines.push(`${indent}[${value.length} items]`);
    return;
  }
  if (value === null || typeof value !== "object") {
    lines.push(`${indent}${renderConfigValue(value)}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (lines.length >= CONFIG_SKELETON_MAX_LINES) return;
    const isBranch = child !== null && typeof child === "object" && !Array.isArray(child);
    if (isBranch && depth < CONFIG_SKELETON_MAX_DEPTH) {
      lines.push(`${indent}${key}:`);
      renderConfigTree(child, depth + 1, `${indent}  `, lines);
    } else {
      lines.push(`${indent}${key}: ${renderConfigValue(child)}`);
    }
  }
}

/** Deterministic key-structure skeleton for JSON/YAML configs (values truncated). */
export function extractConfigSkeleton(source: string, filePath: string): string {
  const format = configFormatFor(filePath);
  if (format === undefined) return "";
  const documents = parseConfigDocuments(source, format);
  if (documents === undefined) return "";
  const lines: string[] = [];
  documents.forEach((document, index) => {
    if (index > 0) lines.push("---");
    renderConfigTree(document, 0, "", lines);
  });
  if (lines.length >= CONFIG_SKELETON_MAX_LINES) {
    lines.push("… (truncated)");
  }
  return lines.join("\n");
}

// ─── Atlas Indexer ───────────────────────────────────────────────────────────

export class AtlasIndexer {
  async indexWorkspace(root: string, options?: {
    includePatterns?: readonly string[];
    excludePatterns?: readonly string[];
    previous?: AtlasGraph;
  }): Promise<AtlasGraph> {
    const startTime = Date.now();
    const includePatterns = options?.includePatterns ?? DEFAULT_INCLUDE_PATTERNS;
    const excludePatterns = options?.excludePatterns ?? [];
    const files = await collectSourceFiles(root, includePatterns, excludePatterns);
    const resolver = await buildResolverContext(files, async (file) => {
      try {
        return await readFile(join(root, file), "utf8");
      } catch {
        return undefined;
      }
    });

    const nodes: AtlasNode[] = [];
    const edges: AtlasEdge[] = [];
    const fileNodeMap = new Map<string, string[]>();
    const extractionByFile = new Map<string, FileExtraction>();
    const javaClassMap = new Map<string, string>();
    const fileRecords: AtlasFileRecord[] = [];
    const parseErrors: AtlasCoverage["parseErrors"][number][] = [];
    const unresolvedImports: AtlasCoverage["unresolvedImports"][number][] = [];
    const sourceFiles: ExtractorFile[] = [];
    const previousFiles = new Map(options?.previous?.files.map((file) => [file.path, file]) ?? []);
    const previousNodes = new Map(options?.previous?.nodes.map((node) => [node.id, node]) ?? []);

    // First pass: parse each file once and extract nodes + import specifiers
    for (const filePath of files) {
      let fileContent: string;
      try {
        fileContent = await readFile(join(root, filePath), "utf8");
      } catch {
        parseErrors.push({ path: filePath, line: 1, message: "File could not be read" });
        continue;
      }
      const contentHash = sha256(fileContent);
      sourceFiles.push({ path: filePath, content: fileContent });
      const previousFile = previousFiles.get(filePath);
      if (previousFile?.contentHash === contentHash) {
        const reused = previousFile.nodeIds
          .map((id) => previousNodes.get(id))
          .filter((node): node is AtlasNode => node !== undefined)
          .map((node) => ({ ...node, dependencies: [], dependents: [] }));
        if (reused.length === previousFile.nodeIds.length) {
          nodes.push(...reused);
          fileNodeMap.set(filePath, reused.map((node) => node.id));
          fileRecords.push(previousFile);
          const module = reused.find((node) => node.kind === "module");
          if (module !== undefined && previousFile.parseStatus !== "unsupported") {
            const importSpecifiers = stringArray(module.metadata["importSpecifiers"] ?? module.imports);
            const reexportSpecifiers = stringArray(module.metadata["reexportSpecifiers"]);
            const relationships = relationshipArray(module.metadata["relationships"]);
            const javaPackage = typeof module.metadata["package"] === "string" ? module.metadata["package"] : undefined;
            const phpNamespace = typeof module.metadata["namespace"] === "string" ? module.metadata["namespace"] : undefined;
            extractionByFile.set(filePath, {
              nodes: reused,
              imports: importSpecifiers,
              reexports: reexportSpecifiers,
              ...(javaPackage === undefined ? {} : { javaPackage }),
              ...(phpNamespace === undefined ? {} : { phpNamespace }),
              ...(relationships.length === 0 ? {} : { relationships }),
            });
            if (javaPackage !== undefined) {
              for (const node of reused) if (node.kind !== "module") javaClassMap.set(`${javaPackage}.${node.name}`, filePath);
            }
          }
          continue;
        }
      }
      const configFormat = configFormatFor(filePath);
      if (configFormat !== undefined) {
        const node = await this.extractConfigNode(root, filePath, configFormat);
        if (node !== undefined) {
          nodes.push(node);
          fileNodeMap.set(filePath, [node.id]);
        }
        const configError = node?.metadata["parseError"] === true;
        if (configError) parseErrors.push({ path: filePath, line: 1, message: "Configuration parse failed" });
        fileRecords.push({
          path: filePath,
          contentHash,
          language: configFormat,
          parseStatus: configError ? "error" : "ok",
          nodeIds: node === undefined ? [] : [node.id],
        });
        continue;
      }
      const language = languageForFile(filePath);
      if (fileContent.length > SOURCE_MAX_BYTES) {
        const endLine = fileContent.split(/\r?\n/u).length;
        parseErrors.push({ path: filePath, line: 1, message: `Source exceeds ${String(SOURCE_MAX_BYTES)} bytes` });
        fileRecords.push({ path: filePath, contentHash, language, parseStatus: "error", nodeIds: [], errorRanges: [[1, endLine]] });
        continue;
      }
      if (language === "scss" || language === "astro") {
        const extraction = language === "scss" ? this.extractStyles(fileContent, filePath) : this.extractAstro(fileContent, filePath);
        nodes.push(...extraction.nodes);
        fileNodeMap.set(filePath, extraction.nodes.map((node) => node.id));
        extractionByFile.set(filePath, extraction);
        fileRecords.push({ path: filePath, contentHash, language, parseStatus: "partial", nodeIds: extraction.nodes.map((node) => node.id) });
        continue;
      }
      const kind = langForFile(filePath);
      if (kind === undefined) {
        fileRecords.push({ path: filePath, contentHash, language: "unsupported", parseStatus: "unsupported", nodeIds: [] });
        continue;
      }
      const syntax = await validateAstSyntax(fileContent, filePath);
      if (!syntax.ok) parseErrors.push({ path: filePath, line: syntax.line, message: syntax.error });
      const extraction = await withParsedRoot(fileContent, kind, (rootNode) => {
        if (kind === "java") return this.extractJava(rootNode, filePath);
        if (kind === "php") return this.extractPhp(rootNode, filePath);
        if (kind === "css") return this.extractStyles(fileContent, filePath);
        return this.extractTypeScript(rootNode, filePath, kind === "javascript");
      });
      if (extraction === undefined) {
        fileRecords.push({ path: filePath, contentHash, language, parseStatus: "error", nodeIds: [], errorRanges: [[1, 1]] });
        continue;
      }
      nodes.push(...extraction.nodes);
      fileNodeMap.set(filePath, extraction.nodes.map((n) => n.id));
      fileRecords.push({
        path: filePath,
        contentHash,
        language,
        parseStatus: syntax.ok ? "ok" : "partial",
        nodeIds: extraction.nodes.map((node) => node.id),
        ...(syntax.ok ? {} : { errorRanges: [[syntax.line, syntax.line] as [number, number]] }),
      });
      extractionByFile.set(filePath, extraction);
      if (extraction.javaPackage !== undefined) {
        for (const node of extraction.nodes) {
          if (node.kind !== "module") {
            javaClassMap.set(`${extraction.javaPackage}.${node.name}`, filePath);
          }
        }
      }
    }

    // Second pass: resolve import/export edges against the indexed file set
    const moduleByFile = new Map(nodes.filter((node) => node.kind === "module").map((node) => [node.filePath, node]));
    const symbolMap = new Map<string, AtlasNode[]>();
    for (const node of nodes) {
      symbolMap.set(node.name, [...(symbolMap.get(node.name) ?? []), node]);
      const module = moduleByFile.get(node.filePath);
      const namespace = module?.metadata["namespace"];
      if (typeof namespace === "string" && node.kind !== "module") symbolMap.set(`${namespace}\\${node.name}`, [...(symbolMap.get(`${namespace}\\${node.name}`) ?? []), node]);
    }
    for (const [filePath, extraction] of extractionByFile) {
      const fromId = this.nodeId(filePath, "module", 0, 0);
      for (const specifier of extraction.imports) {
        const target = this.resolveSpecifier(specifier, filePath, fileNodeMap, javaClassMap, resolver);
        if (target === undefined) {
          unresolvedImports.push({ from: filePath, specifier });
          continue;
        }
        for (const targetNodeId of fileNodeMap.get(target) ?? []) {
          edges.push({ from: fromId, to: targetNodeId, type: /\.(?:css|scss)$/u.test(filePath) ? "style-use" : "import" });
        }
      }
      for (const specifier of extraction.reexports) {
        const target = this.resolveSpecifier(specifier, filePath, fileNodeMap, javaClassMap, resolver);
        if (target === undefined) {
          unresolvedImports.push({ from: filePath, specifier });
          continue;
        }
        for (const targetNodeId of fileNodeMap.get(target) ?? []) {
          edges.push({ from: fromId, to: targetNodeId, type: "export" });
        }
      }
      for (const relationship of extraction.relationships ?? []) {
        const candidates = symbolMap.get(relationship.target.replace(/^\\/u, "")) ?? symbolMap.get(relationship.target.split("\\").pop() ?? relationship.target) ?? [];
        const target = candidates.find((candidate) => candidate.id !== relationship.from);
        if (target !== undefined) edges.push({ from: relationship.from, to: target.id, type: relationship.type });
      }
    }

    const provisionalCoverage: AtlasCoverage = {
      indexerVersion: "2.2.0",
      supportedLanguages: ["typescript", "tsx", "javascript", "jsx", "php", "java", "css", "scss (partial)", "astro (partial)", "json", "yaml"],
      unsupportedFiles: fileRecords.filter((file) => file.parseStatus === "unsupported").map((file) => file.path),
      parseErrors,
      unresolvedImports,
      ...(fileRecords.some((file) => file.language === "php") ? { semantic: "syntactic-only" as const } : {}),
    };
    const provisionalGraph: AtlasGraph = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      workspaceRoot: root,
      nodes,
      edges,
      files: fileRecords,
      coverage: provisionalCoverage,
      stats: { totalFiles: files.length, totalNodes: nodes.length, totalEdges: edges.length, indexDurationMs: 1 },
    };
    const extracted = runExtractors(provisionalGraph, sourceFiles);
    const nodeIds = new Set(nodes.map((node) => node.id));
    for (const node of extracted.nodes) {
      if (!nodeIds.has(node.id)) {
        nodes.push(node);
        nodeIds.add(node.id);
      }
    }
    edges.push(...extracted.edges);
    const contractGraph: AtlasGraph = { ...provisionalGraph, nodes, edges, contracts: extracted.contracts };
    const crossRepo = matchCrossRepoContracts(contractGraph, sourceFiles, extracted.contracts);
    edges.push(...crossRepo.edges);
    const uniqueEdges = [...new Map(edges.map((edge) => [`${edge.from}:${edge.to}:${edge.type}`, edge])).values()];

    // Build dependency maps
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of uniqueEdges) {
      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      if (fromNode && toNode) {
        (fromNode.dependencies as string[]).push(edge.to);
        (toNode.dependents as string[]).push(edge.from);
      }
    }

    const gitStamp = computeGitStamp(root);
    const base = {
      schemaVersion: 2 as const,
      generatedAt: new Date().toISOString(),
      workspaceRoot: root,
      nodes,
      edges: uniqueEdges,
      files: fileRecords,
      coverage: {
        ...provisionalCoverage,
        ...(extracted.errors.length === 0 ? {} : { extractorErrors: extracted.errors }),
      },
      contracts: crossRepo.contracts,
      stats: {
        totalFiles: files.length,
        totalNodes: nodes.length,
        totalEdges: uniqueEdges.length,
        indexDurationMs: Math.max(1, Date.now() - startTime),
      },
    };
    return gitStamp === undefined ? base : { ...base, gitStamp };
  }

  // ── Configuration (json / yml / yaml) ───────────────────────────────────────

  private async extractConfigNode(root: string, filePath: string, format: ConfigFormat): Promise<AtlasNode | undefined> {
    let source: string;
    try {
      source = await readFile(join(root, filePath), "utf8");
    } catch {
      return undefined;
    }
    const base = {
      id: this.nodeId(filePath, "module", 0, 0),
      name: filePath.split("/").pop() ?? filePath,
      kind: "module" as const,
      filePath,
      line: 0,
      column: 0,
      exports: [],
      imports: [],
      dependencies: [],
      dependents: [],
    };
    if (source.length > CONFIG_MAX_BYTES) {
      return { ...base, metadata: { configFormat: format, tooLarge: true, bytes: source.length } };
    }
    const documents = parseConfigDocuments(source, format);
    if (documents === undefined) {
      return { ...base, metadata: { configFormat: format, parseError: true } };
    }
    return {
      ...base,
      metadata: {
        configFormat: format,
        documents: documents.length,
        topLevelKeys: topLevelKeysOf(documents),
      },
    };
  }

  // ── TypeScript / TSX ────────────────────────────────────────────────────────

  private extractTypeScript(rootNode: SyntaxNode, filePath: string, javascript = false): FileExtraction {
    const nodes: AtlasNode[] = [];
    const imports: string[] = [];
    const reexports: string[] = [];

    for (const child of named(rootNode)) {
      if (child.type === "import_statement") {
        const source = child.childForFieldName("source");
        if (source !== null) imports.push(stripQuotes(source.text));
        continue;
      }
      if (child.type === "export_statement") {
        const source = child.childForFieldName("source");
        if (source !== null) {
          reexports.push(stripQuotes(source.text));
          continue;
        }
        for (const inner of named(child)) {
          this.extractTsDeclaration(inner, filePath, true, nodes);
        }
        continue;
      }
      this.extractTsDeclaration(child, filePath, false, nodes);
    }

    if (javascript) {
      walk(rootNode, (candidate) => {
        if (candidate.type !== "call_expression") return;
        const fn = candidate.childForFieldName("function");
        if (fn?.text !== "require") return;
        const argument = candidate.childForFieldName("arguments")?.namedChild(0);
        if (argument?.type === "string") imports.push(stripQuotes(argument.text));
      });
    }

    const relationships = [...callRelationships(rootNode, nodes)];

    nodes.unshift({
      id: this.nodeId(filePath, "module", 0, 0),
      name: filePath.split("/").pop() ?? filePath,
      kind: "module",
      filePath,
      line: 0,
      column: 0,
      exports: [],
      imports: [...imports, ...reexports],
      dependencies: [],
      dependents: [],
      metadata: {
        extension: filePath.split(".").pop(),
        importSpecifiers: imports,
        reexportSpecifiers: reexports,
        relationships,
      },
    });

    return { nodes, imports: [...new Set(imports)], reexports: [...new Set(reexports)], relationships };
  }

  private extractTsDeclaration(node: SyntaxNode, filePath: string, isExported: boolean, out: AtlasNode[]): void {
    const line = node.startPosition.row + 1;
    const col = node.startPosition.column;

    if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
      const name = fieldText(node, "name") ?? "anonymous";
      const params = node.childForFieldName("parameters");
      out.push({
        id: this.nodeId(filePath, "function", line, col),
        name,
        kind: this.detectKind(name, "function"),
        filePath,
        line,
        endLine: node.endPosition.row + 1,
        column: col,
        exports: isExported ? [name] : [],
        imports: [],
        dependencies: [],
        dependents: [],
        signature: signatureOf(node),
        metadata: {
          isAsync: node.children.some((c) => c?.type === "async"),
          params: params !== null ? named(params).length : 0,
          isExported,
        },
      });
      return;
    }

    if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
      const name = fieldText(node, "name") ?? "anonymous";
      const body = node.childForFieldName("body");
      const members = body !== null ? named(body) : [];
      out.push({
        id: this.nodeId(filePath, "class", line, col),
        name,
        kind: "class",
        filePath,
        line,
        endLine: node.endPosition.row + 1,
        column: col,
        exports: isExported ? [name] : [],
        imports: [],
        dependencies: [],
        dependents: [],
        signature: signatureOf(node),
        metadata: {
          isExported,
          methods: members.filter((m) => m.type === "method_definition").length,
          properties: members.filter((m) => m.type === "public_field_definition").length,
        },
      });
      return;
    }

    if (node.type === "interface_declaration") {
      const name = fieldText(node, "name") ?? "anonymous";
      const body = node.childForFieldName("body");
      out.push({
        id: this.nodeId(filePath, "interface", line, col),
        name,
        kind: "interface",
        filePath,
        line,
        endLine: node.endPosition.row + 1,
        column: col,
        exports: isExported ? [name] : [],
        imports: [],
        dependencies: [],
        dependents: [],
        signature: signatureOf(node),
        metadata: {
          isExported,
          members: body !== null ? named(body).length : 0,
        },
      });
      return;
    }

    if (node.type === "type_alias_declaration" || node.type === "enum_declaration") {
      const name = fieldText(node, "name") ?? "anonymous";
      out.push({
        id: this.nodeId(filePath, "type", line, col),
        name,
        kind: "type",
        filePath,
        line,
        endLine: node.endPosition.row + 1,
        column: col,
        exports: isExported ? [name] : [],
        imports: [],
        dependencies: [],
        dependents: [],
        signature: signatureOf(node),
        metadata: { isExported },
      });
      return;
    }

    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      const isConst = node.children.some((c) => c?.type === "const");
      for (const declarator of named(node).filter((c) => c.type === "variable_declarator")) {
        const name = fieldText(declarator, "name") ?? "anonymous";
        const dLine = declarator.startPosition.row + 1;
        const dCol = declarator.startPosition.column;
        const kind = this.detectKind(name, "variable");
        out.push({
          id: this.nodeId(filePath, kind, dLine, dCol),
          name,
          kind,
          filePath,
          line: dLine,
          endLine: declarator.endPosition.row + 1,
          column: dCol,
          exports: isExported ? [name] : [],
          imports: [],
          dependencies: [],
          dependents: [],
          signature: collapse(declarator.text, 160),
          metadata: { isExported, isConst },
        });
      }
    }
  }

  // ── PHP ─────────────────────────────────────────────────────────────────────

  private extractPhp(rootNode: SyntaxNode, filePath: string): FileExtraction {
    const nodes: AtlasNode[] = [];
    const imports: string[] = [];
    let phpNamespace: string | undefined;

    walk(rootNode, (node) => {
      if (node.type === "namespace_definition" && phpNamespace === undefined) {
        phpNamespace = fieldText(node, "name")?.replace(/^\\/u, "");
      }
      if (node.type === "namespace_use_clause") {
        const imported = named(node).find((child) => child.type === "qualified_name" || child.type === "name")?.text;
        if (imported !== undefined) imports.push(imported.replace(/^\\/u, ""));
      }
    });

    const declarations: SyntaxNode[] = [];
    walk(rootNode, (node) => {
      if (["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration", "function_definition"].includes(node.type)) declarations.push(node);
    });
    for (const declaration of declarations) {
      if (declaration.type === "function_definition") {
        const name = fieldText(declaration, "name") ?? "anonymous";
        const line = declaration.startPosition.row + 1;
        nodes.push({
          id: this.nodeId(filePath, "function", line, declaration.startPosition.column), name, kind: "function", filePath,
          line, endLine: declaration.endPosition.row + 1, column: declaration.startPosition.column, exports: [name], imports: [],
          dependencies: [], dependents: [], signature: signatureOf(declaration), metadata: { namespace: phpNamespace },
        });
        continue;
      }
      this.extractPhpType(declaration, filePath, phpNamespace, nodes);
    }
    const relationships = [...callRelationships(rootNode, nodes)];
    for (const node of nodes.filter((candidate) => candidate.kind === "class" || candidate.kind === "service" || candidate.kind === "interface" || candidate.kind === "type")) {
      for (const target of stringArray(node.metadata["extends"])) relationships.push({ from: node.id, target, type: "extends" });
      for (const target of stringArray(node.metadata["implements"])) relationships.push({ from: node.id, target, type: "implements" });
    }
    nodes.unshift({
      id: this.nodeId(filePath, "module", 0, 0), name: filePath.split("/").pop() ?? filePath, kind: "module", filePath,
      line: 0, column: 0, exports: [], imports, dependencies: [], dependents: [],
      metadata: { extension: "php", namespace: phpNamespace, importSpecifiers: imports, reexportSpecifiers: [], relationships },
    });
    return {
      nodes,
      imports: [...new Set(imports)],
      reexports: [],
      relationships,
      ...(phpNamespace === undefined ? {} : { phpNamespace }),
    };
  }

  private extractPhpType(node: SyntaxNode, filePath: string, namespace: string | undefined, out: AtlasNode[]): void {
    const name = fieldText(node, "name") ?? "anonymous";
    const line = node.startPosition.row + 1;
    const column = node.startPosition.column;
    const declarationKind: AtlasNode["kind"] = node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "type" : name.endsWith("Service") ? "service" : "class";
    const body = node.childForFieldName("body");
    const members = body === null ? [] : named(body);
    const base = membersFromClause(node, "base_clause");
    const implements_ = membersFromClause(node, "class_interface_clause");
    const attributes = named(node).filter((child) => child.type === "attribute_list").map((child) => collapse(child.text, 200));
    out.push({
      id: this.nodeId(filePath, declarationKind, line, column), name, kind: declarationKind, filePath, line,
      endLine: node.endPosition.row + 1, column, exports: [name], imports: [], dependencies: [], dependents: [],
      signature: signatureOf(node),
      metadata: {
        namespace,
        declarationType: node.type,
        methods: members.filter((member) => member.type === "method_declaration").length,
        attributes,
        extends: base,
        implements: implements_,
      },
    });
    for (const method of members.filter((member) => member.type === "method_declaration")) {
      const methodName = fieldText(method, "name") ?? "anonymous";
      const methodLine = method.startPosition.row + 1;
      const methodColumn = method.startPosition.column;
      out.push({
        id: this.nodeId(filePath, "function", methodLine, methodColumn), name: methodName, kind: "function", filePath,
        line: methodLine, endLine: method.endPosition.row + 1, column: methodColumn,
        exports: method.text.includes("public ") ? [methodName] : [], imports: [], dependencies: [], dependents: [],
        signature: signatureOf(method), metadata: { parent: name, namespace, attributes: named(method).filter((child) => child.type === "attribute_list").map((child) => collapse(child.text, 200)) },
      });
    }
  }

  // ── Styles and Astro (honest partial extraction) ────────────────────────────

  private extractStyles(source: string, filePath: string): FileExtraction {
    const imports = [...source.matchAll(/@(use|import|forward)\s+["']([^"']+)["']/gu)].map((match) => match[2]).filter((value): value is string => value !== undefined);
    const nodes: AtlasNode[] = [{
      id: this.nodeId(filePath, "module", 0, 0), name: filePath.split("/").pop() ?? filePath, kind: "module", filePath,
      line: 0, column: 0, exports: [], imports, dependencies: [], dependents: [],
      metadata: { extension: filePath.split(".").pop(), importSpecifiers: imports, reexportSpecifiers: [] },
    }];
    for (const match of source.matchAll(/^\s*\$([\w-]+)\s*:/gmu)) {
      const name = match[1];
      if (name === undefined || match.index === undefined) continue;
      const line = source.slice(0, match.index).split("\n").length;
      nodes.push({ id: this.nodeId(filePath, "token", line, 0), name, kind: "token", filePath, line, column: 0, exports: [name], imports: [], dependencies: [], dependents: [], signature: `$${name}`, metadata: { style: "variable" } });
    }
    for (const match of source.matchAll(/@mixin\s+([\w-]+)/gu)) {
      const name = match[1];
      if (name === undefined || match.index === undefined) continue;
      const line = source.slice(0, match.index).split("\n").length;
      nodes.push({ id: this.nodeId(filePath, "function", line, 0), name, kind: "function", filePath, line, column: 0, exports: [name], imports: [], dependencies: [], dependents: [], signature: `@mixin ${name}`, metadata: { style: "mixin" } });
    }
    return { nodes, imports, reexports: [] };
  }

  private extractAstro(source: string, filePath: string): FileExtraction {
    const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(source)?.[1] ?? "";
    const imports = [...frontmatter.matchAll(/(?:import|export)\s+[\s\S]*?\sfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]).filter((value): value is string => value !== undefined);
    const components = [...new Set([...source.matchAll(/<([A-Z][\w.]*)\b/gu)].map((match) => match[1]).filter((value): value is string => value !== undefined))];
    const nodes: AtlasNode[] = [{
      id: this.nodeId(filePath, "module", 0, 0), name: filePath.split("/").pop() ?? filePath, kind: "module", filePath,
      line: 0, column: 0, exports: [], imports, dependencies: [], dependents: [], metadata: { extension: "astro", importSpecifiers: imports, reexportSpecifiers: [], partial: true },
    }];
    for (const name of components) {
      const index = source.indexOf(`<${name}`);
      const line = source.slice(0, Math.max(0, index)).split("\n").length;
      nodes.push({ id: this.nodeId(filePath, "component", line, 0), name, kind: "component", filePath, line, column: 0, exports: [], imports: [], dependencies: [], dependents: [], signature: `<${name}>`, metadata: { usage: true } });
    }
    return { nodes, imports, reexports: [] };
  }

  // ── Java ────────────────────────────────────────────────────────────────────

  private extractJava(rootNode: SyntaxNode, filePath: string): FileExtraction {
    const nodes: AtlasNode[] = [];
    const imports: string[] = [];
    let javaPackage: string | undefined;

    for (const child of named(rootNode)) {
      if (child.type === "package_declaration") {
        javaPackage = named(child).find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
        continue;
      }
      if (child.type === "import_declaration") {
        const spec = named(child).find((c) => c.type === "scoped_identifier" || c.type === "identifier")?.text;
        if (spec !== undefined) imports.push(spec);
        continue;
      }
      this.extractJavaType(child, filePath, nodes);
    }

    nodes.unshift({
      id: this.nodeId(filePath, "module", 0, 0),
      name: filePath.split("/").pop() ?? filePath,
      kind: "module",
      filePath,
      line: 0,
      column: 0,
      exports: [],
      imports,
      dependencies: [],
      dependents: [],
      metadata: { extension: "java", package: javaPackage, importSpecifiers: imports, reexportSpecifiers: [] },
    });

    const extraction: FileExtraction = javaPackage !== undefined
      ? { nodes, imports, reexports: [], javaPackage }
      : { nodes, imports, reexports: [] };
    return extraction;
  }

  private extractJavaType(node: SyntaxNode, filePath: string, out: AtlasNode[]): void {
    const kindByType: Record<string, AtlasNode["kind"]> = {
      class_declaration: "class",
      record_declaration: "class",
      interface_declaration: "interface",
      annotation_type_declaration: "interface",
      enum_declaration: "type",
    };
    const kind = kindByType[node.type];
    if (kind === undefined) return;

    const name = fieldText(node, "name") ?? "anonymous";
    const line = node.startPosition.row + 1;
    const col = node.startPosition.column;
    const modifiers = node.children.find((c) => c?.type === "modifiers")?.text ?? "";
    const isPublic = modifiers.includes("public");
    const body = node.childForFieldName("body");
    const members = body !== null ? named(body) : [];
    const methods = members.filter((m) => m.type === "method_declaration" || m.type === "constructor_declaration");

    out.push({
      id: this.nodeId(filePath, kind, line, col),
      name,
      kind: name.endsWith("Service") ? "service" : kind,
      filePath,
      line,
      endLine: node.endPosition.row + 1,
      column: col,
      exports: isPublic ? [name] : [],
      imports: [],
      dependencies: [],
      dependents: [],
      signature: signatureOf(node),
      metadata: {
        isExported: isPublic,
        methods: methods.length,
        properties: members.filter((m) => m.type === "field_declaration").length,
      },
    });

    for (const method of methods) {
      const methodName = fieldText(method, "name") ?? name;
      const mLine = method.startPosition.row + 1;
      const mCol = method.startPosition.column;
      const mModifiers = method.children.find((c) => c?.type === "modifiers")?.text ?? "";
      const params = method.childForFieldName("parameters");
      out.push({
        id: this.nodeId(filePath, "function", mLine, mCol),
        name: methodName,
        kind: "function",
        filePath,
        line: mLine,
        endLine: method.endPosition.row + 1,
        column: mCol,
        exports: mModifiers.includes("public") ? [methodName] : [],
        imports: [],
        dependencies: [],
        dependents: [],
        signature: signatureOf(method),
        metadata: { parent: name, params: params !== null ? named(params).length : 0 },
      });
    }

    // Nested types
    for (const member of members) {
      this.extractJavaType(member, filePath, out);
    }
  }

  // ── Shared ──────────────────────────────────────────────────────────────────

  private detectKind(name: string, defaultKind: string): AtlasNode["kind"] {
    if (/^use[A-Z]/u.test(name)) return "hook";
    if (/^[A-Z][A-Z0-9_]+$/u.test(name)) return "constant";
    if (/^[A-Z]/u.test(name)) return "component";
    if (name.endsWith("Service")) return "service";
    if (/^[a-z][a-zA-Z0-9]*$/u.test(name) && defaultKind === "variable") return "util";
    return defaultKind as AtlasNode["kind"];
  }

  private nodeId(filePath: string, kind: string, line: number, col: number): string {
    const content = `${filePath}:${kind}:${line}:${col}`;
    return createHash("sha256").update(content).digest("hex").slice(0, 16);
  }

  private resolveSpecifier(
    specifier: string,
    fromFile: string,
    fileNodeMap: Map<string, string[]>,
    javaClassMap: Map<string, string>,
    resolver: ResolverContext,
  ): string | undefined {
    // Java: fully-qualified import → package map, else path suffix match
    if (fromFile.endsWith(".java")) {
      const direct = javaClassMap.get(specifier);
      if (direct !== undefined) return direct;
      const suffix = `${specifier.split(".").join("/")}.java`;
      for (const candidate of fileNodeMap.keys()) {
        if (candidate.endsWith(suffix)) return candidate;
      }
      return undefined;
    }
    if (fromFile.endsWith(".php")) {
      const phpPath = resolvePhpClass(specifier, resolver);
      if (phpPath !== undefined && fileNodeMap.has(phpPath)) return phpPath;
      return undefined;
    }
    const relativeSpecifier = specifier.startsWith("./") || specifier.startsWith("../");
    const bases = relativeSpecifier
      ? [join(dirname(fromFile), specifier).split("\\").join("/")]
      : resolveJsSpecifier(specifier, fromFile, resolver);
    const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".php", ".css", ".scss", ".astro"];
    const candidates = bases.flatMap((base) => {
      const withoutRuntimeExtension = base.replace(/\.(?:js|jsx|mjs|cjs)$/u, "");
      const slash = withoutRuntimeExtension.lastIndexOf("/");
      const sassPartial = `${withoutRuntimeExtension.slice(0, slash + 1)}_${withoutRuntimeExtension.slice(slash + 1)}`;
      return [
        ...extensions.map((extension) => `${withoutRuntimeExtension}${extension}`),
        ...extensions.slice(1).map((extension) => `${withoutRuntimeExtension}/index${extension}`),
        `${sassPartial}.scss`,
      ];
    });
    for (const candidate of candidates) {
      if (fileNodeMap.has(candidate)) return candidate;
    }
    return undefined;
  }
}

// ─── Skeleton Extraction (token-cheap file context) ──────────────────────────

function memberSignature(member: SyntaxNode): string | undefined {
  const withBody = new Set([
    "method_definition", "method_declaration", "constructor_declaration",
    "class_declaration", "interface_declaration", "enum_declaration", "record_declaration",
  ]);
  const flat = new Set([
    "public_field_definition", "field_declaration", "property_signature",
    "method_signature", "enum_constant", "abstract_method_signature", "index_signature",
  ]);
  if (withBody.has(member.type)) {
    const body = member.childForFieldName("body");
    const sig = body !== null
      ? collapse(member.text.slice(0, Math.max(0, body.startIndex - member.startIndex)))
      : collapse(member.text, 160);
    return `${sig} { … }`;
  }
  if (flat.has(member.type)) return collapse(member.text, 160);
  return undefined;
}

export type SkeletonDepth = "signatures" | "signatures+calls";

function documentationTags(source: string): string[] {
  return [...source.matchAll(/@(param|return|throws|deprecated|template)\b[^\r\n*]*/gu)]
    .map((match) => `@${match[1] ?? "tag"}${match[0].slice((match[1]?.length ?? 0) + 1)}`.trim());
}

function partialSkeleton(source: string, fileName: string, depth: SkeletonDepth): string {
  if (fileName.endsWith(".astro")) {
    const frontmatter = /^---\s*\n([\s\S]*?)\n---/u.exec(source)?.[1] ?? "";
    const imports = frontmatter.split(/\r?\n/u).filter((line) => /^\s*(?:import|export)\b/u.test(line)).map((line) => collapse(line, 200));
    const components = [...new Set([...source.matchAll(/<([A-Z][\w.]*)\b/gu)].map((match) => match[1]).filter((value): value is string => value !== undefined))];
    return [...documentationTags(frontmatter), ...imports, ...components.map((name) => `<${name}>`)].join("\n");
  }
  const lines = source.split(/\r?\n/u).filter((line) => /^\s*(?:@(use|import|forward|mixin|function)\b|\$[\w-]+\s*:|[.#%][\w-]+(?:__[\w-]+)?(?:--[\w-]+)?\s*\{)/u.test(line)).map((line) => collapse(line, 200));
  if (depth === "signatures+calls") {
    const calls = [...new Set([...source.matchAll(/@include\s+([\w.-]+)/gu)].map((match) => match[1]).filter((value): value is string => value !== undefined))];
    if (calls.length > 0) lines.push(`calls: ${calls.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Deterministic skeleton: imports, documentation tags, attributes, top-level
 * and member signatures. Bodies are elided; optional call names retain a
 * cheap behavioral outline without copying executable source.
 */
export async function extractSkeleton(source: string, fileName: string, depth: SkeletonDepth = "signatures"): Promise<string> {
  if (configFormatFor(fileName) !== undefined) {
    return extractConfigSkeleton(source, fileName);
  }
  if (/\.(?:scss|astro)$/u.test(fileName)) return partialSkeleton(source, fileName, depth);
  const kind = langForFile(fileName);
  if (kind === undefined) return "";
  const skeleton = await withParsedRoot(source, kind, (rootNode) => {
    const lines: string[] = documentationTags(source);

  const emitDeclaration = (node: SyntaxNode): void => {
    const body = node.childForFieldName("body");
    if (body === null) {
      lines.push(collapse(node.text, 300));
      return;
    }
    lines.push(`${collapse(node.text.slice(0, Math.max(0, body.startIndex - node.startIndex)))} {`);
    for (const member of named(body)) {
      const sig = memberSignature(member);
      if (sig !== undefined) lines.push(`  ${sig}`);
    }
    lines.push("}");
  };

  const children = kind === "php"
    ? (() => {
      const declarations: SyntaxNode[] = [];
      walk(rootNode, (node) => {
        if (["namespace_definition", "namespace_use_declaration", "class_declaration", "interface_declaration", "trait_declaration", "enum_declaration", "function_definition"].includes(node.type)) declarations.push(node);
      });
      return declarations;
    })()
    : named(rootNode);

  for (const child of children) {
    if (child.type === "import_statement" || child.type === "import_declaration" || child.type === "package_declaration") {
      lines.push(collapse(child.text, 200));
      continue;
    }
    if (child.type === "namespace_use_declaration") {
      lines.push(collapse(child.text, 200));
      continue;
    }
    if (child.type === "namespace_definition") {
      const name = fieldText(child, "name");
      if (name !== undefined) lines.push(`namespace ${name};`);
      continue;
    }
    if (child.type === "export_statement") {
      const source_ = child.childForFieldName("source");
      if (source_ !== null) {
        lines.push(collapse(child.text, 200));
        continue;
      }
      for (const inner of named(child)) {
        if (inner.type === "lexical_declaration" || inner.type === "variable_declaration") {
          lines.push(`export ${collapse(inner.text, 160)}`);
        } else {
          const before = lines.length;
          emitDeclaration(inner);
          if (lines.length > before) {
            const first = lines[before];
            if (first !== undefined) lines[before] = `export ${first}`;
          }
        }
      }
      continue;
    }
    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      lines.push(collapse(child.text, 160));
      continue;
    }
    if (child.type.endsWith("_declaration") || child.type === "method_definition" || child.type === "function_definition") {
      emitDeclaration(child);
    }
  }

    if (depth === "signatures+calls") {
      const calls: string[] = [];
      walk(rootNode, (node) => {
        const target = callTarget(node);
        if (target !== undefined) calls.push(target);
      });
      const unique = [...new Set(calls)].sort();
      if (unique.length > 0) lines.push(`calls: ${unique.join(", ")}`);
    }

    return lines.join("\n");
  });
  return skeleton ?? "";
}

// ─── Atlas Cache ─────────────────────────────────────────────────────────────

const ATLAS_CACHE_FILE = "atlas-graph.json";
const GOVERNANCE_FILE = "governance.json";

export async function saveAtlasGraph(paths: MrPaths, workspaceId: string, graph: AtlasGraph): Promise<string> {
  const cacheDir = join(paths.cacheRoot, workspaceId);
  await mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, ATLAS_CACHE_FILE);
  await atomicWrite(cachePath, JSON.stringify(graph));
  return cachePath;
}

export async function loadAtlasGraph(paths: MrPaths, workspaceId: string): Promise<AtlasGraph | undefined> {
  const cachePath = join(paths.cacheRoot, workspaceId, ATLAS_CACHE_FILE);
  try {
    const content = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(content) as { schemaVersion?: unknown };
    return parsed.schemaVersion === 2 ? parsed as AtlasGraph : undefined;
  } catch {
    return undefined;
  }
}

export async function saveGovernanceConfig(paths: MrPaths, workspaceId: string, config: GovernanceConfig): Promise<string> {
  const configDir = join(paths.configRoot, "generated", workspaceId);
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, GOVERNANCE_FILE);
  await atomicWrite(configPath, canonicalJson(config));
  return configPath;
}

export async function loadGovernanceConfig(paths: MrPaths, workspaceId: string): Promise<GovernanceConfig | undefined> {
  const configPath = join(paths.configRoot, "generated", workspaceId, GOVERNANCE_FILE);
  try {
    const content = await readFile(configPath, "utf8");
    return JSON.parse(content) as GovernanceConfig;
  } catch {
    return undefined;
  }
}

// ─── Query Helpers ───────────────────────────────────────────────────────────

export function findNodeByName(graph: AtlasGraph, name: string): AtlasNode | undefined {
  return graph.nodes.find((n) => n.name === name);
}

export async function extractNodeSlice(
  root: string,
  node: AtlasNode,
  contextLines = 0,
): Promise<{ readonly file: string; readonly range: [number, number]; readonly text: string; readonly fileHash: string; readonly sliceHash: string }> {
  const source = await readFile(join(root, node.filePath), "utf8");
  const lines = source.split(/\r?\n/u);
  const start = Math.max(1, node.line - Math.max(0, contextLines));
  const end = Math.min(lines.length, (node.endLine ?? node.line) + Math.max(0, contextLines));
  const text = lines.slice(start - 1, end).join("\n");
  return { file: node.filePath, range: [start, end], text, fileHash: sha256(source), sliceHash: sha256(text) };
}

export function findTestsFor(graph: AtlasGraph, nodeId: string): readonly AtlasNode[] {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return [];
  const fileIds = new Set(graph.nodes.filter((candidate) => candidate.filePath === node.filePath).map((candidate) => candidate.id));
  const testFiles = new Set(
    graph.edges
      .filter((edge) => fileIds.has(edge.to))
      .map((edge) => graph.nodes.find((candidate) => candidate.id === edge.from)?.filePath)
      .filter((path): path is string => path !== undefined && (/(?:^|\/)__tests__\//u.test(path) || /\.(?:test|spec)\.[^.]+$/u.test(path))),
  );
  return graph.nodes.filter((candidate) => candidate.kind === "module" && testFiles.has(candidate.filePath));
}

export function findNodesByKind(graph: AtlasGraph, kind: AtlasNode["kind"]): readonly AtlasNode[] {
  return graph.nodes.filter((n) => n.kind === kind);
}

export function getNodeDependencies(graph: AtlasGraph, nodeId: string): readonly AtlasNode[] {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return [];
  return node.dependencies
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is AtlasNode => n !== undefined);
}

export function getNodeDependents(graph: AtlasGraph, nodeId: string): readonly AtlasNode[] {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node === undefined) return [];
  return node.dependents
    .map((id) => graph.nodes.find((n) => n.id === id))
    .filter((n): n is AtlasNode => n !== undefined);
}

export function getImpactAnalysis(graph: AtlasGraph, nodeId: string, depth = 2): readonly AtlasNode[] {
  const bestCost = new Map<string, number>();
  const result: AtlasNode[] = [];
  const maxCost = Math.max(0, depth) * 2;
  const strong = new Set<AtlasEdge["type"]>(["calls", "implements", "consumes"]);
  const queue: { id: string; cost: number }[] = [{ id: nodeId, cost: 0 }];

  while (queue.length > 0) {
    queue.sort((left, right) => left.cost - right.cost || left.id.localeCompare(right.id));
    const { id, cost } = queue.shift() as { id: string; cost: number };
    if (cost > maxCost || (bestCost.get(id) ?? Number.POSITIVE_INFINITY) <= cost) continue;
    bestCost.set(id, cost);

    const node = graph.nodes.find((n) => n.id === id);
    if (node === undefined) continue;
    result.push(node);

    for (const dependency of graph.edges.filter((edge) => edge.to === id)) {
      const edgeCost = strong.has(dependency.type) ? 1 : 2;
      queue.push({ id: dependency.from, cost: cost + edgeCost });
    }
  }

  return result;
}

/** Merge resolved semantic edges and rebuild dependency indexes immutably. */
export function withAtlasEdges(graph: AtlasGraph, additional: readonly AtlasEdge[]): AtlasGraph {
  const edges = [...new Map([...graph.edges, ...additional].map((edge) => [`${edge.from}:${edge.to}:${edge.type}`, edge])).values()];
  const dependencies = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  const dependents = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    dependencies.get(edge.from)?.add(edge.to);
    dependents.get(edge.to)?.add(edge.from);
  }
  const nodes = graph.nodes.map((node) => ({
    ...node,
    dependencies: [...(dependencies.get(node.id) ?? [])],
    dependents: [...(dependents.get(node.id) ?? [])],
  }));
  return { ...graph, nodes, edges, stats: { ...graph.stats, totalNodes: nodes.length, totalEdges: edges.length } };
}

export function checkGovernance(graph: AtlasGraph, config: GovernanceConfig, filePath: string): readonly GovernanceRule[] {
  const violations: GovernanceRule[] = [];
  for (const rule of config.rules) {
    if (rule.appliesTo.some((pattern) => filePath.includes(pattern))) {
      if (rule.action === "deny" && config.forbiddenPaths.some((p) => filePath.includes(p))) {
        violations.push(rule);
      }
    }
  }
  return violations;
}
