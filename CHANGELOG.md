# Changelog

All notable changes to this project are documented in this file.

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.15.0] - 2026-10-03

### Added

- Added `/task`, a fast explore → plan → apply workflow with deterministic intake, Jev decisions for read depth, verification and handoff, anchored execution plans applied without a model when they carry exact code, scoped verification without a shell, and an out-of-plan conformance check.
- Added the Relay journal (`tool.execute.after`) and lossless-by-reference handoffs: must-keep entries travel verbatim, Jev-selected entries inline, everything else listed in a manifest and recoverable with `mr_task_recall`.
- Added `/task` adapters for Codex, Cursor (`agent`), Claude Code, Antigravity, AGY, fx and Pi, with `run-role --variant` and `mr_task_record kind=read` for hosts without the relay.
- Added per-strategy effort (`mr task-effort`), generating `mr-task-<role>-<variant>` agents without changing models.
- Added a direct TypeSafe Jev adapter (`TYPESAFE_API_KEY`) preferred over Vercel AI Gateway, and `mr decision zdr on|off` for Gateway plans without Zero Data Retention.
- Added the portable Atlas pack: local `.aicontext/atlas/MAP.md` and `MEMORY.md`, managed pointer blocks in `AGENTS.md` (created when missing), `CLAUDE.md`, `GEMINI.md` and Copilot instructions, `mr atlas query` and `mr atlas unlink`. The pack stays local through `.git/info/exclude`.
- Added `[▶ play]` narration for `/task`, `/flow` and `/blueprint` explanations using macOS `say` on click, served on localhost with a per-session token and stripped from model history.
- Added zero-token intake and simulation benches (`scripts/task-intake-bench.ts`, `scripts/task-sim-bench.ts`) with baselines under `bench/baselines/`.
- Added `/choose-model` to pick a model for a case from the agent-visible catalog with Jev.

### Changed

- Planner role now defaults to `claude-opus-5.5` in the governed roster.
- Intake heuristics recognise Spanish bugfix phrasing, cross-cutting contracts, and critical-area synonyms; at intake Jev may raise but never lower difficulty.

### Safety

- Jev only decides cost (reading, verification, handoff) above deterministic floors; floors, plan validation and verification remain deterministic.
- Verification commands run without a shell from an allowlist (declared package scripts and known verification binaries).
- Runtime keeps requesting Zero Data Retention on Vercel AI Gateway unless the developer turns it off explicitly.

## [0.14.0] - 2026-09-21

### Added

- Added first-class Pi harness support with per-invocation application mode, provider-qualified model translation, and reasoning level mapping.
- Added native Pi prompt templates under `~/.pi/agent/prompts/` for `/flow`, `/blueprint`, `/flow-models`, and `/work`.
- Added managed mr-orchestrator MCP server registration in `~/.pi/agent/mcp.json` that safely preserves user-managed MCP servers.
- Added CLI support for non-interactive installer targeting (`mr-clients --target pi-cli`).

### Changed

- Updated client installer and role runner to execute Pi roles using `pi --print --no-session --model ...` with optional thinking parameters.
- Updated documentation and design specs with Pi prerequisites (`pi-mcp-adapter`) and harness routing architecture.

### Safety

- Catalog presence is not treated as proof of quota; missing models or permissions fail closed with actionable diagnostics.
- Pi configuration and model artifacts remain completely isolated from FX and other harness configurations.
- Unchanged user MCP servers and custom prompt configurations are strictly preserved.

## [0.13.0] - 2026-09-19

### Added

- Added ODD-lite everyday routing with deterministic `read-only`, `direct`, and resumable `tracked` paths, plus the `/work` workflow for OpenCode and all native client adapters.
- Added global and per-role credential boundaries for sensitive files and explicit approval gates for remote execution and transfer.
- Added opt-in Jev context compaction with verbatim KEEP preservation, bounded evaluation, deterministic FIFO fallback, secret redaction, and a 1500 ms timeout ceiling.

### Changed

- Judgment now freezes the exact review diff, verifies it with SHA-256 and live CAS checks, and serves bounded chunks so both independent judges inspect the same immutable candidate without tool-output truncation.
- Native client installers now publish `/work` alongside `/flow`, `/blueprint`, and `/flow-models`.

### Safety

- Formal `/flow` remains explicit and is never selected automatically by ODD-lite.
- Context compaction is opt-in, never rewrites system or current user messages, and falls back deterministically on provider errors, timeouts, incomplete answers, or low confidence.
- Commit and release metadata contain no AI co-author trailers.

