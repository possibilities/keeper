/**
 * Tests for `src/exit-watcher.ts`. Two layers:
 *
 * 1. `diffLoop` against a real two-connection DB + a mocked ExitWatcher —
 *    verifies the data_version diff fires `onTick` with the correct
 *    candidate set on commits by another connection, and resolves cleanly
 *    when `isShutdown` flips. The "watch-set diff + alreadyDead → exit
 *    message" wiring is exercised in the same test by driving the diff
 *    callback directly (no real Worker thread needed).
 *
 * 2. A real spawned Worker shuts down cleanly on `{ type: "shutdown" }` —
 *    proves the FFI fd release runs in the worker's own shutdown handler
 *    and the worker actually exits (the kqueue/pidfd carve-out requires
 *    the resource to release before terminate()). This runs only on
 *    platforms the FFI module supports.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  diffLoop,
  type ReprobeRow,
  reprobeLoop,
  type SentinelMemoEntry,
  type SentinelRow,
  STUCK_SENTINEL_SKEW_EPSILON_SECS,
  STUCK_TIER1_MIN_AGE_SECS,
  STUCK_TIER2_MIN_AGE_SECS,
  type StuckSentinelMessage,
  selectDeadReprobeCandidates,
  selectStuckSentinelVerdicts,
  sentinelLoop,
  sentinelReason,
  shouldEmitSentinel,
} from "../src/exit-watcher";
import type {
  AddResult,
  ExitWatcher,
  WaitResult,
} from "../src/exit-watcher-ffi";
import { retryUntil } from "./helpers/retry-until";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-exit-watcher-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // Bootstrap the schema with a writer so the readonly connection can open.
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Seed a `jobs` row directly (bypassing the events log). Mirrors the helper
 * in `test/daemon.test.ts` — the diffLoop reads `jobs`, so we don't need to
 * route through the reducer to set up the candidate set.
 */
