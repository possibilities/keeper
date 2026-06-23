## Overview

The 2026-06-23 keeperd recurring-freeze incident. THREE independent root causes
were found in the original wedge; TWO MORE surfaced when `.1`'s reboot exposed
them. All six land here. **GOALS (the desired end state):**
1. **Restore keeperd** to durable health — no more silent freezes.
2. **Restore autopilot** to driving work autonomously (currently paused; resume
   once the daemon is durably fixed, esp. `.5`).
3. **Prevent client hammering** — no single client (e.g. a `keeper board`
   dashboard reconnect loop) can wedge the daemon into a freeze.
4. **Fix everything forward** — real fixes, not bounce-band-aids.

Full incident context, evidence, and recovery runbook:
`~/docs/keeperd-recurring-freeze-handoff.md`.

Six tasks: `.1` durable git surface (**DONE** — `89b27108`), `.2` server-worker
`subagent_invocations` fanout (the CPU peg), `.3` bus reachability, `.4`
commit-work synced attribution, `.5` read-socket connection protection (the
recurring-freeze root cause — highest leverage), `.6` cold-boot fold perf.

## Quick commands

- `keeper jobs` returns within ~1s under a connection storm; `keeper bus list` shows live agents `subscribed:true`
- `grep "conn-cap census" ~/.local/state/keeper/server.stderr | tail -1` → never pinned at `64/64 zero_sub` (a hammering client cannot wedge the socket)
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT seed_required FROM git_projection_state"` → clears on a healthy boot; a stuck `1` self-recovers
- reboot → daemon serves quickly (no 30s boot-seed timeout, no 3.9s cold folds)

## Acceptance

- [ ] **keeperd restored**: no silent git-surface freeze; reboots are fast; the daemon self-recovers a stuck surface (`.1` done; `.6`)
- [ ] **client hammering prevented**: a reconnect-loop client cannot exhaust the connection cap; the reaper reaps stale `zero_sub` conns; the daemon stays responsive under a storm (`.5`)
- [ ] **server-worker no CPU peg**: no full `subagent_invocations` snapshot fanout (`.2`)
- [ ] **bus reachability**: a live sending agent is reachable + listed; fn-918 wake preserved (`.3`)
- [ ] **commit-work consistency**: reads a consistent `(file_attributions, live-dirty)` set (`.4`)
- [ ] **autopilot restored**: unpaused and dispatching keeper-root work cleanly once `.5`/`.6` land
- [ ] `bun run test:full` green

## Early proof point

`.5` (connection protection) — it is what makes every other freeze
unrecoverable-without-a-bounce, so proving the daemon stays responsive under a
connection storm de-risks the whole epic. If it fails: fall back to the manual
runbook (kill the hammering client + restart) while iterating.

## References

- Incident handoff: `~/docs/keeperd-recurring-freeze-handoff.md`
- Original wedge: `~/docs/keeper-daemon-wedged-cpu-pegged.md`
- `fn-905` (per-root git boot-seed gate) — `.1`/`.6` build on it
- **fn-918 overlap** (`src/bus-worker.ts`, `cli/bus.ts`, shared with `.3`) NOT wired as a dep (would deadlock; fn-918's closer is unblocked by `.1`). Sequence `.3` after fn-918 closes.
- `.2` and `.5` both touch `src/server-worker.ts` (different concerns — diffTick vs the connection reaper) — coordinate to avoid a merge conflict; not wired as a hard dep so `.5` (highest priority) isn't gated behind `.2`.

## Docs gaps

- **README.md** + **CLAUDE.md**: git change-detection (poll-only), boot-seed contract (watchdog), subscribe-server protocol (`subagent_invocations` bound + connection admission/reaper), bus presence model
- New `.keeper/specs/` per task; do NOT edit closed specs

## Best practices

- **Supervisor-side liveness; crash-and-restart over in-process respawn.** [practice-scout]
- **Bound subscription result sets; never refetch from the send path.** [practice-scout]
- **Connection FSM: only a SUBSCRIBED/answered conn holds a durable slot; reap on close AND idle-timeout (macOS UDS half-open is real); subscribe-by-deadline force-close; per-client rate-limit.** [practice-scout + this incident]
