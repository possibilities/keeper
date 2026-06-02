/**
 * Tab-namer worker (epic fn-680 / task .2). keeperd's ELEVENTH Bun Worker
 * thread, joining the producer / consumer fleet (`wake-worker`,
 * `server-worker`, `transcript-worker`, `plan-worker`, `exit-watcher`,
 * `git-worker`, `usage-worker`, `dead-letter-worker`, `autopilot-worker`,
 * `backend-worker`, `restore-worker`).
 *
 * On every ~5s tick, the worker reads the live jobs that carry a resolved
 * `(backend_exec_session_id, backend_exec_tab_id)` pair AND a non-NULL
 * transcript-derived `title`, sanitizes the title for display safety, and
 * (when the sanitized name differs from the last-seen `backend_exec_tab_name`
 * AND from the value already issued in a prior tick) shells the focus-safe
 * zellij `action rename-tab-by-id <id> <name>` op via
 * {@link ExecBackend.renameTab}. End state: `keeper jobs` tabs converge from
 * the cosmetic `verb::id` launch label onto the human transcript title within
 * ~5s of the title becoming available.
 *
 * PURE SIDE-EFFECTOR. The worker:
 *  - opens its own READ-ONLY `openDb` connection (the producer-worker
 *    pattern — `backend-worker.ts` / `restore-worker.ts` — never shares
 *    main's writable connection).
 *  - NEVER writes the DB (no schema bump, no new column, no events row).
 *  - NEVER mints a synthetic event (no schema, no reducer arm, no
 *    `keeper/api.py` whitelist change).
 *  - NEVER posts to main (no `parentPort.postMessage` call, no message
 *    kind defined). It accepts only `{type:"shutdown"}` from main.
 *
 * The rename is a cosmetic shell-out; no control path reads
 * `backend_exec_tab_name` (fn-678 made tab names purely cosmetic — reap is
 * tab-id-driven via `closeByTabId`, launch dedup is served by
 * `pending_dispatches`), so renaming every live tab — autopilot's
 * included — is safe.
 *
 * Convergence with backend-worker. The fn-668 backend-worker reads zellij's
 * authoritative tab name back into `jobs.backend_exec_tab_name` on ITS own
 * ~5s tick. The two workers form a producer/observer loop:
 *
 *     transcript-worker  -> title    (writes via main, no rename trigger)
 *     tab-namer-worker   -> renames  (read-only, shells zellij)
 *     backend-worker     -> tab_name (writes via main, observation)
 *
 * The `tab_name` compare alone is NOT the durable debounce — zellij may
 * normalize/escape the stored copy so the round-trip byte-mismatches even
 * after a successful rename, which would oscillate spawns. The success-gated
 * `lastSet` map (keyed on `job_id`, valued by the EXACT sanitized name we
 * sent on the last `{ ok: true }` rename) is the durable suppression: a
 * second tick that produces the same sanitized name skips the spawn
 * regardless of what `backend_exec_tab_name` shows. A failed rename leaves
 * `lastSet` untouched so the next tick retries.
 *
 * Multiple jobs per tab. The schema doesn't enforce one-job-per-tab; in the
 * happy path the autopilot mints one tab per agent so the invariant holds,
 * but a misconfigured cell could violate it. To prevent two titles from
 * fighting over one tab (oscillation), the tick dedups by
 * `(session, tab_id)` deterministically — the job with the lowest `job_id`
 * wins each tick. This degrades a violation to "stable-arbitrary," not
 * "thrash."
 *
 * Sanitization. `sanitizeTabName` strips control / ANSI / OSC bytes
 * (`\x00-\x1f` + `\x7f`) that would corrupt the zellij tab bar, collapses
 * internal whitespace, trims, strips a leading `-` (so clap doesn't parse
 * the name as a flag), and caps to ~50 chars. Argv-array spawn handles
 * injection — `Bun.spawn` is shell-free, so embedded `$()`, backticks,
 * `;`, quotes are literal positional bytes — so sanitization is purely
 * for DISPLAY safety, not for command-injection mitigation.
 *
 * Lifecycle. Modelled on `backend-worker.ts`:
 *  - `setInterval` with a default 5s `tickMs` (workerData-overridable for
 *    tests that want a tight cadence). NOT the `watchLoop` /
 *    `PRAGMA data_version` model — the rename converges with the
 *    backend-worker's wall-clock 5s tick, so a clock-driven tick is the
 *    right primitive (a quiescent DB shouldn't block a rename that's
 *    waiting on the backend-worker's next refresh).
 *  - Per-tick `isRunning` re-entry guard: `setInterval` does NOT
 *    self-throttle, so a slow tick (a hung `renameTab` spawn) must not
 *    spawn a parallel tick on top of itself.
 *  - Immediate first tick so a freshly-spawned worker doesn't wait the
 *    full interval before its first sweep.
 *  - Shutdown handler clears the interval, sets the `shuttingDown` flag
 *    (gates the `renameTab` call AFTER the read so a late shutdown
 *    suppresses the spawn), closes the DB, and `setImmediate(exit 0)`s
 *    after a yield so any in-flight tick can settle.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import { type ExecBackend, resolveExecBackend } from "./exec-backend";
import type { ShutdownMessage } from "./wake-worker";

/**
 * workerData payload — same shape as the other producer workers
 * (`BackendWorkerData`, `GitWorkerData`): only the absolute DB path is
 * required; the worker opens its own read-only connection on the worker
 * thread. `tickMs` is optional (defaults to 5000) — exposed for tests
 * that need a tight cadence without sleeping.
 */
