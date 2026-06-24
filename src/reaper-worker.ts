/**
 * tmux window-reaper worker (epic fn-802). keeperd's twelfth Bun Worker
 * thread, joining the producer / consumer fleet. A PURE EXTERNAL ACTUATOR:
 * it opens its own read-only connection, watches the `jobs`/`epics`
 * projections (level-triggered on `PRAGMA data_version` via the shared
 * `watchLoop` primitive PLUS a coarse periodic tick), and on every cycle
 * kills the tmux WINDOW of any autopilot-dispatched job whose work is
 * VERIFIABLY complete — stopped past {@link REAP_STOPPED_AGE_SEC} with a
 * `{tag:"completed"}` readiness verdict.
 *
 * It reads the projections read-only and writes ONLY to tmux (`kill-window`);
 * it NEVER writes the DB and posts NOTHING to main beyond the lifecycle
 * close/error events the daemon already wires. The existing exit-watcher →
 * synthetic `Killed` mint (pid + start_time match) is the SOLE truth of the
 * row's death — the kill is fire-and-forget, never assumed to have sufficed
 * (a SIGHUP-absorbing process leaves the row stopped; the cooldown bounds the
 * retry churn and the existing backstops own the residual).
 *
 * The periodic tick is LOAD-BEARING, not telemetry: the age threshold
 * elapsing writes NOTHING to the DB, so no `data_version` pulse fires when a
 * candidate merely ages past the bar — time itself must wake the cycle. Both
 * feeders call the same single-flight `driveCycle`.
 *
 * Each cycle:
 *  1. `loadReconcileSnapshot(db)` — the same snapshot autopilot reconciles
 *     against (includes the merged recently-done epics read that makes
 *     close-row `completed` verdicts observable).
 *  2. `computeReadiness(...)` at unix-SECONDS now (never ms).
 *  3. {@link selectReapCandidates} — the FULL predicate, every clause.
 *  4. Per candidate, skip if inside the in-memory kill cooldown.
 *  5. Immediately before each kill, re-run steps 1-3 fresh and require the
 *     SAME job to pass the full predicate again — a resume that flipped the
 *     verdict aborts the kill (the CWE-367 TOCTOU mitigation).
 *  6. `backend.killWindow(paneId)`; stamp the cooldown; one stderr audit line
 *     per attempt. Failures are non-fatal skips.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import is inert.
 *  - Own read-only `openDb` connection (`prepareStmts:false`, `bootRetry:true`).
 *  - Typed message protocol: `{type:"shutdown"}` main→worker ONLY; NO
 *    worker→main message. Exit 0 clean / 1 crash.
 *  - Subsystem-style teardown: the read-only DB connection is closed and the
 *    periodic interval cleared in the shutdown path before `process.exit(0)`.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { loadReconcileSnapshot } from "./autopilot-worker";
import { openDb } from "./db";
import {
  createTmuxPaneOps,
  MANAGED_AUTOCLOSE_SESSIONS,
  MANAGED_EXEC_SESSION,
  type TmuxPaneOps,
} from "./exec-backend";
import { computeReadiness, type ReadinessSnapshot } from "./readiness";
import type { runQuery } from "./server-worker";
import type { Job } from "./types";
import { watchLoop } from "./wake-worker";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only the DB
 * path crosses the boundary — the read-only connection is opened on the
 * worker thread, not handed across (handles are thread-affine).
 */