## [0.12.0] - 2026-09-19

### Added

- Added an opt-in Jev Decision Plane for OpenCode and MCP-connected harnesses, with bounded intent/context/routing/flow/judgment/permission profiles, shadow-only recommendations, and Flow metrics.
- Added native fx Gateway/Jev permission reviewer setup with reversible, user-preserving settings management.
- Added `mr decision status|shadow|off`, Jev doctor checks, Vercel AI Gateway zero-data-retention requests, and operating documentation.

### Safety

- Jev remains advisory; deterministic FSM, gates, explicit denies, and human confirmation remain authoritative. Invalid configuration, evaluation errors, and telemetry persistence failures cannot block the workflow.
- Gateway credentials are environment-only and never persisted by mr-orchestrator.

## [0.11.0] - 2026-09-17

### Added

- Deterministic `/flow` wizard tools (`mr_flow_wizard_begin`, `mr_flow_wizard_step`) with auto-start on completion, platform/ticket/difficulty/design/instructions steps, and harness badges on tool titles.
- `mr figma setup` plus doctor checks for Figma Live MCP manifest publishing.
- Spanish `/flow` command description in OpenCode (`descriptionEn` keeps English for tests).

### Changed

- Flow orchestrator prompt prioritizes wizard tools over manual field collection.
- Subagent tool titles show role badge from the active session agent (e.g. mr-explore).

## [0.10.0] - 2026-09-17

### Added

- Added the **INTENT** flow phase between context and explore, with typed `IntentCapsule` states (`PROPOSED`, `READY`, `NEEDS_INPUT`).
- Added deterministic intent resolution sweeps **S0–S4** (`intent-resolver.ts`): ticket parse → Engram prefetch → Atlas map hints → bounded merge → fail-closed validation.
- Added `mr_flow_intent_resolve` to re-run sweeps and optionally merge an `mr-intent` JSON draft during S3.
- Added lane-aware intent gates (`confirmMediumAssumptions` on `full`/`critical` when medium-risk assumptions exist).
- Added `docs/INTENT-RESOLUTION.md` documenting sweeps, assumption policy, and exceptional human clarification.

### Changed

- `mr_flow_ticket` and `mr_flow_start` now auto-resolve intent after warm-up instead of requiring a blank questionnaire.
- `mr-intent` refines orchestrator PROPOSED drafts; human questions are capped and only emitted for high-risk gaps with suggested defaults.
- Flow progress UI and client adapters document the INTENT step and confirmation gates before explore.

## [0.9.2] - 2026-09-17

### Added

- Added partial per-harness model overrides, validated native catalogs, effective roster diagnostics, role dispatch for external clients, and fx CLI adapter support.
- Added one-shot Engram prefetch with Atlas warm-up before planning and compact Flow completion memories for future runs.
- Added typed English-only internal execution receipts for implementation and remediation roles.

### Changed

- Model-facing SDD, Atlas, evidence, and context payloads now use whitespace-free JSON while persisted artifacts remain human-readable.
- `next-task` now transports `ContextBundle` as a nested object instead of a double-serialized JSON string.
- External MCP bridges now bind a trusted harness identity and reject missing, conflicting, unsupported, or ambiguous model mappings fail-closed.

### Fixed

- Removed the implicit Antigravity fallback when an external bridge starts without a trusted harness identity.
- Updated the real bridge smoke fixture to use the current model-assignment schema and preserve global assignments while testing scoped overrides.

## [0.9.1] - 2026-09-14

### Changed

- Improved Atlas incremental indexing and cache validation for changed workspace content.

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

[0.11.0]: https://github.com/marioccarloss/orchestrator/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/marioccarloss/orchestrator/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/marioccarloss/orchestrator/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/marioccarloss/orchestrator/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/marioccarloss/orchestrator/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/marioccarloss/orchestrator/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/marioccarloss/orchestrator/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/marioccarloss/orchestrator/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/marioccarloss/orchestrator/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/marioccarloss/orchestrator/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/marioccarloss/orchestrator/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/marioccarloss/orchestrator/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/marioccarloss/orchestrator/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/marioccarloss/orchestrator/releases/tag/v0.1.0

[Unreleased]: https://github.com/marioccarloss/orchestrator/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/marioccarloss/orchestrator/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/marioccarloss/orchestrator/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/marioccarloss/orchestrator/compare/v0.11.0...v0.12.0
