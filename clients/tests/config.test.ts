import { expect, test } from "bun:test";
import {
  changedFilesAreClientOnly,
  mergeAntigravityConfig,
  mergeClaudeConfig,
  mergeCodexConfig,
  mergeCursorConfig,
  mergeFxConfig,
  mergeFxSettings,
  mergeGeminiConfig,
  mergeOpenCodeCatalogs,
  parseOpenCodeCatalog,
  removeOwnedFxSettings,
} from "../src/config.js";

const openCode = `{
  // preserve user local forms
  "mcp": {
    "github": { "type": "local", "command": ["bunx", "github-mcp"], "environment": { "TOKEN": "{env:GITHUB_TOKEN}" } },
    "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" }
  }
}`;

test("imports active OpenCode servers while retaining local command and environment forms", () => {
  expect(parseOpenCodeCatalog(openCode)).toEqual({
    github: {
      command: ["bunx", "github-mcp"],
      env: { TOKEN: "{env:GITHUB_TOKEN}" },
    },
    context7: { url: "https://mcp.context7.com/mcp" },
  });
});

test("merges every active OpenCode catalog and preserves remote headers", () => {
  const catalog = mergeOpenCodeCatalogs([
    `{"mcp":{"github":{"url":"https://github.example/mcp","headers":{"Authorization":"Bearer {env:TOKEN}"}}}}`,
    `{"mcp":{"codegraph":{"command":["codegraph","serve","--mcp"]}}}`,
  ]);

  expect(catalog).toEqual({
    github: {
      url: "https://github.example/mcp",
      headers: { Authorization: "Bearer {env:TOKEN}" },
    },
    codegraph: { command: ["codegraph", "serve", "--mcp"] },
  });
});

test("merges selected host configurations without replacing user servers", () => {
  const servers = parseOpenCodeCatalog(openCode);
  const bridge = { command: ["bun", "/clients/src/cli.ts", "serve"], env: {} };

  expect(mergeCursorConfig('{"mcpServers":{"user":{"url":"https://example.test"}}}', servers, bridge)).toContain('"user"');
  expect(mergeCursorConfig('{"mcpServers":{}}', servers, bridge)).toContain('"mr-orchestrator"');
  const antigravity = JSON.parse(mergeAntigravityConfig('{"mcpServers":{"user":{"command":"user-mcp"}}}', servers, bridge));
  expect(antigravity.mcpServers.context7).toEqual({
    serverUrl: "https://mcp.context7.com/mcp",
  });
  expect(mergeCodexConfig('[mcp_servers.user]\ncommand = "user-mcp"\n', servers, bridge)).toContain('[mcp_servers.mr-orchestrator]');
  const claude = JSON.parse(mergeClaudeConfig('{"mcpServers":{"user":{"command":"user-mcp"}}}', servers, bridge));
  expect(claude.mcpServers.user).toEqual({ command: "user-mcp" });
  expect(claude.mcpServers["mr-orchestrator"].args).toEqual(["/clients/src/cli.ts", "serve"]);
  const gemini = JSON.parse(mergeGeminiConfig("{}", servers, {
    "mr-orchestrator-antigravity": { command: ["bun", "bridge", "serve", "--harness", "antigravity"] },
    "mr-orchestrator-agy": { command: ["bun", "bridge", "serve", "--harness", "agy"] },
  }));
  expect(gemini.mcpServers["mr-orchestrator-antigravity"].args.slice(-2)).toEqual(["--harness", "antigravity"]);
  expect(gemini.mcpServers["mr-orchestrator-agy"].args.slice(-2)).toEqual(["--harness", "agy"]);
  const fx = JSON.parse(mergeFxConfig("{}", servers, bridge));
  expect(fx.mcp["mr-orchestrator"]).toEqual({
    type: "stdio",
    command: ["bun", "/clients/src/cli.ts", "serve"],
  });
  expect(fx.mcp.context7).toEqual({ type: "http", url: "https://mcp.context7.com/mcp" });
});

test("adds and removes only owned native fx Jev reviewer settings", () => {
  const merged = mergeFxSettings('{"models":{"gateway":"moonshotai/kimi-k3"}}');
  expect(JSON.parse(merged.content)).toEqual({
    models: { gateway: "moonshotai/kimi-k3" },
    provider: "gateway",
    review_model: "typesafeai/jev",
    permission_mode: "auto",
  });
  expect(merged.ownedKeys).toEqual(["provider", "review_model", "permission_mode"]);
  expect(JSON.parse(removeOwnedFxSettings(merged.content, merged.ownedKeys))).toEqual({
    models: { gateway: "moonshotai/kimi-k3" },
  });

  const preserved = mergeFxSettings('{"provider":"codex","review_model":"custom/reviewer","permission_mode":"ask"}');
  expect(preserved.ownedKeys).toEqual([]);
  expect(preserved.preservedKeys).toEqual(["provider", "review_model", "permission_mode"]);
});

test("rejects a change set containing files outside clients", () => {
  expect(changedFilesAreClientOnly(["clients/src/bridge.ts"])).toBe(true);
  expect(changedFilesAreClientOnly(["src/plugin.ts"])).toBe(false);
});
