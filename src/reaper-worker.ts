/**
 * tmux window-reaper worker. keeperd's window-reaper Bun Worker thread, one of
 * the producer / consumer fleet. A PURE EXTERNAL ACTUATOR: it opens its own
 * read-only connection, watches the `jobs` projection (level-triggered on
 * `PRAGMA data_version` via the shared `watchLoop` primitive PLUS a coarse
 * periodic tick), and on every cycle kills the tmux WINDOW of any keeper-created
 * tracked job whose work has STOPPED CLEANLY and sat idle past the grace.
 *
 * ONE rule, no arms. A job's window closes iff ALL hold:
 *  - keeper created its session (`backend_exec_birth_session_id` non-null — the
 *    IDENTITY test; a human window folds to a NULL birth and is never touched),
 *  - the backend is `tmux`,
 *  - the row is `stopped` or `ended` — NEVER `killed` (a crashed window stays
 *    open for forensics),
 *  - an idle grace has elapsed since the row last changed,
 *  - the operator opt-out (`disable_autoclose`, glob-aware) matches NEITHER the
 *    live nor the birth session,
 *  - the pane id (the kill target) is present,
 *  - the in-memory kill cooldown has lapsed.
 *
 * The autopilot session is reaped by this same rule (and gated by
 * `disable_autoclose` like any other) — there is no readiness verdict in the
 * reap path. Dropping the verdict gate means a cleanly-stopped-but-incomplete
 * plan worker is reaped, its slot frees, and autopilot re-dispatches (bounded by
 * its own re-dispatch cooldown). The daemon does NOT reap runaway raw OS
 * processes — a leaked `bun test` tree or busy-loop shell is a test/fixture bug
 * fixed at its source, not something the control daemon SIGKILLs on the host.
 *
 * It reads the `jobs` projection read-only and writes ONLY to tmux
 * (`kill-window`); it NEVER writes the DB and posts NOTHING to main beyond the
 * lifecycle close/error events the daemon already wires. The existing
 * exit-watcher → synthetic `Killed` mint (pid + start_time match) is the SOLE
 * truth of the row's death — the kill is fire-and-forget, never assumed to have
 * sufficed (a SIGHUP-absorbing process leaves the row stopped; the cooldown
 * bounds the retry churn and the existing backstops own the residual).
 *
 * The periodic tick is LOAD-BEARING, not telemetry: the grace elapsing writes
 * NOTHING to the DB, so no `data_version` pulse fires when a candidate merely
 * ages past the bar — time itself must wake the cycle. Both feeders call the
 * same single-flight `driveCycle`.
 *
 * Each cycle:
 *  1. A light read of the `jobs` projection (no readiness verdict, no reconcile
 *     snapshot — the clean-stop + idle grace are the whole gate).
 *  2. {@link selectReapCandidates} — the FULL predicate, every clause, at
 *     unix-SECONDS now.
 *  3. Per candidate, skip if inside the in-memory kill cooldown.
 *  4. Immediately before each kill, re-read fresh and require the SAME job to
 *     still pass the full predicate — a resumed worker that flipped
 *     `stopped → working` aborts the kill (the CWE-367 TOCTOU mitigation).
 *  5. `backend.killWindow(paneId)`; stamp the cooldown; one stderr audit line
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
import { openDb } from "./db";
import { createTmuxPaneOps, type TmuxPaneOps } from "./exec-backend";
import { resolveDisableAutoclose } from "./pair-command";
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
   * {@link DEFAULT_REAP_TICK_MS}. The tick is LOAD-BEARING (the grace elapsing
   * writes nothing, so a pulse never fires on aging alone).
   */
  tickMs?: number;
  /**
   * Operator opt-out: a list of keeper-managed session tokens (exact names or
   * globs like `panels:*`) whose stopped tracked windows the reaper leaves OPEN.
   * Compiled once at worker boot into a `(session) => boolean` matcher tested
   * against BOTH the live and birth session. Threaded from
   * `resolveConfig().disableAutoclose`. Default empty (every keeper session
   * autocloses, INCLUDING `autopilot`).
   */
  disableAutoclose?: string[];
  /**
   * The idle grace (unix SECONDS) a row must sit `stopped`/`ended` past before
   * its window reaps. Threaded from `resolveConfig().autocloseGraceSeconds`
   * (default {@link DEFAULT_AUTOCLOSE_GRACE_SEC}). Frozen for the worker's
   * lifetime — a config change takes effect on the next daemon bounce.
   */
  autocloseGraceSeconds?: number;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Fallback idle grace (unix SECONDS) when `autocloseGraceSeconds` is unset.
 * Mirrors `db.ts`'s `DEFAULT_AUTOCLOSE_GRACE_SECONDS`; kept local so the pure
 * predicate carries a default without importing the config module.
 */
