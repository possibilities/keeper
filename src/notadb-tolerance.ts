/**
 * Shared reader-side tolerance for a transient `SQLITE_NOTADB` ("file is not
 * a database") on a read-only `PRAGMA data_version` poll tick (the filed
 * rider from the fn-1082.2 serve-wedge finding doc).
 *
 * The read-only workers (plan / exit-watcher / git / wake / server / …) each
 * open their own read-only connection and poll `PRAGMA data_version` in
 * autocommit to detect a commit by another connection (CLAUDE.md: no kernel
 * watchers on keeper's own DB). They spawn right after `migrate()` — before
 * the boot-drain's checkpoint completes — so a large boot-time WAL checkpoint
 * can transiently rewrite keeper.db's page 1 while a poller reads it. Every
 * reader connection sees the SAME transient `SQLITE_NOTADB` at once: a
 * boot-checkpoint VIEW RACE (sqlite.org/wal.html), not corruption. Today it
 * propagates past the poll, crashes the worker, and — per the no-self-heal
 * invariant — `fatalExit`s the daemon; the LaunchAgent restart re-triggers
 * the same boot-time race, a crash loop.
 *
 * {@link NotadbTolerance.poll} wraps one poll-tick read: a tolerated
 * transient error skips the tick (the caller re-attempts on the NEXT tick —
 * no ad-hoc per-site catch); every SUCCESSFUL read resets the consecutive-
 * miss count to 0. A BOUNDED run of consecutive misses ({@link
 * NOTADB_TOLERANCE_LIMIT}) RETHROWS so genuine persistent corruption still
 * reaches the existing crash-to-restart path — tolerance must never become
 * an infinite silent skip. Any error outside the tolerated set rethrows
 * immediately, untouched (kept tight to the confirmed boot-race code; never
 * widen without a matching observed clustering the way NOTADB was filed).
 *
 * Dep-free: no `bun:sqlite` import (classifies by the thrown error's `.code`
 * string, so it works against any reader, real or scripted), no node IO, no
 * clock — pure and directly unit-testable with an injected throwing reader.
 */

/** Bounded run of consecutive tolerated misses before rethrowing. */
export const NOTADB_TOLERANCE_LIMIT = 20;

/**
 * The sqlite error codes this helper tolerates as transient. Scoped tight
 * per the epic's flagged risk ("keep the tolerated set to NOTADB … any other
 * SqliteError still throws immediately") — only the confirmed boot-checkpoint
 * race code. No `SQLITE_BUSY` clustering was observed at these read-only
 * autocommit poll sites, so it is deliberately NOT included here.
 */
const TOLERATED_CODES: ReadonlySet<string> = new Set(["SQLITE_NOTADB"]);

/** `true` iff `err` carries a `.code` string in the tolerated set. */
export function isTolerableNotadbError(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string" &&
    TOLERATED_CODES.has((err as { code: string }).code)
  );
}

/** One {@link NotadbTolerance.poll} outcome — a real value, or a tolerated skip. */
export type NotadbPollOutcome<T> =
  | { skipped: false; value: T }
  | { skipped: true; code: string; consecutiveMisses: number };

/**
 * Per-poll-site consecutive-miss state. Construct ONE instance per poller
 * (each of plan-worker / exit-watcher / git-worker / wake-worker /
 * server-worker owns its own) and thread it through every tick via
 * {@link poll} — state must persist across ticks for the bounded-rethrow
 * count to mean anything.
 */
export class NotadbTolerance {
  private consecutiveMisses = 0;

  constructor(private readonly limit: number = NOTADB_TOLERANCE_LIMIT) {}

  /**
   * Run `read()` for one poll tick.
   *
   * - Success: resets the consecutive-miss count to 0, returns `{skipped:
   *   false, value}`.
   * - A tolerated transient error within the bound: increments the count,
   *   returns `{skipped: true, ...}` — the CALLER's job is to skip this tick
   *   (return / continue without advancing its own change-gate baseline) so
   *   the same read is effectively re-attempted next interval.
   * - A tolerated error that pushes the count PAST `limit`: RETHROWS — a run
   *   this long is no longer a transient boot race, and silently skipping
   *   forever would hide genuine persistent corruption from the existing
   *   crash-to-restart path.
   * - Any other error: rethrows immediately, count untouched.
   */
  poll<T>(read: () => T): NotadbPollOutcome<T> {
    let value: T;
    try {
      value = read();
    } catch (err) {
      if (!isTolerableNotadbError(err)) {
        throw err;
      }
      this.consecutiveMisses += 1;
      if (this.consecutiveMisses > this.limit) {
        throw err;
      }
      return {
        skipped: true,
        code: err.code,
        consecutiveMisses: this.consecutiveMisses,
      };
    }
    this.consecutiveMisses = 0;
    return { skipped: false, value };
  }
}
