# Changelog

All notable changes to this project are documented in this file.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
