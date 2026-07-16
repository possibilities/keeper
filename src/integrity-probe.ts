/**
 * Periodic SQLite integrity probe (fn-746.1).
 *
 * On 2026-06-07 (~02:07) keeperd logged `SQLiteError: database disk image is
 * malformed` followed by a native `Segmentation fault`. The DB was intact again
 * after the launchd restart, but nothing PROACTIVELY detected the corruption —
 * it only surfaced because a query happened to hit a bad page. This module adds
 * a low-overhead periodic probe that pages the operator the moment corruption is
 * structurally detectable, so a future malformed image is a CAUGHT, recoverable
 * event rather than a silent catastrophe.
 *
 * ## Corruption surfaces as a THROW, not just a non-`ok` row
 *
 * On the real ~2 GB DB, bun:sqlite does not always return a clean non-`ok`
 * result row for a malformed image — it RAISES `SQLITE_CORRUPT` /
 * "database disk image is malformed" while STEPPING the `quick_check` itself
 * (the exact throw the 2026-06-07 incident query hit). So the probe treats a
 * corruption-classified throw ({@link isCorruptionThrow}) as a POSITIVE
 * corruption signal that pages, and only a BENIGN throw (file vanished mid-open
 * during a restart, a transient RO open failure) as a non-fatal retry.
 *
 * ## Why `quick_check`, read-only, low cadence
 *
 * - `PRAGMA quick_check` over the full `PRAGMA integrity_check`: quick_check
 *   skips the (expensive) UNIQUE/foreign-key/index-vs-table cross-validation and
 *   only verifies B-tree structural integrity. On a ~2 GB DB that is the
 *   difference between a bounded structural sweep and a multi-minute full scan;
 *   it still catches the "disk image is malformed" class (torn pages, corrupt
 *   B-tree nodes) this probe exists for.
 * - A DEDICATED, SHORT-LIVED read-only connection (opened and closed per probe):
 *   the worker contract is "own connection, read-only for readers". A read-only
 *   open never takes the writer lock, so the probe can NEVER starve the daemon's
 *   sole writer or a concurrent hook INSERT. We do not reuse main's writable
 *   connection (that would couple a long structural scan to the writer) and we
 *   do not hold a long-lived RO handle (closing it bounds WAL-frame pinning).
 * - Low cadence (default 15 min, {@link INTEGRITY_PROBE_INTERVAL_MS}): corruption
 *   is rare and a structural sweep is not free even when bounded; a slack cadence
 *   keeps steady-state overhead negligible while still catching corruption within
 *   one interval — orders of magnitude faster than "whenever a query happens to
 *   hit it" (the 2026-06-07 failure mode).
 *
 * ## Producer-side, never in a fold
 *
 * This is a PRODUCER-side health check. It runs on the daemon's heartbeat timer,
 * NEVER inside a fold and NEVER inside the reducer's `BEGIN IMMEDIATE`
 * cursor-advance transaction. It reads no projection, writes nothing to the DB,
 * mints no synthetic event, and touches no reducer state — so re-fold
 * determinism, the cursor+projection single-transaction, and the sole-writer
 * rules are all untouched. Its only side effect is an out-of-band page
 * (botctl Telegram, the "Keeper" topic — the same sink the sitter dead-man
 * uses). Mirrors the never-throw posture of the compaction / checkpoint timers:
 * a probe hiccup (file gone mid-open, transient lock) logs and the next
 * heartbeat retries; it never wedges the daemon.
 */

import { Database } from "bun:sqlite";

/**
 * Probe cadence (ms). 15 min is slack enough that the bounded structural sweep
 * is steady-state negligible, yet tight enough that corruption is detected
 * within minutes rather than "whenever a query happens to hit a bad page" (the
 * 2026-06-07 failure mode). Slacker than the 30s WAL checkpoint and 5min
 * compaction heartbeats by design — corruption is rare and the sweep is not
 * latency-sensitive.
 */
export const INTEGRITY_PROBE_INTERVAL_MS = 900_000;

/** The Telegram topic every keeper page routes to (matches the sitter). */
export const KEEPER_TOPIC = "Keeper";

/**
 * The single string `PRAGMA quick_check` returns on a healthy DB. SQLite
 * returns exactly one row with the value `ok`; any other value (or multiple
 * rows) is a structural-integrity failure with the offending pages described.
 */
export const QUICK_CHECK_OK = "ok";

/** The decision a single probe produces — pure, fully determined by its input. */
export interface IntegrityProbeDecision {
  /** True iff `quick_check` returned exactly the single `ok` row. */
  healthy: boolean;
  /**
   * The page message when unhealthy; `null` when healthy. Carries the raw
   * quick_check rows (capped) so the operator sees the offending pages without
   * having to re-run the probe by hand.
   */
  pageMessage: string | null;
}