function seedJobsRow(
  db: ReturnType<typeof openDb>["db"],
  jobId: string,
  pid: number | null,
  startTime: string | null,
  state = "stopped",
): void {
  db.run(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id,
                       updated_at, title, title_source, transcript_path, start_time)
       VALUES (?, ?, NULL, ?, ?, 0, ?, NULL, NULL, NULL, ?)`,
    [jobId, 0, pid, state, 0, startTime],
  );
}

// ---------------------------------------------------------------------------
// diffLoop — data_version-driven candidate-set diff
// ---------------------------------------------------------------------------

test("diffLoop fires onTick once at boot and again on each commit by another connection", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;
  const ticks: {
    job_id: string;
    pid: number | null;
    start_time: string | null;
  }[][] = [];
  let shutdown = false;

  // Seed an initial candidate row so the boot tick is non-empty.
  seedJobsRow(writer, "sess-pre-boot", 4242, "darwin:foo");

  const loop = diffLoop(
    reader,
    (rows) => {
      ticks.push(rows.slice());
    },
    () => shutdown,
    25,
  );

  // Boot tick fires synchronously inside diffLoop — give the event loop one
  // turn to let the awaited Bun.sleep enter the polling phase.
  await Bun.sleep(50);

  // A SEPARATE writer commit (another seed) must drive a second tick that
  // observes BOTH rows (positive gate).
  seedJobsRow(writer, "sess-after-boot", 5252, "darwin:bar");
  await retryUntil(() => {
    const last = ticks[ticks.length - 1];
    return last && last.length === 2 ? last : null;
  });

  shutdown = true;
  await loop;

  // Boot tick: just the pre-boot row.
  expect(ticks.length).toBeGreaterThanOrEqual(1);
  expect(ticks[0]).toContainEqual({
    job_id: "sess-pre-boot",
    pid: 4242,
    start_time: "darwin:foo",
  });

  // At least one subsequent tick saw both rows.
  const afterRows = ticks[ticks.length - 1];
  const jobIds = afterRows.map((r) => r.job_id).sort();
  expect(jobIds).toEqual(["sess-after-boot", "sess-pre-boot"]);

  writer.close();
  reader.close();
});

test("diffLoop emits all non-terminal rows INCLUDING NULL-pid ones (fn-743)", async () => {
  // fn-743 dropped the old `pid IS NOT NULL` exclusion: a NULL-pid stopped row
  // is the stuck-`stopped` incident (unwatchable, lived forever). The diff loop
  // now surfaces it so `diffTick` can reap it via a pidless exit message.
  // Terminal rows (ended/killed) stay out of the candidate set.
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;
  let lastTick:
    | { job_id: string; pid: number | null; start_time: string | null }[]
    | null = null;
  let shutdown = false;

  // Mixed: alive working, alive stopped, ended (out), killed (out), NULL-pid
  // stopped (NOW IN — reaped via the pidless path), NULL-pid ended (out).
  seedJobsRow(writer, "sess-working", 1001, "darwin:a", "working");
  seedJobsRow(writer, "sess-stopped", 1002, "darwin:b", "stopped");
  seedJobsRow(writer, "sess-ended", 1003, "darwin:c", "ended");
  seedJobsRow(writer, "sess-killed", 1004, "darwin:d", "killed");
  seedJobsRow(writer, "sess-no-pid", null, null, "stopped");
  seedJobsRow(writer, "sess-no-pid-ended", null, null, "ended");

  const loop = diffLoop(
    reader,
    (rows) => {
      lastTick = rows.slice();
    },
    () => shutdown,
    25,
  );

  // Wait for the boot tick to capture all three non-terminal rows (positive gate).
  await retryUntil(() => (lastTick && lastTick.length === 3 ? lastTick : null));
  shutdown = true;
  await loop;

  expect(lastTick).not.toBeNull();
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
  const ids = lastTick!.map((r) => r.job_id).sort();
  // NULL-pid STOPPED row is in; terminal rows (pid-bearing or NULL) are out.
  expect(ids).toEqual(["sess-no-pid", "sess-stopped", "sess-working"]);
  // The NULL-pid candidate carries pid === null (the diffTick pidless arm keys
  // off this to reap-on-sight rather than arm the kernel watcher).
  // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
  const noPidRow = lastTick!.find((r) => r.job_id === "sess-no-pid");
  expect(noPidRow?.pid).toBeNull();

  writer.close();
  reader.close();
});

test("diffLoop resolves once isShutdown flips with no writes", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  let ticks = 0;
  let shutdown = false;

  const loop = diffLoop(
    reader,
    () => {
      ticks += 1;
    },
    () => shutdown,
    25,
  );

  // Boot tick fires synchronously; subsequent ticks require commits.
  await Bun.sleep(80);
  shutdown = true;
  await loop; // must resolve, not hang

  // Exactly the boot tick (empty rows, no commits drove additional ticks).
  expect(ticks).toBe(1);
  reader.close();
});

// ---------------------------------------------------------------------------
// Watch-set diff against a mocked ExitWatcher — the alreadyDead short-circuit
// ---------------------------------------------------------------------------

/**
 * Build a mock ExitWatcher whose `add()` returns a programmable result per
 * call (so a test can drive the alreadyDead branch deterministically) and
 * whose `wait()` blocks on a controlled resolver. The mock records every
 * call for assertion.
 */
function buildMockWatcher(scriptedAdd: AddResult[]): {
  watcher: ExitWatcher;
  addCalls: { pid: number; udata: bigint }[];
  closed: () => boolean;
} {
  const addCalls: { pid: number; udata: bigint }[] = [];
  let closed = false;
  const watcher: ExitWatcher = {
    add(pid, udata) {
      addCalls.push({ pid, udata });
      const next = scriptedAdd.shift();
      return next ?? { registered: true };
    },
    async wait(timeoutMs): Promise<WaitResult> {
      // Park for the requested slice so the diff loop drives the show.
      await Bun.sleep(Math.min(timeoutMs, 50));
      return { kind: "timeout" };
    },
    wake() {
      // no-op for the mock
    },
    close() {
      closed = true;
    },
  };
  return { watcher, addCalls, closed: () => closed };
}

test("diffLoop+mock: every new candidate row triggers exactly one add()", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;
  const { watcher, addCalls } = buildMockWatcher([]);

  // Track which job ids the diff has already registered, to mirror the
  // worker's own dedup behavior.
  const tracked = new Set<string>();
  let shutdown = false;

  seedJobsRow(writer, "sess-a", 7001, "darwin:a");

  const loop = diffLoop(
    reader,
    (rows) => {
      for (const r of rows) {
        // Mirror the worker's pidless skip (fn-743): NULL-pid rows are reaped
        // on sight, never armed in the kernel.
        if (r.pid != null && !tracked.has(r.job_id)) {
          tracked.add(r.job_id);
          watcher.add(r.pid, BigInt(addCalls.length + 1));
        }
      }
    },
    () => shutdown,
    25,
  );

  // Boot tick: sess-a only.
  await Bun.sleep(50);
  seedJobsRow(writer, "sess-b", 7002, "darwin:b");
  // Wait for the sess-b add (positive gate) before re-triggering.
  await retryUntil(() => (addCalls.some((c) => c.pid === 7002) ? true : null));
  // Re-trigger another commit to confirm no DUPLICATE add for sess-a.
  writer.run(
    "UPDATE jobs SET last_event_id = last_event_id + 1 WHERE job_id = 'sess-a'",
  );
  // Settle: the re-trigger must NOT fire a second add for sess-a (dedup
  // negative — only a wait can disprove a duplicate).
  await Bun.sleep(80);

  shutdown = true;
  await loop;

  // One add per unique pid, in arrival order.
  expect(addCalls.map((c) => c.pid).sort()).toEqual([7001, 7002]);
  watcher.close();
  writer.close();
  reader.close();
});

// ---------------------------------------------------------------------------
// selectDeadReprobeCandidates — pure predicate, clause by clause
// ---------------------------------------------------------------------------

const NOW = 1_000_000; // arbitrary wall-clock seconds for the predicate tests.
const OLD_ENOUGH = NOW - 5 * 60; // exactly at the age gate (eligible: >=).
const TOO_FRESH = NOW - (5 * 60 - 1); // one second under the gate.

/** Build a ReprobeRow with sane defaults; override per clause. */
function rrow(over: Partial<ReprobeRow> = {}): ReprobeRow {
  return {
    job_id: "sess",
    pid: 4242,
    start_time: "darwin:start",
    created_at: OLD_ENOUGH,
    ...over,
  };
}

const allDead = () => false;
const allAlive = () => true;
const neverProbe = (): string | null => {
  throw new Error("readStartTime must not be called");
};

test("predicate: dead pid past the age gate folds with reason=dead", () => {
  const out = selectDeadReprobeCandidates(
    [rrow({ pid: 4242, start_time: "darwin:s" })],
    NOW,
    allDead,
    neverProbe, // dead path must NOT consult readStartTime
  );
  expect(out).toEqual([
    { jobId: "sess", pid: 4242, startTime: "darwin:s", reason: "dead" },
  ]);
});

test("predicate: age gate is inclusive — created_at exactly at threshold is eligible", () => {
  const out = selectDeadReprobeCandidates(
    [rrow({ created_at: OLD_ENOUGH })],
    NOW,
    allDead,
    neverProbe,
  );
  expect(out.map((c) => c.reason)).toEqual(["dead"]);
});

test("predicate: a row one second under the age gate is NOT reaped even if dead", () => {
  const out = selectDeadReprobeCandidates(
    [rrow({ created_at: TOO_FRESH })],
    NOW,
    allDead, // dead, but too fresh
    neverProbe,
  );
  expect(out).toEqual([]);
});

test("predicate: alive pid with a recycled (mismatched) start_time folds with reason=recycled", () => {
  const out = selectDeadReprobeCandidates(
    [rrow({ pid: 50, start_time: "darwin:original" })],
    NOW,
    allAlive,
    () => "darwin:DIFFERENT", // OS reports a different start_time → recycled
  );
  expect(out).toEqual([
    {
      jobId: "sess",
      pid: 50,
      startTime: "darwin:original", // STORED, not the live recycler's
      reason: "recycled",
    },
  ]);
});

test("predicate: alive pid with a matching start_time is left alone", () => {
  const out = selectDeadReprobeCandidates(
    [rrow({ pid: 50, start_time: "darwin:same" })],
    NOW,
    allAlive,
    () => "darwin:same",
  );
  expect(out).toEqual([]);
});

test("predicate: alive pid with NULL stored start_time is left alone (can't prove recycle)", () => {
  const out = selectDeadReprobeCandidates(
    [rrow({ pid: 50, start_time: null })],
    NOW,
    allAlive,
    neverProbe, // start_time NULL → readStartTime never reached
  );
  expect(out).toEqual([]);
});

test("predicate: alive pid whose start_time probe fails (null) is left alone", () => {
  const out = selectDeadReprobeCandidates(
    [rrow({ pid: 50, start_time: "darwin:stored" })],
    NOW,
    allAlive,
    () => null, // probe failure → conservative leave-alone
  );
  expect(out).toEqual([]);
});

test("predicate: NULL-pid rows are out of scope (the diff loop's pidless arm owns them)", () => {
  const out = selectDeadReprobeCandidates(
    [rrow({ pid: null })],
    NOW,
    allDead,
    neverProbe,
  );
  expect(out).toEqual([]);
});

// ---------------------------------------------------------------------------
// reprobeLoop — live-DB integration: a dead-pid stopped row mints an exit msg,
// and a re-sweep of the now-killed row is a no-op
// ---------------------------------------------------------------------------

/** Seed a row with an explicit created_at (the age gate keys on it). */
function seedJobsRowAt(
  db: ReturnType<typeof openDb>["db"],
  jobId: string,
  pid: number | null,
  startTime: string | null,
  createdAt: number,
  state = "stopped",
): void {
  db.run(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id,
                       updated_at, title, title_source, transcript_path, start_time)
       VALUES (?, ?, NULL, ?, ?, 0, ?, NULL, NULL, NULL, ?)`,
    [jobId, createdAt, pid, state, createdAt, startTime],
  );
}

