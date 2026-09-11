import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const TicketPlatformSchema = z.enum(["github", "jira", "gitlab"]);

export const WorkspaceProfileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
  name: z.string().min(1),
  root: z.string().min(1),
  contextRoot: z.string().min(1),
  ticket: z
    .object({
      platform: TicketPlatformSchema,
      mcpServer: z.string().min(1),
    })
    .optional(),
});

export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;

export const WorkspaceRegistrySchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  workspaces: z.array(WorkspaceProfileSchema),
});

export type WorkspaceRegistry = z.infer<typeof WorkspaceRegistrySchema>;

export const FlowRoleSchema = z.enum([
  "orchestrator",
  "explore",
  "plan",
  "general",
  "sddApply",
  "judgeA",
  "judgeB",
  "fix",
]);

export type FlowRole = z.infer<typeof FlowRoleSchema>;

export const BlueprintRoleSchema = z.enum([
  "bpExtractor",
  "bpArchitect",
  "bpTransactor",
]);

export type BlueprintRole = z.infer<typeof BlueprintRoleSchema>;

export const ModelRoleSchema = z.enum([
  "orchestrator",
  "explore",
  "plan",
  "general",
  "sddApply",
  "judgeA",
  "judgeB",
  "fix",
  "bpExtractor",
  "bpArchitect",
  "bpTransactor",
]);

export const ModelReferenceSchema = z.string().regex(/^[^\s/]+\/[^\s#]+$/u);
export const ModelVariantSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

export const ModelTargetSchema = z.object({
  model: ModelReferenceSchema,
  variant: ModelVariantSchema.optional(),
});

export const ModelAssignmentSchema = ModelTargetSchema.extend({
  alternative: ModelTargetSchema,
});

export const ModelMapSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  roles: z.record(ModelRoleSchema, ModelAssignmentSchema),
});

export type ModelTarget = z.infer<typeof ModelTargetSchema>;
export type ModelAssignment = z.infer<typeof ModelAssignmentSchema>;
export type ModelMap = z.infer<typeof ModelMapSchema>;

export const ManifestFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const InstallManifestSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  version: z.string().min(1),
  installedAt: z.iso.datetime(),
  sourceRoot: z.string().min(1),
  files: z.array(ManifestFileSchema),
});

export type InstallManifest = z.infer<typeof InstallManifestSchema>;
