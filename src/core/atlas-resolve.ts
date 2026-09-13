import { dirname, join, posix } from "node:path";

// ─── Specifier resolution: tsconfig paths, workspace packages, PSR-4 ─────────
//
// Pure resolution over an in-memory context. The indexer builds the context
// once per index run from the configuration files it already reads, then asks
// for candidate base paths for every non-relative specifier. Anything that
// still cannot be matched to an indexed file is reported as an unresolved
// import in the coverage receipt instead of being silently dropped.

export interface TsPathMapping {
  /** Directory (workspace-relative, "" for root) that owns the tsconfig. */
  readonly baseDir: string;
  /** Resolved `compilerOptions.baseUrl` relative to the workspace root. */
  readonly baseUrl: string;
  /** Pattern → target list, both possibly containing a single `*`. */
  readonly paths: ReadonlyMap<string, readonly string[]>;
}

export interface Psr4Mapping {
  /** Namespace prefix with trailing backslash, e.g. `App\\`. */
  readonly prefix: string;
  /** Workspace-relative directory, e.g. `repos/api/src`. */
  readonly dir: string;
}

export interface ResolverContext {
  readonly tsPaths: readonly TsPathMapping[];
  /** package.json `name` → workspace-relative package directory. */
  readonly packages: ReadonlyMap<string, string>;
  readonly psr4: readonly Psr4Mapping[];
}

export const EMPTY_RESOLVER_CONTEXT: ResolverContext = { tsPaths: [], packages: new Map(), psr4: [] };

function normalize(path: string): string {
  const joined = posix.normalize(path.split("\\").join("/"));
  return joined === "." ? "" : joined.replace(/^\.\//u, "").replace(/\/$/u, "");
}

function parseJsonc(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    try {
      return JSON.parse(source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "").replace(/,\s*([}\]])/gu, "$1"));
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface TsconfigShape {
  readonly extends?: unknown;
  readonly compilerOptions?: { readonly baseUrl?: unknown; readonly paths?: unknown };
}

/**
 * Builds the resolver context from configuration files. `readText` returns the
 * content of a workspace-relative file or undefined; `files` is the indexed
 * file list (configuration files must be part of it to be considered).
 */
export async function buildResolverContext(
  files: readonly string[],
  readText: (relPath: string) => Promise<string | undefined>,
): Promise<ResolverContext> {
  const tsPaths: TsPathMapping[] = [];
  const packages = new Map<string, string>();
  const psr4: Psr4Mapping[] = [];

  const tsconfigs = files.filter((file) => /(?:^|\/)tsconfig(?:\.[\w-]+)?\.json$/u.test(file));
  for (const file of tsconfigs) {
    const mapping = await loadTsconfigPaths(file, readText, new Set());
    if (mapping !== undefined && mapping.paths.size > 0) tsPaths.push(mapping);
  }

  for (const file of files.filter((candidate) => /(?:^|\/)package\.json$/u.test(candidate))) {
    const parsed = parseJsonc((await readText(file)) ?? "");
    if (!isRecord(parsed) || typeof parsed["name"] !== "string") continue;
    packages.set(parsed["name"], normalize(dirname(file)));
  }

  for (const file of files.filter((candidate) => /(?:^|\/)composer\.json$/u.test(candidate))) {
    const parsed = parseJsonc((await readText(file)) ?? "");
    if (!isRecord(parsed)) continue;
    const baseDir = normalize(dirname(file));
    for (const key of ["autoload", "autoload-dev"]) {
      const autoload = parsed[key];
      if (!isRecord(autoload) || !isRecord(autoload["psr-4"])) continue;
      for (const [prefix, target] of Object.entries(autoload["psr-4"])) {
        const targets = Array.isArray(target) ? target : [target];
        for (const dir of targets) {
          if (typeof dir !== "string") continue;
          psr4.push({ prefix: prefix.endsWith("\\") ? prefix : `${prefix}\\`, dir: normalize(join(baseDir, dir)) });
        }
      }
    }
  }
  psr4.sort((a, b) => b.prefix.length - a.prefix.length);
  return { tsPaths, packages, psr4 };
}

async function loadTsconfigPaths(
  file: string,
  readText: (relPath: string) => Promise<string | undefined>,
  seen: Set<string>,
): Promise<TsPathMapping | undefined> {
  if (seen.has(file)) return undefined;
  seen.add(file);
  const parsed = parseJsonc((await readText(file)) ?? "");
  if (!isRecord(parsed)) return undefined;
  const config = parsed as TsconfigShape;
  const baseDir = normalize(dirname(file));
  let inherited: TsPathMapping | undefined;
  if (typeof config.extends === "string" && (config.extends.startsWith("./") || config.extends.startsWith("../"))) {
    const parent = normalize(join(baseDir, config.extends.endsWith(".json") ? config.extends : `${config.extends}.json`));
    inherited = await loadTsconfigPaths(parent, readText, seen);
  }
  const options = config.compilerOptions ?? {};
  const baseUrl = typeof options.baseUrl === "string" ? normalize(join(baseDir, options.baseUrl)) : inherited?.baseUrl ?? baseDir;
  const paths = new Map<string, readonly string[]>(inherited?.paths ?? []);
  if (isRecord(options.paths)) {
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (!Array.isArray(targets)) continue;
      paths.set(pattern, targets.filter((target): target is string => typeof target === "string"));
    }
  }
  return { baseDir, baseUrl, paths };
}

function matchStar(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/**
 * Candidate base paths (without extension probing) for a JS/TS specifier that
 * is not relative. Returns an empty list when nothing in the context applies.
 */
export function resolveJsSpecifier(specifier: string, fromFile: string, context: ResolverContext): readonly string[] {
  const candidates: string[] = [];
  const from = normalize(fromFile);
  const applicable = context.tsPaths
    .filter((mapping) => mapping.baseDir === "" || from.startsWith(`${mapping.baseDir}/`))
    .sort((a, b) => b.baseDir.length - a.baseDir.length);
  for (const mapping of applicable) {
    for (const [pattern, targets] of mapping.paths) {
      const captured = matchStar(pattern, specifier);
      if (captured === undefined) continue;
      for (const target of targets) {
        candidates.push(normalize(join(mapping.baseUrl, target.replace("*", captured))));
      }
    }
    if (candidates.length > 0) break;
  }
  const packageMatch = [...context.packages].find(([name]) => specifier === name || specifier.startsWith(`${name}/`));
  if (packageMatch !== undefined) {
    const [name, dir] = packageMatch;
    const rest = specifier === name ? "" : specifier.slice(name.length + 1);
    candidates.push(normalize(join(dir, rest === "" ? "src/index" : rest)), normalize(join(dir, rest === "" ? "index" : `src/${rest}`)));
  }
  return [...new Set(candidates)];
}

/** Maps a fully-qualified PHP class name to its PSR-4 file path when a prefix matches. */
export function resolvePhpClass(fqn: string, context: ResolverContext): string | undefined {
  const name = fqn.replace(/^\\/u, "");
  for (const mapping of context.psr4) {
    if (!name.startsWith(mapping.prefix)) continue;
    const rest = name.slice(mapping.prefix.length).split("\\").join("/");
    return normalize(join(mapping.dir, `${rest}.php`));
  }
  return undefined;
}