export interface ReaperWorkerData {
  dbPath: string;
  /**
   * Poll cadence in ms for the underlying `data_version` watch. Optional;
   * defaults to {@link watchLoop}'s default. Threaded through workerData for
   * parity with the other consumer workers.
   */
  pollMs?: number;
  /**
   * Coarse periodic-tick cadence in ms. Optional; defaults to
   * {@link DEFAULT_REAP_TICK_MS}. The tick is LOAD-BEARING (the age threshold
   * elapsing writes nothing, so a pulse never fires on aging alone).
   */
  tickMs?: number;
  /**
   * Operator opt-out: keeper-managed session names whose stopped tracked windows
   * the managed-session arm leaves OPEN. Threaded from `resolveConfig().
   * disableAutoclose` at the single populate site. Default empty (every managed
   * session autocloses). NEVER includes {@link MANAGED_EXEC_SESSION} — the
   * autopilot session rides the verdict-gated arm.
   */
  disableAutoclose?: string[];
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * The completed-and-stopped age threshold (unix SECONDS). A row must have been
 * `stopped` for longer than this before it's reapable. Deliberately tight —
 * the done-AND-idle `{tag:"completed"}` verdict and the immediate pre-kill
 * re-check carry the safety; this bar only debounces the stop-instant
 * `data_version` pulse so a window never dies the same instant its row lands.
 */
export const REAP_STOPPED_AGE_SEC = 1;

/**
 * Idle grace (unix SECONDS) for the managed-session arm. Longer than
 * {@link REAP_STOPPED_AGE_SEC} because that arm carries NO readiness verdict —
 * the allow-list + this grace are its whole safety margin. The CLI captures the
 * partner's answer SYNCHRONOUSLY (`wait-for-stop`/`show-last-message`) the
 * instant the Stop lands, so the window is dead weight once stopped; this grace
 * only keeps a just-stopped window alive long enough that a human glancing at it
 * (or a slow capture read) isn't racing the reaper.
 */
export const REAP_MANAGED_SESSION_IDLE_SEC = 30;

/**
 * In-memory kill cooldown (unix SECONDS). After an attempt, the same job is
 * suppressed for this long so a SIGHUP-absorbing process or an already-gone
 * window doesn't re-spawn tmux every cycle. In-memory ONLY — a restart
 * re-derives and re-kills once (idempotent no-op against a closed window).
 */
export const REAP_KILL_COOLDOWN_SEC = 10 * 60;

/** Default periodic-tick cadence (ms). ~1s — matches the tight age bar so an
 *  aged candidate is reaped within a tick of crossing it (done window dies in
 *  ~1-2s). The cycle is a few read-only queries over small projections, so the
 *  1s idle cadence is cheap. */
export const DEFAULT_REAP_TICK_MS = 1000;

/**
 * One reap the decision emits: the job whose window to kill and the pane id
 * that targets it (the stable `%N` handle, rename-proof — a concurrent
 * renamer can't redirect it). The remaining fields ride along for the audit
 * line. The autopilot verdict arm sets `verb`/`plan_ref` (its discriminators);
 * the managed-session arm sets `session` instead (its jobs carry NULL
 * `plan_verb`/`plan_ref`). The two arms are disjoint, so exactly one shape fires
 * per job.
 */
export interface ReapCandidate {
  job_id: string;
  pane_id: string;
  /** Autopilot arm: the `plan_verb`. NULL for a managed-session candidate. */
  verb: string | null;
  /** Autopilot arm: the `plan_ref`. NULL for a managed-session candidate. */
  plan_ref: string | null;
  /**
   * Managed-session arm: the resolved birth/live session name driving the kill.
   * NULL for an autopilot candidate (its session is always
   * {@link MANAGED_EXEC_SESSION}).
   */
  session?: string | null;
}

/**
 * The FULL reap predicate over a snapshot + readiness pass at a fixed `now`
 * (unix seconds), honoring the in-memory cooldown map. Pure — tests drive it
 * with no DB and a fake `killWindow`. Returns candidates in ascending
 * `job_id` order for a deterministic fire order and stable assertions.
 *
 * A row is a candidate iff ALL hold:
 *  - `backend_exec_session_id === MANAGED_EXEC_SESSION` (autopilot's session;
 *    a human-created session is never touched),
 *  - `plan_verb ∈ {work, close}` with a non-null `plan_ref` (approve rows are
 *    excluded by the verb filter even though they get `perTask` verdicts),
 *  - `state === 'stopped'` AND `now - updated_at > REAP_STOPPED_AGE_SEC`,
 *  - non-null `backend_exec_pane_id` AND non-null `pid` (a NULL-pid row is
 *    degenerate bookkeeping the exit-watcher's pidless path terminalizes;
 *    killing on its evidence is risk without payoff),
 *  - the verdict looked up BY VERB is `{tag:"completed"}`: work →
 *    `perTask[plan_ref]`, close → `perCloseRow[plan_ref]`. NEVER "try both
 *    maps" — the verb filter is what excludes the approve rows that also carry
 *    a `perTask` verdict.
 *
 * `cooldown` (job_id → last-attempt unix-seconds) suppresses a candidate while
 * `now - lastAttempt < REAP_KILL_COOLDOWN_SEC`.
 */
export function selectReapCandidates(
  jobs: Iterable<Job>,
  readiness: ReadinessSnapshot,
  now: number,
  cooldown: Map<string, number>,
): ReapCandidate[] {
  const out: ReapCandidate[] = [];
  for (const job of jobs) {
    if (job.backend_exec_session_id !== MANAGED_EXEC_SESSION) {
      continue;
    }
    const verb = job.plan_verb;
    if (verb !== "work" && verb !== "close") {
      continue;
    }
    const planRef = job.plan_ref;
    if (planRef == null || planRef === "") {
      continue;
    }
    if (job.state !== "stopped") {
      continue;
    }
    if (now - job.updated_at <= REAP_STOPPED_AGE_SEC) {
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    if (paneId == null || paneId === "") {
      continue;
    }
    if (job.pid == null) {
      continue;
    }
    // Verdict looked up BY VERB — never both maps. Task ids and epic ids never
    // collide (`fn-N-slug.M` vs `fn-N-slug`), but the verb filter is what keeps
    // an approve row (which also gets a perTask verdict) out of the reap set.
    const verdict =
      verb === "work"
        ? readiness.perTask.get(planRef)
        : readiness.perCloseRow.get(planRef);
    if (verdict?.tag !== "completed") {
      continue;
    }
    // In-memory cooldown: a recent attempt suppresses this job (a
    // SIGHUP-absorbing process or already-gone window must not re-spawn tmux
    // every cycle). A close job whose epic aged out of the merged-done window
    // reads no verdict above and is simply never reaped — accepted aging bound.
    const last = cooldown.get(job.job_id);
    if (last !== undefined && now - last < REAP_KILL_COOLDOWN_SEC) {
      continue;
    }
    out.push({ job_id: job.job_id, pane_id: paneId, verb, plan_ref: planRef });
  }
  out.sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0));
  return out;
}

