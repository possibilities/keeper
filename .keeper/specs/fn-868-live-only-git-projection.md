## Overview

Make keeper's git surface (`git_status` + `file_attributions` + the 3 git-derived
`jobs`/`epics` columns) a **LIVE-ONLY projection**: never replay historical
`GitSnapshot` events; a boot-seed PRODUCER re-derives current git state on boot;
a monotonic `events.id` skip-floor makes git folds no-op for `id ≤ floor`; live
events keep it current. Result: re-fold / rewinding-migration / restart completes
in SECONDS at 4.3M+ events instead of ~6 DAYS. This is the FOUNDATION that unblocks
the planctl strip (fn-864/fn-865) and the safe return to yolo autopilot. Pattern is
Marten's "Live projection lifecycle"; the carve-out from re-fold determinism is
deliberate and scoped to git, declared via a central projection-class registry.

## Quick commands

- `bun run test:full` (mandatory — db/daemon/reducer/git paths)
- copy-proof: `KEEPER_DB=/tmp/cp.db bun run <migrate-test>` on a copy of the live 1GB DB → v76→78 migrate completes in seconds, git folds skipped, git surface correct for currently-dirty files
- `keeper await git-clean` works immediately after boot (boot-seed populated `git_status` before serve)

## Acceptance

- [ ] A re-fold / rewinding migration over the 4.3M-event log completes in seconds (git `GitSnapshot`/discharge folds no-op for `id ≤ floor`); the daemon serves
- [ ] Boot-seed re-derives `git_status` + `file_attributions` + the 3 jobs git-counters at full fidelity for currently-dirty files (`commit-work`/`await git-clean`/readiness consumers keep working)
- [ ] Re-fold determinism stays byte-identical for the OTHER ~16 projections; the live-only surface is excluded from the charter via a central registry
- [ ] `bun run test:full` green; the migration-viability copy-proof passes

## Early proof point

Task `.1`'s **copy-proof**: take a copy of the live v76 DB (4.3M events), run the
redesigned migrate + boot-seed, assert (a) completes in seconds, (b) `git_status`/
`file_attributions`/3 jobs-columns match a full replay's result FOR CURRENTLY-DIRTY
files, (c) the runtime-downgrade guard still refuses an old binary. If it fails:
the live-tail-equivalence claim is wrong — fix before any live cutover.

## References

- Panel verdict (`opus4.8-gpt5.5`) + scouts: this is Marten's Live lifecycle; floor read as `max_id` BEFORE the git scan (events during the scan re-apply idempotently); persist floor + seed atomically; cold-start (floor=0/NULL) vs resume.
- The incident: fn-856 v77 rewind forced a 4.3M-event re-fold; `computeRepoBashWindows` (`reducer.ts:1601`) self-joins the whole log per GitSnapshot × 18,326 = ~6 days. Incremental folds are ~337ms.
- fn-867 (in HEAD) deleted readiness predicate 6.5 → the 3 jobs git-columns are now display-only (`collections.ts:90-95`); declare them live-owned.
- keeper-py stopped reading git tables (`api.py:49-106`); bump `SUPPORTED_SCHEMA_VERSIONS` (`api.py:337`) with any SCHEMA_VERSION bump.

## Architecture

Projection-class taxonomy (new central registry): **deterministic-replayed** (the
sacred default — jobs/epics/commit_trailer_facts/… byte-identical re-fold) /
**live-producer-fed** (git_status, file_attributions, the 3 jobs git-columns — NOT
replayed; boot-seeded + incremental; NOT wiped on rewind) / **control** (reducer_state,
the new floor + seed_required). Boot: migrate → ingest → drain (git no-ops ≤ floor) →
seedKilledSweep → **git boot-seed producer** (id > floor, before serving) → autopilot
re-arm → spawn git-worker (first-emit suppressed). Floor gate lives INSIDE `applyEvent`
by event type (`reducer.ts:7290-7464`), NOT in drain SQL (the global cursor must
advance for the other 16 projections).

## Docs gaps

- **CLAUDE.md** (event-sourcing-invariants block: projection-class taxonomy + skip-floor + "a fold whose per-event cost grows with history is a re-fold time-bomb" rule + boot-producer contract; Migrations block: no-wipe-live-projections discipline) + **README ## Architecture** + **docs/planctl-strip.md §3a/§4** + the charter test doc comment + `cli/find-file-history.ts` reword — handled in `.2`.

## Best practices

- Name the live-only exemption first-class (Marten Live lifecycle); don't read git/clock in the live fold above-floor (producer only); floor is per-surface, not global; scope floor write-access to the daemon. [practice-scout]
- The general rule worth codifying: any projection whose per-event fold cost grows with history length is a replay time-bomb — model it live-only or constant-bounded, never O(history)-per-event. [practice-scout]

## Rollout

Orchestrator-driven (the planning session pilots this; NOT worker tasks):
1. **Base reconcile (pre-dev):** restore working tree → HEAD/v78, apply `/tmp/v78-residual-fix.patch` (fn-864's residual-check fix) so the v78 migration is correct. The live v76 daemon keeps serving in-memory; HOLD launchd KeepAlive so a crash can't auto-restart it onto incomplete v78.
2. **Build** `.1`+`.2` on HEAD/v78 (armed autopilot dispatching ONLY this epic, or `/plan:work`).
3. **Copy-proof** (`.1`'s gate): on a copy of the live 1GB DB, assert v76→78 migrate + boot-seed is fast + correct.
4. **Cutover:** fresh DB backup → re-enable launchd → restart daemon → migrates v76→78 viably → serves v78.
5. **Post:** reconcile fn-864 (its migration now correct + landed via cutover); resume fn-865 / Problems B+D; then resume **yolo** autopilot.
