## Description

**Size:** S
**Files:** src/rpc-handlers.ts, src/server-worker.ts, src/daemon.ts, test/rpc-handlers.test.ts

**CLEANUP (Phase 4) — deps: `.2`.** After the cutover, remove the now-dead
approval-kick machinery (it papered over the def-file fold lag; the sidecar
fold is gate-free). KEEP the def-fallback ladder permanently.

### Approach

Remove `approvalKickSignal`/`fireApprovalKick` (rpc-handlers.ts:163-189) and
the `kick-plan-worker-request` wiring in server-worker.ts (~:2657-2663) + its
daemon.ts handler (~:1262). Verify no other caller depends on the signal.
Confirm `keeper/api.py` needs no change. Restart keeperd.

### Investigation targets

**Required** (read before coding):
- src/rpc-handlers.ts:163-189 approvalKickSignal/fireApprovalKick (to remove)
- src/server-worker.ts:2657-2663 kick wiring; src/daemon.ts:1262 kick handler

### Risks

- Confirm the gated `recheckPending` path doesn't share the signal before deleting.
- Do NOT remove the def-fallback ladder — it stays as the permanent safety net.

### Test notes

bun test: no kick emitted on approve; no dead references; approval-fold tests still green.

## Acceptance

- [ ] approvalKickSignal/fireApprovalKick + wiring removed; no dead references
- [ ] def-fallback ladder retained
- [ ] bun test green

## Done summary
Removed the now-dead fn-701 approval-kick machinery (approvalKickSignal/setApprovalKickSignal/fireApprovalKick + kick-plan-worker-request wiring across rpc-handlers/server-worker/daemon). The sidecar fold is gate-free so the committed-def fold-lag kick is no longer needed; def-fallback ladder retained as the permanent safety net. Added a regression guard and confirmed no dead references; bun test green.
## Evidence