/**
 * The managed-session reap arm (epic fn-920) — the SECOND, verdict-free arm.
 * Autocloses any stopped tracked NON-plan job launched into a keeper-managed
 * session (`pair`/`panels`/`agentbus`) past the idle grace. It reads ONLY the
 * `jobs` projection + an idle clock — NO readiness verdict (these jobs carry no
 * `plan_ref`, so there is no verdict to look up; the Stop hook landing `state =
 * 'stopped'` is the authoritative done signal). Pure: tests drive it with no DB.
 *
 * A row is a candidate iff ALL hold:
 *  - `plan_verb IS NULL` — a tracked NON-plan job (a pair/panel/agentbus
 *    partner). A plan-verb job is the autopilot arm's domain.
 *  - `(backend_exec_session_id ?? backend_exec_birth_session_id)` ∈
 *    {@link MANAGED_AUTOCLOSE_SESSIONS} — the COALESCE onto the FROZEN
 *    birth-session matters: a fresh pair job reads a NULL live session until the
 *    first `TmuxTopologySnapshot` resolves it, and the birth-session
 *    (`KEEPER_TMUX_SESSION` at spawn) is stamped ONLY on keeper's own launches.
 *    This allow-list — NOT `plan_verb IS NULL` alone — is what keeps the arm off
 *    a human's hand-started claude window (which also folds to NULL `plan_verb`).
 *  - that resolved session is NOT in `disableAutoclose` — the operator opt-out.
 *  - `state === 'stopped'` AND `now - updated_at > REAP_MANAGED_SESSION_IDLE_SEC`.
 *  - non-null `backend_exec_pane_id` AND non-null `pid` (same degeneracy guard as
 *    the autopilot arm).
 *  - not inside the shared in-memory kill cooldown.
 *
 * The autopilot session ({@link MANAGED_EXEC_SESSION}) is DELIBERATELY absent
 * from {@link MANAGED_AUTOCLOSE_SESSIONS}, so the two arms never overlap and no
 * job is double-handled. Returns candidates in ascending `job_id` order.
 */
