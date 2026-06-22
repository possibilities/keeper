## Overview

Make keeperd's control plane available sooner after a restart and bound peak WAL during the
boot drain. Today the daemon opens its control socket only after the entire synchronous
boot-drain completes, and `withBootDrainCheckpointTuning` disables WAL autocheckpoint for the
whole drain (WAL ballooned to 3.3 GB before a single final TRUNCATE). With fn-888 + fn-892
already cutting per-fold cost, the remaining work is structural: (B2) checkpoint the WAL
periodically during the drain to bound peak size, and (B1) serve read-only queries while the
reducer is still catching up — with state-changing surfaces (autopilot actuator + mutating
RPCs) gated behind drain-reaches-head + git-seed, an unseeded git surface reading as "unknown"
not "clean", and a boot-status header so clients can tell they're seeing catch-up state.

## Quick commands

- `bun test test/daemon.test.ts` — boot-drain + WAL checkpoint cadence (B2)
- `bun test test/server-worker.test.ts test/readiness.test.ts test/git-boot-seed.test.ts` — early-serve, boot-status header, unseeded-git guard (B1)
- `bun run test:full` — mandatory full tier (daemon/worker/db/git paths)
- After landing + a daemon bounce: control socket reachable during catch-up; `keeper jobs`/queries carry a boot-status header showing `catching_up` until head+seed

## Acceptance

- [ ] Peak WAL stays bounded during a large boot drain (periodic PASSIVE), with the final TRUNCATE preserved
- [ ] The read-only query socket is reachable while the reducer is still draining
- [ ] Autopilot actuator + mutating RPCs stay gated behind drain-reaches-head + git-seed + ephemeral-truncate; mutating RPCs rejected with a clear `server_booting` error until then
- [ ] An unseeded git surface reads as "unknown", never "clean" (readiness + `keeper await git-clean`)
- [ ] Query replies carry a boot-status header (rev / head_event_id / catching_up / git_seed_required|complete)
- [ ] No projection / fold / cursor touched — zero re-fold or exactly-once impact; server worker stays read-only

## Early proof point

Task that proves the approach: `.1` (B2 PASSIVE cadence). It lands the low-risk WAL-bounding
win and validates the in-drain instrumentation the rest builds on. If a mid-drain PASSIVE
can't bound the WAL without disturbing the per-event drain transaction, rethink before `.2`.
`.2` (B1) is the keystone, gated behind `.1` because serving during the drain weakens the
final TRUNCATE's sole-connection precondition that `.1` owns.

## References

- Boot sequence: `src/daemon.ts:1313-1464` (events-ingest → boot-drain block `:1321-1424` → git boot-seed `seedGitProjection` `:1426-1443` → `truncateEphemeralProjections` `:1445-1456`); server-worker spawn currently at `:1621-1635`.
- WAL tuning: `withBootDrainCheckpointTuning` `src/daemon.ts:344-355`, final-TRUNCATE sole-connection note `:331-342`, steady-state PASSIVE heartbeat `:3458-3469`, `WAL_AUTOCHECKPOINT_PAGES` `:187`.
- Drain loop (where the per-K-batch PASSIVE rides): `drainToCompletion` / `drain` `src/daemon.ts:154-180`.
- Server worker: `startServer` bind `src/server-worker.ts:2469-2493`, ready signal `:3096`, `readWorldRev` `:1748-1753`, distinct reader/writer conns (reader autocommit) `:2455-2467`.
- Protocol: `rev` on every frame `src/protocol.ts:67-70` / `:147-148`; forward-compat "unknown fields ignored" `:64-65` — boot-status header slots into ResultFrame/RpcResultFrame safely.
- Readiness: `computeReadiness` `src/readiness.ts:316-340`; existing `{kind:"unknown"}` verdict `:135-152`, `:1319-1334`; input wiring in `src/readiness-client.ts`.
- Git-seed flag (authoritative): `git_projection_state(floor, seed_required)` `src/db.ts:1236-1239`; `rewindLiveProjection` resets `seed_required=1` `:1320-1347`; producer `src/git-boot-seed.ts`.
- Overlap (hard dep, wired): fn-896 (retire-exec-backend-abstraction) is in-flight and its task .3 adds an agentwrap boot check to `src/daemon.ts` — same boot region; this epic is sequenced after it.
- Overlap (advisory, NOT wired): fn-889 (retire-planctl-name) task .1 is a repo-wide AST rename codemod touching `src/daemon.ts` — rename-only, different lines; rebase whichever lands second.

## Docs gaps

- **README.md** (`## Architecture`, boot/WAL prose ~120-138, the "BEFORE serving" + final-TRUNCATE "sole connection" claims ~126-130, autopilot-gating ~244-253): revise to the two-gate model (read socket up during drain; actuator + mutating RPCs gated behind head+seed) and the periodic in-drain PASSIVE cadence; prune the stale single-gate language rather than appending.
- **CLAUDE.md / AGENTS.md** (line ~90 "boot-seed runs AFTER drain, BEFORE serving"; ephemeral paragraph ~73-75): split into two gates ("read socket opens after migrate during drain; actuator + mutating RPCs gated behind drain-reaches-head + git-seed"); record the new "unseeded git reads as unknown, never clean" invariant.
- **plugins/keeper/skills/await/SKILL.md** (`server-up` ~61, ~302-310): `server-up` now fires when the socket opens (during catch-up), not at drain-complete — clarify the semantics and that the board may still be catching up (clients inspect the boot-status header).

## Best practices

- **PASSIVE never blocks; trigger on WAL size, not per-event:** issue `wal_checkpoint(PASSIVE)` when the WAL grows past a threshold (≈nLog>50k pages / ~200MB) or every ~10k events — never per-event (millions of near-no-op checkpoints dominate drain time). [SQLite WAL docs; Litestream; rqlite]
- **TRUNCATE needs no active reader:** once B1 attaches the server's read connection during the drain, the final `wal_checkpoint(TRUNCATE)` can hit busy and not shrink the file — it degrades to busy/PASSIVE semantics; have the early server idle/detach its read txn at the drain-complete boundary or accept the degrade. [SQLite WAL; Litestream truncate-threshold]
- **Readiness ≠ liveness:** up-but-catching-up must pass liveness (fold is progressing) and fail readiness for mutating surfaces; never fail liveness on `catching_up` or a restart loop wipes drain progress. [k8s probes]
- **Stamp staleness on every reply, not just the first:** a client that reads an empty projection mid-drain and caches it is silently wrong — `catching_up` must ride every response during the drain. [CQRS read-model consistency]
