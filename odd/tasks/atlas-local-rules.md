# Atlas Local Rules

Locator: `odd/tasks/atlas-local-rules.md` · Engram mirror: `odd/atlas-local-rules/tasks` · Branch: `feat/atlas-local-rules`

## Objective

Let users author Atlas rules that survive `mr atlas rules` / `mr atlas init` regeneration, and make invalid Atlas rule files visible instead of silently disabling every rule.

## Problem

- `.aicontext/atlas/rules.json` is rebuilt from detectors only; `saveWorkspaceRules` overwrites it, so hand-added rules are lost on regeneration.
- `loadWorkspaceRules` / `loadRepositoryProfiles` return `undefined` on any schema error, so one invalid entry (for example `severity: "error"` or an unknown `commands` key) silently removes all rules and profiles from `mr_atlas_profile`, `/task`, and flow hydration. Observed on 2026-10-07 in the `core-dev` workspace.

## Why

The user keeps project rules (no CSS edits, hexagonal layers, delivery conventions, staged context gathering) that must reach every harness through `mr_atlas_profile` with a single source of truth.

## Scope

- New user-owned file `.aicontext/atlas/rules.local.json`, never written by generation.
- `loadWorkspaceRules` merges generated and local rules; local wins on the same `repo` + `id`.
- Generated `AGENTS.md` files render the merged rules.
- `mr doctor` reports schema errors for `profile.json`, `rules.json`, and `rules.local.json` with the failing path.
- Usage docs.
- Migrate the `core-dev` workspace's hand-added rules into `rules.local.json` and prove they survive regeneration.

## Constraints

- Strict TDD per behavior change (RED → GREEN → REFACTOR) with `bun test`.
- No new dependencies. Reuse the existing zod schemas.
- An invalid `rules.local.json` must not disable generated rules; it is ignored and reported by `mr doctor`.
- Keep `rules.json` generator-owned; never write local rules into it.

## Acceptance Criteria

- With only `rules.json`, behavior is unchanged.
- With `rules.local.json`, `mr_atlas_profile` / `rulesDigest` include local rules, and a local rule with the same id overrides the generated one for that repo.
- Local rules for a repo that has no generated entry are still served.
- Regenerating rules leaves `rules.local.json` byte-identical, and the merged output still contains the local rules.
- `mr doctor` names the file and the zod issue path when any of the three files is invalid.
- `bun run check` passes.

## Delivery

Strategy: `ask-on-risk`. Forecast is about 250 authored changed lines, under the 400-line budget: one PR. Push, PR, and merge are the user's decision.

## Tasks

- [x] T1 — Local rules schema and merge in `loadWorkspaceRules` (+ tests). Route: delegated writer (T1–T3 touch 4+ non-trivial files).
- [x] T2 — Render merged rules into generated `AGENTS.md` on save (+ tests). Route: delegated writer.
- [x] T3 — `mr doctor` validation of Atlas rule files with explicit errors (+ tests), plus docs in `docs/USAGE.md`. Route: delegated writer.
- [x] T4 — Migrate `core-dev` hand-added rules into `rules.local.json`, reinstall, regenerate, verify. Route: inline (operational).

- [ ] T5 — `mr atlas rules show [--repo R] [--file F ...] [--json]`: read-only CLI that prints the merged rules (generated + local) without MCP or a flow. Route: delegated writer.
- [ ] T6 — `mr atlas rules render`: rewrite only `.aicontext/atlas/AGENTS.md` and `.aicontext/atlas/repos/<repo>/AGENTS.md` from the current rules.json + rules.local.json + profile.json. No reindex, no rules.json/profile.json write, no pointer edits in repos. Route: delegated writer.
- [ ] T7 — `mr atlas rules --diff` becomes a true dry run: print the diff, write nothing, and touch no pointers. Route: delegated writer.

## Progress

- 2026-10-07: Branch created; exploration done. All consumers read rules through `src/core/rules/store.ts` `loadWorkspaceRules`.

- 2026-10-07: T1–T3 done by delegated writer (uncommitted). RED: tests/rules-store.test.ts (4 failing with stub exports: override/append/local-only, missing/invalid rules.json, merged AGENTS.md save, file inspection) and tests/doctor.test.ts (missing `checkAtlasRuleFiles` export). GREEN: focused 11/11 pass; `bun run typecheck` clean; `bun run lint` clean; `bun run test` 359/359 pass. Design: `LocalRulesSchema` defaults `kind: "user"`, `confidence: 1`, `evidence: []`; local-only repos get a synthesized baseline entry with `generatedFromIndex` of 64 zeros; missing rules.json synthesizes a workspace with no preferences and `generatedAt` epoch; doctor reports only invalid files via `checkAtlasRuleFiles`.

- 2026-10-07: T1–T3 committed as 307a858. RDD: clone-local off; assess = medium, under_budget, no review due.
- 2026-10-07: T4. `mr atlas rules --diff` turned out to SAVE: it regenerated rules.json (hand rules dropped) and added Atlas pointer blocks to tracked AGENTS.md/CLAUDE.md/copilot-instructions.md in 42ds, pasatiempos-api and pasatiempos-ui. The pointer edits were reverted with `git checkout -- <file>` after confirming the diffs held only Atlas lines; unrelated staged work in pasatiempos-api was left untouched. All hand rules (4 for 42ds, 4 for api, 12 for ui) were rebuilt into rules.local.json from /tmp/rules.json.bak-1791384434 plus the 10 user rules. Verified with the new code that the merged digest for pasatiempos-ui serves every local rule. The new doctor check flagged invalid profile.json files in the openreferences workspaces. The running MCP server keeps the old code until the harness restarts.

## Follow-ups

- `mr atlas rules --diff` should be a dry run (or say clearly that it saves), and it should not rewrite pointer blocks in tracked files without consent.
- openreferences: `profile.json` has an unknown `commands.pullDependencies` key.

## Next Step

T5–T7 via one bounded writer (user request 2026-10-07: rules must be consultable and usable without the mr-orchestrator flow).
