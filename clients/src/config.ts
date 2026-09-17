import { applyEdits, modify, parse } from "jsonc-parser";

export interface McpServerConfig {
  command?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  url?: string;
  instructions?: string;
}

type JsonRecord = Record<string, unknown>;

const bindingInstruction = "Before using mr-orchestrator tools, call mr_bind_workspace with exactly one registered workspaceId or workspacePath. Never assume a current working directory.";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function commandConfig(value: JsonRecord): McpServerConfig | undefined {
  const command = value["command"];
  const args = value["args"];
  const env = value["environment"] ?? value["env"];
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    return { command, ...(isRecord(env) ? { env: stringRecord(env) } : {}) };
  }
  if (typeof command === "string") {
    const commandParts = [command, ...(Array.isArray(args) ? args.filter((part): part is string => typeof part === "string") : [])];
    return { command: commandParts, ...(isRecord(env) ? { env: stringRecord(env) } : {}) };
  }
  if (typeof value["url"] === "string") {
    const headers = value["headers"];
    return {
      url: value["url"],
      ...(isRecord(headers) ? { headers: stringRecord(headers) } : {}),
    };
  }
  return undefined;
}

function stringRecord(value: JsonRecord): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function parseOpenCodeCatalog(content: string): Record<string, McpServerConfig> {
  const root = asRecord(parse(content));
  const mcp = asRecord(root["mcp"]);
  return Object.fromEntries(
    Object.entries(mcp)
      .map(([name, config]) => [name, commandConfig(asRecord(config))] as const)
      .filter((entry): entry is [string, McpServerConfig] => entry[1] !== undefined),
  );
}

export function mergeOpenCodeCatalogs(contents: string[]): Record<string, McpServerConfig> {
  return Object.assign({}, ...contents.filter((content) => content.length > 0).map(parseOpenCodeCatalog));
}

type JsonHost = "cursor" | "antigravity" | "claude" | "fx";