export const DEFAULT_AUTOCLOSE_GRACE_SEC = 3;

/**
 * In-memory kill cooldown (unix SECONDS). After an attempt, the same job is
 * suppressed for this long so a SIGHUP-absorbing process or an already-gone
 * window doesn't re-spawn tmux every cycle. In-memory ONLY — a restart
 * re-derives and re-kills once (idempotent no-op against a closed window).
 */
export const REAP_KILL_COOLDOWN_SEC = 10 * 60;

/** Default periodic-tick cadence (ms). ~1s — matches the tight grace so an
 *  aged candidate is reaped within a tick of crossing it. The cycle is a few
 *  read-only queries over a small projection, so the 1s idle cadence is cheap. */
export const DEFAULT_REAP_TICK_MS = 1000;

/**
 * One reap the decision emits: the job whose window to kill and the pane id
 * that targets it (the stable `%N` handle, rename-proof — a concurrent renamer
 * can't redirect it). `session` rides along for the audit line — the keeper
 * birth-session identity that drove the reap.
 */
export interface ReapCandidate {
  job_id: string;
  pane_id: string;
  /** The keeper birth-session whose window is being reaped (audit fragment). */
  session: string;
}

/**
 * The single unified reap predicate over a `jobs` snapshot at a fixed `now`
 * (unix seconds), honoring the in-memory cooldown. Pure — tests drive it with no
 * DB and a plain `(session) => boolean` matcher. Returns candidates in ascending
 * `job_id` order for a deterministic fire order and stable assertions.
 *
 * A row's window reaps iff ALL hold:
 *  - `backend_exec_birth_session_id` is non-null — the IDENTITY test: keeper
 *    created the session. Keyed on the FROZEN birth-session, NOT
 *    `COALESCE(live, birth)`: a human window carries a live session name but a
 *    NULL birth, so keying on the live name would mis-reap it.
 *  - `backend_exec_type === 'tmux'`.
 *  - `state ∈ {stopped, ended}` — a clean stop. `killed` (a crash) stays open.
 *  - `now - updated_at > graceSec`.
 *  - the `disableAutoclose` matcher matches NEITHER the live nor the birth
 *    session (the operator opt-out, glob-aware).
 *  - `backend_exec_pane_id` is non-null (the kill target).
 *  - not inside the in-memory kill cooldown.
 *
 * `cooldown` (job_id → last-attempt unix-seconds) suppresses a candidate while
 * `now - lastAttempt < REAP_KILL_COOLDOWN_SEC`.
 */
export function selectReapCandidates(
  jobs: Iterable<Job>,
  now: number,
  cooldown: Map<string, number>,
  disableAutoclose: (session: string) => boolean,
  graceSec: number = DEFAULT_AUTOCLOSE_GRACE_SEC,
): ReapCandidate[] {
  const out: ReapCandidate[] = [];
  for (const job of jobs) {
    // IDENTITY: keeper created this session. The frozen birth-session is stamped
    // (via `KEEPER_TMUX_SESSION`) ONLY on keeper's own launches; a human window
    // folds to a NULL birth and is never reaped. Keyed on birth (NOT the live
    // session) precisely because a human window carries a live name but NULL birth.
    const birth = job.backend_exec_birth_session_id;
    if (birth == null || birth === "") {
      continue;
    }
    if (job.backend_exec_type !== "tmux") {
      continue;
    }
    // Clean stop only — `killed` (a crash) stays open for forensics.
    if (job.state !== "stopped" && job.state !== "ended") {
      continue;
    }
    if (now - job.updated_at <= graceSec) {
      continue;
    }
    // Operator opt-out, tested against BOTH the live and the birth session: a
    // human debugging a keeper session lists its name (or a glob) and the window
    // stays open. The live session may be NULL until TmuxTopologySnapshot
    // resolves the pane, so the birth test is the floor.
    const live = job.backend_exec_session_id;
    if (
      disableAutoclose(birth) ||
      (live != null && live !== "" && disableAutoclose(live))
    ) {
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    if (paneId == null || paneId === "") {
      continue;
    }
    // In-memory cooldown: a recent attempt suppresses this job (a
    // SIGHUP-absorbing process or already-gone window must not re-spawn tmux
    // every cycle).
    const last = cooldown.get(job.job_id);
    if (last !== undefined && now - last < REAP_KILL_COOLDOWN_SEC) {
      continue;
    }
    out.push({ job_id: job.job_id, pane_id: paneId, session: birth });
  }
  out.sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0));
  return out;
}

