import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import { ContextRoleSchema, type ContextRole } from "./budgets.js";
import { RiskLaneSchema, type RiskLane } from "./risk.js";
import { UserLanguageSchema, type UserLanguage } from "./language.js";

const TokenUsageSchema = z.strictObject({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  reasoning: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

const MessageUsageSchema = z.strictObject({
  sessionID: z.string().min(1),
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  cost: z.number().nonnegative(),
  role: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  tokens: TokenUsageSchema,
});

const ContextHydrationUsageSchema = z.strictObject({
  role: ContextRoleSchema,
  lane: RiskLaneSchema,
  taskId: z.string().min(1).optional(),
  requestedChars: z.number().int().positive(),
  usedChars: z.number().int().nonnegative(),
  truncated: z.number().int().nonnegative(),
  recordedAt: z.iso.datetime(),
});

export const FlowMetricsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  flowStartedAt: z.iso.datetime(),
  userLanguage: UserLanguageSchema.optional(),
  status: z.enum(["active", "completed", "aborted"]),
  sessionIDs: z.array(z.string().min(1)),
  messages: z.record(z.string(), MessageUsageSchema),
  hydrations: z.array(ContextHydrationUsageSchema).default([]),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});

export type FlowMetrics = z.infer<typeof FlowMetricsSchema>;
export type ContextHydrationUsage = z.infer<typeof ContextHydrationUsageSchema>;

export interface AssistantUsageUpdate {
  readonly id: string;
  readonly sessionID: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly cost: number;
  readonly role?: string;
  readonly taskId?: string;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: {
      readonly read: number;
      readonly write: number;
    };
  };
}

export interface FlowUsageSummary {
  readonly ticketId: string;
  readonly status: FlowMetrics["status"];
  readonly cost: number;
  readonly messages: number;
  readonly sessions: number;
  readonly tokens: z.infer<typeof TokenUsageSchema>;
  readonly context?: {
    readonly role: ContextRole;
    readonly lane: RiskLane;
    readonly requestedChars: number;
    readonly usedChars: number;
    readonly truncated: number;
    readonly hydrations: number;
  };
}

function flowMetricsPath(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, "flow-metrics.json");
}

async function saveFlowMetrics(paths: MrPaths, workspaceId: string, metrics: FlowMetrics): Promise<void> {
  await atomicWrite(flowMetricsPath(paths, workspaceId), canonicalJson(FlowMetricsSchema.parse(metrics)));
}

