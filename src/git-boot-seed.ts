/**
 * Boot-seed producer for the LIVE-ONLY git projection surface (`git_status` +
 * `file_attributions` + the 3 `jobs` git-counter columns).
 *
 * The git surface is a Marten "Live projection" — NOT replayed from history. The
 * v79 migration raises a skip-floor (`git_projection_state.floor`) to the current
 * `max(events.id)`, so every historical `GitSnapshot`/`Commit` git fold no-ops
 * (skipping the ~6-day `computeRepoBashWindows` self-join over 4.3M events). This
 * producer re-derives the surface at FULL fidelity for currently-dirty files
 * BEFORE the daemon serves, then live folds keep it current.
 *
 * Boot slot (in `runDaemon`, mirroring `seedKilledSweep`):
 *
 *   migrate(db) → scanEventsLogDir → drainToCompletion (git no-ops <= floor)
 *   seedKilledSweep(db)
 *   seedGitProjection(db, stmts, { drainToCompletion })   // <-- here
 *   // …autopilot re-arm, then spawn git-worker (first-emit suppressed)
 *
 * Per-root work (the panel-verified live-tail-equivalence recipe):
 *   1. read `max(events.id)` FIRST — this is the floor we will persist. Events
 *      that arrive DURING the scan (id > this) re-apply idempotently via the live
 *      fold, so capturing the floor before the scan is the correctness anchor.
 *   2. mark `seed_required = 1` (crash mid-seed ⇒ next boot re-seeds).
 *   3. per watched root: reset (`DELETE`) its `git_status` + `file_attributions`
 *      rows and zero the 3 `jobs` git-counters, then `readStatus` →
 *      `buildGitSnapshot` (REUSED from git-worker — never reimplemented), append
 *      a synthetic `GitSnapshot` via the prepared `stmts.insertEvent` (NOT a raw
 *      INSERT — avoids EVENT_COLUMNS drift), and drain it. The synthetic event's
 *      id > floor, so `projectGitStatus` does the full pass1/pass2/pass4 against
 *      the intact log → full fidelity.
 *   4. persist `floor = capturedMaxId` and clear `seed_required` atomically.
 *
 * **Degrade, NOT fatalExit.** This is the FIRST git shell-out on the daemon main
 * thread; a hang or failure must NOT take down the control plane (jobs / epics /
 * autopilot). The whole seed is time-bound; on timeout or per-root failure we
 * serve the rest of the surface and LEAVE `seed_required` set so a later boot (or
 * the live git-worker's first emit) re-derives the git surface. The git reads are
 * already individually time-bound + fail-safe (`gitOutput` returns `null`), so a
 * single bad root degrades to "that root unseeded", never a throw.
 *
 * Determinism note: this is a PRODUCER (the boot half of the git surface, the
 * live git-worker being the steady-state half). It probes git + reads
 * `max(events.id)` — both producer-only. The synthetic `GitSnapshot` it appends
 * is folded by the deterministic `projectGitStatus`, and the floor/seed_required
 * it writes are charter-excluded control state, so the re-fold byte-identical
 * guarantee for the OTHER ~16 projections is untouched.
 *
 * The live git-worker spawns with an EMPTY in-memory dedupe cache, so its first
 * scan re-emits a GitSnapshot per root shortly after boot. That re-emit is
 * BENIGN: its id is also > floor, `projectGitStatus` folds it idempotently
 * (same dirty set ⇒ same `git_status`/`file_attributions`), and it merely
 * re-confirms what this seed already populated. The seed's job is to have the
 * surface ready BEFORE serving (so `await git-clean` works from the first board
 * read); reconciling the one redundant re-emit is an explicit non-goal here.
 */

import type { Database } from "bun:sqlite";
import type { Stmts } from "./db";
import { raiseGitProjectionFloor, setGitProjectionSeedRequired } from "./db";
import {
  buildDiscoveryCandidates,
  buildGitSnapshot,
  readStatus,
  resolveGitToplevel,
} from "./git-worker";

/**
 * Default wall-clock budget for the WHOLE boot-seed git scan. Generous enough to
 * cover a handful of repos with dirty-heavy trees on a slow disk, but bounded so
 * a wedged git can never brick boot. On exhaustion the seed stops issuing new
 * per-root scans, `seed_required` stays set, and the daemon serves.
 */
