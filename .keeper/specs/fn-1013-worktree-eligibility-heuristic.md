## Overview

A per-repo worktree-eligibility heuristic for autopilot. When global worktree mode is ON, only "worktree-friendly" repos — a git toplevel with >=1 root language manifest, no workspace-orchestration marker, and no submodules — get parallel worktree lanes. Every other repo's epics dispatch on the shared checkout, one task per root, sequentially: a normal, NON-error dispatch (never a sticky `DispatchFailed`). The heuristic separates a "crisp polyglot" (e.g. keeper: bun + a zero-dep python sidecar, no orchestration -> eligible) from a "monorepo" (e.g. arthack: pnpm-workspace + turbo + uv.workspace, or zellijsub: Cargo `[workspace]` -> disabled). Validated against all 56 repos in `~/code/` in an approved categorization exercise.

It adds a new non-error `disabled` arm to `WorktreeRepoResolution` and `EpicWorktreeGeometry`, threaded through the existing classification -> geometry -> dispatch pipeline, behind a pure, injectable, per-cycle-memoized filesystem probe; mid-flight grandfathering keeps in-flight worktree epics from flipping; and the verdict surfaces as a neutral operator-visible status.

## Quick commands

- `bun test test/worktree-eligibility.test.ts` — the pure heuristic + probe
- `bun test test/autopilot-worker.test.ts test/readiness.test.ts` — classification/geometry/dispatch + the allocator-safety invariant
- `bun test` — full pure-in-process suite

## Acceptance

- [ ] worktree mode ON: a clean repo (>=1 root language manifest, no workspace marker, no submodules) still gets worktree lanes — unchanged from today
- [ ] worktree mode ON: a monorepo (workspace marker), a no-manifest repo, or a submodule repo dispatches sequentially on the shared checkout, one task per root, with NO dispatch_failures / sticky reject
- [ ] an all-disabled cycle with `max_concurrent_per_root>1` still serializes one worker per repo (the cap-1 lane mutex fires) — the load-bearing safety invariant
- [ ] the verdict matches the approved `~/code/` categorization: keeper=eligible, arthack=disabled(workspace), zellijsub=disabled(cargo-workspace)
- [ ] an in-flight worktree epic is NOT flipped to disabled by a mid-cycle marker change or a transient probe error (grandfathered)
- [ ] the fast test tier touches no real fs/git (synthetic resolvers injected)
- [ ] an operator can see which repos are worktree-disabled and why on `keeper autopilot`

## Early proof point

Task that proves the approach: `.1` — the pure eligibility module. Its logic is already validated against all 56 `~/code/` repos via the categorization exercise; its unit tests pin that oracle. If it fails: the heuristic's signal set is wrong — re-derive the markers with the human before any wiring lands.

## References

- `README.md` `## Architecture` worktree section (~3285-3389)
- `src/git-toplevel.ts` — `memoizedNullableGitToplevel` (91-118) is the per-cycle memo + dep-light producer-module template to mirror
- `src/worktree-plan.ts` — `worktreePathFor` (165, always `~/worktrees/...`), `baseBranchFor`/`ribBranchFor` (130-142)
- `src/codex-trust.ts` — the existing hand-rolled, no-parser-dep TOML precedent
- The autopilot seams are verified at `src/autopilot-worker.ts` 655 / 1758 / 1835 / 1868 / 1937 / 2261 / 2487 / 3519 / 3943, and `src/readiness.ts` 1595 / 1901

## Docs gaps

- **`README.md` `## Architecture` (~3368-3378)**: reword the "Two distinct sticky rejects" sentence and introduce `disabled` as a SEPARATE non-error category (eligibility criteria, sequential shared-checkout dispatch, the memoized probe, grandfathering, and the non-sticky status surface).
- **`cli/autopilot.ts` worktree `--help` (~86-92)**: add under 3 lines noting some repos fall back to sequential shared-checkout dispatch when the heuristic fires.
- `CLAUDE.md`: no change — `disabled` mints no reason-string prefix and never touches `dispatch_failures` / recover-pass auto-clear scoping, so the producer-only guardrail covers it by generalization.

## Best practices

- **`package.json` `"workspaces"` key presence (even `[]`) = monorepo** — test key presence, not a non-empty array. [npm/turbo docs]
- **Cargo.toml `[workspace]` = workspace ALWAYS, even when `[package]` is also present** — the workspace-root-with-root-crate is the most common false-negative; only the absence of `[workspace]` is a single crate. [Cargo Book]
- **`[tool.uv.workspace]` = python workspace; `[tool.poetry]` alone is NOT a monorepo.** [uv docs]
- **`.gitmodules` -> unconditionally disable** — git worktree + submodule support is "incomplete" (pre-2.26 HEAD-overwrite corruption). [git-scm]
- **Fail closed (DISABLED) on any read/parse error** — fail-open risks a worktree against a monorepo/submodule repo, giving a fresh checkout the wrong dependency tree.
- **No naive `startsWith("[workspace]")`** — anchor on a line boundary and strip same-line comments; a parser-ambiguous existing file fails closed.
