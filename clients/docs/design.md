# Client Compatibility Bridge

## No-Regression Contract

This package is standalone and only loads `../dist/src/plugin.js` at runtime. It does not import, modify, rebuild, install, or configure the existing OpenCode integration. All Flow, Blueprint, Atlas, SDD, GitHub, prompt, and workspace business behavior remains owned by the immutable compiled plugin.

The bridge exposes that plugin's returned `tool` registry over stdio MCP. It converts each Zod argument schema to MCP-compatible JSON Schema and turns tool results into text plus structured content. Every server process is also started with an installer-owned harness identity; forwarded `mr_models` calls cannot impersonate another harness.

## Workspace Binding

The server reads the existing mr-orchestrator workspace registry and has no implicit current-directory behavior. A client must call `mr_bind_workspace` using exactly one registered workspace id or root path before any forwarded tool. Unbound, missing, or unregistered workspaces fail closed with an actionable error.

## Client Installation

`mr-clients install` presents independent checkbox choices for OpenCode CLI, OpenCode Desktop, Codex CLI, Codex Desktop, Cursor CLI, Cursor Desktop, Claude Code, Antigravity Desktop, AGY CLI, and fx CLI. OpenCode is reported but never modified. The Codex variants share `~/.codex/config.toml`, the Cursor variants share `~/.cursor/mcp.json`, Claude Code uses the user-scoped top-level `mcpServers` entry in `~/.claude.json`, fx uses the profile-owned `mcp` map in `~/.fx/mcp.json`, and Antigravity Desktop and AGY CLI share `~/.gemini/config/mcp_config.json`. The shared Gemini file receives separate `mr-orchestrator-antigravity` and `mr-orchestrator-agy` entries so their identities and catalogs remain independent. Each managed command includes `serve --harness <id>` and `MR_HARNESS_ID=<id>`; the server rejects missing or conflicting identities. For fx, the installer also adds missing native Jev reviewer keys to `~/.fx/settings.json` and records ownership per key. Existing user values are preserved, and uninstall removes only unchanged keys previously added by mr-orchestrator.

The installer also creates thin host-native adapters for `flow`, `blueprint`, and `flow-models`. Cursor receives slash-invoked skills under `~/.cursor/skills/` with `disable-model-invocation: true`. Claude receives Markdown slash commands. AGY receives TOML slash commands with `{{args}}`. Codex receives explicit `$flow`, `$blueprint`, and `$flow-models` skills because Codex's supported custom invocation mechanism is `$skill`, not a guaranteed custom slash command. Antigravity Desktop receives globally discovered skills. fx receives explicit skills under `~/.fx/skills/`, one of its documented user discovery roots. Every adapter binds a registered workspace first, validates the harness roster through `mr_models`, and delegates lifecycle state, model persistence, validation, and safety gates to MCP tools.

## Harness Model Contract

Model selection is global or harness-scoped, never workspace-scoped. The root package resolves the complete global roster with the partial override in `~/.config/mr-orchestrator/harnesses/<id>/models.json`, validates it against that harness's `catalog.json`, translates logical IDs to native IDs, and writes `effective-models.json` for diagnostics. The trusted bridge identity is authoritative; a model-tool argument supplied by host text cannot change it. OpenCode and fx support catalog refresh through `opencode models` and `fx models --json` respectively. Codex, Cursor Agent, Claude Code, AGY, and fx use the owned `run-role` dispatcher to launch one isolated CLI invocation with the validated native model/variant; their catalogs therefore use `per-invocation`, not `native-role`. Antigravity has no verified managed heterogeneous-model application path and is rejected fail-closed until one is implemented.

Adapters must validate before dispatch. Missing catalogs, unsupported variants, ambiguous translations, and unsupported heterogeneous role assignment fail closed without a partial write. Catalog `applicationMode` records whether a host can apply models per native role or invocation. Validation does not by itself prove that a host applied the selected model, so an adapter must not claim native parity until its host-specific mechanism is implemented and tested.

Hosts without mr-orchestrator's native OpenCode subagent definitions preserve the same separation through independent role passes: read-only explore, read-only plan, bounded implementation, two separate read-only judgments, and validated fixes. This is behavioral parity, not a claim that every host exposes the same native subagent runtime.

Existing active OpenCode MCP servers are imported from `~/.config/opencode/opencode.json` or `.jsonc`. Local commands, arguments, environment interpolation, and remote URLs are retained in host-native forms. Existing host entries are never overwritten. The bridge entry carries a binding instruction; the MCP server also advertises the same instruction because hosts vary in whether they display per-server instructions.

## Ownership And Limits

The package records configuration and adapter installations under `$XDG_DATA_HOME/mr-orchestrator-clients/manifest.json`. It never overwrites an existing adapter with different content. Uninstall removes an owned adapter only when its fingerprint is unchanged and removes an owned bridge entry only when the containing configuration is unchanged; otherwise it preserves the user file. It does not delete arbitrary user configuration or manage OpenCode.

Codex TOML is extended by appending new MCP sections to preserve pre-existing TOML text. JSON and JSONC clients are edited structurally so existing MCP entries remain intact. Host-specific instruction fields may be ignored by a host; the server-level binding requirement remains enforced regardless.
