import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "./files.js";
import { normalizeUserLanguage, UserLanguageSchema, type UserLanguage } from "./language.js";
import { messagesFor } from "./render.js";

export const BlueprintModeSchema = z.enum(["idea", "ticket"]);
export type BlueprintMode = z.infer<typeof BlueprintModeSchema>;

export const BlueprintEntitySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  fields: z.record(z.string(), z.string()).default({}),
});
export type BlueprintEntity = z.infer<typeof BlueprintEntitySchema>;

export const BlueprintContractSchema = z.object({
  endpointOrFunction: z.string().min(1),
  input: z.string().min(1),
  output: z.string().min(1),
  errorCases: z.array(z.string()).default([]),
});
export type BlueprintContract = z.infer<typeof BlueprintContractSchema>;

export const BlueprintTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  labels: z.array(z.string()).default([]),
  priority: z.enum(["high", "medium", "low"]).default("medium"),
});
export type BlueprintTask = z.infer<typeof BlueprintTaskSchema>;

export const BlueprintSpecSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  title: z.string().min(1),
  mode: BlueprintModeSchema,
  userLanguage: UserLanguageSchema.optional(),
  overview: z.string().min(1),
  sdd: z.object({
    entities: z.array(BlueprintEntitySchema).default([]),
    invariants: z.array(z.string()).default([]),
    contracts: z.array(BlueprintContractSchema).default([]),
    testConditions: z.array(z.string()).default([]),
  }),
  rpi: z.object({
    requestIntent: z.string().min(1),
    transversalImpact: z.array(z.string()).default([]),
    assumedInferences: z.array(z.string()).default([]),
  }),
  tasks: z.array(BlueprintTaskSchema).default([]),
  createdAt: z.string(),
});
export type BlueprintSpec = z.infer<typeof BlueprintSpecSchema>;

export const BlueprintMutationSchema = z.object({
  action: z.enum(["create", "update", "delete"]),
  target: z.object({
    id: z.string().optional(),
    title: z.string().min(1),
    repo: z.string().min(1),
    fields: z.record(z.string(), z.unknown()).default({}),
  }),
});
export type BlueprintMutation = z.infer<typeof BlueprintMutationSchema>;

export function renderBlueprintMarkdown(spec: BlueprintSpec, language: UserLanguage = normalizeUserLanguage(spec.userLanguage)): string {
  const m = messagesFor(language).blueprint;
  const lines: string[] = [
    `# Blueprint: ${spec.title}`,
    ``,
    `> **${m.mode}**: ${spec.mode} | **Slug**: \`${spec.slug}\` | **${m.date}**: ${spec.createdAt}`,
    ``,
    `## 1. ${m.executiveSummary}`,
    spec.overview,
    ``,
    `### ${m.requestIntent}`,
    spec.rpi.requestIntent,
    ``,
    `### ${m.transversalImpact}`,
    ...(spec.rpi.transversalImpact.length > 0
      ? spec.rpi.transversalImpact.map((item) => `- ${item}`)
      : [`- ${m.noImpact}`]),
    ``,
    `### [${m.assumptions}]`,
    ...(spec.rpi.assumedInferences.length > 0
      ? spec.rpi.assumedInferences.map((item) => `- ⚠️ ${item}`)
      : [`- ${m.noAssumptions}`]),
    ``,
    `## 2. ${m.designSpec}`,
    ``,
    `### ${m.coreEntities}`,
    ...(spec.sdd.entities.length > 0
      ? spec.sdd.entities.map((e) => {
          const fieldsStr = Object.entries(e.fields)
            .map(([k, v]) => `\`${k}\`: ${v}`)
            .join(", ");
          return `- **${e.name}**: ${e.description}${fieldsStr ? ` (${fieldsStr})` : ""}`;
        })
      : [`- ${m.noEntities}`]),
    ``,
    `### ${m.invariants}`,
    ...(spec.sdd.invariants.length > 0
      ? spec.sdd.invariants.map((item) => `- 🔒 ${item}`)
      : [`- ${m.standardRules}`]),
    ``,
    `### ${m.contracts}`,
    ...(spec.sdd.contracts.length > 0
      ? spec.sdd.contracts.map((c) => `- \`${c.endpointOrFunction}\` -> In: \`${c.input}\`, Out: \`${c.output}\``)
      : [`- ${m.noContracts}`]),
    ``,
    `### ${m.testConditions}`,
    ...(spec.sdd.testConditions.length > 0
      ? spec.sdd.testConditions.map((item) => `- ✅ ${item}`)
      : [`- ${m.defaultTests}`]),
    ``,
    `## 3. ${m.taskBreakdown}`,
    ...(spec.tasks.length > 0
      ? spec.tasks.map((t) => `- [ ] **[${t.id}] ${t.title}** (${t.priority}): ${t.description}`)
      : [`- ${m.pendingBreakdown}`]),
  ];

  return lines.join("\n");
}

