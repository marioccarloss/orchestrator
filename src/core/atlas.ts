import { Parser, Language, type Node as SyntaxNode } from "web-tree-sitter";
import { parseAllDocuments } from "yaml";
import { createHash } from "node:crypto";
import { writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./process.js";
import type { MrPaths } from "./paths.js";

// ─── Atlas Graph Types ───────────────────────────────────────────────────────

export interface AtlasNode {
  readonly id: string;
  readonly name: string;
  readonly kind: "component" | "hook" | "util" | "service" | "type" | "constant" | "function" | "class" | "interface" | "module";
  readonly filePath: string;
  readonly line: number;
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
  readonly type: "import" | "export" | "dependency" | "reference";
}

export interface AtlasGraph {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly workspaceRoot: string;
  readonly gitStamp?: string;
  readonly nodes: readonly AtlasNode[];
  readonly edges: readonly AtlasEdge[];
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

type LangKind = "typescript" | "tsx" | "java";

const WASM_SOURCES: Record<LangKind, { pkg: string; file: string }> = {
  typescript: { pkg: "tree-sitter-typescript", file: "tree-sitter-typescript.wasm" },
  tsx: { pkg: "tree-sitter-typescript", file: "tree-sitter-tsx.wasm" },
  java: { pkg: "tree-sitter-java", file: "tree-sitter-java.wasm" },
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
  if (filePath.endsWith(".java")) return "java";
  return undefined;
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

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", "target", ".next", ".turbo"]);

export const DEFAULT_INCLUDE_PATTERNS: readonly string[] = [
  // Single-repo layout: code
  "src/**/*.ts",
  "src/**/*.tsx",
  "src/**/*.java",
  // Single-repo layout: configuration
  "*.json",
  "*.yml",
  "*.yaml",
  "src/**/*.json",
  "src/**/*.yml",
  "src/**/*.yaml",
  // Nested workspaces may place sources under repositories/<project>/code[/<module>]/src/.
  "repos/**/src/**/*.ts",
  "repos/**/src/**/*.tsx",
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
];

/** Lockfiles and generated blobs: deliberately not indexed as configuration. */
const CONFIG_SKIP_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "composer.lock",
  "flake.lock",
]);

const CONFIG_MAX_BYTES = 2_000_000;

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
  while (stack.length > 0) {
    const relDir = stack.pop();
    if (relDir === undefined) break;
    let entries;
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (CONFIG_SKIP_FILES.has(entry.name)) continue;
      if (!includes.some((re) => re.test(relPath))) continue;
      if (excludes.some((re) => re.test(relPath))) continue;
      found.push(relPath);
    }
  }
  return found.sort();
}

// ─── Extraction Helpers ──────────────────────────────────────────────────────

interface FileExtraction {
  readonly nodes: AtlasNode[];
  readonly imports: string[];
  readonly reexports: string[];
  readonly javaPackage?: string;
}

function named(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((child): child is SyntaxNode => child !== null);
}

