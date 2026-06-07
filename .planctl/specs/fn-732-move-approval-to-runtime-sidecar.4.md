## Description

**Size:** S
**Files:** src/rpc-handlers.ts, src/server-worker.ts, src/daemon.ts, test/rpc-handlers.test.ts

Move keeper's own approval writers (`set_task_approval` /
`set_epic_approval`) to the sidecar, and remove the now-dead approval-kick
machinery.

### Approach

- **RPC retarget:** `rewriteApprovalField` + `setTaskApprovalHandler` /
  `setEpicApprovalHandler` write the sidecar
  (`state/{tasks,epics}/<id>.state.json`) instead of the def file —
  create-if-absent (mkdir parent + new file), task sidecar via
  read-modify-write to preserve `status`, reusing `serializePlanctlJson` /
  `atomicWriteFile` so the bytes match planctl's form. Apply the existing
  path-traversal guard (`rejectPathTraversal`) to the new sidecar path
  construction.
- **Drop the kick:** remove `approvalKickSignal` / `fireApprovalKick`
  (rpc-handlers.ts:163-189) and the `kick-plan-worker-request` wiring in
  `server-worker.ts` (~:2657-2663) and its handler in `daemon.ts`
  (~:1262). It existed only to paper over the uncommitted-approval
  fn-629 lag; the sidecar fold is gate-free so the kick is dead. Verify no
  other caller depends on the signal before deleting (the not-yet-committed
  def edge no longer applies — approval no longer rides the def file).
- Confirm `keeper/api.py` (`get_epic`/`get_job`) needs no change (approval
  column unchanged).

### Investigation targets

**Required:**
- src/rpc-handlers.ts:292-302 — `rewriteApprovalField` (retarget to sidecar)
- src/rpc-handlers.ts:325-360, :669-670 — the two approval handlers + registration
- src/rpc-handlers.ts:163-189 — `approvalKickSignal`/`fireApprovalKick` (to remove)
- src/server-worker.ts:2657-2663 — kick wiring; src/daemon.ts:1262 — `kick-plan-worker-request` handler

### Risks

- RPC sidecar write must create-if-absent (an epic/task never approved has
  no sidecar) — don't reuse `resolvePlanFile`'s "must exist" semantics.
- Removing the kick: confirm the gated `recheckPending` path doesn't share
  the signal for an unrelated reason.

### Test notes

bun test: RPC approve writes the sidecar create-if-absent; task RPC RMW
preserves status; path-traversal rejected; no kick emitted. Sandbox all
five state paths.

## Acceptance

- [ ] `set_task_approval` / `set_epic_approval` write the sidecar (create-if-absent; task RMW preserves status; traversal-guarded).
- [ ] `approvalKickSignal` / `fireApprovalKick` and their wiring removed; no dead references.
- [ ] bun test green.

## Done summary

## Evidence
