## Overview

Build the **Agent Bus**: a local inter-agent message bus living inside
keeperd as a new Bun/TS worker thread. Agents reach each other by session
name, session id, or ANY former name — resolved transparently (dead names
resolve behind the scenes, both when reaching out and when replying). "Chat"
is the first tenant; the wire carries a `namespace` axis so future tenants
(`pair`, …) ride the same bus. Exposed as `keeper bus chat …`; armed as a
session Monitor via the keeper plugin manifest so every interactive session
is connected with no manual step. Modeled in SHAPE (not code) on the chatctl
Python app, which a separate later epic tears out of ~/code/arthack.

The load-bearing invariant-safety move: the bus is PHYSICALLY OUT of
keeper.db's blast radius — its own `bus.db`, its own socket, its own wire
protocol. It adds NO keeper event type, projection, RPC surface, or
schema-version bump, so keeper's re-fold determinism and "writes are tightly
scoped" invariants hold by construction. The bus reads keeper's `jobs`
projection READ-ONLY for name resolution; it never writes keeper.db.

## Quick commands

- `bun test test/bus-db.test.ts test/bus-identity.test.ts` — storage + two-layer resolution unit tests (fast tier)
- `bun run test:full 2>&1 | grep -iE 'bus|fail'` — worker/socket/daemon integration (mandatory before landing)
- `keeper bus list` — show who is currently on the bus (JSON)
- `keeper bus chat send <name-or-id> "hello"` — message another agent (resolves current OR historical name)
- `keeper bus chat send <a-now-dead-name> "still reachable?"` — proves transparent dead-name resolution
- `keeper bus watch` — the Monitor inbox command (also auto-armed per session via the plugin manifest)

## Acceptance

- [ ] A new `bus` worker is in `ALL_WORKERS`, boots inside keeperd under the existing LaunchAgent, and owns `bus.db` + a dedicated UDS socket — keeper.db gains NO new event/projection/RPC/schema-version
- [ ] Two live agents exchange a message end-to-end over the bus; a third `broadcast` reaches all
- [ ] An agent reachable by its CURRENT name is ALSO reachable by a FORMER name (dead-name resolution), and a reply to a since-changed `from` name still lands — both directions transparent
- [ ] The wire envelope carries a `namespace` axis; `chat` is one tenant and the core routes tenant-agnostically (a future `pair` tenant needs no core change)
- [ ] `keeper bus watch` is auto-armed every interactive session via the keeper plugin manifest; long inbound messages spill to a file with a compact pointer line
- [ ] A slow/dead subscriber is evicted (bounded per-client queue), never blocking the relay; a malformed/oversized frame is rejected/dropped without affecting other subscribers
- [ ] The server overwrites the sender-claimed `from` with the peer-resolved identity (anti-spoof); the socket is mode 0600
- [ ] `bun run test:full` passes; chatctl is untouched (its teardown is a separate epic)

## Early proof point

Task that proves the approach: `.2` (bus worker + UDS transport + two-layer
resolution, exercised end-to-end by a socket round-trip + a dead-name
resolve in the full-tier integration test). If it fails — i.e. running the
relay as an in-keeperd worker proves untenable (crash blast-radius, socket
lifecycle, or the read-only jobs coupling) — the recovery is to lift the
SAME worker code into a sibling `keeper-bus` LaunchAgent running the binary
in a `--bus-only` mode; the storage/identity/CLI tasks are unaffected.

## References

- chatctl SHAPE source (different repo, ~/code/arthack/apps/chatctl): `cli.py` AGENT_HELP/AGENT_TEASER, `run_run_server.py` (Registry + relay), `run_watch_chat.py` (watch loop + spill), `resolve.py` (tiered resolution), `db.py` (chatters + messages schema), `identity.py` (pid + name_history overlay). Borrow shapes, not code.
- Worker template: `src/renamer-worker.ts` (pure actuator: read-only openDb, runQuery seam, watchLoop, isMainThread guard, shutdown-releases-resources).
- UDS server mechanism: `src/server-worker.ts` (`Bun.listen` unix, ConnState + LineBuffer framing, writeFrames/resumePending/flush backpressure, `acquireLock`/`LockHeldError` lock-before-bind reclaim, `peerPidForFd` LOCAL_PEERPID, chmod 0600).
- CLI templates: `cli/plan.ts`/`cli/prompt.ts` (in-process wrapper), `cli/control-rpc.ts` `roundTrip` (one-shot UDS client), `cli/keeper.ts` (SUBCOMMANDS/USAGE/handlers).
- Identity columns: `src/db.ts` jobs `pid`/`start_time`/`title`/`name_history` (v40, JSON oldest→newest cap 20), `idx_jobs_pid`. Resolution model: `cli/show-job.ts` `json_each(COALESCE(name_history,'[]'))` membership, opens keeper.db read-only directly.
- DB gotcha: `src/db.ts` `applyPragmas` (schema-free, REUSE) vs `openDb`/`migrate` (keeper v79 ladder — NEVER call on bus.db; bus gets its own open + `PRAGMA user_version` ladder). Reader opens of keeper.db via `openDb(..,{readonly:true})` do NOT migrate — that is the correct pattern for the bus's jobs reads.
- Monitor feature: Claude Code plugin `experimental.monitors` (v2.1.105+, `when:"always"`, interactive-only, name-deduped, INVISIBLE to the hook stream → will NOT populate `jobs.monitors`, which is correct; bus presence comes from the bus.db registry).
- FOLLOW-UP: a separate epic in ~/code/arthack will tear out chatctl (app, `monitors.json`, the 5 messaging snippets + index, the `hookctl-chatctl-pointer` bundle referenced at `claude/arthack/hooks/user_prompt_submit.ts:167`, CLAUDE.md mentions) and rewrite its advice against this bus. That epic DEPENDS ON this one; it is scaffolded after this bus lands and verifies.

