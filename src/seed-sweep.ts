/**
 * Boot-time seed sweep — fold dead/recycled jobs to `killed` BEFORE the daemon
 * goes live. After downtime (machine reboot, hook crash, SIGKILL of the parent
 * claude, terminal-pane closure) the `jobs` projection can carry rows whose
 * lifecycle still reads `working` or `stopped` while the underlying process is
 * long gone. Without this sweep those rows live forever — there is no hook
 * event to fold them through.
 *
 * The sweep runs ONCE per boot, between `migrate → drainToCompletion` and
 * worker spawn:
 *
 *   migrate(db)
 *   drainToCompletion(db)
 *   seedKilledSweep(db)
 *   drainToCompletion(db)   // fold the just-emitted Killed events
 *   // …spawn workers
 *
 * The pre-sweep `drainToCompletion` is mandatory: it brings the `jobs`
 * projection up to the latest persisted lifecycle BEFORE we query it for
 * candidate rows. A SessionEnd that arrived mid-boot would otherwise be
 * invisible to the sweep (we'd consider the row a zombie and re-emit Killed
 * for an already-ended session). The post-sweep drain folds the synthetic
 * Killed events the sweep just inserted.
 *
 * Q7 rules (encoded below):
 * - pid DEAD → emit Killed regardless of stored start_time (proven gone).
 * - pid ALIVE, stored start_time present, OS start_time differs → emit Killed
 *   (pid was recycled into a different process — the original is gone).
 * - pid ALIVE, stored start_time present, OS start_time matches → leave alone
 *   (still the same process).
 * - pid ALIVE, stored start_time NULL → leave
 *   alone (we cannot prove recycle without the (pid, start_time) two-field
 *   identity, and a bare pid match is unsafe on macOS where the pid space is
 *   small).
 * - pid NULL: the row has NO process to probe and is unwatchable (the
 *   exit-watcher can never arm a NULL-pid row). Invariant: such a row is
 *   terminal BY CONSTRUCTION (unwatchable, unprovable-alive); excluding it
 *   from the candidate set strands the session in `stopped` forever, so we
 *   emit a PIDLESS Killed (`{pid:null}`) to reap it. The reducer's Killed fold
 *   honors a pidless reap ONLY against a row whose persisted pid is ALSO NULL,
 *   so this can never knock out a watchable row. NULL-pid origin: a
 *   SessionStart whose pid binding landed NULL (events-log ingester
 *   schema-skew degrade, a dead-letter replay that dropped the pid, or a row
 *   with no pid captured) — unavoidable from the projection side, hence the
 *   reaper is the fallback.
 *
 * Determinism + safety invariants:
 * - **Producer-only liveness probing.** This module IS the producer (the boot
 *   half of it; the live exit-watcher worker covers steady state). The
 *   reducer never re-probes liveness — a probe inside the fold would break
 *   re-fold determinism (a from-scratch re-fold would see different pid
 *   states than the original run). The Killed event payload carries enough
 *   to fold deterministically: `(pid, start_time)` matched against the
 *   persisted (jobs.pid, jobs.start_time).
 * - **Idempotent across re-runs.** Emitting Killed for an already-killed row
 *   is a safe no-op in the reducer (the terminal-state guard skips it). We
 *   filter the candidate query to `state IN ('working','stopped')` so a
 *   second sweep over the same boot table doesn't even insert the event,
 *   keeping the event log tight.
 * - **Per-row failure isolation.** Each candidate row's probe is wrapped in
 *   try/catch; one bad row (ps glitch, /proc race, unreadable stat) logs to
 *   stderr and the sweep continues. A throw escaping the loop would prevent
 *   `drainToCompletion` from running on the events we already emitted —
 *   wedging the daemon on a single bad pid is worse than missing one row.
 * - **Bounded work.** Sweep cost scales with the count of non-ended rows
 *   carrying a pid, not total jobs. Each probe is one `kill(pid, 0)` syscall
 *   plus (when the pid is alive) one platform-specific start_time read.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { classifyCloseKind, type KillReason } from "./exec-backend";
import { parseLinuxStarttime, splitArgsLstart } from "./proc-starttime";
import { isPidAlive } from "./server-worker";

/**
 * Re-read a live pid's start_time in the SAME platform-tagged opaque shape the
 * SessionStart hook produces (`darwin:<lstart-text>` / `linux:<jiffies>`).
 * Reused from `src/proc-starttime.ts`'s parsers (the SAME dep-free module the
 * hook itself imports) so the format is guaranteed identical to what gets
 * persisted — the recycle test is a verbatim string compare against the
 * stored `jobs.start_time`.
 *
 * Returns `null` on any failure (ps timeout, missing pid in /proc, unknown
 * platform, parse failure). A null result short-circuits the recycle test as
 * "we can't tell" — the per-row caller skips it.
 *
 * Darwin: `ps -p <pid> -o lstart=,args=` (column order MATTERS — see
 * `splitArgsLstart`'s rationale; `args=` must trail so `-ww` un-truncates it).
 * The args column we ignore — we just need lstart, which is fixed-width 24.
 *
 * Linux: `/proc/<pid>/stat` field 22 (`starttime`). Sync read: at boot the
 * sweep runs synchronously inside `runDaemon` before workers spawn, and the
 * exit-watcher's periodic re-probe also calls it on a slow (~60s) tick where a
 * 500ms-capped sync `ps` is cheaper than an async fork to manage. Exported so
 * that re-probe (the steady-state sibling of this boot sweep) reuses the SAME
 * platform-tagged format — the recycle compare stays a verbatim string match.
 */
