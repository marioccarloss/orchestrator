export const HARNESS_IDS = [
  "opencode",
  "codex",
  "cursor",
  "claude",
  "antigravity",
  "agy",
  "fx",
] as const;

export type HarnessId = typeof HARNESS_IDS[number];

export function parseHarnessId(value: string | undefined): HarnessId {
  if (value !== undefined && HARNESS_IDS.includes(value as HarnessId)) return value as HarnessId;
  throw new Error(`A valid --harness is required (${HARNESS_IDS.join(", ")})`);
}

export function resolveHarnessIdentity(argumentValue: string | undefined, environmentValue: string | undefined): HarnessId {
  const argumentHarness = argumentValue === undefined ? undefined : parseHarnessId(argumentValue);
  const environmentHarness = environmentValue === undefined ? undefined : parseHarnessId(environmentValue);
  if (argumentHarness !== undefined && environmentHarness !== undefined && argumentHarness !== environmentHarness) {
    throw new Error(`Conflicting harness identities: --harness=${argumentHarness}, MR_HARNESS_ID=${environmentHarness}`);
  }
  const resolved = argumentHarness ?? environmentHarness;
  if (resolved === undefined) return parseHarnessId(undefined);
  return resolved;
}
