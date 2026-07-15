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
 *   1. read `max(events.id)` FIRST — this is the replay floor we will persist.
 *   2. mark `seed_required = 1` (crash mid-seed ⇒ next boot re-seeds).
 *   3. per watched root: capture a fresh inclusive `max(events.id)` watermark
 *      IMMEDIATELY before `readStatus` → `buildGitSnapshot` (REUSED from
 *      git-worker — never reimplemented), append both in a synthetic
 *      `GitSnapshot` through `stmts.insertEvent`, and drain it. The watermark,
 *      not the later synthetic event id, bounds attribution evidence visible to
 *      that Git read; events arriving after it remain for the next observation.
 *   4. persist the original replay floor and clear `seed_required` atomically.
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
import { existsSync } from "node:fs";
import type { Stmts } from "./db";
import { raiseGitProjectionFloor, setGitProjectionSeedRequired } from "./db";
import { allGatedRootsSeeded, gatedGitRoots } from "./gated-roots";
import { memoizedGitToplevel } from "./git-toplevel";
import {
  buildDiscoveryCandidates,
  buildGitSnapshot,
  type GitSnapshotPayload,
  readStatus,
  resolveGitToplevel,
} from "./git-worker";
import { warmGitAttribMemo } from "./reducer";

/**
 * Default wall-clock budget for the WHOLE boot-seed git scan. Generous enough to
 * cover a handful of repos with dirty-heavy trees on a slow disk, but bounded so
 * a wedged git can never brick boot. On exhaustion the seed stops issuing new
 * per-root scans, `seed_required` stays set, and the daemon serves.
 *
 * Raised 30s→60s (fn-921): the original 30s exhausted at 0/10 roots because the
 * cold attribution memo paid an O(history) scan inside the first root's fold AND
 * stale `/Volumes/Scratch/*` roots each burned the 2s toplevel-resolve timeout.
 * With the cold scan pre-warmed once (`warmGitAttribMemo`) and missing roots
 * pruned before resolve (`discoverSeedRoots`'s `pathExists`), the per-root cost
 * is bounded; the wider budget is headroom for a genuinely dirty-heavy real repo
 * set, and the per-root bulkhead (fn-905) already protects correctness when it
 * is exceeded (one unseeded root darks only itself, the rest serve).
 */
export const DEFAULT_GIT_SEED_BUDGET_MS = 60_000;

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
  /**
   * Probe whether a candidate root path exists on disk. Defaults to
   * `fs.existsSync`. Used by {@link discoverSeedRoots} to PRUNE missing/stale
   * roots (e.g. an unmounted `/Volumes/Scratch/*`) BEFORE the per-candidate
   * `resolveGitToplevel` git spawn — a missing root would otherwise burn the full
   * 2s toplevel-resolve timeout for nothing, and 10 such roots drag the whole
   * boot-seed. A producer-side fs read (never inside a fold). Injectable so a
   * unit test drives the prune decision without touching the real filesystem.
   */
  pathExists?: (path: string) => boolean;
  /**
   * The per-root snapshot builder — the ONLY git-touching step. Defaults to the
   * real producer path (`readStatus` → `buildGitSnapshot`, both shelling out to
   * `git`). Returns `null` for a root that is not a git repo / whose time-bound
   * read failed (the row stays whatever it was; a later boot retries). Injectable
   * so tests drive the seed's fold/floor/reset/seed_required logic with synthetic
   * `GitSnapshotPayload`s — NEVER a real git invocation (the no-real-git tier).
   */
  buildSnapshotForRoot?: (root: string) => GitSnapshotPayload | null;
}

/**
 * The default {@link SeedGitProjectionOptions.buildSnapshotForRoot}: the real
 * producer path. `readStatus` is the time-bound `git status` probe (returns
 * `null` for a non-repo / timeout), `buildGitSnapshot` runs the batched
 * `hash-object` + per-file `lstat`. This is the seed's ONLY git boundary.
 */
