## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/server-worker.ts, src/autopilot-worker.ts (or daemon.ts — producer feed), cli/autopilot.ts, README.md

### Approach

Surface WHY a repo's worktrees are disabled as a NON-error operator view on `keeper autopilot`. The keeper CLI reads ONLY DB-backed collections via server-worker (`server-worker.ts:176`) — it has NO line to the autopilot worker's in-memory per-cycle state — so the verdict MUST reach the CLI through a projection. To preserve re-fold determinism (the verdict is fs-derived / non-deterministic and MUST NOT be replayed from the event log), use a LIVE-ONLY projection, exactly the `git_status` precedent (`db.ts:1523-1531` `LIVE_ONLY_PROJECTIONS`, wiped via `rewindLiveProjection` `db.ts:1604`, NEVER deterministic-replayed).

- Add a live-only `worktree_repo_status` projection/collection: `{ key (toplevel or epic_id), mode: "worktree"|"serial"|"rejected", reason, updated_at }`. Register it in `LIVE_ONLY_PROJECTIONS` and cover it in `rewindLiveProjection` — NEVER the deterministic-replayed class.
- Write path: the autopilot worker already computes `worktreeRepoByEpicId` each cycle; feed it to main and fold it into the live-only projection via the SAME producer -> main -> fold mechanism `git_status` uses (workers feed via main; main writes). Do NOT add a new RPC and do NOT widen the seven RPC-writable surfaces — mirror the existing live git-surface write path. VERIFY the exact `git_status` write mechanism end to end and mirror it; if it cannot be mirrored cleanly for this producer, RE-BLOCK for a design pass rather than inventing a new event/RPC.
- Read/render: `keeper autopilot` (cli/autopilot.ts) reads the new collection via the normal server-worker query path and renders a neutral `worktree: serial (reason)` section, DISTINCT from the red failed / dispatch-failures block. An empty / pre-first-cycle collection renders cleanly (no section).
- Docs: `README.md` `## Architecture` worktree section (~3368-3378) — reword "Two distinct sticky rejects" and introduce `disabled` as a separate non-error category (criteria, sequential shared-checkout dispatch, the memoized probe, grandfathering, and the live-only status projection). `cli/autopilot.ts` worktree `--help` (~86-92) — under 3 lines on the sequential-fallback.

### Investigation targets

**Required** (read before coding):
- src/db.ts:1523-1531 (`LIVE_ONLY_PROJECTIONS`), :1604 (`rewindLiveProjection`) — the live-only registry + wipe path
- the `git_status` live-only projection END TO END: its producer/write path (the git surface feeding main), its collection definition, and how `cli/board.ts` renders it — THIS is the pattern to mirror
- src/server-worker.ts:176 — the CLI collection read path (why in-memory worker state is unreachable from the CLI)
- src/collections.ts — collection registration
- cli/autopilot.ts:62-115 (status render + `--help`), cli/board.ts:469-470,852 (human-view precedent), README.md ~3285-3389

**Optional:**
- src/reducer.ts — the fold registration site for the new live-only projection

### Risks

- Re-fold determinism: the projection MUST be live-only (wiped / re-derived, never replayed). An fs-derived verdict in the deterministic-replayed class would corrupt re-fold. `git_status` is the exact precedent — mirror its class membership.
- Don't widen the write surface: mirror the `git_status` producer -> main write path; do NOT add a new RPC or a general reducer write path. If `git_status`'s mechanism cannot be cleanly mirrored for this producer, RE-BLOCK for a design pass rather than inventing one.
- Keep it entirely out of the `dispatch_failures` / red path — `disabled` is non-error.

### Test notes

- Pure fold tests: a synthetic worktree-status event -> the live-only projection; and its wipe via `rewindLiveProjection`.
- A guard/test asserting the new projection IS in `LIVE_ONLY_PROJECTIONS` (i.e. NOT deterministic-replayed).
- Collection -> status-render shaping: a disabled epic -> a neutral `serial (reason)` line; an empty collection -> no section.

## Acceptance

- [ ] `keeper autopilot` shows which repos/epics are worktree-disabled and the reason, as a neutral (non-error) line distinct from the failed / dispatch-failures block
- [ ] the verdict reaches the CLI via a LIVE-ONLY projection (the `git_status` class) — registered in `LIVE_ONLY_PROJECTIONS` and wiped via `rewindLiveProjection`, NEVER deterministic-replayed (pinned by a test)
- [ ] the producer write path mirrors `git_status` (worker feeds main); NO new RPC and NO widened reducer write surface
- [ ] an empty / pre-first-cycle collection renders cleanly (no section)
- [ ] `README.md` worktree section reworded — `disabled` introduced as a separate non-error category; the "two sticky rejects" wording corrected
- [ ] `cli/autopilot.ts` worktree `--help` notes the sequential-fallback behavior (under 3 added lines)
- [ ] no `dispatch_failures` / sticky reject involvement

## Done summary

## Evidence