export const DEFAULT_GIT_SEED_BUDGET_MS = 30_000;

export interface SeedGitProjectionOptions {
  /**
   * Drain the event log to completion. Passed in (not imported) so the boot-seed
   * stays decoupled from `daemon.ts` (which imports THIS module — a direct import
   * back would be circular) and so tests can inject a drain stub.
   */
  drainToCompletion: (db: Database) => void;
  /** Wall-clock budget for the whole scan. Defaults {@link DEFAULT_GIT_SEED_BUDGET_MS}. */
  timeBudgetMs?: number;
  /** Monotonic-clock source (injectable for tests). Defaults `performance.now`. */
  now?: () => number;
  /**
   * Override the root set (skips `buildDiscoveryCandidates` + toplevel resolve).
   * Tests pass explicit roots; production omits it.
   */
  roots?: string[];
}

export interface SeedGitProjectionResult {
  /** The floor persisted (the `max(events.id)` captured before the scan). */
  floor: number;
  /** Roots that were successfully scanned + seeded. */
  seededRoots: string[];
  /** True when every targeted root seeded within budget (⇒ `seed_required` cleared). */
  complete: boolean;
}

/**
 * Read `max(events.id)`. Returns 0 on an empty log. This is captured BEFORE the
 * git scan and becomes the floor — see the module header's correctness note.
 */
function readMaxEventId(db: Database): number {
  const row = db.query("SELECT MAX(id) AS maxId FROM events").get() as {
    maxId: number | null;
  } | null;
  return row?.maxId ?? 0;
}

/**
 * Enumerate the git roots to seed: the same candidate set the live git-worker
 * watches (`epics.project_dir` + `task.target_repo` + every `jobs.cwd`), resolved
 * to git toplevels. `runFullSweep: true` so a stale unpushed-but-clean repo is
 * covered. Failures resolve to "skip that candidate" (fail-safe).
 */
function discoverSeedRoots(db: Database, nowMs: number): string[] {
  const candidates = buildDiscoveryCandidates(db, {
    nowMs,
    runFullSweep: true,
    watched: new Set<string>(),
  });
  const roots = new Set<string>();
  for (const candidate of candidates) {
    let root: string | null = null;
    try {
      root = resolveGitToplevel(candidate);
    } catch {
      root = null;
    }
    if (root != null) roots.add(root);
  }
  return Array.from(roots).sort();
}

/**
 * Reset one root's live git rows so the synthetic snapshot repopulates from a
 * clean slate: DELETE its `git_status` + `file_attributions` rows and zero the 3
 * `jobs` git-counters for every job attributed to this root. Without the reset a
 * file that was dirty pre-restart but is now clean would strand a stale
 * `file_attributions` row (the snapshot only re-renders CURRENTLY-dirty files).
 *
 * Mirrors `retractGitStatus` (minus the floor gate — this runs ABOVE the floor as
 * a producer). Pulls the attributed `job_id`s from the stored `git_status.jobs`
 * JSON, same as the live retract.
 */
function resetRootGitRows(db: Database, projectDir: string): void {
  const row = db
    .query("SELECT jobs FROM git_status WHERE project_dir = ?")
    .get(projectDir) as { jobs: string | null } | null;
  if (row != null && row.jobs != null && row.jobs.length > 0) {
    let attributedJobs: Array<{ job_id?: unknown }> = [];
    try {
      const parsed = JSON.parse(row.jobs);
      if (Array.isArray(parsed)) {
        attributedJobs = parsed as Array<{ job_id?: unknown }>;
      }
    } catch {
      attributedJobs = [];
    }
    for (const job of attributedJobs) {
      const jobId = job.job_id;
      if (typeof jobId !== "string" || jobId.length === 0) continue;
      db.run(
        `UPDATE jobs
            SET git_dirty_count = 0,
                git_unattributed_to_live_count = 0,
                git_orphan_count = 0
          WHERE job_id = ?`,
        [jobId],
      );
    }
  }
  db.run("DELETE FROM file_attributions WHERE project_dir = ?", [projectDir]);
  db.run("DELETE FROM git_status WHERE project_dir = ?", [projectDir]);
}

