## Overview

The escalation-retirement collapse folded the `block_escalations` latch into
the per-key `dispatch_failures` incident projection as `('block', task_id)`
rows, but two loose ends survived: the boot orphan-GC sweep now reaps those
live block rows (a correctness defect that silently un-escalates a still-blocked
task and reproduces a spurious clear into the append-only log on every re-fold),
and the retained base-schema literal that the migration depends on carries a
now-false doc comment. This follow-up closes both so the collapse's stated
invariant — a block row exists for as long as a plan task is blocked — actually
holds across a daemon boot.

## Acceptance

- [ ] A live `verb='block'` incident row survives a daemon boot / a direct
      `gcUnretryableDispatchFailures` call — it is NOT swept, and no spurious
      `DispatchCleared` is minted for it.
- [ ] A regression test seeds a `verb='block'` row into the boot-GC and asserts
      the row survives, alongside the existing exemption cases.
- [ ] The retained `CREATE_BLOCK_ESCALATIONS` literal's comment states it exists
      solely so the fresh-DB collapse migration can SELECT from it before
      dropping it — not a live projection.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | gcUnretryableDispatchFailures reads all dispatch_failures rows with no verb filter and lacks a `verb='block'` exemption; a live block row is deleted on every boot, un-escalating a still-blocked task and losing the page-once guarantee. |
| F2 | kept | .1 | The retained `block_escalations` literal's doc comment still calls it a live latch projection and omits that the literal survives only for v142 fresh-DB migration ordering, misleading a reader into deleting a literal the migration needs. |

## Out of scope

- Any change to the block-incident schema/columns (task 4 of the source landed
  them correctly and additively).
- The wider consumer re-pointing, which the audit confirmed correct everywhere
  except the boot-GC producer.