/**
 * A reap-candidate selector at a fixed `now` (unix seconds) honoring the
 * cooldown map — the production light-read bound to a connection, OR a fake in
 * tests. Injected into {@link reaperCycle} so the re-check / cooldown / audit
 * logic is drivable without a fully-folded DB.
 */
export type ReapSelector = (
  now: number,
  cooldown: Map<string, number>,
) => ReapCandidate[];

/**
 * Drive one reaper cycle. Calls `select` for the candidate set, and for EACH
 * candidate re-runs `select` against a FRESH read immediately before the kill —
 * requiring the SAME job to still pass the full predicate. A resume that flipped
 * `stopped → working` (or any other clause miss) between selection and now
 * aborts that kill (the CWE-367 TOCTOU mitigation). Stamps the cooldown on every
 * attempt and emits one stderr audit line per attempt. NEVER throws for an
 * expected degradation: a `killWindow` failure is a logged non-fatal skip.
 *
 * Exported for unit reach: tests drive this directly with an injected selector +
 * fake backend and a controllable `now`.
 */
export async function reaperCycle(
  select: ReapSelector,
  backend: Pick<TmuxPaneOps, "killWindow">,
  cooldown: Map<string, number>,
  now: () => number,
): Promise<void> {
  const candidates = select(now(), cooldown);
  for (const candidate of candidates) {
    // Re-run the full predicate against a FRESH read immediately before the kill
    // and require the SAME job to still pass. A resume that flipped the state
    // between selection and now aborts the kill.
    const recheckNow = now();
    const fresh = select(recheckNow, cooldown);
    const stillReapable = fresh.some(
      (c) => c.job_id === candidate.job_id && c.pane_id === candidate.pane_id,
    );
    if (!stillReapable) {
      console.error(
        `[reaper-worker] reap aborted job=${candidate.job_id} session=${candidate.session} outcome=recheck-miss`,
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
      `[reaper-worker] reap job=${candidate.job_id} session=${candidate.session} pane=${candidate.pane_id} outcome=${outcome}`,
    );
  }
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
  // Session-agnostic pane-ops seam: only killWindow is used. Direct tmux seam.
  // Warnings route to stderr.
  const backend = createTmuxPaneOps({
    noteLine: (line: string): void => {
      console.error(`[reaper-worker] ${line}`);
    },
  });
  // job_id → last kill-attempt unix-seconds. In-memory only.
  const cooldown = new Map<string, number>();
  const now = (): number => Math.floor(Date.now() / 1000);
  // The operator opt-out matcher, compiled ONCE at boot from
  // `resolveConfig().disableAutoclose` (frozen for the worker's lifetime — a
  // config change takes effect on the next daemon bounce). Glob-aware,
  // fail-open: an empty/garbage list matches nothing and never throws at call
  // time (a throw here would crash the worker).
  const disableAutoclose = resolveDisableAutoclose(data.disableAutoclose ?? []);
  const graceSec =
    typeof data.autocloseGraceSeconds === "number"
      ? data.autocloseGraceSeconds
      : DEFAULT_AUTOCLOSE_GRACE_SEC;

  // The light jobs read — no reconcile snapshot, no readiness verdict. The hard
  // clauses (keeper-created tmux, cleanly stopped, pane present) pre-filter in
  // SQL; the pure predicate is authoritative and re-checks them plus the grace /
  // opt-out / cooldown at a fixed `now`. Prepared once; `.all()` re-executes
  // against the latest committed snapshot on every cycle and pre-kill re-check.
  const jobsQuery = db.query(
    `SELECT job_id, state, updated_at, backend_exec_type,
            backend_exec_session_id, backend_exec_birth_session_id,
            backend_exec_pane_id
       FROM jobs
      WHERE backend_exec_birth_session_id IS NOT NULL
        AND backend_exec_type = 'tmux'
        AND state IN ('stopped', 'ended')
        AND backend_exec_pane_id IS NOT NULL`,
  );
  const select: ReapSelector = (n, cd) => {
    let jobs: Job[];
    try {
      jobs = jobsQuery.all() as Job[];
    } catch (err) {
      console.error("[reaper-worker] jobs read failed (non-fatal):", err);
      return [];
    }
    return selectReapCandidates(jobs, n, cd, disableAutoclose, graceSec);
  };

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
  // one trailing re-run. The WHOLE cycle is wrapped so a read throw never wedges
  // the loop (no self-heal — log and let the next wake re-drive).
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

  // The LOAD-BEARING periodic tick: the grace elapsing writes nothing to the DB,
  // so no data_version pulse fires on aging alone — time itself must wake the
  // cycle. Cleared on shutdown.
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
