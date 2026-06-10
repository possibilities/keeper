## Overview

When an epic completes (folds to `status='done'`) it must drop off the
armed set — an epic can't be off the board and still armed. fn-751 built
`armed_epics` as a presence table written only by `EpicArmed` events, with
no lifecycle tie to completion, so a completed-while-armed epic keeps its
row (polluting the reconcile closure and the `[armed]` board pill). Two
defenses: (1) a fold-side prune that deletes the `armed_epics` row at the
completion snapshot — covers the normal lifecycle; (2) a daemon-side guard
that rejects arming an already-`done` epic — closes the arm-after-done
ordering hole the fold-prune alone can't reach. Re-fold determinism is the
acceptance bar.

## Quick commands

- `bun test test/reducer-projections.test.ts test/daemon.test.ts`
- `keeper autopilot arm <a-done-epic>`   # rejected once task .2 lands

## Acceptance

- [ ] A completed epic never appears in `armed_epics` (normal lifecycle, via fold-prune)
- [ ] Arming an already-`done` epic is rejected (arm-after-done hole closed, via daemon guard)
- [ ] Re-fold from empty reproduces zero `armed_epics` rows for any epic that ever folded to `done`
- [ ] No schema bump; CLAUDE.md + README updated for the second `armed_epics` writer + the arm-done rejection

## Early proof point

Task that proves the approach: `.1` (fold-side prune). If it fails: the
determinism invariant or the carve-out placement is wrong — revisit the
`ON-CONFLICT` boundary before layering on the guard.

## References

- fn-751 (autopilot armed mode) — built `armed_epics`, `EpicArmed`, `foldEpicArmed` (done)
- `src/reducer.ts:804` — the model unconditional `epic_tombstones` DELETE this prune mirrors

## Docs gaps

- **CLAUDE.md** ("Writes are tightly scoped" ~96-98, "## Autopilot" ~233-235): `armed_epics` gains a second writer (the EpicSnapshot fold prune) and arming a `done` epic is rejected — the "sole writer / append-only" prose needs tightening.
- **README.md** (RPC paragraph ~193-196, schema v62 narrative ~1647-1651, `keeper autopilot` CLI subsection ~853-877): same single-writer claim + the arm-done rejection note.

## Best practices

- **Unconditional DELETE, no SELECT-first guard:** a no-match DELETE is a safe no-op under a single-writer, in-order fold — don't pre-read. [event-driven.io / CockroachDB]
- **Don't transition-guard the delete** (no `previous_status` check): it breaks on the arm-after-done race; gate only on `status === 'done'`. [Architecture Weekly, Nov 2025]
- **Test the missing-insert + re-fold-from-empty cases:** DELETE on a never-armed epic, and a full replay leaving zero rows. [Marten / Azure ES]