export interface TabNamerWorkerData {
  dbPath: string;
  tickMs?: number;
}

/**
 * Default tick cadence. 5s matches `backend-worker`'s read-back cadence
 * so the rename/observe loop converges in one tick when the title is
 * stable. Shorter would spam zellij; longer would stretch the visible
 * lag between transcript title and tab label.
 */
const DEFAULT_TICK_MS = 5_000;

/**
 * Maximum sanitized tab name length. Zellij tab labels render in a
 * fixed-width bar; ~50 chars is comfortable across typical terminal
 * widths and well under any zellij internal limit. Cap by Unicode code
 * point (`Array.from`), NOT by UTF-16 code unit, so a 50-char cap
 * doesn't split a surrogate pair in half mid-emoji.
 */
const MAX_TAB_NAME_LEN = 50;

/**
 * Strips control / ANSI / OSC bytes, collapses internal whitespace,
 * trims, strips a leading `-` (clap-flag mitigation), and caps to
 * {@link MAX_TAB_NAME_LEN} code points. Returns the empty string on
 * input that sanitizes to nothing — the caller skips the rename when
 * the result is empty (zellij would render a blank tab name, which is
 * a worse signal than the cosmetic `verb::id` default).
 *
 * Pure — no I/O, no env reads, deterministic. Exported for direct
 * test reach.
 */
export function sanitizeTabName(title: string): string {
  // Step 1: strip C0 control bytes (0x00-0x1f) and DEL (0x7f). This
  // catches embedded ANSI/OSC escape sequences (ESC = 0x1b), tab
  // (0x09), newline (0x0a), CR (0x0d), etc. — anything that would
  // corrupt the zellij tab bar's rendering. We use `String.fromCharCode`
  // in a RegExp constructor so the source literal contains no control
  // characters (biome's `noControlCharactersInRegex` lint).
  const controlRe = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
    "g",
  );
  let cleaned = title.replace(controlRe, " ");
  // Step 2: collapse runs of whitespace (incl. the spaces just minted
  // from stripped control bytes) into single spaces.
  cleaned = cleaned.replace(/\s+/g, " ");
  // Step 3: trim leading/trailing whitespace.
  cleaned = cleaned.trim();
  // Step 4: strip a leading `-` so clap doesn't parse the name as a
  // flag. Loop in case the title started with `--name` etc.
  while (cleaned.startsWith("-")) {
    cleaned = cleaned.slice(1).trimStart();
  }
  // Step 5: cap length by Unicode code point so we never split a
  // surrogate pair (e.g. an emoji at the 50th position).
  const codePoints = Array.from(cleaned);
  if (codePoints.length > MAX_TAB_NAME_LEN) {
    cleaned = codePoints.slice(0, MAX_TAB_NAME_LEN).join("");
  }
  return cleaned;
}

/** Row shape read from `jobs` on each tick. */
interface LiveJobRow {
  job_id: string;
  backend_exec_session_id: string;
  backend_exec_tab_id: string;
  title: string;
  backend_exec_tab_name: string | null;
}

