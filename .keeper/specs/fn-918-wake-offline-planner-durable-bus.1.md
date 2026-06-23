## Description

**Size:** M
**Files:** src/bus-worker.ts, src/bus-db.ts, cli/bus.ts

### Approach

Make an offline `planner@<epic>` escalation durable so any returning creator session receives it — over the EXISTING `messages` table, no schema bump (bus.db has its own `user_version` ladder; `status` is free-text `src/bus-db.ts:73` and `resolved_session_id` already exists `:70`).

1. **Persist the address (load-bearing fix).** In the offline-send branch (`src/bus-worker.ts:891-923`, entered when `channel===null || !channel.connected`), today `:916` writes `resolved_session_id: channel?.session_id ?? null` — always null offline. Fix to the resolved identity: `res.kind === "ok" ? res.identity?.job_id ?? null : null` (the offline `ok` resolution carries `identity` even with `channel:null` — `src/bus-identity.ts:360-385`; the keeper-miss live-fallback returns `identity:null` `:399-409`, which correctly yields null → not queued).
2. **Status.** For the `planner@<epic>` role-address offline case ONLY, persist `status:'queued_for_wake'`. A generic offline name/id send keeps `not_connected` — do NOT turn every offline send into a durable queue. Detect the role case via `parseRoleAddress(toTarget)` (`src/bus-identity.ts:240`).
3. **Replay-on-resubscribe (recipient-keyed).** In `opSubscribe` (`src/bus-worker.ts:831-864`), after binding `entry.sock` + sending the ack, query `messages WHERE resolved_session_id = <entry.channel.session_id> AND status='queued_for_wake' AND event='send' ORDER BY id ASC`, rebuild each via `buildEnvelope` (`:997`, mirror the live-send arg list at `:943-952`), `deliver()` it, and on accept flip to `status:'delivered_after_wake'` via `setMessageStatus` (`:1199`, private in bus-worker). The flip IS the dedup (stable key = message id) — a second subscribe re-queries and finds none. Do NOT reuse `replayFromCursor` (`src/bus-db.ts:344`) — it filters by namespace only and would leak unrelated chat rows.
4. **CLI outcome.** Surface `queued_for_wake` as a publish outcome on `keeper bus chat send`, exit 0 (it's "queued for the offline planner", not a failure) — `cli/bus.ts` outcome→exit map (`:99-104`, `:525-536`).

The `/work` Phase 2c skill change + the wake verb are task `.2`; this task is bus-internal + the CLI outcome only.

### Investigation targets

**Required:**
- src/bus-worker.ts:891-923 — offline-send branch (the fix + `queued_for_wake`); :831-864 `opSubscribe` (replay); :1199 `setMessageStatus`; :997-1010 + :943-952 `buildEnvelope` arg list; :285 `publishOutcome`; :15 (NO worker→main — stay in worker)
- src/bus-identity.ts:360-385 (offline `ok` carries `identity`), :399-409 (keeper-miss `identity:null`), :240 `parseRoleAddress`
- src/bus-db.ts:59-76 messages schema, :70 `resolved_session_id`, :73 `status` free-text, :93-113 `migrateBusDb` (do NOT bump user_version), :301 `appendMessage`, :344-360 `replayFromCursor` (do NOT use)
- cli/bus.ts:135-179 `parseBusArgv`, :99-104 + :525-536 outcome→exit, :486 publish ack

**Optional:**
- test/bus-worker.test.ts, test/bus-db.test.ts, test/bus-cli.test.ts — fast-tier pure patterns (no real git, no daemon)

### Risks

- Idempotency: once flipped to `delivered_after_wake` a row must never re-deliver — the replay query excludes it by status; verify a double-subscribe is a no-op.
- Recipient key correctness: key on the RECONNECTING channel's `session_id` (`entry.channel.session_id`), the creator's `job_id` — not `channel_id` (ephemeral, changes on reconnect/takeover).
- Only queue when `res.identity?.job_id` is present (role + known creator); never queue a keeper-miss (`identity:null`) or a generic offline send.
- No bus.db version bump (free-text status + existing column) — bumping would trip the downgrade guard for nothing.

### Test notes

Fast-tier, synthetic (no real git/daemon). Cases: offline `planner@<epic>` → `queued_for_wake` with `resolved_session_id`=creator job_id; generic offline name → still `not_connected`; `opSubscribe` for that session redelivers only its `queued_for_wake` rows and flips them; second subscribe redelivers nothing; a different namespace / different recipient is not leaked; `keeper bus chat send` exits 0 on `queued_for_wake`.

## Acceptance

- [ ] Offline `planner@<epic>` send persists `queued_for_wake` + `resolved_session_id`=creator `job_id`; generic offline stays `not_connected`
- [ ] `opSubscribe` recipient-keyed replay delivers only this session's `queued_for_wake` rows, flips them to `delivered_after_wake`, idempotent on re-subscribe, namespace-safe; `replayFromCursor` untouched
- [ ] `queued_for_wake` surfaced as exit-0 outcome on `keeper bus chat send`; no bus.db schema bump; bus worker stays pure (no spawn, no worker→main)
- [ ] fast-tier tests cover all cases; `bun run test:full` green

## Done summary
Durable wake-on-send queue: an offline planner@<epic> escalation persists as queued_for_wake keyed on the creator job_id and replays recipient-keyed on resubscribe (flipped to delivered_after_wake, namespace-safe, idempotent); surfaced as an exit-0 outcome on keeper bus chat send. No bus.db schema bump; bus worker stays pure.
## Evidence
