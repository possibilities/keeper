## Description

Finding F1 (with F6 merged). The write-grant leaf is the epic's central
exclusion lock ("an unexpired holder prevents every sibling from writing"),
but two mechanics can silently breach it:

- `listGrantLeaves` (`src/grant-leaf.ts:803`) increments its `inspected`
  counter on every directory entry and breaks at `MAX_TRUNK_LEASE_REQUESTS`
  (256), sorting by fencing token only after truncation — so once the shared
  grants dir exceeds 256 entries the scan can drop the one active holder
  before returning.
- Nothing reaps expired or dead-owner leaves: `expireRepairGrant` only
  rewrites `expires_at`, and there is no unlink/remove of a grant leaf
  anywhere in the daemon. Leaves accumulate one per distinct
  `(parent_job_id, agent_type)` ever granted.

Together, `publishRepairGrant`'s `.some(... Date.now() < leaf.expires_at)`
exclusion check can return false while a live holder exists, publishing a
second grant for the same shared checkout -> two in-session repairers
writing one tree.

Fix: reap expired / dead-owner grant leaves in a bounded sweep, and/or
exempt the exclusion probe from the 256 scan cap so it never truncates
before deciding "no active holder." Preserve fail-open discipline (no throw
into the daemon loop) and the fencing-token monotonicity invariant.

Files: src/grant-leaf.ts (listGrantLeaves + a reaper), src/daemon.ts
(publishRepairGrant / expireRepairGrant call sites), test/grant-guard.test.ts
and/or test/daemon.test.ts.

## Acceptance

- [ ] The exclusion probe correctly detects the active holder even when the shared grants directory holds more than 256 entries.
- [ ] Expired / dead-owner grant leaves are reaped rather than accumulating unboundedly.
- [ ] A regression test exercises listGrantLeaves / the exclusion probe at and over the 256-entry cap (F6).
- [ ] Fail-open and fencing-token monotonicity invariants are preserved.

## Done summary
Made listGrantLeaves scan the full grants directory (no 256-entry truncation before the exclusion decision) and added a bounded, cursor-driven, fail-open reaper that unlinks expired dead-owner grant leaves while retaining the highest fencing token as the crash-safe monotonicity floor.
## Evidence
