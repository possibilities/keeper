/**
 * RETIRED PRODUCER — shared helper module (fn-684 task .5).
 *
 * History. This file used to host the interval-driven
 * `zellij action list-panes -a -j` tab-resolver worker (fn-668 /
 * schema v48) — the eighth worker thread and the fourth producer
 * instance. Each tick read live jobs carrying both a
 * `backend_exec_session_id` and a `backend_exec_pane_id`, deduped by
 * distinct (session, pane), shelled one `list-panes` per distinct
 * session, and posted a `BackendExecSnapshot` message per resolved
 * pane to main. main lifted each message into a synthetic event whose
 * reducer fold UPDATEs `jobs.backend_exec_tab_{id,name}` (tab
 * tombstone = last-known sticks).
 *
 * Why it's gone. The poller forced zellij's single screen thread
 * through an O(panes) full-system process scan on every tick, which
 * regularly wedged the screen thread (frozen tabs, unreachable new
 * tabs) under fan-out load. The fn-684 epic replaced it with a
 * headless Rust wasm bridge plugin (`task .1`) that subscribes to
 * native `PaneUpdate` / `TabUpdate` events and pushes already-joined
 * `pane_id -> (tab_id, tab_name)` resolutions to keeper via
 * session-scoped NDJSON files. The new ingestion pipeline
 * (`src/zellij-events-worker.ts` + `scanZellijEventsDir` in
 * `src/daemon.ts`) folds those lines through the EXACT same
 * `BackendExecSnapshot` synthetic event the poller used — zero
 * reducer change, zero schema change — and is event-driven, so
 * renames / new tabs surface in ~1s instead of the poller's 5s.
 *
 * What remains. `readLiveJobsWithCoords` is the
 * `(session, pane) -> job_id` join the new ingestion path also
 * uses (see `scanZellijEventsDir` in `daemon.ts`). It's preserved
 * here as a stable export so downstream readers and tests can keep
 * their import path; the `LiveJobRow` shape is the projection-side
 * column set the join produces.
 *
 * Rollback. The plugin feed has soaked on the dev box (multi-day
 * window: tab renames + new tabs propagate to
 * `jobs.backend_exec_tab_name`; the zellij log shows no
 * `GetPaneCwd timed out` / `NewTab` timeout storms). If a future
 * regression forces a return to the poller, the one-step revert is
 * to `git revert` the fn-684 task .5 commit — the prior commit
 * restores the worker spawn (and this file's original body) in
 * `src/daemon.ts` and resurrects the `KEEPER_ZELLIJ_FEED=poller`
 * default. There is no in-process env-flag toggle — the poller
 * code path is retired, not merely gated.
 */

import type { Database } from "bun:sqlite";

/** Row shape produced by {@link readLiveJobsWithCoords}. */
export interface LiveJobRow {
  job_id: string;
  backend_exec_session_id: string;
  backend_exec_pane_id: string;
  /**
   * The job's CURRENT projected tab coordinates (fn-709). Both are
   * nullable TEXT — a job that has not yet folded a `BackendExecSnapshot`
   * carries `null` for both, which `scanZellijEventsDir` treats as "no
   * last-known" so the first mint is always allowed. The consumer's
   * mint-seam dedup gate compares an incoming line's effective
   * `(tab_id, tab_name)` against these to skip no-op re-mints.
   */
  backend_exec_tab_id: string | null;
  backend_exec_tab_name: string | null;
}

/**
 * Read every live job carrying both a `backend_exec_session_id` and
 * a `backend_exec_pane_id`. "Live" = `state NOT IN ('ended', 'killed')`
 * — the same resting-state predicate the rest of the projection uses
 * to decide whether a job's coordinates are still meaningful. An
 * ended job's pane is presumed gone, so its (session, pane) is not a
 * join target.
 *
 * The plugin-feed consumer (`scanZellijEventsDir` in `src/daemon.ts`)
 * calls this once per scan to build a `${session}::${pane_id}` ->
 * `{job_id, tabId, tabName}` map; an NDJSON line whose pane has no live
 * job is dropped (non-keeper session, or job already ended) and never
 * mints a snapshot.
 *
 * The SELECT also carries the job's CURRENT `backend_exec_tab_id` /
 * `backend_exec_tab_name` (fn-709, additive) so the consumer can seed a
 * per-scan last-known tab tuple and dedup feed lines whose effective
 * `(tab_id, tab_name)` already equals the projection — eliminating the
 * no-op `BackendExecSnapshot` mints that were the bulk of the event log.
 */
export function readLiveJobsWithCoords(db: Database): LiveJobRow[] {
  return db
    .query(
      `SELECT job_id, backend_exec_session_id, backend_exec_pane_id,
              backend_exec_tab_id, backend_exec_tab_name
         FROM jobs
        WHERE backend_exec_session_id IS NOT NULL
          AND backend_exec_pane_id IS NOT NULL
          AND state NOT IN ('ended', 'killed')`,
    )
    .all() as LiveJobRow[];
}