function fieldText(node: SyntaxNode, field: string): string | undefined {
  const child = node.childForFieldName(field);
  return child?.text;
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
  }): Promise<AtlasGraph> {
    const startTime = Date.now();
    const includePatterns = options?.includePatterns ?? DEFAULT_INCLUDE_PATTERNS;
    const excludePatterns = options?.excludePatterns ?? [];
    const files = await collectSourceFiles(root, includePatterns, excludePatterns);

    const nodes: AtlasNode[] = [];
    const edges: AtlasEdge[] = [];
    const fileNodeMap = new Map<string, string[]>();
    const extractionByFile = new Map<string, FileExtraction>();
    const javaClassMap = new Map<string, string>();

    // First pass: parse each file once and extract nodes + import specifiers
    for (const filePath of files) {
      const configFormat = configFormatFor(filePath);
      if (configFormat !== undefined) {
        const node = await this.extractConfigNode(root, filePath, configFormat);
        if (node !== undefined) {
          nodes.push(node);
          fileNodeMap.set(filePath, [node.id]);
        }
        continue;
      }
      const kind = langForFile(filePath);
      if (kind === undefined) continue;
      let source: string;
      try {
        source = await readFile(join(root, filePath), "utf8");
      } catch {
        continue;
      }
      const extraction = await withParsedRoot(source, kind, (rootNode) => kind === "java"
        ? this.extractJava(rootNode, filePath)
        : this.extractTypeScript(rootNode, filePath));
      if (extraction === undefined) continue;
      nodes.push(...extraction.nodes);
      fileNodeMap.set(filePath, extraction.nodes.map((n) => n.id));
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
    for (const [filePath, extraction] of extractionByFile) {
      const fromId = this.nodeId(filePath, "module", 0, 0);
      for (const specifier of extraction.imports) {
        const target = this.resolveSpecifier(specifier, filePath, fileNodeMap, javaClassMap);
        if (target === undefined) continue;
        for (const targetNodeId of fileNodeMap.get(target) ?? []) {
          edges.push({ from: fromId, to: targetNodeId, type: "import" });
        }
      }
      for (const specifier of extraction.reexports) {
        const target = this.resolveSpecifier(specifier, filePath, fileNodeMap, javaClassMap);
        if (target === undefined) continue;
        for (const targetNodeId of fileNodeMap.get(target) ?? []) {
          edges.push({ from: fromId, to: targetNodeId, type: "export" });
        }
      }
    }

    // Build dependency maps
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of edges) {
      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      if (fromNode && toNode) {
        (fromNode.dependencies as string[]).push(edge.to);
        (toNode.dependents as string[]).push(edge.from);
      }
    }

    const gitStamp = computeGitStamp(root);
    const base = {
      schemaVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      workspaceRoot: root,
      nodes,
      edges,
      stats: {
        totalFiles: files.length,
        totalNodes: nodes.length,
        totalEdges: edges.length,
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

  private extractTypeScript(rootNode: SyntaxNode, filePath: string): FileExtraction {
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
      metadata: { extension: filePath.split(".").pop() },
    });

    return { nodes, imports, reexports };
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
      metadata: { extension: "java", package: javaPackage },
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
    // TypeScript: relative specifiers only (external packages are out of workspace)
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
    const dir = dirname(fromFile);
    const base = join(dir, specifier).split("\\").join("/");
    const candidates = [
      base,
      base.replace(/\.jsx?$/u, ".ts"),
      base.replace(/\.jsx?$/u, ".tsx"),
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ];
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

/**
 * Deterministic skeleton: imports + top-level signatures + member signatures,
 * bodies elided. Typically 8-15% of the original token count.
 */
export async function extractSkeleton(source: string, fileName: string): Promise<string> {
  if (configFormatFor(fileName) !== undefined) {
    return extractConfigSkeleton(source, fileName);
  }
  const kind = langForFile(fileName);
  if (kind === undefined) return "";
  const skeleton = await withParsedRoot(source, kind, (rootNode) => {
    const lines: string[] = [];

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

  for (const child of named(rootNode)) {
    if (child.type === "import_statement" || child.type === "import_declaration" || child.type === "package_declaration") {
      lines.push(collapse(child.text, 200));
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
    if (child.type.endsWith("_declaration") || child.type === "method_definition") {
      emitDeclaration(child);
    }
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
  await writeFile(cachePath, JSON.stringify(graph, null, 2));
  return cachePath;
}

export async function loadAtlasGraph(paths: MrPaths, workspaceId: string): Promise<AtlasGraph | undefined> {
  const cachePath = join(paths.cacheRoot, workspaceId, ATLAS_CACHE_FILE);
  try {
    const content = await readFile(cachePath, "utf8");
    return JSON.parse(content) as AtlasGraph;
  } catch {
    return undefined;
  }
}

export async function saveGovernanceConfig(paths: MrPaths, workspaceId: string, config: GovernanceConfig): Promise<string> {
  const configDir = join(paths.configRoot, "generated", workspaceId);
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, GOVERNANCE_FILE);
  await writeFile(configPath, JSON.stringify(config, null, 2));
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
  const visited = new Set<string>();
  const result: AtlasNode[] = [];
  const queue: { id: string; level: number }[] = [{ id: nodeId, level: 0 }];

  while (queue.length > 0) {
    const { id, level } = queue.shift() as { id: string; level: number };
    if (visited.has(id) || level > depth) continue;
    visited.add(id);

    const node = graph.nodes.find((n) => n.id === id);
    if (node === undefined) continue;
    result.push(node);

    for (const depId of node.dependents) {
      if (!visited.has(depId)) {
        queue.push({ id: depId, level: level + 1 });
      }
    }
  }

  return result;
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
