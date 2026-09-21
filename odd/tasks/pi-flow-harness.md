# Pi Flow Harness

## Objective

Add Pi as a first-class mr-orchestrator harness so `/flow`, `/blueprint`, `/flow-models`, and `/work` use Pi prompt templates, the mr-orchestrator MCP bridge, and isolated per-role model dispatch.

## Problem

Pi is not currently represented in the harness schemas, client installer, model catalog, role runner, or generated adapters. The existing FX-only configuration cannot safely or correctly stand in for Pi.

## Why

The user explicitly requires mr-orchestrator Flow to work in Pi with the same deterministic workflow guarantees and a Pi-specific translation of the selected role roster.

## Scope

- Add the `pi` harness identity and per-invocation application mode.
- Discover Pi models through the public `pi --list-models` command and translate logical IDs to provider-qualified native IDs.
- Execute isolated roles through `pi --print --no-session --model ...` with supported thinking levels.
- Install and remove the mr-orchestrator MCP entry in `~/.pi/agent/mcp.json` without disturbing user-managed servers.
- Install Pi prompt templates under `~/.pi/agent/prompts/` so the native UX is `/flow` rather than `/skill:flow`.
- Add strict-TDD regression coverage and user-facing integration documentation.
- Install and validate the Pi integration locally after source verification.

## Constraints

- Strict TDD: RED -> GREEN -> REFACTOR for each work unit.
- Preserve unrelated user configuration and never inspect credentials.
- Do not install third-party Pi packages silently; report a missing `pi-mcp-adapter` clearly.
- Pi configuration and model artifacts remain isolated from FX.
- Catalog presence is not proof of quota.
- No push or pull request without separate authorization.

## TDD

- Mode: enabled
- Source: repository AGENTS.md (`Strict TDD Mode: enabled`)
- Runners: `bun test` focused suites, then root and client `bun run check`

## Delivery

- Strategy: `ask-on-risk`
- Forecast: approximately 450-650 authored changed lines across two cohesive work units.
- Chain strategy: `feature-branch-chain` (explicit user choice).

## Tasks

- [x] **PI-1 — Core Pi harness and model routing** (`delegated`)
  - Trigger evidence: implementation spans multiple non-trivial schema, model, runner, and test files.
  - Add Pi to shared/client harness identities and per-invocation application modes.
  - Add strict parsing of public `pi --list-models` output with provider-qualified native IDs and reasoning variants only where supported.
  - Add Pi role-runner commands with optional thinking levels.
  - Acceptance: focused tests first fail for absent Pi behavior, then pass; root/client checks relevant to this unit pass.
  - Commits: `2562617 feat(pi): add harness model routing`; `790a016 fix(pi): harden model and prompt translation`.
  - Review outcome: RDD disabled clone-locally by explicit user authorization after the native collect-transition block; independent verification initially found two P1 defects, both corrected and re-verified PASS.

- [x] **PI-2 — Pi installer, MCP, templates, documentation, and local validation** (`delegated`)
  - Trigger evidence: implementation spans installer, config, adapters, CLI, tests, docs, and local Pi integration.
  - Preserve user-managed Pi MCP servers while managing only the owned mr-orchestrator entry.
  - Generate native Pi prompt templates with `$ARGUMENTS`, deterministic workspace binding, harness validation, and per-role dispatch.
  - Document the `pi-mcp-adapter` dependency and Pi workflow/model behavior.
  - Install locally and validate the Pi-specific catalog, override, effective model output, MCP entry, and prompt templates without paid inference.
  - Acceptance: RED/GREEN evidence recorded; full root/client checks pass; installed artifacts are read back.
  - Commit: `089f78b feat(pi): install native flow integration`.
  - Review outcome: RDD disabled clone-locally; high-risk independent verification PASS.

## Authorized Scope

The user explicitly authorized complete native Pi support for mr-orchestrator Flow. Local source changes, tests, work-unit commits, and local Pi configuration required for that outcome are authorized. Push, pull request creation, merge, and paid inference are not authorized.

## Verification Evidence

- Exploration: Pi 0.86.1 supports provider-qualified `--model`, `--thinking`, `--print`, and `--no-session`; prompt templates provide native `/flow`.
- PI-1: strict-TDD RED observed; correction RED covered Vercel logical/native translation and dash-prefixed prompt safety. Parent spot-check passed 13 root + 5 client tests. Worker reported full root check with 315 tests and client check with 25 tests. Independent re-verification PASS. Runtime N/A until PI-2 installs the integration.
- PI-2: strict-TDD RED observed; 20 focused client tests passed in parent spot-check. Full verification passed with 316 root tests and 29 client tests, plus typecheck and lint. Independent verification PASS. Local install detected `pi-mcp-adapter`, preserved existing MCP servers, installed four native prompt templates, refreshed a 242-model catalog, and validated the complete Pi roster without paid inference.

## Progress

- Branch: `feat/pi-flow-harness`
- Current task: complete
- Authored changed lines: 361 across implementation commits (`2562617`, `790a016`, `089f78b`), excluding this tracking document.
- Next step: restart Pi or run `/reload`, enter a registered workspace, then invoke `/flow`.
