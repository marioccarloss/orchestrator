import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson, readJson } from "../files.js";
import type { WorkspaceProfile } from "../schema.js";
import { LocalRulesSchema, mergeLocalRules, WorkspaceRulesSchema, type LocalRules, type WorkspaceRules } from "./generator.js";
import { RepositoryProfileSchema, type RepositoryProfile } from "./profiler.js";
import { renderRepositoryAgentsMarkdown, renderWorkspaceAgentsMarkdown, type AgentsLanguage } from "./render.js";
import { profileStackFingerprint } from "./profiler.js";

const RepositoryProfilesFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: z.iso.datetime(),
  profiles: z.array(RepositoryProfileSchema),
});

export function rulesRoot(profile: WorkspaceProfile): string {
  return join(profile.contextRoot, "atlas");
}

export const LOCAL_RULES_FILE = "rules.local.json";

export type AtlasRuleFile = "profile.json" | "rules.json" | typeof LOCAL_RULES_FILE;
export type AtlasRuleFileInspection =
  | { readonly file: AtlasRuleFile; readonly path: string; readonly status: "missing" }
  | { readonly file: AtlasRuleFile; readonly path: string; readonly status: "valid"; readonly value: unknown }
  | { readonly file: AtlasRuleFile; readonly path: string; readonly status: "invalid"; readonly issue: string };

const ATLAS_RULE_FILES: readonly (readonly [AtlasRuleFile, z.ZodType])[] = [
  ["profile.json", RepositoryProfilesFileSchema], ["rules.json", WorkspaceRulesSchema], [LOCAL_RULES_FILE, LocalRulesSchema],
];

async function inspectJson(file: AtlasRuleFile, path: string, schema: z.ZodType): Promise<AtlasRuleFileInspection> {
  let content: string;
  try { content = await readFile(path, "utf8"); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, path, status: "missing" };
    return { file, path, status: "invalid", issue: error instanceof Error ? error.message : String(error) };
  }
  let json: unknown;
  try { json = JSON.parse(content) as unknown; } catch (error: unknown) {
    return { file, path, status: "invalid", issue: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { file, path, status: "valid", value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue === undefined || issue.path.length === 0 ? "(root)" : issue.path.join(".");
  return { file, path, status: "invalid", issue: `${where}: ${issue?.message ?? "invalid"}` };
}

/** Validates profile.json, rules.json, and rules.local.json without throwing; used by `mr doctor`. */
export async function inspectAtlasRuleFiles(profile: WorkspaceProfile): Promise<readonly AtlasRuleFileInspection[]> {
  return Promise.all(ATLAS_RULE_FILES.map(([file, schema]) => inspectJson(file, join(rulesRoot(profile), file), schema)));
}

export async function saveRepositoryProfiles(profile: WorkspaceProfile, profiles: readonly RepositoryProfile[]): Promise<string> {
  const root = rulesRoot(profile);
  await mkdir(root, { recursive: true });
  const path = join(root, "profile.json");
  await atomicWrite(path, canonicalJson(RepositoryProfilesFileSchema.parse({ schemaVersion: 1, generatedAt: new Date().toISOString(), profiles })));
  return path;
}

export async function saveWorkspaceRules(profile: WorkspaceProfile, rules: WorkspaceRules, profiles: readonly RepositoryProfile[], language: AgentsLanguage = "en"): Promise<readonly string[]> {
  const root = rulesRoot(profile);
  await mkdir(join(root, "repos"), { recursive: true });
  const files: string[] = [];
  const write = async (path: string, content: string): Promise<void> => {
    await atomicWrite(path, content);
    files.push(path);
  };
  files.push(await saveRepositoryProfiles(profile, profiles));
  await write(join(root, "rules.json"), canonicalJson(rules));
  const merged = mergeLocalRules(rules, await loadLocalRules(profile)) ?? rules;
  await write(join(root, "AGENTS.md"), renderWorkspaceAgentsMarkdown(merged, profiles, language));
  for (const repository of merged.repositories) {
    const repositoryProfile = profiles.find((candidate) => candidate.repo === repository.repo);
    if (repositoryProfile === undefined) continue;
    const dir = join(root, "repos", repository.repo);
    await mkdir(dir, { recursive: true });
    await write(join(dir, "AGENTS.md"), renderRepositoryAgentsMarkdown(repository, repositoryProfile, rules.preferences, language));
  }
  return files;
}

/** Generator-owned rules.json only. */
export async function loadGeneratedWorkspaceRules(profile: WorkspaceProfile): Promise<WorkspaceRules | undefined> {
  try { return await readJson(join(rulesRoot(profile), "rules.json"), WorkspaceRulesSchema); } catch { return undefined; }
}

/** User-owned rules.local.json; undefined when missing or invalid (`mr doctor` reports why). */
export async function loadLocalRules(profile: WorkspaceProfile): Promise<LocalRules | undefined> {
  try { return await readJson(join(rulesRoot(profile), LOCAL_RULES_FILE), LocalRulesSchema); } catch { return undefined; }
}

/** Generated rules merged with user-owned local rules; local rules win on the same repo + id. */
export async function loadWorkspaceRules(profile: WorkspaceProfile): Promise<WorkspaceRules | undefined> {
  const [generated, local] = await Promise.all([loadGeneratedWorkspaceRules(profile), loadLocalRules(profile)]);
  return mergeLocalRules(generated, local);
}

export async function loadRepositoryProfiles(profile: WorkspaceProfile): Promise<readonly RepositoryProfile[] | undefined> {
  try { return (await readJson(join(rulesRoot(profile), "profile.json"), RepositoryProfilesFileSchema)).profiles; } catch { return undefined; }
}

export function staleRuleRepositories(rules: WorkspaceRules, profiles: readonly RepositoryProfile[]): readonly string[] {
  return profiles.filter((profile) => {
    const repository = rules.repositories.find((candidate) => candidate.repo === profile.repo);
    return repository === undefined
      || repository.generatedFromIndex !== profile.generatedFromIndex
      && repository.stackFingerprint !== profileStackFingerprint(profile);
  }).map((profile) => profile.repo);
}