/**
 * Append a synthetic `GitSnapshot` event for one root, EXACTLY matching the live
 * git-worker's `stmts.insertEvent` shape in `daemon.ts` (so a future column add
 * is caught by the prepared statement's named bindings, not silently shifted).
 * The snapshot's id > floor, so the next drain folds it through the full
 * `projectGitStatus` path.
 */
function insertSyntheticGitSnapshot(
  stmts: Stmts,
  projectDir: string,
  data: string,
): void {
  stmts.insertEvent.run({
    $ts: Date.now() / 1000,
    $session_id: projectDir,
    $pid: null,
    $hook_event: "GitSnapshot",
    $event_type: "git_snapshot",
    $tool_name: null,
    $matcher: null,
    $cwd: projectDir,
    $permission_mode: null,
    $agent_id: null,
    $agent_type: null,
    $stop_hook_active: null,
    $data: data,
    $subagent_agent_id: null,
    $spawn_name: null,
    $start_time: null,
    $slash_command: null,
    $skill_name: null,
    $plan_op: null,
    $plan_target: null,
    $plan_epic_id: null,
    $plan_task_id: null,
    $plan_subject_present: null,
    $tool_use_id: null,
    $config_dir: null,
    $plan_queue_jump: null,
    $bash_mutation_kind: null,
    $bash_mutation_targets: null,
    $plan_files: null,
    $backend_exec_type: null,
    $backend_exec_session_id: null,
    $backend_exec_pane_id: null,
    $background_task_id: null,
    $mutation_path: null,
  });
}

/**
 * Re-derive the live git surface for currently-dirty files BEFORE serving, then
 * raise the skip-floor + clear `seed_required`. See the module header for the
 * full contract. NEVER throws — a per-root failure is isolated, a budget timeout
 * leaves `seed_required` set, and either way the daemon serves the rest.
 */
export function seedGitProjection(
  db: Database,
  stmts: Stmts,
  options: SeedGitProjectionOptions,
): SeedGitProjectionResult {
  const now = options.now ?? (() => performance.now());
  const budgetMs = options.timeBudgetMs ?? DEFAULT_GIT_SEED_BUDGET_MS;
  const startedAt = now();

  // 1. Capture the floor FIRST (before any git scan), so events arriving during
  //    the scan (id > this) re-apply idempotently via the live fold.
  const floor = readMaxEventId(db);

  // 2. Mark mid-flight. A crash before the atomic finish leaves this set, so the
  //    next boot re-seeds.
  setGitProjectionSeedRequired(db, true);

  const roots = options.roots ?? discoverSeedRoots(db, Date.now());

  const seededRoots: string[] = [];
  let complete = true;
  for (const root of roots) {
    if (now() - startedAt >= budgetMs) {
      // Budget exhausted — stop issuing new scans. `seed_required` stays set.
      complete = false;
      console.error(
        `[keeperd] git boot-seed budget (${budgetMs}ms) exhausted after ` +
          `${seededRoots.length}/${roots.length} roots; serving with ` +
          `seed_required set (next boot re-seeds the rest)`,
      );
      break;
    }
    try {
      const status = readStatus(root);
      if (status == null) {
        // Time-bound git read failed/timed out for this root — skip it (the row
        // it would have produced stays whatever it was; a later boot retries).
        complete = false;
        continue;
      }
      const snapshot = buildGitSnapshot(root, status);
      resetRootGitRows(db, root);
      insertSyntheticGitSnapshot(stmts, root, JSON.stringify(snapshot));
      // Fold the just-appended snapshot (id > floor → full-fidelity re-derive).
      options.drainToCompletion(db);
      seededRoots.push(root);
    } catch (err) {
      // Per-root isolation: one bad root never aborts the seed or the daemon.
      complete = false;
      console.error(`[keeperd] git boot-seed failed for root=${root}: ${err}`);
    }
  }

  // 4. Persist the floor (monotonic raise) regardless of completeness — the
  //    historical replay must stay skipped. Clear `seed_required` ONLY when every
  //    targeted root seeded within budget; otherwise leave it set to retry.
  raiseGitProjectionFloor(db, floor);
  if (complete) {
    setGitProjectionSeedRequired(db, false);
  }

  return { floor, seededRoots, complete };
}