test("reprobeLoop posts an exit message for a dead-pid stopped row past the age gate", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;

  const nowSecs = 2_000_000;
  // Old enough (created well before the gate) + a pid we declare dead.
  seedJobsRowAt(writer, "sess-dead", 8888, "darwin:victim", nowSecs - 3600);
  // A fresh row with the same dead pid must NOT be reaped (age gate).
  seedJobsRowAt(writer, "sess-fresh", 8889, "darwin:fresh", nowSecs - 10);

  const posted: { jobId: string; pid: number | null }[] = [];
  let shutdown = false;
  const loop = reprobeLoop(
    reader,
    (msg) => posted.push({ jobId: msg.jobId, pid: msg.pid }),
    () => shutdown,
    {
      intervalMs: 25,
      nowSecs: () => nowSecs,
      isAlive: (pid) => pid !== 8888 && pid !== 8889, // both dead
      readStartTime: () => null,
    },
  );

  // Wait for at least one tick to post the dead candidate.
  const got = await retryUntil(
    () => (posted.length > 0 ? posted : null),
    5_000,
  );
  shutdown = true;
  await loop;

  expect(got).not.toBeNull();
  expect(got?.map((p) => p.jobId)).toEqual(["sess-dead"]);
  expect(got?.[0]?.pid).toBe(8888);

  writer.close();
  reader.close();
});