export async function loadFlowMetrics(paths: MrPaths, workspaceId: string): Promise<FlowMetrics | undefined> {
  try {
    const parsed = FlowMetricsSchema.safeParse(JSON.parse(await readFile(flowMetricsPath(paths, workspaceId), "utf8")) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function startFlowMetrics(
  paths: MrPaths,
  workspaceId: string,
  ticketId: string,
  flowStartedAt: string,
  sessionID: string,
  userLanguage?: UserLanguage,
): Promise<FlowMetrics> {
  const now = new Date().toISOString();
  const metrics = FlowMetricsSchema.parse({
    schemaVersion: 1,
    ticketId,
    flowStartedAt,
    ...(userLanguage === undefined ? {} : { userLanguage }),
    status: "active",
    sessionIDs: [sessionID],
    messages: {},
    hydrations: [],
    updatedAt: now,
  });
  await saveFlowMetrics(paths, workspaceId, metrics);
  return metrics;
}

export async function bindFlowSession(
  paths: MrPaths,
  workspaceId: string,
  sessionID: string,
  userLanguage?: UserLanguage,
): Promise<FlowMetrics | undefined> {
  const current = await loadFlowMetrics(paths, workspaceId);
  if (current === undefined) return current;
  const hasSession = current.sessionIDs.includes(sessionID);
  if (hasSession && (userLanguage === undefined || current.userLanguage === userLanguage)) return current;
  const updated = FlowMetricsSchema.parse({
    ...current,
    sessionIDs: hasSession ? current.sessionIDs : [...current.sessionIDs, sessionID],
    ...(userLanguage === undefined ? {} : { userLanguage }),
    updatedAt: new Date().toISOString(),
  });
  await saveFlowMetrics(paths, workspaceId, updated);
  return updated;
}

export async function bindChildFlowSession(
  paths: MrPaths,
  workspaceId: string,
  parentSessionID: string,
  childSessionID: string,
): Promise<boolean> {
  const current = await loadFlowMetrics(paths, workspaceId);
  if (!current?.sessionIDs.includes(parentSessionID)) return false;
  await bindFlowSession(paths, workspaceId, childSessionID, current.userLanguage);
  return true;
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function recordFlowAssistantUsage(
  paths: MrPaths,
  workspaceId: string,
  update: AssistantUsageUpdate,
): Promise<boolean> {
  const current = await loadFlowMetrics(paths, workspaceId);
  if (!current?.sessionIDs.includes(update.sessionID)) return false;
  const previous = current.messages[update.id];
  const message = MessageUsageSchema.parse({
    sessionID: update.sessionID,
    providerID: update.providerID,
    modelID: update.modelID,
    cost: Math.max(previous?.cost ?? 0, finiteNonNegative(update.cost)),
    ...(update.role === undefined ? (previous?.role === undefined ? {} : { role: previous.role }) : { role: update.role }),
    ...(update.taskId === undefined ? (previous?.taskId === undefined ? {} : { taskId: previous.taskId }) : { taskId: update.taskId }),
    tokens: {
      input: Math.max(previous?.tokens.input ?? 0, finiteNonNegative(update.tokens.input)),
      output: Math.max(previous?.tokens.output ?? 0, finiteNonNegative(update.tokens.output)),
      reasoning: Math.max(previous?.tokens.reasoning ?? 0, finiteNonNegative(update.tokens.reasoning)),
      cacheRead: Math.max(previous?.tokens.cacheRead ?? 0, finiteNonNegative(update.tokens.cache.read)),
      cacheWrite: Math.max(previous?.tokens.cacheWrite ?? 0, finiteNonNegative(update.tokens.cache.write)),
    },
  });
  await saveFlowMetrics(paths, workspaceId, FlowMetricsSchema.parse({
    ...current,
    messages: { ...current.messages, [update.id]: message },
    updatedAt: new Date().toISOString(),
  }));
  return true;
}

export async function recordContextHydration(
  paths: MrPaths,
  workspaceId: string,
  usage: Omit<ContextHydrationUsage, "recordedAt">,
): Promise<boolean> {
  const current = await loadFlowMetrics(paths, workspaceId);
  if (current === undefined) return false;
  const hydration = ContextHydrationUsageSchema.parse({ ...usage, recordedAt: new Date().toISOString() });
  const updated = FlowMetricsSchema.parse({
    ...current,
    hydrations: [...current.hydrations, hydration].slice(-100),
    updatedAt: hydration.recordedAt,
  });
  await saveFlowMetrics(paths, workspaceId, updated);
  return true;
}

export async function finalizeFlowMetrics(
  paths: MrPaths,
  workspaceId: string,
  status: "completed" | "aborted",
): Promise<FlowMetrics | undefined> {
  const current = await loadFlowMetrics(paths, workspaceId);
  if (current === undefined) return undefined;
  const now = new Date().toISOString();
  const updated = FlowMetricsSchema.parse({
    ...current,
    status,
    updatedAt: now,
    completedAt: now,
  });
  await saveFlowMetrics(paths, workspaceId, updated);
  return updated;
}

export function summarizeFlowMetrics(metrics: FlowMetrics): FlowUsageSummary {
  const messages = Object.values(metrics.messages);
  const latestContext = metrics.hydrations.at(-1);
  return {
    ticketId: metrics.ticketId,
    status: metrics.status,
    cost: messages.reduce((total, message) => total + message.cost, 0),
    messages: messages.length,
    sessions: metrics.sessionIDs.length,
    tokens: messages.reduce((total, message) => ({
      input: total.input + message.tokens.input,
      output: total.output + message.tokens.output,
      reasoning: total.reasoning + message.tokens.reasoning,
      cacheRead: total.cacheRead + message.tokens.cacheRead,
      cacheWrite: total.cacheWrite + message.tokens.cacheWrite,
    }), { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }),
    ...(latestContext === undefined ? {} : {
      context: {
        role: latestContext.role,
        lane: latestContext.lane,
        requestedChars: latestContext.requestedChars,
        usedChars: latestContext.usedChars,
        truncated: latestContext.truncated,
        hydrations: metrics.hydrations.length,
      },
    }),
  };
}
