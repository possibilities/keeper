## Overview

Approved/closed epics linger on `keeper board` for up to ~60s because the
producer-side plan-worker only emits the hiding EpicSnapshot when its 60s
`RECONCILE_HEARTBEAT_MS` backstop fires. The board render pipeline is already
sub-second. Root cause (traced from the fn-699 session): the git-worker
detects the approve commit and posts `planctl-commit-changed`, main forwards
it, and `plan-worker.onChange` runs — but onChange re-runs the fn-629
`isTracked` gate (`git cat-file -e HEAD`, 1s timeout, fails closed), which
silently bounces the just-committed file into `pending`; with no further git
pulse, only the heartbeat recovers it.

This epic makes the fast path reliable and self-reporting: bypass the
redundant gate on commit-driven ingest, make the silent bounce and any
backstop activation loud, close the no-pulse-to-drain gap with an
approval-RPC kick, and fix the `@parcel/watcher` concurrent-dlopen race that
crash-loops the daemon at boot. Scope deliberately EXCLUDES retiring the
60s/90s stopgaps — that is a follow-up gated on the new observability.

## Quick commands

- `bun test test/plan-worker.test.ts`
- Approve an epic in `keeper board` and confirm it disappears in <2s (was ~60s)

## Acceptance

- [ ] Commit-driven ingest emits the approval/close snapshot without re-running `isPathInHead`; board removal is sub-second in the traced flow
- [ ] The fn-629 pending bounce and any backstop (heartbeat / FSEvents-drop rescan) "did real work" activation are logged with a trigger reason
- [ ] An approval RPC write kicks the plan-worker (gated recheck) so an approval that never commits still converges promptly
- [ ] `@parcel/watcher` loads reliably at boot (no napi crash-loop); a genuine load failure escalates loudly
- [ ] CLAUDE.md / README fn-629 prose updated to distinguish FSEvent-gated vs commit-bypassed ingest

## Early proof point

Task that proves the approach: `.1` (commit-driven bypass). If it fails (the
bypass still bounces, or emits stale worktree bytes): fall back to making
`isPathInHead` use a long-lived `git cat-file --batch` to shrink the
fail-closed window on the still-gated path.

## References

- Root-cause trace (fn-699 session): approve commit ts 523 -> approval EpicSnapshot fold ts 585.6 (63.6s lag); zero git pulses in the gap; the heartbeat fold was a cross-root batch (keeper + arthack), the reconcile signature.
- Bun v1.3.5 fixed the original `napi_register_module_v1` main+worker double-load bug; Bun #15942 documents residual fragility under many concurrent Worker spawns. Daemon bun is 1.3.14 yet still crash-looped -> residual #15942.
- DEFERRED follow-up (not in this epic): retire `RECONCILE_HEARTBEAT_MS` and root-cause the `HEAD_DIVERGENCE_GRACE_MS` git-vs-fs divergence, gated on what the new observability shows.

## Docs gaps

- **CLAUDE.md** (Autopilot dispatch gates, "Won't dispatch against an uncommitted epic (fn-629)"): distinguish FSEvent-triggered ingest (still gated) from commit-driven ingest (gate bypassed — file is provably in HEAD).
- **README.md** (`## Architecture`, fn-629 block): same revision, "As of fn-NNN" anchor style; audit "60s heartbeat" prose if cadence ever changes.
- **README.md** (`@parcel/watcher` intro): add a load-ordering note only if the pre-warm introduces an operational rule.

## Best practices

- **Don't re-verify an authoritative event with a fail-closed/timeout probe on the happy path:** pass a `triggeredByCommit` discriminant and keep the probe only on the uncertain FSEvents path.
- **Make backstops observable:** a heartbeat/rescan that fires in normal operation is a signal that the primary path is broken.
- **Native N-API addons:** pre-warm on main before spawning worker threads; avoid a concurrent first-dlopen (Bun #15942).
