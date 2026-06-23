## Overview

Three independent root causes behind the 2026-06-23 keeperd wedge — one per
worker, landed as one epic. **T1 (durable git surface)** is the priority: the
git-surface freeze darks ALL keeper-root autopilot dispatch (it is what
currently blocks the fn-918 closer and fn-919.2). **T2** kills the
server-worker CPU peg (the `subagent_invocations` full-snapshot fanout storm).
**T3** makes a live agent reachable on the bus again. End state: the git
surface self-recovers without a manual bounce, the server-worker no longer
pegs a core, and live agents are reachable + listed on the bus.

## Quick commands

- `keeper jobs` returns within ~1s; `keeper bus list` shows live agents `subscribed:true`
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT seed_required FROM git_projection_state"` → clears to 0 on a healthy boot, and a stuck `1` self-recovers
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT COUNT(*) FROM events WHERE hook_event='GitSnapshot' AND id > (SELECT floor FROM git_projection_state)"` → non-zero on a quiet repo with seed_required set (the producer emits to clear)
- per-thread CPU on the daemon settles to low idle (no server-worker `sendto` storm — `sudo dtrace -n 'syscall::sendto:entry/pid==<keeperd>/{@=count()} tick-2s{exit(0)}'`)

## Acceptance

- [ ] git surface recovers a stuck `seed_required` WITHOUT a manual daemon bounce; autopilot keeper-root dispatch un-darks once seeded
- [ ] git producer survives a `@parcel/watcher` load-hang / mute (it no longer gates the producer)
- [ ] read-after-write git reads (commit-work class) reflect within ~one poll tick for the changed root
- [ ] server-worker no longer sends full `subagent_invocations` snapshots per event; no CPU peg
- [ ] a live, sending agent is reachable by directed bus send AND appears in `keeper bus list`; fn-918 durable wake-on-send preserved
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: `T1` (durable git surface) — it proves the un-dark, the highest-value + highest-risk piece. If it fails: the gated-root key-mismatch reconciliation or the watchdog escalation needs rework (fall back to a manual re-seed RPC while iterating).

## References

- Incident handoff: `~/docs/keeper-daemon-wedged-cpu-pegged.md`
- `fn-905` (per-root git boot-seed gate) — T1 builds on / modifies this readiness-gate surface
- **fn-918 overlap NOTED but deliberately NOT wired as a dep**: fn-918 (done, awaiting close) writes `src/bus-worker.ts` + `cli/bus.ts` (same files as T3), but its closer is itself blocked by the git-surface freeze T1 fixes — wiring this epic to depend on fn-918 would deadlock. Managed by sequential in-session execution: T1 lands → reboot un-darks fn-918's closer → fn-918 closes → T3 edits those files last.

## Docs gaps

- **README.md**: `@parcel/watcher` load-ordering block (git-worker drops off the watcher list, poll-only), the "single third-party dep" claim, git change-detection prose (FSEvents → poll + targeted synced scan), boot-seed contract (add watchdog + dead-vs-stuck), subscribe-server collection protocol (`subagent_invocations` recency bound + meta-no-longer-full-refetch), bus presence model (register-without-subscribe is valid + Monitor re-arm contract)
- **CLAUDE.md**: boot-seed contract ("never a retry loop" narrows for the watchdog), worker contract (supervisor probes git-worker liveness), bus worker rules (register-without-subscribe is a valid connected state, never mis-classified `not_connected`)
- New `.keeper/specs/` entries per task; do NOT edit closed specs (fn-748 / fn-868 / fn-905 / fn-697 / fn-886 / fn-875)

## Best practices

- **Supervisor-side liveness over unilateral heartbeat:** the watchdog lives in main (not the watched worker, which the hang would starve); prefer crash-and-LaunchAgent-restart over in-process respawn (keeper's no-self-heal rule). [practice-scout]
- **Two-tier poll + debounce:** cheap `stat()` of `.git` metadata at ~300ms, run the git scan only on a detected mtime delta; coalesce 100–500ms. [practice-scout]
- **Never refetch from inside the send path; bound subscription result sets:** the meta→full-refetch amplification loop needs the unbounded token bounded AND the client to stop full-refetching on meta. [practice-scout]
- **Only a SUBSCRIBED connection is a valid dispatch target:** distinguish register-without-subscribe from subscribed-then-closed; reap on close AND on heartbeat-timeout (macOS TCP half-open). [practice-scout]
