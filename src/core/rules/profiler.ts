import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AtlasGraph } from "../atlas.js";
import { sha256 } from "../files.js";
import { runCommand } from "../process.js";
import type { DiscoveredRepository } from "./discover.js";
import { REPOSITORY_DETECTORS, type RepositoryDetectorContext } from "./detectors/index.js";

export const RuleFactSchema = z.strictObject({
  id: z.string().min(1),
  statement: z.string().min(1).max(200),
  value: z.string().min(1).max(100),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().max(200)).max(5),
});

export const RepositoryProfileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  root: z.string().min(1),
  generatedFromIndex: z.string().length(64),
  kind: z.enum(["spa", "mfe-host", "mfe-remote", "api", "bff", "service", "monorepo", "design-system", "library", "cli", "unknown"]),
  stack: z.strictObject({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    packageManager: z.string().optional(),
    build: z.string().optional(),
    runtime: z.string().optional(),
  }),
  layout: z.strictObject({ style: z.enum(["feature", "layered", "hexagonal", "ddd", "atomic", "flat", "mixed"]), roots: z.array(z.string()) }),
  commands: z.strictObject({
    install: z.string().optional(), test: z.string().optional(), lint: z.string().optional(),
    typecheck: z.string().optional(), build: z.string().optional(), format: z.string().optional(),
  }),
  criticalAreas: z.array(z.string()),
  facts: z.array(RuleFactSchema),
  inferences: z.array(RuleFactSchema),
  gaps: z.array(z.string().max(200)),
});

export type RuleFact = z.infer<typeof RuleFactSchema>;
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;

interface PackageJson {
  readonly scripts?: Record<string, unknown>;
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
  readonly packageManager?: unknown;
  readonly bin?: unknown;
  readonly workspaces?: unknown;
}

interface ComposerJson {
  readonly require?: Record<string, unknown>;
  readonly "require-dev"?: Record<string, unknown>;
}

