import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { MrPaths } from "./paths.js";

// ─── Figma Cache Types ───────────────────────────────────────────────────────

export interface FigmaFile {
  readonly key: string;
  readonly name: string;
  readonly lastModified: string;
  readonly thumbnailUrl?: string;
  readonly nodes: readonly FigmaNode[];
}

export interface FigmaNode {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly componentProperties?: Record<string, unknown>;
  readonly children?: readonly FigmaNode[];
}

export interface FigmaCacheEntry {
  readonly schemaVersion: 1;
  readonly key: string;
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly ttlSeconds: number;
  readonly data: FigmaFile;
}

// ─── Figma MCP Adapter ───────────────────────────────────────────────────────

export class FigmaMcpAdapter {
  constructor(private readonly mcpServer = "framelink_figma") {}

  async fetchFile(fileKey: string): Promise<FigmaFile> {
    // MCP integration would go here
    // For now, return a stub that indicates MCP usage
    return {
      key: fileKey,
      name: `[Figma ${fileKey}]`,
      lastModified: new Date().toISOString(),
      nodes: [],
    };
  }

  async fetchNode(fileKey: string, nodeId: string): Promise<FigmaNode | undefined> {
    const file = await this.fetchFile(fileKey);
    return this.findNode(file.nodes, nodeId);
  }

  private findNode(nodes: readonly FigmaNode[], id: string): FigmaNode | undefined {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children !== undefined) {
        const found = this.findNode(node.children, id);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }
}

// ─── Figma Cache ─────────────────────────────────────────────────────────────

const FIGMA_CACHE_DIR = "figma";
const DEFAULT_TTL_SECONDS = 3600; // 1 hour

export class FigmaCache {
  constructor(private readonly paths: MrPaths, private readonly workspaceId: string) {}

  private cachePath(fileKey: string): string {
    return join(this.paths.cacheRoot, this.workspaceId, FIGMA_CACHE_DIR, `${fileKey}.json`);
  }

  private hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  async get(fileKey: string): Promise<FigmaFile | undefined> {
    const path = this.cachePath(fileKey);
    if (!existsSync(path)) return undefined;

    try {
      const content = await readFile(path, "utf8");
      const entry = JSON.parse(content) as FigmaCacheEntry;

      // Check TTL
      const fetchedAt = new Date(entry.fetchedAt).getTime();
      const now = Date.now();
      if (now - fetchedAt > entry.ttlSeconds * 1000) {
        return undefined; // Expired
      }

      return entry.data;
    } catch {
      return undefined;
    }
  }

  async set(fileKey: string, data: FigmaFile, ttlSeconds: number = DEFAULT_TTL_SECONDS): Promise<void> {
    const path = this.cachePath(fileKey);
    await mkdir(dirname(path), { recursive: true });

    const entry: FigmaCacheEntry = {
      schemaVersion: 1,
      key: fileKey,
      contentHash: this.hashContent(JSON.stringify(data)),
      fetchedAt: new Date().toISOString(),
      ttlSeconds,
      data,
    };

    await writeFile(path, JSON.stringify(entry, null, 2));
  }

  async invalidate(fileKey: string): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    const path = this.cachePath(fileKey);
    try {
      await unlink(path);
    } catch {
      // Ignore if doesn't exist
    }
  }

  async clear(): Promise<void> {
    const { rm } = await import("node:fs/promises");
    const dir = join(this.paths.cacheRoot, this.workspaceId, FIGMA_CACHE_DIR);
    try {
      await rm(dir, { recursive: true });
    } catch {
      // Ignore if doesn't exist
    }
  }
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : ".";
}

// ─── E2E Test Harness ────────────────────────────────────────────────────────

export interface E2ETestCase {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly expectedExitCode: number;
  readonly expectedStdout?: string | RegExp;
  readonly expectedStderr?: string | RegExp;
  readonly timeoutMs?: number;
}

export interface E2EResult {
  readonly name: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly error?: string | undefined;
}

export async function runE2ETest(testCase: E2ETestCase): Promise<E2EResult> {
  const { spawnSync } = await import("node:child_process");
  const start = Date.now();

  try {
    const result = spawnSync(testCase.command, [...testCase.args], {
      encoding: "utf8",
      timeout: testCase.timeoutMs ?? 30_000,
    });

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const exitCode = result.status;
    const durationMs = Date.now() - start;

    let passed = exitCode === testCase.expectedExitCode;
    let error: string | undefined;

    if (passed && testCase.expectedStdout !== undefined) {
      if (typeof testCase.expectedStdout === "string") {
        passed = stdout.includes(testCase.expectedStdout);
        if (!passed) error = `Expected stdout to contain "${testCase.expectedStdout}"`;
      } else {
        passed = testCase.expectedStdout.test(stdout);
        if (!passed) error = `Expected stdout to match ${testCase.expectedStdout}`;
      }
    }

    if (passed && testCase.expectedStderr !== undefined) {
      if (typeof testCase.expectedStderr === "string") {
        passed = stderr.includes(testCase.expectedStderr);
        if (!passed) error = `Expected stderr to contain "${testCase.expectedStderr}"`;
      } else {
        passed = testCase.expectedStderr.test(stderr);
        if (!passed) error = `Expected stderr to match ${testCase.expectedStderr}`;
      }
    }

    return {
      name: testCase.name,
      passed,
      exitCode,
      stdout,
      stderr,
      durationMs,
      error,
    };
  } catch (err: unknown) {
    return {
      name: testCase.name,
      passed: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runE2ESuite(testCases: readonly E2ETestCase[]): Promise<readonly E2EResult[]> {
  const results: E2EResult[] = [];
  for (const testCase of testCases) {
    results.push(await runE2ETest(testCase));
  }
  return results;
}

export function formatE2EResults(results: readonly E2EResult[]): string {
  const lines = ["# E2E Test Results", ""];
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  lines.push(`**Total**: ${results.length} | **Passed**: ${passed} | **Failed**: ${failed}`);
  lines.push("");

  for (const result of results) {
    const icon = result.passed ? "✅" : "❌";
    lines.push(`${icon} ${result.name} (${result.durationMs}ms)`);
    if (result.error !== undefined) {
      lines.push(`   Error: ${result.error}`);
    }
  }

  return lines.join("\n");
}
