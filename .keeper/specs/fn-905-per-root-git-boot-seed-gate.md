## Overview

The autopilot stops dispatching when the git boot-seed leaves
`git_projection_state.seed_required` set: the fn-897 gate forces EVERY
readiness row to `{kind:unknown}`, so one unseeded root (often a stale,
irrelevant repo) darks the whole board — and nothing clears the flag except
a future complete boot-seed (no steady-state recovery). This epic makes the
gate behave per-root and self-healing WITHOUT a schema change: scope the
boot-seed to plan-relevant roots, make the readiness gate consult
`seed_required` per-root (force `unknown` only for rows whose `effectiveRoot`
is not yet seeded above the floor), and let the flag self-clear via the
boot-seed plus the live git-worker's emit folded by main. End state: a
stale/failed root never blocks dispatch into a healthy root, and a
transiently-missed root recovers on its own.

## Quick commands

- `keeper board` shows ready work AND `keeper autopilot --snapshot` dispatches it even while an unrelated root is unseeded (the coupling is gone).
- After a daemon bounce: `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT seed_required FROM git_projection_state"` self-clears once the gated roots seed; a stale `/Volumes/Scratch` root never appears in the gated set.
- `bun run test:full` green (mandatory — daemon/worker/db/readiness/git paths).

## Acceptance

- [ ] A single unseeded/failed root blocks dispatch only into THAT root's rows, never the whole board.
- [ ] `seed_required` self-clears in steady state (no daemon bounce required) once every gated root is seeded — via the boot-seed and main's above-floor git fold, never a git-worker write and never a retry loop.
- [ ] The boot-seed scans only plan-relevant roots (open-epic `project_dir` + task `target_repo`), not the full historical `jobs.cwd` sweep.
- [ ] A per-root boot-seed read failure is logged (root + reason), not silently skipped.
- [ ] Re-fold stays byte-identical for the deterministic-replayed projections; no schema bump.
- [ ] CLAUDE.md + README prose updated to describe the per-root, self-clearing gate.

## Early proof point

Task that proves the approach: `.1` (scope + self-clear + log). It directly
fixes the incident class (no-recovery + amplifier) on its own, even before
the per-root gate lands. If it fails: the per-root gate in `.2` still fixes
the COUPLING (others dispatch) independently, so the epic degrades to
isolation-only rather than full self-heal.

## References

- fn-897 introduced the `seed_required` boot gate (`src/readiness.ts:503-509`) and the two-gate boot sequence this builds on.
- Commit `fe7f3a63` fixed a SEPARATE readiness predicate-8 forward-dep bug found in the same investigation — out of scope here, but it also edits `src/readiness.ts` (a different region).
- The wedge was reproduced live: a transient `readStatus`→null at boot left `seed_required=1`; a re-bounce reseeded and cleared it.

## Best practices

- **Model readiness per-root, not as a global scalar:** the autopilot should gate only the roots relevant to the work it dispatches (bulkhead / fault-isolation). [practice-scout]
- **`unknown` is never `clean`:** the gate must keep forcing `unknown` (never let an unseeded root read clean and dispatch into a dirty repo). [practice-scout]
- **Self-heal via the live producer's emit, NOT a retry loop:** a second writer re-scanning failed roots races the git-worker (TOCTOU); the live emit folded by main is the single-writer recovery path. [practice-scout]
- **Capture `floor = max(events.id)` BEFORE the scan:** unchanged here; capturing after silently drops events that arrive during the scan. [practice-scout]

## Docs gaps

- **CLAUDE.md**: the projection-class taxonomy / boot-producer contract / "Unseeded git reads as UNKNOWN" prose (lines ~65-99) describes a single global `seed_required`; revise in place to the per-root, self-clearing model (current state only, no V1/V2 framing).
- **README.md**: the `## Architecture` git-surface subsection (~1860-1890) and two-boot-gates section (~130-140) name `seed_required` / the `git_seed_required` boot-status field; update to the per-root gate + the additive seeded-set boot-status field.

## Alternatives

- **Persisted per-root `git_seeded_roots` latch table (sticky):** rejected — needs a SCHEMA_VERSION bump + `LIVE_ONLY_PROJECTIONS`/`rewindLiveProjection` wiring + `SUPPORTED_SCHEMA_VERSIONS`. Unnecessary: bounding the per-root gate to the `seed_required`-set window makes derivation sound without persisted state (retracts only happen post-clean-dwell, after the flag has cleared).
- **Always-on derived per-root gate (no global flag):** rejected — non-sticky. `retractGitStatus` DELETEs a clean non-`.keeper` root's `git_status` row, so an always-on derived gate re-wedges that root after it goes clean.
- **Background retry loop re-scanning failed roots:** rejected — competing-writer race with the live git-worker (TOCTOU). The live emit is the sanctioned single-writer self-heal.

## Architecture

`seed_required` STAYS a global boolean (it still drives `catching_up` and the
coarse `gitCleanState` gate), but its role narrows:

- **Self-clearing:** the boot-seed clears it once all GATED roots seeded
  (best-effort for stale ones); for a root the boot-seed missed, main's
  above-floor `GitSnapshot` fold (`projectGitStatus`) clears it once every
  gated root has a `git_status` row with `last_event_id > floor`. The clear
  lands in MAIN's fold, never a git-worker write — producer-only preserved.
- **Per-root consultation:** while set, the readiness gate forces `unknown`
  ONLY for rows whose `effectiveRoot` lacks a `git_status` row above the
  floor, keyed identically to the per-root mutex's `effectiveRoot`.
- **Floor capture** before scan is unchanged. No migration; no new projection.

## Rollout

No schema change → no migration. Land behind `bun run test:full`; deploy by
bouncing the daemon (`launchctl kickstart -k gui/$(id -u)/arthack.keeperd`).
Rollback = plain revert (no data migration to undo). Post-deploy, verify on a
real bounce that an unseeded stale root does not block keeper-root dispatch
and that `seed_required` self-clears.
