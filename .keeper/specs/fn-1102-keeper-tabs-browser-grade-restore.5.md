## Description

**Size:** S
**Files:** src/restore-worker.ts, src/tabs-core.ts, src/db.ts, test/restore-worker.test.ts

### Approach

The restore-worker maintains a runnable revive script side-file
(revive.sh next to restore.json in the keeper state dir) on the same
data_version pulse as the JSON mirror: render via the shared
src/tabs-core.ts renderSnapshotScript from the same live set the JSON
uses but with plan_verb='work' excluded — an intentional membership
divergence (the script is a human replay surface where
reconciler-managed workers double-spawn; document it in both file
headers). Gate on its own timestamp-stripped content hash, and write via
atomicWriteFile extended with an optional mode parameter so 0600 lands on
the temp file before rename (agent titles and cwds ride in the script).
Write failures swallow to stderr exactly like restore.json — a side-file
concern never crashes the daemon — and one file's failed write never
skips the other's. The script is dump-only: nothing reads it back;
crash-restore still derives from keeper.db.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/restore-worker.ts:354 — buildRestoreTier; :435,:450 — serializeForHash / serializeForWrite; ~:636 — the hash gate; :828 — the write-failure swallow; :64-68 — the write-failure policy comment
- src/db.ts:6088 — atomicWriteFile (add the optional mode without changing existing call sites)
- src/tabs-core.ts — renderSnapshotScript (from the dep task)

**Optional** (reference as needed):
- test/restore-worker.test.ts — existing side-file fixtures

### Risks

- Two side-files with independent hash gates can diverge for one pulse when one write fails — acceptable, the next pulse heals; the test must pin that the swallow path still attempts the second write.

### Test notes

Fixtures assert: the script lands next to restore.json with mode 0600;
work-workers absent; header counts present; the hash gate suppresses
no-op rewrites; a JSON-write failure does not block the script write and
vice versa.

## Acceptance

- [ ] A current runnable revive script exists on disk after any live-set change, reconciler-managed workers excluded, mode 0600
- [ ] Unchanged live sets rewrite nothing, and a failed side-file write warns without crashing the worker or blocking the sibling write
- [ ] The JSON mirror's membership and schema are unchanged by the new sibling

## Done summary
restore-worker now maintains a durable revive.sh next to restore.json on the same data_version pulse (via shared renderSnapshotScript, reconciler-managed workers excluded), with its own hash gate, 0600 mode via atomicWriteFile's new optional mode param, and independent swallow-on-failure writes.
## Evidence
