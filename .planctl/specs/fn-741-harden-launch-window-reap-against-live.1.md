## Description

**Size:** S
**Files:** `src/autopilot-worker.ts`, `test/autopilot-worker.test.ts`
(read `src/exec-backend.ts` for the `ZellijPane.exited` shape)

### Approach

Add an `exited === false` veto to the shared reap predicate so a
demonstrably-live worker pane is never closed, independent of the
`pending_dispatches` discharge signal (which is fold-latency-dependent and
broke during the 2026-06-08 fn-736 freeze, killing live workers).

1. In `isReapCandidate(openPendingKeys, pane)` (`src/autopilot-worker.ts:396`),
   return `false` when `pane.exited === false` — BEFORE/regardless of the
   key-in-openPendingKeys check. Only an explicit `false` vetoes; `true` and
   `undefined` fall through to the existing logic (so true ghosts and
   unknown-state panes still reap).
2. Apply the SAME veto to the fn-727 completion-reap predicate (`:404`) — a
   live pane should not be completion-reaped either if it's still `exited:false`
   (it's idle-but-alive; reaping is fine once exited, and the completion path
   already gates on approved+idle, but the live-veto is the same safety net).
   If on inspection the completion-reap intentionally closes idle-alive panes
   (approved completion), document why and scope the veto to the pause/boot
   reap only — but DEFAULT to applying it to both and note the decision in the
   Done summary.
3. Keep the predicate(s) pure and shared with tests (the module already
   exports them for exactly this).

### Investigation targets

- `src/autopilot-worker.ts:379-426` (`isReapCandidate` + completion-reap
  predicate doc/impl), `:1928-1995` (pause/boot reap caller),
  completion-reap caller below it.
- `src/exec-backend.ts:436,566,647` — `ZellijPane.exited` (optional boolean,
  may be undefined).
- `test/autopilot-worker.test.ts` — existing predicate tests.

### Risks

- Make the reap strictly MORE conservative only. Never widen it.
- `undefined` exited must not block the ghost reap (zellij omits the field
  sometimes) — only explicit `false` vetoes.
- Daemon-side; not live until operator runs `launchctl kickstart`.

### Test notes

- live pane `{exited:false}` + key in openPendingKeys → NOT reaped.
- ghost `{exited:true}` and `{}` (undefined) + open key → reaped.
- missing-key (discharged) live worker → still never reaped (no regression).

## Acceptance

- [ ] `exited===false` panes never reaped by either predicate, even with an
  open pending / completed key.
- [ ] `exited` true/undefined + open key still reaped (no ghost-reap regression).
- [ ] Tests cover live-veto, ghost-reap, and discharged-worker cases; `bun test` green.

## Done summary
Added an 'exited === false' live-veto to both reap predicates (isReapCandidate pause/boot reap + isCompletionReapCandidate fn-727 completion reap) in src/autopilot-worker.ts. A demonstrably-live worker pane is never closed, independent of the fold-latency-dependent pending_dispatches/completed-id signal that broke during the 2026-06-08 fn-736 freeze. Only explicit false vetoes; true/undefined still reap (ghost behavior preserved). Applied to BOTH predicates per spec default — the inverse-polarity veto does not reinstate the rejected is_exited==true rule; the live-at-approval approver still reaps on a later list-panes once exited.
## Evidence