/**
 * Classify an error THROWN by `quick_check`. On a ~2 GB live DB the
 * 2026-06-07 failure mode was not a clean non-`ok` result row — bun:sqlite
 * raises `SQLITE_CORRUPT` / "database disk image is malformed" while STEPPING
 * the very `quick_check` (the same throw the original incident query hit). So a
 * corruption throw is a POSITIVE signal that MUST page; only a benign throw
 * (file vanished mid-open during a restart, a transient RO open failure) is a
 * non-fatal retry. We classify on the SQLite error code (`SQLITE_CORRUPT`) and
 * the message text (`malformed` / `corrupt`) so a driver that surfaces one but
 * not the other still pages.
 */
export function isCorruptionThrow(err: unknown): boolean {
  if (err == null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.includes("SQLITE_CORRUPT")) return true;
  const errno = (err as { errno?: unknown }).errno;
  // SQLite result code 11 == SQLITE_CORRUPT.
  if (errno === 11) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /malformed|corrupt/i.test(message);
}

/**
 * Pure decision: given the rows `PRAGMA quick_check` returned, decide whether
 * the DB is healthy and, if not, build the page message. A healthy result is
 * EXACTLY one row whose value is the literal string `ok`; anything else
 * (multiple rows, a non-`ok` value, or zero rows) is corruption.
 *
 * Exported and pure so the test suite can drive every branch (healthy / single
 * corruption row / multiple corruption rows / empty result) without a real DB.
 *
 * @param rows the strings from each `quick_check` result row, in result order.
 */
export function decideIntegrityProbe(rows: string[]): IntegrityProbeDecision {
  const healthy = rows.length === 1 && rows[0] === QUICK_CHECK_OK;
  if (healthy) {
    return { healthy: true, pageMessage: null };
  }
  // Cap the detail so a DB with thousands of corrupt pages can't produce a
  // megabyte page. The first few lines name the problem class; the count tells
  // the operator the blast radius.
  const MAX_DETAIL_LINES = 10;
  const detail =
    rows.length === 0
      ? "(quick_check returned no rows)"
      : rows.slice(0, MAX_DETAIL_LINES).join("\n");
  const more =
    rows.length > MAX_DETAIL_LINES
      ? `\n… and ${rows.length - MAX_DETAIL_LINES} more`
      : "";
  const pageMessage =
    `🔴 keeperd integrity_probe: PRAGMA quick_check FAILED — ` +
    `keeper.db may be corrupt (the 2026-06-07 malformed-image class).\n` +
    `${detail}${more}`;
  return { healthy: false, pageMessage };
}

/** Injectable side effects for {@link runIntegrityProbe} (tests stub these). */
export interface IntegrityProbeDeps {
  /**
   * Open a read-only connection, run `PRAGMA quick_check`, and return the result
   * rows as strings. Production opens a DEDICATED short-lived read-only
   * connection and closes it; tests inject a canned result (healthy / corrupt /
   * throwing) without a real DB.
   */
  quickCheck: () => string[];
  /** Page sink (botctl Telegram, "Keeper" topic). Best-effort. */
  page: (message: string) => void;
  /** Structured logger (daemon uses `console.error`). */
  log: (message: string) => void;
}

/**
 * Production `quickCheck`: open a DEDICATED short-lived read-only connection on
 * `dbPath`, run `PRAGMA quick_check`, return its rows as strings, and ALWAYS
 * close the connection (the `finally` bounds WAL-frame pinning even if the read
 * throws). Read-only ⇒ never takes the writer lock ⇒ cannot starve the daemon's
 * sole writer or a concurrent hook INSERT.
 *
 * We deliberately do NOT call `applyPragmas` here: a fresh read-only connection
 * needs no WAL switch (read-only opens cannot change journal mode) and the probe
 * wants the smallest possible footprint — the default page cache is fine for a
 * one-shot structural sweep, and a large `cache_size`/`mmap_size` would only
 * grow this short-lived connection's resident set for no benefit. `busy_timeout`
 * is irrelevant: a read-only `quick_check` never waits on the writer lock.
 */
export function liveQuickCheck(dbPath: string): () => string[] {
  return () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db.query("PRAGMA quick_check").all() as Record<
        string,
        unknown
      >[];
      // The result column is named `quick_check`; read it defensively (fall back
      // to the first column value) so a future SQLite rename can't make a
      // corrupt DB look healthy.
      return rows.map((r) => {
        const v = "quick_check" in r ? r.quick_check : Object.values(r)[0];
        return typeof v === "string" ? v : String(v);
      });
    } finally {
      db.close();
    }
  };
}

