/**
 * fold-cost bench (fn-1313) — pins the reducer's per-fold growth curves so a
 * future change can't silently reintroduce an O(board)/O(history) fold-cost
 * time-bomb. Runs behind the `bench-folds` named gate only (`bun run
 * test:bench-folds`); never a correctness gate (`test:gate` / `test` /
 * `test:full` never collect this file).
 *
 * UNLIKE the other two slow-tier gates (`slow-git`, `slow-daemon`), this bench
 * is PURE IN-PROCESS: no daemon, no Worker thread, no subprocess. It clones the
 * migrated `:memory:` template (`freshMemDb`) and drives the reducer's public
 * `drain` path directly, exactly like the fast correctness gates — it earns its
 * own gate purely because timing assertions are inherently noisier than
 * correctness assertions, not because it touches any real-process boundary. See
 * docs/testing.md.
 *
 * Two curves, both against DETERMINISTIC synthetic corpora (fixed ids/ts — no
 * `Date.now()` / `Math.random()`, so the corpus shape is exactly reproducible;
 * only wall-clock TIMING varies run to run):
 *
 *  (a) Epic-fold per-event cost across a board-size ladder — asserted FLAT via
 *      adjacent-size ratio bands. Scoped to the memoized INDEX-SERVING path
 *      (`readEpicIndex` / `syncEpicDepsForward`) only, not the dep reverse
 *      fan-out (`syncEpicDepsReverse`, deliberately O(consumers) — see
 *      `measureEpicFoldCurve`'s doc for how the corpus keeps that fan-out at
 *      zero for every timed fold).
 *  (b) The `syncPlanLinks` per-session commit-trailer PREFIX cost — pinned as a
 *      documented regression band, not a flatness demand: linear growth in the
 *      session's own commit history is allowed (the bench guards against a
 *      SUPERLINEAR regression, it does not demand a fix for the existing linear
 *      cost).
 *
 * Both curves bulk-time (one `drain` call over a whole batch, total ms / batch
 * size) rather than per-fold — per-fold timing sits at clock resolution and
 * flakes. Both run an untimed warmup batch before the timed repeats, then take
 * the MEDIAN of several timed repeats per size (never a single sample), so one
 * scheduler hiccup can't flip the verdict. If a ratio band still flakes on a
 * slower CI runner, widen the band and document it here — never tighten the
 * runtime or the corpus to chase a number.
 */

import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drain } from "../../src/reducer";
import { freshMemDb } from "../helpers/template-db";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface RawEventRow {
  ts: number;
  sessionId: string;
  hookEvent: string;
  data: string;
}

/** Bulk-insert raw `events` rows in ONE transaction (setup speed only — never
 * timed). Mirrors exactly what `drain` reads: `ts`, `session_id`, `hook_event`,
 * `event_type` (= `hook_event`, no non-plan/non-commit kind needed here), and
 * `data`. Every other column defaults NULL, which every fold arm this bench
 * exercises tolerates (see reducer.ts `applyEvent`). */
function bulkInsertEvents(db: Database, rows: readonly RawEventRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertAll = db.transaction((items: readonly RawEventRow[]) => {
    for (const item of items) {
      stmt.run(
        item.ts,
        item.sessionId,
        item.hookEvent,
        item.hookEvent,
        item.data,
      );
    }
  });
  insertAll(rows);
}

/** Drain the whole backlog regardless of `drain`'s internal batch cap. */
function drainAll(db: Database): number {
  let total = 0;
  let n: number;
  do {
    n = drain(db, 5_000);
    total += n;
  } while (n > 0);
  return total;
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  // biome-ignore lint/style/noNonNullAssertion: samples is always non-empty here
  return sorted[Math.floor(sorted.length / 2)]!;
}

// ---------------------------------------------------------------------------
// Curve (a): epic-fold per-event cost across a board-size ladder.
// ---------------------------------------------------------------------------

const EPIC_BOARD_SIZES = [500, 2_000, 8_000] as const;
const EPIC_WARMUP_EVENTS = 50;
const EPIC_TIMED_BATCH = 200;
const EPIC_TIMED_REPEATS = 5;
/**
 * Flat in board size under the seed-once/patch-in-place memo — measured
 * ~0.28-0.31ms/event across 500->8000 epics on the reference host. A
 * regression back to a per-fold full `buildEpicIndex` scan (the pre-memo
 * behavior) would show ~4x growth per 4x board-size step; this cutoff sits
 * well below that so it fails loud on a regression while absorbing ordinary
 * CI noise.
 */
const EPIC_FLAT_RATIO_BAND = 2.5;

function epicSnapshotData(epicNumber: number, deps: readonly string[]): string {
  return JSON.stringify({
    epic_number: epicNumber,
    title: "bench",
    project_dir: "/bench-repo",
    status: "open",
    depends_on_epics: deps,
  });
}