function parseJson(source: string | undefined): Record<string, unknown> | undefined {
  if (source === undefined) return undefined;
  try {
    const value = JSON.parse(source) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function deduplicate(rows: readonly RuleFact[]): RuleFact[] {
  return [...new Map([...rows]
    .sort((left, right) => right.confidence - left.confidence)
    .map((row) => [row.id, RuleFactSchema.parse(row)])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function repositoryIndexHash(graph: AtlasGraph, root: string): string {
  const prefix = root === "." ? "" : `${root}/`;
  return sha256(graph.files
    .filter((record) => record.path.startsWith(prefix))
    .map((record) => `${record.path}:${record.contentHash}`)
    .sort()
    .join("\n"));
}

export function profileStackFingerprint(profile: Pick<RepositoryProfile, "stack" | "kind">): string {
  return sha256(JSON.stringify({ stack: profile.stack, kind: profile.kind }));
}

async function repositorySources(workspaceRoot: string, paths: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const rows = await Promise.all(paths.slice(0, 3_000).map(async (path) => {
    try {
      const source = await readFile(join(workspaceRoot, path), "utf8");
      return source.length <= 300_000 ? [path, source] as const : undefined;
    } catch {
      return undefined;
    }
  }));
  return new Map(rows.filter((row): row is readonly [string, string] => row !== undefined));
}

function layout(paths: readonly string[], prefix: string): RepositoryProfile["layout"] {
  const candidates = [
    ["feature", /(?:^|\/)features?\//u],
    ["hexagonal", /(?:^|\/)(?:domain|application|infrastructure|adapters?|ports?)\//iu],
    ["ddd", /(?:^|\/)(?:Domain|Application|Infrastructure)\//u],
    ["atomic", /(?:^|\/)(?:atoms?|molecules?|organisms?)\//u],
    ["layered", /(?:^|\/)(?:components|services|controllers|repositories)\//iu],
  ] as const;
  const relative = paths.map((path) => prefix === "" ? path : path.slice(prefix.length));
  const scores = candidates.map(([name, pattern]) => [name, relative.filter((path) => pattern.test(path)).length] as const)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);
  const style = scores.length === 0 ? "flat" : scores.length > 1 && scores[0]?.[1] === scores[1]?.[1] ? "mixed" : scores[0]?.[0] ?? "flat";
  const roots = [...new Set(relative.filter((path) => path.includes("/")).map((path) => path.split("/")[0]).filter((value): value is string => value !== undefined && value.length > 0))].slice(0, 8);
  return { style, roots };
}

function inferKind(repo: DiscoveredRepository, pkg: PackageJson, frameworks: readonly string[], graph: AtlasGraph, prefix: string): RepositoryProfile["kind"] {
  const federation = graph.nodes.filter((node) => node.filePath.startsWith(prefix) && node.kind === "federation-contract");
  if (federation.some((node) => node.metadata["role"] === "remote")) return "mfe-host";
  if (federation.some((node) => node.metadata["role"] === "expose")) return "mfe-remote";
  if (pkg.workspaces !== undefined || repo.markers.includes("pnpm-workspace.yaml")) return "monorepo";
  if (typeof pkg.bin === "string" || (pkg.bin !== null && typeof pkg.bin === "object" && Object.keys(pkg.bin).length > 0)) return "cli";
  if (frameworks.includes("Next.js") || frameworks.includes("React") || frameworks.includes("Vue") || frameworks.includes("Angular")) return "spa";
  if (frameworks.includes("Symfony") || frameworks.includes("NestJS") || repo.markers.includes("composer.json")) return "api";
  if (repo.markers.includes("package.json")) return "library";
  return "unknown";
}

export async function profileRepository(workspaceRoot: string, repo: DiscoveredRepository, graph: AtlasGraph): Promise<RepositoryProfile> {
  const prefix = repo.root === "." ? "" : `${repo.root}/`;
  const records = graph.files.filter((file) => file.path.startsWith(prefix));
  const paths = records.map((file) => file.path);
  const files = await repositorySources(workspaceRoot, paths);
  const packagePath = `${prefix}package.json`;
  const composerPath = `${prefix}composer.json`;
  const pkg = (parseJson(files.get(packagePath)) ?? {}) as PackageJson;
  const composer = (parseJson(files.get(composerPath)) ?? {}) as ComposerJson;
  const dependencies = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(composer.require ?? {}),
    ...Object.keys(composer["require-dev"] ?? {}),
  ]);
  const frameworkEntries: readonly (readonly [string, string])[] = [
    ["react", "React"], ["next", "Next.js"], ["@angular/core", "Angular"], ["vue", "Vue"],
    ["@nestjs/core", "NestJS"], ["symfony/framework-bundle", "Symfony"], ["vite", "Vite"],
    ["@tanstack/react-query", "TanStack Query"], ["@reduxjs/toolkit", "Redux Toolkit"], ["zod", "Zod"],
    ["astro", "Astro"], ["expo", "Expo"], ["doctrine/orm", "Doctrine ORM"], ["doctrine/mongodb-odm", "Doctrine ODM"],
  ];
  const frameworks = frameworkEntries.filter(([key]) => dependencies.has(key)).map(([, label]) => label);
  if (repo.markers.includes("composer.json") && frameworks.length === 0) frameworks.push("PHP");
  const languages = [...new Set(records.map((file) => file.language).filter((language) => !["unsupported", "json", "yaml"].includes(language)))];
  const scripts = pkg.scripts ?? {};
  const packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : repo.markers.includes("package.json") ? "bun" : undefined;
  const runPrefix = packageManager === "npm" ? "npm run" : packageManager === "pnpm" ? "pnpm" : packageManager === "yarn" ? "yarn" : "bun run";
  const command = (name: string): string | undefined => typeof scripts[name] === "string" ? `${runPrefix} ${name}` : undefined;
  const commands = Object.fromEntries([
    ["install", packageManager === undefined ? undefined : `${packageManager} install`],
    ...["test", "lint", "typecheck", "build", "format"].map((name) => [name, command(name)]),
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const recent = runCommand("git", ["-C", workspaceRoot, "log", "-20", "--format=%s", "--", repo.root === "." ? "." : repo.root]);
  const recentCommits = recent.ok ? recent.stdout.split(/\r?\n/u).filter(Boolean) : [];
  const detectorContext: RepositoryDetectorContext = { prefix, paths, files, graph, dependencies, scripts, markers: repo.markers, recentCommits };
  const facts: RuleFact[] = [];
  const inferences: RuleFact[] = [];
  const gaps: string[] = [];
  for (const detector of REPOSITORY_DETECTORS) {
    const output = detector(detectorContext);
    facts.push(...(output.facts ?? []));
    for (const inference of output.inferences ?? []) {
      if (inference.confidence >= 0.55) inferences.push(inference);
      else gaps.push(`${inference.id} could not be inferred with confidence.`);
    }
    gaps.push(...(output.gaps ?? []));
  }
  for (const [name, value] of Object.entries(commands)) facts.push({ id: `commands.${name}`, value, statement: `Use ${value}.`, confidence: 1, evidence: [`${packagePath}#scripts`] });
  const layoutResult = layout(paths, prefix);
  const criticalAreas = ["auth", "payment", "security", "persistence", "migration", "federation-contract", "public-api", "cache-concurrency"]
    .filter((area) => paths.some((path) => path.toLowerCase().replace(/migrations?/gu, "migration").replace(/[-_]/gu, "").includes(area.replaceAll("-", ""))))
    .concat(graph.nodes.some((node) => node.filePath.startsWith(prefix) && node.kind === "federation-contract") ? ["federation-contract"] : []);
  const kind = inferKind(repo, pkg, frameworks, graph, prefix);
  const stack = {
    languages,
    frameworks: [...new Set(frameworks)],
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(command("build") === undefined ? {} : { build: command("build") }),
    ...(repo.markers.includes("composer.json") ? { runtime: "PHP" } : languages.includes("java") ? { runtime: "JVM" } : {}),
  };
  return RepositoryProfileSchema.parse({
    schemaVersion: 1,
    repo: repo.name,
    root: repo.root,
    generatedFromIndex: repositoryIndexHash(graph, repo.root),
    kind,
    stack,
    layout: layoutResult,
    commands,
    criticalAreas: [...new Set(criticalAreas)],
    facts: deduplicate(facts),
    inferences: deduplicate(inferences),
    gaps: [...new Set(gaps)].slice(0, 20),
  });
}
