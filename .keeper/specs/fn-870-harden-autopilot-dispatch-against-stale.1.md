## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/daemon.ts, test/refold-equivalence.test.ts, test/reducer-projections.test.ts, test/daemon.test.ts, CLAUDE.md, README.md

### Approach

Make `pending_dispatches` an EPHEMERAL projection — runtime launch-window
state rebuilt from current reality at boot, never replayed from history (the
root cause of the jam). Mechanism: **boot-truncate-after-drain** — after the
boot drain completes and BEFORE the daemon serves, `DELETE FROM
pending_dispatches` so the in-flight set starts empty (the autopilot
re-derives genuine in-flight launches from live `jobs`/tmux panes; empty at
boot is correct and subsumes clearing any already-resurrected phantoms on the
upgrade path). **No SCHEMA_VERSION bump** — runtime behavior + code + comments
+ tests, not a schema change. SCOPE: ONLY `pending_dispatches` is reclassified;
`dispatch_failures` + `dispatch_never_bound` stay deterministic-replayed. Also
land the steady-state self-heal: the TTL sweep must expire a pending past the
ceiling regardless of `dispatch_failures` membership, the operator-clear fold
must also delete the pending row, and an expiry must not re-trip the breaker
for an already-failed key.

### Detailed phases

1. **Boot-truncate**: in `runDaemon` after the boot drain + before serving (mirror the `seedGitProjection` slot), `DELETE FROM pending_dispatches`. Verify nothing reads the projection between drain and serve.
2. **Reclassify metadata**: rewrite the `pending_dispatches` CREATE-TABLE docblock (`src/db.ts:~841`) to state ephemeral/not-replayed; add a machine-readable ephemeral marker parallel to `LIVE_ONLY_PROJECTIONS` (`src/db.ts:~1181`) so the charter test + tooling share one source of truth. Leave `dispatch_failures`/`dispatch_never_bound` classification unchanged.
3. **TTL sweep self-heal (BUG2)**: in `selectExpiredPendingDispatches` (`src/daemon.ts:~273`) expire aged pendings regardless of `dispatch_failures` membership (drop/loosen `WHERE df.verb IS NULL`), preserving the DispatchFailed-folded-late race intent (the expiry DELETE is idempotent with a concurrent DispatchFailed).
4. **Breaker-loop safety (Q6)**: `foldDispatchExpired` (`src/reducer.ts:~3646`) must NOT re-increment the never-bound counter when the key already has a `dispatch_failures` row — an expiry of an already-failed row just deletes the pending (a timeout is not a target failure).
5. **Clear-deletes-pending (Q5)**: `foldDispatchCleared` (`src/reducer.ts:~3479`) must also `DELETE FROM pending_dispatches` for the key (today it deletes only the failure + counter), so an operator clear immediately frees the slot. Keep the fold pure/idempotent.
6. **Charter + regression test**: exclude `pending_dispatches` from the byte-identical charter (`test/refold-equivalence.test.ts` `snapshotProjections:~737` / `rewindAndWipeProjections:~779`) via the new marker; add a resurrection regression test (seed historical `Dispatched` events, rewind + re-fold, assert `pending_dispatches` empty at serve). Add tests for sweep-clears-failed-pending and clear-deletes-pending.
7. **Docs**: CLAUDE.md projection-class taxonomy (name the ephemeral class; fix the stale byte-identical note for `pending_dispatches`); README `## Architecture` paragraph. Forward-facing only.

### Investigation targets

**Required** (read before coding):
- src/db.ts:841 `pending_dispatches` docblock; :1181 `LIVE_ONLY_PROJECTIONS` + :1217 `rewindLiveProjection` (registry pattern to mirror); :3959-3976 v77 rewind wipe list.
- src/reducer.ts:3593 `foldDispatched`, :3646 `foldDispatchExpired` (+ never-bound breaker :3682), :3651 pending DELETE, :3479 `foldDispatchCleared`, :6457-6471 SessionStart discharge-on-bind, :7358-7362 dispatch arms.
- src/daemon.ts:273 `selectExpiredPendingDispatches` (+ :266 race rationale), :212 `PENDING_DISPATCH_TTL_MS`, :3152 `handleDispatchExpiredMint`, :3210 `sweepExpiredPendingDispatches`, and the boot drain→serve slot (mirror `seedGitProjection` placement).
- test/refold-equivalence.test.ts:737/779 charter; test/reducer-projections.test.ts:1228-1259 (DispatchExpired) + :1561-1706 (never-bound K=3).

### Risks

- Half-reclassify hazard: charter-exclude without the boot-truncate (or vice versa) leaves the resurrection live — both must land together.
- Boot-truncate must run AFTER the drain (live folds applied) and BEFORE serving (no consumer sees phantoms); wrong placement drops genuine in-flight or serves phantoms.
- Dropping the sweep's df-guard must not corrupt the never-bound counter (phase 4 guards this).

### Test notes

`bun run test:full` mandatory (db/daemon/reducer paths). Use `freshDb`/`freshMemDb` in-process; the resurrection regression seeds `Dispatched` events then drains. Poll with `retryUntil`, never `Bun.sleep`.

## Acceptance

- [ ] `pending_dispatches` is empty at serve after a full re-fold over historical `Dispatched` events (resurrection regression passes); `dispatch_failures` + `dispatch_never_bound` re-fold byte-identically (unchanged)
- [ ] TTL sweep expires an aged pending even when a `dispatch_failures` row exists for the key; `foldDispatchExpired` does not re-trip the breaker for an already-failed key
- [ ] `foldDispatchCleared` also deletes the `pending_dispatches` row (pure/idempotent)
- [ ] `pending_dispatches` excluded from the byte-identical charter via a machine-readable marker; no SCHEMA_VERSION bump
- [ ] CLAUDE.md + README taxonomy/architecture prose updated (forward-facing); `bun run test:full` green

## Done summary
Reclassified pending_dispatches as an EPHEMERAL projection (boot-truncated after drain, before serving) so a rewinding migration's re-fold can't resurrect phantom dispatch rows. Made the TTL sweep expire aged pendings unconditionally on dispatch_failures membership, skipped the never-bound counter for already-failed keys, and widened DispatchCleared to delete the pending row. No SCHEMA_VERSION bump; test:full green.
## Evidence
