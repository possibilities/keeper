## Overview

Remove all static priority/ordering machinery from keeper's plan fold and
state. The backend returns epics in plain creation order (`epic_number ASC`)
as a neutral seed; clients (board, autopilot) consume that order through a new
readiness-owned `orderEpicsForScheduling` seam — today an identity passthrough,
the single future home for any runtime priority (which will live on the
autopilot surface, never epic/board state). This deletes the `sort_path`,
`queue_jump`, and `created_by_closer_of` `epics` columns, the `events.plan_queue_jump`
column, the `[slotted-after-closer]` board pill, and the `/queue` surface
(`/plan:next` skill + `keeper plan epic queue-jump` verb). It is a deliberate
simplification/removal — it adds no new priority behavior. It largely reverses
fn-621 (slot-after-closer epic ordering) plus the later queue-jump + await coupling.

End state: one orderless `epics` fold that re-folds byte-identically; board +
autopilot read creation order via the seam; no priority knobs anywhere in
plan metadata/state.

## Quick commands

- `keeper plan board --snapshot` — epics render in `epic_number` order, no `[slotted-after-closer]` pill.
- `bun run test:full` — full slow tier (db/reducer/readiness/autopilot/await + plan plugin).
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "PRAGMA table_info(epics)"` — no `sort_path`/`queue_jump`/`created_by_closer_of`.
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "PRAGMA table_info(events)"` — no `plan_queue_jump`.
- `keeper plan epic --help` — no `queue-jump` verb.

## Acceptance

- [ ] `SCHEMA_VERSION` bumped to 85 and 85 added to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the SAME commit (`test/schema-version.test.ts` green).
- [ ] `epics` no longer carries `sort_path`/`queue_jump`/`created_by_closer_of`; `events` no longer carries `plan_queue_jump`; no dead NULL-stub columns left behind.
- [ ] The v85 migration re-folds the `epics` projection byte-identically (a from-scratch re-fold equivalence guard, fed legacy queue_jump/sort_path events, passes).
- [ ] Backend default order is `epic_number ASC` (tie-break `epic_id`); board + autopilot consume it through `orderEpicsForScheduling`.
- [ ] `[slotted-after-closer]` pill, `closerChildrenOf`/`followup`, `/plan:next`, and `keeper plan epic queue-jump` are all gone.
- [ ] `created_by_close_of` (the close-saga audit-follow-up stamp) is UNTOUCHED.
- [ ] `bun run test:full` green.

## Early proof point

Task that proves the approach: `.1` (the keeper-binary migration + orderless re-fold). If the re-fold equivalence guard or a clean boot-drain to v85 fails, the migration mechanism is wrong — fall back to a finer-grained table rebuild and re-verify determinism before touching consumers. `.2` (plan plugin) is low-risk and independent.

## References

- `.keeper/specs/fn-621-slot-after-closer-epic-ordering.1.md` — the change this reverses (schema v29 + rewind precedent).
- `src/db.ts` rewind-and-redrain precedent: v81/fn-888 (~:4690-4721), v80 (~:4625-4656); v82 `file_attributions` table-rebuild (~:4818-4856).
- Overlap: fn-934 also bumps `SCHEMA_VERSION` in `src/db.ts` + `keeper/api.py` — must serialize (wired as an epic dep).

## Rollout

Schema-bump serialized behind fn-934 via an epic dep so the two `SCHEMA_VERSION`
bumps don't collide (whichever lands first takes the next version; this epic
rebases onto the result). On daemon restart onto v85 the boot drain re-folds
every projection from cursor 0 — a one-time full re-fold. No runtime downgrade
path (an old binary refuses a v85 DB by the existing guard).
