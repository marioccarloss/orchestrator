import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBridge, toMcpResult, toMcpSchema } from "../src/bridge.js";
import { loadPluginFacade } from "../src/facade.js";

const registry = {
  mr_echo: {
    description: "Echo a message",
    args: { message: z.string() },
    execute: async (args: { message: string }) => ({ title: "Echo", output: args.message }),
  },
};

test("converts facade tool schemas and results to MCP-safe values", async () => {
  expect(toMcpSchema(registry.mr_echo.args)).toEqual({
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  });
  expect(toMcpResult(await registry.mr_echo.execute({ message: "hello" }))).toEqual({
    content: [{ type: "text", text: "Echo\n\nhello" }],
    structuredContent: { title: "Echo", output: "hello" },
  });
});

test("loads the immutable compiled plugin as a tool facade", async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), "mr-clients-facade-"));
  const tools = await loadPluginFacade(workspacePath);

  expect(tools["mr_flow_status"]?.description).toBe("Get the current mr-orchestrator flow status");
  expect(tools["mr_flow_status"]?.args).toEqual({});
  expect(tools["mr_flow_start"]?.args).toHaveProperty("ticketId");
  expect(typeof tools["mr_blueprint_save"]?.execute).toBe("function");
});

test("rejects forwarded tools until a registered workspace is explicitly bound", async () => {
  const bridge = createBridge(async () => registry, "cursor");

  await expect(bridge.call("mr_echo", { message: "hello" })).rejects.toThrow(
    "Bind a registered workspace first",
  );
});

test("forwards calls through the facade after binding by workspace id", async () => {
  const bridge = createBridge(async () => registry, "cursor", [{ id: "workspace-a", path: "/tmp/workspace-a" }]);

  await bridge.call("mr_bind_workspace", { workspaceId: "workspace-a" });

  await expect(bridge.call("mr_echo", { message: "hello" })).resolves.toEqual({
    title: "Echo",
    output: "hello",
  });
  expect(bridge.harness()).toBe("cursor");
});

test("injects the trusted bridge harness into model operations", async () => {
  const received: Record<string, unknown>[] = [];
  const bridge = createBridge(async () => ({
    mr_models: {
      description: "Models",
      args: {},
      execute: async (args: Record<string, unknown>) => {
        received.push(args);
        return { title: "Models", output: "ok" };
      },
    },
  }), "codex", [{ id: "workspace-a", path: "/tmp/workspace-a" }]);
  await bridge.call("mr_bind_workspace", { workspaceId: "workspace-a" });
  await bridge.call("mr_models", { action: "status" });
  await bridge.call("mr_models", { action: "status", harness: "cursor" });
  expect(received).toEqual([
    { action: "status", harness: "codex" },
    { action: "status", harness: "codex" },
  ]);
});