/** Build a dep-free board of `count` epics (`bench-epic-0..count-1`), the
 * FIRST of which (`bench-epic-0`) is the fixed anchor every timed marginal
 * epic below depends on. Returns the next free `ts`. */
function buildEpicBoard(db: Database, count: number, tsStart: number): number {
  let ts = tsStart;
  const rows: RawEventRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      ts: ts++,
      sessionId: `bench-epic-${i}`,
      hookEvent: "EpicSnapshot",
      data: epicSnapshotData(i + 1, []),
    });
  }
  bulkInsertEvents(db, rows);
  drainAll(db);
  return ts;
}

/**
 * Median per-event ms of `repeats` bulk-timed batches of `batch` marginal
 * epics, each depending SOLELY on the fixed `bench-epic-0` anchor. This
 * isolates the memoized index-SERVING path deliberately: `bench-epic-0` never
 * gains more than `repeats * batch` consumers total (its OWN reverse fan-out
 * runs only when IT is re-written, which never happens here), and every
 * marginal epic's own reverse fan-out (`syncEpicDepsReverse` on ITS id)
 * always finds zero rows — nothing depends on a marginal epic yet. So no
 * timed fold ever pays for the dep reverse fan-out this bench deliberately
 * excludes (see module doc).
 */
function measureEpicFoldCurve(db: Database, tsStart: number): number {
  let ts = tsStart;
  const warmupRows: RawEventRow[] = [];
  for (let i = 0; i < EPIC_WARMUP_EVENTS; i++) {
    warmupRows.push({
      ts: ts++,
      sessionId: `bench-warm-${i}`,
      hookEvent: "EpicSnapshot",
      data: epicSnapshotData(0, ["bench-epic-0"]),
    });
  }
  bulkInsertEvents(db, warmupRows);
  drainAll(db);

  const samples: number[] = [];
  for (let r = 0; r < EPIC_TIMED_REPEATS; r++) {
    const rows: RawEventRow[] = [];
    for (let i = 0; i < EPIC_TIMED_BATCH; i++) {
      rows.push({
        ts: ts++,
        sessionId: `bench-marg-${r}-${i}`,
        hookEvent: "EpicSnapshot",
        data: epicSnapshotData(0, ["bench-epic-0"]),
      });
    }
    bulkInsertEvents(db, rows);
    const t0 = performance.now();
    const n = drain(db, EPIC_TIMED_BATCH);
    const elapsedMs = performance.now() - t0;
    expect(n).toBe(EPIC_TIMED_BATCH);
    samples.push(elapsedMs / EPIC_TIMED_BATCH);
  }
  return median(samples);
}

test("epic-fold per-event cost stays flat across a 500/2000/8000-epic board (memoized index-serving path)", () => {
  const perEventMsBySize: number[] = [];
  for (const size of EPIC_BOARD_SIZES) {
    const { db } = freshMemDb();
    const ts = buildEpicBoard(db, size, 1);
    perEventMsBySize.push(measureEpicFoldCurve(db, ts));
    db.close();
  }

  // Informational output only — the assertion below is on SHAPE, never on
  // this absolute number (see module doc).
  console.log(
    `[fold-cost-bench] epic-fold ms/event by board size: ${EPIC_BOARD_SIZES.map(
      (size, i) => `${size}=${perEventMsBySize[i]?.toFixed(4)}`,
    ).join(" ")}`,
  );

  for (let i = 1; i < EPIC_BOARD_SIZES.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index in range by loop bound
    const ratio = perEventMsBySize[i]! / perEventMsBySize[i - 1]!;
    expect(ratio).toBeLessThanOrEqual(EPIC_FLAT_RATIO_BAND);
  }
});

// ---------------------------------------------------------------------------
// Curve (b): syncPlanLinks per-session commit-trailer PREFIX cost.
// ---------------------------------------------------------------------------

const PLAN_LINKS_PREFIX_SIZES = [1_000, 4_000, 16_000] as const;
const PLAN_LINKS_WARMUP_COMMITS = 100;
const PLAN_LINKS_TIMED_BATCH = 100;
const PLAN_LINKS_TIMED_REPEATS = 5;
/**
 * Regression band, NOT a flatness demand (see module doc) — measured
 * ~0.05-0.07ms/event, essentially flat-to-mildly-linear across 1000->16000
 * prior commits on the reference host. A true O(prefix) linear cost would
 * show ~4x growth per 4x prefix-size step; a superlinear (e.g. O(prefix^2))
 * regression would show ~16x. This cutoff sits comfortably above the linear
 * case and well below the quadratic one.
 */
const PLAN_LINKS_REGRESSION_BAND = 6;

const BENCH_ANCHOR_EPIC = "fn-1-bench-anchor";
const BENCH_SESSION = "bench-sess";

/** Deterministic 40-hex commit oid (GIT_OID_RE-shaped) from a plain counter. */
function commitOid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

