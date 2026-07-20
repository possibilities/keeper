#!/usr/bin/env bun
/**
 * `serve-fold-load` — controlled, repeatable load harness for keeper's
 * serve-side + fold-side latency under concurrent-worker load (fn-744 task .1).
 *
 * The 2026-06-08 incident showed two symptoms at live scale (~602k events, ~870
 * epics, a ~2MB epics-projection snapshot): folds up to 5.4s, and the board/jobs
 * subscribe-server TUI slow to CONNECT and late to UPDATE. This harness is the
 * INSTRUMENT — it reproduces the three measurable legs in-process, deterministic,
 * with no live-daemon dependency and no state pollution, and ATTRIBUTES the
 * dominant cost so task .2 pulls the right lever.
 *
 * The three legs (all timed with monotonic `performance.now()`):
 *
 *   1. COLD CONNECT — the `serveFromMemo` MISS path: one `runQuery` (page SELECT
 *      + per-row JSON-decode of the 4 array columns) + one `JSON.stringify(rows)`
 *      of the full board snapshot. This is exactly what a fresh subscribe (or a
 *      memo miss after a worldRev bump) pays on the server-worker's single event
 *      loop. We split SELECT vs serialize so the attribution is unambiguous.
 *
 *   2. UPDATE UNDER BURST — `diffTick` against M concurrent subscribers each
 *      watching the full epics set, while a fold burst mutates K rows per tick.
 *      We replicate `diffTick`'s exact stages (version-probe → changed-row fetch
 *      → per-sub fanout → meta countAndToken) so the per-tick cost and the
 *      ~M-subscriber serial fanout are both visible. Drives the REAL exported
 *      `diffTick` for the end-to-end number, and the stage helpers for the
 *      attribution breakdown.
 *
 *   3. FOLD — per-`applyEvent` cost over a live-size event log via the real
 *      `drain` path, broken down by `hook_event` so the fat-tail folds
 *      (`GitSnapshot` / `Commit` re-fanning the big projections) are named.
 *
 * fn-1067 adds a fourth, opt-in `--replay-from-zero` mode: the TRUE re-fold cost
 * audit. It wipes ONLY the deterministic-replayed projection class (mirroring the
 * rewinding migration's exact list in `src/db.ts` — never the live-only git
 * surface, whose floor is RAISED so its O(history) fold self-gates), resets the
 * cursor to 0, and replays the WHOLE corpus through the real `applyEvent`, timing
 * every fold. It emits per-fold p50/p95 keyed by kind, the total wall time, and a
 * two-point (first-half vs second-half) per-event slope per kind — the honest
 * scaling detector (flat = bounded fold, growth = accumulating-state scan). A
 * kind whose p95 grows >20% between halves, or a >10-minute total replay, is a
 * confirmed offender for task .2. See {@link measureReplayFromZero} + the re-run
 * procedure in `HELP` below. DESTRUCTIVE — run only on a COPY.
 *
 * Measured headroom (fn-1067 .2 audit, corpus of 775,125 events / 1,263 epics,
 * two `--replay-from-zero` runs on this machine): the whole corpus re-folds in
 * 91–95s wall — ~6.6x under the 10-minute budget — and the OVERALL per-event p95
 * slope between corpus halves is flat-to-negative (−18% / +0.6% across the two
 * runs), the definitive bounded-fold signal. The dominant cost is per-key
 * upserts with flat per-event cost: PostToolUse (~25s total, slope ~0), PreToolUse
 * (~25s, +11%), EpicSnapshot (~6s, single-epic INSERT keyed by epic_id, so O(1)
 * per event regardless of board size). VERDICT: CLEAN — no fold breaches either
 * threshold reproducibly, so no reducer change is warranted (the known O(history)
 * scans — git attribution pass-1 {@link GitAttribMemo}-adjacent, monitor
 * provenance — were already bounded by prior work). The per-kind slope FLAGS the
 * harness prints (e.g. SubagentStop, UserPromptSubmit, ApiError, EpicSnapshot) do
 * NOT reproduce run-to-run (ApiError 29%→6%, EpicSnapshot 6%→36%, EpicDeleted
 * absent→35%): they are jitter on sub-millisecond baselines (p95 0.15–0.44ms,
 * where a ~0.1ms GC/scheduling blip is a large percentage), NOT accumulating-state
 * scans — a real scan shows a STABLE positive slope (cf. the 437s syncPlanLinks
 * incident). Linear projection at the current flat per-event rate (~0.118ms/event
 * amortized): the 10-minute budget is first reached near ~5.1M events, ~6.6x the
 * current corpus. Re-measure via the procedure in `HELP` when the corpus grows a
 * multiple, or when a new fold lands on the applyEvent hot path.
 *
 * Substrate: by default the harness SYNTHESIZES a live-size projection + event
 * log into a tmp DB so it runs standalone and deterministically (seeded PRNG).
 * Pass `--db <path>` to point at a COPY of a real keeper.db (read-only for the
 * serve/diff legs; the fold leg needs a writable copy) for the most faithful
 * numbers. NEVER point `--db` at the live keeper.db — open it on a copy.
 *
 * Usage:
 *   bun scripts/serve-fold-load.ts [options]
 *
 * Options:
 *   --db <path>          Use this (copied) keeper.db instead of synthesizing.
 *                        Serve/diff legs open it read-only; the fold leg needs a
 *                        writable copy (refolds a tail window in place).
 *   --epics <n>          Synthetic epic count (default: 877, the live scale).
 *   --subscribers <n>    Concurrent board subscribers for the diff leg
 *                        (default: 21, the incident's observed count).
 *   --burst <n>          Rows mutated per diffTick in the update-under-burst leg
 *                        (default: 1, the steady single-epic fold; try higher
 *                        to model a multi-row burst).
 *   --fold-events <n>    Synthetic events to fold in the fold leg (default: 3000)
 *                        OR the tail window size when --db is given.
 *   --iterations <n>     Samples per measured leg (default: 30).
 *   --seed <n>           PRNG seed for synthesis (default: 744).
 *   --replay-from-zero   DESTRUCTIVE re-fold cost audit (fn-1067); runs INSTEAD
 *                        of legs 1-4. Wipes + rebuilds the deterministic
 *                        projections and times every fold from id 0. Use a COPY.
 *   --replay-batch <n>   drain() batch size for --replay-from-zero (default: 50).
 *   --json               Emit the full report as JSON.
 *   --help, -h           Show this help.
 *
 * The harness prints p50/p95/p99 for each leg and a one-line dominant-cost
 * verdict — the input to the task .2 lever decision.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  countAndToken,
  getCollection,
  selectByIdsChunked,
  selectVersionsByIdsChunked,
} from "../src/collections";
import { LIVE_ONLY_PROJECTIONS, openDb } from "../src/db";
import { applyEvent, DEFAULT_BATCH_SIZE, drain } from "../src/reducer";
import {
  diffTick,
  resolveFilter,
  runQuery,
  type SubState,
  type Writable,
} from "../src/server-worker";
import type { Event } from "../src/types";

const HELP = `serve-fold-load — controlled serve/fold latency harness (fn-744.1)

Usage:
  bun scripts/serve-fold-load.ts [options]

Options:
  --db <path>          Use this (copied) keeper.db instead of synthesizing.
  --epics <n>          Synthetic epic count (default: 877).
  --subscribers <n>    Concurrent board subscribers for the diff leg (default: 21).
  --burst <n>          Rows mutated per diffTick (default: 1).
  --fold-events <n>    Events to fold / tail window when --db given (default: 3000).
  --iterations <n>     Samples per measured leg (default: 30).
  --seed <n>           PRNG seed for synthesis (default: 744).
  --replay-from-zero   DESTRUCTIVE replay-from-zero re-fold cost audit (fn-1067).
                       Wipes + rebuilds the deterministic projections and times
                       every fold from id 0. Runs INSTEAD of the four legs above.
                       Use only on a COPY. Pair with --db.
  --replay-batch <n>   drain() batch size for --replay-from-zero (default: 50).
  --json               Emit the full report as JSON.
  --help, -h           Show this help.

Measures cold-connect, update-under-burst, and per-fold latency at live scale and
names the dominant cost. Standalone (synthesizes a live-size projection) unless
--db points at a COPY of a real keeper.db. NEVER pass the live keeper.db.

Replay-from-zero re-run procedure (regenerates the fn-1067 audit numbers in the
header above). Use sqlite .backup for a consistent snapshot of the LIVE,
actively-written DB — a raw cp of the .db + -wal can race the daemon's writes:
  sqlite3 "file:$HOME/.local/state/keeper/keeper.db?mode=ro" ".backup /tmp/kdb-copy.db"
  bun scripts/serve-fold-load.ts --db /tmp/kdb-copy.db --replay-from-zero
  # Run it twice: a per-kind slope that flips in/out of the offender set between
  # runs is sub-ms jitter, not a scaling scan. The overall slope + total wall are
  # the stable signals — an offender must reproduce to count.
`;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function pct(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx] as number;
}

function summary(values: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  // Reduce, never `Math.max(...values)`: the replay-from-zero leg passes the
  // whole corpus (~774k folds), and spreading that many array elements as call
  // arguments overflows the engine's argument limit (RangeError).
  let max = Number.NaN;
  for (const v of values) max = Number.isNaN(max) || v > max ? v : max;
  return {
    n: values.length,
    p50: pct(values, 0.5),
    p95: pct(values, 0.95),
    p99: pct(values, 0.99),
    max,
  };
}

function fmt(n: number): string {
  return Number.isFinite(n) ? `${n.toFixed(2)}ms` : "—";
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — seeded so synthesis is repeatable.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Synthesis — a live-size epics projection + a foldable event log.
// ---------------------------------------------------------------------------

/**
 * Populate the `epics` table with `count` rows whose per-row byte size matches
 * the live distribution (~2.2KB p50, ~5.8KB tail) by padding the JSON-array
 * columns with synthetic tasks/jobs. Deterministic given `seed`.
 */