function defaultBuildSnapshotForRoot(root: string): GitSnapshotPayload | null {
  const status = readStatus(root);
  if (status == null) return null;
  return buildGitSnapshot(root, status);
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
 * Enumerate the git roots to seed, scoped to PLAN-RELEVANT roots — NOT the full
 * historical `jobs.cwd` sweep. The set is the FAST-PATH candidate build
 * (`runFullSweep: false` → working + recently-updated jobs, plus every epic's
 * `project_dir`/`task.target_repo`) UNIONED with the GATED roots (open-epic
 * `project_dir` + each task's `target_repo`, including the close-row root). The
 * gated union is the load-bearing guarantee: the readiness gate (task 2)
 * consults `seed_required` per-root keyed on `effectiveRoot`, so the surface of
 * EVERY root a readiness row can reference must be established at boot — even a
 * clean, idle gated root with no recent job activity. Dropping the full sweep
 * sheds the stale `/private/tmp` / `/Volumes/Scratch` roots that darkened the
 * board for no plan reason.
 *
 * The git-worker's OWN watched-set call site shares `buildDiscoveryCandidates`
 * but is a DIFFERENT caller (it keeps its sweep cadence) — this scoping is
 * boot-seed-local.
 *
 * Failures resolve to "skip that candidate" (fail-safe). A gated root that
 * fails to resolve here is still covered by the producer-only self-heal: main's
 * above-floor fold clears `seed_required` once it acquires a row, and until then
 * the per-root gate forces only THAT root `unknown`.
 *
 * STALE-ROOT PRUNE (fn-921): a candidate whose path no longer EXISTS on disk
 * (e.g. an unmounted `/Volumes/Scratch/*` repo from a long-dead session) is
 * dropped BEFORE `resolveGitToplevel` — `git -C <missing> rev-parse` would
 * otherwise burn the full 2s toplevel-resolve timeout per such root, and a
 * handful of them is exactly what dragged the boot-seed to 0/10. The prune is a
 * cheap `existsSync` (`pathExists`), producer-side, never inside a fold. A
 * GATED-but-missing root self-heals the same way: it never seeds here, so main's
 * above-floor fold (or a later boot when the volume is back) clears it.
 */
export function discoverSeedRoots(
  db: Database,
  nowMs: number,
  pathExists: (path: string) => boolean = existsSync,
): string[] {
  const candidates = buildDiscoveryCandidates(db, {
    nowMs,
    runFullSweep: false,
    watched: new Set<string>(),
  });
  // Union in the gated roots so every root a readiness row can reference is
  // seeded, even one with no working/recent job (the fast path would miss it).
  for (const gated of gatedGitRoots(db)) candidates.add(gated);

  const roots = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    // Prune a missing/stale root BEFORE the 2s git toplevel-resolve. A path that
    // is gone (unmounted volume, deleted scratch repo) can never seed and only
    // burns the resolve timeout.
    let present: boolean;
    try {
      present = pathExists(candidate);
    } catch {
      // A probe failure (permissions, broken symlink) is treated as "missing" —
      // no worse than the resolve returning null, and never throws here.
      present = false;
    }
    if (!present) continue;
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
    $bash_mutation_kind: null,
    $bash_mutation_targets: null,
    $plan_files: null,
    $backend_exec_type: null,
    $backend_exec_session_id: null,
    $backend_exec_pane_id: null,
    $background_task_id: null,
    $mutation_path: null,
    $worktree: null,
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
  const buildSnapshotForRoot =
    options.buildSnapshotForRoot ?? defaultBuildSnapshotForRoot;
  const startedAt = now();

  // 1. Capture the floor FIRST (before any git scan), so events arriving during
  //    the scan (id > this) re-apply idempotently via the live fold.
  const floor = readMaxEventId(db);

  // 2. Mark mid-flight. A crash before the atomic finish leaves this set, so the
  //    next boot re-seeds.
  setGitProjectionSeedRequired(db, true);

  // 2b. Pre-warm the per-`Database` git-attribution memo ONCE, before the
  //     per-root fold loop. On a fresh boot connection the memo is cold, so the
  //     FIRST root's fold would otherwise pay the single `id > 0` full-history
  //     scan WHILE holding the reducer lock and racing the per-root time budget
  //     — the cold-fold cost that let one slow root starve the seed (0/10). This
  //     hoists that one-time scan out of the loop; it is a pure optimization (the
  //     memo is never a fold input), so re-fold determinism is untouched.
  warmGitAttribMemo(db);

  const roots =
    options.roots ?? discoverSeedRoots(db, Date.now(), options.pathExists);

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
      // Fold over the prior live row rather than deleting it first. The prior
      // `git_status.jobs` set drives the bounded dirty→clean counter fan-out.
      // Bind attribution to the inclusive event watermark captured immediately
      // BEFORE this root's Git read — the synthetic event id is publication
      // order, not proof that the read observed an intervening mutation.
      const attributionEventId = readMaxEventId(db);
      const snapshot = buildSnapshotForRoot(root);
      if (snapshot == null) {
        // Time-bound git read failed/timed out for this root — skip it (the row
        // it would have produced stays whatever it was; a later boot OR the live
        // git-worker's emit retries). LOG it (root + best-effort reason) so a
        // wedged/non-git root is not a silent gap — the prior behavior dropped
        // it with no trace, leaving an unexplained `seed_required`.
        complete = false;
        console.error(
          `[keeperd] git boot-seed skipped root=${root}: readStatus returned ` +
            `null (non-git dir, timed-out, or failed git read) — surface for ` +
            `this root left to the live git-worker's emit`,
        );
        continue;
      }
      insertSyntheticGitSnapshot(
        stmts,
        root,
        JSON.stringify({
          ...snapshot,
          attribution_event_id: attributionEventId,
        }),
      );
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
  //    historical replay must stay skipped. Clear `seed_required` once every
  //    GATED root (open-epic `project_dir` + task `target_repo`) has an
  //    above-floor `git_status` row — best-effort for stale, non-gated roots:
  //    a failed `/Volumes/Scratch` root must NOT keep the flag set and dark the
  //    whole board. A gated root the seed missed/failed is left to the
  //    producer-only self-heal (main's above-floor fold clears the flag once
  //    that root's live emit lands). `complete` (EVERY targeted root) still
  //    rides the return for observability, but the clear gates on the gated set.
  raiseGitProjectionFloor(db, floor);
  // fn-921: reconcile the gated read key with the toplevel write key — a
  // subdir/symlink `target_repo` whose `git_status` row is written under
  // resolveGitToplevel still clears here (memoized to one resolve per distinct
  // gated root). The reducer's self-clear passes NO resolver (it cannot shell out
  // to git); for the common `effectiveRoot === toplevel` case both agree.
  if (allGatedRootsSeeded(db, floor, memoizedGitToplevel())) {
    setGitProjectionSeedRequired(db, false);
  }

  return { floor, seededRoots, complete };
}
