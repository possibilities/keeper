## Overview

Make an epic's creator/refiner edges (the `epics.job_links` / `jobs.epic_links`
projections rendered on the board) derive from the durable planctl COMMIT —
`Planctl-Op` + `Planctl-Target` (already written) plus a new `Session-Id`
trailer — instead of the fragile bash-stdout `planctl_invocation` envelope
scrape. Any pipe / redirect / `grep` / `head` / output-truncation on a planctl
command hides the envelope today (`events.planctl_op` lands NULL) and the edge
silently never forms, even though the epic still projects via the robust
plan-worker file-watch. Deriving from the commit makes the edge survive client
AND server reboots and any stdout mangling. The commit-trailer facts feed the
SAME sole edge writer (`syncPlanctlLinks`) as a deduped union with the legacy
scrape — no second writer, no race, re-fold converges by construction.
Fix-forward: no historical backfill (fn-635 stays orphaned; this prevents
recurrence).

## Quick commands

- End-to-end (after all tasks): scaffold a throwaway epic with planctl stdout
  piped through `grep`, then
  `sqlite3 ~/.local/state/keeper/keeper.db "SELECT job_links FROM epics WHERE epic_id='<id>';"`
  → the creator edge is present via the commit path despite the scraped NULL.
- `bun test test/git-worker.test.ts test/reducer.test.ts test/board.test.ts test/schema-version.test.ts`

## Acceptance

- [ ] planctl stamps `Session-Id: <PLANCTL_SESSION_ID>` on `chore(planctl)` commits (omitted, commit still lands, when the env var is absent)
- [ ] git-worker lifts `Planctl-Op` / `Planctl-Target` onto the `Commit` event payload (stride-correct for N-commit deltas, NULL on pre-feature events)
- [ ] `syncPlanctlLinks` emits the deduped union of scrape events + commit-trailer facts; it stays the single writer of the edge cells
- [ ] a scaffold whose stdout scrape yielded NULL `planctl_op` still produces a creator edge via the commit trailer (fix-forward proof)
- [ ] `SCHEMA_VERSION = 54` and `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` includes 54 in the same change; from-scratch re-fold is byte-identical over a log containing pre-feature `Commit` events
- [ ] the board renders many creator/refiner edges per epic, durable across restarts

## Early proof point

Task that proves the approach: `.3` (reducer union + the commit-only fixture) —
a scaffold whose stdout scrape yields NULL still produces a creator edge via the
commit trailer. If it fails: the commit-trailer fact isn't reaching
`syncPlanctlLinks`'s union — re-check task `.2`'s payload freeze and the
`foldCommit` trigger.

## References

- **fn-681** commit-driven planctl ingest channel — the git-worker commit channel this reuses (`isPlanctlChangedPath`, `enumerateCommitsInDelta`).
- **fn-670** deterministic committing-session — `Session-Id`/`Job-Id` coalesce + the T2 task-link `foldCommit` sub-arm: the trailer-parse + fold-arm template.
- **fn-664.2** content-aware commit discharge — the `foldCommit` machinery and producer-time freeze discipline.
- Proven failure: arthack `fn-635-extract-planctl-into-standalone-repo` — its scaffold stdout was piped through `grep`, event 264079 landed `planctl_op` NULL, no creator edge. fn-635 itself stays orphaned (fix-forward); this epic prevents recurrence.
- planctl is now standalone at `/Users/mike/code/planctl` (commit.py:226 is the stamp site). The arthack fn-635 extraction is DONE, so there is no upstream blocker.

## Docs gaps

- **CLAUDE.md**: revise the v45/fn-664.2, v49/fn-670, and v46/fn-666 bullets — add `Planctl-Op`/`Target`/`Session-Id` to the commit-trailer list, note `foldCommit` now also triggers the edge rebuild, and prune the claim that the stdout envelope is the creator/refiner source (it still drives `file_attributions`).
- **README.md** Architecture: `planctl_*` column description (~46-78), the `syncPlanctlLinks` blocks (~1063, ~1488-1492), the `foldCommit` changelog paragraph (~1135-1175), the cheatsheet SQL comments (~1761-1773).
- **src/types.ts** / **src/plan-classifier.ts**: JSDoc + module-header source-of-truth sentences (`/plan:plan` window → commit-trailer union).

## Best practices

- **Freeze trailers at producer time; never shell git inside a fold** — the git-worker lifts, the reducer reads only the payload (re-fold determinism).
- **Event-type / id precedence, never wall-clock, for any source disambiguation** — a `ts`-based merge breaks re-fold determinism.
- **Stamp the same opaque v4 session UUID the hook uses; no PII in trailers** — honors `job_id === session_id`; commit metadata is forever-data replicated to every clone.
- **Bump `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` in the SAME change as `SCHEMA_VERSION`** — else every `commit-work` on the host fails loud (`test/schema-version.test.ts` enforces).
