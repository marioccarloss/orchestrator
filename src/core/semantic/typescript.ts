import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import type { AtlasEdge, AtlasGraph, AtlasNode } from "../atlas.js";

export interface SemanticLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly name?: string;
}

export interface SemanticTypeInfo {
  readonly display: string;
  readonly documentation: string;
}

/** Convert Language Service incoming-call locations into explicit Atlas calls edges. */
export function resolveTypeScriptCallEdges(
  graph: AtlasGraph,
  target: AtlasNode,
  callers: readonly SemanticLocation[],
  projectPrefix = ".",
): readonly AtlasEdge[] {
  const workspacePath = (projectPath: string): string => projectPrefix === "."
    ? projectPath
    : `${projectPrefix.replace(/\/$/u, "")}/${projectPath}`.replaceAll("\\", "/");
  return [...new Map(callers.flatMap((caller) => {
    const source = graph.nodes.find((candidate) => candidate.filePath === workspacePath(caller.file) && candidate.name === caller.name);
    return source === undefined ? [] : [{ from: source.id, to: target.id, type: "calls" as const }];
  }).map((edge) => [`${edge.from}:${edge.to}`, edge])).values()];
}

function normalizedFile(root: string, file: string): string {
  return resolve(root, file);
}

function symbolPosition(fileName: string, symbol: string): number | undefined {
  const source = ts.createSourceFile(fileName, readFileSync(fileName, "utf8"), ts.ScriptTarget.Latest, true);
  let declaration: number | undefined;
  let first: number | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === symbol) {
      first ??= node.getStart(source);
      if ((node.parent as ts.NamedDeclaration).name === node) declaration ??= node.getStart(source);
    }
    if (declaration === undefined) ts.forEachChild(node, visit);
  };
  visit(source);
  return declaration ?? first;
}

export class TypeScriptProjectService {
  private readonly root: string;
  private readonly parsed: ts.ParsedCommandLine;
  private readonly service: ts.LanguageService;
  private readonly scriptVersions = new Map<string, { readonly stamp: string; readonly hash: string }>();

  constructor(readonly tsconfigPath: string) {
    const absoluteConfig = resolve(tsconfigPath);
    this.root = dirname(absoluteConfig);
    const config = ts.readConfigFile(absoluteConfig, (fileName) => ts.sys.readFile(fileName));
    if (config.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    this.parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, this.root);
    if (this.parsed.errors.length > 0) throw new Error(this.parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; "));
    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.parsed.options,
      getScriptFileNames: () => this.parsed.fileNames,
      getScriptVersion: (fileName) => {
        try {
          const stat = statSync(fileName);
          const stamp = `${String(stat.mtimeMs)}:${String(stat.size)}`;
          const cached = this.scriptVersions.get(fileName);
          if (cached?.stamp === stamp) return cached.hash;
          const hash = createHash("sha256").update(readFileSync(fileName)).digest("hex");
          this.scriptVersions.set(fileName, { stamp, hash });
          return hash;
        } catch {
          return "missing";
        }
      },
      getScriptSnapshot: (fileName) => {
        const source = ts.sys.readFile(fileName);
        return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
      },
      getCurrentDirectory: () => this.root,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: (fileName) => ts.sys.fileExists(fileName),
      readFile: (fileName) => ts.sys.readFile(fileName),
      readDirectory: (path, extensions, excludes, includes, depth) => ts.sys.readDirectory(path, extensions, excludes, includes, depth),
      directoryExists: (path) => ts.sys.directoryExists(path),
      getDirectories: (path) => ts.sys.getDirectories(path),
    };
    this.service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  private target(file: string, symbol: string): { readonly fileName: string; readonly position: number } {
    const fileName = isAbsolute(file) ? file : normalizedFile(this.root, file);
    const position = symbolPosition(fileName, symbol);
    if (position === undefined) throw new Error(`Symbol '${symbol}' was not found in ${file}`);
    return { fileName, position };
  }

  private location(fileName: string, position: number, name?: string): SemanticLocation {
    const source = this.service.getProgram()?.getSourceFile(fileName);
    const point = source?.getLineAndCharacterOfPosition(position) ?? { line: 0, character: 0 };
    return {
      file: relative(this.root, fileName).replaceAll("\\", "/"),
      line: point.line + 1,
      column: point.character + 1,
      ...(name === undefined ? {} : { name }),
    };
  }

  findReferences(file: string, symbol: string): readonly SemanticLocation[] {
    const target = this.target(file, symbol);
    const references = this.service.findReferences(target.fileName, target.position) ?? [];
    const locations = references.flatMap((group) => group.references)
      .filter((reference) => !reference.fileName.endsWith(".d.ts"))
      .slice(0, 200)
      .map((reference) => this.location(reference.fileName, reference.textSpan.start, symbol));
    return [...new Map(locations.map((location) => [`${location.file}:${String(location.line)}:${String(location.column)}`, location])).values()];
  }

  getCallers(file: string, symbol: string, depth = 2): readonly SemanticLocation[] {
    const target = this.target(file, symbol);
    const queue: { readonly fileName: string; readonly position: number; readonly level: number }[] = [{ ...target, level: 0 }];
    const output: SemanticLocation[] = [];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || current.level >= Math.min(2, Math.max(0, depth))) continue;
      for (const incoming of this.service.provideCallHierarchyIncomingCalls(current.fileName, current.position).slice(0, 100)) {
        const key = `${incoming.from.file}:${String(incoming.from.selectionSpan.start)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(this.location(incoming.from.file, incoming.from.selectionSpan.start, incoming.from.name));
        queue.push({ fileName: incoming.from.file, position: incoming.from.selectionSpan.start, level: current.level + 1 });
      }
    }
    return output;
  }

  getTypeAtSymbol(file: string, symbol: string): SemanticTypeInfo {
    const target = this.target(file, symbol);
    const quickInfo = this.service.getQuickInfoAtPosition(target.fileName, target.position);
    if (quickInfo === undefined) throw new Error(`No type information is available for '${symbol}' in ${file}`);
    return {
      display: ts.displayPartsToString(quickInfo.displayParts),
      documentation: ts.displayPartsToString(quickInfo.documentation),
    };
  }

  dispose(): void {
    this.service.dispose();
    if (serviceCache.get(resolve(this.tsconfigPath)) === this) serviceCache.delete(resolve(this.tsconfigPath));
  }
}

const serviceCache = new Map<string, TypeScriptProjectService>();

export function createProjectService(tsconfigPath: string): TypeScriptProjectService {
  const key = resolve(tsconfigPath);
  const cached = serviceCache.get(key);
  if (cached !== undefined) return cached;
  const service = new TypeScriptProjectService(key);
  serviceCache.set(key, service);
  return service;
}
