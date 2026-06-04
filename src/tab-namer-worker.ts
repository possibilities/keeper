/**
 * Tab-namer worker (epic fn-680, reworked fn-699). keeperd's TWELFTH Bun
 * Worker thread, joining the producer / consumer fleet (`wake-worker`,
 * `server-worker`, `transcript-worker`, `plan-worker`, `exit-watcher`,
 * `git-worker`, `usage-worker`, `dead-letter-worker`, `autopilot-worker`,
 * `backend-worker`, `restore-worker`).
 *
 * On every tick the worker reads the live jobs that carry a resolved
 * `(backend_exec_session_id, backend_exec_tab_id)` pair AND a non-NULL
 * transcript-derived `title`, sanitizes the title for display safety, and —
 * UNCONDITIONALLY, whenever the sanitized name differs from the last-observed
 * `backend_exec_tab_name` — shells the focus-safe zellij
 * `action rename-tab-by-id <id> <name>` op via {@link ExecBackend.renameTab}.
 * End state: `keeper jobs` tabs converge from the cosmetic `verb::id` launch
 * label onto the human transcript title, and FOLLOW it across drift — a tab
 * that zellij resets to `Tab #N` on resume (or a tab-mate renames) is
 * re-asserted within one kick/poll cycle. There is NO permanent
 * "already-sent" suppression: convergence is idempotent and self-terminating
 * (the loop stops the moment `tab_name === sanitize(title)`).
 *
 * Reactive, mirroring `server-worker.ts` (fn-699). The renamer is driven the
 * same way the subscribe server is: main posts a `{type:"kick"}` after every
 * `drainToCompletion` (the fn-694 lever-B fast path), and a `data_version`
 * poll backstop (~2.5s, autocommit) catches any lost kick. The kick carries
 * no payload — every tick re-reads current `jobs` state and reconciles from
 * scratch (edge + level; never derive from the kick). This replaced the old
 * 5s `setInterval`: the zellij-events feed (fn-684) made drift reach keeper as
 * a real DB write (a `Tab #N` reset emits a feed line → reducer folds
 * `backend_exec_tab_name` → `data_version` bumps), so a quiescent DB has no
 * pending rename and a wall-clock sweep buys nothing.
 *
 * PURE SIDE-EFFECTOR. The worker:
 *  - opens its own READ-ONLY `openDb` connection (the producer-worker
 *    pattern — `backend-worker.ts` / `restore-worker.ts` — never shares
 *    main's writable connection).
 *  - NEVER writes the DB (no schema bump, no new column, no events row).
 *  - NEVER mints a synthetic event (no schema, no reducer arm, no
 *    `keeper/api.py` whitelist change).
 *  - NEVER posts to main (no `parentPort.postMessage` call, no message
 *    kind defined). It RECEIVES `{type:"shutdown"}` and `{type:"kick"}`
 *    from main; it sends nothing back.
 *
 * The rename is a cosmetic shell-out; no control path reads
 * `backend_exec_tab_name` (fn-678 made tab names purely cosmetic — reap is
 * tab-id-driven via `closeByTabId`, launch dedup is served by
 * `pending_dispatches`), so renaming every live tab — autopilot's
 * included — is safe.
 *
 * Convergence with the zellij-events feed. The fn-684 zellij-events worker
 * reads zellij's authoritative tab name back into `jobs.backend_exec_tab_name`
 * as feed lines fold. The two form a producer/observer loop:
 *
 *     transcript-worker    -> title    (writes via main, kicks the renamer)
 *     tab-namer-worker     -> renames  (read-only, shells zellij)
 *     zellij-events-worker -> tab_name (writes via main, observation)
 *
 * Clear-on-convergence memo. The `tab_name` compare alone is not a sufficient
 * suppressor — between a `renameTab` success and the feed reporting the new
 * name there is a post-write observe window in which a kick/poll re-reads the
 * OLD `tab_name`. A `memo` (keyed `SESSION::PANE_ID`, valued by the EXACT
 * sanitized name sent on the last `{ ok: true }` rename) suppresses the
 * re-issue in that window. It is NOT a permanent debounce: the entry is
 * DELETED the moment a tick observes `tab_name === sanitized` (convergence
 * observed), so a later drift away from the title re-fires the rename. A
 * failed rename does NOT write the memo, so the next cycle retries. (Even a
 * memo miss is harmless: a redundant rename to the same value is idempotent.)
 *
 * Multiple jobs per tab. The schema doesn't enforce one-job-per-tab; in the
 * happy path the autopilot mints one tab per agent so the invariant holds,
 * but a misconfigured cell could violate it. To prevent two titles from
 * fighting over one tab (oscillation), the tick dedups by
 * `(session, tab_id)` deterministically — the job with the lowest `job_id`
 * wins each tick. This degrades a violation to "stable-arbitrary," not
 * "thrash." (`tab_id` is a positional zellij index, stable within one
 * snapshot, so the per-tick dedup is anti-tab-fight; the memo is keyed by the
 * stable `pane_id` so it survives a tab_id reshuffle.)
 *
 * Sanitization. `sanitizeTabName` strips control / ANSI / OSC bytes
 * (`\x00-\x1f` + `\x7f`) that would corrupt the zellij tab bar, collapses
 * internal whitespace, trims, and strips a leading `-` (so clap doesn't
 * parse the name as a flag). It does NOT cap length — zellij stores tab
 * names of any length verbatim and clips them at display time, so a
 * keeper-side cap would only drop the trailing task number (the fn-635
 * `…repo.5` bug). Argv-array spawn handles
 * injection — `Bun.spawn` is shell-free, so embedded `$()`, backticks,
 * `;`, quotes are literal positional bytes — so sanitization is purely
 * for DISPLAY safety, not for command-injection mitigation.
 *
 * Lifecycle. Modelled on `server-worker.ts` (fn-699):
 *  - A `pollLoop` reads a naked autocommit `PRAGMA data_version` every
 *    `pollMs` (default 2500, workerData-overridable for tests) and re-ticks
 *    only when the counter moves. The poll connection MUST stay autocommit —
 *    a surrounding `BEGIN` freezes `data_version` and the loop goes blind.
 *  - A `kick` message branch runs an immediate tick (the fast path); the poll
 *    is the lost-wakeup backstop. Both are wrapped so a throw never escapes
 *    (no-self-heal — an uncaught throw crashes the worker and bounces the
 *    daemon).
 *  - Per-tick `isRunning` re-entry guard + a `pendingKick` drain-then-arm
 *    flag: a kick arriving mid-tick sets the flag and the in-flight tick
 *    re-runs once on completion. Coalesces a burst of kicks into at most one
 *    trailing tick.
 *  - Immediate first tick on spawn so a freshly-restarted worker re-converges
 *    every live tab without waiting for a kick or the first poll interval.
 *  - Shutdown handler sets the `shuttingDown` flag (gates the `renameTab`
 *    call AFTER the read so a late shutdown suppresses the spawn), closes the
 *    DB, and `setImmediate(exit 0)`s after a yield so any in-flight tick can
 *    settle.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import { type ExecBackend, resolveExecBackend } from "./exec-backend";
import type { KickMessage } from "./server-worker";
import type { ShutdownMessage } from "./wake-worker";

/**
 * workerData payload — same shape as the other reader workers
 * (`ServerWorkerData`, `BackendWorkerData`): only the absolute DB path is
 * required; the worker opens its own read-only connection on the worker
 * thread. `pollMs` is optional (defaults to 2500) — the `data_version`
 * poll backstop cadence, exposed for tests that need a tight cadence
 * without sleeping.
 */
