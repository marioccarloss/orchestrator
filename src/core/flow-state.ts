import { join } from "node:path";
import { atomicWrite, canonicalJson, readJson } from "./files.js";
import type { MrPaths } from "./paths.js";
import {
  FlowStateSchema,
  type FlowState,
  type FlowEvent,
  transition,
} from "./flow-schema.js";

const FLOW_STATE_FILE = "flow-state.json";
const FLOW_EVENTS_FILE = "events.jsonl";

export function flowStatePath(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, FLOW_STATE_FILE);
}

export function flowEventsPath(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, FLOW_EVENTS_FILE);
}

export interface FlowEventRecord {
  readonly timestamp: string;
  readonly event: FlowEvent;
}

export async function appendFlowEvent(paths: MrPaths, workspaceId: string, event: FlowEvent, timestamp?: string): Promise<FlowEventRecord> {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const filePath = flowEventsPath(paths, workspaceId);
  await mkdir(join(paths.generatedRoot, workspaceId), { recursive: true });
  const record: FlowEventRecord = {
    timestamp: timestamp ?? new Date().toISOString(),
    event,
  };
  const entry = JSON.stringify(record) + "\n";
  await appendFile(filePath, entry, "utf8");
  return record;
}

export async function loadFlowEvents(paths: MrPaths, workspaceId: string): Promise<FlowEventRecord[]> {
  const { readFile } = await import("node:fs/promises");
  try {
    const content = await readFile(flowEventsPath(paths, workspaceId), "utf8");
    const lines = content.trim().split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line) => JSON.parse(line) as FlowEventRecord);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function replayFromOrigin(eventRecords: FlowEventRecord[], workspaceId: string): FlowState {
  if (eventRecords.length === 0) {
    throw new Error("Cannot replay empty event stream.");
  }
  let current: FlowState | undefined;
  for (const record of eventRecords) {
    const event = record.event;
    if (current === undefined) {
      if (event.type === "start") {
        const initial: FlowState = {
          phase: "init",
          schemaVersion: 1,
          workspaceId,
          startedAt: record.timestamp,
        };
        current = transition(initial, event);
        continue;
      }
      if (event.type === "wizard_complete") {
        const initial: FlowState = {
          phase: "init",
          schemaVersion: 1,
          workspaceId,
          startedAt: record.timestamp,
        };
        const wizardState = transition(initial, { type: "start", workspaceId });
        current = transition(wizardState, event);
        continue;
      }
      throw new Error(`Unexpected first event in replay: ${event.type}`);
    }
    current = transition(current, event);
  }
  if (!current) {
    throw new Error("Replay produced empty state.");
  }
  return current;
}

export async function loadFlowState(paths: MrPaths, workspaceId: string): Promise<FlowState | undefined> {
  try {
    return await readJson(flowStatePath(paths, workspaceId), FlowStateSchema);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function saveFlowState(paths: MrPaths, workspaceId: string, state: FlowState): Promise<void> {
  const valid = FlowStateSchema.parse(state);
  await atomicWrite(flowStatePath(paths, workspaceId), canonicalJson(valid));
}

export async function clearFlowState(paths: MrPaths, workspaceId: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(flowStatePath(paths, workspaceId));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await unlink(flowEventsPath(paths, workspaceId));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function applyEvent(
  paths: MrPaths,
  workspaceId: string,
  event: FlowEvent,
): Promise<FlowState> {
  const current = await loadFlowState(paths, workspaceId);
  if (current === undefined) {
    if (event.type === "start") {
      const startedAt = new Date().toISOString();
      const initial: FlowState = {
        phase: "init",
        schemaVersion: 1,
        workspaceId,
        startedAt,
      };
      const next = transition(initial, event);
      await appendFlowEvent(paths, workspaceId, event, startedAt);
      await saveFlowState(paths, workspaceId, next);
      return next;
    }
    if (event.type === "wizard_complete") {
      const startedAt = new Date().toISOString();
      const initial: FlowState = {
        phase: "init",
        schemaVersion: 1,
        workspaceId,
        startedAt,
      };
      const wizardState = transition(initial, { type: "start", workspaceId });
      const next = transition(wizardState, event);
      await appendFlowEvent(paths, workspaceId, { type: "start", workspaceId }, startedAt);
      await appendFlowEvent(paths, workspaceId, event, startedAt);
      await saveFlowState(paths, workspaceId, next);
      return next;
    }
    throw new Error("No active flow. Start with `mr flow start`.");
  }
  const next = transition(current, event);
  await appendFlowEvent(paths, workspaceId, event);
  await saveFlowState(paths, workspaceId, next);
  return next;
}

export function isFlowActive(state: FlowState | undefined): boolean {
  return state !== undefined && state.phase !== "finish";
}

export function isFlowComplete(state: FlowState | undefined): boolean {
  return state !== undefined && state.phase === "finish";
}

export { requiresJudgment } from "./flow-schema.js";
