## Overview

The Agent Bus serves but inter-agent ADDRESSING is non-functional, so it is
not yet at chatctl parity. Two end-to-end wiring bugs, both confirmed live:

1. **Identity keys on the wrong pid.** The bus enriches a channel from the
   CONNECTING PEER pid — which is the `keeper bus watch` SUBPROCESS (harness
   → zsh → `keeper bus watch`, two hops down), not the Claude harness. keeper
   tracks HARNESS pids (`jobs.pid`), so it has no row for the watcher pid →
   `name`/`session_id` resolve to NULL on every channel → agents can't be
   reached by name (the headline feature).
2. **The watch client never heartbeats.** The server evicts any channel
   silent past `HEARTBEAT_EVICT_MS` (90s) and expects `{op:"heartbeat"}`
   frames, but the `watch` client sends none — so every channel registers,
   goes silent, and is evicted ~90s later (continuous `evicting channel …
   (heartbeat-timeout)` churn in the daemon log).

Fix both so a live session appears in `keeper bus list` WITH its keeper title,
STAYS listed past 90s, and is reachable by current OR former name — restoring
parity with how chatctl is used today. Unit tests passed because they fed a
correct channel pid + a `jobs` row; the gap is the LIVE wiring (peer pid is
the watcher; client sends no heartbeat), so this epic must carry an
integration-flavored test that exercises real registration.

## Quick commands

- `launchctl kickstart -k "gui/$(id -u)/arthack.keeperd"` then poll `keeper bus list` until it serves — loads the fix
- `keeper bus list` — a live session must show a NON-NULL name + survive >90s (no eviction churn)
- `keeper bus resolve <current-name>` and `keeper bus resolve <former-name>` — both resolve to the same live channel
- `tail -f ~/.local/state/keeper/server.stderr | grep bus-worker` — confirm NO heartbeat-timeout evictions of a live watcher

## Acceptance

- [ ] A fresh interactive session appears in `keeper bus list` with its keeper TITLE (not null) and a stable session_id — identity resolves to the Claude HARNESS, not the watcher subprocess
- [ ] The channel survives past the 90s heartbeat-evict threshold; the daemon log shows no heartbeat-timeout eviction of a live watcher
- [ ] The session is reachable by its CURRENT name AND a FORMER name (name_history); the published `from` carries the harness-resolved identity
- [ ] Anti-spoof preserved: identity is server-authoritative — a client cannot claim a harness pid it is not actually descended from
- [ ] `bun run test:full` green, including a test that exercises live registration (harness resolution + heartbeat persistence), not just pure resolution given a pid

## Early proof point

Task that proves the approach: `.1` (harness identity). Once a registered
channel resolves to its harness title in `keeper bus list`, the headline
parity feature is restored. If the server-side ancestry walk proves
unreliable on macOS, the fallback is to have the `watch` client resolve its
own harness pid and send it in `register`, with the server VERIFYING it is a
genuine ancestor of the peer pid (preserves anti-spoof).

## References

- Bug A evidence: `src/bus-worker.ts:606-607` (`peerPid = conn.peerPid …; enrichPeerFromJobs(keeperDb, peerPid)`), `cli/bus.ts:457 registerFrame()` (sends no harness pid; comment says "enriched server-side from the peer pid").
- Bug B evidence: `src/bus-worker.ts:79` (`HEARTBEAT_EVICT_MS = 90_000`), the `{op:"heartbeat"}` handler; `cli/bus.ts` watch loop has no heartbeat sender.
- Shape reference: chatctl `~/code/arthack/apps/chatctl/chatctl/identity.py` (bounded harness-ancestry walk) and `run_watch_chat.py` `_heartbeat_loop` (30s heartbeat). Borrow the shape, not the code.
- keeper identity substrate: `jobs.pid` (`src/db.ts:622`), `idx_jobs_pid` (`src/db.ts:614`), `name_history` (`src/db.ts:642`). The worker already reads process liveness (`isAlive`), so a bounded `ps`-based ancestry walk in the worker is within the worker contract.

## Architecture

**Bug A — server-side harness resolution (anti-spoof-preserving).** On
`register`, instead of enriching by the bare peer pid, walk the peer pid's
ancestry (bounded depth) and take the NEAREST ancestor that has a keeper.db
`jobs` row as the harness identity — keeper only tracks harness pids, so "the
nearest ancestor keeper knows" IS the harness, with no argv heuristics.
Enrich name/session_id/name_history from that pid and store it as the
channel's identity pid; apply the same harness-resolved identity to the
publish `from`. Because the walk starts from the SERVER-resolved peer pid, a
client cannot forge an identity it is not descended from — the anti-spoof
boundary holds.

**Bug B — client heartbeat.** The long-lived `watch` client starts a ~30s
interval after `register` that sends `{op:"heartbeat"}`, well under the 90s
evict threshold; the interval is cleared on disconnect. Confirm the server's
heartbeat handler refreshes the channel's `last_heartbeat`.

The two bugs are independent (server `bus-worker.ts` vs client `cli/bus.ts`)
and can land in parallel; both are required for parity.
