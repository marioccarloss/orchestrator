import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { MrPaths } from "./paths.js";
import { computeGitStamp } from "./atlas.js";
import { canonicalJson, atomicWrite } from "./files.js";

export const MemoryObservationSchema = z.object({
  id: z.string(),
  topic: z.string(),
  content: z.string(),
  gitStamp: z.string().optional(),
  recordedAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type MemoryObservation = z.infer<typeof MemoryObservationSchema>;

export const MemoryStoreSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string(),
  records: z.array(MemoryObservationSchema),
});

export type MemoryStore = z.infer<typeof MemoryStoreSchema>;

export interface MemoryQueryOptions {
  readonly topic?: string | undefined;
  readonly query?: string | undefined;
  readonly validateFreshness?: boolean | undefined;
}

export interface MemoryQueryResult {
  readonly observation: MemoryObservation;
  readonly isStale: boolean;
}

export class PersistentMemoryStore {
  constructor(
    private readonly paths: MrPaths,
    private readonly workspaceId: string,
    private readonly workspaceRoot: string
  ) {}

  private getStoreFilePath(): string {
    return join(this.paths.dataRoot, this.workspaceId, "memory-store.json");
  }

  async load(): Promise<MemoryStore> {
    const filePath = this.getStoreFilePath();
    if (!existsSync(filePath)) {
      return {
        schemaVersion: 1,
        workspaceId: this.workspaceId,
        records: [],
      };
    }
    try {
      const raw = await readFile(filePath, "utf8");
      return MemoryStoreSchema.parse(JSON.parse(raw));
    } catch {
      return {
        schemaVersion: 1,
        workspaceId: this.workspaceId,
        records: [],
      };
    }
  }

  async saveObservation(
    topic: string,
    content: string,
    metadata: Record<string, unknown> = {}
  ): Promise<MemoryObservation> {
    const currentStamp = computeGitStamp(this.workspaceRoot);
    const store = await this.load();
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const observation: MemoryObservation = {
      id,
      topic,
      content,
      gitStamp: currentStamp,
      recordedAt: new Date().toISOString(),
      metadata,
    };

    const updatedRecords = [...store.records, observation];
    const updatedStore: MemoryStore = {
      ...store,
      records: updatedRecords,
    };

    await atomicWrite(this.getStoreFilePath(), canonicalJson(updatedStore));
    return observation;
  }

  async query(options: MemoryQueryOptions = {}): Promise<readonly MemoryQueryResult[]> {
    const store = await this.load();
    const currentStamp = computeGitStamp(this.workspaceRoot);

    const filtered = store.records.filter((rec) => {
      if (options.topic && !rec.topic.includes(options.topic)) {
        return false;
      }
      if (options.query && !rec.content.toLowerCase().includes(options.query.toLowerCase())) {
        return false;
      }
      return true;
    });

    return filtered.map((observation) => {
      // Invalidate / mark stale if gitStamp differs from current workspace tree
      const isStale =
        options.validateFreshness !== false &&
        Boolean(currentStamp && observation.gitStamp && observation.gitStamp !== currentStamp);
      return {
        observation,
        isStale,
      };
    });
  }
}