function toHostServer(config: McpServerConfig, host: JsonHost | "codex"): JsonRecord {
  if (config.url !== undefined) {
    if (host === "fx") {
      return {
        type: "http",
        url: config.url,
        ...(config.headers === undefined || Object.keys(config.headers).length === 0 ? {} : { headers: config.headers }),
      };
    }
    const urlProperty = host === "antigravity" ? "serverUrl" : "url";
    const headersProperty = host === "codex" ? "http_headers" : "headers";
    return {
      [urlProperty]: config.url,
      ...(config.headers === undefined || Object.keys(config.headers).length === 0 ? {} : { [headersProperty]: config.headers }),
      ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
    };
  }
  const command = config.command ?? [];
  if (host === "fx") {
    return {
      type: "stdio",
      command,
      ...(config.env !== undefined && Object.keys(config.env).length > 0 ? { environment: config.env } : {}),
    };
  }
  return {
    command: command[0] ?? "",
    ...(command.length > 1 ? { args: command.slice(1) } : {}),
    ...(config.env !== undefined && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
    ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
  };
}

function mergeJsonConfig(
  content: string,
  property: "mcpServers" | "mcp",
  host: JsonHost,
  servers: Record<string, McpServerConfig>,
  bridges: Record<string, McpServerConfig>,
): string {
  let next = content.trim().length === 0 ? "{}\n" : content;
  const existing = asRecord(parse(next));
  const current = asRecord(existing[property]);
  const importedServers = Object.fromEntries(
    Object.entries(servers).filter(([name]) => name !== "mr-orchestrator" && !name.startsWith("mr-orchestrator-")),
  );
  const additions = {
    ...importedServers,
    ...Object.fromEntries(Object.entries(bridges).map(([name, bridge]) => [name, { ...bridge, instructions: bindingInstruction }])),
  };
  for (const [name, server] of Object.entries(additions)) {
    if (current[name] !== undefined) continue;
    const edits = modify(next, [property, name], toHostServer(server, host), {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    next = applyEdits(next, edits);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

export function mergeCursorConfig(content: string, servers: Record<string, McpServerConfig>, bridge: McpServerConfig): string {
  return mergeJsonConfig(content, "mcpServers", "cursor", servers, { "mr-orchestrator": bridge });
}

export function mergeAntigravityConfig(content: string, servers: Record<string, McpServerConfig>, bridge: McpServerConfig): string {
  return mergeJsonConfig(content, "mcpServers", "antigravity", servers, { "mr-orchestrator": bridge });
}

export function mergeGeminiConfig(content: string, servers: Record<string, McpServerConfig>, bridges: Record<string, McpServerConfig>): string {
  return mergeJsonConfig(content, "mcpServers", "antigravity", servers, bridges);
}

export function mergeClaudeConfig(content: string, servers: Record<string, McpServerConfig>, bridge: McpServerConfig): string {
  return mergeJsonConfig(content, "mcpServers", "claude", servers, { "mr-orchestrator": bridge });
}

export function mergeFxConfig(content: string, servers: Record<string, McpServerConfig>, bridge: McpServerConfig): string {
  return mergeJsonConfig(content, "mcp", "fx", servers, { "mr-orchestrator": bridge });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function removeJsonBridge(content: string, bridge: McpServerConfig): string {
  const root = asRecord(parse(content));
  const servers = asRecord(root["mcpServers"]);
  const current = servers["mr-orchestrator"];
  const expected = toHostServer({ ...bridge, instructions: bindingInstruction }, "cursor");
  if (!sameJson(current, expected)) return content;
  const edits = modify(content, ["mcpServers", "mr-orchestrator"], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const next = applyEdits(content, edits);
  return next.endsWith("\n") ? next : `${next}\n`;
}

export function removeOwnedJsonBridge(content: string): string {
  return removeOwnedJsonBridges(content, "mcpServers", ["mr-orchestrator"]);
}

export function removeOwnedJsonBridges(
  content: string,
  property: "mcpServers" | "mcp",
  names: readonly string[],
): string {
  let next = content;
  for (const name of names) {
    const root = asRecord(parse(next));
    const servers = asRecord(root[property]);
    if (servers[name] === undefined) continue;
    const edits = modify(next, [property, name], undefined, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    });
    next = applyEdits(next, edits);
  }
  return next.endsWith("\n") ? next : `${next}\n`;
}

export function removeOwnedFxBridge(content: string): string {
  return removeOwnedJsonBridges(content, "mcp", ["mr-orchestrator"]);
}

export function removeOwnedGeminiBridges(content: string): string {
  return removeOwnedJsonBridges(content, "mcpServers", [
    "mr-orchestrator",
    "mr-orchestrator-antigravity",
    "mr-orchestrator-agy",
  ]);
}

export function removeCodexBridge(content: string): string {
  const escaped = "mr-orchestrator".replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const expression = new RegExp(`\\n?\\[mcp_servers\\.${escaped}\\][\\s\\S]*?(?=\\n\\[mcp_servers\\.|$)`, "u");
  return content.replace(expression, "").trimEnd() + "\n";
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  return JSON.stringify(value);
}

function appendTomlServer(content: string, name: string, server: McpServerConfig): string {
  const section = `[mcp_servers.${name}]`;
  if (content.includes(section)) return content;
  const host = toHostServer(server, "codex");
  const lines = ["", section];
  for (const [key, value] of Object.entries(host)) {
    if (key === "env") continue;
    lines.push(`${key} = ${tomlValue(value)}`);
  }
  const env = host["env"];
  if (isRecord(env)) {
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [key, value] of Object.entries(env)) lines.push(`${key} = ${tomlValue(value)}`);
  }
  return `${content.trimEnd()}${lines.join("\n")}\n`;
}

export function mergeCodexConfig(content: string, servers: Record<string, McpServerConfig>, bridge: McpServerConfig): string {
  let next = content;
  for (const [name, server] of Object.entries({ ...servers, "mr-orchestrator": { ...bridge, instructions: bindingInstruction } })) {
    next = appendTomlServer(next, name, server);
  }
  return next;
}

export function changedFilesAreClientOnly(paths: string[]): boolean {
  return paths.every((path) => path === "clients" || path.startsWith("clients/"));
}

export { bindingInstruction };
