## Overview

`keeper board|jobs|git|autopilot|usage` are long-lived UDS subscribers that
only handle SIGINT — so when their pane/shell/Claude-session dies they orphan
(reparent to ppid=1) and run headless forever, socket still open and
subscribed. The server never reaps dead/idle connections. Over ~2 days these
piled to 64 viewer procs / 96 connections; the single-threaded server-worker
diffs every change against ALL of them serially → saturation, new boards
can't connect, live ones lag (the 2026-06-06 incident; findings.md §7b).

This epic stops the leak on BOTH sides: (1) viewers self-exit when their
parent / controlling-TTY dies; (2) the server reaps dead connections
(EPIPE-on-write + a stuck-pending TTL) and hard-bounds the connection set
with a max-connection cap. The client self-exit is the load-bearing fix (an
alive orphan can only be killed by itself — no server probe can distinguish a
ponging orphan from a quietly-watching live user); the server reap + cap are
the belt-and-suspenders bound. Server-worker + CLI only — NOT event-sourced:
no reducer/schema/keeper-py change.

## Quick commands

- Open a `keeper board` in a pane, kill the pane's parent shell → the viewer proc exits within ~2s and `lsof -U | grep keeperd.sock` drops by one.
- `bun test test/view-shell.test.ts test/server-worker.test.ts` — self-exit + reap/cap proofs.
- Hammer >64 connections → new ones get a `max_connections` error frame + close; live boards unaffected.
- `bun run lint && bun run typecheck && bun test` — green; no schema bump.

## Acceptance

- [ ] A viewer whose parent process dies (ppid→1), receives SIGHUP, or loses its controlling TTY (stdin EOF) exits within ~2s and closes its socket — verified for board/jobs/git/autopilot AND usage (the bypassed-handler viewer).
- [ ] No false self-exit for a live, attached viewer (launch-time ppid guard; non-TTY runs handled); teardown idempotent across overlapping triggers.
- [ ] Server evicts a dead connection from `conns` (EPIPE/write<0 on a diff write) AND a dead-but-backpressured connection (stuck-pending TTL — fires only on a genuinely stuck write buffer, NOT a write-side idle timer that would kill quiet receive-only subscribers).
- [ ] Server hard-bounds connections: at the cap (64) a NEW connection is rejected with an error frame then closed (reject-new, NOT LRU-evict); hitting the cap logs loudly as a reaper-regression signal.
- [ ] Reap/cap logic is in the no-self-heal try/catch (a throw logs+continues, never bounces the daemon); any reap timer is cleared on shutdown.
- [ ] ZERO reducer/schema/keeper-py change; no wire-protocol frame added (heartbeat descoped — see Alternatives); `bun test` green.
- [ ] README + CLAUDE.md updated (connection-lifecycle + viewer exit conditions + no-self-heal carve-out).

## Early proof point

Task that proves the approach: `.1` (client self-exit) — the load-bearing fix
for the orphan class. Kill a viewer's parent, watch the proc exit and the
daemon's connection count drop. If it fails (e.g. zellij detach keeps the pty
open and the ppid-poll doesn't fire): the death-detection strategy is wrong —
revisit before the server-side work.

## References

- findings.md §7b (the incident + root cause), §7c (the live process evidence).
- src/view-shell.ts:538-560 — `installSigintHandler` (SIGINT-only; the teardown seam to factor + extend).
- cli/usage.ts:1011 — own raw `process.on("SIGINT")` (3-handle teardown; NOT routed through view-shell — separate coverage).
- cli/board.ts:890-897, cli/jobs.ts:900-907, cli/git.ts:309-322, cli/autopilot.ts:1220-1271 — viewers funnel dispose through `installSigintHandler` onDispose.
- src/readiness-client.ts:1104-1132 — `dispose()` (idempotent; writes unsubscribe + sock.end()) — CALLED, not edited (no fn-721 overlap).
- src/server-worker.ts: flush :1778-1796 (write<0 = closing, detected but no evict + no `conns` handle — the central plumbing gap), `conns` Set :2290, Bun.listen handlers :2299-2333 (close evicts :2321; error logs-only :2329), ConnState/newConnState :722-736, diffTick :1879 (backpressure-skip :1995), writeFrames :1721, handleKick :2220-2227 (no-self-heal try/catch pattern).
- src/exit-watcher-ffi.ts — process-death precedent (server-side, FFI); the VIEWER side needs NO FFI (plain process.ppid / SIGHUP / stdin 'end').
- Tests: test/view-shell.test.ts:405-478 (signal-handler capture pattern), test/server-worker.test.ts:1363-1385 (fakeSock — extend to return <0 + end() spy).

## Architecture

Failure modes and what reaps each:
- **Alive orphan** (the actual leak — ponging/running but no user): ONLY the
  client self-exit kills it. No server probe (heartbeat, kill(pid,0),
  LOCAL_PEERCRED) can distinguish it from a quiet live viewer. Task .1.
- **Dead socket during active period:** EPIPE/write<0 on the next diff write
  → evict from `conns` + `sock.end()`. Task .2.
- **Dead-but-backpressured socket:** `diffTick` SKIPS backpressured conns, so
  it never gets a write to EPIPE on → a stuck-pending TTL (pending buffer
  stuck > N) evicts it. Task .2.
- **Catastrophic accumulation (any cause):** max-conn cap (64) reject-new is
  the hard bound. Task .2.
- **Dead socket during total quiet:** harmless (one idle conn) until the next
  diff EPIPEs it; the cap bounds the worst case. (This is the ONLY case a
  heartbeat would catch sooner — see Alternatives.)

Plumbing: `flush` (server-worker.ts:1778) detects write<0 but has no handle to
the `conns` Set (local to startServer). Resolve the reachability — either
return a closing-bool up through writeFrames→diffTick's caller to `conns.delete`,
or call `sock.end()` and rely on the Bun `close` handler (:2321) firing
`conns.delete`. `conns` holds real Bun sockets cast as `Writable` (only
declares `write`); `.end()`/`.timeout()` exist at runtime (the type-vs-runtime
bridge the dispose path already uses).

## Alternatives

- **Heartbeat ping/pong (server ping → client pong, reap on missed pong)** —
  REJECTED. (a) Can't reap the actual orphan class: an alive orphan pongs
  faithfully forever, indistinguishable from a live quiet viewer. (b) Deploy
  risk: a new server reaping on missed-pong would false-reap LIVE OLD clients
  that lack a pong branch. (c) Adds wire-protocol surface (Ping/Pong frames in
  protocol.ts + a readiness-client.ts responder) — and dropping it is what
  keeps this epic OUT of readiness-client.ts, avoiding the fn-721 overlap. Its
  only unique value (reaping a dead socket during total DB-quiet) is covered
  acceptably by "evict on next diff" + the cap. If quiet-period dead-conn
  latency ever proves to matter, revisit.
- **LOCAL_PEERCRED uid-check + kill(pid,0) liveness (FFI)** — REJECTED: socket
  is already 0600 single-user (the 0700 dir is the real ACL); and it still
  can't reap an alive orphan. FFI complexity for no gain.
- **max-conn LRU-evict** — REJECTED: the oldest conn is likely the legit
  long-lived board; reject-new protects it.

## Rollout

Behaviorally additive (viewers gain exit triggers; server gains eviction + a
cap). No migration, no schema. Ships safe — a too-aggressive self-exit or
false-evict would be the only regression risk, gated by the live-viewer
acceptance criteria. Rollback = revert. Already-orphaned procs from before the
deploy won't have the self-exit code; the max-conn cap bounds their blast
radius and a one-time reap (kill ppid=1 viewers) clears the backlog.
