## Overview

The server-worker's conns Set leaks ghost entries: tonight it hit the 64-conn cap
and rejected 83 connections ("the reaper has regressed", conn ids to 106) while the
kernel held only 15 real sockets on the daemon. Root shape: a client that connects,
runs one query, and exits without subscribing never receives another server write —
so the EPIPE-evict (write < 0) never fires, the stuck-pending TTL never applies (no
pending buffer), and the entry sits in conns forever. One-shot keeper CLI probes
from autopilot workers (~2.5 conns/min tonight) fill the cap in ~40 min, then
every new await/board/worker probe is rejected. Mitigated tonight by keeperd
bounces; this epic closes the class.

## Quick commands

- `bun test test/server-worker.test.ts` — new eviction tests green
- Post-deploy soak: `grep -c max_connections ~/.local/state/keeper/server.stderr` stops growing; conns stays near lsof reality under CLI churn

## Acceptance

- [ ] root cause diagnosed and written into the task Evidence (why does a cleanly-exited one-shot client's socket close not evict — missing/regressed close/error handler wiring on the Bun socket, or close events not removing from conns?)
- [ ] every socket close/error path evicts its conns entry; PLUS a belt-and-braces idle sweep: a connection with zero subscriptions and no frame activity for a TTL (~5 min) is evicted (covers silent deaths the kernel never reports)
- [ ] the stuck-pending TTL reap runs on every poll tick, not only data_version-changed ticks (the deferred fn-723 review gap)
- [ ] a churn test pins it: open N short-lived query-only clients, let them exit, assert conns count returns to baseline and the cap is never approached
- [ ] reaper-regression log line preserved (it carried tonight's diagnosis)

## Early proof point

Task that proves the approach: the single task — its diagnosis step. If the close
handler IS wired and entries still leak, the bug is subtler (half-close, error
swallowing) — follow the evidence, not this spec's hypothesis.

## References

- ~/.local/state/keeper/server.stderr — the 83 rejection lines + "reaper has regressed"
- 2026-06-09 deep review Tier 2 server cluster (~/docs/keeper-reliability/2026-06-09-server-deep-review.md) — the stuck-pending-reap-gated-on-changed-tick finding, now symptomatic
- fn-723 spec (.planctl/specs/) — the original reaper design (EPIPE-evict, pending TTL, cap-with-loud-log); CLAUDE.md carve-out: connection hygiene is NOT self-heal
