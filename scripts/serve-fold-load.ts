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
import { openDb } from "../src/db";
import { applyEvent, DEFAULT_BATCH_SIZE, drain } from "../src/reducer";
import {
  diffTick,
  resolveFilter,
  runQuery,
  type SubState,
  type Writable,
} from "../src/server-worker";

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
  --json               Emit the full report as JSON.
  --help, -h           Show this help.

Measures cold-connect, update-under-burst, and per-fold latency at live scale and
names the dominant cost. Standalone (synthesizes a live-size projection) unless
--db points at a COPY of a real keeper.db. NEVER pass the live keeper.db.
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
  return {
    n: values.length,
    p50: pct(values, 0.5),
    p95: pct(values, 0.95),
    p99: pct(values, 0.99),
    max: values.length ? Math.max(...values) : Number.NaN,
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
      `SELECT events.id AS id, ts, session_id, pid, hook_event, event_type,
              tool_name, matcher, cwd, permission_mode, agent_id, agent_type,
              stop_hook_active, data, subagent_agent_id, spawn_name, start_time,
              slash_command, skill_name, planctl_op, planctl_target,
              planctl_epic_id, planctl_task_id, planctl_subject_present,
              tool_use_id, config_dir, planctl_files, backend_exec_type,
              backend_exec_session_id, backend_exec_pane_id
         FROM events
        WHERE events.id > ?
        ORDER BY events.id ASC
        LIMIT ?`,
    )
    // biome-ignore lint/suspicious/noExplicitAny: raw Event-shaped rows for applyEvent
    .all(from, windowSize) as any[];

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
