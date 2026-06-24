## Overview

The autopilot's `paused`/`playing` state is already durable
(`autopilot_state.paused`, an event-sourced deterministic-replayed column),
but an intentional `play` is lost on every daemon restart because
`serveBootDrain()` unconditionally appends a synthetic
`AutopilotPaused{paused:true}` event that clobbers the column back to paused.
This removes that forced boot-pause and instead reads the durable column on
main after the boot drain, seeding the autopilot worker's boot flag from it.
Behavior becomes: the daemon resumes its last durable paused state, defaulting
to paused only on a fresh board. This is the deliberately minimal version — no
crash-loop circuit breaker, marker, or restart-rate ledger; the existing
fn-897 actuator gate (no dispatch until the drain completes) plus launchd's
~10s ThrottleInterval remain the crash-loop guards.

## Quick commands

- `keeper autopilot play && <restart keeperd> && keeper autopilot --snapshot | tail -1` — expect the snapshot to show `paused:false` after the restart (today it comes back paused).
- `bun run test:full` — must pass, including `test/refold-equivalence.test.ts`.

## Acceptance

- [ ] An intentional `play` survives a daemon restart (durable `paused=0` → boots PLAYING); a fresh board still boots PAUSED.
- [ ] Re-fold determinism is preserved — `autopilot_state` re-folds byte-identically from history with the boot-append gone.
- [ ] The "boots paused" invariant prose is corrected everywhere it is asserted as an absolute.

## Early proof point

Task that proves the approach: `.1` (the whole change is one task). If it fails
(e.g. re-fold equivalence breaks, or the worker still boots paused), the
fallback is to keep the boot-append but mint it with the durable column's value
instead of a hardcoded `true` — same outcome, one extra synthetic event per boot.

## References

- fn-897 split the boot into a read-socket gate + an actuator/mutating-RPC gate; the column read must sit after `serveBootDrain()` returns (src/daemon.ts:2289) and before the worker spawn (src/daemon.ts:3331), inside that window.
- The fresh-DB `paused=1` default is carried solely by `foldAutopilotCapSet`'s INSERT path (src/reducer.ts:4013-4031) once the forced `AutopilotPaused` re-arm is gone — keeping the `AutopilotCapSet` boot re-arm is therefore load-bearing, not optional.
- Overlap with `fn-941` (daemon-driven plan-task block escalation): it also edits `src/daemon.ts` (heartbeat region ~3624-3671) and bumps schema touching `src/db.ts`/`src/reducer.ts` — distinct regions from this change, but same files, so a merge-order/conflict risk exists. Sequenced via an epic dep so this lands on top of fn-941's daemon edits.

## Docs gaps

- **CLAUDE.md** (`## Autopilot`, "It boots paused"): update to "resumes the last durable paused state; defaults to paused on a fresh board" (AGENTS.md is a symlink — one edit covers both).
- **README.md** (`## Architecture`, ~3 passages incl. the autopilot-control-RPC bullet and the "~1 extra event per restart" tradeoff note): describe the new boot-read path; drop the boot-append rationale.
- **src/db.ts:1184-1186**: the comment claiming the fresh-DB singleton materializes from the `AutopilotPaused` boot-append is now false — shift it to the `AutopilotCapSet` INSERT-path `paused=1`.
- **src/autopilot-worker.ts** (JSDoc ~33-35 "NEVER persisted", ~1472-1473 "supervisor passes true always", inline ~498/~1796) and **src/daemon.ts** comments (~1767-1771, ~3307-3308, review ~1825 "unpaused-boot dispatch window"): correct the stale boots-paused invariant, forward-facing.
- **test/autopilot-worker.test.ts:607-624** ("fn-778 boot-pause determinism"): the comment asserting the daemon's unconditional boot re-arm becomes false; correct it (the worker-side `?? true` assertion still holds).

## Best practices

- **The fn-897 actuator gate is the real crash-loop guard:** a resumed-as-playing daemon still cannot dispatch until the drain completes, and a crash inside the drain never opens the gate — keep that gate strict.
- **launchd ThrottleInterval (~10s default) spreads restarts:** the original 39-restart incident would span minutes, not a tight loop; verify the plist does not override `ThrottleInterval` to 0/small.
- **Log the resume:** emit one INFO line when booting PLAYING from persisted state, since playing-after-reboot is the new, surprising-by-default behavior.