test("reprobeLoop: a re-sweep of a row that left the candidate set is a no-op", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;

  const nowSecs = 2_000_000;
  seedJobsRowAt(
    writer,
    "sess-killed",
    7777,
    "darwin:k",
    nowSecs - 3600,
    "killed",
  );

  const posted: string[] = [];
  let shutdown = false;
  const loop = reprobeLoop(
    reader,
    (msg) => posted.push(msg.jobId),
    () => shutdown,
    {
      intervalMs: 25,
      nowSecs: () => nowSecs,
      isAlive: () => false, // would reap if it were a candidate
      readStartTime: () => null,
    },
  );

  // Give it several ticks — a 'killed' row is outside the candidate query, so
  // nothing should ever be posted.
  await Bun.sleep(120);
  shutdown = true;
  await loop;

  expect(posted).toEqual([]);

  writer.close();
  reader.close();
});

// ---------------------------------------------------------------------------
// selectStuckSentinelVerdicts (ADR 0013 layer 3) — pure predicate, clause by
// clause. Every DB read is resolved into the row upstream, so the predicate is
// driven with plain values + injected liveness.
// ---------------------------------------------------------------------------

const SNOW = 1_000_000; // arbitrary wall-clock seconds for the sentinel tests.
const STALE_T1 = SNOW - STUCK_TIER1_MIN_AGE_SECS; // age EXACTLY at the tier-1 gate.
const STALE_T2 = SNOW - STUCK_TIER2_MIN_AGE_SECS; // age EXACTLY at the tier-2 gate.
const FRESH_EVT = SNOW - 60; // 1 min old — not stale.
const MID_STALE = SNOW - 30 * 60; // 30 min — past tier-1, under tier-2.
const FUTURE_SKEW = SNOW + STUCK_SENTINEL_SKEW_EPSILON_SECS + 100; // implausible.

