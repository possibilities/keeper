## Overview

Add a global, dynamic concurrency cap for keeper autopilot dispatch. A new
config key `max_concurrent_jobs` (default unlimited) sets a ceiling on how
many root-occupants autopilot will run at once across ALL epics/roots —
behaving like the existing single-per-root mutex but with a configurable N
instead of a hard 1. The cap is enforced as a reconcile-level budget (not a
readiness verdict, so the board renders unchanged) and its value is surfaced
on the autopilot TUI next to the play/pause indicator. Restart-to-apply,
exactly like every other keeper config key.

## Quick commands

- `echo 'max_concurrent_jobs: 3' >> ~/.config/keeper/config.yaml` then restart keeperd — `keeper autopilot` banner shows `· max 3`; with 3 root-occupants live, no 4th dispatches.
- `bun test test/config.test.ts test/autopilot-worker.test.ts test/autopilot.test.ts test/schema-version.test.ts`

## Acceptance

- [ ] `max_concurrent_jobs` parses from config.yaml (positive integer only; 0/negative/non-integer/absent → unlimited), independent of sibling keys.
- [ ] Autopilot dispatches at most N concurrent root-occupants globally; planners are exempt from the count; N=unlimited preserves today's behavior exactly.
- [ ] The autopilot TUI shows the cap next to `[paused]`/`[playing]`, sourced over the socket from the `autopilot_state` projection — the viewer never reads config.yaml.
- [ ] `null`=unlimited round-trips SQLite + wire and renders as `∞`.
- [ ] Schema bump is mirrored in `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS`; a cursor=0 re-fold reproduces byte-identical `autopilot_state` rows.

## Early proof point

Task that proves the approach: `.1` (config + reconcile budget enforces the cap end-to-end, testable without any UI). If it fails: the budget-vs-occupancy counting model is wrong — revisit whether `occupied` must count post-mutex verdicts over both perTask and perCloseRow before building the delivery layer.

## References

- Depends on fn-721 (done): extended the canonical occupant set (`isLiveWorkOccupant`/`isRootOccupant`) to include `dispatch-pending`; this epic's budget loop inherits that set and MUST NOT narrow the predicate.
- Overlap fn-724 (in_progress): edits `src/autopilot-worker.ts` (`confirmRunning`/`emitDispatched`/set-paused) and `src/daemon.ts` (`handleDispatchedMint`) — HIGH merge-conflict surface; sequence after it.
- Overlap fn-723 (todo): edits `cli/autopilot.ts` teardown seam (`installSigintHandler`/dispose) — lower conflict; sequence after it.

## Best practices

- **Optimistic decrement:** compute `occupied` once per cycle before the loop, thread a mutable budget int down, decrement eagerly before each push (Go `semaphore.Weighted` / Tokio / p-limit). Never re-read the projection mid-loop (WAL snapshot consistency).
- **`null` not `Infinity` at rest:** `Infinity` serializes to `null` via JSON and fails SQLite; keep `null`=unlimited in config + column + wire, convert to a fast-path bypass (not `Infinity` arithmetic) only at the budget gate.
- **Strict `budget > 0` gate:** cap=1, occupied=1 → budget=0 → block the next (CWE-193 off-by-one).
- **Predicate parity:** count and the per-root mutex must use the SAME `isRootOccupant` (planner-exempt) or the two counts drift.
- ~~**Approval-pending starvation is correct, not a bug:** cap=1 with a held done+approval-pending slot dispatches nothing until a human approves — document it.~~ **SUPERSEDED by fn-728:** `approve`-verb launches are now exempt from the cap (a backlog of pending-approval rows must not deadlock its own approvers); the cap bounds only `work`/`close`.

## Docs gaps

- **keeper/CLAUDE.md**: add a "global max concurrent jobs cap" bullet under "Autopilot dispatch gates" (counts root-occupants across all epics, applies at reconcile before per-epic dispatch, defaults unlimited, config.yaml). NOTE: a budget skip does NOT hold a slot, so it does NOT get the "verbForVerdict returns null / held slot UNDISPATCHABLE" closing line.
- **README.md**: config-key table (~line 285-308) add `max_concurrent_jobs` + YAML example; autopilot CLI ref (~706) banner one-liner mentions the cap; schema-version changelog (~1396-1500) new entry once the version is known.

## Snippet context

No promptctl snippets/bundles attached: searched the library for event-sourcing/reducer/migration and autopilot/reconcile/concurrency topics — zero hits. Keeper's conventions for these live in keeper/CLAUDE.md (event-sourcing invariants, autopilot dispatch gates, schema-version coupling), which the worker reads directly.
