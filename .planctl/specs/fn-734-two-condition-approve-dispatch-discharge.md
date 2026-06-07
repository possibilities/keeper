## Overview

keeper's autopilot re-dispatches a redundant `approve` worker in the window
between the first approver's job going terminal (ended/killed) and the
approval folding into the `epics` projection. At job-terminal every
`reconcile()` suppression arm has released (`pending_dispatches` discharged
at SessionStart; `isOccupyingJob` only counts working/stopped), yet the
verdict stays `blocked:job-pending` until the slower plan-worker snapshot
folds the approval (59s after dispatch in the flagged incident). The
babysitter caught it as dup-dispatch (`approve::fn-731-...1` dispatched 2x
within 56s). Impact is benign (idempotent approval, no double-commit) but it
is a real dup-dispatch the dedup machinery is designed to prevent.

Fix: keep the `approve` `pending_dispatches` row alive past SessionStart and
discharge it only when BOTH (a) the approval has resolved (approved|rejected)
AND (b) the approve job is terminal (ended|killed) — fired by whichever folds
second via a re-fold-deterministic cross-table read — with the existing 120s
`DispatchExpired` TTL as the crashed-approver backstop. Covers task and
close-row (epic) approvals. Pure reducer logic, no schema bump. A companion
change exempts a now-live approver pane from the pause/boot reaper, which
otherwise (assuming "open pending row = not-yet-bound ghost") would kill the
live approver whose row is deliberately kept open.

Depends on fn-732 (move approval to runtime sidecar), which reworks the
approval source + fold path this epic gates — build the discharge on the
sidecar-sourced approval.

## Quick commands

- `bun test test/reducer.test.ts` — pending_dispatches discharge + re-fold determinism blocks
- `bun test test/autopilot-worker.test.ts` — pause/boot reap exemption
- `tail -f ~/.local/state/keeper-watch/agent.log` — confirm no recurring `dup-dispatch: approve::*` after landing

## Acceptance

- [ ] No redundant `approve` dispatch in the [job-terminal, approval-folded] window — task AND close-row paths
- [ ] Two-condition discharge is commutative + byte-identical re-fold for both fold orders
- [ ] Crashed approver (job terminal, approval never folds) self-heals via the 120s `DispatchExpired` TTL
- [ ] Pause/boot never reaps a live approver pane; a genuine not-yet-bound ghost is still reaped
- [ ] `SCHEMA_VERSION` unchanged (60); re-fold determinism preserved; no fold ever throws

## Early proof point

Task that proves the approach: the reducer two-condition discharge task
(ordinal 2) — its dual-order re-fold tests plus the incident-order regression
test are the proof. If it fails (e.g. the cross-table read can't be made
re-fold-deterministic), fall back to the bitmask-columns alternative noted in
References (two readiness bits on the row, accepting a schema bump).

## References

- Incident: babysitter `dup-dispatch` finding `approve::fn-731-babysitter-follow-up-prompt-files.1 dispatched 2x within 56s` (2026-06-07); root-caused to the job-terminal -> approval-fold projection-lag window (dispatch 21:22:35, job ended 21:22:53, re-dispatch 21:23:31, approval folded 21:23:34).
- Dispatch-dedup lineage (historical — do NOT edit their specs): fn-627 (double-dispatch class), fn-674 (live-tab probe), fn-678 (`pending_dispatches` outbox + discharge-on-bind), fn-721 (pending row as readiness mutex), fn-724 (durable dispatch outbox + await-ack), fn-725/fn-728 (concurrency cap + approve-exempt).
- Overlap / reverse-dep: `fn-732-move-approval-to-runtime-sidecar` reworks the approval-fold path this epic gates; this epic DEPENDS ON fn-732 (build the gate on the sidecar-sourced approval). `fn-733` (babysitter telemetry / fold-latency) is a low-risk read-only observer of the same snapshot events.
- Rejected alternative: store two readiness bits (`effect_seen`, `job_terminal`) on the pending row instead of cross-table reads — cleaner convergence but needs a schema bump; rejected in favor of the no-bump cross-table-read approach (sanctioned by "Read-in-fold is allowed" + the `syncIfPlanRef` / `syncJobIntoEpic` precedent).

## Docs gaps

- **README.md `## Architecture`** (pending_dispatches paragraph ~1569-1580 + reconciler paragraph ~1768-1791): "discharge-on-bind / discharges when SessionStart folds" must become the two-condition discharge rule for `approve` rows.
- **CLAUDE.md `## Autopilot`** (~124-150): the "launch->SessionStart blind window" gate line — precision fix noting the extended approve window.

## Best practices

- **Discharge only when the effect is durably observed**, never on the faster condition alone — releasing at bind before the approval folds IS the read-your-own-write-lag race being fixed.
- **Both discharge handlers must be commutative** (each re-checks the other condition from persisted `epics`/`jobs` state) so a byte-identical re-fold converges regardless of which event folds first.
- **Anchor TTL to the event's own `ts`, never `Date.now`**; idempotent `DELETE`; never throw inside a fold (malformed -> safe no-op, cursor still advances).