export function selectManagedSessionReapCandidates(
  jobs: Iterable<Job>,
  now: number,
  cooldown: Map<string, number>,
  disableAutoclose: ReadonlySet<string>,
  idleSec: number = REAP_MANAGED_SESSION_IDLE_SEC,
): ReapCandidate[] {
  const out: ReapCandidate[] = [];
  for (const job of jobs) {
    // NON-plan jobs only — a plan-verb job belongs to the autopilot arm.
    if (job.plan_verb != null && job.plan_verb !== "") {
      continue;
    }
    // COALESCE the LIVE session onto the FROZEN birth-session: a fresh pair job
    // reads a NULL live session until TmuxTopologySnapshot resolves the pane.
    const session =
      job.backend_exec_session_id ?? job.backend_exec_birth_session_id;
    if (session == null || !MANAGED_AUTOCLOSE_SESSIONS.has(session)) {
      continue;
    }
    // The operator opt-out: a managed session a human is debugging stays open.
    if (disableAutoclose.has(session)) {
      continue;
    }
    if (job.state !== "stopped") {
      continue;
    }
    if (now - job.updated_at <= idleSec) {
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    if (paneId == null || paneId === "") {
      continue;
    }
    if (job.pid == null) {
      continue;
    }
    const last = cooldown.get(job.job_id);
    if (last !== undefined && now - last < REAP_KILL_COOLDOWN_SEC) {
      continue;
    }
    out.push({
      job_id: job.job_id,
      pane_id: paneId,
      verb: null,
      plan_ref: null,
      session,
    });
  }
  out.sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0));
  return out;
}

/**
 * Load a fresh snapshot, run readiness at `now` (unix seconds), and select the
 * reap candidates from BOTH arms (autopilot verdict + managed-session idle). The
 * single composed read the cycle and the immediate pre-kill re-check both call,
 * so the re-check sees the SAME pipeline (and thus a flipped verdict / resumed
 * partner provably aborts the kill). `now` is injected so the pre-kill re-check
 * uses the current instant. Config (`disableAutoclose`, idle grace) is bound at
 * the call site; the readiness pass is computed ONCE and reused for the
 * autopilot arm only (the managed-session arm reads no verdict).
 */
async function selectFromDb(
  db: Parameters<typeof runQuery>[0],
  now: number,
  cooldown: Map<string, number>,
  disableAutoclose: ReadonlySet<string>,
): Promise<ReapCandidate[]> {
  const snapshot = await loadReconcileSnapshot(db);
  const readiness = computeReadiness(
    snapshot.epics,
    snapshot.jobs,
    snapshot.subagentInvocations,
    snapshot.gitStatusByProjectDir,
    now,
    snapshot.pendingDispatches,
  );
  // Two disjoint arms over the SAME jobs snapshot — autopilot verdict-gated
  // (plan-verb jobs in the autopilot session) + managed-session idle-gated
  // (NON-plan jobs in pair/panels/agentbus). The allow-list excludes the
  // autopilot session, so no job appears in both lists.
  return [
    ...selectReapCandidates(snapshot.jobs.values(), readiness, now, cooldown),
    ...selectManagedSessionReapCandidates(
      snapshot.jobs.values(),
      now,
      cooldown,
      disableAutoclose,
    ),
  ];
}

/**
 * A reap-candidate selector at a fixed `now` (unix seconds) honoring the
 * cooldown map — {@link selectFromDb} bound to a connection, OR a fake in
 * tests. Injected into {@link reaperCycle} so the re-check / cooldown / audit
 * logic is drivable without a fully-folded DB.
 */
export type ReapSelector = (
  now: number,
  cooldown: Map<string, number>,
) => Promise<ReapCandidate[]>;

/**
 * Drive one reaper cycle. Calls `select` for the candidate set, and for EACH
 * candidate re-runs `select` against a FRESH snapshot immediately before the
 * kill — requiring the SAME job to still pass the full predicate (fresh verdict
 * included). A resume that flipped the verdict (or any other clause miss)
 * between selection and now aborts that kill (the CWE-367 TOCTOU mitigation).
 * Stamps the cooldown on every attempt and emits one stderr audit line per
 * attempt. NEVER throws for an expected degradation: a `killWindow` failure is
 * a logged non-fatal skip.
 *
 * Exported for unit reach: tests drive this directly with an injected selector
 * + fake backend and a controllable `now`.
 */
