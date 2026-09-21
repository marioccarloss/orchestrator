import { expect, test } from "bun:test";
import { roleCommand } from "../src/role-runner.js";

test("builds an fx invocation from the validated native role target", () => {
  const effective = {
    harness: "fx" as const,
    applicationMode: "per-invocation" as const,
    roles: {
      explore: {
        primary: { native: { model: "gpt-5.6-sol", variant: "high" } },
      },
    },
  } as never;

  expect(roleCommand(effective, "explore", "Inspect the router")).toEqual({
    command: "fx",
    arguments: ["ask", "--model", "gpt-5.6-sol", "--effort", "high", "Inspect the router"],
  });
});

test("builds verified per-invocation commands for Codex, Cursor, Claude, and AGY", () => {
  const assignment = { explore: { primary: { native: { model: "native-model", variant: "high" } } } };
  expect(roleCommand({ harness: "codex", applicationMode: "per-invocation", roles: assignment } as never, "explore", "task")).toEqual({
    command: "codex",
    arguments: ["exec", "--model", "native-model", "--config", 'model_reasoning_effort="high"', "task"],
  });
  expect(roleCommand({ harness: "cursor", applicationMode: "per-invocation", roles: assignment } as never, "explore", "task")).toEqual({
    command: "agent",
    arguments: ["--print", "--model", "native-model[effort=high]", "task"],
  });
  expect(roleCommand({ harness: "agy", applicationMode: "per-invocation", roles: assignment } as never, "explore", "task")).toEqual({
    command: "agy",
    arguments: ["--model", "native-model", "--effort", "high", "--print", "task"],
  });
  expect(roleCommand({ harness: "claude", applicationMode: "per-invocation", roles: assignment } as never, "explore", "task")).toEqual({
    command: "claude",
    arguments: ["--print", "--model", "native-model", "--effort", "high", "task"],
  });
});

test("builds a Pi invocation with optional thinking from the native role target", () => {
  const withThinking = { explore: { primary: { native: { model: "anthropic/claude-sonnet-4-6", variant: "high" } } } };
  expect(roleCommand({ harness: "pi", applicationMode: "per-invocation", roles: withThinking } as never, "explore", "Inspect the router")).toEqual({
    command: "pi",
    arguments: ["--print", "--no-session", "--model", "anthropic/claude-sonnet-4-6", "--thinking", "high", "--", "Inspect the router"],
  });

  const withoutThinking = { explore: { primary: { native: { model: "openai/gpt-4o-mini" } } } };
  expect(roleCommand({ harness: "pi", applicationMode: "per-invocation", roles: withoutThinking } as never, "explore", "Inspect the router")).toEqual({
    command: "pi",
    arguments: ["--print", "--no-session", "--model", "openai/gpt-4o-mini", "--", "Inspect the router"],
  });

  expect(roleCommand({ harness: "pi", applicationMode: "per-invocation", roles: withoutThinking } as never, "explore", "--help")).toEqual({
    command: "pi",
    arguments: ["--print", "--no-session", "--model", "openai/gpt-4o-mini", "--", "--help"],
  });
});