/** One plan-trailer Commit payload — files carries exactly one entry (a
 * files-empty commit short-circuits `foldCommit` before it ever reaches
 * `syncPlanLinks`, see reducer.ts), and `plan_target` always names the SAME
 * anchor epic so every fold touches exactly one epic (`touchedEpics.size ===
 * 1`), isolating the per-session PREFIX load as the sole scaling driver. */
function commitData(n: number): string {
  return JSON.stringify({
    project_dir: "/bench-repo",
    commit_oid: commitOid(n),
    parent_oid: null,
    files: [
      { path: "docs/adr/bench.md", blob_oid: null, committed_mode: null },
    ],
    committer_session_id: BENCH_SESSION,
    task_ids: [],
    plan_op: "scaffold",
    plan_target: BENCH_ANCHOR_EPIC,
    committed_at_ms: 5_000_000 + n,
  });
}

/** Seed the fixed anchor epic + the bench session's SessionStart, so
 * `syncPlanLinks`'s jobs-row write is non-orphan and every commit resolves
 * against a real epic row. Returns the next free `ts`. */
function seedPlanLinksFixture(db: Database): number {
  bulkInsertEvents(db, [
    {
      ts: 1,
      sessionId: BENCH_ANCHOR_EPIC,
      hookEvent: "EpicSnapshot",
      data: JSON.stringify({
        epic_number: 1,
        title: "bench anchor",
        project_dir: "/bench-repo",
        status: "open",
      }),
    },
    { ts: 2, sessionId: BENCH_SESSION, hookEvent: "SessionStart", data: "{}" },
  ]);
  drainAll(db);
  return 3;
}

/** Build `count` prior commits in the bench session, starting the deterministic
 * commit-oid counter at `commitIndexStart`. Returns the next free `ts` and the
 * next free commit index. */
function buildCommitPrefix(
  db: Database,
  count: number,
  tsStart: number,
  commitIndexStart: number,
): { ts: number; commitIndex: number } {
  let ts = tsStart;
  let commitIndex = commitIndexStart;
  const rows: RawEventRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      ts: ts++,
      sessionId: BENCH_SESSION,
      hookEvent: "Commit",
      data: commitData(commitIndex++),
    });
  }
  bulkInsertEvents(db, rows);
  drainAll(db);
  return { ts, commitIndex };
}

/** Median per-event ms of `PLAN_LINKS_TIMED_REPEATS` bulk-timed batches of
 * `PLAN_LINKS_TIMED_BATCH` marginal commits, appended to the session's
 * existing prefix built by the caller. */
function measurePlanLinksCurve(
  db: Database,
  tsStart: number,
  commitIndexStart: number,
): number {
  const warmup = buildCommitPrefix(
    db,
    PLAN_LINKS_WARMUP_COMMITS,
    tsStart,
    commitIndexStart,
  );
  let ts = warmup.ts;
  let commitIndex = warmup.commitIndex;

  const samples: number[] = [];
  for (let r = 0; r < PLAN_LINKS_TIMED_REPEATS; r++) {
    const rows: RawEventRow[] = [];
    for (let i = 0; i < PLAN_LINKS_TIMED_BATCH; i++) {
      rows.push({
        ts: ts++,
        sessionId: BENCH_SESSION,
        hookEvent: "Commit",
        data: commitData(commitIndex++),
      });
    }
    bulkInsertEvents(db, rows);
    const t0 = performance.now();
    const n = drain(db, PLAN_LINKS_TIMED_BATCH);
    const elapsedMs = performance.now() - t0;
    expect(n).toBe(PLAN_LINKS_TIMED_BATCH);
    samples.push(elapsedMs / PLAN_LINKS_TIMED_BATCH);
  }
  return median(samples);
}

test("syncPlanLinks per-session commit-trailer prefix cost stays within a regression band across 1000/4000/16000 prior commits", () => {
  const perEventMsBySize: number[] = [];
  for (const size of PLAN_LINKS_PREFIX_SIZES) {
    const { db } = freshMemDb();
    const seededTs = seedPlanLinksFixture(db);
    const prefix = buildCommitPrefix(db, size, seededTs, 0);
    perEventMsBySize.push(
      measurePlanLinksCurve(db, prefix.ts, prefix.commitIndex),
    );
    db.close();
  }

  // Informational output only (bulk ms/event) — see module doc.
  console.log(
    `[fold-cost-bench] syncPlanLinks ms/event by session prefix size: ${PLAN_LINKS_PREFIX_SIZES.map(
      (size, i) => `${size}=${perEventMsBySize[i]?.toFixed(4)}`,
    ).join(" ")}`,
  );

  for (let i = 1; i < PLAN_LINKS_PREFIX_SIZES.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index in range by loop bound
    const ratio = perEventMsBySize[i]! / perEventMsBySize[i - 1]!;
    expect(ratio).toBeLessThanOrEqual(PLAN_LINKS_REGRESSION_BAND);
  }
});