## Alternatives

- **Sibling daemon (own LaunchAgent)** instead of an in-keeperd worker — rejected as the default: doubles the operational surface (second deploy, second supervisor, second restart story) for a subsystem that already depends on keeper for identity. Kept as the documented fallback if the in-worker crash blast-radius proves unacceptable (see Early proof point).
- **Ride keeper.db / keeper's query protocol** — rejected: keeper.db carries sacred re-fold-determinism + tightly-scoped-write invariants a heartbeat/reap/relay log would violate, and `src/protocol.ts` has FROZEN MEMBERSHIP (a new message = a new row a keeper-style subscriber never receives).
- **ZMQ (as chatctl uses)** — rejected: a heavy native dep on a deliberately dep-light Bun codebase that already has a hand-rolled UDS fan-out engine to mirror.
- **Python + keeper-py** — rejected: a keeperd worker thread must be Bun; native in-process read of `jobs` removes the cross-language hop chatctl needed.

## Architecture

**Processes/files.** `src/bus-worker.ts` (new keeperd worker, registered in
`ALL_WORKERS`); `src/bus-db.ts` + `src/bus-identity.ts` (storage + resolution,
repo root); `cli/bus.ts` (CLI); `plugins/keeper/monitors.json` (Monitor arm).
State under `~/.local/state/keeper/`: `bus.db` (KEEPER_BUS_DB), `bus.sock`
(KEEPER_BUS_SOCK), `bus.lock`, `bus/inbox/` (spill).

**bus.db (own user_version, reducer never opens):**
- `channels` — one row per live registration. Key on `(pid, start_time)` to
  defeat OS pid reuse. Columns: channel_id, pid, start_time, session_id,
  current_name, name_history (JSON), namespaces (JSON), registered_at,
  last_heartbeat. In-memory registry is the runtime source of truth; the
  table is a best-effort persistence cache rehydrated at boot (dead pids
  dropped).
- `messages` — append-only durable forensic log: id (autoincrement = the
  monotonic cursor), ts, namespace, event, from_channel_id/from_pid/
  from_name, to_target/resolved_channel_id/resolved_session_id, body,
  body_size, status, reply_to. Doubles as reconnect-recovery.

**Wire envelope (2-axis, NDJSON line per frame):**
```
{ "v":1, "namespace":"chat", "event":"message",
  "id":"…", "ts":"…",
  "from": {"channel_id":"…","pid":0,"session_id":"…","name":"…"},
  "to":   {"target":"old-or-current-name","channel_id":"…","session_id":"…"},
  "payload": {"media_type":"text/markdown","text":"…"},
  "reply_to": null }
```
`namespace` = tenant (`chat` now; `pair` later; reserved `bus` = control:
join/part/reap/takeover). `event` is owned per-tenant. Core routes ONLY on
`(namespace, resolved-target)`; payload is opaque.

**Socket ops (one op-discriminated UDS socket):** client →
register / heartbeat / subscribe / publish(send|broadcast) / list / resolve /
deregister; server → ack / event / presence / error. `subscribe` ACK carries
`last_message_id` (replay cursor) so a reconnecting client recovers missed
rows from `messages` ≤ cursor, then streams live > cursor (fences the gap).

**Identity & resolution (two-layer).** The server resolves the connecting
client's pid via `peerPidForFd` (authoritative, anti-spoof), then enriches
from keeper.db `jobs` (session_id, title, name_history, start_time) — falling
back to a client-provided floor name on the resume gap (before keeper folds
the new session). Target resolution: (a) name → stable identity, consulting
ALL jobs not just live channels — exact on session_id/pid/current title/ANY
name_history entry → prefix on ids → substring on CURRENT TITLE ONLY; then
(b) identity → current live channel. Append-only name_history makes an
old/dead name map deterministically to the same agent wherever it is
reachable NOW — symmetric for reach and reply.

## Rollout

Phased: this bus ships and is proven end-to-end while chatctl still runs
(independent buses, short coexistence window — agents may be double-armed,
acceptable). A SEPARATE follow-up epic in ~/code/arthack then removes
chatctl and rewrites its advice against this bus, closing the window. No
keeper schema migration, so rollback is removing the `bus` worker from
`ALL_WORKERS` + deleting bus.db/bus.sock — keeper.db is untouched throughout.
