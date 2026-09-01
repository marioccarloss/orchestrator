import { spawn, spawnSync } from "node:child_process";

export interface CommandResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCommand(command: string, arguments_: readonly string[], env: NodeJS.ProcessEnv = process.env): CommandResult {
  const result = spawnSync(command, [...arguments_], { encoding: "utf8", env });
  return {
    ok: result.status === 0,
    status: result.status ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

export function spawnInteractive(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<number> {
  const child = spawn(command, [...arguments_], { ...options, stdio: "inherit" });
  return new Promise<number>((resolve, reject) => {
    child.once("error", (error) => { reject(error); });
    child.once("exit", (code, signal) => { resolve(code ?? (signal === null ? 1 : 128)); });
  });
}