/**
 * Read every live job carrying both a session id AND a resolved tab id
 * AND a non-NULL title. "Live" = `state NOT IN ('ended', 'killed')` —
 * the same resting-state predicate the rest of the projection uses to
 * decide whether a job's coordinates are still meaningful. An ended
 * job's tab is presumed reaped (or about to be), so renaming it would
 * be either a no-op or a race against the autopilot's close pass.
 *
 * Exported for test reach so the per-tick logic can be exercised
 * against a known fixture without spawning the worker.
 */
export function readLiveJobsForTabNaming(
  db: import("bun:sqlite").Database,
): LiveJobRow[] {
  return db
    .query(
      `SELECT job_id, backend_exec_session_id, backend_exec_tab_id,
              title, backend_exec_tab_name
         FROM jobs
        WHERE backend_exec_session_id IS NOT NULL
          AND backend_exec_tab_id IS NOT NULL
          AND title IS NOT NULL
          AND state NOT IN ('ended', 'killed')`,
    )
    .all() as LiveJobRow[];
}

/**
 * Per-tick driver. Pure w.r.t. the DB (read-only); side effect is the
 * `renameTab` call for each (session, tab) whose sanitized title
 * differs from the last-observed `backend_exec_tab_name` AND from the
 * value already issued in a prior tick (the `lastSet` debounce). The
 * `lastSet` map (keyed on `job_id`) lives across ticks in the worker's
 * `main` closure so a successful rename suppresses redundant spawns
 * until the title changes again.
 *
 * Exported for tests: an injected `backend` (a `Pick<ExecBackend,
 * "renameTab">`) lets the test drive the dedup, debounce, and skip
 * behavior without spawning processes.
 */
export interface TickDeps {
  /** Read-only DB connection. */
  readonly db: import("bun:sqlite").Database;
  /** Backend injection point. Defaults to a fresh `resolveExecBackend`
   *  forwarding warnings to stderr. Tests inject a stub carrying just
   *  the `renameTab` slot the tick driver actually reads. */
  readonly backend?: Pick<ExecBackend, "renameTab">;
  /** Success-gated debounce — keyed on `job_id`, valued by the EXACT
   *  sanitized name sent on the last `{ ok: true }` rename. Mutated
   *  in place (writes on success, prunes dead jobs at the end of the
   *  tick). Lives across ticks in the worker's `main` closure. */
  readonly lastSet: Map<string, string>;
  /** Shutdown predicate — gates the rename call AFTER the read so a
   *  late shutdown suppresses the spawn. */
  readonly isShuttingDown: () => boolean;
}

