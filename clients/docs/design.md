# Client Compatibility Bridge

## No-Regression Contract

This package is standalone and only loads `../dist/src/plugin.js` at runtime. It does not import, modify, rebuild, install, or configure the existing OpenCode integration. All Flow, Blueprint, Atlas, SDD, GitHub, prompt, and workspace business behavior remains owned by the immutable compiled plugin.

The bridge exposes that plugin's returned `tool` registry over stdio MCP. It converts each Zod argument schema to MCP-compatible JSON Schema and turns tool results into text plus structured content without assuming a host-specific execution context.

## Workspace Binding

The server reads the existing mr-orchestrator workspace registry and has no implicit current-directory behavior. A client must call `mr_bind_workspace` using exactly one registered workspace id or root path before any forwarded tool. Unbound, missing, or unregistered workspaces fail closed with an actionable error.

## Client Installation

`mr-clients install` presents independent checkbox choices for OpenCode CLI, OpenCode Desktop, Codex CLI, Codex Desktop, Cursor CLI, Cursor Desktop, Claude Code, Antigravity Desktop, and AGY CLI. OpenCode is reported but never modified. The Codex variants share `~/.codex/config.toml`, the Cursor variants share `~/.cursor/mcp.json`, Claude Code uses the user-scoped top-level `mcpServers` entry in `~/.claude.json`, and Antigravity Desktop and AGY CLI share `~/.gemini/config/mcp_config.json`.

The installer also creates thin host-native adapters for `flow`, `blueprint`, and `flow-models`. Cursor receives slash-invoked skills under `~/.cursor/skills/` with `disable-model-invocation: true`. Claude receives Markdown slash commands. AGY receives TOML slash commands with `{{args}}`. Codex receives explicit `$flow`, `$blueprint`, and `$flow-models` skills because Codex's supported custom invocation mechanism is `$skill`, not a guaranteed custom slash command. Antigravity Desktop receives globally discovered skills. Every adapter binds a registered workspace first and delegates lifecycle state, model persistence, validation, and safety gates to MCP tools.

Hosts without mr-orchestrator's native OpenCode subagent definitions preserve the same separation through independent role passes: read-only explore, read-only plan, bounded implementation, two separate read-only judgments, and validated fixes. This is behavioral parity, not a claim that every host exposes the same native subagent runtime.

Existing active OpenCode MCP servers are imported from `~/.config/opencode/opencode.json` or `.jsonc`. Local commands, arguments, environment interpolation, and remote URLs are retained in host-native forms. Existing host entries are never overwritten. The bridge entry carries a binding instruction; the MCP server also advertises the same instruction because hosts vary in whether they display per-server instructions.

## Ownership And Limits

The package records configuration and adapter installations under `$XDG_DATA_HOME/mr-orchestrator-clients/manifest.json`. It never overwrites an existing adapter with different content. Uninstall removes an owned adapter only when its fingerprint is unchanged and removes an owned bridge entry only when the containing configuration is unchanged; otherwise it preserves the user file. It does not delete arbitrary user configuration or manage OpenCode.

Codex TOML is extended by appending new MCP sections to preserve pre-existing TOML text. JSON and JSONC clients are edited structurally so existing MCP entries remain intact. Host-specific instruction fields may be ignored by a host; the server-level binding requirement remains enforced regardless.
