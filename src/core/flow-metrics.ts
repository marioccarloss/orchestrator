import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWrite, canonicalJson } from "./files.js";
import type { MrPaths } from "./paths.js";

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
  tokens: TokenUsageSchema,
});

export const FlowMetricsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ticketId: z.string().min(1),
  flowStartedAt: z.iso.datetime(),
  status: z.enum(["active", "completed", "aborted"]),
  sessionIDs: z.array(z.string().min(1)),
  messages: z.record(z.string(), MessageUsageSchema),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});

export type FlowMetrics = z.infer<typeof FlowMetricsSchema>;

export interface AssistantUsageUpdate {
  readonly id: string;
  readonly sessionID: string;
  readonly providerID: string;
  readonly modelID: string;
  readonly cost: number;
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
): Promise<FlowMetrics> {
  const now = new Date().toISOString();
  const metrics = FlowMetricsSchema.parse({
    schemaVersion: 1,
    ticketId,
    flowStartedAt,
    status: "active",
    sessionIDs: [sessionID],
    messages: {},
    updatedAt: now,
  });
  await saveFlowMetrics(paths, workspaceId, metrics);
  return metrics;
}

export async function bindFlowSession(
  paths: MrPaths,
  workspaceId: string,
  sessionID: string,
): Promise<FlowMetrics | undefined> {
  const current = await loadFlowMetrics(paths, workspaceId);
  if (current === undefined || current.sessionIDs.includes(sessionID)) return current;
  const updated = FlowMetricsSchema.parse({
    ...current,
    sessionIDs: [...current.sessionIDs, sessionID],
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
  await bindFlowSession(paths, workspaceId, childSessionID);
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
  };
}
