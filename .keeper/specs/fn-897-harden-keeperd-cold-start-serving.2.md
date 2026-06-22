## Description

**Size:** M
**Files:** src/daemon.ts, src/server-worker.ts, src/readiness.ts, src/readiness-client.ts, src/protocol.ts, test/server-worker.test.ts, test/readiness.test.ts, README.md, CLAUDE.md, plugins/keeper/skills/await/SKILL.md

### Approach

Make the read-only control socket reachable while the reducer is still catching up, without
letting any consumer act on partial state. Move the server-worker spawn (src/daemon.ts:1621-1635)
to right after `migrate()` (before the boot-drain block at :1321), since the server worker is
decoupled and read-only and needs only a migrated schema. Then add the guards:

1. **Actuator + mutating RPCs stay gated.** Keep the autopilot actuator spawning only after
   drain-reaches-head + git-seed + `truncateEphemeralProjections` (do NOT move those). In the
   server worker's RPC dispatch, reject mutating RPCs with a clear `server_booting` error until
   the daemon reaches today's post-drain spawn point (signal readiness from main → server via
   the existing typed message channel). Reads are served throughout.
2. **Unseeded git = unknown, never clean.** Where `computeReadiness` inputs are built
   (src/readiness-client.ts), map `git_projection_state.seed_required=1` to the existing
   `{kind:"unknown"}` verdict (src/readiness.ts:135-152) so autopilot won't dispatch and
   `keeper await git-clean` treats unseeded as not-ready, never clean.
3. **Boot-status header.** Add fields to the reply envelope (ResultFrame/RpcResultFrame in
   src/protocol.ts — forward-compat-safe per :64-65): reuse `rev` (=`reducer_state.last_event_id`),
   add `head_event_id` (=`max(events.id)`), `catching_up`, `git_seed_required`/`git_seed_complete`
   (from `git_projection_state`). Stamp it on EVERY reply during catch-up, not just the first.
4. **TRUNCATE interaction (depends on task 1).** The early server's read connection is now
   attached during the drain, weakening the final TRUNCATE's "sole connection" precondition
   (src/daemon.ts:331-342). Have the early server idle/detach its read txn at the drain-complete
   boundary so the final TRUNCATE can still collapse the WAL, or accept the documented degrade
   to busy/PASSIVE semantics — and rewrite that code comment + the README/CLAUDE.md claims.

No projection, fold, or cursor is touched; the server worker stays read-only (no write path).
The only failure mode is a consumer acting on partial state, which the gate in (1)+(2) closes.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1621-1635 — server-worker spawn (move earlier); :1313-1464 — full boot order; :331-342 — final-TRUNCATE sole-connection note to rewrite
- src/server-worker.ts:2455-2493 — `startServer` (distinct reader/writer conns, bind); :3096 — ready signal; :1748-1753 — `readWorldRev`
- src/protocol.ts:64-70, :147-148 — frame shape, `rev`, forward-compat field rule
- src/readiness.ts:135-152, :316-340, :1319-1334 — `{kind:"unknown"}` verdict + `computeReadiness`
- src/db.ts:1236-1239 — `git_projection_state(floor, seed_required)` authoritative seed flag

**Optional** (reference as needed):
- src/readiness-client.ts — where readiness inputs (incl. now + git state) are assembled
- src/git-boot-seed.ts — `seedGitProjection`, what clears `seed_required`
- test/server-worker.test.ts:1331-1368, :1485-1487 — bind/ready test + `setWorldRev` helper

### Risks

- **Acting on partial state is the core hazard:** a mutating RPC (e.g. `set_epic_armed`) mid-drain could arm against unfolded job-link state → phantom-ready dispatch. The `server_booting` reject must be enforced at dispatch, not by convention.
- **Phantom `pending_dispatches`:** never serve the actuator before `truncateEphemeralProjections` (the v76→v79 dispatch jam). Keep the actuator gate exactly where it is.
- **TRUNCATE degrade:** the early reader can pin the WAL so the final TRUNCATE no-ops; handle via read-txn idle/detach at the drain boundary, or accept + document the degrade (interaction with task 1).
- **Empty-projection caching:** clients reading an empty `epics` mid-drain and caching it are silently wrong — `catching_up` must ride every reply, not just the first.

### Test notes

- test/server-worker.test.ts: assert the socket binds + serves reads while `rev < head`; assert the boot-status header (`catching_up`, `head_event_id`, seed flags) is present and correct (reuse `setWorldRev`); assert mutating RPCs return `server_booting` until readiness is signaled.
- test/readiness.test.ts: assert unseeded git (`seed_required=1`) yields `{kind:"unknown"}`, never clean.
- `bun run test:full` (daemon/worker/db/git).

## Acceptance

- [ ] Server worker spawns right after `migrate()`; the read-only query socket is reachable while the reducer is still draining
- [ ] Mutating RPCs return a clear `server_booting` error until drain-reaches-head + git-seed + ephemeral-truncate; the autopilot actuator still arms only after that point
- [ ] Unseeded git surface (`seed_required=1`) reads as `{kind:"unknown"}` in readiness and is treated as not-ready by `keeper await git-clean` — never "clean"
- [ ] Every query/RPC reply during catch-up carries a boot-status header (rev / head_event_id / catching_up / git_seed_required|complete)
- [ ] The final-TRUNCATE behavior under an attached early reader is handled (read-txn idle/detach at drain boundary) or its degrade documented; the stale `daemon.ts:331-342` comment + README/CLAUDE.md claims are rewritten
- [ ] Server worker remains read-only; no projection/fold/cursor change
- [ ] `bun run test:full` green

## Done summary

## Evidence
