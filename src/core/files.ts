import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function atomicWrite(path: string, content: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await rename(temporary, path);
}

export async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const content = await readFile(path, "utf8");
  return schema.parse(JSON.parse(content) as unknown);
}

export async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      throw error;
    }
  }
}
