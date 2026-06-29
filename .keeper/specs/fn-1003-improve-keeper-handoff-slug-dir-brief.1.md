## Description

**Size:** M
**Files:** cli/handoff.ts, src/rpc-handlers.ts, src/server-worker.ts, src/daemon.ts, src/derivers.ts, test/handoff.test.ts, test/rpc-handlers.test.ts, plus a new keeper-core slugify helper + a uniqueness-probe helper and their tests

### Approach

Replace the client-minted `crypto.randomUUID()` handoff id with an agent-authored,
slugified, globally-unique slug. The CLI gains a REQUIRED `--slug` input, slugified to
`[a-z0-9-]+` via a NEW keeper-core helper (reimplement the shape from
`plugins/plan/src/ids.ts:69` — do NOT import the peer plan plugin). The RPC wire param
`handoff_id` becomes `desired_slug`; the event payload field AND the `handoffs` column
STAY `handoff_id` (now carrying a slug value — no column rename). Main's `requestHandoff`
handler resolves uniqueness BEFORE `insertEvent`: a SYNCHRONOUS probe of the EVENTS log
(`SELECT 1 FROM events WHERE hook_event='HandoffRequested' AND session_id=?` — drain-
independent, permanent global uniqueness) with NO `await` between probe and insert. On
collision, REJECT loudly through the ERROR-FRAME path (NOT an `{ok:false}` rpc_result —
that would make the CLI print `value` and exit 0) with a DISTINCT error code the CLI
maps to a NEW exit 3 (machine-distinguishable from exit 1 "daemon unreachable"). The
daemon ALSO re-validates slug format (`^[a-z0-9-]+$`, non-empty, length cap, reject
`.`/`..`) — the socket is the trust boundary; a hand-crafted RPC bypasses CLI slugify.
Factor the probe into a PURE helper (`(slug, Database) -> boolean`) for unit testing
without booting the daemon. Key the doc spill file on a THROWAWAY id (the rpcId/uuid),
NOT the slug — two concurrent same-slug enqueues would otherwise clobber each other's
spill before the daemon reads it.

### Investigation targets

**Required** (read before coding):
- cli/handoff.ts:231 — `crypto.randomUUID()` (the mint being replaced); :93 `buildRequestHandoffFrame`; :119-125/:241 `spillHandoffDoc` (re-key on a throwaway id); :137-281 `main()` arg parsing + the `argFault` exit-2 path; :266-276 the rpc_result success branch that prints `value`+exits 0 (collision must NOT flow here)
- src/daemon.ts:2724-2868 — main's `requestHandoff` handler; :2823-2846 `insertEvent` with `$session_id = handoff_id` (probe goes immediately before, synchronous, no await); :2750+ the existing `ok:false` reject branches (mirror their shape for the collision frame)
- src/rpc-handlers.ts:520-621 — `validateRequestHandoffParams` (:548) + `requestHandoffHandler` (:617 the `!ok` throw that becomes the collision error frame); `optStr` :585
- src/server-worker.ts:3462-3484 — `requestHandoff` bridge + `RequestHandoffRequestMessage` type (rename the wire field)
- src/derivers.ts:37-47 — `HANDOFF_SPAWN_RE` already accepts `[a-z0-9-]+` (NO regex change); the doc-comment :37-46 claims "id is a `crypto.randomUUID()`" — rewrite to current behavior (forward-facing only)
- plugins/plan/src/ids.ts:69 — `slugify` REFERENCE shape (copy, do NOT import)
- src/db.ts:720 — `idx_events_session ON events(session_id)` (confirm the probe leads with the `session_id` predicate so it uses this index, not a scan of all `HandoffRequested` rows)

**Optional:**
- test/handoff.test.ts:59,83 — `buildRequestHandoffFrame` wire-shape assertions
- test/rpc-handlers.test.ts:658-740 — `requestHandoffHandler` happy-path + the bad-shape table :719

### Risks

- The probe and `insertEvent` MUST be in main's synchronous handler with NO `await` between them — the only race vector under the single-writer lock.
- Slugify edge cases: empty after transform (all non-ASCII / emoji), all-dash, `.`/`..` — reject empty/`.`/`..` explicitly, BOTH CLI and daemon. A leading digit is fine for an internal key.
- The producer-only probe must NEVER enter the fold — re-fold determinism: the resolved slug is frozen in `events.data`; replay never re-checks uniqueness. `foldHandoffRequested` stays a pure UPSERT.
- The spill file must be keyed on a throwaway id, not the slug (concurrent-same-slug clobber → wrong doc inlined).

### Test notes

- New pure-helper tests: slugify (the edge cases above) and the uniqueness-probe helper (freshMemDb: seed a `HandoffRequested` event, assert exists=true for that slug, false for another).
- rpc-handlers: add `desired_slug` validation cases (empty, non-slug format, missing) to the bad-shape table.
- handoff.test.ts: `buildRequestHandoffFrame` carries `desired_slug` in the wire shape.
- Assert the collision path returns the distinct error code and the CLI maps it to exit 3 (not 1/2/0).

## Acceptance

- [ ] `keeper handoff` REQUIRES a `--slug`; absent → exit 2 with a clear message.
- [ ] The slug is slugified to `[a-z0-9-]+` by a NEW keeper-core helper (no import of `plugins/plan`).
- [ ] The worker launches as `--name handoff::<slug>` (via the existing `claudeName` path — no change needed there; verify).
- [ ] A duplicate slug is REJECTED loudly: distinct error code through the error frame, CLI exits 3 (distinct from exit 1 daemon-unreachable / exit 2 arg-fault), message tells the agent to pick a new slug.
- [ ] The daemon re-validates slug format on the RPC (rejects empty/`.`/`..`/non-`[a-z0-9-]+`/oversized) independent of the CLI.
- [ ] The uniqueness probe is a pure helper, unit-tested with freshMemDb, probing the events log synchronously before `insertEvent` (no await between).
- [ ] `foldHandoffRequested` remains a pure UPSERT (no uniqueness logic in the fold); re-fold of a frozen event is byte-identical.
- [ ] The doc spill file is keyed on a throwaway id, not the slug.
- [ ] The stale `crypto.randomUUID()` doc-comment at src/derivers.ts:37-46 is rewritten to current behavior.
- [ ] `bun test` green.

## Done summary
Replaced the handoff uuid with an agent-authored, host-global-unique --slug: new src/handoff-slug.ts (slugify + format re-validation + a pure events-log uniqueness probe), main probes synchronously before insertEvent and rejects a collision via a distinct slug_conflict frame mapped to CLI exit 3, spill keyed on a throwaway rpc id.
## Evidence