export async function reaperCycle(
  select: ReapSelector,
  backend: Pick<TmuxPaneOps, "killWindow">,
  cooldown: Map<string, number>,
  now: () => number,
): Promise<void> {
  const candidates = await select(now(), cooldown);
  for (const candidate of candidates) {
    // Re-run the full predicate against a FRESH snapshot immediately before the
    // kill and require the SAME job to still pass (fresh verdict included). A
    // resume that flipped the verdict between selection and now aborts the kill.
    const recheckNow = now();
    const fresh = await select(recheckNow, cooldown);
    const stillReapable = fresh.some(
      (c) => c.job_id === candidate.job_id && c.pane_id === candidate.pane_id,
    );
    // The arm-specific discriminators for the audit line: the autopilot arm
    // carries verb/ref, the managed-session arm carries session.
    const desc = describeCandidate(candidate);
    if (!stillReapable) {
      console.error(
        `[reaper-worker] reap aborted job=${candidate.job_id} ${desc} outcome=recheck-miss`,
      );
      continue;
    }
    // Stamp the cooldown on EVERY attempt (before the fire) so a SIGHUP-absorbed
    // kill that left the row stopped doesn't re-spawn tmux next cycle.
    cooldown.set(candidate.job_id, recheckNow);
    const res = await backend.killWindow(candidate.pane_id);
    const outcome = res.ok ? "killed" : `skip:${res.error}`;
    // The one trace the reaper leaves: a single audit line per attempt. The
    // exit-watcher's Killed mint — not this line — is the truth of the death.
    console.error(
      `[reaper-worker] reap job=${candidate.job_id} ${desc} pane=${candidate.pane_id} outcome=${outcome}`,
    );
  }
}

/** The arm-specific audit fragment: `verb=…/ref=…` for an autopilot candidate,
 *  `session=…` for a managed-session candidate. */
function describeCandidate(c: ReapCandidate): string {
  return c.session != null
    ? `arm=managed-session session=${c.session}`
    : `arm=autopilot verb=${c.verb} ref=${c.plan_ref}`;
}

/**
 * Worker entrypoint. Opens its own read-only connection, wires the shutdown
 * message, and drives the reaper cycle from BOTH `data_version` pulses and a
 * coarse periodic tick through one single-flight entry until told to stop.
 */
function main(): void {
  if (!parentPort) {
    console.error("[reaper-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as ReaperWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[reaper-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  // Session-agnostic pane-ops seam: only killWindow is used. Direct tmux seam
  // (NOT routed through the removed exec-backend abstraction). Warnings route to
  // stderr.
  const backend = createTmuxPaneOps({
    noteLine: (line: string): void => {
      console.error(`[reaper-worker] ${line}`);
    },
  });
  // job_id → last kill-attempt unix-seconds. In-memory only.
  const cooldown = new Map<string, number>();
  const now = (): number => Math.floor(Date.now() / 1000);
  // The operator opt-out set, threaded from `resolveConfig().disableAutoclose`
  // at the daemon populate site. Frozen for the worker's lifetime — a config
  // change takes effect on the next daemon bounce, same as the other tunables.
  const disableAutoclose: ReadonlySet<string> = new Set(
    data.disableAutoclose ?? [],
  );
  // The production selector: the full pipeline bound to this read-only
  // connection. The cycle's pre-kill re-check re-runs it against a fresh read.
  const select: ReapSelector = (n, cd) =>
    selectFromDb(db, n, cd, disableAutoclose);
  let shutdown = false;

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown = true;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  // Single-flight cycle drive. Both feeders (data_version pulses + the periodic
  // tick) call this; a wake while a cycle runs sets `wakePending` and the
  // running cycle loops once more after it finishes — coalescing a burst into
  // one trailing re-run. The WHOLE cycle is wrapped so a snapshot or readiness
  // throw never wedges the loop (no self-heal — log and let the next wake
  // re-drive).
  let cycleRunning = false;
  let wakePending = false;
  const driveCycle = async (): Promise<void> => {
    if (cycleRunning) {
      wakePending = true;
      return;
    }
    cycleRunning = true;
    try {
      do {
        wakePending = false;
        if (shutdown) {
          return;
        }
        await reaperCycle(select, backend, cooldown, now);
      } while (wakePending && !shutdown);
    } catch (err) {
      console.error(
        `[reaper-worker] reap cycle threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      cycleRunning = false;
    }
  };

  const drive = (): void => {
    void driveCycle();
  };

  // The LOAD-BEARING periodic tick: the age threshold elapsing writes nothing
  // to the DB, so no data_version pulse fires on aging alone — time itself must
  // wake the cycle. Cleared on shutdown.
  const tickMs = data.tickMs ?? DEFAULT_REAP_TICK_MS;
  const tick = setInterval(() => {
    if (shutdown) return;
    drive();
  }, tickMs);

  watchLoop(db, drive, () => shutdown, data.pollMs)
    .then(() => {
      clearInterval(tick);
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      clearInterval(tick);
      console.error("[reaper-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure decision fns / cycle) is inert.
if (!isMainThread) {
  main();
}
