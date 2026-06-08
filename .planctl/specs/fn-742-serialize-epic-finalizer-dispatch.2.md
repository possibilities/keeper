## Description

**Size:** S
**Files:** src/readiness.ts, src/autopilot-worker.ts, src/rpc-handlers.ts (re-approve), test/readiness.test.ts

### Approach

A `{kind:"job-rejected"}` epic currently has no dispatchable verb
(`verbForVerdict → null`) and sits `[::blocked:job-rejected]` forever. Give it
a clean exit. Decide (and implement) the recovery: either (a) auto-clear a
rejected epic's approval back to `pending` so the normal approve flow re-runs
(route through `setEpicApprovalHandler` — the only approval write surface,
rpc-handlers.ts:356), or (b) surface a clear board affordance / one-shot RPC to
re-approve. Prefer (a) when the rejection's cause is transient (the race),
gated so a genuinely-rejected epic isn't auto-re-approved in a loop. Document
the chosen semantics. (Once `.1` lands, NEW bogus rejections stop; this task
handles recovering existing/legit rejected epics.)

### Investigation targets

**Required:**
- src/readiness.ts:791,1146 — `{kind:"job-rejected"}` verdict
- src/autopilot-worker.ts:920-922 — `verbForVerdict` returns null for rejected
- src/rpc-handlers.ts:356-370 — `setEpicApprovalHandler` (sidecar write; re-approve route)

### Risks

- Don't auto-re-approve in a loop — gate the auto-clear so a legitimately
  rejected epic doesn't thrash. Document the policy.
- Approval writes go through the sanctioned RPC/sidecar only.

### Test notes

- Pin: a rejected epic reaches a non-stuck terminal/recoverable state per the
  chosen policy.

## Acceptance

- [ ] A rejected epic is no longer permanently stuck with no recourse.
- [ ] Recovery semantics documented; no auto-re-approve thrash loop.
- [ ] Approval changes route through the sanctioned write path only.

## Done summary
Gave a job-rejected epic a clean board exit: reconcile emits a one-shot rejectedClears entry, the cycle glue resets the epic approval to pending via main's sanctioned set_epic_approval handler, gated by an in-memory autoClearedRejections ledger so a genuine rejection can't thrash (one auto-clear per epic per process). In-memory, fold-lag-immune, skipped while paused.
## Evidence