export function readOsStartTime(pid: number): string | null {
  try {
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["ps", "-ww", "-p", String(pid), "-o", "lstart=,args="],
        { timeout: 500 },
      );
      if (!result.success || result.exitCode !== 0) {
        return null;
      }
      const out = result.stdout?.toString() ?? "";
      const split = splitArgsLstart(out);
      if (!split) {
        return null;
      }
      return `darwin:${split.lstart}`;
    }
    if (process.platform === "linux") {
      // Sync read via `readFileSync` — `Bun.file().text()` is async and the
      // sweep is synchronous. The /proc/<pid>/stat file is in-kernel
      // (filesystem-cheap, no fork).
      const statText = readFileSync(`/proc/${pid}/stat`, "utf8");
      const raw = parseLinuxStarttime(statText);
      return raw !== null ? `linux:${raw}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Insert a synthetic `Killed` event for one candidate session, mirroring the
 * shape main uses for `TranscriptTitle` / `EpicSnapshot` (named bindings,
 * everything other than the lifecycle-bearing fields NULL). The payload blob
 * carries the `(pid, start_time, close_kind, reason)` payload the reducer's
 * Killed fold reads — `(pid, start_time)` for the recycle-safe match,
 * `close_kind` for the crash-restore discriminator, `reason` for WHY keeper
 * reaped (which boot arm minted it); both string fields fold on as opaque
 * copies. All ride the JSON blob, so the `events` column list is unchanged.
 *
 * Why inline SQL here instead of the prepared `stmts.insertEvent`: `db` is the
 * only handle we have at sweep time, and the prepared statement bundle isn't
 * threaded through. The column list matches CREATE_EVENTS verbatim; a future
 * column add MUST update this site (kept tight by the named-bindings comment
 * on `stmts.insertEvent`).
 */
function insertKilledEvent(
  db: Database,
  sessionId: string,
  pid: number | null,
  startTime: string | null,
  closeKind: string | null,
  reason: KillReason,
): void {
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Date.now() / 1000, // unix seconds as REAL, matching the hook
      sessionId,
      // pid column stays NULL for synthetic events (matching TranscriptTitle /
      // EpicSnapshot inserts in daemon.ts); the proven-dead pid rides in the
      // payload blob, which is where the reducer's `extractKilledPayload`
      // reads it from.
      null,
      "Killed",
      "killed", // synthetic event_type tag
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify({
        pid,
        start_time: startTime,
        close_kind: closeKind,
        reason,
      }),
      null,
      null,
      null,
    ],
  );
}

/**
 * Boot seed sweep — emit synthetic `Killed` events for every `jobs` row whose
 * underlying process is proven dead or recycled per the Q7 rules documented
 * in the module header.
 *
 * Caller contract:
 * - Run AFTER the pre-sweep `drainToCompletion`, so the candidate query sees
 *   the latest persisted lifecycle (any SessionEnd already folded). Re-running
 *   this without the prior drain risks emitting Killed for a row whose
 *   SessionEnd is still un-folded — harmless (the row is already ended once
 *   the drain runs and the Killed fold's terminal guard short-circuits) but
 *   wasteful.
 * - Run BEFORE the post-sweep `drainToCompletion`, so the synthetic events
 *   this inserts get folded before the workers come up. Workers running
 *   against a half-folded sweep would see a brief window of "still alive"
 *   rows that immediately flip to killed, racing the first patches.
 *
 * Never throws. A per-row probe failure logs to stderr and continues; an
 * insert failure (write contention against the writer lock) also logs and
 * continues — the next boot will re-probe the row anyway.
 */
export interface SeedKilledSweepDeps {
  isPidAlive?: (pid: number) => boolean;
  readOsStartTime?: (pid: number) => string | null;
  classifyCloseKind?: (paneId: string | null) => string | null;
}

export function seedKilledSweep(
  db: Database,
  deps: SeedKilledSweepDeps = {},
): void {
  const probeAlive = deps.isPidAlive ?? isPidAlive;
  const probeStartTime = deps.readOsStartTime ?? readOsStartTime;
  const closeKindFor = deps.classifyCloseKind ?? classifyCloseKind;
  // Candidate set: every non-terminal lifecycle row (Q7 scope), INCLUDING
  // NULL-pid rows (no `pid IS NOT NULL` filter). Invariant: a NULL-pid row is
  // unwatchable and unprobeable; excluding it strands the session in `stopped`
  // forever. We pull it in and reap it via a pidless Killed (the
  // `row.pid == null` branch below).
  const rows = db
    .query(
      `SELECT job_id, pid, start_time, backend_exec_pane_id FROM jobs
         WHERE state IN ('working', 'stopped')`,
    )
    .all() as {
    job_id: string;
    pid: number | null;
    start_time: string | null;
    backend_exec_pane_id: string | null;
  }[];

  for (const row of rows) {
    try {
      // Classify WHY this row is dying via a main-side tmux liveness probe (the
      // boot half of the two-producer contract; main's exit-watcher handler is
      // the steady-state half, sharing the SAME `classifyCloseKind` so both
      // stamp identically). Done once per candidate, BEFORE the Q7 dead/recycle
      // arms — the kind is orthogonal to which arm emits the Killed.
      const closeKind = closeKindFor(row.backend_exec_pane_id);
      if (row.pid == null) {
        // NULL-pid non-terminal row. Nothing to probe — it can never be
        // watched and we can never prove it alive, so it's terminal by
        // construction. Emit a pidless Killed; the reducer's pidless-reap arm
        // folds it to 'killed' (guarded to NULL-pid rows only, so a watchable
        // row is never touched).
        insertKilledEvent(
          db,
          row.job_id,
          null,
          row.start_time,
          closeKind,
          "boot_unwatchable",
        );
        continue;
      }
      const alive = probeAlive(row.pid);
      if (!alive) {
        // Q7 dead-pid rule: emit Killed regardless of stored start_time. The
        // payload carries the stored start_time so the reducer's match rule
        // (strict when persisted, loose-on-pid when NULL) folds correctly
        // either way.
        insertKilledEvent(
          db,
          row.job_id,
          row.pid,
          row.start_time,
          closeKind,
          "boot_pid_dead",
        );
        continue;
      }
      if (row.start_time == null) {
        // Q7 legacy rule: pid alive + no stored start_time → cannot prove
        // recycle. Leave alone.
        continue;
      }
      const osStart = probeStartTime(row.pid);
      if (osStart == null) {
        // Probe failed (ps timeout, /proc race, unknown platform). We can't
        // distinguish recycled from same-process — be conservative and leave
        // alone. The next boot will retry.
        continue;
      }
      if (osStart === row.start_time) {
        // Same process, still alive. Leave alone.
        continue;
      }
      // pid alive but start_time differs → pid was recycled into a different
      // process; the original session is gone. Payload carries the STORED
      // start_time so the reducer matches the persisted row (not the live
      // recycler's start_time).
      insertKilledEvent(
        db,
        row.job_id,
        row.pid,
        row.start_time,
        closeKind,
        "boot_pid_recycled",
      );
    } catch (err) {
      // Per-row isolation: one bad probe never aborts the sweep.
      console.error(
        `[keeperd] seed sweep failed for job_id=${row.job_id} pid=${row.pid}: ${err}`,
      );
    }
  }
}
