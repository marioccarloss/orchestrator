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
- [ ] T4 — Migrate `core-dev` hand-added rules into `rules.local.json`, reinstall, regenerate, verify. Route: inline (operational).

## Progress

- 2026-10-07: Branch created; exploration done. All consumers read rules through `src/core/rules/store.ts` `loadWorkspaceRules`.

- 2026-10-07: T1–T3 done by delegated writer (uncommitted). RED: tests/rules-store.test.ts (4 failing with stub exports: override/append/local-only, missing/invalid rules.json, merged AGENTS.md save, file inspection) and tests/doctor.test.ts (missing `checkAtlasRuleFiles` export). GREEN: focused 11/11 pass; `bun run typecheck` clean; `bun run lint` clean; `bun run test` 359/359 pass. Design: `LocalRulesSchema` defaults `kind: "user"`, `confidence: 1`, `evidence: []`; local-only repos get a synthesized baseline entry with `generatedFromIndex` of 64 zeros; missing rules.json synthesizes a workspace with no preferences and `generatedAt` epoch; doctor reports only invalid files via `checkAtlasRuleFiles`.

## Next Step

Parent: work-unit commit for T1–T3, then T4 (migrate core-dev rules).
