import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export interface FacadeTool {
  description: string;
  args: z.ZodRawShape;
  execute: (args: never, context?: never) => Promise<unknown>;
}

export type ToolRegistry = Record<string, FacadeTool>;

export interface RegisteredWorkspace {
  id: string;
  path: string;
}

export interface FacadeResult {
  title: string;
  output: string;
  [key: string]: unknown;
}

export type FacadeLoader = (workspacePath: string) => Promise<ToolRegistry>;

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === "bigint") return candidate.toString();
      if (typeof candidate === "function" || typeof candidate === "symbol" || typeof candidate === "undefined") return String(candidate);
      return candidate;
    });
    return serialized ?? "null";
  } catch {
    return "[unserializable output]";
  }
}

function asFacadeResult(value: unknown): FacadeResult {
  if (typeof value === "object" && value !== null && "title" in value && "output" in value) {
    const candidate = value as { title: unknown; output: unknown };
    return {
      title: typeof candidate.title === "string" ? candidate.title : safeJson(candidate.title),
      output: typeof candidate.output === "string" ? candidate.output : safeJson(candidate.output),
    };
  }
  return { title: "mr-orchestrator result", output: safeJson(value) };
}

export function toMcpSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(z.object(shape), { target: "draft-7" });
  if (jsonSchema.type !== "object") {
    throw new Error("Facade tool args must convert to an object JSON Schema.");
  }
  const { $schema: draft, "~standard": standard, ...mcpSchema } = jsonSchema;
  void draft;
  void standard;
  return mcpSchema;
}

export function toMcpResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: FacadeResult;
} {
  const result = asFacadeResult(value);
  return {
    content: [{ type: "text", text: `${result.title}\n\n${result.output}` }],
    structuredContent: result,
  };
}

export interface Bridge {
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  listTools(): Promise<Record<string, FacadeTool>>;
  boundWorkspace(): RegisteredWorkspace | undefined;
}

export function createBridge(loader: FacadeLoader, workspaces: RegisteredWorkspace[] = []): Bridge {
  let bound: RegisteredWorkspace | undefined;
  let tools: ToolRegistry | undefined;

  async function bind(args: Record<string, unknown>): Promise<FacadeResult> {
    const requestedId = typeof args["workspaceId"] === "string" ? args["workspaceId"] : undefined;
    const requestedPath = typeof args["workspacePath"] === "string" ? args["workspacePath"] : undefined;
    if ((requestedId === undefined && requestedPath === undefined) || (requestedId !== undefined && requestedPath !== undefined)) {
      throw new Error("Provide exactly one of workspaceId or workspacePath to bind a registered workspace.");
    }
    const match = workspaces.find((workspace) => workspace.id === requestedId || workspace.path === requestedPath);
    if (match === undefined) {
      throw new Error("Workspace is not registered. Register it with the immutable mr-orchestrator installation before binding.");
    }
    bound = match;
    tools = await loader(match.path);
    return { title: "Workspace Bound", output: `Bound mr-orchestrator to ${match.id} at ${match.path}.` };
  }

  return {
    async call(name, args) {
      if (name === "mr_bind_workspace") return bind(args);
      if (bound === undefined || tools === undefined) {
        throw new Error("Bind a registered workspace first with mr_bind_workspace using workspaceId or workspacePath. No current directory is assumed.");
      }
      const tool = tools[name];
      if (tool === undefined) throw new Error(`Unknown mr-orchestrator tool '${name}'.`);
      return await Reflect.apply(tool.execute, undefined, [args]);
    },
    async listTools() {
      const registry = tools ?? await (async () => {
        const entries: ToolRegistry = {};
        return entries;
      })();
      return registry;
    },
    boundWorkspace() {
      return bound;
    },
  };
}

const bindSchema = z.object({
  workspaceId: z.string().optional().describe("Registered mr-orchestrator workspace id"),
  workspacePath: z.string().optional().describe("Registered mr-orchestrator workspace root"),
});

export async function createMcpBridge(loader: FacadeLoader, workspaces: RegisteredWorkspace[]): Promise<McpServer> {
  const bridge = createBridge(loader, workspaces);
  const server = new McpServer(
    {
      name: "mr-orchestrator-bridge",
      version: "0.1.0",
    },
    {
      instructions: "Before any mr-orchestrator tool call, call mr_bind_workspace with one registered workspaceId or workspacePath. The bridge never assumes a current working directory.",
    },
  );

  server.registerTool(
    "mr_bind_workspace",
    {
      description: "Bind this MCP session to one registered mr-orchestrator workspace before calling any forwarded tool.",
      inputSchema: bindSchema,
    },
    async (args) => toMcpResult(await bridge.call("mr_bind_workspace", args)),
  );

  const toolRegistry = await loaderForToolListing(loader, workspaces);
  for (const [name, tool] of Object.entries(toolRegistry)) {
    server.registerTool(
      name,
      {
        description: tool.description,
        inputSchema: tool.args,
      },
      async (args) => {
        try {
          return toMcpResult(await bridge.call(name, Object.fromEntries(Object.entries(args))));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown bridge error.";
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }
  return server;
}

async function loaderForToolListing(loader: FacadeLoader, workspaces: RegisteredWorkspace[]): Promise<ToolRegistry> {
  const first = workspaces[0];
  if (first === undefined) return {};
  return loader(first.path);
}

export async function serveStdio(loader: FacadeLoader, workspaces: RegisteredWorkspace[]): Promise<void> {
  const server = await createMcpBridge(loader, workspaces);
  await server.connect(new StdioServerTransport());
}
