# Changelog

All notable changes to this project are documented in this file.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-09-14

### Added

- **F0 — Measurable journeys:** added the typed 15-journey reliability corpus, per-role/task Flow usage capture, and deterministic benchmark aggregation from real metrics and event logs.
- **F1 — Trustworthy Atlas:** upgraded Atlas to content-hashed incremental indexing with explicit coverage, polyglot skeletons, monorepo-aware resolution, and no silent claims over unsupported or partially parsed files.
- **F2 — Shared evidence:** added a content-addressed EvidenceStore, versioned ResearchCapsules, freshness/relocation checks, and task/role-specific context hydration.
- **F3 — Deterministic delivery gates:** added TaskGraph v2 surgical boundaries, invariants, verification receipts, local tickets, risk lanes, critical approval, and fail-closed planning/implementation/judgment gates.
- **F4 — Semantic and framework intelligence:** added bounded TypeScript and optional PHP semantic enrichment, weighted impact, framework extractors, and cross-repository contract edges.
- **F5 — Observed repository rules:** added evidence-backed convention detectors, confidence decisions, persisted rule projections, Atlas onboarding CLI/TUI, scoped hydration, and deterministic rule enforcement.
- **F6 — Language and token economy:** added persisted `es`/`en`/`pt`/`ca`/`fr` output selection, deterministic localized projections, role-by-lane context budgets, visible hydration usage, and single-session routing for ticketless fast work.
- Simplified command reference (`docs/USAGE-simple.md`) with at-a-glance parameters for `/flow`, `/blueprint`, `/prompt` and `/atlas`.

### Changed

- Deterministic gates now default to `MR_GATES_MODE=block`; set `warn` explicitly only for temporary diagnosis or migration.
- Removed the MacBook Air transfer guide from the README docs index.

## [0.8.0] - 2026-09-12

### Added

- Universal grounding contract with the canonical `INSUFFICIENT_EVIDENCE` response for missing source context.
- Evidence-backed judgment findings with mechanically verified diff file, line, side, snippet, and optional requirement linkage.
- Deterministic agent sampling defaults (`temperature: 0`, `top_p: 1`) and controlled grounded/rejection examples.
- JSON-only Blueprint-lite planning briefs with optional risk-driven clarification capped at three questions.
- Order-style Flow progress, per-Flow OpenCode cost/token accounting across child sessions, and deterministic compact developer explanations for plans and SDD tasks.
- Resumable capability installer for i-have-adhd, Codebase Memory, CodeGraph, Context7, Engram, GitHub, Jira, and figma-live-mcp, with selective installation, readiness reporting, and non-blocking credential deferral.

### Changed

- Full flows now reject task graphs that modify files without ResearchCapsule evidence; Lite flows retain the warning.
- Judgment verdicts are bound to the CAS diff hash and stale verdict files are cleared before every review round.
- OpenCode now starts in its normal `build` agent; `/flow` dispatches to the internal Orchestrator automatically without a manual mode switch.
- Developer-facing ADHD-friendly explanations are restricted to Orchestrator; implementation, judgment, and remediation roles return internal receipts only.

## [0.7.0] - 2026-09-11

### Added

- Per-role primary and `alternative.model` assignments, with automatic alternative promotion after non-recoverable quota exhaustion.
- Deterministic implementer selection: `mr-general` for Fibonacci 1-3 and `mr-sdd-apply` for Fibonacci 5+.

### Changed

- Restored the documented Judgment Day threshold: Lite flows finish after implementation; Full flows continue through the two independent judges and bounded fix loop.
- Upgraded the governed roster: GPT-5.6 Sol powers implementation/planning, while DeepSeek V4 Pro and Kimi K2.7 Code provide diverse OpenCode Go judgment.
- Model configuration UIs and tools now display and edit both primary and alternative slots.

### Fixed

- Isolated plugin test sandboxes through explicit path injection and installed client-package dependencies in CI before root test discovery.

## [0.6.1] - 2026-09-11

### Changed

- Propagated the fixed-prefix/context-suffix contract to native Codex, Cursor, Claude Code, Antigravity, and AGY workflow adapters.
- Expanded external Flow guidance for typed SDD submissions, deterministic task progression, fail-closed verification, blind dual judgment, and bounded remediation.
- Kept adapter role contracts provider-neutral so the generated prompts do not embed stale model assignments.

## [0.6.0] - 2026-09-11

### Added

- Static, model-invariant contracts for the Flow judges and bounded remediation agent.
- Regression coverage for command suffix stability, model-invariant agent prompts, timestamp-free SDD context, canonical capsule ordering, and the governed model roster.

### Changed

- Moved `$ARGUMENTS` to a single final `[CONTEXT_INPUT_PAYLOAD]` boundary in every generated command so fixed instructions remain cacheable.
- Removed generated model snapshots from `/blueprint` and `/flow-models`; the latter now loads the authoritative roster with `mr_models status`.
- Split SDD/RPI capsules into timestamp-free operational payloads and persisted artifacts with audit metadata. `mr_sdd_get` and generated markdown no longer expose volatile timestamps.
- Updated the repository seed and missing-role defaults to the governed eleven-role model roster.

## [0.5.0] - 2026-09-07

### Added

- **Fail-Closed Harness Hardening (Gentleman Programming 7 Pillars):**
  - **Pillar 1 (Event Sourcing):** State transitions persist to `events.jsonl` with deterministic `replayFromOrigin()` state reconstruction.
  - **Pillar 2 (CAS Integrity):** SHA-256 Content-Addressed Storage diff digest enforcement (`getDiffHash`), rejecting mutations post-judgment in `mr_flow_finish`.
  - **Pillar 3 (Fail-Closed Gates):** Mandatory judgment (`requiresJudgment` unconditionally true); cryptographic `safetyGateTicket` verification on `mr_blueprint_graphql` mutations.
  - **Pillar 4 (Role Segregation):** Strict caller verification in `mr_flow_judge` (`mr-judge-a` / `mr-judge-b`), preventing workers or orchestrator from self-approving.
  - **Pillar 5 (Context Amnesia Resilience):** `PersistentMemoryStore` with git-stamp workspace tree tracking; auto-invalidates stale records upon repository tree drift.
  - **Pillar 6 (Structural AST Analysis):** Tree-sitter WASM validation (`validateAstSyntax`) blocking broken code from reaching judgment.
  - **Pillar 7 (Bounded Remediation Loop & Scope Enforcement):** Rejection of unapproved file mutations outside `plan.files`; hard ceiling of 3 fix attempts before human escalation.

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

[0.7.0]: https://github.com/marioccarloss/orchestrator/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/marioccarloss/orchestrator/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/marioccarloss/orchestrator/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/marioccarloss/orchestrator/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/marioccarloss/orchestrator/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/marioccarloss/orchestrator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/marioccarloss/orchestrator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/marioccarloss/orchestrator/releases/tag/v0.1.0
