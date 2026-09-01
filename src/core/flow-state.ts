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

export function flowStatePath(paths: MrPaths, workspaceId: string): string {
  return join(paths.generatedRoot, workspaceId, FLOW_STATE_FILE);
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
}

export async function applyEvent(
  paths: MrPaths,
  workspaceId: string,
  event: FlowEvent,
): Promise<FlowState> {
  const current = await loadFlowState(paths, workspaceId);
  if (current === undefined) {
    if (event.type === "start") {
      const initial: FlowState = {
        phase: "init",
        schemaVersion: 1,
        workspaceId,
        startedAt: new Date().toISOString(),
      };
      const next = transition(initial, event);
      await saveFlowState(paths, workspaceId, next);
      return next;
    }
    if (event.type === "wizard_complete") {
      const initial: FlowState = {
        phase: "init",
        schemaVersion: 1,
        workspaceId,
        startedAt: new Date().toISOString(),
      };
      const wizardState = transition(initial, { type: "start", workspaceId });
      const next = transition(wizardState, event);
      await saveFlowState(paths, workspaceId, next);
      return next;
    }
    throw new Error("No active flow. Start with `mr flow start`.");
  }
  const next = transition(current, event);
  await saveFlowState(paths, workspaceId, next);
  return next;
}

export function isFlowActive(state: FlowState | undefined): boolean {
  return state !== undefined && state.phase !== "finish";
}

export function isFlowComplete(state: FlowState | undefined): boolean {
  return state !== undefined && state.phase === "finish";
}

export function requiresJudgment(difficulty: number): boolean {
  return difficulty >= 5;
}
