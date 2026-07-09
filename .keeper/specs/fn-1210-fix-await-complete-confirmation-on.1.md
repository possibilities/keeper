## Description

Rework the `complete`-await stability confirmation (fn-1207) so it no longer
depends on a second change-driven subscribe frame arriving.

Originating findings (see the epic's Audit decisions table):
- F1 (Critical, kept): `advanceCompleteStability` requires `streak >= 2`
  (src/await-conditions.ts:453, `COMPLETE_CONFIRMATIONS=2` at :418), wired into
  `evaluate` in cli/await.ts:1681-1707 so a completed-but-unconfirmed observation
  downgrades to `waiting`. But `diffTick` emits a patch once per advance
  (src/server-worker.ts:507) and freezes on a DB-quiet board (:2565), and
  `keeper await complete` is reconnect-forever with no give-up timeout
  (cli/await.ts:143). So a target that reads `completed` as the FINAL board
  activity delivers one frame, `streak` stalls at 1, and `met` never fires — an
  indefinite hang and a regression from the prior first-frame `met`. Covers both
  direct/scripted callers and a target that completes-then-settles-quiet after arming.
- F2 (merged into F1): a `completed -> running -> completed` flap resolving within
  one poll (`DEFAULT_POLL_MS = 50`) is coalesced by `diffTick` into a single
  `completed` patch at a higher version, so the intervening `running` never resets
  the streak and the flap is confirmed anyway. Same root cause: counting coalesced
  FRAMES is the wrong confirmation basis. The fix must NOT simply raise N — that
  worsens F1's quiet-board hang.
- F3 (merged into F1): no existing test exercises the live-delivery interaction;
  every stability test drives the pure `advanceCompleteStability` machine or
  hand-delivers a second frame. Add the missing test as part of this fix.

Files: cli/await.ts, src/await-conditions.ts, test/await.test.ts,
test/await-conditions.test.ts (and the delivery model in src/server-worker.ts as
read-only context). Prefer driving the confirmation off elapsed dwell / a bounded
re-evaluation timer (or counting the initial-paint `completed` as confirm-eligible
after a short dwell) rather than a second distinct frame delivery, so a quiet board
confirms while a genuine reconcile flap still resets.

## Acceptance

- [ ] `keeper await complete <id>` fires `met` on a genuinely quiet board where the target reads `completed` as the final board activity (no further frame delivered), for both direct callers and a target that completes-then-settles-quiet after arming.
- [ ] The done-unwind flap is still debounced — including a flap whose intervening `running` is coalesced away by `diffTick` — without simply raising `COMPLETE_CONFIRMATIONS` in a way that regresses the quiet-board case.
- [ ] A test arms `complete`, delivers NO further frame after the first `completed`, and asserts `met` fires (the live-delivery interaction current tests assume by hand).

## Done summary
Reworked keeper await complete confirmation from counting change-driven subscribe frames to debouncing on elapsed dwell at a stable target-row version. A quiet board now confirms via a bounded re-evaluation timer with no second frame (fixing the F1 indefinite hang), while a done-unwind flap — including one whose intervening running is coalesced away by diffTick — bumps the row version and restarts the dwell.
## Evidence
