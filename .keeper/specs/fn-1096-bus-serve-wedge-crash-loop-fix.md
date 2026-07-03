## Overview

keeperd's bus-worker serve loop wedges deterministically at every boot: the reconnect
stampede's register handling runs synchronous `ps` ancestry walks on the serve event loop,
parking the kqueue loop so JS-level socket events stop firing while kernel accepts pile up.
The serve-liveness watchdog then fatalExits, LaunchAgent respawns, and the respawn re-triggers
the stampede — a self-sustaining crash-loop (~60-120s per cycle) that is invisible on the board
(needs_human stays 0). This epic unwedges the serve loop, makes the watchdog verdict and any
future crash-loop loud, lands the filed NOTADB reader tolerance, and prunes the bus.db bloat
that amplifies every boot.

## Quick commands

- `bun scripts/repro-serve-wedge.ts --clients 40 --rate-hz 10 --churn 64` — red-capable wedge harness (task 1 adds register-work/stampede/getsockopt dimensions)
- `keeper bus list` — answers within its 5s budget when the bus serve path is healthy
- `ps -p $(launchctl list | awk '/arthack\.keeperd$/{print $1}') -o etime=` — daemon uptime; minutes-plus means the loop is gone
- `grep -c "serve-liveness watchdog" ~/.local/state/keeper/server.stderr` — stops growing once fixed

## Acceptance

- [ ] The live daemon holds uptime across many former wedge cycles with `keeper bus list` answering continuously
- [ ] A watchdog escalation names which socket/mode tripped; a sustained crash-loop mints one sticky operator-visible distress signal that auto-clears when the boot rate recovers
- [ ] Transient SQLITE_NOTADB reads no longer crash the read-only pollers; genuine persistent corruption still surfaces loudly
- [ ] bus.db channel and message row counts stay bounded under steady-state churn without stranding undelivered wake messages

## Early proof point

Task that proves the approach: ordinal 1 (unwedge the serve loop). Its harness must first go RED
against the pre-fix serve shape; if the harness cannot reproduce, the fallback is per-conn
breadcrumb instrumentation on the live daemon — the production crash-loop itself is the repro.

## References

- ~/docs/2026-07-02-fn-1082-2-serve-wedge-finding.md — the bounded-effort wedge investigation this epic completes (repro harness design, NOTADB rider spec)
- ~/docs/keeper-session-failure-inventory-2026-07-02.md — item 17, the surviving cluster this epic closes
- Live evidence: mute-from-bind probe timelines, idle-kevent64 process sample, accepted-fd pileup via lsof, 585+ watchdog fatalExits in server.stderr
- Bun #8044 is a red herring (unrelated 2024 Bun.serve bug); no documented upstream issue matches this signature — the fix is designed defensively, with a minimal upstream repro filed only if a Bun.listen-specific defect survives the off-loop fix
- plist reality: ThrottleInterval 10 + KeepAlive{SuccessfulExit:false} — crash-loop thresholds are set against this cadence

## Docs gaps

- **CLAUDE.md**: revise in place — the data_version polling invariant gains the NOTADB skip-tick rule (task 3); the no-self-heal/watchdog line reflects the named-verdict log and crash-loop distress signal (task 2). lint-claude-md stays green.
- **README.md**: System map / "Two boot gates" poller enumeration corrected to match the three data_version pollers (task 3).
- **src/bus-db.ts doc header**: the messages "append-only durable forensic log" comment becomes the retention contract statement (task 4).

## Best practices

- **Never run a synchronous subprocess on a socket-serving event loop:** sync spawn parks the kqueue loop; accepts pile up unread at the kernel [Val Town node-spawn-performance; verified mechanism]
- **Don't bank on a Bun upgrade:** no documented fix for this signature in 1.3.15-1.3.18; the off-loop fix is what resolves it
- **node:net swap is not a first resort:** both listener APIs ride the same in-process loop; swap only on concrete evidence of a listener-specific defect after the spawn is off-loop
- **NOTADB on a read-only WAL reader during checkpoint is a transient view race, not corruption:** skip and retry with a bounded consecutive-miss escalation; never wipe-and-rebuild [sqlite.org/wal.html]
- **Crash-loop self-detection:** count recent restarts from a durable ledger at boot; threshold against the real launchd throttle (10s), fail loud, keep the ledger window-aged [AIXplore LaunchAgent crash-loop case study]