export function renderBlueprintExecutiveSummary(spec: BlueprintSpec, language: UserLanguage = normalizeUserLanguage(spec.userLanguage)): string {
  const m = messagesFor(language).blueprint;
  const assumptionsCount = spec.rpi.assumedInferences.length;
  const entitiesCount = spec.sdd.entities.length;
  const tasksCount = spec.tasks.length;

  return [
    `# ${m.approved}: ${spec.title} (\`${spec.slug}\`)`,
    `• ${m.mode}: ${spec.mode.toUpperCase()}`,
    `• ${m.sddEntities}: ${entitiesCount} | ${m.invariants}: ${spec.sdd.invariants.length} | ${messagesFor(language).common.tasks}: ${tasksCount}`,
    `• ${m.assumed}: ${assumptionsCount > 0 ? `${assumptionsCount} ${m.inferences}` : `0 (${m.exactSpec})`}`,
    `• ${m.summary}: ${spec.overview}`,
    `• ${m.artifact}: .blueprint/specs/YYYY-MM-DD_${spec.slug}.md`,
  ].join("\n");
}

export function renderSafetyGateDiff(mutation: BlueprintMutation, language: UserLanguage = "es"): string {
  const m = messagesFor(language).blueprint;
  const actionBadge = mutation.action === "delete" ? "🚨 DELETE" : mutation.action === "update" ? "🔄 UPDATE" : "✨ CREATE";
  return [
    `┌────────────────────────────────────────────────────────┐`,
    `│ ${m.safetyGate.padEnd(54).slice(0, 54)}│`,
    `├────────────────────────────────────────────────────────┤`,
    `│ ${m.action.padEnd(10).slice(0, 10)}: ${actionBadge.padEnd(42).slice(0, 42)}│`,
    `│ ${m.repo.padEnd(10).slice(0, 10)}: ${mutation.target.repo.padEnd(42).slice(0, 42)}│`,
    `│ ${m.title.padEnd(10).slice(0, 10)}: ${mutation.target.title.padEnd(42).slice(0, 42)}│`,
    mutation.target.id ? `│ ID        : ${mutation.target.id.padEnd(42)}│` : "",
    `└────────────────────────────────────────────────────────┘`,
  ].filter(Boolean).join("\n");
}

export async function saveBlueprintSpec(
  workspaceRoot: string,
  spec: BlueprintSpec,
): Promise<{ jsonPath: string; markdownPath: string }> {
  const dir = join(workspaceRoot, ".blueprint", "specs");
  await mkdir(dir, { recursive: true });

  const dateStr = spec.createdAt.slice(0, 10);
  const baseName = `${dateStr}_${spec.slug}`;
  const jsonPath = join(dir, `${baseName}.json`);
  const markdownPath = join(dir, `${baseName}.md`);

  await writeFile(jsonPath, canonicalJson(spec));
  await writeFile(markdownPath, renderBlueprintMarkdown(spec, normalizeUserLanguage(spec.userLanguage)));

  return { jsonPath, markdownPath };
}