export async function runTick(deps: TickDeps): Promise<void> {
  const { db, lastSet, isShuttingDown } = deps;
  const backend =
    deps.backend ??
    resolveExecBackend({
      noteLine: (line: string) => {
        console.error(line);
      },
    });
  const rows = readLiveJobsForTabNaming(db);

  // Dedup by `(session, tab_id)`. If two jobs share the same tab (an
  // invariant violation — one tab should host one agent), pick the
  // lowest `job_id` deterministically so the cell's behavior degrades
  // to stable-arbitrary rather than oscillation. Sorting by `job_id`
  // first then bucketing by `(session, tab_id)` with "first wins" is
  // the simplest realization.
  const sorted = [...rows].sort((a, b) =>
    a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0,
  );
  const dedup = new Map<string, LiveJobRow>();
  for (const row of sorted) {
    const key = `${row.backend_exec_session_id} ${row.backend_exec_tab_id}`;
    if (!dedup.has(key)) {
      dedup.set(key, row);
    }
  }

  // Track which job_ids the live set carries this tick, so we can
  // prune `lastSet` of dead jobs at the end. Bounds memory under a
  // never-ending stream of new sessions (each prior agent's id stays
  // in `lastSet` forever otherwise).
  const liveJobIds = new Set<string>();
  for (const row of dedup.values()) {
    liveJobIds.add(row.job_id);
  }

  // Drive the renames in parallel across distinct (session, tab) —
  // zellij handles concurrent `rename-tab-by-id` against different
  // tabs cleanly, and the per-(job, name) `lastSet` write happens
  // only on the resolved promise so there's no race within a job.
  // (Two jobs sharing a tab won't both reach this loop — the dedup
  // above keeps only the lowest-job_id winner.)
  await Promise.all(
    [...dedup.values()].map(async (row) => {
      const sanitized = sanitizeTabName(row.title);
      if (sanitized.length === 0) {
        // Empty sanitized name → skip. Sending a blank label to
        // zellij would render worse than leaving the cosmetic
        // `verb::id` default, so we don't.
        return;
      }
      if (sanitized === row.backend_exec_tab_name) {
        // Already correct (covers the cold-restart case where
        // backend-worker has folded the name back into the DB and
        // our `lastSet` is empty after a worker restart). Skip the
        // spawn.
        return;
      }
      if (lastSet.get(row.job_id) === sanitized) {
        // In-flight debounce: we already issued this exact sanitized
        // name on a prior tick. Zellij may normalize/escape its
        // stored copy so the `backend_exec_tab_name` round-trip
        // byte-mismatches even after the rename landed; without this
        // gate we'd spawn every 5s forever. Skip.
        return;
      }
      if (isShuttingDown()) {
        // Shutdown raced the await on this tick — skip the spawn.
        // We're tearing down; let the next worker boot resume.
        return;
      }
      let result: Awaited<ReturnType<ExecBackend["renameTab"]>>;
      try {
        result = await backend.renameTab(
          row.backend_exec_session_id,
          row.backend_exec_tab_id,
          sanitized,
        );
      } catch (err) {
        // `renameTab` is designed to never throw — but defense-in-
        // depth here keeps a rogue throw (a future code path that
        // surfaces an error, an injected backend in a test) from
        // wedging the tick's `Promise.all` walk. Log + skip; the
        // next tick retries (we don't write `lastSet`).
        console.error(
          `[tab-namer-worker] renameTab threw for session=${row.backend_exec_session_id} tab=${row.backend_exec_tab_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      if (result.ok) {
        // Success-gated debounce: record the EXACT name we sent (not
        // the title, not whatever zellij chooses to store) so the
        // next-tick compare against `lastSet` lands even if
        // `backend_exec_tab_name` shows a normalized form.
        lastSet.set(row.job_id, sanitized);
      }
      // A failed rename (tab gone, session dead, zellij missing) does
      // NOT write `lastSet`. The next tick will retry — a transient
      // failure self-heals when the tab/session comes back; a
      // permanent failure (the job ended) gets pruned below.
    }),
  );

  // Prune dead job_ids from `lastSet` (jobs that left the live set —
  // ended, killed, or had their session/tab cleared). Bounds memory
  // so the map doesn't grow unbounded across a long-running daemon.
  for (const jobId of [...lastSet.keys()]) {
    if (!liveJobIds.has(jobId)) {
      lastSet.delete(jobId);
    }
  }
}

function main(): void {
  if (parentPort == null) {
    console.error("[tab-namer-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as TabNamerWorkerData | undefined;
  if (data == null || typeof data.dbPath !== "string") {
    console.error("[tab-namer-worker] missing dbPath in workerData");
    process.exit(1);
  }
  const port = parentPort;

  const { db } = openDb(data.dbPath, { readonly: true });
  const tickMs = data.tickMs ?? DEFAULT_TICK_MS;
  const lastSet = new Map<string, string>();
  let shuttingDown = false;
  let isRunning = false;

  const isShuttingDown = (): boolean => shuttingDown;

  const tick = async (): Promise<void> => {
    if (isRunning) return; // Per-tick guard — `setInterval` does NOT self-throttle.
    if (shuttingDown) return;
    isRunning = true;
    try {
      await runTick({
        db,
        lastSet,
        isShuttingDown,
      });
    } catch (err) {
      // `runTick` already catches per-rename throws; this catches anything
      // upstream (DB read failure on the live-jobs query, etc.). Log +
      // continue — the next tick will retry. NEVER throw out of here,
      // or the interval callback rejects and the event loop logs a stderr
      // trace but the interval keeps firing — we want the explicit log
      // line instead.
      console.error(
        `[tab-namer-worker] tick threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      isRunning = false;
    }
  };

  const tickTimer = setInterval(() => {
    void tick();
  }, tickMs);

  // Run one immediate tick so a freshly-spawned worker doesn't wait
  // the full interval before sweeping the first batch.
  void tick();

  port.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg?.type !== "shutdown") return;
    shuttingDown = true;
    clearInterval(tickTimer);
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
    // Give any in-flight tick promise a beat to settle before exit.
    // The `shuttingDown` flag suppresses any late `renameTab()` call.
    setImmediate(() => {
      process.exit(0);
    });
  });
}

// Mirrors every other producer worker: a plain `import` from a test runs
// on the main thread, where `main()` must NOT fire — the pure `runTick`,
// `readLiveJobsForTabNaming`, and `sanitizeTabName` symbols are
// exercised directly by the test suite.
if (!isMainThread) {
  main();
}
