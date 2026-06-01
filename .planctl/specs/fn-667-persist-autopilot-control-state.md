## Overview

The autopilot paused/playing flag lives only in main's memory
(`src/daemon.ts:760`, `autopilotPaused`) and the `keeper autopilot` TUI
hardcodes `state.paused = true` (`cli/autopilot.ts:754`), so the banner
ALWAYS reads `[paused]` even while autopilot is playing and dispatching.
This epic turns autopilot state into its own event-sourced projection —
a `autopilot_state` singleton fed by an `AutopilotPaused{paused}`
synthetic event, folded like `dispatch_failures`, and read by the viewer
via `subscribeCollection`. End state: the banner reflects real
paused/playing state, and the projection is a growing control plane
(concurrency caps / stagger / per-repo gates land as future columns +
events). Boots-paused safety is preserved by appending an
`AutopilotPaused{paused:true}` at boot.

## Quick commands

- `keeper autopilot play && sqlite3 ~/.local/state/keeper/keeper.db "SELECT id,paused,last_event_id FROM autopilot_state"` — row shows `paused=0` after play
- In one terminal run `keeper autopilot`; in another run `keeper autopilot play` — the live TUI banner flips `[paused]` → `[playing]` (the bug being fixed)
- `bun test test/reducer.test.ts test/autopilot.test.ts test/schema-version.test.ts` — fold, viewer, and whitelist coverage green

## Acceptance

- [ ] Pausing/playing autopilot is recorded as an `AutopilotPaused` event and folded into a persisted `autopilot_state` projection
- [ ] The `keeper autopilot` TUI banner reflects the real current paused/playing state (no longer hardcoded), updating live via subscription
- [ ] Daemon still boots paused (safety re-arm via boot-append), and a re-fold from scratch reproduces a byte-identical `autopilot_state` row
- [ ] `SCHEMA_VERSION` bumped to the next free integer with keeper-py `SUPPORTED_SCHEMA_VERSIONS` updated in the same change; full test suite + lint pass

## Early proof point

Task that proves the approach: `fn-N.1` — the end-to-end vertical
(event → fold → projection → subscription → banner). If it fails: the
projection/subscription wiring diverges from the `dispatch_failures`
template; re-check `src/collections.ts` REGISTRY + `cli/autopilot.ts`
subscribe against that mirror before anything else.

## References

- The `dispatch_failures` vertical (fn-661) is the exact template: `src/reducer.ts:2694-2886` (payload/extract/fold), `src/collections.ts:634-678` (descriptor + REGISTRY), `cli/autopilot.ts:803` (subscribeCollection), `src/daemon.ts:924-987` (retry-dispatch RPC→synthetic-event mint).
- `fn-664` (gate commit discharge on worktree oid) — owns schema v44 (its .1 shipped); land-order is satisfied, but it shares the `src/db.ts` migration region + `src/reducer.ts`.
- `fn-666` (attribute planctl file writes) — also bumps SCHEMA_VERSION and touches `src/reducer.ts` / `src/db.ts` / `keeper/api.py` / `test/schema-version.test.ts`; whichever lands second takes the next free integer. **Read the live `SCHEMA_VERSION` at code time — do not hardcode 45.**

## Docs gaps

- **CLAUDE.md**: splice `AutopilotPaused` into the sole-writer synthetic-event list (~63-67); revise the "no general write path" RPC carve-out list (~99-111) — the pause flag is no longer "never persisted," it now round-trips through an event + projection (state it as carve-out #5, same shape as `retry_dispatch`); invert/replace the autopilot-dispatch-gates bullets (~174-193) that claim the `[paused]` banner is NOT authoritative and there is no `get_autopilot_paused` query, and the "in-memory only and never persisted" line → describe the boot-append re-arm.
- **README.md**: viewer description (~589-594) and reconciler prose (~1107-1108) — the "never persisted, restart returns to safe-by-default" guarantee is now maintained by the boot-append, not by volatility; add a v45 entry to the schema-version trail (~960).
- **keeper/api.py**: add the new version to `SUPPORTED_SCHEMA_VERSIONS` (~93) and the whitelist comment block (~77-90), noting keeper-py reads neither the new table nor event (whitelist-only).

## Best practices

- **Typed value-carrying event over a generic `SettingChanged{key,value}`:** keeps each knob's invariants co-located and validatable; future knobs each get their own value-carrying event ([planetgeek.ch event-versioning 2026](https://www.planetgeek.ch/2026/05/19/event-sourcing-trade-offs-of-event-versioning-and-migrating-approaches/)).
- **Fold is a pure function of the event payload + `event.ts`:** never `Date.now()`, never re-read the projection inside the fold (keeper invariant; [microservices.io event sourcing](https://microservices.io/patterns/data/event-sourcing.html)).
- **Singleton row, UPSERT preserving `created_at`:** mirror `foldDispatchFailed`. keeper folds in strict total-order so an out-of-order version guard is defensive-only, not required.
- **Boot-event-every-start is a generic-ES anti-pattern — but keeper's re-fold ≠ replay** (it re-drains the existing log, never re-runs boot), so the boot-append is safe and matches the established `seedKilledSweep` precedent. Residual cost: ~1 event per daemon restart — accepted; note it in the migration-slot comment.
