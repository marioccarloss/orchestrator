import * as p from "@clack/prompts";

export function heading(message: string): void {
  p.intro(message);
}

export function success(message: string): void {
  p.outro(message);
}

export function info(message: string): void {
  p.log.info(message);
}

export function warning(message: string): void {
  p.log.warn(message);
}

export function failure(message: string): void {
  p.log.error(message);
}

export async function approve(message: string): Promise<boolean> {
  const answer = await p.confirm({ message, initialValue: false });
  if (p.isCancel(answer)) {
    p.cancel("Cancelled.");
    return false;
  }
  return answer;
}