/** Build a SentinelRow with sane (not-stuck) defaults; override per clause. */
function srow(over: Partial<SentinelRow> = {}): SentinelRow {
  return {
    jobId: "sess",
    pid: 4242,
    lastEventTs: FRESH_EVT,
    lastLifecycleTs: FRESH_EVT,
    workerDone: false,
    hasFreshSubagent: false,
    planRef: "fn-9-x.1",
    adopted: false,
    ...over,
  };
}

const sAlive = () => true;
const sDead = () => false;

test("sentinel predicate: worker-done + stale + live pid + no subagent → TIER ONE heal", () => {
  const out = selectStuckSentinelVerdicts(
    [
      srow({
        workerDone: true,
        lastEventTs: STALE_T1,
        lastLifecycleTs: STALE_T1,
      }),
    ],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([
    {
      jobId: "sess",
      tier: 1,
      heal: true,
      reason: "stuck-sentinel: worker-done-while-working",
    },
  ]);
});

test("sentinel predicate: tier-one age gate is inclusive (age == threshold heals) and exclusive one second under", () => {
  // Exactly at the gate → heal.
  expect(
    selectStuckSentinelVerdicts(
      [srow({ workerDone: true, lastEventTs: STALE_T1 })],
      SNOW,
      sAlive,
    ).map((v) => v.tier),
  ).toEqual([1]);
  // One second fresher than the gate → not tier one, and under tier two → skip.
  expect(
    selectStuckSentinelVerdicts(
      [
        srow({
          workerDone: true,
          lastEventTs: SNOW - (STUCK_TIER1_MIN_AGE_SECS - 1),
        }),
      ],
      SNOW,
      sAlive,
    ),
  ).toEqual([]);
});

test("sentinel predicate: a fresh in-flight subagent is NEVER healed (tier-one exclusion)", () => {
  const out = selectStuckSentinelVerdicts(
    [srow({ workerDone: true, lastEventTs: STALE_T1, hasFreshSubagent: true })],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([]);
});

test("sentinel predicate: worker-done but recent events is never corrected", () => {
  const out = selectStuckSentinelVerdicts(
    [srow({ workerDone: true, lastEventTs: FRESH_EVT })],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([]);
});

test("sentinel predicate: a DEAD pid is skipped (the exit-watcher's reap — producers stay disjoint)", () => {
  const out = selectStuckSentinelVerdicts(
    [srow({ workerDone: true, lastEventTs: STALE_T1 })],
    SNOW,
    sDead, // pid dead → out of scope for the sentinel
  );
  expect(out).toEqual([]);
});

test("sentinel predicate: no worker-done + VERY stale → TIER TWO detect-only (heal false)", () => {
  const out = selectStuckSentinelVerdicts(
    [srow({ workerDone: false, lastEventTs: STALE_T2 })],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([
    {
      jobId: "sess",
      tier: 2,
      heal: false,
      reason: "stuck-sentinel: stale-working",
    },
  ]);
});

test("sentinel predicate: no worker-done + only MID-stale (past tier-1, under tier-2) → skip", () => {
  const out = selectStuckSentinelVerdicts(
    [srow({ workerDone: false, lastEventTs: MID_STALE })],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([]);
});

test("sentinel predicate: tier-two age gate is inclusive", () => {
  expect(
    selectStuckSentinelVerdicts(
      [srow({ lastEventTs: STALE_T2 })],
      SNOW,
      sAlive,
    ).map((v) => v.tier),
  ).toEqual([2]);
  expect(
    selectStuckSentinelVerdicts(
      [srow({ lastEventTs: SNOW - (STUCK_TIER2_MIN_AGE_SECS - 1) })],
      SNOW,
      sAlive,
    ),
  ).toEqual([]);
});

test("sentinel predicate: NULL lastEventTs (no events) → skip (staleness uncomputable)", () => {
  const out = selectStuckSentinelVerdicts(
    [srow({ workerDone: true, lastEventTs: null })],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([]);
});

test("sentinel predicate: NULL pid → skip (the diff loop's pidless arm owns it)", () => {
  const out = selectStuckSentinelVerdicts(
    [srow({ workerDone: true, lastEventTs: STALE_T1, pid: null })],
    SNOW,
    sDead, // never consulted for a null pid
  );
  expect(out).toEqual([]);
});

test("sentinel predicate: an implausibly-future event clock with no staleness trip → clock-skew detect", () => {
  const out = selectStuckSentinelVerdicts(
    [
      srow({
        workerDone: false,
        lastEventTs: FUTURE_SKEW, // ahead of wall clock → age negative, not stale
        lastLifecycleTs: FUTURE_SKEW,
      }),
    ],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([
    {
      jobId: "sess",
      tier: 2,
      heal: false,
      reason: "stuck-sentinel: clock-skew",
    },
  ]);
});

test("sentinel predicate: a far-future STAMP annotates a firing tier's reason with clock-skew", () => {
  // A tier-two stale row (its last event is genuinely old) whose lifecycle stamp
  // is pinned implausibly far in the future — the phantom far-future signature.
  const out = selectStuckSentinelVerdicts(
    [srow({ lastEventTs: STALE_T2, lastLifecycleTs: FUTURE_SKEW })],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([
    {
      jobId: "sess",
      tier: 2,
      heal: false,
      reason: "stuck-sentinel: stale-working (clock-skew)",
    },
  ]);
});

test("sentinel predicate: a stale-working row with NO plan linkage mints no tier-two ack-row (interactive carve-out)", () => {
  const out = selectStuckSentinelVerdicts(
    [srow({ workerDone: false, lastEventTs: STALE_T2, planRef: null })],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([]);
});

test("sentinel predicate: a stale-working ADOPTED row mints no tier-two ack-row even if plan_ref is somehow set", () => {
  const out = selectStuckSentinelVerdicts(
    [
      srow({
        workerDone: false,
        lastEventTs: STALE_T2,
        planRef: "fn-9-x.1",
        adopted: true,
      }),
    ],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([]);
});

test("sentinel predicate: a stale-working PLAN-LINKED row still mints its tier-two ack-row", () => {
  const out = selectStuckSentinelVerdicts(
    [
      srow({
        workerDone: false,
        lastEventTs: STALE_T2,
        planRef: "fn-9-x.1",
        adopted: false,
      }),
    ],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([
    {
      jobId: "sess",
      tier: 2,
      heal: false,
      reason: "stuck-sentinel: stale-working",
    },
  ]);
});

test("sentinel predicate: tier-one self-heal fires for a plan_ref-null (interactive/adopted) row too — unchanged for all session kinds", () => {
  const out = selectStuckSentinelVerdicts(
    [
      srow({
        workerDone: true,
        lastEventTs: STALE_T1,
        planRef: null,
        adopted: true,
      }),
    ],
    SNOW,
    sAlive,
  );
  expect(out).toEqual([
    {
      jobId: "sess",
      tier: 1,
      heal: true,
      reason: "stuck-sentinel: worker-done-while-working",
    },
  ]);
});

// ---------------------------------------------------------------------------
// sentinelReason — the class-stable reason builder
// ---------------------------------------------------------------------------

test("sentinelReason: class-stable, with a clock-skew suffix only when observed", () => {
  expect(sentinelReason("worker-done-while-working", false)).toBe(
    "stuck-sentinel: worker-done-while-working",
  );
  expect(sentinelReason("worker-done-while-working", true)).toBe(
    "stuck-sentinel: worker-done-while-working (clock-skew)",
  );
  expect(sentinelReason("stale-working", false)).toBe(
    "stuck-sentinel: stale-working",
  );
  // The clock-skew CLASS never double-appends its own suffix.
  expect(sentinelReason("clock-skew", true)).toBe("stuck-sentinel: clock-skew");
});

// ---------------------------------------------------------------------------
// shouldEmitSentinel — the change-gate (first-detect + reason-change + bounded
// still-stuck re-emit), so a persistent condition emits O(1), not per tick.
// ---------------------------------------------------------------------------

test("shouldEmitSentinel: first appearance emits", () => {
  expect(shouldEmitSentinel(undefined, "stuck-sentinel: x", 1000, 10_000)).toBe(
    true,
  );
});

test("shouldEmitSentinel: same reason inside the re-emit window is suppressed", () => {
  const prev: SentinelMemoEntry = {
    reason: "stuck-sentinel: x",
    lastEmitMs: 1000,
  };
  expect(
    shouldEmitSentinel(prev, "stuck-sentinel: x", 1000 + 9_999, 10_000),
  ).toBe(false);
});

test("shouldEmitSentinel: a reason-change re-emits immediately (e.g. skew newly observed)", () => {
  const prev: SentinelMemoEntry = {
    reason: "stuck-sentinel: stale-working",
    lastEmitMs: 1000,
  };
  expect(
    shouldEmitSentinel(
      prev,
      "stuck-sentinel: stale-working (clock-skew)",
      1000 + 5,
      10_000,
    ),
  ).toBe(true);
});

test("shouldEmitSentinel: same reason re-emits once the bounded interval elapses", () => {
  const prev: SentinelMemoEntry = {
    reason: "stuck-sentinel: x",
    lastEmitMs: 1000,
  };
  expect(
    shouldEmitSentinel(prev, "stuck-sentinel: x", 1000 + 10_000, 10_000),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// sentinelLoop — live-DB integration: a worker-done working row with stale
// events + a live pid heals ONCE (change-gated across ticks).
// ---------------------------------------------------------------------------

/** Seed a `working` plan `work` job the sentinel sweep will pick up. */
function seedWorkingPlanJob(
  db: ReturnType<typeof openDb>["db"],
  jobId: string,
  pid: number,
  planRef: string,
  lastLifecycleTs: number,
): void {
  db.run(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id,
                       updated_at, plan_verb, plan_ref, last_lifecycle_ts)
       VALUES (?, ?, NULL, ?, 'working', 0, ?, 'work', ?, ?)`,
    [jobId, lastLifecycleTs, pid, lastLifecycleTs, planRef, lastLifecycleTs],
  );
}

/** Seed the epic whose embedded tasks carry the worker-done signal. */
function seedEpicWithTask(
  db: ReturnType<typeof openDb>["db"],
  epicId: string,
  taskId: string,
  workerPhase: string,
): void {
  const tasks = JSON.stringify([
    { task_id: taskId, worker_phase: workerPhase },
  ]);
  db.run(
    `INSERT INTO epics (epic_id, status, updated_at, tasks) VALUES (?, 'open', 0, ?)`,
    [epicId, tasks],
  );
}

/** Seed one raw event so `MAX(ts)` gives the session its staleness anchor. */
function seedEvent(
  db: ReturnType<typeof openDb>["db"],
  jobId: string,
  ts: number,
): void {
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type)
       VALUES (?, ?, 'PostToolUse', 'PostToolUse')`,
    [ts, jobId],
  );
}

test("sentinelLoop: a worker-done working row with stale events heals ONCE (change-gated)", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;

  const nowSecs = 2_000_000;
  seedEpicWithTask(writer, "fn-9-x", "fn-9-x.1", "done");
  seedWorkingPlanJob(writer, "sess-stuck", 6001, "fn-9-x.1", nowSecs - 3600);
  seedEvent(writer, "sess-stuck", nowSecs - 3600); // ~1h stale

  const posted: StuckSentinelMessage[] = [];
  let shutdown = false;
  const loop = sentinelLoop(
    reader,
    (msg) => posted.push(msg),
    () => shutdown,
    {
      intervalMs: 25,
      // Large re-emit window so a persistent condition never re-emits within the
      // test — proves the change-gate suppresses per-tick spam.
      reemitMs: 10 * 60_000,
      nowSecs: () => nowSecs,
      isAlive: (pid) => pid === 6001, // the stuck pid is alive
    },
  );

  const got = await retryUntil(
    () => (posted.length > 0 ? posted : null),
    5_000,
  );
  // Give the loop several MORE ticks to prove the change-gate holds it at one.
  await Bun.sleep(150);
  shutdown = true;
  await loop;

  expect(got).not.toBeNull();
  expect(posted.length).toBe(1); // change-gated — exactly one emission.
  expect(posted[0]?.jobId).toBe("sess-stuck");
  expect(posted[0]?.heal).toBe(true);
  expect(posted[0]?.reason).toBe("stuck-sentinel: worker-done-while-working");

  writer.close();
  reader.close();
});

/** Seed a `working` interactive job (no plan linkage) with no live pid tie. */
function seedWorkingInteractiveJob(
  db: ReturnType<typeof openDb>["db"],
  jobId: string,
  pid: number,
  lastLifecycleTs: number,
  adopted: number | null = null,
): void {
  db.run(
    `INSERT INTO jobs (job_id, created_at, cwd, pid, state, last_event_id,
                       updated_at, plan_verb, plan_ref, last_lifecycle_ts, adopted)
       VALUES (?, ?, NULL, ?, 'working', 0, ?, NULL, NULL, ?, ?)`,
    [jobId, lastLifecycleTs, pid, lastLifecycleTs, lastLifecycleTs, adopted],
  );
}

test("sentinelLoop: a parked-idle interactive session (no plan_ref) past the tier-two floor mints NO ack-row", async () => {
  const reader = openDb(dbPath, { readonly: true }).db;
  const writer = openDb(dbPath).db;

  const nowSecs = 3_000_000;
  seedWorkingInteractiveJob(writer, "sess-idle-human", 6002, nowSecs - 3600);
  seedEvent(writer, "sess-idle-human", nowSecs - 3600); // ~1h stale, past tier-two

  const posted: StuckSentinelMessage[] = [];
  let shutdown = false;
  const loop = sentinelLoop(
    reader,
    (msg) => posted.push(msg),
    () => shutdown,
    {
      intervalMs: 25,
      reemitMs: 10 * 60_000,
      nowSecs: () => nowSecs,
      isAlive: (pid) => pid === 6002,
    },
  );

  // Give the loop several ticks to prove it never emits for this row.
  await Bun.sleep(150);
  shutdown = true;
  await loop;

  expect(posted).toEqual([]);

  writer.close();
  reader.close();
});
