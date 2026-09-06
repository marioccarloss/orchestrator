# Changelog

All notable changes to this project are documented in this file.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-07

### Added

- **Multi-Client MCP Compatibility Bridge (`clients/`):**
  - Standalone package providing an MCP stdio server bridging the immutable compiled mr-orchestrator plugin facade to external clients.
  - Interactive multi-client installer CLI (`mr-clients install`, `doctor`, `uninstall`, `serve`) supporting OpenCode CLI/Desktop, Codex CLI/Desktop, Cursor CLI/Desktop, Claude Code, Antigravity Desktop, and AGY CLI.
  - Native workflow adapters for `/flow`, `/blueprint`, and `/flow-models` across Cursor skills, Claude Code slash commands, AGY TOML commands, Codex `$skill` definitions, and Antigravity global skills.
  - Dynamic OpenCode MCP catalog importer preserving environment interpolation, headers, and local commands.
  - Strict workspace binding requirement (`mr_bind_workspace`) before executing forwarded plugin tools.
- **Quota Failure Classification & Model Recovery:**
  - Non-recoverable API quota error detection (`429 insufficient_quota` / `quota_exceeded`) in session error handler.
  - Quota candidate suggestion tool (`mr_models` with `action="candidates"` and `failedModel`) excluding non-functional models while preserving flow state.

## [0.3.0] - 2026-09-04

### Added

- **Blueprint Pipeline:**
  - Native product idea and GitHub ticket pipeline with typed SDD and RPI specifications.
  - Blueprint roles (`bpExtractor`, `bpArchitect`, `bpTransactor`) with safety gate verification diffs and model configuration.

## [0.2.0] - 2026-09-02

### Fixed

- **Plugin dependency auto-install:** `syncWorkspace()` now runs `bun install` automatically after generating `package.json` in each workspace's generated directory. Previously, the plugin would fail to load silently because `node_modules` was missing.
- **Loader error visibility:** The global OpenCode loader (`~/.config/opencode/plugins/mr-orchestrator-loader.ts`) now writes errors to stderr instead of silently swallowing them. If the plugin fails to load, users will see a diagnostic message instead of missing commands with no explanation.

### Added

- **Installation docs:** Documented the automatic `bun install` step in `docs/INSTALLATION.md`, added troubleshooting section for missing commands, and explained how to use `opencode .` directly without `mrcode`.

## [0.1.0] - 2026-09-01

### Added

- Deterministic OpenCode orchestration with typed flow state and SDD/RPI capsules.
- Global isolated installation, workspace registry, generated OpenCode configuration, diagnostics, and safe uninstall lifecycle.
- Atlas indexing for TypeScript, TSX, Java, JSON, and YAML with dependency, impact, governance, and skeleton queries.
- Adversarial dual-judge review and bounded correction loop.
- Interactive `flow-models` configuration during installation and from the terminal, with per-process assignments and catalog refresh.
- Bun-only runtime, package management, build, test, and CLI workflow using the public npm registry.
- GitHub Actions verification for type checking, linting, and tests.

[0.1.0]: https://github.com/marioccarloss/orchestrator/releases/tag/v0.1.0