function synthesizeEpics(
  db: ReturnType<typeof openDb>["db"],
  count: number,
  rng: () => number,
): void {
  const insert = db.prepare(
    `INSERT INTO epics
       (epic_id, epic_number, title, project_dir, status, approval,
        last_event_id, updated_at, tasks, depends_on_epics, jobs, job_links,
        sort_path, queue_jump)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `fn-${i}-synthetic-epic-${i}`;
      // Each task/job element mirrors the embedded shape the reducer projects, so
      // the JSON-decode + serialize cost on the read path tracks production.
      const taskN = 2 + Math.floor(rng() * 6);
      const tasks = Array.from({ length: taskN }, (_, t) => ({
        task_id: `${id}.${t}`,
        title: `Task ${t} — ${"x".repeat(40 + Math.floor(rng() * 80))}`,
        status: rng() > 0.5 ? "done" : "open",
        approval: "approved",
        jobs: [{ verb: "work", job_id: `job-${i}-${t}`, state: "ended" }],
        snippets: Array.from({ length: 3 }, (_, s) => `snippet/bundle-${s}`),
      }));
      const jobs = [
        { verb: "plan", job_id: `plan-${i}`, state: "ended" },
        { verb: "close", job_id: `close-${i}`, state: "ended" },
      ];
      const jobLinks = Array.from({ length: 2 }, (_, l) => ({
        kind: "creator",
        epic_id: `fn-${(i + l + 1) % count}-synthetic-epic`,
      }));
      insert.run(
        id,
        i,
        `Synthetic epic ${i} — ${"y".repeat(30 + Math.floor(rng() * 40))}`,
        "/Users/mike/code/keeper",
        // All `done` so the cold-connect leg's `status:done` filter returns the
        // FULL set (matching the ~2MB live board snapshot, which serves every
        // epic). Approval varies so default-visible / meta-pass behavior is still
        // representative.
        "done",
        rng() > 0.5 ? "approved" : "pending",
        1000 + i,
        1_700_000_000 + i,
        JSON.stringify(tasks),
        "[]",
        JSON.stringify(jobs),
        JSON.stringify(jobLinks),
        `!${String(i).padStart(6, "0")}`,
        0,
      );
    }
  })();
}

/**
 * Append a foldable event log. Mirrors the live event-type mix that drives the
 * fat-tail folds: a stream of cheap PreToolUse/PostToolUse with periodic
 * GitSnapshot + Commit + EpicSnapshot (the heavy fan-out folds). Deterministic.
 */
function synthesizeEvents(
  db: ReturnType<typeof openDb>["db"],
  count: number,
  rng: () => number,
): void {
  const insert = db.prepare(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const r = rng();
      let hook = "PostToolUse";
      let data = "{}";
      if (r < 0.05) {
        hook = "GitSnapshot";
        // A git snapshot payload listing many roots — the heavy fold.
        const roots = Array.from({ length: 8 }, (_, k) => ({
          root: `/Users/mike/code/project-${k}`,
          branch: "main",
          ahead: Math.floor(rng() * 5),
          dirty: rng() > 0.5,
        }));
        data = JSON.stringify({ roots });
      } else if (r < 0.07) {
        hook = "Commit";
        data = JSON.stringify({
          sha: `${i}`.padStart(40, "0"),
          subject: "synthetic",
        });
      } else if (r < 0.5) {
        hook = "PreToolUse";
      }
      insert.run(
        1_700_000_000 + i,
        `sess-${i % 8}`,
        4242,
        hook,
        hook,
        "/Users/mike/code/keeper",
        data,
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// Fake subscriber — the diff-leg sink. Counts bytes written so the per-tick
// fanout cost is real (writeFrames serializes into our write()).
// ---------------------------------------------------------------------------

interface CountingSock extends Writable {
  bytesWritten: number;
  framesWritten: number;
}

function makeSubscriber(
  db: ReturnType<typeof openDb>["db"],
  watchedIds: string[],
  versionById: Map<string, number>,
): CountingSock {
  const descriptor = getCollection("epics");
  if (!descriptor) throw new Error("no epics collection");
  const where = resolveFilter(descriptor, {});
  const { total, token } = countAndToken(
    db,
    descriptor,
    where.clause,
    where.params,
  );
  const sub: SubState = {
    collection: "epics",
    watched: new Set(watchedIds),
    lastSent: new Map(watchedIds.map((id) => [id, versionById.get(id) ?? -1])),
    where,
    lastTotal: total,
    lastToken: token,
    lastMetaEmittedAt: 0,
  };
  const sock: CountingSock = {
    data: {
      buffer: {
        push: () => [],
        pendingLength: () => 0,
      } as unknown as Writable["data"]["buffer"],
      subs: new Map([[null, sub]]),
      pending: null,
      pendingSince: null,
    },
    bytesWritten: 0,
    framesWritten: 0,
    write(payload: Uint8Array, off = 0, len = payload.length - off): number {
      this.bytesWritten += len;
      // Count NDJSON lines without re-parsing (cheap; cost is in writeFrames'
      // encodeFrame, which already ran to produce these bytes).
      this.framesWritten += 1;
      return len;
    },
    end(): void {
      /* eviction spy — unused in the load leg */
    },
  } as CountingSock;
  return sock;
}

// ---------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------

interface ColdConnectResult {
  rows: number;
  bytes: number;
  selectMs: ReturnType<typeof summary>;
  serializeMs: ReturnType<typeof summary>;
  totalMs: ReturnType<typeof summary>;
}

/** Leg 1 — cold connect: serveFromMemo MISS = runQuery + JSON.stringify(rows). */
function measureColdConnect(
  db: ReturnType<typeof openDb>["db"],
  iterations: number,
): ColdConnectResult {
  // The board pulls the FULL epics set (no page limit). An explicit status
  // filter drops the default-visible scope so we serve every row — matching the
  // 2MB live board snapshot, not the tiny default page.
  const frame = {
    type: "query" as const,
    collection: "epics",
    filter: { status: "done" },
    limit: 0,
  };
  const select: number[] = [];
  const serialize: number[] = [];
  const total: number[] = [];
  let rows = 0;
  let bytes = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const res = runQuery(db, 0, frame);
    const t1 = performance.now();
    const r = res.type === "result" ? res.rows : [];
    const json = JSON.stringify(r);
    const t2 = performance.now();
    select.push(t1 - t0);
    serialize.push(t2 - t1);
    total.push(t2 - t0);
    rows = r.length;
    bytes = json.length;
  }
  return {
    rows,
    bytes,
    selectMs: summary(select),
    serializeMs: summary(serialize),
    totalMs: summary(total),
  };
}

interface UpdateBurstResult {
  subscribers: number;
  burst: number;
  watched: number;
  tickMs: ReturnType<typeof summary>;
  probeMs: ReturnType<typeof summary>;
  fetchMs: ReturnType<typeof summary>;
  countMs: ReturnType<typeof summary>;
  fanoutMs: ReturnType<typeof summary>;
}

/**
 * Leg 2 — update under burst. M subscribers watch the full epics set; each tick
 * mutates `burst` rows (bumping last_event_id, the version column) then runs the
 * REAL diffTick across all M subscribers (the end-to-end per-tick number) and,
 * separately, the stage helpers for the attribution split.
 */
function measureUpdateBurst(
  db: ReturnType<typeof openDb>["db"],
  subscribers: number,
  burst: number,
  iterations: number,
): UpdateBurstResult {
  const descriptor = getCollection("epics");
  if (!descriptor) throw new Error("no epics collection");
  const ids = db.query(`SELECT epic_id, last_event_id FROM epics`).all() as {
    epic_id: string;
    last_event_id: number;
  }[];
  const watchedIds = ids.map((r) => r.epic_id);
  const versionById = new Map(ids.map((r) => [r.epic_id, r.last_event_id]));
  const socks = Array.from({ length: subscribers }, () =>
    makeSubscriber(db, watchedIds, versionById),
  );

  const where = resolveFilter(descriptor, {});
  const tick: number[] = [];
  const probe: number[] = [];
  const fetch: number[] = [];
  const count: number[] = [];
  const fanout: number[] = [];

  // A reusable mutate statement — simulate a fold bumping `burst` epics' version.
  const bump = db.prepare(
    `UPDATE epics SET last_event_id = last_event_id + 1, updated_at = updated_at + 1 WHERE epic_id = ?`,
  );

  for (let i = 0; i < iterations; i++) {
    // Mutate `burst` rows (a fold burst landed since the last tick).
    const changed: string[] = [];
    for (let b = 0; b < burst; b++) {
      const id = watchedIds[(i * burst + b) % watchedIds.length] as string;
      bump.run(id);
      changed.push(id);
    }

    // End-to-end: the real diffTick across every subscriber.
    const t0 = performance.now();
    diffTick(db, socks as unknown as Iterable<Writable>);
    tick.push(performance.now() - t0);

    // Re-bump the SAME rows so the stage breakdown below sees fresh deltas
    // (diffTick advanced lastSent on the socks above).
    for (const id of changed) bump.run(id);

    // Attribution: replicate diffTick's stages directly.
    let s = performance.now();
    selectVersionsByIdsChunked(db, descriptor, watchedIds);
    probe.push(performance.now() - s);

    s = performance.now();
    selectByIdsChunked(db, descriptor, changed);
    fetch.push(performance.now() - s);

    s = performance.now();
    countAndToken(db, descriptor, where.clause, where.params);
    count.push(performance.now() - s);

    // Fanout proxy: the per-subscriber serial cost is (subscribers ×
    // per-fetch), already captured by tickMs above; we record the marginal
    // count-pass × subscribers as the meta-storm proxy.
    fanout.push((performance.now() - s) * subscribers);
  }

  return {
    subscribers,
    burst,
    watched: watchedIds.length,
    tickMs: summary(tick),
    probeMs: summary(probe),
    fetchMs: summary(fetch),
    countMs: summary(count),
    fanoutMs: summary(fanout),
  };
}

/**
 * The exact `events` column list {@link drain} reads into an {@link Event} row.
 * Kept byte-identical to `reducer.ts`'s drain SELECT so the harness folds the
 * same shape the daemon does — `applyEvent` reads `plan_*` (the current names;
 * the pre-v31 `planctl_*` names are long renamed) and `worktree`. A missing or
 * misnamed column silently NULLs a fold input, so this single source of truth
 * feeds both the tail-window fold leg and the replay-from-zero mode.
 */
const FOLD_EVENT_COLUMNS = `id, ts, session_id, pid, hook_event, event_type,
        tool_name, matcher, cwd, permission_mode, agent_id, agent_type,
        stop_hook_active, data, subagent_agent_id, spawn_name, start_time,
        slash_command, skill_name, plan_op, plan_target, plan_epic_id,
        plan_task_id, plan_subject_present, tool_use_id, config_dir, plan_files,
        backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
        worktree`;

interface FoldResult {
  events: number;
  perFoldMs: ReturnType<typeof summary>;
  byType: {
    type: string;
    n: number;
    p50: number;
    p95: number;
    max: number;
    totalMs: number;
  }[];
}

/**
 * Leg 3 — per-fold latency. Re-folds a window of `events` through the real
 * `applyEvent` (idempotent upserts), broken down by `hook_event` so the
 * fat-tail folds are named. On a real `--db` copy this re-folds the tail window;
 * on synthesized data it folds the synthesized log.
 *
 * Fidelity note: synthesized GitSnapshot/Commit events fold cheaply because they
 * don't trigger the real `syncPlanctlLinks` / git-status fan-out across the big
 * projection that the LIVE heavy folds do. For a faithful fold-leg measurement
 * (the 5.4s-fold attribution), run with `--db <copy>` against a real keeper.db
 * COPY. Synthesized data is faithful for the serve (Leg 1) and diff (Leg 2)
 * legs, whose cost is projection size + subscriber count, not fold semantics.
 */
function measureFold(
  db: ReturnType<typeof openDb>["db"],
  windowSize: number,
): FoldResult {
  const head = (
    db.query(`SELECT COALESCE(MAX(id), 0) m FROM events`).get() as { m: number }
  ).m;
  const from = Math.max(0, head - windowSize);
  const rows = db
    .query(
      `SELECT ${FOLD_EVENT_COLUMNS}
         FROM events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?`,
    )
    .all(from, windowSize) as Event[];

  const all: number[] = [];
  const byTypeMap = new Map<string, number[]>();
  for (const row of rows) {
    const t0 = performance.now();
    applyEvent(db, row);
    const d = performance.now() - t0;
    all.push(d);
    const key = (row.hook_event as string) ?? "?";
    const arr = byTypeMap.get(key) ?? [];
    arr.push(d);
    byTypeMap.set(key, arr);
  }

  const byType = [...byTypeMap.entries()]
    .map(([type, arr]) => ({
      type,
      n: arr.length,
      p50: pct(arr, 0.5),
      p95: pct(arr, 0.95),
      max: Math.max(...arr),
      totalMs: arr.reduce((a, b) => a + b, 0),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);

  return { events: rows.length, perFoldMs: summary(all), byType };
}

// ---------------------------------------------------------------------------
// Leg 4 — drain-batch writer-lock hold (fn-744 .2 batch-tuning lever)
// ---------------------------------------------------------------------------

interface BatchHoldResult {
  /** Batch sizes compared (the configured default plus a control). */
  batches: {
    batchSize: number;
    /** Wall-clock per full drain() call = uninterrupted writer-lock run. */
    batchMs: ReturnType<typeof summary>;
    /** Events actually folded per drain() call (≤ batchSize). */
    eventsPerBatch: number;
  }[];
  /** The shipped DEFAULT_BATCH_SIZE, for the verdict line. */
  defaultBatchSize: number;
}

/**
 * Leg 4 — the fn-744 .2 batch-tuning lever, measured directly. The dominant
 * live-scale cost `.1` attributed was a `drain()` BATCH (200 events) landing on
 * a `GitSnapshot`/`Commit` burst and running every fold back-to-back, holding
 * the writer for the batch's full duration — the window a contending hook INSERT
 * waits through. Each event folds in its OWN transaction, so the lever is the
 * batch boundary: a smaller `batchSize` returns control to `drainToCompletion`
 * (the only point a contending hook reliably wins the writer) sooner.
 *
 * This leg re-folds the SAME tail window at several batch sizes and reports the
 * wall-clock a single `drain()` call holds the writer = max contiguous
 * starvation window per batch. The shipped {@link DEFAULT_BATCH_SIZE} (50) vs a
 * 200-event control makes the before/after improvement on the targeted cost
 * explicit. We rewind the cursor between batch-size sweeps so each sweep folds
 * the identical window (idempotent upserts — re-folding is byte-identical, the
 * re-fold-determinism invariant the harness must not violate).
 */
function measureBatchHold(
  db: ReturnType<typeof openDb>["db"],
  windowSize: number,
  batchSizes: number[],
): BatchHoldResult {
  const head = (
    db.query(`SELECT COALESCE(MAX(id), 0) m FROM events`).get() as { m: number }
  ).m;
  const from = Math.max(0, head - windowSize);
  // Snapshot the live cursor so we can restore it after the destructive sweeps
  // (each drain() advances reducer_state.last_event_id). The folds themselves
  // are idempotent upserts, so the projection is unchanged; only the cursor
  // moves, and we put it back.
  const savedCursor = (
    db.query(`SELECT last_event_id FROM reducer_state WHERE id = 1`).get() as {
      last_event_id: number;
    } | null
  )?.last_event_id;

  const rewind = (): void => {
    db.run(`UPDATE reducer_state SET last_event_id = ? WHERE id = 1`, [from]);
  };

  const batches = batchSizes.map((batchSize) => {
    rewind();
    const perBatch: number[] = [];
    let totalFolded = 0;
    let calls = 0;
    for (;;) {
      const t0 = performance.now();
      const folded = drain(db, batchSize);
      perBatch.push(performance.now() - t0);
      if (folded === 0) break;
      totalFolded += folded;
      calls += 1;
    }
    return {
      batchSize,
      batchMs: summary(perBatch),
      eventsPerBatch: calls > 0 ? Math.round(totalFolded / calls) : 0,
    };
  });

  // Restore the cursor so the harness leaves reducer_state where it found it
  // (the DB is a disposable copy/tmp, but restoring keeps a --db copy re-runnable
  // and the synthesized-tmp path symmetric).
  if (savedCursor !== undefined) {
    db.run(`UPDATE reducer_state SET last_event_id = ? WHERE id = 1`, [
      savedCursor,
    ]);
  }

  return { batches, defaultBatchSize: DEFAULT_BATCH_SIZE };
}

// ---------------------------------------------------------------------------
// Leg 5 — replay-from-zero (fn-1067 .1): the TRUE re-fold cost audit
// ---------------------------------------------------------------------------

/**
 * A fold breaching either threshold is a confirmed scaling offender for task .2:
 * a per-event p95 that grows >20% between the corpus's first and second halves
 * (an accumulating-state scan), OR a total replay past 10 minutes on this
 * machine (an unbounded aggregate cost regardless of slope).
 */
export const SLOPE_OFFENDER_PCT = 20;
export const REPLAY_BUDGET_MS = 10 * 60 * 1000;

/**
 * Checkpoint the WAL every N folds so a long replay's growing `-wal` does not
 * silently inflate the SECOND half's reader cost (a false-positive slope).
 * PASSIVE-class space reclamation only — run OUTSIDE the timed `applyEvent`
 * call, so no fold's measured duration includes a checkpoint. Pure measurement
 * hygiene: SQLite fold output is checkpoint-cadence-independent.
 */
const REPLAY_CHECKPOINT_EVERY = 50_000;

export interface HalfSummary {
  n: number;
  p50: number;
  p95: number;
}

export interface FoldSlope {
  /** `hook_event` kind, or `__overall__` for the whole-corpus row. */
  kind: string;
  first: HalfSummary;
  second: HalfSummary;
  /**
   * Per-event p95 growth from the first half to the second, as a percent.
   * `null` when it cannot be computed honestly: a kind absent from either half
   * (no two-point line), or a first-half p95 of 0 (no baseline to divide by).
   * A `null` slope is NEVER an offender — the two-point test only convicts a
   * kind present, and non-trivially costed, in BOTH halves.
   */
  p95SlopePct: number | null;
  offender: boolean;
}

function halfSummary(ms: number[]): HalfSummary {
  return { n: ms.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95) };
}

/**
 * The two-point slope for one fold kind (or the overall corpus): compare the
 * per-event p95 of its first-half samples against its second-half samples.
 * Pure — the unit-tested core of the audit's scaling detector.
 */
export function foldSlope(
  kind: string,
  first: number[],
  second: number[],
): FoldSlope {
  const f = halfSummary(first);
  const s = halfSummary(second);
  const computable = f.n > 0 && s.n > 0 && f.p95 > 0;
  const p95SlopePct = computable ? ((s.p95 - f.p95) / f.p95) * 100 : null;
  return {
    kind,
    first: f,
    second: s,
    p95SlopePct,
    offender: p95SlopePct !== null && p95SlopePct > SLOPE_OFFENDER_PCT,
  };
}

/**
 * Split fold-order samples at the corpus midpoint and emit the two-point slope
 * for the whole corpus plus one per `hook_event` kind. `samples` MUST be in
 * fold order (ascending event id) — the split is positional, so the first
 * `floor(n/2)` samples are the first half. Pure; the harness feeds it every
 * replayed fold, the smoke test feeds it hand-built arrays.
 */
export function twoPointSlopes(samples: { kind: string; ms: number }[]): {
  overall: FoldSlope;
  byKind: FoldSlope[];
} {
  const mid = Math.floor(samples.length / 2);
  const overallFirst: number[] = [];
  const overallSecond: number[] = [];
  const firstByKind = new Map<string, number[]>();
  const secondByKind = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, v: number): void => {
    const arr = m.get(k);
    if (arr) arr.push(v);
    else m.set(k, [v]);
  };
  samples.forEach((sample, i) => {
    const inFirst = i < mid;
    (inFirst ? overallFirst : overallSecond).push(sample.ms);
    push(inFirst ? firstByKind : secondByKind, sample.kind, sample.ms);
  });
  const kinds = [
    ...new Set([...firstByKind.keys(), ...secondByKind.keys()]),
  ].sort();
  const byKind = kinds.map((k) =>
    foldSlope(k, firstByKind.get(k) ?? [], secondByKind.get(k) ?? []),
  );
  return {
    overall: foldSlope("__overall__", overallFirst, overallSecond),
    byKind,
  };
}

/**
 * Whether a table exists — guards the wipe below so the harness survives a copy
 * of an older/newer schema without throwing on a since-renamed table.
 */
function tableExists(
  db: ReturnType<typeof openDb>["db"],
  name: string,
): boolean {
  return (
    (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all(name) as unknown[]
    ).length > 0
  );
}

/**
 * Wipe ONLY the deterministic-replayed projection class and reset the cursor to
 * 0, mirroring the rewinding migration's exact list (the v84→v85 full
 * rewind-and-redrain in `src/db.ts`). The LIVE-ONLY surface
 * ({@link LIVE_ONLY_PROJECTIONS}) is wiped but its git floor is RAISED to
 * `max(events.id)` (never reset to 0), so the from-scratch replay's
 * `GitSnapshot` / tmux folds self-gate below the floor and no-op — refolding the
 * live-only git surface re-arms the `computeRepoBashWindows` O(history)
 * time-bomb and would both distort the numbers and dominate the wall clock.
 * `commit_trailer_facts` is DELIBERATELY not wiped (an `INSERT OR IGNORE` fold
 * keyed by `event_id` PK — it re-folds byte-identically from id 0 without one).
 */
function wipeDeterministicProjections(
  db: ReturnType<typeof openDb>["db"],
): void {
  const del = (t: string): void => {
    if (tableExists(db, t)) db.run(`DELETE FROM ${t}`);
  };
  db.transaction(() => {
    db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
    // Deterministic reducer projections (jobs + epics lead the migration list).
    del("jobs");
    del("epics");
    // Live-only surface: wipe the rows, but the git floor RAISE below — not a
    // reset to 0 — is what keeps the replay off the O(history) git fold.
    for (const t of LIVE_ONLY_PROJECTIONS) del(t);
    if (tableExists(db, "jobs")) {
      db.run(
        `UPDATE jobs SET git_dirty_count = 0, git_unattributed_to_live_count = 0, git_orphan_count = 0`,
      );
    }
    if (tableExists(db, "git_projection_state")) {
      db.run(
        `UPDATE git_projection_state
            SET floor = max(floor, (SELECT COALESCE(MAX(id), 0) FROM events)),
                seed_required = 1,
                updated_at = unixepoch('now', 'subsec')
          WHERE id = 1`,
      );
    }
    del("subagent_invocations");
    del("usage");
    del("profiles");
    del("dispatch_failures");
    del("autopilot_state");
    del("pending_dispatches");
    del("dispatch_never_bound");
    del("block_escalations");
    del("handoffs");
    del("armed_epics");
  })();
}

interface ReplayResult {
  events: number;
  wallMs: number;
  batchSize: number;
  checkpoints: number;
  exceedsBudget: boolean;
  perFoldMs: ReturnType<typeof summary>;
  overall: FoldSlope;
  /** Per-kind slopes, sorted offenders-first then by descending slope. */
  byKind: FoldSlope[];
  /** Per-kind total fold time, for the report's cost attribution. */
  totalMsByKind: Map<string, number>;
}

/**
 * Leg 5 — a TRUE replay from id 0. Wipes the deterministic-replayed class
 * ({@link wipeDeterministicProjections}), checkpoints the WAL, then loops the
 * SAME batched SELECT + per-event `applyEvent` that {@link drain} runs — timing
 * each fold individually (drain does not expose per-fold latency) — to
 * completion. Emits per-fold p50/p95 keyed by `hook_event`, the total wall
 * time, and the two-point (first-half vs second-half) slope per kind.
 *
 * DESTRUCTIVE: only ever run against a COPY of a real keeper.db. The projection
 * is rebuilt by the replay, but the git floor is left raised — the copy is
 * disposable.
 */
function measureReplayFromZero(
  db: ReturnType<typeof openDb>["db"],
  batchSize: number,
): ReplayResult {
  wipeDeterministicProjections(db);
  // Reader cost is proportional to WAL size — start the timed replay on a
  // checkpointed WAL (best practice: sqlite.org/wal.html).
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");

  const query = db.query(
    `SELECT ${FOLD_EVENT_COLUMNS}
       FROM events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?`,
  );

  const all: number[] = [];
  const samples: { kind: string; ms: number }[] = [];
  const totalMsByKind = new Map<string, number>();
  let cursor = 0;
  let sinceCheckpoint = 0;
  let checkpoints = 0;

  const wall0 = performance.now();
  for (;;) {
    const rows = query.all(cursor, batchSize) as Event[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const t0 = performance.now();
      applyEvent(db, row);
      const d = performance.now() - t0;
      const kind = row.hook_event ?? "?";
      all.push(d);
      samples.push({ kind, ms: d });
      totalMsByKind.set(kind, (totalMsByKind.get(kind) ?? 0) + d);
      cursor = row.id;
      sinceCheckpoint += 1;
    }
    if (sinceCheckpoint >= REPLAY_CHECKPOINT_EVERY) {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      sinceCheckpoint = 0;
      checkpoints += 1;
    }
  }
  const wallMs = performance.now() - wall0;

  const { overall, byKind } = twoPointSlopes(samples);
  // Offenders first, then steepest slope; nulls (uncomputable) sink to the end.
  byKind.sort((a, b) => {
    const rank = (x: FoldSlope): number =>
      x.offender ? 2 : x.p95SlopePct !== null ? 1 : 0;
    if (rank(a) !== rank(b)) return rank(b) - rank(a);
    return (b.p95SlopePct ?? -Infinity) - (a.p95SlopePct ?? -Infinity);
  });

  return {
    events: samples.length,
    wallMs,
    batchSize,
    checkpoints,
    exceedsBudget: wallMs > REPLAY_BUDGET_MS,
    perFoldMs: summary(all),
    overall,
    byKind,
    totalMsByKind,
  };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

interface Args {
  db: string | null;
  epics: number;
  subscribers: number;
  burst: number;
  foldEvents: number;
  iterations: number;
  seed: number;
  json: boolean;
  replayFromZero: boolean;
  replayBatch: number;
}

function parse(argv: string[]): Args | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string" },
      epics: { type: "string" },
      subscribers: { type: "string" },
      burst: { type: "string" },
      "fold-events": { type: "string" },
      iterations: { type: "string" },
      seed: { type: "string" },
      json: { type: "boolean", default: false },
      "replay-from-zero": { type: "boolean", default: false },
      "replay-batch": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });
  if (values.help) return "help";
  const num = (v: string | undefined, d: number): number => {
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`expected a positive number, got '${v}'`);
    return n;
  };
  return {
    db: values.db ?? null,
    epics: num(values.epics, 877),
    subscribers: num(values.subscribers, 21),
    burst: num(values.burst, 1),
    foldEvents: num(values["fold-events"], 3000),
    iterations: num(values.iterations, 30),
    seed: num(values.seed, 744),
    json: values.json ?? false,
    replayFromZero: values["replay-from-zero"] ?? false,
    replayBatch: num(values["replay-batch"], DEFAULT_BATCH_SIZE),
  };
}

function dominantVerdict(
  cold: ColdConnectResult,
  burst: UpdateBurstResult,
  fold: FoldResult,
): string {
  // The serve-side single-event-loop budget: cold serialize, per-tick diff, and
  // the worst per-fold (which holds the writer lock and stalls everything).
  const coldP95 = cold.totalMs.p95;
  const tickStorm = burst.tickMs.p95; // already covers M-subscriber serial fanout
  const foldTail = fold.perFoldMs.p99;
  const candidates: [string, number, string][] = [
    [
      "cold-connect snapshot serialize",
      coldP95,
      "delta-on-subscribe-update + postMessage(string) fast path",
    ],
    [
      "board update-under-burst (diffTick × subscribers)",
      tickStorm,
      "per-row version deltas / meta-coalesce widening",
    ],
    [
      "per-fold tail on the large projection",
      foldTail,
      "fold-batch tuning (shrink DEFAULT_BATCH_SIZE) / WAL checkpoint cadence",
    ],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  const [name, ms, lever] = candidates[0] as [string, number, string];
  return `DOMINANT: ${name} (p95/p99 ${ms.toFixed(1)}ms) → safe lever for .2: ${lever}`;
}

function printReport(
  args: Args,
  scale: { epics: number; events: number; source: string },
  cold: ColdConnectResult,
  burst: UpdateBurstResult,
  fold: FoldResult,
  batchHold: BatchHoldResult,
): void {
  const L = (s: string) => process.stdout.write(`${s}\n`);
  L("");
  L("══ serve-fold-load report ════════════════════════════════════════");
  L(`source: ${scale.source}   epics=${scale.epics}   events=${scale.events}`);
  L(
    `iterations=${args.iterations}  subscribers=${args.subscribers}  burst=${args.burst}`,
  );
  L("");
  L(
    "── Leg 1: COLD CONNECT (serveFromMemo miss = runQuery + JSON.stringify) ──",
  );
  L(
    `  snapshot: ${cold.rows} rows / ${(cold.bytes / 1024 / 1024).toFixed(2)}MB`,
  );
  L(
    `  SELECT     p50 ${fmt(cold.selectMs.p50)}  p95 ${fmt(cold.selectMs.p95)}  p99 ${fmt(cold.selectMs.p99)}`,
  );
  L(
    `  serialize  p50 ${fmt(cold.serializeMs.p50)}  p95 ${fmt(cold.serializeMs.p95)}  p99 ${fmt(cold.serializeMs.p99)}`,
  );
  L(
    `  TOTAL      p50 ${fmt(cold.totalMs.p50)}  p95 ${fmt(cold.totalMs.p95)}  p99 ${fmt(cold.totalMs.p99)}`,
  );
  L("");
  L("── Leg 2: UPDATE UNDER BURST (real diffTick × subscribers) ──");
  L(
    `  watched ${burst.watched} epics × ${burst.subscribers} subscribers, ${burst.burst} row(s)/tick`,
  );
  L(
    `  per-tick   p50 ${fmt(burst.tickMs.p50)}  p95 ${fmt(burst.tickMs.p95)}  p99 ${fmt(burst.tickMs.p99)}`,
  );
  L(
    `  ├ probe    p50 ${fmt(burst.probeMs.p50)}  p95 ${fmt(burst.probeMs.p95)}`,
  );
  L(
    `  ├ fetch    p50 ${fmt(burst.fetchMs.p50)}  p95 ${fmt(burst.fetchMs.p95)}`,
  );
  L(
    `  └ count    p50 ${fmt(burst.countMs.p50)}  p95 ${fmt(burst.countMs.p95)}`,
  );
  L("");
  L("── Leg 3: PER-FOLD (real applyEvent over the log) ──");
  L(`  folded ${fold.events} events`);
  L(
    `  per-fold   p50 ${fmt(fold.perFoldMs.p50)}  p95 ${fmt(fold.perFoldMs.p95)}  p99 ${fmt(fold.perFoldMs.p99)}  max ${fmt(fold.perFoldMs.max)}`,
  );
  L(`  by hook_event (top by total fold time):`);
  L(
    `    ${"event".padEnd(20)}${"n".padStart(6)}${"p50".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}${"total".padStart(10)}`,
  );
  for (const t of fold.byType.slice(0, 6)) {
    L(
      `    ${t.type.padEnd(20)}${String(t.n).padStart(6)}${`${t.p50.toFixed(2)}ms`.padStart(9)}${`${t.p95.toFixed(2)}ms`.padStart(9)}${`${t.max.toFixed(1)}ms`.padStart(9)}${`${t.totalMs.toFixed(0)}ms`.padStart(10)}`,
    );
  }
  L("");
  L("── Leg 4: DRAIN-BATCH WRITER-LOCK HOLD (fn-744 .2 batch-tuning lever) ──");
  L(
    `  per-drain() wall-clock = max contiguous writer hold a hook INSERT waits through`,
  );
  for (const b of batchHold.batches) {
    const tag = b.batchSize === batchHold.defaultBatchSize ? " (shipped)" : "";
    L(
      `  batch=${String(b.batchSize).padStart(3)}${tag.padEnd(10)} p50 ${fmt(b.batchMs.p50)}  p95 ${fmt(b.batchMs.p95)}  p99 ${fmt(b.batchMs.p99)}  max ${fmt(b.batchMs.max)}`,
    );
  }
  L("");
  L("── VERDICT ──");
  L(`  ${dominantVerdict(cold, burst, fold)}`);
  L("══════════════════════════════════════════════════════════════════");
}

function printReplayReport(
  replay: ReplayResult,
  scale: { epics: number; events: number; source: string },
): void {
  const L = (s: string) => process.stdout.write(`${s}\n`);
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const slopeStr = (s: FoldSlope): string =>
    s.p95SlopePct === null
      ? "n/a"
      : `${s.p95SlopePct >= 0 ? "+" : ""}${s.p95SlopePct.toFixed(1)}%`;
  L("");
  L("══ serve-fold-load: REPLAY-FROM-ZERO ═════════════════════════════");
  L(`source: ${scale.source}`);
  L(
    `events=${scale.events}  epics(rebuilt)=${scale.epics}  batch=${replay.batchSize}  wal_checkpoints=${replay.checkpoints}`,
  );
  L("");
  L("── TOTAL REPLAY ──");
  L(
    `  wall clock ${secs(replay.wallMs)}  → budget ${replay.exceedsBudget ? "EXCEEDED (>10min)" : "OK (<10min)"}`,
  );
  L(
    `  per-fold   p50 ${fmt(replay.perFoldMs.p50)}  p95 ${fmt(replay.perFoldMs.p95)}  p99 ${fmt(replay.perFoldMs.p99)}  max ${fmt(replay.perFoldMs.max)}`,
  );
  L("");
  L("── TWO-POINT SLOPE (first half vs second half of corpus) ──");
  L(
    `  offender threshold: per-event p95 slope > ${SLOPE_OFFENDER_PCT}% between halves`,
  );
  L(
    `  overall    p95 1st ${fmt(replay.overall.first.p95)}  p95 2nd ${fmt(replay.overall.second.p95)}  slope ${slopeStr(replay.overall)}${replay.overall.offender ? "  <-- OFFENDER" : ""}`,
  );
  L("");
  L(`  by hook_event (p95 1st-half -> 2nd-half):`);
  L(
    `    ${"event".padEnd(24)}${"n".padStart(9)}${"p95(1)".padStart(10)}${"p95(2)".padStart(10)}${"slope".padStart(9)}${"total".padStart(11)}  flag`,
  );
  for (const s of replay.byKind) {
    const n = s.first.n + s.second.n;
    const total = replay.totalMsByKind.get(s.kind) ?? 0;
    L(
      `    ${s.kind.padEnd(24)}${String(n).padStart(9)}${fmt(s.first.p95).padStart(10)}${fmt(s.second.p95).padStart(10)}${slopeStr(s).padStart(9)}${`${total.toFixed(0)}ms`.padStart(11)}  ${s.offender ? "OFFENDER" : ""}`,
    );
  }
  L("");
  L("── VERDICT ──");
  const offenders = replay.byKind.filter((s) => s.offender).map((s) => s.kind);
  if (offenders.length === 0 && !replay.exceedsBudget) {
    L("  CLEAN: no fold breaches the slope or wall-clock thresholds.");
  } else {
    if (offenders.length > 0)
      L(
        `  SLOPE OFFENDERS (>${SLOPE_OFFENDER_PCT}% p95 growth): ${offenders.join(", ")}`,
      );
    if (replay.exceedsBudget)
      L(
        `  WALL-CLOCK OFFENDER: total replay ${secs(replay.wallMs)} > 10min budget.`,
      );
    L(
      "  → task .2 must remediate with a sanctioned shape or explicitly justify.",
    );
  }
  L("══════════════════════════════════════════════════════════════════");
}

async function main(argv: string[]): Promise<void> {
  let args: Args | "help";
  try {
    args = parse(argv);
  } catch (err) {
    process.stderr.write(
      `serve-fold-load: ${(err as Error).message}\n\n${HELP}`,
    );
    process.exit(1);
  }
  if (args === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  let dbPath: string;
  let tmpDir: string | null = null;
  let source: string;

  if (args.db) {
    dbPath = args.db;
    source = `live copy ${args.db}`;
  } else {
    tmpDir = mkdtempSync(join(tmpdir(), "keeper-serve-fold-load-"));
    dbPath = join(tmpDir, "keeper.db");
    const { db } = openDb(dbPath, { readonly: false });
    const rng = makeRng(args.seed);
    synthesizeEpics(db, args.epics, rng);
    synthesizeEvents(db, args.foldEvents, rng);
    db.close();
    source = `synthesized (seed=${args.seed})`;
  }

  // Serve/diff legs: read the projection. Fold leg: needs a writable handle.
  // A single writable connection serves all three (the serve/diff legs only
  // read; opening writable matches the fold leg's need without a second open).
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const epicCount = (
      db.query(`SELECT COUNT(*) c FROM epics`).get() as { c: number }
    ).c;
    const eventCount = (
      db.query(`SELECT COUNT(*) c FROM events`).get() as { c: number }
    ).c;

    // Replay-from-zero is a distinct, DESTRUCTIVE mode: it wipes + rebuilds the
    // deterministic projections, so it runs INSTEAD of the four serve/fold legs
    // (which measure the projection as-is). Rebuilt epics count is read after.
    if (args.replayFromZero) {
      const replay = measureReplayFromZero(db, args.replayBatch);
      const rebuiltEpics = (
        db.query(`SELECT COUNT(*) c FROM epics`).get() as { c: number }
      ).c;
      if (args.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              mode: "replay-from-zero",
              source,
              scale: { epics: rebuiltEpics, events: eventCount },
              args,
              replay: {
                ...replay,
                totalMsByKind: Object.fromEntries(replay.totalMsByKind),
              },
            },
            null,
            2,
          )}\n`,
        );
      } else {
        printReplayReport(replay, {
          epics: rebuiltEpics,
          events: eventCount,
          source,
        });
      }
      return;
    }

    const cold = measureColdConnect(db, args.iterations);
    const burst = measureUpdateBurst(
      db,
      args.subscribers,
      args.burst,
      args.iterations,
    );
    const fold = measureFold(db, args.foldEvents);
    // Leg 4 — compare the shipped DEFAULT_BATCH_SIZE against the pre-fn-744 .2
    // 200-event control on the SAME tail window so the batch-tuning win is
    // explicit. MUST run AFTER measureFold (both advance the cursor; this leg
    // saves+restores it, but running it last keeps the fold leg's window clean).
    const batchHold = measureBatchHold(db, args.foldEvents, [
      DEFAULT_BATCH_SIZE,
      200,
    ]);

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            source,
            scale: { epics: epicCount, events: eventCount },
            args,
            coldConnect: cold,
            updateBurst: burst,
            fold,
            batchHold,
            verdict: dominantVerdict(cold, burst, fold),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      printReport(
        args,
        { epics: epicCount, events: eventCount, source },
        cold,
        burst,
        fold,
        batchHold,
      );
    }
  } finally {
    db.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
