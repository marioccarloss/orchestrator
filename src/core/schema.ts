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

export const MODEL_ROLES = [
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
] as const;

export const ModelRoleSchema = z.enum(MODEL_ROLES);

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

export const HARNESS_IDS = [
  "opencode",
  "codex",
  "cursor",
  "claude",
  "antigravity",
  "agy",
  "fx",
] as const;

export const HarnessIdSchema = z.enum(HARNESS_IDS);
export const HarnessApplicationModeSchema = z.enum([
  "native-role",
  "per-invocation",
  "session-only",
  "unsupported",
]);

export const HarnessRoleOverrideSchema = z.object({
  primary: ModelTargetSchema.optional(),
  alternative: ModelTargetSchema.optional(),
}).strict().refine(
  (value) => value.primary !== undefined || value.alternative !== undefined,
  { message: "A harness role override requires primary or alternative" },
);

export const HarnessModelOverrideSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  harness: HarnessIdSchema,
  roles: z.partialRecord(ModelRoleSchema, HarnessRoleOverrideSchema),
}).strict();

export const HarnessCatalogModelSchema = z.object({
  nativeModel: z.string().min(1),
  variants: z.record(ModelVariantSchema, z.string().min(1)).optional(),
}).strict();

export const HarnessModelCatalogSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  harness: HarnessIdSchema,
  applicationMode: HarnessApplicationModeSchema,
  models: z.record(ModelReferenceSchema, HarnessCatalogModelSchema),
  provenance: z.object({
    source: z.enum(["explicit", "discovered", "seed", "legacy-identity"]),
    refreshedAt: z.iso.datetime().optional(),
  }).strict(),
}).strict();

export type HarnessId = z.infer<typeof HarnessIdSchema>;
export type HarnessApplicationMode = z.infer<typeof HarnessApplicationModeSchema>;
export type HarnessRoleOverride = z.infer<typeof HarnessRoleOverrideSchema>;
export type HarnessModelOverride = z.infer<typeof HarnessModelOverrideSchema>;
export type HarnessCatalogModel = z.infer<typeof HarnessCatalogModelSchema>;
export type HarnessModelCatalog = z.infer<typeof HarnessModelCatalogSchema>;

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