export interface TabNamerWorkerData {
  dbPath: string;
  pollMs?: number;
}

/**
 * Default `data_version` poll backstop cadence. The kick is the primary
 * fast path (main posts it after every drain); the poll only catches a
 * lost kick, so a slacker 2.5s cadence is fine — it never gates the common
 * case. Floored at {@link MIN_POLL_MS} so a too-tight test override can't
 * busy-spin.
 */
const DEFAULT_POLL_MS = 2_500;

/** Floor on the poll cadence so a tight workerData override can't busy-spin. */
const MIN_POLL_MS = 25;

/**
 * Strips control / ANSI / OSC bytes, collapses internal whitespace,
 * trims, and strips a leading `-` (clap-flag mitigation). Does NOT cap
 * length: zellij stores tab names of arbitrary length verbatim (verified
 * 0.44.3 — a 112-char `rename-tab-by-id` round-trips byte-identical), so
 * any keeper-side cap would only re-truncate the name BEFORE zellij sees
 * it — which is exactly how the fn-635 `…repo.5` lost its trailing task
 * number. We pass the full sanitized name through and leave display-time
 * clipping (a render concern bounded by terminal width) to zellij's tab
 * bar. Returns the empty string on input that sanitizes to nothing — the
 * caller skips the rename when the result is empty (zellij would render a
 * blank tab name, which is a worse signal than the cosmetic `verb::id`
 * default).
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
  // No length cap: zellij stores the full name and clips it at display
  // time by terminal width. A keeper-side cap can only LOSE information
  // (the fn-635 `…repo.5` truncation) without buying anything zellij's
  // own tab-bar rendering doesn't already do.
  return cleaned;
}

/** Row shape read from `jobs` on each tick. */
interface LiveJobRow {
  job_id: string;
  backend_exec_session_id: string;
  backend_exec_tab_id: string;
  backend_exec_pane_id: string | null;
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
 * `backend_exec_pane_id` is selected for the convergence memo key (the
 * stable per-pane identity that survives a `tab_id` reshuffle), but the
 * `backend_exec_tab_id IS NOT NULL` filter STAYS: the rename targets the
 * tab id, and pane vs. tab resolve on INDEPENDENT reducer arms
 * (`src/reducer.ts`), so a pane can be set while the tab is still NULL.
 * A row missing a tab id can't be renamed and is filtered here.
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
              backend_exec_pane_id, title, backend_exec_tab_name
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
 * UNCONDITIONAL `renameTab` call for each (session, tab) whose sanitized
 * title differs from the last-observed `backend_exec_tab_name`. There is no
 * `job_id`-keyed permanent suppression: convergence is idempotent and
 * self-terminating (the rename stops firing the moment the observed
 * `tab_name` equals the sanitized title), so a tab that drifts to the zellij
 * default after a resume re-converges within one tick.
 *
 * The `memo` (keyed `SESSION::PANE_ID`) is a NARROW post-write observe-window
 * suppressor, not a debounce: it holds the last name we sent on a `{ ok:true }`
 * rename, suppresses a re-issue while `tab_name` still shows the OLD value, and
 * is DELETED the moment a tick observes `tab_name === sanitized` (so a later
 * drift re-fires). It lives across ticks in the worker's `main` closure.
 *
 * Exported for tests: an injected `backend` (a `Pick<ExecBackend,
 * "renameTab">`) lets the test drive the dedup, convergence, and memo
 * behavior without spawning processes.
 */
export interface TickDeps {
  /** Read-only DB connection. */
  readonly db: import("bun:sqlite").Database;
  /** Backend injection point. Defaults to a fresh `resolveExecBackend`
   *  forwarding warnings to stderr. Tests inject a stub carrying just
   *  the `renameTab` slot the tick driver actually reads. */
  readonly backend?: Pick<ExecBackend, "renameTab">;
  /** Post-write observe-window memo — keyed `SESSION::PANE_ID`, valued by
   *  the EXACT sanitized name sent on the last `{ ok: true }` rename.
   *  Mutated in place (set on success, deleted on observed convergence,
   *  pruned of dead panes at the end of the tick). Lives across ticks in
   *  the worker's `main` closure. */
  readonly memo: Map<string, string>;
  /** Shutdown predicate — gates the rename call AFTER the read so a
   *  late shutdown suppresses the spawn. */
  readonly isShuttingDown: () => boolean;
}

/** Memo key — the stable per-pane identity. Survives a `tab_id` reshuffle
 *  (positional, can move) so the post-write suppression doesn't false-clear
 *  when zellij renumbers tabs. A row with a NULL pane id (pane not resolved
 *  yet) keys distinctly off the literal `null` slot — harmless, since the
 *  memo is only an observe-window optimization. */
function memoKey(row: LiveJobRow): string {
  return `${row.backend_exec_session_id}::${row.backend_exec_pane_id ?? "null"}`;
}

export async function runTick(deps: TickDeps): Promise<void> {
  const { db, memo, isShuttingDown } = deps;
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
  // to stable-arbitrary rather than oscillation. `tab_id` is the rename
  // target and is stable within one snapshot, so the per-tick dedup is
  // the anti-tab-fight guard. Sorting by `job_id` first then bucketing by
  // `(session, tab_id)` with "first wins" is the simplest realization.
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

  // Track which `SESSION::PANE_ID` keys the live set carries this tick, so
  // we can prune the memo of dead panes at the end. Bounds memory under a
  // never-ending stream of new sessions (each prior pane's key would stay
  // in the memo forever otherwise).
  const livePaneKeys = new Set<string>();
  for (const row of dedup.values()) {
    livePaneKeys.add(memoKey(row));
  }

  // Drive the renames in parallel across distinct (session, tab) —
  // zellij handles concurrent `rename-tab-by-id` against different
  // tabs cleanly, and the per-pane memo write happens only on the
  // resolved promise so there's no race within a pane. (Two jobs sharing
  // a tab won't both reach this loop — the dedup above keeps only the
  // lowest-job_id winner.)
  await Promise.all(
    [...dedup.values()].map(async (row) => {
      const sanitized = sanitizeTabName(row.title);
      if (sanitized.length === 0) {
        // Empty sanitized name → skip. Sending a blank label to
        // zellij would render worse than leaving the cosmetic
        // `verb::id` default, so we don't.
        return;
      }
      const key = memoKey(row);
      if (sanitized === row.backend_exec_tab_name) {
        // Convergence OBSERVED: the feed has reported the tab name back
        // and it matches the sanitized title. Clear any memo entry — this
        // is what lets a LATER drift away from the title re-fire the
        // rename (the headline fn-699 fix) — and skip the spawn.
        memo.delete(key);
        return;
      }
      if (memo.get(key) === sanitized) {
        // Post-write observe window: we already issued this exact sanitized
        // name and the feed hasn't reported it back yet (or zellij
        // normalized its stored copy so the `tab_name` round-trip
        // byte-mismatches). Suppress the redundant re-issue. (Even if this
        // slips through, a rename to the same value is idempotent.)
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
        // next tick retries (we don't write the memo).
        console.error(
          `[tab-namer-worker] renameTab threw for session=${row.backend_exec_session_id} tab=${row.backend_exec_tab_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      if (result.ok) {
        // Record the EXACT name we sent (not the title, not whatever
        // zellij chooses to store) so the next-tick compare against the
        // memo suppresses the redundant re-issue during the observe
        // window even if `backend_exec_tab_name` shows a normalized form.
        memo.set(key, sanitized);
      }
      // A failed rename (tab gone, session dead, zellij missing) does
      // NOT write the memo. The next tick will retry — a transient
      // failure self-heals when the tab/session comes back; a
      // permanent failure (the job ended) gets pruned below.
    }),
  );

  // Prune dead pane keys from the memo (panes that left the live set —
  // ended, killed, or had their session/pane cleared). Bounds memory
  // so the map doesn't grow unbounded across a long-running daemon.
  for (const key of [...memo.keys()]) {
    if (!livePaneKeys.has(key)) {
      memo.delete(key);
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
  const pollMs = Math.max(MIN_POLL_MS, data.pollMs ?? DEFAULT_POLL_MS);
  const memo = new Map<string, string>();
  let shuttingDown = false;
  let isRunning = false;
  // Drain-then-arm: a kick/poll arriving while a tick is in flight sets this
  // flag instead of stacking a parallel tick; the in-flight tick re-runs once
  // on completion if set. Coalesces a burst into at most one trailing tick.
  let pendingKick = false;

  const isShuttingDown = (): boolean => shuttingDown;

  // Run one reconcile tick. Re-entrancy-safe via `isRunning`; a concurrent
  // request sets `pendingKick` and the in-flight tick drains it on the way
  // out. Wrapped so a throw NEVER escapes (no-self-heal — an uncaught throw
  // would crash the worker and bounce the daemon).
  const tick = async (): Promise<void> => {
    if (shuttingDown) return;
    if (isRunning) {
      // A tick is already running; arm a trailing re-run instead of stacking.
      pendingKick = true;
      return;
    }
    isRunning = true;
    try {
      do {
        pendingKick = false;
        try {
          await runTick({ db, memo, isShuttingDown });
        } catch (err) {
          // `runTick` already catches per-rename throws; this catches anything
          // upstream (DB read failure on the live-jobs query, etc.). Log +
          // continue — the next kick/poll retries. NEVER throw out of here.
          console.error(
            `[tab-namer-worker] tick threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // Loop again if a kick landed mid-tick (drain-then-arm coalescing).
      } while (pendingKick && !shuttingDown);
    } finally {
      isRunning = false;
    }
  };

  // Realtime `data_version` poll backstop. Mirrors `server-worker.ts`'s
  // `pollLoop`: a naked autocommit `PRAGMA data_version` read, re-tick only on
  // a change. The kick is the primary fast path; this catches any lost kick.
  // CRITICAL: the poll connection stays autocommit — a surrounding `BEGIN`
  // freezes `data_version` for this connection and the loop goes blind.
  const pollLoop = async (): Promise<void> => {
    const query = db.query("PRAGMA data_version");
    let last = (query.get() as { data_version: number }).data_version;
    while (!shuttingDown) {
      await Bun.sleep(pollMs);
      if (shuttingDown) break;
      const cur = (query.get() as { data_version: number }).data_version;
      if (cur !== last) {
        last = cur;
        await tick();
      }
    }
  };

  // Run one immediate tick so a freshly-spawned worker re-converges every
  // live tab without waiting for a kick or the first poll interval
  // (cold-restart re-convergence).
  void tick();

  // Start the poll backstop. A crash in the loop is unrecoverable: no
  // self-heal, exit non-zero → LaunchAgent restart.
  pollLoop().catch((err) => {
    console.error("[tab-namer-worker] poll loop crashed:", err);
    process.exit(1);
  });

  port.on("message", (msg: ShutdownMessage | KickMessage | undefined) => {
    if (msg?.type === "kick") {
      // fn-699 fast path: main folded an event and kicked us so we run the
      // reconcile tick now instead of waiting for the next poll tick. The
      // try/catch lives inside `tick` — this handler must never throw
      // (no-self-heal path).
      void tick();
      return;
    }
    if (msg?.type !== "shutdown") return;
    shuttingDown = true;
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
