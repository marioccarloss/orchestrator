import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson, readJson } from "../files.js";
import type { WorkspaceProfile } from "../schema.js";
import { WorkspaceRulesSchema, type WorkspaceRules } from "./generator.js";
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
  await write(join(root, "AGENTS.md"), renderWorkspaceAgentsMarkdown(rules, profiles, language));
  for (const repository of rules.repositories) {
    const repositoryProfile = profiles.find((candidate) => candidate.repo === repository.repo);
    if (repositoryProfile === undefined) continue;
    const dir = join(root, "repos", repository.repo);
    await mkdir(dir, { recursive: true });
    await write(join(dir, "AGENTS.md"), renderRepositoryAgentsMarkdown(repository, repositoryProfile, rules.preferences, language));
  }
  return files;
}

export async function loadWorkspaceRules(profile: WorkspaceProfile): Promise<WorkspaceRules | undefined> {
  try { return await readJson(join(rulesRoot(profile), "rules.json"), WorkspaceRulesSchema); } catch { return undefined; }
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