/** The observable completion shape of one array-form botctl spawn. */
export type BotctlPageSpawnOutcome =
  | { kind: "exited"; exitCode: number }
  | { kind: "spawn_threw" }
  | { kind: "exit_threw" };

/** A delivered page, a retryable pager failure, or a missing-pager failure. */
export type BotctlPageOutcome =
  | "notified"
  | "transient_failure"
  | "permanent_failure";

/** Injectable asynchronous process shape for {@link sendBotctlPage}. */
export type BotctlPageSpawn = (argv: string[]) => {
  readonly exited: Promise<number>;
};

/**
 * Classify the page transport outcome without treating a non-zero botctl exit as
 * proof that the binary is gone. Only a failed spawn is absence-shaped; non-zero
 * exits remain retryable so an unhealthy remote does not mint a new distress row
 * on every page sweep.
 */
export function classifyBotctlPageOutcome(
  outcome: BotctlPageSpawnOutcome,
): BotctlPageOutcome {
  if (outcome.kind === "spawn_threw") return "permanent_failure";
  if (outcome.kind === "exit_threw") return "transient_failure";
  return outcome.exitCode === 0 ? "notified" : "transient_failure";
}

/**
 * Send one botctl page and capture its launch/exit outcome. The array-form argv
 * keeps message content literal; callers decide whether a permanent failure should
 * surface a producer-owned distress row.
 */
export async function sendBotctlPage(
  message: string,
  deps: { topic?: string; spawn?: BotctlPageSpawn } = {},
): Promise<BotctlPageOutcome> {
  const spawn: BotctlPageSpawn =
    deps.spawn ??
    ((argv) =>
      Bun.spawn(argv, {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: process.env as Record<string, string | undefined>,
      }));
  let proc: ReturnType<BotctlPageSpawn>;
  try {
    proc = spawn([
      "botctl",
      "send-message",
      "--topic",
      deps.topic ?? KEEPER_TOPIC,
      message,
    ]);
  } catch {
    return classifyBotctlPageOutcome({ kind: "spawn_threw" });
  }
  try {
    return classifyBotctlPageOutcome({
      kind: "exited",
      exitCode: await proc.exited,
    });
  } catch {
    return classifyBotctlPageOutcome({ kind: "exit_threw" });
  }
}

/**
 * Run one integrity probe: read `quick_check`, decide, and on failure page the
 * operator. Returns the decision for tests + the caller's logging. ALWAYS
 * degrades to no-throw — a probe failure (file gone mid-open, transient lock,
 * botctl missing) logs and lets the next heartbeat retry; it never wedges the
 * daemon's always-running-writer posture.
 *
 * A healthy probe is SILENT (no page, no "all clear" spam — corruption is the
 * only signal worth a Telegram ping). A failing probe logs at error level AND
 * pages.
 */
export function runIntegrityProbe(
  deps: IntegrityProbeDeps,
): IntegrityProbeDecision {
  let rows: string[];
  try {
    rows = deps.quickCheck();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isCorruptionThrow(err)) {
      // THE 2026-06-07 PATH: bun:sqlite raises `SQLITE_CORRUPT` /
      // "database disk image is malformed" while STEPPING quick_check on a
      // damaged page — the same throw the original incident query hit. This is a
      // POSITIVE corruption signal, not a benign hiccup, so it LOGS and PAGES.
      const pageMessage =
        `🔴 keeperd integrity_probe: PRAGMA quick_check RAISED a corruption ` +
        `error — keeper.db is corrupt (the 2026-06-07 malformed-image class).\n` +
        message;
      deps.log(`[keeperd] integrity_probe FAILED (threw): ${pageMessage}`);
      try {
        deps.page(pageMessage);
      } catch {
        // Page is best-effort; a notifier failure must not crash the heartbeat.
      }
      return { healthy: false, pageMessage };
    }
    // A benign throw (file vanished mid-open during a restart, a transient RO
    // open failure) is non-fatal — log distinctly and let the next heartbeat
    // retry; do NOT page (it is not a corruption signal).
    deps.log(
      `[keeperd] integrity_probe quick_check threw (non-corruption, non-fatal, will retry): ${message}`,
    );
    return { healthy: true, pageMessage: null };
  }

  const decision = decideIntegrityProbe(rows);
  if (!decision.healthy && decision.pageMessage != null) {
    deps.log(`[keeperd] integrity_probe FAILED: ${decision.pageMessage}`);
    try {
      deps.page(decision.pageMessage);
    } catch {
      // Page is best-effort; a notifier failure must not crash the heartbeat.
    }
  }
  return decision;
}
