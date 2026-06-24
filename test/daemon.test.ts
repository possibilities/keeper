/**
 * Daemon boot-drain test. Verifies the catch-up path independent of the wake
 * mechanism: pre-seed the `events` table, then drive `drainToCompletion`
 * directly against a tmp DB (no Worker spawned — `daemon.ts` is import-safe
 * behind its `import.meta.main` guard). The full wake-worker → reducer
 * round-trip is covered by the end-to-end integration test.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectAutopilotPaused } from "../cli/autopilot";
import {
  appendBackstopRecord,
  BackstopCounters,
} from "../src/backstop-telemetry";
import {
  ALL_WORKERS,
  BLOCK_ESCALATION_SKIP_CATEGORY,
  BLOCK_ESCALATION_SWEEP_INTERVAL_MS,
  type BlockEscalationOutcome,
  type BlockEscalationSendResult,
  type BlockEscalationSweepDeps,
  BOOT_DRAIN_CHECKPOINT_EVENT_INTERVAL,
  BOOT_DRAIN_CHECKPOINT_WAL_BYTES,
  BOOT_DRAIN_PACE_EVENTS,
  BOOT_DRAIN_PACE_MS,
  buildBlockEscalationBody,
  buildPendingDispatchSweepRecords,
  checkKeeperAgentPresence,
  type DaemonHandle,
  decideGitSeedWatchdog,
  drainToCompletion,
  effectiveBlockEscalationRepo,
  GIT_SEED_MAX_RESEED_ATTEMPTS,
  GIT_SEED_STUCK_THRESHOLD_MS,
  isTransientBusyError,
  PENDING_DISPATCH_SWEEP_INTERVAL_MS,
  PENDING_DISPATCH_TTL_MS,
  type PendingBlockEscalation,
  parseBlockedCategory,
  prewarmWatcherAddon,
  recoverOneDeadLetter,
  runBlockEscalationSweep,
  scanDeadLetterDir,
  selectExpiredPendingDispatches,
  selectPendingBlockEscalations,
  serializeUsageSnapshot,
  shouldEscalateBlockedCategory,
  startDaemon,
  WAL_AUTOCHECKPOINT_PAGES,
  type WorkerName,
  withBootDrainCheckpointTuning,
} from "../src/daemon";
import { openDb, SCHEMA_VERSION } from "../src/db";
import { serializeDeadLetterRecord } from "../src/dead-letter";
import {
  encodeFrame,
  LineBuffer,
  type RpcFrame,
  type ServerFrame,
} from "../src/protocol";
import { drain } from "../src/reducer";
import { seedKilledSweep } from "../src/seed-sweep";
import { isPidAlive } from "../src/server-worker";
import { withInProcessDaemon } from "./helpers/in-process-daemon";
import { retryUntil } from "./helpers/retry-until";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-daemon-test-"));
  dbPath = join(tmpDir, "keeper.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedEvent(
  db: ReturnType<typeof openDb>["db"],
  sessionId: string,
  hookEvent: string,
  ts: number,
  permissionMode: string | null = null,
): void {
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, permission_mode, data)
       VALUES (?, ?, ?, ?, 'lifecycle', ?, '{}')`,
    [ts, sessionId, 4242, hookEvent, permissionMode],
  );
}

test("boot drain folds a pre-seeded events table to completion", () => {
  const { db } = openDb(dbPath);

  // Pre-seed a full session lifecycle as if events accumulated during downtime.
  seedEvent(db, "sess-a", "SessionStart", 1);
  seedEvent(db, "sess-a", "UserPromptSubmit", 2, "plan");
  seedEvent(db, "sess-a", "Stop", 3);
  seedEvent(db, "sess-b", "SessionStart", 4);
  seedEvent(db, "sess-b", "SessionEnd", 5);

  // Cursor starts at 0 (fresh DB) — nothing folded yet.
  const before = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(before.last_event_id).toBe(0);

  drainToCompletion(db);

  // Cursor advanced past every seeded event.
  const after = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  expect(after.last_event_id).toBe(5);

  // Projection reflects the folded lifecycle.
  const jobA = db
    .query("SELECT state FROM jobs WHERE job_id = 'sess-a'")
    .get() as { state: string };
  expect(jobA.state).toBe("stopped");

  const jobB = db
    .query("SELECT state FROM jobs WHERE job_id = 'sess-b'")
    .get() as { state: string };
  expect(jobB.state).toBe("ended");

  db.close();
});

test("boot drain is idempotent — a second pass folds nothing", () => {
  const { db } = openDb(dbPath);
  seedEvent(db, "sess-a", "SessionStart", 1);
  seedEvent(db, "sess-a", "Stop", 2);

  drainToCompletion(db);
  const firstCursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;

  // A second drain over an unchanged events table must fold zero new events.
  expect(drain(db)).toBe(0);
  drainToCompletion(db);
  const secondCursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;

  expect(secondCursor).toBe(firstCursor);
  db.close();
});

/**
 * Seed one synthetic `autopilot_state` event (`AutopilotPaused` /
 * `AutopilotCapSet`) carrying a JSON `data` payload — the shape the daemon's
 * boot drain folds into the singleton.
 */
function seedAutopilotEvent(
  db: ReturnType<typeof openDb>["db"],
  hookEvent: "AutopilotPaused" | "AutopilotCapSet",
  ts: number,
  data: Record<string, unknown>,
): void {
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
       VALUES (?, 'autopilot', NULL, ?, 'autopilot_state', ?)`,
    [ts, hookEvent, JSON.stringify(data)],
  );
}

test("boot-drain seed: a durable AutopilotPaused{paused:false} resumes PLAYING; a fresh board boots PAUSED (the daemon's seed-from-column step)", () => {
  // Leg A — durable `play`: a real `AutopilotPaused{paused:false}` in history,
  // then the daemon's `AutopilotCapSet` boot re-arm (NO forced boot-pause). The
  // CapSet ON CONFLICT branch preserves the durable paused=0. After the drain
  // the daemon reads the singleton via `projectAutopilotPaused` and seeds its
  // in-memory `autopilotPaused` — a non-null `false` means BOOTS PLAYING.
  const playingDb = openDb(dbPath).db;
  seedAutopilotEvent(playingDb, "AutopilotPaused", 1, { paused: false });
  seedAutopilotEvent(playingDb, "AutopilotCapSet", 2, {
    max_concurrent_jobs: null,
  });
  drainToCompletion(playingDb);
  const playingRows = playingDb
    .query("SELECT paused FROM autopilot_state WHERE id = 1")
    .all() as Record<string, unknown>[];
  // The daemon's exact seed step: `const p = projectAutopilotPaused(rows); if
  // (p !== null) autopilotPaused = p;`. Provenance: a real durable play event.
  const seededPlaying = projectAutopilotPaused(playingRows);
  expect(seededPlaying).toBe(false); // boots PLAYING
  playingDb.close();

  // Leg B — fresh board: a brand-new DB with NO `AutopilotPaused` history, only
  // the daemon's `AutopilotCapSet` boot re-arm. Its INSERT path (`VALUES (1, 1,
  // …)`) is the SOLE carrier of the fresh-DB `paused=1` default now that the
  // forced boot-pause is gone — so the seed resolves to PAUSED.
  const freshPath = join(tmpDir, "fresh.db");
  const freshDb = openDb(freshPath).db;
  seedAutopilotEvent(freshDb, "AutopilotCapSet", 1, {
    max_concurrent_jobs: null,
  });
  drainToCompletion(freshDb);
  const freshRows = freshDb
    .query("SELECT paused FROM autopilot_state WHERE id = 1")
    .all() as Record<string, unknown>[];
  const seededFresh = projectAutopilotPaused(freshRows);
  expect(seededFresh).toBe(true); // boots PAUSED
  freshDb.close();

  // Leg C — empty singleton: no autopilot events at all. The seed step leaves
  // the in-memory boots-paused default untouched (`null` means "keep default").
  const emptyPath = join(tmpDir, "empty.db");
  const emptyDb = openDb(emptyPath).db;
  drainToCompletion(emptyDb);
  const emptyRows = emptyDb
    .query("SELECT paused FROM autopilot_state WHERE id = 1")
    .all() as Record<string, unknown>[];
  expect(projectAutopilotPaused(emptyRows)).toBeNull();
  emptyDb.close();
});

test("withBootDrainCheckpointTuning disables autocheckpoint inside the body and restores it after", () => {
  const { db } = openDb(dbPath);

  // Steady-state default before the wrapper runs.
  const initial = (
    db.query("PRAGMA wal_autocheckpoint").get() as {
      wal_autocheckpoint: number;
    }
  ).wal_autocheckpoint;
  expect(initial).toBe(WAL_AUTOCHECKPOINT_PAGES);

  let insideValue = -1;
  withBootDrainCheckpointTuning(db, () => {
    insideValue = (
      db.query("PRAGMA wal_autocheckpoint").get() as {
        wal_autocheckpoint: number;
      }
    ).wal_autocheckpoint;
  });

  // Auto-checkpoint is OFF during the boot drain so fold commits never absorb a
  // synchronous checkpoint…
  expect(insideValue).toBe(0);
  // …and the steady-state threshold is restored once the drain completes.
  const after = (
    db.query("PRAGMA wal_autocheckpoint").get() as {
      wal_autocheckpoint: number;
    }
  ).wal_autocheckpoint;
  expect(after).toBe(WAL_AUTOCHECKPOINT_PAGES);

  db.close();
});

test("withBootDrainCheckpointTuning restores autocheckpoint even if the body throws", () => {
  const { db } = openDb(dbPath);

  expect(() =>
    withBootDrainCheckpointTuning(db, () => {
      throw new Error("drain blew up");
    }),
  ).toThrow("drain blew up");

  // The `finally` must re-arm steady-state checkpointing — leaving the
  // long-running writer with autocheckpoint=0 would let the WAL grow unbounded.
  const after = (
    db.query("PRAGMA wal_autocheckpoint").get() as {
      wal_autocheckpoint: number;
    }
  ).wal_autocheckpoint;
  expect(after).toBe(WAL_AUTOCHECKPOINT_PAGES);

  db.close();
});

test("withBootDrainCheckpointTuning still folds the boot backlog to completion", () => {
  const { db } = openDb(dbPath);

  seedEvent(db, "sess-a", "SessionStart", 1);
  seedEvent(db, "sess-a", "Stop", 2);
  seedEvent(db, "sess-b", "SessionStart", 3);

  // The real boot shape: drain inside the checkpoint-tuning wrapper.
  withBootDrainCheckpointTuning(db, () => {
    drainToCompletion(db);
  });

  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(3);

  // The trailing TRUNCATE checkpoint flushed every COMMITted frame from the
  // WAL into the main DB AND reclaimed the WAL file. A subsequent PASSIVE
  // therefore sees an empty WAL: `log == 0`, `checkpointed == 0` (nothing left
  // to move), and `busy == 0` (no concurrent writer blocked us — at boot main's
  // writer is the only attached connection). The `checkpointed == log` invariant
  // (here 0 == 0) holds because every frame was already flushed.
  const checkpoint = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  expect(checkpoint.busy).toBe(0);
  expect(checkpoint.checkpointed).toBe(checkpoint.log);

  db.close();
});

test("boot drain checkpoints the WAL periodically so peak stays bounded, and the final TRUNCATE collapses it", () => {
  // The in-drain PASSIVE is gated on a folded-event count (or `-wal` size),
  // so the backlog must cross the real interval several times. With
  // `wal_autocheckpoint=0` and NO in-drain checkpoint, the `-wal` file
  // high-water would grow with the total drain length; the periodic PASSIVE
  // caps it near the size-gate ceiling regardless of how long the drain runs.
  // The `-wal` file never shrinks mid-drain, so its final size IS the peak
  // high-water the drain reached.
  const interval = BOOT_DRAIN_CHECKPOINT_EVENT_INTERVAL;

  const walHigh = (path: string): number =>
    existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;

  // Drive a synthetic backlog through `drainToCompletion`, returning the
  // peak `-wal` file size reached during the drain (captured at the end of the
  // wrapper body, BEFORE its final TRUNCATE) and the post-TRUNCATE size.
  const driveDrain = (
    path: string,
    total: number,
  ): { folded: number; peakWalBytes: number; postTruncateWalBytes: number } => {
    const { db } = openDb(path);
    db.run("BEGIN");
    for (let i = 1; i <= total; i += 1) {
      db.run(
        `INSERT INTO events (ts, session_id, pid, hook_event, event_type, permission_mode, data)
           VALUES (?, ?, 4242, 'SessionStart', 'lifecycle', NULL, '{}')`,
        [i, `sess-${i}`],
      );
    }
    db.run("COMMIT");

    let peakWalBytes = 0;
    withBootDrainCheckpointTuning(db, () => {
      drainToCompletion(db);
      peakWalBytes = walHigh(path);
    });
    const folded = (
      db
        .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
        .get() as {
        last_event_id: number;
      }
    ).last_event_id;
    const postTruncateWalBytes = walHigh(path);
    db.close();
    return { folded, peakWalBytes, postTruncateWalBytes };
  };

  // A control backlog JUST UNDER the interval never trips the in-drain gate.
  const controlDir = mkdtempSync(join(tmpdir(), "keeper-wal-control-"));
  const control = driveDrain(
    join(controlDir, "keeper.db"),
    Math.floor(interval * 0.9),
  );
  rmSync(controlDir, { recursive: true, force: true });
  expect(control.peakWalBytes).toBeGreaterThan(0);

  // The large backlog spans several intervals — the in-drain PASSIVE fires
  // repeatedly, so its peak WAL must NOT scale up with the extra length.
  const total = interval * 3;
  const large = driveDrain(dbPath, total);

  // Every event folded — the periodic checkpoint never disturbed the cursor.
  expect(large.folded).toBe(total);

  // Peak stays bounded near the size-gate ceiling even though the backlog is
  // ~5.5× the control's. A linear, un-checkpointed WAL would balloon past the
  // ceiling; the periodic PASSIVE caps the high-water within the size gate plus
  // a single between-checkpoint interval of growth.
  expect(large.peakWalBytes).toBeLessThan(BOOT_DRAIN_CHECKPOINT_WAL_BYTES * 2);

  // The final TRUNCATE in the wrapper collapsed the WAL file to empty.
  expect(large.postTruncateWalBytes).toBe(0);
}, 30_000);

test("boot drain spanning multiple batches catches up every event", () => {
  const { db } = openDb(dbPath);

  // More events than a single small batch, to exercise the drain loop.
  const total = 25;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  // Drive drain with a batch size smaller than the backlog so the loop must
  // iterate — same code path boot uses, just a tighter batch.
  while (drain(db, 10) > 0) {
    // keep folding
  }

  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(total);

  const jobCount = (
    db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobCount).toBe(total);

  db.close();
});

// =============================================================================
// fn-659 task .1 — boot-drain pacing for bounce-window starvation mitigation
// =============================================================================
//
// The reducer's `drain()` accepts an optional `DrainOptions` with `paceMs` +
// `paceEvents`. When `paceMs > 0`, the fold loop inserts a real OS-level sleep
// AFTER each event's `BEGIN IMMEDIATE` COMMITs (post-COMMIT seam, OUTSIDE the
// fold transaction), opening a writer-lock window for a concurrent hook
// INSERT (separate process) to slip in instead of starving on the tight
// re-entry into the next `BEGIN IMMEDIATE`. The budget (`paceEvents`) caps
// how many folds are paced so a large from-scratch re-fold catches up to
// head in bounded time.
//
// The tests below exercise:
//   - the mock-sleep counter (the mechanism is invoked the right number of
//     times)
//   - the cross-batch budget exhaustion in `drainToCompletion`
//   - re-fold byte-identical determinism (the post-COMMIT sleep is not an
//     input to any projection)
//   - a deterministic starvation repro using a subprocess concurrent writer
//     (a known-wide-gap drain consistently yields the lock; a known-tight
//     loop consistently starves a short-`busy_timeout` writer)
//   - the large-backlog wedge guard (the budget caps total paced latency)
//   - `withBootDrainCheckpointTuning`'s end-of-boot checkpoint is TRUNCATE
//     (empties the WAL — boot runs before any worker spawns, so nothing to
//     block on; every worker's first open then sees no WAL/-shm recovery path)

test("drain post-COMMIT pacing invokes the injected sleep exactly once per folded event", () => {
  const { db } = openDb(dbPath);

  const total = 10;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  // Mock sleep: record every call. The reducer's `drain` must call this once
  // per folded event (post-COMMIT) whenever `paceMs > 0` and the budget is
  // not yet exhausted.
  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  const folded = drain(db, /* batchSize */ 100, {
    paceMs: 7,
    paceEvents: 0, // "pace every event in the batch" — no budget cap
    sleep: mockSleep,
  });

  expect(folded).toBe(total);
  expect(sleepCalls.length).toBe(total);
  expect(sleepCalls.every((ms) => ms === 7)).toBe(true);

  db.close();
});

test("drain post-COMMIT pacing is OFF by default — no sleep call when paceMs is unset", () => {
  const { db } = openDb(dbPath);

  const total = 5;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  // Pacing knob unset → mockSleep MUST NOT be invoked. Steady-state wakes
  // pass no options and rely on this behavior — the per-event budget is
  // zero, the loop runs at full speed.
  const folded = drain(db, /* batchSize */ 100, { sleep: mockSleep });

  expect(folded).toBe(total);
  expect(sleepCalls.length).toBe(0);

  db.close();
});

test("drain paceEvents budget caps how many folds in a single batch get paced", () => {
  const { db } = openDb(dbPath);

  const total = 10;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  // Budget = 4 events; the remaining 6 must fold unpaced. This is the
  // mechanism that keeps a large from-scratch re-fold from wedging boot.
  const folded = drain(db, /* batchSize */ 100, {
    paceMs: 3,
    paceEvents: 4,
    sleep: mockSleep,
  });

  expect(folded).toBe(total);
  expect(sleepCalls.length).toBe(4);
  expect(sleepCalls.every((ms) => ms === 3)).toBe(true);

  db.close();
});

test("drainToCompletion pace budget carries across batches and exhausts cleanly", () => {
  const { db } = openDb(dbPath);

  // 30 events × batchSize 10 = three drain batches.
  const total = 30;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  // Pace budget = 12 events; spread across three batches it should be:
  //   batch1 (10 events): all 10 paced (budget remaining 2 after)
  //   batch2 (10 events): 2 paced + 8 unpaced (budget 0 after)
  //   batch3 (10 events): 0 paced
  // Total mock sleep calls = 12, all at paceMs.
  drainToCompletion(db, /* batchSize */ 10, {
    paceMs: 2,
    paceEvents: 12,
    sleep: mockSleep,
  });

  expect(sleepCalls.length).toBe(12);
  expect(sleepCalls.every((ms) => ms === 2)).toBe(true);

  // Cursor reached head even though only part of the drain was paced.
  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(total);

  db.close();
});

test("drainToCompletion: large backlog with bounded paceEvents catches up to head in bounded time", () => {
  const { db } = openDb(dbPath);

  // Simulate a from-scratch re-fold scale: enough events that an unbounded
  // pace (paceEvents=0) at the production paceMs would clearly wedge boot.
  // 2000 events × 5ms = 10s of pacing; capping to 50 keeps it to ~250ms even
  // with a real sleep.
  const total = 2000;
  for (let i = 1; i <= total; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
  }

  const sleepCalls: number[] = [];
  const mockSleep = (ms: number) => {
    sleepCalls.push(ms);
  };

  drainToCompletion(db, /* batchSize */ 200, {
    paceMs: 5,
    paceEvents: 50, // tight cap: only the bounce window's worth of pacing
    sleep: mockSleep,
  });

  // Pacing burned exactly the budget; the remaining 1950 events folded
  // unpaced. Without this cap the drain would have paced all 2000 →
  // 10 seconds of sleep, the wedge case the spec calls out.
  expect(sleepCalls.length).toBe(50);

  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(total);

  // Projection contains every job.
  const jobCount = (
    db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobCount).toBe(total);

  db.close();
});

test("BOOT_DRAIN_PACE constants stay inside the documented budget", () => {
  // Documented contract: total worst-case paced latency at boot
  // (`BOOT_DRAIN_PACE_MS × BOOT_DRAIN_PACE_EVENTS`) stays well under any
  // realistic bounce-window patience — under 3 seconds. If a future tweak
  // bumps either constant past this gate, the test signals the implicit
  // boot-latency budget the docs promise.
  expect(BOOT_DRAIN_PACE_MS).toBeGreaterThan(0);
  expect(BOOT_DRAIN_PACE_EVENTS).toBeGreaterThan(0);
  expect(BOOT_DRAIN_PACE_MS * BOOT_DRAIN_PACE_EVENTS).toBeLessThanOrEqual(3000);
});

test("pacing preserves re-fold byte-identical determinism (projection unchanged)", () => {
  // Re-fold determinism is the CLAUDE.md invariant: a from-scratch re-fold
  // (rewind cursor, DELETE projection rows, re-drain) reproduces byte-
  // identical rows. The post-COMMIT sleep is OUTSIDE the fold transaction
  // and reads no wall-clock value into any projection write — so flipping
  // pacing on/off MUST NOT change any projected row.
  function snapshot(db: ReturnType<typeof openDb>["db"]): string {
    // Serialize `jobs` in a stable order. The projection is shape-pinned so
    // the JSON string is a sufficient byte-identity probe; if any pacing
    // path leaked into a projection write it would diverge here. The cell
    // set covers every reducer-write target — lifecycle state, identity,
    // epoch + cursor — without the wall-clock `updated_at` (the reducer
    // stamps the event's own `ts` there, NOT a fresh wall clock, so it
    // would still be byte-identical, but excluding it tightens the probe
    // against an accidental `Date.now()` slip).
    const rows = db
      .query(
        `SELECT job_id, state, title, title_source, pid, start_time, cwd,
                last_event_id, plan_verb, plan_ref, epic_links,
                last_api_error_at, last_api_error_kind
           FROM jobs ORDER BY job_id ASC`,
      )
      .all();
    return JSON.stringify(rows);
  }

  // First fold: NO pacing (the historical shape).
  const dbPathA = join(tmpDir, "keeper-a.db");
  const a = openDb(dbPathA);
  for (let i = 1; i <= 25; i += 1) {
    seedEvent(a.db, `sess-${i}`, "SessionStart", i);
    seedEvent(
      a.db,
      `sess-${i}`,
      "UserPromptSubmit",
      i + 100,
      i % 2 === 0 ? "plan" : null,
    );
    seedEvent(a.db, `sess-${i}`, "Stop", i + 200);
  }
  drainToCompletion(a.db);
  const snapA = snapshot(a.db);
  a.db.close();

  // Second fold: pacing ON via a mock sleep (no real time spent). Identical
  // event seed.
  const dbPathB = join(tmpDir, "keeper-b.db");
  const b = openDb(dbPathB);
  for (let i = 1; i <= 25; i += 1) {
    seedEvent(b.db, `sess-${i}`, "SessionStart", i);
    seedEvent(
      b.db,
      `sess-${i}`,
      "UserPromptSubmit",
      i + 100,
      i % 2 === 0 ? "plan" : null,
    );
    seedEvent(b.db, `sess-${i}`, "Stop", i + 200);
  }
  drainToCompletion(b.db, /* batchSize */ 200, {
    paceMs: 7,
    paceEvents: 50,
    sleep: () => {
      /* no-op mock — proves a sleep at all is not what changes the projection */
    },
  });
  const snapB = snapshot(b.db);
  b.db.close();

  // Byte-identical projection rows under pacing on/off.
  expect(snapB).toEqual(snapA);
});

/**
 * Deterministic starvation repro. Spawns a subprocess that opens the same
 * SQLite DB the parent is folding into, sets `busy_timeout` to a short value,
 * and attempts ONE `BEGIN IMMEDIATE` INSERT. The parent meanwhile does a
 * synthetic "drain" — a tight `BEGIN IMMEDIATE`/COMMIT loop of N transactions
 * with configurable post-COMMIT pacing. The unpaced loop holds the writer
 * lock with microsecond gaps between transactions (WAL gives NO writer FIFO
 * fairness) so the subprocess's short `busy_timeout` reliably expires before
 * the parent yields → SQLITE_BUSY observed. The paced loop opens a real
 * OS-level window after every COMMIT, well wider than the subprocess's
 * `busy_timeout`, so the subprocess slips in cleanly → success observed.
 *
 * The shape mirrors the production bounce window precisely: a long-running
 * single writer (keeperd's boot drain) vs a short-`busy_timeout` concurrent
 * writer (a hook process). The fix is the SAME post-COMMIT sleep the
 * production drain uses; the test drives it through the same primitive
 * (a real `Atomics.wait` sleep) so a regression that defaults pacing back to
 * `setImmediate` (which does NOT release the SQLite lock to a separate
 * process) fails this test even though setImmediate would still yield the JS
 * event loop.
 */
async function spawnContendingWriter(opts: {
  dbPath: string;
  busyTimeoutMs: number;
  readyMarkerPath: string;
}): Promise<{
  ok: boolean;
  err: string | null;
  durationMs: number;
}> {
  // Inline subprocess script. Opens the DB with the requested
  // `busy_timeout`, signals readiness by creating a marker file, then
  // attempts the contended INSERT. The DDL on this connection is a fresh
  // `openDb` so the schema is shared with the parent's DB file.
  const script = `
    import { Database } from "bun:sqlite";
    import { writeFileSync } from "node:fs";

    const dbPath = ${JSON.stringify(opts.dbPath)};
    const readyMarker = ${JSON.stringify(opts.readyMarkerPath)};
    const busyTimeoutMs = ${opts.busyTimeoutMs};

    const db = new Database(dbPath);
    db.run("PRAGMA busy_timeout = " + busyTimeoutMs);
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");

    // Signal "ready" before attempting the contended INSERT so the parent
    // can synchronize the start of its own drain to this subprocess being
    // alive and listening at the writer lock.
    writeFileSync(readyMarker, "ready");

    // Sleep briefly to let the parent see the marker and enter its drain
    // loop. 50ms is enough for any file-watch-grade observation; the
    // parent's drain is sized to take many times longer than this.
    await Bun.sleep(50);

    const start = performance.now();
    let ok = false;
    let err = null;
    try {
      const txn = db.transaction(() => {
        db.run(
          \`INSERT INTO events
               (ts, session_id, pid, hook_event, event_type, data)
             VALUES (?, 'contender', 99999, 'Contention', 'lifecycle', '{}')\`,
          [Math.floor(Date.now() / 1000)],
        );
      });
      txn.immediate();
      ok = true;
    } catch (e) {
      err = (e && (e.message || String(e))) || "unknown";
    }
    const durationMs = performance.now() - start;

    process.stdout.write(JSON.stringify({ ok, err, durationMs }));
    process.exit(0);
  `;
  const proc = Bun.spawn({
    cmd: ["bun", "--eval", script],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `contender child failed exit=${proc.exitCode} stdout=${stdout} stderr=${stderr}`,
    );
  }
  return JSON.parse(stdout.trim());
}

/**
 * Mirror of {@link spawnContendingWriter}: a subprocess that GRABS the writer
 * lock (`BEGIN IMMEDIATE`), signals ready, then HOLDS it via a synchronous
 * in-transaction OS sleep for `holdMs` before committing. Lets the parent
 * provoke a real `SQLITE_BUSY` on its OWN write (the inverse role split — here
 * the child is the lock hold, the parent is the contender whose error we
 * inspect). Resolves once the subprocess has committed and exited.
 */
async function spawnLockHolder(opts: {
  dbPath: string;
  holdMs: number;
  readyMarkerPath: string;
}): Promise<void> {
  const script = `
    import { Database } from "bun:sqlite";
    import { writeFileSync } from "node:fs";

    const dbPath = ${JSON.stringify(opts.dbPath)};
    const readyMarker = ${JSON.stringify(opts.readyMarkerPath)};
    const holdMs = ${opts.holdMs};

    const db = new Database(dbPath);
    db.run("PRAGMA busy_timeout = 5000");
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");

    function sleepSyncMs(ms) {
      const view = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(view, 0, 0, ms);
    }

    // Grab the writer lock at BEGIN IMMEDIATE, THEN signal ready (so the parent
    // never sees "ready" before the lock is actually held), THEN hold it.
    const heldTxn = db.transaction(() => {
      db.run(
        \`INSERT INTO events
             (ts, session_id, pid, hook_event, event_type, data)
           VALUES (?, 'holder', 88888, 'Hold', 'lifecycle', '{}')\`,
        [Math.floor(Date.now() / 1000)],
      );
      writeFileSync(readyMarker, "ready");
      sleepSyncMs(holdMs); // INSIDE BEGIN IMMEDIATE — lock held continuously
    });
    heldTxn.immediate();

    process.exit(0);
  `;
  const proc = Bun.spawn({
    cmd: ["bun", "--eval", script],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `lock holder child failed exit=${proc.exitCode} stdout=${stdout} stderr=${stderr}`,
    );
  }
}

test("starvation repro: a long-held writer lock (no yield) starves a concurrent writer past its busy_timeout", async () => {
  // Reproduces the production bounce-window starvation: a single writer
  // (keeperd's boot drain, the end-of-boot TRUNCATE checkpoint, or a slow
  // fold) holds the writer lock CONTINUOUSLY for a duration past the
  // concurrent hook's `busy_timeout`. WAL has no FIFO fairness — a hook
  // retrying at its `busy_timeout` cadence loses the race entirely.
  //
  // The deterministic shape: parent enters ONE `BEGIN IMMEDIATE` write
  // transaction and holds it (via a synchronous OS sleep INSIDE the
  // transaction) for longer than the contender's `busy_timeout`. The
  // contender's INSERT MUST observe SQLITE_BUSY — the production drop
  // signal.
  const { db } = openDb(dbPath);

  const readyMarkerPath = join(tmpDir, "contender-ready");

  const contenderPromise = spawnContendingWriter({
    dbPath,
    busyTimeoutMs: 100,
    readyMarkerPath,
  });

  // Wait for the contender to signal ready (max ~2s). It then sleeps 50ms
  // before attempting its INSERT — by which time the parent is already
  // holding the writer lock.
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const readyDeadline = Date.now() + 2000;
  while (!existsSync(readyMarkerPath)) {
    if (Date.now() > readyDeadline) {
      throw new Error("contender failed to signal ready within 2s");
    }
    await Bun.sleep(5);
  }

  function sleepSyncMs(ms: number): void {
    const buf = new SharedArrayBuffer(4);
    const view = new Int32Array(buf);
    Atomics.wait(view, 0, 0, ms);
  }

  // Single long-held transaction. The OS sleep inside the txn is the
  // direct analog of the production [fold-slow] events the spec calls
  // out as the contention hold (per-fold 200ms+ holds AND end-of-boot
  // TRUNCATE waiting on writers). 500ms hold is 5× the contender's
  // 100ms busy_timeout, so the contender's busy handler exhausts its
  // budget while the lock is still held.
  const heldTxn = db.transaction(() => {
    db.run(
      `INSERT OR IGNORE INTO dead_letters
            (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
             status, recovered_at, replayed_event_id, source_file)
          VALUES (?, 'parent', 'Parent', ?, ?, 0, '{}',
                  'waiting', NULL, NULL, NULL)`,
      [`held-${performance.now()}`, 1, 1],
    );
    sleepSyncMs(500); // INSIDE the BEGIN IMMEDIATE — lock held continuously
  });
  heldTxn.immediate();

  const result = await contenderPromise;
  db.close();

  // The contender's 100ms busy_timeout expired while the parent's lock
  // hold was still active → SQLITE_BUSY. This is the bounce-window drop
  // shape the fn-659 fix targets: a writer holding too long starves the
  // hook into a dead-letter.
  expect(result.ok).toBe(false);
  expect(result.err).toMatch(/(?:locked|busy|SQLITE_BUSY)/i);
}, 120_000);

test("starvation fix: pacing the writer (post-COMMIT OS sleep) yields the lock cleanly to a concurrent writer", async () => {
  // The mirror of the starvation repro: instead of one long-held
  // transaction, the parent SPLITS its writes into many short
  // transactions with a real OS-level sleep BETWEEN them — the exact
  // shape the reducer's paced drain uses (post-COMMIT, OUTSIDE any
  // `BEGIN IMMEDIATE`, via the same `Atomics.wait` primitive). Total
  // parent work is the same magnitude but the lock is released
  // frequently enough that the contender slips into the first paced
  // gap. Outcome: contender's INSERT succeeds; no SQLITE_BUSY.
  const { db } = openDb(dbPath);

  const readyMarkerPath = join(tmpDir, "contender-ready-paced");

  const contenderPromise = spawnContendingWriter({
    dbPath,
    busyTimeoutMs: 100,
    readyMarkerPath,
  });

  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const readyDeadline = Date.now() + 2000;
  while (!existsSync(readyMarkerPath)) {
    if (Date.now() > readyDeadline) {
      throw new Error("contender failed to signal ready within 2s");
    }
    await Bun.sleep(5);
  }

  function sleepSyncMs(ms: number): void {
    const buf = new SharedArrayBuffer(4);
    const view = new Int32Array(buf);
    Atomics.wait(view, 0, 0, ms);
  }

  // Short transactions + post-COMMIT pacing (the production paced-drain
  // shape). Each iteration: open BEGIN IMMEDIATE, do a tiny INSERT,
  // COMMIT (release the lock), sleep ~20ms before the next iteration.
  // The sleep gap (20ms) is well wider than the 100ms busy_timeout's
  // retry-cadence resolution, so the contender's first retry inside any
  // paced gap acquires the lock cleanly.
  const shortTxn = db.transaction(() => {
    db.run(
      `INSERT OR IGNORE INTO dead_letters
            (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
             status, recovered_at, replayed_event_id, source_file)
          VALUES (?, 'parent', 'Parent', ?, ?, 0, '{}',
                  'waiting', NULL, NULL, NULL)`,
      [`paced-${performance.now()}-${Math.random()}`, 1, 1],
    );
  });
  const pacedDeadline = Date.now() + 500;
  while (Date.now() < pacedDeadline) {
    shortTxn.immediate();
    sleepSyncMs(20); // OS-level yield BETWEEN transactions, OUTSIDE BEGIN
  }

  const result = await contenderPromise;
  db.close();

  // With paced gaps wider than the contender's busy_timeout retry
  // cadence, the contender grabs the lock in the FIRST paced gap → ok.
  expect(result.ok).toBe(true);
  expect(result.err).toBeNull();
}, 120_000);

test("isTransientBusyError classifies writer-lock starvation as transient and everything else as fatal", () => {
  // The discriminator the usage mint's drop-don't-crash hinges on. Transient =
  // recoverable lock contention (re-emit / boot-sweep heals a dropped row);
  // everything else, notably SQLITE_CORRUPT (the fn-746 malformed-image class),
  // must stay fatal so the loud-and-fatalExit-and-relaunch contract holds.
  // Both the string `code` (what bun stamps) AND the numeric `errno` fallback.
  expect(isTransientBusyError({ code: "SQLITE_BUSY", errno: 5 })).toBe(true);
  expect(isTransientBusyError({ code: "SQLITE_LOCKED", errno: 6 })).toBe(true);
  expect(isTransientBusyError({ errno: 5 })).toBe(true); // code dropped → errno
  expect(isTransientBusyError({ errno: 6 })).toBe(true);

  // Fatal classes — must NOT be swallowed.
  expect(isTransientBusyError({ code: "SQLITE_CORRUPT", errno: 11 })).toBe(
    false,
  );
  expect(isTransientBusyError({ code: "SQLITE_CONSTRAINT", errno: 19 })).toBe(
    false,
  );
  expect(isTransientBusyError(new Error("plain"))).toBe(false);
  expect(isTransientBusyError("SQLITE_BUSY")).toBe(false); // a bare string
  expect(isTransientBusyError(null)).toBe(false);
  expect(isTransientBusyError(undefined)).toBe(false);
});

// ---------------------------------------------------------------------------
// fn-921 — git seed-liveness watchdog pure verdict
// ---------------------------------------------------------------------------

const WD_BASE = {
  seedRequired: true,
  lastProgressAtMs: 0,
  lastLivenessAtMs: 100_000,
  nowMs: 100_000,
  stuckThresholdMs: GIT_SEED_STUCK_THRESHOLD_MS,
  livenessThresholdMs: 90_000,
  reseedAttempts: 0,
  maxReseedAttempts: GIT_SEED_MAX_RESEED_ATTEMPTS,
};

test("decideGitSeedWatchdog: seed cleared → ok (the healthy steady state)", () => {
  expect(decideGitSeedWatchdog({ ...WD_BASE, seedRequired: false })).toBe("ok");
});

test("decideGitSeedWatchdog: worker never pulsed → ok (never trip mid-boot-seed)", () => {
  // lastLivenessAtMs null = boot-seed may still be in flight. Even with a long-
  // stale progress anchor, we must not act.
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      lastLivenessAtMs: null,
      lastProgressAtMs: 0,
      nowMs: 10_000_000,
    }),
  ).toBe("ok");
});

test("decideGitSeedWatchdog: recent progress → ok (staleness under the threshold)", () => {
  // A snapshot landed 1s ago; seed_required set but not yet stuck.
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      lastProgressAtMs: 100_000,
      lastLivenessAtMs: 100_500,
      nowMs: 101_000,
    }),
  ).toBe("ok");
});

test("decideGitSeedWatchdog: stuck + worker alive + budget remaining → reseed", () => {
  // No progress for > stuckThreshold, but the worker is still pulsing (alive),
  // and we have not exhausted the re-seed budget → re-seed on main first.
  const now = WD_BASE.lastProgressAtMs + GIT_SEED_STUCK_THRESHOLD_MS + 1;
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      nowMs: now,
      lastLivenessAtMs: now, // pulsed just now → alive
      reseedAttempts: 0,
    }),
  ).toBe("reseed");
});

test("decideGitSeedWatchdog: stuck + re-seed budget spent → escalate", () => {
  const now = WD_BASE.lastProgressAtMs + GIT_SEED_STUCK_THRESHOLD_MS + 1;
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      nowMs: now,
      lastLivenessAtMs: now,
      reseedAttempts: GIT_SEED_MAX_RESEED_ATTEMPTS,
    }),
  ).toBe("escalate");
});

test("decideGitSeedWatchdog: mute worker (no pulse past livenessThreshold) → escalate, regardless of re-seed budget", () => {
  // The worker stopped pulsing > livenessThreshold ago — a hung poll tick. A main
  // re-seed would only momentarily clear the flag before the dead producer
  // re-staled it, so restart is the correct recovery even with budget remaining.
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      lastLivenessAtMs: 0,
      nowMs: 200_000, // 200s since last pulse, > 90s liveness threshold
      reseedAttempts: 0,
    }),
  ).toBe("escalate");
});

test("decideGitSeedWatchdog: alive-but-never-seeding still grows stale from the arm baseline → reseed", () => {
  // The stable progress anchor (the watchdog-arm baseline) grows stale even while
  // the worker keeps pulsing — so a quiet repo whose force-emit never clears the
  // flag is still recovered, not stuck forever. Pulse stays fresh (alive); the
  // progress anchor is old (no snapshot ever landed).
  const baseline = 0;
  const now = baseline + GIT_SEED_STUCK_THRESHOLD_MS + 1;
  expect(
    decideGitSeedWatchdog({
      ...WD_BASE,
      lastProgressAtMs: baseline,
      lastLivenessAtMs: now, // still pulsing → alive
      nowMs: now,
      reseedAttempts: 0,
    }),
  ).toBe("reseed");
});

test("usage-mint crash regression: a real insertEvent.run starved past busy_timeout throws an error isTransientBusyError catches", async () => {
  // Pins the 2026-06-10 crash (39 daemon restarts): the usage mint's synchronous
  // `stmts.insertEvent.run` threw `SQLITE_BUSY` straight through `uw.onmessage`
  // to `uncaughtException` → `fatalExit`. The tolerant mint now swallows EXACTLY
  // this error. This drives a REAL `insertEvent.run` (the synthetic UsageDeleted
  // shape — pk in session_id, empty data) into a writer lock held past its
  // busy_timeout and asserts the thrown error is one `isTransientBusyError`
  // classifies transient — proving the live bun error carries the `code` the
  // drop-don't-crash path keys on, not just a hand-built object.
  const { db, stmts } = openDb(dbPath, { busyTimeoutMs: 100 });

  const readyMarkerPath = join(tmpDir, "lockholder-ready");

  // Reuse the contending-writer harness as the LOCK HOLDER: it enters a
  // BEGIN IMMEDIATE write and holds it ~500ms (5× our busy_timeout) while THIS
  // process attempts the mint and loses the race.
  const holderPromise = spawnLockHolder({
    dbPath,
    holdMs: 500,
    readyMarkerPath,
  });

  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const readyDeadline = Date.now() + 2000;
  while (!existsSync(readyMarkerPath)) {
    if (Date.now() > readyDeadline) {
      throw new Error("lock holder failed to signal ready within 2s");
    }
    await Bun.sleep(5);
  }
  // Holder is mid-transaction now; our 100ms busy_timeout will exhaust under it.

  let thrown: unknown;
  try {
    stmts.insertEvent.run({
      $ts: Date.now() / 1000,
      $session_id: "agentusage-profile-pk", // the UsageDeleted pk shape
      $pid: null,
      $hook_event: "UsageDeleted",
      $event_type: "usage_snapshot",
      $tool_name: null,
      $matcher: null,
      $cwd: null,
      $permission_mode: null,
      $agent_id: null,
      $agent_type: null,
      $stop_hook_active: null,
      $data: "",
      $subagent_agent_id: null,
      $spawn_name: null,
      $start_time: null,
      $slash_command: null,
      $skill_name: null,
      $plan_op: null,
      $plan_target: null,
      $plan_epic_id: null,
      $plan_task_id: null,
      $plan_subject_present: null,
      $config_dir: null,
      $bash_mutation_kind: null,
      $bash_mutation_targets: null,
      $plan_files: null,
      $backend_exec_type: null,
      $backend_exec_session_id: null,
      $backend_exec_pane_id: null,
    });
  } catch (err) {
    thrown = err;
  }

  await holderPromise;
  db.close();

  // The mint DID throw (lock starvation), and the discriminator catches it —
  // so the tolerant mint drops-and-survives instead of crashing the daemon.
  expect(thrown).toBeDefined();
  expect(isTransientBusyError(thrown)).toBe(true);
}, 120_000);

test("withBootDrainCheckpointTuning ends the boot with a TRUNCATE checkpoint (empties the WAL)", () => {
  // The end-of-boot checkpoint runs in the `finally` AFTER the drain body. It
  // is TRUNCATE, not PASSIVE: this wrapper runs at boot BEFORE any worker
  // thread spawns, so main's writer is the only connection attached and there
  // is nothing to wait on. TRUNCATE empties the WAL file so every worker's
  // first `openDb` reads the main file with no WAL frames to scan and no `-shm`
  // recovery path to walk — closing a boot-race failure surface under load.
  //
  // Probe the choice via the WAL file's observable post-state. After the
  // wrapper exits:
  //   - TRUNCATE leaves `log == 0` (WAL file reclaimed)
  //   - PASSIVE leaves `log > 0` (frames flushed but the file is not reclaimed)
  // This test pins the SPECIFIC checkpoint mode by asserting `log == 0` after —
  // the regression signal if a future tweak switches the trailing checkpoint
  // back to PASSIVE.
  const { db } = openDb(dbPath);

  // Seed enough events that PASSIVE would leave a measurable WAL frame count —
  // so the `log == 0` assertion below is meaningful (a too-small WAL would also
  // yield log=0 under PASSIVE, masking a regression).
  for (let i = 1; i <= 20; i += 1) {
    seedEvent(db, `sess-${i}`, "SessionStart", i);
    seedEvent(db, `sess-${i}`, "Stop", i + 1000);
  }

  withBootDrainCheckpointTuning(db, () => {
    drainToCompletion(db);
  });

  // Probe the post-state. TRUNCATE reclaimed the WAL file, so a follow-up
  // checkpoint sees an empty WAL: `log == 0`. A regression to PASSIVE would
  // leave `log > 0` here.
  const probe = db.query("PRAGMA wal_checkpoint(PASSIVE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  expect(probe.busy).toBe(0);
  expect(probe.log).toBe(0);
  expect(probe.checkpointed).toBe(0);

  db.close();
});

/**
 * The plan-worker → main path: a `plan-epic`/`plan-task` snapshot message
 * becomes a synthetic `EpicSnapshot`/`TaskSnapshot` events row that main inserts
 * on its writable connection (entity id in `session_id`, the snapshot in
 * `data`), then folds. This mirrors exactly what `runDaemon`'s
 * `planWorker.onmessage` branch does (insert via the same positional column
 * order, then pump a drain) — driven directly here so no Worker is spawned.
 */
function insertPlanSnapshot(
  stmts: ReturnType<typeof openDb>["stmts"],
  hookEvent: "EpicSnapshot" | "TaskSnapshot",
  entityId: string,
  ts: number,
  data: Record<string, unknown>,
): void {
  stmts.insertEvent.run({
    $ts: ts,
    $session_id: entityId, // the entity pk
    $pid: null,
    $hook_event: hookEvent,
    $event_type: "plan_snapshot",
    $tool_name: null,
    $matcher: null,
    $cwd: null,
    $permission_mode: null,
    $agent_id: null,
    $agent_type: null,
    $stop_hook_active: null,
    $data: JSON.stringify(data), // the full snapshot blob
    $subagent_agent_id: null,
    $spawn_name: null,
    $start_time: null,
  });
}

test("synthetic EpicSnapshot/TaskSnapshot events fold into epics (tasks embedded)", () => {
  const { db, stmts } = openDb(dbPath);

  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 1, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "in_progress",
  });
  insertPlanSnapshot(stmts, "TaskSnapshot", "fn-7-add-oauth.2", 2, {
    epic_id: "fn-7-add-oauth",
    task_number: 2,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    status: "open",
  });

  drainToCompletion(db);

  // Cursor advanced past both synthetic events.
  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(2);

  const epic = db
    .query(
      "SELECT epic_number, title, project_dir, status, last_event_id, tasks FROM epics WHERE epic_id = 'fn-7-add-oauth'",
    )
    .get() as {
    epic_number: number;
    title: string;
    project_dir: string;
    status: string;
    last_event_id: number;
    tasks: string;
  };
  expect(epic.epic_number).toBe(7);
  expect(epic.title).toBe("Add OAuth");
  expect(epic.project_dir).toBe("/Users/mike/code/keeper");
  expect(epic.status).toBe("in_progress");
  // Schema v7: the TaskSnapshot folds into the epic's embedded array and bumps
  // the parent epic's last_event_id (so the epic row patches).
  expect(epic.last_event_id).toBe(2);

  // The task is embedded in the parent epic's `tasks` array (no standalone
  // tasks table).
  const tasks = JSON.parse(epic.tasks) as {
    task_id: string;
    epic_id: string;
    task_number: number;
    title: string;
    target_repo: string;
    tier: string | null;
    worker_phase: string;
    runtime_status: string;
    depends_on: string[];
    jobs: unknown[];
  }[];
  expect(tasks.length).toBe(1);
  expect(tasks[0]).toEqual({
    task_id: "fn-7-add-oauth.2",
    epic_id: "fn-7-add-oauth",
    task_number: 2,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    // fn-602: `tier` rides FREE in the embedded JSON. This synthetic event
    // omits the field — the reducer reads `snapshot.tier ?? null` so the
    // embedded element folds to `null` deterministically (graceful-
    // degradation precedent shared with `worker_phase`/`runtime_status`).
    tier: null,
    // Schema v19: the legacy `status` column was renamed to `worker_phase`
    // (derived worker-phase binary) and a sibling `runtime_status` field
    // surfaces the plan-native enum. A TaskSnapshot blob without a state
    // file folds `runtime_status` to the plan `"todo"` default.
    worker_phase: "open",
    runtime_status: "todo",
    depends_on: [],
    // Schema v11: first-sight task element gets an empty embedded jobs sub-array.
    jobs: [],
  });

  db.close();
});

test("EpicSnapshot folds depends_on_epics; TaskSnapshot folds depends_on into the embedded element", () => {
  const { db, stmts } = openDb(dbPath);

  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 1, {
    epic_number: 7,
    title: "Add OAuth",
    status: "open",
    depends_on_epics: ["fn-3-base", "fn-5-prereq"],
  });
  insertPlanSnapshot(stmts, "TaskSnapshot", "fn-7-add-oauth.2", 2, {
    epic_id: "fn-7-add-oauth",
    task_number: 2,
    title: "Wire the callback",
    status: "open",
    depends_on: ["fn-7-add-oauth.1"],
  });
  drainToCompletion(db);

  const epic = db
    .query(
      "SELECT depends_on_epics, tasks FROM epics WHERE epic_id = 'fn-7-add-oauth'",
    )
    .get() as { depends_on_epics: string; tasks: string };
  // Epic deps are stored as a JSON-TEXT array column.
  expect(JSON.parse(epic.depends_on_epics)).toEqual([
    "fn-3-base",
    "fn-5-prereq",
  ]);
  // Task deps ride inside the embedded element.
  const tasks = JSON.parse(epic.tasks) as { depends_on: string[] }[];
  expect(tasks[0]?.depends_on).toEqual(["fn-7-add-oauth.1"]);

  db.close();
});

test("a re-arrived EpicSnapshot upserts last-write-wins with monotonic last_event_id", () => {
  const { db, stmts } = openDb(dbPath);

  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 1, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "open",
  });
  drainToCompletion(db);

  // A later snapshot for the same epic (status moved on disk) upserts in place.
  insertPlanSnapshot(stmts, "EpicSnapshot", "fn-7-add-oauth", 2, {
    epic_number: 7,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "done",
  });
  drainToCompletion(db);

  const rows = db
    .query(
      "SELECT status, last_event_id FROM epics WHERE epic_id = 'fn-7-add-oauth'",
    )
    .all() as { status: string; last_event_id: number }[];
  // One row (idempotent upsert), the newer snapshot won, version advanced.
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe("done");
  expect(rows[0].last_event_id).toBe(2);

  db.close();
});

// ---------------------------------------------------------------------------
// Seed sweep — Q7 boot-time liveness pass (dead → Killed; alive+recycled →
// Killed; alive+matching → leave; legacy NULL start_time → leave).
// ---------------------------------------------------------------------------

/**
 * Pre-seed a `jobs` row directly (bypassing the events log). The sweep reads
 * `jobs` to decide who to probe, so seeding the projection is enough — the
 * subsequent `drainToCompletion` only needs to fold the synthetic Killed
 * events the sweep emits.
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

/**
 * Find a pid that is definitely NOT in use right now. Starts from 999_990 and
 * walks downward — the OS pid space on macOS caps at 99_999 by default and on
 * Linux at 4_194_304; either way, a 6-digit pid above the live range is
 * essentially always free. Returns the first dead pid we land on; throws if
 * the loop somehow exhausts the search (impossibly contended host).
 */
function pickDeadPid(): number {
  for (let candidate = 999_990; candidate > 100_000; candidate -= 1) {
    if (!isPidAlive(candidate)) {
      return candidate;
    }
  }
  throw new Error("seed sweep test: could not find a dead pid");
}

test("seed sweep folds dead/recycled rows to killed; leaves alive+matching and legacy NULL alone", () => {
  const { db } = openDb(dbPath);

  // (a) alive matching pid+start_time → leave alone. We don't yet know the
  // OS-reported start_time for process.pid; the post-sweep assertion is just
  // that this row stayed `stopped` regardless (we re-use the same alive pid
  // for (b) below with a deliberately-wrong stored start_time, so any
  // recycle-fold would target (b) — not (a)).
  // We seed (a) with the SAME stored start_time we'll read off the OS below,
  // by reflecting the seed sweep's own producer logic: the sweep only emits
  // Killed when alive+stored differs from alive+OS-now. To make (a)
  // deterministically NOT fold, we set start_time=NULL and assert state stays
  // `stopped`. NOTE: that overlaps semantically with case (e), so we use a
  // distinct invariant: case (a) keeps a non-null start_time obtained from
  // the OS-now read so the match is true. The simplest seed: don't read the
  // OS at all — set start_time to a sentinel that NEVER matches, and the
  // expected outcome flips to "folded to killed". Instead we model (a) as
  // alive+stored=OS-now by piggy-backing on the producer: seed start_time
  // unknown, but use a known-alive pid with a sentinel that DOES match a
  // freshly-read OS value. We achieve that by reading the OS value here and
  // mirroring the seed-sweep's own reader contract via a same-process
  // platform probe.
  const alivePid = process.pid;
  // Read the OS start_time the SAME way the producer does (darwin: ps lstart,
  // linux: /proc stat). Re-using the producer parsers would be cleaner but
  // would tightly couple the test to the producer's import surface; the
  // duplication here is deliberate — the test asserts ROUND-TRIP equality
  // against a freshly-read OS value, which is the contract the sweep promises.
  function readOsStartTimeForTest(pid: number): string | null {
    if (process.platform === "darwin") {
      const result = Bun.spawnSync(
        ["ps", "-ww", "-p", String(pid), "-o", "lstart="],
        { timeout: 500 },
      );
      if (!result.success || result.exitCode !== 0) return null;
      const text = result.stdout?.toString().replace(/^\s+|\s+$/g, "") ?? "";
      if (text.length < 24) return null;
      return `darwin:${text.slice(0, 24)}`;
    }
    if (process.platform === "linux") {
      try {
        const { readFileSync } = require("node:fs") as typeof import("node:fs");
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const close = stat.lastIndexOf(")");
        if (close < 0) return null;
        const fields = stat
          .slice(close + 1)
          .trim()
          .split(/\s+/);
        const raw = fields[19];
        return raw && /^\d+$/.test(raw) ? `linux:${raw}` : null;
      } catch {
        return null;
      }
    }
    return null;
  }

  const aliveStart = readOsStartTimeForTest(alivePid);
  // The test only runs the matching-row assertion when the platform probe
  // works — on a CI image with no `ps` or `/proc` access, case (a) collapses
  // to "we don't know the matching start_time" and we skip that arm. The
  // dead/recycled/legacy arms below remain valid regardless.
  if (aliveStart != null) {
    seedJobsRow(db, "sess-a-alive-matching", alivePid, aliveStart);
  }
  // (b) alive recycled — stored start_time deliberately wrong for the live pid.
  seedJobsRow(
    db,
    "sess-b-alive-recycled",
    alivePid,
    "darwin:Wed Jan 01 00:00:00 1970",
  );
  // (c) dead pid with stored start_time → Killed regardless.
  const deadPid = pickDeadPid();
  seedJobsRow(
    db,
    "sess-c-dead-with-start",
    deadPid,
    "darwin:Wed Jan 01 00:00:00 1970",
  );
  // (d) dead pid no start_time → Killed (Q7 dead-pid rule).
  seedJobsRow(db, "sess-d-dead-no-start", deadPid, null);
  // (e) alive pid, no start_time (legacy / pre-schema-v9) → leave alone.
  seedJobsRow(db, "sess-e-alive-legacy", alivePid, null);

  // Run the sweep + drain (the same `sweep → drain` pair the daemon's boot
  // sequence runs).
  seedKilledSweep(db);
  drainToCompletion(db);

  function stateOf(jobId: string): string | undefined {
    const row = db
      .query("SELECT state FROM jobs WHERE job_id = ?")
      .get(jobId) as { state: string } | null;
    return row?.state;
  }

  // (b),(c),(d) → killed.
  expect(stateOf("sess-b-alive-recycled")).toBe("killed");
  expect(stateOf("sess-c-dead-with-start")).toBe("killed");
  expect(stateOf("sess-d-dead-no-start")).toBe("killed");
  // (e) legacy → unchanged.
  expect(stateOf("sess-e-alive-legacy")).toBe("stopped");
  // (a) alive matching → unchanged (when the platform probe was available).
  if (aliveStart != null) {
    expect(stateOf("sess-a-alive-matching")).toBe("stopped");
  }

  db.close();
});

test("seed sweep is idempotent — a second sweep emits no duplicate Killed events", () => {
  const { db } = openDb(dbPath);

  const deadPid = pickDeadPid();
  seedJobsRow(db, "sess-zombie", deadPid, null);

  // First sweep: should emit ONE Killed event and fold to `killed`.
  seedKilledSweep(db);
  drainToCompletion(db);
  expect(
    (
      db.query("SELECT state FROM jobs WHERE job_id = 'sess-zombie'").get() as {
        state: string;
      }
    ).state,
  ).toBe("killed");
  const firstKilledCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-zombie'",
      )
      .get() as { n: number }
  ).n;
  expect(firstKilledCount).toBe(1);

  // Second sweep: the row is now `killed` (terminal), so it's outside the
  // candidate query (`state IN ('working','stopped')`) and the sweep emits
  // NOTHING for it. This is the idempotency guarantee — we don't churn the
  // event log on every boot for already-killed sessions.
  seedKilledSweep(db);
  drainToCompletion(db);
  const secondKilledCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-zombie'",
      )
      .get() as { n: number }
  ).n;
  expect(secondKilledCount).toBe(1);

  db.close();
});

test("seed sweep ignores terminal rows (ended, killed) — incl. NULL-pid ones", () => {
  const { db } = openDb(dbPath);

  const deadPid = pickDeadPid();
  // Terminal states are out of scope per the candidate query — even with a
  // NULL pid (a terminal NULL-pid row stays put; the fn-743 reap is for
  // NON-terminal NULL-pid rows only).
  seedJobsRow(db, "sess-ended", deadPid, null, "ended");
  seedJobsRow(db, "sess-already-killed", deadPid, null, "killed");
  seedJobsRow(db, "sess-no-pid-ended", null, null, "ended");

  seedKilledSweep(db);
  drainToCompletion(db);

  // None of these should have had a Killed event emitted against them.
  const killedCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id IN ('sess-ended','sess-already-killed','sess-no-pid-ended')",
      )
      .get() as { n: number }
  ).n;
  expect(killedCount).toBe(0);

  // States preserved.
  function stateOf(jobId: string): string {
    return (
      db.query("SELECT state FROM jobs WHERE job_id = ?").get(jobId) as {
        state: string;
      }
    ).state;
  }
  expect(stateOf("sess-ended")).toBe("ended");
  expect(stateOf("sess-already-killed")).toBe("killed");
  expect(stateOf("sess-no-pid-ended")).toBe("ended");

  db.close();
});

test("fn-743 seed sweep: a NON-terminal NULL-pid (stopped) row IS reaped to killed", () => {
  // The stuck-`stopped` incident (2026-06-08): a NULL-pid stopped row is
  // unwatchable (exit-watcher's old `pid IS NOT NULL` filter never armed it)
  // and unprobeable, so it lived forever. The sweep now reaps it via a pidless
  // Killed. Default state for `seedJobsRow` is `stopped`.
  const { db } = openDb(dbPath);
  seedJobsRow(db, "sess-no-pid", null, null);

  seedKilledSweep(db);
  drainToCompletion(db);

  const killedCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-no-pid'",
      )
      .get() as { n: number }
  ).n;
  expect(killedCount).toBe(1);
  const state = (
    db.query("SELECT state FROM jobs WHERE job_id = 'sess-no-pid'").get() as {
      state: string;
    }
  ).state;
  expect(state).toBe("killed");

  db.close();
});

// ---------------------------------------------------------------------------
// recoverOneDeadLetter (fn-643 task .4 — the replay transaction)
// ---------------------------------------------------------------------------

/**
 * Insert one dead-letter row in the `waiting` state. Mirrors what
 * `scanDeadLetterDir` would have written from a parsed NDJSON record. Each
 * test that needs more rows calls this multiple times — write-time keys
 * `(dl_written_at, dl_id)` drive the oldest-first replay pick.
 */
function seedDeadLetter(
  db: ReturnType<typeof openDb>["db"],
  opts: {
    dl_id: string;
    session_id: string;
    hook_event: string;
    ts: number;
    dl_written_at: number;
    pid?: number | null;
    bindings: Record<string, unknown>;
    source_file?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, ?)`,
  ).run(
    opts.dl_id,
    opts.session_id,
    opts.hook_event,
    opts.ts,
    opts.dl_written_at,
    opts.pid ?? null,
    JSON.stringify(opts.bindings),
    opts.source_file ?? null,
  );
}

test("recoverOneDeadLetter appends a real events row + flips dead_letters to recovered, in one transaction", () => {
  const { db } = openDb(dbPath);
  // Seed one SessionStart dead-letter — the dropped-incident scenario.
  seedDeadLetter(db, {
    dl_id: "dl-aaa",
    session_id: "sess-recovered",
    hook_event: "SessionStart",
    ts: 1_700_000_000,
    dl_written_at: 1_700_000_001,
    pid: 4242,
    bindings: {
      ts: 1_700_000_000,
      session_id: "sess-recovered",
      pid: 4242,
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: JSON.stringify({}),
      cwd: "/tmp/foo",
      spawn_name: "agent-x",
      start_time: "darwin:Mon Jan  1 00:00:00 2026",
      config_dir: null,
    },
  });

  const eventsBefore = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;

  const dlId = recoverOneDeadLetter(db);
  expect(dlId).toBe("dl-aaa");

  // A real events row landed, carrying the stored bindings verbatim.
  const eventsAfter = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(eventsAfter).toBe(eventsBefore + 1);
  const replayed = db
    .query(
      `SELECT id, session_id, hook_event, pid, cwd, spawn_name, start_time, ts
         FROM events WHERE session_id = 'sess-recovered'`,
    )
    .get() as {
    id: number;
    session_id: string;
    hook_event: string;
    pid: number | null;
    cwd: string | null;
    spawn_name: string | null;
    start_time: string | null;
    ts: number;
  };
  expect(replayed.hook_event).toBe("SessionStart");
  expect(replayed.pid).toBe(4242);
  expect(replayed.cwd).toBe("/tmp/foo");
  expect(replayed.spawn_name).toBe("agent-x");
  expect(replayed.start_time).toBe("darwin:Mon Jan  1 00:00:00 2026");
  // ts preserved verbatim (NOT stamped to Date.now()/1000 — this is a real
  // event with the original wall-clock time).
  expect(replayed.ts).toBe(1_700_000_000);

  // Dead-letter row flipped to recovered with the captured event id.
  const dlRow = db
    .query(
      `SELECT status, recovered_at, replayed_event_id FROM dead_letters WHERE dl_id = 'dl-aaa'`,
    )
    .get() as {
    status: string;
    recovered_at: number;
    replayed_event_id: number;
  };
  expect(dlRow.status).toBe("recovered");
  expect(dlRow.replayed_event_id).toBe(replayed.id);
  expect(typeof dlRow.recovered_at).toBe("number");
  expect(dlRow.recovered_at).toBeGreaterThan(0);

  db.close();
});

test("recoverOneDeadLetter folded by the reducer → jobs row appears for the recovered session", () => {
  const { db } = openDb(dbPath);
  seedDeadLetter(db, {
    dl_id: "dl-bbb",
    session_id: "sess-folded",
    hook_event: "SessionStart",
    ts: 1_700_000_010,
    dl_written_at: 1_700_000_011,
    pid: 9999,
    bindings: {
      ts: 1_700_000_010,
      session_id: "sess-folded",
      pid: 9999,
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: JSON.stringify({}),
      cwd: "/work",
    },
  });

  // No jobs row yet — the SessionStart was dropped before this test ran.
  const before = db
    .query("SELECT COUNT(*) AS n FROM jobs WHERE job_id = 'sess-folded'")
    .get() as { n: number };
  expect(before.n).toBe(0);

  expect(recoverOneDeadLetter(db)).toBe("dl-bbb");

  // Drain folds the appended event into the projection.
  drainToCompletion(db);

  const after = db
    .query("SELECT job_id, state, cwd FROM jobs WHERE job_id = 'sess-folded'")
    .get() as { job_id: string; state: string; cwd: string };
  expect(after.job_id).toBe("sess-folded");
  // The reducer's SessionStart fold seeds a row in 'stopped' state — the
  // session would flip to 'working' on the next UserPromptSubmit. Replaying
  // just the dropped SessionStart resurrects the row, which is the whole
  // point of the recovery (the row appears on the board where it was
  // invisible before).
  expect(after.state).toBe("stopped");
  expect(after.cwd).toBe("/work");

  db.close();
});

test("recoverOneDeadLetter picks the OLDEST waiting row, ordered by (dl_written_at ASC, dl_id ASC)", () => {
  const { db } = openDb(dbPath);
  // Three rows; the middle write_at is the oldest by dl_written_at, and the
  // dl_id tiebreaker resolves the dl_written_at tie deterministically.
  seedDeadLetter(db, {
    dl_id: "dl-2",
    session_id: "sess-2",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 200,
    bindings: {
      ts: 1,
      session_id: "sess-2",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  seedDeadLetter(db, {
    dl_id: "dl-1a",
    session_id: "sess-1a",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 100,
    bindings: {
      ts: 1,
      session_id: "sess-1a",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  seedDeadLetter(db, {
    dl_id: "dl-1b",
    session_id: "sess-1b",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 100,
    bindings: {
      ts: 1,
      session_id: "sess-1b",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });

  // Oldest by dl_written_at (100) with the smallest dl_id ('dl-1a') wins.
  expect(recoverOneDeadLetter(db)).toBe("dl-1a");
  // Next oldest at dl_written_at=100 with dl_id 'dl-1b'.
  expect(recoverOneDeadLetter(db)).toBe("dl-1b");
  // Then the dl_written_at=200 row.
  expect(recoverOneDeadLetter(db)).toBe("dl-2");
  // No more waiting rows.
  expect(recoverOneDeadLetter(db)).toBeNull();

  db.close();
});

test("recoverOneDeadLetter on empty backlog returns null and writes nothing", () => {
  const { db } = openDb(dbPath);
  const eventsBefore = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(recoverOneDeadLetter(db)).toBeNull();
  const eventsAfter = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(eventsAfter).toBe(eventsBefore);
  db.close();
});

test("recoverOneDeadLetter rolls back the events INSERT on malformed bindings; row stays waiting", () => {
  const { db } = openDb(dbPath);
  // Hand-write a row with garbage `bindings` JSON (bypassing
  // parseDeadLetterLine which would have rejected it on the import path).
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', NULL, NULL, NULL)`,
  ).run("dl-bad", "sess-bad", "SessionStart", 1, 1, null, "this is not json");

  const eventsBefore = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(() => recoverOneDeadLetter(db)).toThrow(/bindings JSON parse failed/);
  // Transaction rolled back: no events row, dead-letter row still waiting.
  const eventsAfter = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(eventsAfter).toBe(eventsBefore);
  const dlRow = db
    .query("SELECT status FROM dead_letters WHERE dl_id = 'dl-bad'")
    .get() as { status: string };
  expect(dlRow.status).toBe("waiting");
  db.close();
});

test("recoverOneDeadLetter forward-compat: unknown columns in bindings are dropped, known ones bind", () => {
  const { db } = openDb(dbPath);
  seedDeadLetter(db, {
    dl_id: "dl-fwd",
    session_id: "sess-fwd",
    hook_event: "SessionStart",
    ts: 5,
    dl_written_at: 5,
    bindings: {
      ts: 5,
      session_id: "sess-fwd",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
      // A column from a hypothetical future schema — dropped on replay.
      future_column_v99: "should-be-ignored",
    },
  });
  expect(recoverOneDeadLetter(db)).toBe("dl-fwd");
  const row = db
    .query(
      "SELECT session_id, hook_event FROM events WHERE session_id = 'sess-fwd'",
    )
    .get() as { session_id: string; hook_event: string };
  expect(row.session_id).toBe("sess-fwd");
  expect(row.hook_event).toBe("SessionStart");
  db.close();
});

test("recoverOneDeadLetter skips rows already in `recovered` status (idempotency under re-invocation)", () => {
  const { db } = openDb(dbPath);
  seedDeadLetter(db, {
    dl_id: "dl-once",
    session_id: "sess-once",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 1,
    bindings: {
      ts: 1,
      session_id: "sess-once",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  expect(recoverOneDeadLetter(db)).toBe("dl-once");
  // A second invocation sees zero waiting rows — the same dl_id never
  // recovers twice.
  expect(recoverOneDeadLetter(db)).toBeNull();
  db.close();
});

test("recoverOneDeadLetter does NOT touch dead_letters on a re-fold (the row survives DELETE FROM jobs+epics)", () => {
  // Re-fold determinism invariant (CLAUDE.md "DO NOT" — dead_letters is an
  // operational sidecar, NEVER a fold target). Recover, then simulate a
  // from-scratch re-fold: zero the cursor + delete projections + re-drain.
  // dead_letters row must survive byte-identically.
  const { db } = openDb(dbPath);
  seedDeadLetter(db, {
    dl_id: "dl-refold",
    session_id: "sess-refold",
    hook_event: "SessionStart",
    ts: 7,
    dl_written_at: 7,
    bindings: {
      ts: 7,
      session_id: "sess-refold",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  expect(recoverOneDeadLetter(db)).toBe("dl-refold");
  drainToCompletion(db);

  const dlBefore = db
    .query("SELECT * FROM dead_letters WHERE dl_id = 'dl-refold'")
    .get() as Record<string, unknown>;

  // Simulate a from-scratch re-fold.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainToCompletion(db);

  const dlAfter = db
    .query("SELECT * FROM dead_letters WHERE dl_id = 'dl-refold'")
    .get() as Record<string, unknown>;
  expect(dlAfter).toEqual(dlBefore);
  // The re-fold reproduced the jobs row from the events log.
  const job = db
    .query("SELECT state FROM jobs WHERE job_id = 'sess-refold'")
    .get() as { state: string };
  // The reducer's SessionStart fold seeds a row in 'stopped' state (the
  // initial state — the row flips to 'working' only on the next
  // UserPromptSubmit). Replaying just the SessionStart resurrects the row;
  // the rest of the session lifecycle would arrive via subsequent events
  // if any were dead-lettered alongside (out of scope for v1 — replay is
  // one record at a time, and a partial recovery is still strictly better
  // than the row never appearing on the board).
  expect(job.state).toBe("stopped");
  db.close();
});

// ---------------------------------------------------------------------------
// fn-739 task .1 — backlog-drain: end-to-end scan→replay re-fold parity, and
// the torn-tail scan-skip. The earlier `recoverOneDeadLetter` block seeds the
// `dead_letters` row directly; these two drive the FULL on-disk NDJSON path
// (`scanDeadLetterDir` import → `recoverOneDeadLetter` replay) so the file
// import + idempotency + torn-tail contracts are exercised together.
// ---------------------------------------------------------------------------

test("scan→replay re-fold parity: a record imported from an NDJSON file folds byte-identically to a directly-landed event", () => {
  // Bindings the hook would have written had its INSERT not been dropped — a
  // full SessionStart binding incl. the SessionStart-scraped fields.
  const bindings = {
    ts: 1_700_000_500,
    session_id: "sess-parity",
    pid: 4242,
    hook_event: "SessionStart",
    event_type: "lifecycle",
    data: "{}",
    cwd: "/tmp/parity",
    permission_mode: null,
    spawn_name: "agent-parity",
    start_time: "darwin:Mon Jan  1 00:00:00 2026",
    config_dir: null,
  };

  // (A) Directly-landed reference: INSERT the same bindings straight into
  // `events` and fold — this is what the hook's original INSERT would have
  // produced.
  const refPath = join(tmpDir, "ref.db");
  const { db: refDb } = openDb(refPath);
  const refCols = Object.keys(bindings);
  refDb.run(
    `INSERT INTO events (${refCols.join(", ")}) VALUES (${refCols.map(() => "?").join(", ")})`,
    refCols.map(
      (c) => (bindings as Record<string, unknown>)[c] as string | number | null,
    ),
  );
  drainToCompletion(refDb);
  const refJob = refDb
    .query("SELECT * FROM jobs WHERE job_id = 'sess-parity'")
    .get() as Record<string, unknown>;
  refDb.close();

  // (B) Replayed path: write the record to an on-disk per-pid NDJSON file,
  // import via `scanDeadLetterDir`, replay via `recoverOneDeadLetter`, fold.
  const { db } = openDb(dbPath);
  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  writeFileSync(
    join(dlDir, "4242.ndjson"),
    serializeDeadLetterRecord({
      dl_id: "dl-parity",
      session_id: "sess-parity",
      hook_event: "SessionStart",
      ts: 1_700_000_500,
      dl_written_at: 1_700_000_501,
      pid: 4242,
      bindings,
    }),
  );
  scanDeadLetterDir(db, dlDir);
  expect(recoverOneDeadLetter(db)).toBe("dl-parity");
  drainToCompletion(db);
  const job = db
    .query("SELECT * FROM jobs WHERE job_id = 'sess-parity'")
    .get() as Record<string, unknown>;

  // The replayed-path projection row is byte-identical to the directly-landed
  // one — the re-fold determinism invariant holds through the replay path.
  expect(job).toEqual(refJob);
  db.close();
});

test("scan→replay idempotency: importing + replaying twice yields exactly one events row (no dup on re-run)", () => {
  const { db } = openDb(dbPath);
  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const line = serializeDeadLetterRecord({
    dl_id: "dl-idem",
    session_id: "sess-idem",
    hook_event: "SessionStart",
    ts: 9,
    dl_written_at: 9,
    pid: 7,
    bindings: {
      ts: 9,
      session_id: "sess-idem",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  writeFileSync(join(dlDir, "7.ndjson"), line);

  // First drain: import (INSERT OR IGNORE on dl_id) + replay.
  scanDeadLetterDir(db, dlDir);
  expect(recoverOneDeadLetter(db)).toBe("dl-idem");

  // Re-run the WHOLE path (file still on disk — as it is in production until a
  // cleanup pass moves it): the re-scan's INSERT OR IGNORE is a no-op on the
  // existing dl_id, and the row is already `recovered` so replay skips it.
  scanDeadLetterDir(db, dlDir);
  expect(recoverOneDeadLetter(db)).toBeNull();

  // Exactly one events row for the session — no duplicate.
  const n = (
    db
      .query("SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-idem'")
      .get() as { n: number }
  ).n;
  expect(n).toBe(1);
  db.close();
});

test("scanDeadLetterDir skips a torn final line — the partial record is never imported or replayed", () => {
  const { db } = openDb(dbPath);
  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });

  const whole = serializeDeadLetterRecord({
    dl_id: "dl-whole",
    session_id: "sess-whole",
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 1,
    pid: 1,
    bindings: {
      ts: 1,
      session_id: "sess-whole",
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
  // A second record truncated mid-write (no trailing newline, JSON cut off) —
  // exactly what a killed hook process leaves behind.
  const torn = '{"dl_id":"dl-torn","session_id":"sess-torn","hook_eve';
  writeFileSync(join(dlDir, "1.ndjson"), whole + torn);

  scanDeadLetterDir(db, dlDir);

  // Only the whole record imported; the torn tail produced no row.
  const ids = (
    db.query("SELECT dl_id FROM dead_letters ORDER BY dl_id").all() as {
      dl_id: string;
    }[]
  ).map((r) => r.dl_id);
  expect(ids).toEqual(["dl-whole"]);

  // And replay drains only the whole one; the torn record never replays.
  expect(recoverOneDeadLetter(db)).toBe("dl-whole");
  expect(recoverOneDeadLetter(db)).toBeNull();
  expect(
    (
      db
        .query(
          "SELECT COUNT(*) AS n FROM events WHERE session_id = 'sess-torn'",
        )
        .get() as { n: number }
    ).n,
  ).toBe(0);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-740 task .1 — archive-recovered-dead-letters.ts eligibility gate. F2 from
// the fn-739 audit: the script's DATA-SAFETY CONTRACT (allConfirmed gate,
// ids.length===0 early-exit, recovered-but-no-replayed_event_id exclusion, and
// the --apply move) had zero direct coverage. These four tests drive the real
// script as a subprocess against a sandboxed KEEPER_DB + KEEPER_DEAD_LETTER_DIR
// and assert on whether the on-disk file is moved to archive/ or left in place.
// ---------------------------------------------------------------------------

const ARCHIVE_SCRIPT = join(
  import.meta.dir,
  "..",
  "scripts",
  "archive-recovered-dead-letters.ts",
);

/**
 * Insert a `recovered` dead_letters row AND its landed `events` row so the
 * script's `confirmed` set (status='recovered' AND replayed_event_id IS NOT
 * NULL AND that events row EXISTS) includes this dl_id. Returns the dl_id.
 */
function seedConfirmedRecovered(
  db: ReturnType<typeof openDb>["db"],
  dlId: string,
  sessionId: string,
): void {
  const info = db
    .prepare(
      `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'SessionStart', 'lifecycle', '{}')`,
    )
    .run(1, sessionId);
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, 'SessionStart', 1, 1, 1, '{}', 'recovered', 1, ?, NULL)`,
  ).run(dlId, sessionId, info.lastInsertRowid as number);
}

/** Seed a `waiting` (not-yet-recovered) dead_letters row — no events row. */
function seedWaiting(
  db: ReturnType<typeof openDb>["db"],
  dlId: string,
  sessionId: string,
): void {
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES (?, ?, 'SessionStart', 1, 1, 1, '{}', 'waiting', NULL, NULL, NULL)`,
  ).run(dlId, sessionId);
}

/** Serialize one NDJSON line carrying just the dl_id the script keys on. */
function dlLine(dlId: string, sessionId: string): string {
  return serializeDeadLetterRecord({
    dl_id: dlId,
    session_id: sessionId,
    hook_event: "SessionStart",
    ts: 1,
    dl_written_at: 1,
    pid: 1,
    bindings: {
      ts: 1,
      session_id: sessionId,
      hook_event: "SessionStart",
      event_type: "lifecycle",
      data: "{}",
    },
  });
}

/** Run the archive script as a subprocess against the sandboxed DB + dl dir. */
function runArchiveScript(dlDir: string, args: string[] = []): void {
  const proc = Bun.spawnSync(["bun", ARCHIVE_SCRIPT, ...args], {
    env: {
      ...process.env,
      KEEPER_DB: dbPath,
      KEEPER_DEAD_LETTER_DIR: dlDir,
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `archive script exited ${proc.exitCode}: ${proc.stderr.toString()}`,
    );
  }
}

test("archive eligibility: a file with one still-waiting record is left in place (allConfirmed gate fires)", () => {
  // The DB must exist + be migrated before the read-only script opens it.
  openDb(dbPath).db.close();
  const { db } = openDb(dbPath);
  // One confirmed-recovered record and one still-waiting record share a file.
  seedConfirmedRecovered(db, "dl-ok", "sess-ok");
  seedWaiting(db, "dl-wait", "sess-wait");
  db.close();

  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const file = join(dlDir, "mixed.ndjson");
  writeFileSync(
    file,
    dlLine("dl-ok", "sess-ok") + dlLine("dl-wait", "sess-wait"),
  );

  runArchiveScript(dlDir, ["--apply"]);

  // allConfirmed === false (the waiting record is not in `confirmed`) → the
  // whole file stays, never archived on a guess.
  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(dlDir, "archive", "mixed.ndjson"))).toBe(false);
});

test("archive eligibility: a recovered record with no replayed_event_id is excluded; the file stays", () => {
  openDb(dbPath).db.close();
  const { db } = openDb(dbPath);
  // Status flipped to `recovered` but replayed_event_id never stamped (the
  // should-never-happen case). The script's `EXISTS` SELECT excludes it from
  // `confirmed`, so allConfirmed fires false.
  db.prepare(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings,
        status, recovered_at, replayed_event_id, source_file)
     VALUES ('dl-noid', 'sess-noid', 'SessionStart', 1, 1, 1, '{}',
             'recovered', 1, NULL, NULL)`,
  ).run();
  db.close();

  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const file = join(dlDir, "noid.ndjson");
  writeFileSync(file, dlLine("dl-noid", "sess-noid"));

  runArchiveScript(dlDir, ["--apply"]);

  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(dlDir, "archive", "noid.ndjson"))).toBe(false);
});

test("archive eligibility: an all-torn file (ids.length === 0) is left untouched", () => {
  openDb(dbPath).db.close();

  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const file = join(dlDir, "torn.ndjson");
  // Every line is unparseable garbage — no recoverable record. parseDeadLetterLine
  // returns null for each → ids stays empty → the file is not archived (nothing
  // to confirm landed).
  writeFileSync(file, "not json\n{bad\n");

  runArchiveScript(dlDir, ["--apply"]);

  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(dlDir, "archive", "torn.ndjson"))).toBe(false);
});

test("archive eligibility: --apply moves a fully-confirmed file to the archive/ subdir", () => {
  openDb(dbPath).db.close();
  const { db } = openDb(dbPath);
  seedConfirmedRecovered(db, "dl-a", "sess-a");
  seedConfirmedRecovered(db, "dl-b", "sess-b");
  db.close();

  const dlDir = join(tmpDir, "dead-letters");
  mkdirSync(dlDir, { recursive: true });
  const file = join(dlDir, "done.ndjson");
  writeFileSync(file, dlLine("dl-a", "sess-a") + dlLine("dl-b", "sess-b"));

  // Dry run first: every record is confirmed, but without --apply the file
  // stays put (only reported).
  runArchiveScript(dlDir);
  expect(existsSync(file)).toBe(true);
  expect(existsSync(join(dlDir, "archive", "done.ndjson"))).toBe(false);

  // --apply moves the eligible file into archive/.
  runArchiveScript(dlDir, ["--apply"]);
  expect(existsSync(file)).toBe(false);
  expect(existsSync(join(dlDir, "archive", "done.ndjson"))).toBe(true);
});

// ---------------------------------------------------------------------------
// fn-651 task .1 — UsageSnapshot serializer (the worker→event wire shape)
// ---------------------------------------------------------------------------
//
// Pre-fix the inline `JSON.stringify({...})` in the `usage-snapshot` worker
// handler dropped the fn-645 freshness fields (`status`,
// `subscription_active`, `error_type`, `error_message`, `error_at`), so the
// reducer's UPSERT folded them to NULL forever — `mc1` (no subscription)
// never got redacted and the status chip never rendered. These tests pin
// the extracted serializer's wire shape so the leak can't recur, then
// run a full round-trip through the reducer to prove the columns
// actually populate end-to-end.

test("fn-651: serializeUsageSnapshot forwards every projection-meaningful field", () => {
  const wire = JSON.parse(
    serializeUsageSnapshot({
      kind: "usage-snapshot",
      id: "claude-mc1",
      target: "claude",
      multiplier: 5,
      session_percent: 42.5,
      session_resets_at: "2026-05-30T18:30:00-04:00",
      week_percent: 17.0,
      week_resets_at: "2026-06-01T20:00:00-04:00",
      sonnet_week_percent: 9.0,
      sonnet_week_resets_at: "2026-06-01T20:00:00-04:00",
      status: "stale",
      subscription_active: false,
      error_type: "ClaudeUsageParseError",
      error_message: "cli output unparseable",
      error_at: "2026-05-30T12:00:00-04:00",
      // fn-651 task .4: rate-limit lift instant. The companion
      // `last_usage_fold_at` is NOT a serialized field — the reducer
      // derives it from the event ts on a successful fold.
      lift_at: "2026-05-30T20:30:00-04:00",
    }),
  );
  // Every fn-645 + earlier projection field present and round-trippable.
  expect(wire).toEqual({
    target: "claude",
    multiplier: 5,
    session_percent: 42.5,
    session_resets_at: "2026-05-30T18:30:00-04:00",
    week_percent: 17.0,
    week_resets_at: "2026-06-01T20:00:00-04:00",
    sonnet_week_percent: 9.0,
    sonnet_week_resets_at: "2026-06-01T20:00:00-04:00",
    status: "stale",
    subscription_active: false,
    error_type: "ClaudeUsageParseError",
    error_message: "cli output unparseable",
    error_at: "2026-05-30T12:00:00-04:00",
    // fn-651 task .4: top-level envelope field, projected onto
    // `usage.rate_limit_lifts_at` by parseUsageSnapshot.
    lift_at: "2026-05-30T20:30:00-04:00",
  });
  // `kind` / `id` are NOT projection fields — the discriminator is event
  // metadata and `id` rides in `events.session_id` via the synthetic-event
  // pipeline's generic entity-key overload.
  expect(wire.kind).toBeUndefined();
  expect(wire.id).toBeUndefined();
});

test("fn-651: serialized snapshot folds end-to-end — status / subscription_active / error_* are non-NULL after drain", () => {
  const { db } = openDb(dbPath);
  // Seed the events row exactly the way main's `usage-snapshot` handler
  // would: session_id = profile pk, data = serialized payload.
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
       VALUES (?, ?, NULL, 'UsageSnapshot', 'usage_snapshot', ?)`,
    [
      1000,
      "claude-mc1",
      serializeUsageSnapshot({
        kind: "usage-snapshot",
        id: "claude-mc1",
        target: "claude",
        multiplier: 5,
        session_percent: 0,
        session_resets_at: null,
        week_percent: 0,
        week_resets_at: null,
        sonnet_week_percent: null,
        sonnet_week_resets_at: null,
        status: "stale",
        subscription_active: false,
        error_type: "ClaudeUsageParseError",
        error_message: "boom",
        error_at: "2026-05-30T12:00:00-04:00",
        lift_at: null,
      }),
    ],
  );
  drainToCompletion(db);
  const row = db
    .query(
      `SELECT status, subscription_active, error_type, error_message, error_at,
              sonnet_week_resets_at
         FROM usage WHERE id = ?`,
    )
    .get("claude-mc1") as {
    status: string | null;
    subscription_active: number | null;
    error_type: string | null;
    error_message: string | null;
    error_at: string | null;
    sonnet_week_resets_at: string | null;
  };
  expect(row.status).toBe("stale");
  // The reducer coerces boolean false → integer 0 on the column.
  expect(row.subscription_active).toBe(0);
  expect(row.error_type).toBe("ClaudeUsageParseError");
  expect(row.error_message).toBe("boom");
  expect(row.error_at).toBe("2026-05-30T12:00:00-04:00");
  // sonnet_week_resets_at was null in the message; folds to NULL safely.
  expect(row.sonnet_week_resets_at).toBeNull();
  db.close();
});

test("fn-651: a no-subscription envelope folds subscription_active = 0 so the renderer redacts it", () => {
  // The `mc1` case from the epic spec: subscription_active=false on the
  // wire becomes 0 in the column, which is what `cli/usage.ts`'s
  // `subscription_active !== 0` filter checks to redact the row.
  const { db } = openDb(dbPath);
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
       VALUES (?, ?, NULL, 'UsageSnapshot', 'usage_snapshot', ?)`,
    [
      2000,
      "claude-mc1",
      serializeUsageSnapshot({
        kind: "usage-snapshot",
        id: "claude-mc1",
        target: "claude",
        multiplier: 1,
        session_percent: null,
        session_resets_at: null,
        week_percent: null,
        week_resets_at: null,
        sonnet_week_percent: null,
        sonnet_week_resets_at: null,
        status: "active",
        subscription_active: false,
        error_type: null,
        error_message: null,
        error_at: null,
        lift_at: null,
      }),
    ],
  );
  drainToCompletion(db);
  const row = db
    .query(`SELECT subscription_active, status FROM usage WHERE id = ?`)
    .get("claude-mc1") as {
    subscription_active: number | null;
    status: string | null;
  };
  expect(row.subscription_active).toBe(0);
  expect(row.status).toBe("active");
  db.close();
});

test("fn-651: an old event missing the fn-645 fields folds them to NULL without error (backwards-compat)", () => {
  // Pre-fix events on disk have the data blob WITHOUT status /
  // subscription_active / error_*. The reducer must keep folding them
  // safely; only NEW events carry the fields. This pins the
  // backwards-compat contract spelled in the task spec.
  const { db } = openDb(dbPath);
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
       VALUES (?, ?, NULL, 'UsageSnapshot', 'usage_snapshot', ?)`,
    [
      3000,
      "claude-legacy",
      JSON.stringify({
        target: "claude",
        multiplier: 5,
        session_percent: 1.0,
        session_resets_at: "T1",
        week_percent: 1.0,
        week_resets_at: "T2",
        // fn-645 fields deliberately omitted — pre-fix shape.
      }),
    ],
  );
  drainToCompletion(db);
  const row = db
    .query(
      `SELECT status, subscription_active, error_type, error_message, error_at
         FROM usage WHERE id = ?`,
    )
    .get("claude-legacy") as {
    status: string | null;
    subscription_active: number | null;
    error_type: string | null;
    error_message: string | null;
    error_at: string | null;
  };
  expect(row.status).toBeNull();
  expect(row.subscription_active).toBeNull();
  expect(row.error_type).toBeNull();
  expect(row.error_message).toBeNull();
  expect(row.error_at).toBeNull();
  db.close();
});

// ---------------------------------------------------------------------------
// fn-661 task .4 — autopilot worker spawn + shutdown contract
// ---------------------------------------------------------------------------

/**
 * Spawn the autopilot worker against a tmp DB, await its first
 * `data_version`-poll tick by sleeping briefly, send the standard
 * `{type:"shutdown"}` message, and assert the worker's `close` event
 * fires within the test deadline. Mirrors the server-worker shutdown
 * test pattern (`test/server-worker.test.ts`): spawn → exercise →
 * shutdown → race against a 2s deadline.
 *
 * Why a direct spawn rather than a full `runDaemon()` boot: the daemon
 * module is import-safe behind its `import.meta.main` guard, but a
 * full boot opens the writer DB, launches nine other workers, binds
 * a UDS, and writes the LaunchAgent state dir — far outside the scope
 * of "does the autopilot worker accept its initial workerData and
 * shut down cleanly". Each test below targets one contract piece.
 */
test("autopilot worker spawns with paused=true workerData and shuts down cleanly on {type:'shutdown'}", async () => {
  // Fresh DB so the worker's readonly openDb has a real schema to open
  // against. The migrate path is the daemon's job; for this contract
  // test we just need the file to exist.
  openDb(dbPath).db.close();

  const worker = new Worker(
    new URL("../src/autopilot-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        paused: true,
        execBackend: "zellij",
        pollMs: 25,
      },
    } as WorkerOptions & { workerData: unknown },
  );

  let closed = false;
  worker.addEventListener("close", () => {
    closed = true;
  });

  // Autopilot emits no `ready` signal, so the boot window (RO conn +
  // `parentPort.on("message")` listener + `watchLoop` poll) can race a
  // one-shot shutdown. Re-emit the idempotent `shutdown` each tick until the
  // close lands; guard on the flag so we never post to an already-closed
  // worker. The poll absorbs boot latency — no blind boot sleep needed.
  const ok = await retryUntil(() => {
    if (!closed) {
      worker.postMessage({ type: "shutdown" });
    }
    return closed || null;
  }, 60_000);
  expect(ok).toBe(true);
}, 120_000);

test("autopilot worker accepts {type:'set-paused', paused} commands without crashing the loop", async () => {
  openDb(dbPath).db.close();

  const worker = new Worker(
    new URL("../src/autopilot-worker.ts", import.meta.url).href,
    {
      workerData: {
        dbPath,
        paused: true,
        execBackend: "zellij",
        pollMs: 25,
      },
    } as WorkerOptions & { workerData: unknown },
  );

  let closed = false;
  worker.addEventListener("close", () => {
    closed = true;
  });

  // Flip paused both directions. The worker's loop is a no-op today
  // (the reconcile glue is a sibling task), but the message handler
  // MUST accept these without throwing — that's the boot-pause +
  // play/pause contract this task wires up. parent→worker messages are
  // queued, so these land in order even before the worker's listener is
  // attached; no boot sleep needed.
  worker.postMessage({ type: "set-paused", paused: false });
  worker.postMessage({ type: "set-paused", paused: true });
  worker.postMessage({ type: "set-paused", paused: false });

  // Autopilot emits no `ready` signal — re-emit the idempotent shutdown each
  // tick (guarded on the flag) so a boot-race can't drop the one-shot trigger.
  const ok = await retryUntil(() => {
    if (!closed) {
      worker.postMessage({ type: "shutdown" });
    }
    return closed || null;
  }, 60_000);
  expect(ok).toBe(true);
}, 120_000);

// ---------------------------------------------------------------------------
// fn-678 task .3 — pending_dispatches TTL sweep (producer-side, 60s heartbeat)
// ---------------------------------------------------------------------------

/**
 * Insert a row directly into `pending_dispatches`. Bypasses the reducer
 * — fine for unit testing the sweep selector, which doesn't depend on
 * how the row arrived (the reducer's `foldDispatched` UPSERT path is
 * covered by `reducer.test.ts`).
 */
function seedPendingDispatch(
  db: ReturnType<typeof openDb>["db"],
  verb: string,
  id: string,
  dispatchedAtSec: number,
  dir: string | null = null,
  lastEventId = 1,
): void {
  db.run(
    `INSERT INTO pending_dispatches (verb, id, dir, dispatched_at, last_event_id)
       VALUES (?, ?, ?, ?, ?)`,
    [verb, id, dir, dispatchedAtSec, lastEventId],
  );
}

function seedDispatchFailure(
  db: ReturnType<typeof openDb>["db"],
  verb: string,
  id: string,
  tsSec: number,
): void {
  db.run(
    `INSERT INTO dispatch_failures (
       verb, id, reason, dir, ts, last_event_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [verb, id, "ceiling-elapsed", null, tsSec, 1, tsSec, tsSec],
  );
}

test("PENDING_DISPATCH_TTL_MS is 120s (>= 2x the documented 60s cold-start ceiling)", () => {
  // The constant defends the fn-627 double-dispatch invariant: a worker
  // mid-boot must NEVER be re-dispatched over. Documented cold start P99
  // is ~24-33s; 120s gives ~3-4x margin. A regression here would
  // re-create the hazard the projection exists to eliminate.
  expect(PENDING_DISPATCH_TTL_MS).toBe(120_000);
});

test("fn-724: SCHEMA_VERSION tracks the live schema (durable ack itself added no schema)", () => {
  // The fn-724 durable mint-before-launch + three-way outcome is entirely
  // a producer-side control-flow change: a new id-correlated
  // dispatched-request/ack on the main↔autopilot-worker channel and the
  // ceiling→indoubt emit suppression. The reducer arms
  // (foldDispatched / foldDispatchFailed / foldDispatchExpired) were
  // UNTOUCHED by fn-724 — no new event, no new column, no migration; it
  // landed against the fn-719 schema value (59).
  //
  // The schema has since LEGITIMATELY advanced — to 60 via fn-725 (the
  // max_concurrent_jobs cap snapshot), to 61 via fn-736 task .1 (the
  // `event_ingest_offsets` NDJSON→events ingest cursor), to 62 via fn-751
  // task .1 (the autopilot `mode` column + the `armed_epics` presence table),
  // to 63 via fn-756 task .2 (drop `epics.approval` + rewrite
  // `default_visible`), to 64 via fn-781 task .1 (the `builds` buildbot
  // dashboard projection table), to 65 via fn-784 task .1 (the folded
  // `jobs.active_since` recency column for the unified dash AGENTS timeline),
  // to 66 via fn-787 task .2 (the session-anchored partial index
  // `idx_events_pretooluse_agent_session` for the SubagentStart fold's
  // pending-PreToolUse bridge), to 67 via fn-807 task .2 (the
  // `commit_trailer_facts` projection table that de-blobs the commit-trailer
  // channel of `syncPlanLinks`), to 68 via fn-813 task .1 (the
  // `scheduled_tasks` projection table folding the CronCreate/CronDelete
  // PostToolUse pair onto the jobs surface), to 69 via fn-38 task .2 (the
  // `subagent_invocations.last_disposition` column feeding the SILENT_STREAM_CUT
  // drop detector), to 70 via fn-817 task .1 (the producer-stamped
  // `jobs.close_kind` column the DB-derived crash-restore set reads), to 71
  // via fn-817 task .2 (the folded `jobs.window_index` column carrying visual
  // window order for the DB-only crash-restore derivation), to 72 via
  // fn-826 task .1 (widening the `file_attributions.source` CHECK to accept the
  // renamed `'plan'` alongside legacy `'planctl'` — a row-preserving table
  // rebuild, no cursor rewind), to 73 via fn-836 task .2 (the additive
  // `events.mutation_path` column promoting the git-attribution fold's lone
  // cross-event field — instant ADD COLUMN, no rebuild, no cursor rewind), and to
  // 74 via fn-836 task .4 (the DESTRUCTIVE shed: restore keep-set bodies inline +
  // DROP `event_blobs` at the migration tail — no cursor rewind, projection
  // re-fold stays byte-identical), and to 75 via fn-831 task .1 (rewriting stored
  // `file_attributions.source='planctl'` rows to `'plan'` in lockstep with the
  // producer mint flip — in-transaction with the version stamp, no cursor rewind,
  // re-fold byte-identical), and to 76 via fn-846 task .1 (the never-bound
  // dispatch circuit breaker's additive `dispatch_never_bound` projection table —
  // CREATE-only, no cursor rewind, re-fold byte-identical), and to 77 via fn-856
  // task .1 (ungating the plan-link classifier from the `/plan:plan` time-window
  // model — the fold output changed, so the migration REWINDS the cursor and
  // wipes the canonical projection list to repopulate from the corrected derive,
  // re-fold byte-identical via the classifier's `(ts, event_id)` total order),
  // and to 78 via fn-864 task .1 (renaming the `plan_*` schema surface →
  // `plan_*` + rewriting historical `planctl_invocation` envelopes → forward —
  // value-preserving, NO cursor rewind, re-fold byte-identical across the
  // rename), each of which bumped SCHEMA_VERSION AND added its version to
  // `SUPPORTED_SCHEMA_VERSIONS` in the same commit per the CLAUDE.md same-commit
  // invariant. And to 79 via fn-868 task .1 (the LIVE-ONLY git projection: a new
  // `git_projection_state` control singleton + skip-floor, additive table +
  // floor-raise, NO cursor rewind of the deterministic projections — the git
  // surface is carved out of the re-fold charter, the other ~16 stay
  // byte-identical). And to 80 via fn-881 task .1 (excluding the worker's `done`
  // and the closer's `close` op from the plan-link classifier — the fold output
  // changed, so the migration REWINDS the cursor and wipes the canonical
  // projection list to repopulate from the corrected derive, but RAISES the git
  // skip-floor instead of resetting it to 0 to keep the v79 git carve-out, so the
  // deterministic link projections re-fold byte-identically). And to 81 via fn-888
  // task .2 (converging `epics.job_links` under task .1's cheap per-session
  // `mergeJobLinkSlice` merge — the fold is byte-identical to the old per event, so
  // this rewind-and-redrain is a convergence + self-validation pass, mirroring v80's
  // rewind/wipe block exactly: cursor→0, deterministic projections wiped,
  // `commit_trailer_facts` preserved, git skip-floor RAISED not reset). And to 82
  // via fn-889 task .3 (retiring the last live `planctl` residue: rewriting the
  // historical Commit-event `events.data` keys `planctl_op`/`planctl_target` →
  // `plan_op`/`plan_target` + narrowing the `file_attributions.source` CHECK to
  // drop `'planctl'` — value-preserving, NO cursor rewind, `commit_trailer_facts`
  // re-folds byte-identical under the new keys). And to 83 via fn-907 task .1
  // (adding the `jobs.backend_exec_generation_id` + `backend_exec_birth_session_id`
  // columns + the `tmux_projection_state` live-only control singleton, flipping
  // `backend_exec_session_id` + `window_index` to LIVE-ONLY, and backfilling the
  // birth session from the frozen launch env — NO cursor rewind, the two columns
  // become boot-seeded/live so history is never re-folded for them). And to 84
  // via fn-924 task .1 (carrying the existing `jobs.active_since` fact on the
  // embedded `epics.jobs` element — a JSON-cell-only add, fix-forward: no column,
  // no rewind, absent ≡ null — so readiness's new `bound-pending` predicate holds
  // a freshly-bound `stopped` worker's root across the bind → first-activity
  // handoff). And to 85 via fn-936 task .1 (stripping the static priority/
  // ordering machinery — DROP `epics.sort_path` / `queue_jump` /
  // `created_by_closer_of` + `events.plan_queue_jump` via a table rebuild +
  // full rewind-and-redrain). And to 86 via fn-941 task .2 (adding the
  // `block_escalations` escalate-once latch projection table — comment-only
  // no-op, NO cursor rewind: the latch re-folds byte-identical from the
  // `TaskSnapshot` / `BlockEscalation*` stream). This pin tracks the LIVE schema
  // version: the guard it provides is "an accidental reducer/schema change must
  // surface as a failing whitelist + this pin", which still holds — bump both
  // together when the schema genuinely moves.
  expect(SCHEMA_VERSION).toBe(86);
});

test("PENDING_DISPATCH_SWEEP_INTERVAL_MS is 60s (matches the documented heartbeat cadence)", () => {
  // The sweep MUST ride the heartbeat, not the data_version wake — a
  // crashed dispatch can be the only pending row on a quiescent board,
  // and a write-triggered wake would never fire. The 60s cadence
  // matches the git-worker / git-status / readiness heartbeats keeper
  // already uses elsewhere.
  expect(PENDING_DISPATCH_SWEEP_INTERVAL_MS).toBe(60_000);
});

test("selectExpiredPendingDispatches returns aged rows past the TTL", () => {
  const { db } = openDb(dbPath);
  const now = 1_700_000_000_000; // arbitrary fixed epoch (ms)
  const nowSec = now / 1000;
  // Aged: dispatched 121s ago (past the 120s TTL).
  seedPendingDispatch(db, "work", "fn-1-foo.1", nowSec - 121);
  // Fresh: dispatched 30s ago (well inside the TTL).
  seedPendingDispatch(db, "work", "fn-1-foo.2", nowSec - 30);
  // Exact boundary: dispatched exactly 120s ago — equal is NOT past,
  // so this row is NOT expired (cutoff is strict less-than).
  seedPendingDispatch(db, "work", "fn-1-foo.3", nowSec - 120);

  const expired = selectExpiredPendingDispatches(db, now);
  expect(expired.map((r) => r.id).sort()).toEqual(["fn-1-foo.1"]);
  db.close();
});

test("selectExpiredPendingDispatches expires an aged row EVEN with an open dispatch_failures row (fn-870 BUG2 self-heal)", () => {
  const { db } = openDb(dbPath);
  const now = 1_700_000_000_000;
  const nowSec = now / 1000;
  // Aged row WITH a sticky dispatch_failures row for the same (verb, id). The
  // prior `WHERE df.verb IS NULL` guard shielded this row from the sweep forever
  // — the "suppressed sweep" deadlock (the v76→v79 jam: every phantom was
  // BLOCKED-by-dispatch_failures, so the sweep never freed the slot). The TTL
  // sweep is now UNCONDITIONAL on dispatch_failures membership, so this aged row
  // expires.
  seedPendingDispatch(db, "work", "fn-1-foo.1", nowSec - 200);
  seedDispatchFailure(db, "work", "fn-1-foo.1", nowSec - 200);
  // Another aged row WITHOUT a matching failure — also expires.
  seedPendingDispatch(db, "work", "fn-1-foo.2", nowSec - 200);

  const expired = selectExpiredPendingDispatches(db, now);
  expect(expired.map((r) => r.id).sort()).toEqual(["fn-1-foo.1", "fn-1-foo.2"]);
  db.close();
});

test("selectExpiredPendingDispatches measures TTL against frozen dispatched_at (a daemon restart never resets the clock)", () => {
  const { db } = openDb(dbPath);
  // The frozen `dispatched_at` lifts off the synthetic event's payload,
  // not `Date.now()` inside the fold (CLAUDE.md re-fold determinism).
  // This test confirms the SWEEP side honors the same contract: the
  // expire decision is `Date.now() - dispatched_at*1000 > TTL`,
  // independent of when the daemon (re)started.
  const dispatchedAtSec = 1_699_000_000;
  seedPendingDispatch(db, "work", "fn-1-bar.1", dispatchedAtSec);

  // Sweep "shortly after" — fresh row, not expired.
  const justAfter = dispatchedAtSec * 1000 + 30_000;
  expect(selectExpiredPendingDispatches(db, justAfter)).toEqual([]);

  // Sweep "after a daemon restart that took 2 minutes" — same row,
  // same frozen dispatched_at, NOW past the TTL.
  const muchLater = dispatchedAtSec * 1000 + PENDING_DISPATCH_TTL_MS + 1;
  const aged = selectExpiredPendingDispatches(db, muchLater);
  expect(aged.map((r) => r.id)).toEqual(["fn-1-bar.1"]);
  db.close();
});

test("selectExpiredPendingDispatches on an empty pending_dispatches table returns []", () => {
  const { db } = openDb(dbPath);
  expect(selectExpiredPendingDispatches(db, 1_700_000_000_000)).toEqual([]);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-720 task .3 — pending-dispatch sweep backstop telemetry (timeout class)
// ---------------------------------------------------------------------------

test("buildPendingDispatchSweepRecords: an expired row posts a timeout rescue with elapsed-since-dispatch staleness", () => {
  // The sweep's per-row telemetry is a `timeout`-class rescue: fast_path and
  // last_fast_path_at are ALWAYS null (no fast-path notion), staleness_ms is
  // elapsed-since-dispatch (now − dispatched_at*1000), and the {verb,id}
  // triage detail rides along. backstop/worker pin to the sweep + main.
  const dispatchedAtSec = 1_699_000_000;
  const nowMs = dispatchedAtSec * 1000 + 150_000; // 150s after dispatch
  const aged = [
    { verb: "work", id: "fn-1-foo.1", dispatched_at: dispatchedAtSec },
  ];
  const recs = buildPendingDispatchSweepRecords(aged, nowMs);
  expect(recs.length).toBe(1);
  const rec = recs[0];
  expect(rec?.kind).toBe("backstop-rescue");
  expect(rec?.class).toBe("timeout");
  expect(rec?.backstop).toBe("pending-dispatch-sweep");
  expect(rec?.worker).toBe("main");
  expect(rec?.rescued).toBe(true);
  expect(rec?.staleness_ms).toBe(150_000);
  // timeout class carries null fast_path / last_fast_path_at (epic acceptance).
  expect(rec?.fast_path).toBeNull();
  expect(rec?.last_fast_path_at).toBeNull();
  expect(rec?.detail).toEqual({ verb: "work", id: "fn-1-foo.1" });
});

test("buildPendingDispatchSweepRecords: an empty sweep yields no records (denominator-only)", () => {
  // An empty sweep writes NO line — it only bumps the rescued:false
  // denominator (a counter bump the caller does directly). The helper returns
  // [] so the no-op sweep never spams the sidecar.
  expect(buildPendingDispatchSweepRecords([], 1_700_000_000_000)).toEqual([]);
});

test("pending-dispatch sweep telemetry round-trips to the sidecar; empty sweep bumps the rescued:false denominator", () => {
  // Mirrors the daemon-side sweep composition end to end: aged rows →
  // buildPendingDispatchSweepRecords → appendBackstopRecord (main is the SOLE
  // sidecar writer); an EMPTY sweep bumps the rescued:false denominator on the
  // shared BackstopCounters. Asserts the rescue line lands on disk and the
  // rollup carries fires_total > rescues_total once a no-op sweep is counted.
  const logPath = join(tmpDir, "backstop.ndjson");
  const counters = new BackstopCounters();

  // Rescue pass: one aged row → one record line + a rescued:true counter bump.
  const dispatchedAtSec = 1_699_000_000;
  const nowMs = dispatchedAtSec * 1000 + 200_000;
  const aged = [
    { verb: "work", id: "fn-2-bar.3", dispatched_at: dispatchedAtSec },
  ];
  const recs = buildPendingDispatchSweepRecords(aged, nowMs);
  for (const rec of recs) {
    appendBackstopRecord(rec, logPath);
    counters.bump("pending-dispatch-sweep", "timeout", true);
  }

  // Empty sweep: no record line, just the rescued:false denominator bump.
  expect(buildPendingDispatchSweepRecords([], nowMs)).toEqual([]);
  counters.bump("pending-dispatch-sweep", "timeout", false);

  // The sidecar has exactly the one rescue line, parseable as the timeout
  // record (reader tolerates the trailing newline → final empty segment).
  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0] ?? "{}");
  expect(parsed.class).toBe("timeout");
  expect(parsed.backstop).toBe("pending-dispatch-sweep");
  expect(parsed.rescued).toBe(true);
  expect(parsed.staleness_ms).toBe(200_000);
  expect(parsed.fast_path).toBeNull();
  expect(parsed.last_fast_path_at).toBeNull();

  // The rollup denominator reflects BOTH fires (one rescue + one no-op) so
  // scripts/backstop-stats.ts can compute a true rescue RATE (1/2).
  const rollups = counters.snapshot(nowMs);
  expect(rollups.length).toBe(1);
  expect(rollups[0]?.backstop).toBe("pending-dispatch-sweep");
  expect(rollups[0]?.class).toBe("timeout");
  expect(rollups[0]?.fires_total).toBe(2);
  expect(rollups[0]?.rescues_total).toBe(1);
});

// ---------------------------------------------------------------------------
// fn-941 task .3 — daemon block-escalation producer
// ---------------------------------------------------------------------------

test("BLOCK_ESCALATION_SWEEP_INTERVAL_MS is 60s (rides the heartbeat, not the data_version wake)", () => {
  expect(BLOCK_ESCALATION_SWEEP_INTERVAL_MS).toBe(60_000);
});

test("parseBlockedCategory: lifts the leading <CATEGORY>: token, null on absent/unparseable", () => {
  expect(parseBlockedCategory("SPEC_UNCLEAR: the spec is vague")).toBe(
    "SPEC_UNCLEAR",
  );
  expect(parseBlockedCategory("  TOOLING_FAILURE: broken runner")).toBe(
    "TOOLING_FAILURE",
  );
  expect(parseBlockedCategory("RESUME_EXHAUSTED: out of resume budget")).toBe(
    "RESUME_EXHAUSTED",
  );
  // No leading WORD: token → null (a later colon never false-matches).
  expect(parseBlockedCategory("see foo: bar")).toBeNull();
  expect(parseBlockedCategory("no category here")).toBeNull();
  expect(parseBlockedCategory("")).toBeNull();
  expect(parseBlockedCategory(null)).toBeNull();
  // Lowercase prefix is NOT a category token.
  expect(parseBlockedCategory("spec_unclear: nope")).toBeNull();
});

test("shouldEscalateBlockedCategory: denylist — only TOOLING_FAILURE and null are skipped", () => {
  expect(shouldEscalateBlockedCategory("SPEC_UNCLEAR")).toBe(true);
  expect(shouldEscalateBlockedCategory("DEPENDENCY_BLOCKED")).toBe(true);
  expect(shouldEscalateBlockedCategory("DESIGN_CONFLICT")).toBe(true);
  expect(shouldEscalateBlockedCategory("SCOPE_EXCEEDED")).toBe(true);
  expect(shouldEscalateBlockedCategory("EXTERNAL_BLOCKED")).toBe(true);
  expect(shouldEscalateBlockedCategory("RESUME_EXHAUSTED")).toBe(true);
  // Skipped: the one denylisted category + an absent/unparseable reason.
  expect(shouldEscalateBlockedCategory(BLOCK_ESCALATION_SKIP_CATEGORY)).toBe(
    false,
  );
  expect(shouldEscalateBlockedCategory("TOOLING_FAILURE")).toBe(false);
  expect(shouldEscalateBlockedCategory(null)).toBe(false);
});

test("effectiveBlockEscalationRepo: target_repo override, else project_dir, else empty", () => {
  expect(effectiveBlockEscalationRepo("/repo/a", "/proj")).toBe("/repo/a");
  expect(effectiveBlockEscalationRepo(null, "/proj")).toBe("/proj");
  expect(effectiveBlockEscalationRepo("", "/proj")).toBe("/proj");
  expect(effectiveBlockEscalationRepo(null, null)).toBe("");
  expect(effectiveBlockEscalationRepo("", "")).toBe("");
});

test("buildBlockEscalationBody: carries epic/task/category/repo/reason + the one-way directive", () => {
  const body = buildBlockEscalationBody({
    epicId: "fn-9-foo",
    taskId: "fn-9-foo.2",
    category: "SPEC_UNCLEAR",
    blockedReason: "SPEC_UNCLEAR: the acceptance is ambiguous",
    repo: "/Users/me/code/foo",
  });
  expect(body).toContain("fn-9-foo.2");
  expect(body).toContain("fn-9-foo");
  expect(body).toContain("SPEC_UNCLEAR");
  expect(body).toContain("/Users/me/code/foo");
  expect(body).toContain("the acceptance is ambiguous");
  // The one-way directive — unblock on the board, autopilot re-dispatches, no
  // reply, and the manual-dispatch fallback.
  expect(body).toContain("keeper plan unblock fn-9-foo.2");
  expect(body).toContain("NO reply needed");
  expect(body).toContain("keeper dispatch work::fn-9-foo.2");
});

// ---- selectPendingBlockEscalations (the current-state working-set read) -----

function seedEpicWithTasks(
  db: ReturnType<typeof openDb>["db"],
  epicId: string,
  projectDir: string | null,
  tasks: {
    task_id: string;
    runtime_status?: string;
    target_repo?: string | null;
  }[],
): void {
  db.run(
    `INSERT INTO epics (epic_id, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, ?, 'open', 1, 0, ?)`,
    [epicId, projectDir, JSON.stringify(tasks)],
  );
}

function seedBlockLatch(
  db: ReturnType<typeof openDb>["db"],
  epicId: string,
  taskId: string,
  status = "pending",
): void {
  db.run(
    `INSERT INTO block_escalations (epic_id, task_id, blocked_since, status, outcome, last_event_id)
       VALUES (?, ?, 1, ?, NULL, 1)`,
    [epicId, taskId, status],
  );
}

test("selectPendingBlockEscalations: joins pending latch to epic project_dir + embedded task runtime_status/target_repo", () => {
  const { db } = openDb(dbPath);
  seedEpicWithTasks(db, "fn-1-foo", "/proj/foo", [
    {
      task_id: "fn-1-foo.1",
      runtime_status: "blocked",
      target_repo: "/repo/x",
    },
    { task_id: "fn-1-foo.2", runtime_status: "todo", target_repo: null },
  ]);
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.1");
  // A non-pending (already-attempted) latch is NOT returned.
  seedBlockLatch(db, "fn-1-foo", "fn-1-foo.2", "attempted");

  const rows = selectPendingBlockEscalations(db);
  expect(rows.length).toBe(1);
  expect(rows[0]).toEqual({
    epic_id: "fn-1-foo",
    task_id: "fn-1-foo.1",
    project_dir: "/proj/foo",
    runtime_status: "blocked",
    target_repo: "/repo/x",
  });
  db.close();
});

test("selectPendingBlockEscalations: a pending latch with no surviving epic/task element returns null fields", () => {
  const { db } = openDb(dbPath);
  // Latch with NO matching epic row.
  seedBlockLatch(db, "fn-2-ghost", "fn-2-ghost.1");
  // Latch whose epic exists but the embedded task element is absent.
  seedEpicWithTasks(db, "fn-3-bar", "/proj/bar", [
    { task_id: "fn-3-bar.9", runtime_status: "blocked" },
  ]);
  seedBlockLatch(db, "fn-3-bar", "fn-3-bar.1");

  const rows = selectPendingBlockEscalations(db);
  const ghost = rows.find((r) => r.task_id === "fn-2-ghost.1");
  expect(ghost).toEqual({
    epic_id: "fn-2-ghost",
    task_id: "fn-2-ghost.1",
    project_dir: null,
    runtime_status: null,
    target_repo: null,
  });
  const missingEl = rows.find((r) => r.task_id === "fn-3-bar.1");
  expect(missingEl).toEqual({
    epic_id: "fn-3-bar",
    task_id: "fn-3-bar.1",
    project_dir: "/proj/bar",
    runtime_status: null,
    target_repo: null,
  });
  db.close();
});

test("selectPendingBlockEscalations: empty table returns []", () => {
  const { db } = openDb(dbPath);
  expect(selectPendingBlockEscalations(db)).toEqual([]);
  db.close();
});

// ---- runBlockEscalationSweep (the orchestration core, injected deps) --------

interface MintCall {
  kind: "requested" | "attempted";
  epicId: string;
  taskId: string;
  outcome?: BlockEscalationOutcome;
}

/** Build injectable deps over a synthetic pending set + a reason map + a notify
 *  stub, recording every mint + notify call for assertion. */
function fakeSweepDeps(opts: {
  pending: PendingBlockEscalation[];
  reasons?: Record<string, string | null>;
  notify?: (args: {
    epicId: string;
    taskId: string;
  }) => Promise<BlockEscalationSendResult>;
}): {
  deps: BlockEscalationSweepDeps;
  mints: MintCall[];
  notifies: { epicId: string; taskId: string }[];
} {
  const mints: MintCall[] = [];
  const notifies: { epicId: string; taskId: string }[] = [];
  const deps: BlockEscalationSweepDeps = {
    selectPending: () => opts.pending,
    readBlockedReason: (_projectDir, taskId) => opts.reasons?.[taskId] ?? null,
    mintRequested: (epicId, taskId) =>
      mints.push({ kind: "requested", epicId, taskId }),
    mintAttempted: (epicId, taskId, outcome) =>
      mints.push({ kind: "attempted", epicId, taskId, outcome }),
    notifyPlanner: async (args) => {
      notifies.push({ epicId: args.epicId, taskId: args.taskId });
      return (
        (await opts.notify?.(args)) ?? {
          outcome: "sent",
          detail: "sent",
        }
      );
    },
  };
  return { deps, mints, notifies };
}

test("runBlockEscalationSweep: an escalatable block mints Requested→Attempted{sent} in order, sends once", async () => {
  const { deps, mints, notifies } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
    ],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: ambiguous acceptance" },
  });
  await runBlockEscalationSweep(deps);

  expect(notifies).toEqual([{ epicId: "fn-1-foo", taskId: "fn-1-foo.1" }]);
  // Requested STRICTLY before Attempted.
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "sent",
    },
  ]);
});

test("runBlockEscalationSweep: TOOLING_FAILURE is skipped with a recorded outcome, no send", async () => {
  const { deps, mints, notifies } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
    ],
    reasons: { "fn-1-foo.1": "TOOLING_FAILURE: the runner is broken" },
  });
  await runBlockEscalationSweep(deps);

  expect(notifies).toEqual([]);
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "skipped_category",
    },
  ]);
});

test("runBlockEscalationSweep: an absent/unparseable reason is skipped (surface-and-stop), no send", async () => {
  const { deps, mints, notifies } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
    ],
    // No reason entry → readBlockedReason returns null → category null → skip.
    reasons: {},
  });
  await runBlockEscalationSweep(deps);

  expect(notifies).toEqual([]);
  expect(mints.map((m) => m.kind === "attempted" && m.outcome)).toContain(
    "skipped_category",
  );
});

test("runBlockEscalationSweep: cancellation guard — a task that left blocked is skipped_unblocked, no send", async () => {
  const { deps, mints, notifies } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        // Latch still pending, but the live task already left blocked.
        runtime_status: "todo",
        target_repo: null,
      },
    ],
    reasons: { "fn-1-foo.1": "SPEC_UNCLEAR: would-escalate-if-still-blocked" },
  });
  await runBlockEscalationSweep(deps);

  expect(notifies).toEqual([]);
  expect(mints).toEqual([
    { kind: "requested", epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    {
      kind: "attempted",
      epicId: "fn-1-foo",
      taskId: "fn-1-foo.1",
      outcome: "skipped_unblocked",
    },
  ]);
});

test("runBlockEscalationSweep: per-planner coalescing — two blocked tasks in one epic send ONCE", async () => {
  const { deps, mints, notifies } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.2",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
    ],
    reasons: {
      "fn-1-foo.1": "SPEC_UNCLEAR: a",
      "fn-1-foo.2": "DEPENDENCY_BLOCKED: b",
    },
  });
  await runBlockEscalationSweep(deps);

  // Exactly ONE send for the shared planner@fn-1-foo (the first row wins).
  expect(notifies).toEqual([{ epicId: "fn-1-foo", taskId: "fn-1-foo.1" }]);
  // The coalesced sibling still gets a terminal outcome so it leaves pending.
  const attempts = mints.filter((m) => m.kind === "attempted");
  expect(attempts).toContainEqual({
    kind: "attempted",
    epicId: "fn-1-foo",
    taskId: "fn-1-foo.1",
    outcome: "sent",
  });
  expect(attempts).toContainEqual({
    kind: "attempted",
    epicId: "fn-1-foo",
    taskId: "fn-1-foo.2",
    outcome: "skipped_coalesced",
  });
});

test("runBlockEscalationSweep: two DIFFERENT epics each get their own send", async () => {
  const { deps, notifies } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
      {
        epic_id: "fn-2-bar",
        task_id: "fn-2-bar.1",
        project_dir: "/proj2",
        runtime_status: "blocked",
        target_repo: null,
      },
    ],
    reasons: {
      "fn-1-foo.1": "SPEC_UNCLEAR: a",
      "fn-2-bar.1": "SCOPE_EXCEEDED: b",
    },
  });
  await runBlockEscalationSweep(deps);

  expect(notifies).toEqual([
    { epicId: "fn-1-foo", taskId: "fn-1-foo.1" },
    { epicId: "fn-2-bar", taskId: "fn-2-bar.1" },
  ]);
});

test("runBlockEscalationSweep: a send_failed helper result is recorded as the latch outcome (fail-open)", async () => {
  const { deps, mints } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
    ],
    reasons: { "fn-1-foo.1": "EXTERNAL_BLOCKED: api down" },
    notify: async () => ({ outcome: "send_failed", detail: "not_connected" }),
  });
  await runBlockEscalationSweep(deps);

  expect(mints).toContainEqual({
    kind: "attempted",
    epicId: "fn-1-foo",
    taskId: "fn-1-foo.1",
    outcome: "send_failed",
  });
});

test("runBlockEscalationSweep: a THROWING notify never aborts the sweep (records send_failed)", async () => {
  const { deps, mints } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
    ],
    reasons: { "fn-1-foo.1": "DESIGN_CONFLICT: clash" },
    notify: async () => {
      throw new Error("boom");
    },
  });
  // MUST resolve (never throw) and record a terminal outcome.
  await runBlockEscalationSweep(deps);
  expect(mints).toContainEqual({
    kind: "attempted",
    epicId: "fn-1-foo",
    taskId: "fn-1-foo.1",
    outcome: "send_failed",
  });
});

test("runBlockEscalationSweep: an empty pending set is a no-op (no mints, no sends)", async () => {
  const { deps, mints, notifies } = fakeSweepDeps({ pending: [] });
  await runBlockEscalationSweep(deps);
  expect(mints).toEqual([]);
  expect(notifies).toEqual([]);
});

test("runBlockEscalationSweep: a queued_for_wake helper result rides through as the outcome", async () => {
  const { deps, mints } = fakeSweepDeps({
    pending: [
      {
        epic_id: "fn-1-foo",
        task_id: "fn-1-foo.1",
        project_dir: "/proj",
        runtime_status: "blocked",
        target_repo: null,
      },
    ],
    reasons: { "fn-1-foo.1": "RESUME_EXHAUSTED: out of budget" },
    notify: async () => ({
      outcome: "queued_for_wake",
      detail: "queued",
    }),
  });
  await runBlockEscalationSweep(deps);
  expect(mints).toContainEqual({
    kind: "attempted",
    epicId: "fn-1-foo",
    taskId: "fn-1-foo.1",
    outcome: "queued_for_wake",
  });
});

// fn-701 task .3 — @parcel/watcher pre-warm. The native-addon dlopen race is
// timing-dependent and cannot be regression-tested directly, so these cover the
// helper's two contractual branches: a healthy load is a silent no-op (invoking
// the loader exactly once), and a genuine load failure fires the LOUD boot
// assertion (bun version + context) and RE-THROWS so the caller can take the
// single recovery path. The real boot wiring (`prewarmWatcherAddon()` →
// `fatalExit()`) is exercised by the live daemon; here we inject the loader +
// logger to drive the failure branch without a real broken addon.
test("prewarmWatcherAddon invokes the loader exactly once and stays silent on success", () => {
  let loaderCalls = 0;
  const logs: string[] = [];
  prewarmWatcherAddon(
    () => {
      loaderCalls += 1;
      return {};
    },
    (msg) => logs.push(msg),
  );
  expect(loaderCalls).toBe(1);
  expect(logs).toEqual([]);
});

test("prewarmWatcherAddon logs a loud boot assertion (bun version + context) and re-throws on a genuine load failure", () => {
  const logs: string[] = [];
  const boom = new Error("symbol 'napi_register_module_v1' not found");
  expect(() =>
    prewarmWatcherAddon(
      () => {
        throw boom;
      },
      (msg) => logs.push(msg),
    ),
  ).toThrow(boom);
  // Exactly one loud assertion line, and it must carry the diagnostic anchors:
  // the FATAL marker, the addon name, the actual bun version, and the
  // underlying error message — so a recurrence is greppable, not silent.
  expect(logs).toHaveLength(1);
  const line = logs[0] ?? "";
  expect(line).toContain("FATAL");
  expect(line).toContain("@parcel/watcher");
  expect(line).toContain(Bun.version);
  expect(line).toContain("napi_register_module_v1");
});

test("prewarmWatcherAddon: the loud assertion does NOT downgrade a genuine failure to a warning (it re-throws)", () => {
  // A no-op logger that swallows the line proves the escalation is in the
  // THROW, not the log — the caller (boot) escalates to fatalExit regardless of
  // what the logger does with the message.
  expect(() =>
    prewarmWatcherAddon(
      () => {
        throw new Error("ABI mismatch");
      },
      () => {},
    ),
  ).toThrow("ABI mismatch");
});

// ---------------------------------------------------------------------------
// fn-747 task .2 — in-process daemon keystone
// ---------------------------------------------------------------------------

/**
 * The fn-747 keystone proof: a REAL daemon booted IN THIS PROCESS via
 * `startDaemon({ disableNativeWatcher: true })` runs the full fold pipeline
 * (event INSERT → wake-worker drain → `jobs` projection → UDS query) and tears
 * down cleanly via `stop()` — with NO worker-thread `@parcel/watcher` dlopen
 * (the SIGTRAP source the OS-coupled subprocess-daemon tests, deleted in
 * fn-752, used to risk). This addon-free boot is what lets the whole suite run
 * as ONE `--parallel` tier.
 *
 * The trigger is a direct synthetic-event INSERT through a SECOND writer
 * connection to the sandboxed DB — the daemon's wake worker polls
 * `PRAGMA data_version`, sees the cross-connection write, and drains it through
 * main's reducer exactly as a hook-sourced row would flow. We then prove BOTH
 * halves: the projection landed (read-only DB) AND the server worker serves it
 * over the bound UDS (`query → result`).
 */
test("fn-747: in-process daemon folds an event and serves it over UDS, then stops clean (no watcher dlopen)", async () => {
  await withInProcessDaemon(async ({ dbPath, sockPath }) => {
    const sessionId = "sess-inproc-keystone";

    // Trigger: INSERT one SessionStart lifecycle event via a SECOND writer
    // connection. The daemon holds its own writer; this cross-connection commit
    // bumps `data_version`, which the wake worker polls and drains — the same
    // path a hook-sourced events-log row takes once main ingests it.
    const writer = openDb(dbPath).db;
    writer.run(
      `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, permission_mode, data)
         VALUES (?, ?, ?, 'SessionStart', 'lifecycle', ?, 'default', '{}')`,
      [Date.now() / 1000, sessionId, 4242, "/tmp/inproc-work"],
    );
    writer.close();

    // Half 1 — the fold pipeline ran in-process: the reducer projected the job.
    const reader = openDb(dbPath, { readonly: true }).db;
    const projected = await retryUntil(() => {
      const row = reader
        .query("SELECT job_id FROM jobs WHERE job_id = ?")
        .get(sessionId) as { job_id: string } | null;
      return row ?? null;
    }, 30_000);
    reader.close();
    expect(projected).not.toBeNull();

    // Half 2 — the server worker serves that row over the bound UDS.
    const frames: ServerFrame[] = [];
    const buffer = new LineBuffer();
    const socket = await Bun.connect({
      unix: sockPath,
      socket: {
        data(_sock, chunk) {
          for (const line of buffer.push(chunk.toString("utf8"))) {
            if (line.trim().length > 0) {
              frames.push(JSON.parse(line) as ServerFrame);
            }
          }
        },
      },
    });
    try {
      // Query by the `job_id` pk (a detail-subscribe lookup) — this bypasses the
      // `jobs` default `state NOT IN (ended,killed)` scope, so the served page
      // contains our row regardless of state (a synthetic job whose `pid` isn't
      // a live process gets reaped to `killed` by the liveness sweep — incidental
      // to "does the server worker serve a folded row").
      //
      // The server worker serves `result` from its OWN read connection, which
      // converges on its independent `data_version` poll — so a single query can
      // race ahead of the server's fold. Re-query until the served page contains
      // our row.
      const served = await retryUntil(() => {
        socket.write(
          encodeFrame({
            type: "query",
            collection: "jobs",
            filter: { job_id: sessionId },
            id: "q1",
          }),
        );
        const hit = frames.find(
          (f) =>
            f.type === "result" &&
            f.collection === "jobs" &&
            f.rows.some((r) => r.job_id === sessionId),
        );
        return hit ?? null;
      }, 30_000);
      expect(served).not.toBeNull();
    } finally {
      socket.end();
    }
  });
  // Reaching here means the harness's `stop()` tore down all workers + db
  // WITHOUT a `process.exit` (a `process.exit` would have killed the test
  // runner). Clean in-process boot → fold → query → stop, proven.
  //
  // 120s ceiling (was 30s): on a CI box shared with live autopilot workers the
  // full-set boot alone was observed eating 20s+ (2026-06-10 builds 53/54/63/65
  // — timeouts at 30001/30009ms, milliseconds past the old line). A ceiling is
  // free on the happy path; it only pays when the box is starved, where
  // "slower green" is the correct outcome, not a red build.
}, 120_000);

// ---------------------------------------------------------------------------
// fn-751 task .3 — set_autopilot_mode / set_epic_armed RPC round-trip
// ---------------------------------------------------------------------------

/**
 * One control-RPC round-trip on a fresh UDS connection to the in-process
 * daemon: write the `rpc` frame, await the `rpc_result` / `error` frame whose
 * `id` matches, close. Mirrors the keystone test's query-socket shape.
 */
async function rpcRoundTrip(
  sockPath: string,
  frame: RpcFrame,
): Promise<ServerFrame> {
  const buffer = new LineBuffer();
  const frames: ServerFrame[] = [];
  const socket = await Bun.connect({
    unix: sockPath,
    socket: {
      data(_sock, chunk) {
        for (const line of buffer.push(chunk.toString("utf8"))) {
          if (line.trim().length > 0) {
            frames.push(JSON.parse(line) as ServerFrame);
          }
        }
      },
    },
  });
  try {
    socket.write(encodeFrame(frame));
    const reply = await retryUntil(() => {
      const hit = frames.find(
        (f) =>
          (f.type === "rpc_result" || f.type === "error") &&
          (f as { id?: string }).id === frame.id,
      );
      return hit ?? null;
    }, 30_000);
    if (reply === null) {
      throw new Error(
        `no rpc_result/error frame for ${frame.method} (id ${frame.id}) within 10s`,
      );
    }
    return reply;
  } finally {
    socket.end();
  }
}

test("fn-751: set_autopilot_mode RPC round-trips and folds the autopilot_state singleton's mode column", async () => {
  await withInProcessDaemon(
    async ({ dbPath, sockPath }) => {
      const reply = await rpcRoundTrip(sockPath, {
        type: "rpc",
        id: "mode-1",
        method: "set_autopilot_mode",
        params: { mode: "armed" },
      });
      expect(reply.type).toBe("rpc_result");
      expect((reply as { value: unknown }).value).toEqual({
        ok: true,
        mode: "armed",
      });

      // The daemon appended an `AutopilotMode` event; the wake worker drained
      // it into the singleton. Re-query the projection until the fold lands.
      const reader = openDb(dbPath, { readonly: true }).db;
      const mode = await retryUntil(() => {
        const row = reader
          .query("SELECT mode FROM autopilot_state WHERE id = 1")
          .get() as { mode: string } | null;
        return row?.mode === "armed" ? row.mode : null;
      }, 30_000);
      reader.close();
      expect(mode).toBe("armed");
    },
    { workers: ["wake", "server"] },
  );
}, 120_000);

test("fn-751: set_autopilot_mode rejects an unknown enum value with a bad_params error (no fold)", async () => {
  await withInProcessDaemon(
    async ({ sockPath }) => {
      const reply = await rpcRoundTrip(sockPath, {
        type: "rpc",
        id: "mode-bad",
        method: "set_autopilot_mode",
        params: { mode: "turbo" },
      });
      expect(reply.type).toBe("error");
      expect((reply as { code: string }).code).toBe("bad_params");
    },
    { workers: ["wake", "server"] },
  );
}, 120_000);

test("fn-751: set_epic_armed RPC round-trips and folds the armed_epics presence table (arm then disarm)", async () => {
  await withInProcessDaemon(
    async ({ dbPath, sockPath }) => {
      // Arm: the presence row appears.
      const armReply = await rpcRoundTrip(sockPath, {
        type: "rpc",
        id: "arm-1",
        method: "set_epic_armed",
        params: { epic_id: "fn-42-armed", armed: true },
      });
      expect(armReply.type).toBe("rpc_result");
      expect((armReply as { value: unknown }).value).toEqual({
        ok: true,
        epic_id: "fn-42-armed",
        armed: true,
      });

      const reader = openDb(dbPath, { readonly: true }).db;
      const armed = await retryUntil(() => {
        const row = reader
          .query("SELECT epic_id FROM armed_epics WHERE epic_id = ?")
          .get("fn-42-armed") as { epic_id: string } | null;
        return row ?? null;
      }, 30_000);
      expect(armed).not.toBeNull();

      // Disarm: the presence row is DELETEd.
      const disarmReply = await rpcRoundTrip(sockPath, {
        type: "rpc",
        id: "disarm-1",
        method: "set_epic_armed",
        params: { epic_id: "fn-42-armed", armed: false },
      });
      expect(disarmReply.type).toBe("rpc_result");

      const gone = await retryUntil(() => {
        const row = reader
          .query("SELECT epic_id FROM armed_epics WHERE epic_id = ?")
          .get("fn-42-armed") as { epic_id: string } | null;
        // retryUntil treats a non-null return as "settled"; sentinel `true`
        // means "row is gone".
        return row === null ? true : null;
      }, 30_000);
      reader.close();
      expect(gone).toBe(true);
    },
    { workers: ["wake", "server"] },
  );
}, 120_000);

test("fn-774: set_epic_armed rejects arming a done epic, allows open / unfolded arm and done-disarm", async () => {
  await withInProcessDaemon(
    async ({ dbPath, sockPath }) => {
      // Seed two epics through the LIVE fold pipeline (the wake-worker drains
      // these synthetic EpicSnapshots into the `epics` projection): one `done`,
      // one `open`. A writer connection mints the events; the daemon folds.
      const writer = openDb(dbPath);
      insertPlanSnapshot(writer.stmts, "EpicSnapshot", "fn-90-done", 1, {
        epic_number: 90,
        title: "Already done",
        project_dir: "/Users/mike/code/keeper",
        status: "done",
      });
      insertPlanSnapshot(writer.stmts, "EpicSnapshot", "fn-91-open", 2, {
        epic_number: 91,
        title: "Still open",
        project_dir: "/Users/mike/code/keeper",
        status: "open",
      });
      writer.db.close();

      const reader = openDb(dbPath, { readonly: true }).db;
      // Wait for BOTH epic rows to fold so the guard's status read is stable.
      const folded = await retryUntil(() => {
        const done = reader
          .query("SELECT status FROM epics WHERE epic_id = ?")
          .get("fn-90-done") as { status: string } | null;
        const open = reader
          .query("SELECT status FROM epics WHERE epic_id = ?")
          .get("fn-91-open") as { status: string } | null;
        return done?.status === "done" && open?.status === "open" ? true : null;
      }, 30_000);
      expect(folded).toBe(true);

      // 1) arm a `done` epic → rejected (rpc_failed), no EpicArmed appended,
      //    `armed_epics` stays empty for it.
      const armDone = await rpcRoundTrip(sockPath, {
        type: "rpc",
        id: "arm-done",
        method: "set_epic_armed",
        params: { epic_id: "fn-90-done", armed: true },
      });
      expect(armDone.type).toBe("error");
      expect((armDone as { code: string }).code).toBe("rpc_failed");
      expect((armDone as { message: string }).message).toContain(
        "already done",
      );
      expect(
        reader
          .query("SELECT epic_id FROM armed_epics WHERE epic_id = ?")
          .get("fn-90-done"),
      ).toBeNull();

      // 2) arm an `open` epic → still appends + arms (unchanged behavior).
      const armOpen = await rpcRoundTrip(sockPath, {
        type: "rpc",
        id: "arm-open",
        method: "set_epic_armed",
        params: { epic_id: "fn-91-open", armed: true },
      });
      expect(armOpen.type).toBe("rpc_result");
      const openArmed = await retryUntil(() => {
        const row = reader
          .query("SELECT epic_id FROM armed_epics WHERE epic_id = ?")
          .get("fn-91-open") as { epic_id: string } | null;
        return row ?? null;
      }, 30_000);
      expect(openArmed).not.toBeNull();

      // 3) arm a not-yet-folded epic (no `epics` row) → still allowed
      //    (fold-lag tolerance: an absent row is NOT a `done` row).
      const armUnfolded = await rpcRoundTrip(sockPath, {
        type: "rpc",
        id: "arm-unfolded",
        method: "set_epic_armed",
        params: { epic_id: "fn-999-never-planned", armed: true },
      });
      expect(armUnfolded.type).toBe("rpc_result");
      const unfoldedArmed = await retryUntil(() => {
        const row = reader
          .query("SELECT epic_id FROM armed_epics WHERE epic_id = ?")
          .get("fn-999-never-planned") as { epic_id: string } | null;
        return row ?? null;
      }, 30_000);
      expect(unfoldedArmed).not.toBeNull();

      // 4) disarm a `done` epic → ALWAYS allowed (the guard gates only
      //    `armed:true`; a disarm must clear a stuck row regardless of status).
      const disarmDone = await rpcRoundTrip(sockPath, {
        type: "rpc",
        id: "disarm-done",
        method: "set_epic_armed",
        params: { epic_id: "fn-90-done", armed: false },
      });
      expect(disarmDone.type).toBe("rpc_result");

      reader.close();
    },
    { workers: ["wake", "server"] },
  );
}, 120_000);

// ---------------------------------------------------------------------------
// fn-749 task .1 — worker-set selector
// ---------------------------------------------------------------------------

/** Map a spawned worker-module URL back to its {@link WorkerName}. */
const WORKER_MODULE_TO_NAME: Record<string, WorkerName> = {
  "wake-worker.ts": "wake",
  "server-worker.ts": "server",
  "transcript-worker.ts": "transcript",
  "plan-worker.ts": "plan",
  "exit-watcher.ts": "exit",
  "git-worker.ts": "git",
  "usage-worker.ts": "usage",
  "builds-worker.ts": "builds",
  "usage-scraper-worker.ts": "usageScraper",
  "dead-letter-worker.ts": "deadLetter",
  "events-ingest-worker.ts": "eventsIngest",
  "autopilot-worker.ts": "autopilot",
  "maintenance-worker.ts": "maintenance",
  "restore-worker.ts": "restore",
  "renamer-worker.ts": "renamer",
  "reaper-worker.ts": "reaper",
  "bus-worker.ts": "bus",
};

/**
 * fn-749 — boot `startDaemon(opts)` under a `globalThis.Worker` constructor SPY
 * that records each spawned worker's module name WITHOUT creating a real thread
 * (so no `@parcel/watcher` dlopen, no UDS bind, no kernel fd). The stub satisfies
 * the property/method surface `startDaemon` touches during its synchronous boot
 * (`onmessage`/`onerror` setters + `addEventListener`); the boot's DB work runs
 * for real against the sandboxed tmp DB. Returns the captured set of spawned
 * worker NAMES, in spawn order.
 *
 * The `close` listeners the boot wires (the fatalExit-on-crash guards) are NEVER
 * fired by the stub, so the `!shuttingDown` crash path can't trip the test
 * runner. We do NOT call `handle.stop()` (no real workers to tear down); the
 * sandboxed DB connection is released when the test process ends and the tmpdir
 * is removed in `afterEach`.
 */
function spawnedWorkerNames(opts?: {
  workers?: readonly WorkerName[];
}): WorkerName[] {
  const captured: WorkerName[] = [];

  // Minimal Worker stub — records the module name, no-ops the lifecycle surface.
  class WorkerSpy {
    onmessage: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(url: string | URL) {
      const href = typeof url === "string" ? url : url.href;
      const leaf = href.split("/").pop() ?? href;
      const name = WORKER_MODULE_TO_NAME[leaf];
      if (name) captured.push(name);
    }
    addEventListener(): void {}
    postMessage(): void {}
    terminate(): void {}
  }

  const realWorker = globalThis.Worker;
  // Sandbox every state path on the LIVE process.env for the synchronous boot
  // window, mirroring the in-process harness (the path resolvers read
  // process.env directly). Restore exactly afterward — no `await` between set
  // and restore, so it stays parallel-safe.
  const sockPath = join(tmpDir, "keeperd.sock");
  // The builds worker spawn is gated on a configured `buildbot_url`. Pin a temp
  // config carrying it so this boot is deterministic regardless of the live
  // `~/.config/keeper/config.yaml` — `builds` is in ALL_WORKERS and must spawn.
  const configPath = join(tmpDir, "keeper-config.yaml");
  // `builds` is gated on `buildbot_url`; `usageScraper` is gated on BOTH a
  // resolvable `uv` path + agentusage project dir. Both workers are in
  // ALL_WORKERS and must spawn, so pin all three keys (the values are never
  // dereferenced under the Worker spy — the gate only checks they resolve).
  writeFileSync(
    configPath,
    "buildbot_url: http://localhost:8010\n" +
      `usage_scraper_uv_path: ${join(tmpDir, "uv")}\n` +
      `usage_scraper_project_dir: ${tmpDir}\n`,
  );
  const sandbox: Record<string, string> = {
    KEEPER_DB: dbPath,
    KEEPER_CONFIG: configPath,
    KEEPER_DEAD_LETTER_DIR: join(tmpDir, "dead-letters"),
    KEEPER_EVENTS_LOG: join(tmpDir, "events-log"),
    KEEPER_DROP_LOG: join(tmpDir, "hook-drops.ndjson"),
    KEEPER_RESTORE_FILE: join(tmpDir, "restore.json"),
    KEEPER_BACKSTOP_LOG: join(tmpDir, "backstop.ndjson"),
    KEEPER_SOCK: sockPath,
  };
  const prior: Record<string, string | undefined> = {};
  for (const k of Object.keys(sandbox)) prior[k] = process.env[k];

  let handle: DaemonHandle | null = null;
  try {
    (globalThis as { Worker: unknown }).Worker = WorkerSpy;
    for (const [k, v] of Object.entries(sandbox)) process.env[k] = v;
    // Boot is fully synchronous up to the returned handle (every `new Worker`
    // fires here, under the spy).
    handle = startDaemon(opts);
  } finally {
    (globalThis as { Worker: unknown }).Worker = realWorker;
    for (const k of Object.keys(sandbox)) {
      const v = prior[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  void handle;
  return captured;
}

test("fn-749: the production boot (no selector) spawns the IDENTICAL seventeen workers", () => {
  // The headline regression guard: a wrong default would silently drop a worker
  // in prod (no autopilot, no exit-watcher, …). `startDaemon()` with NO selector
  // must spawn exactly ALL_WORKERS, in order. fn-765 added `maintenance`; fn-781
  // added `builds` (the first outbound-HTTP worker, gated on a configured
  // `buildbot_url` — `spawnedWorkerNames` pins one so the boot is deterministic);
  // fn-801 added `renamer` (the tmux window-namer; no watcher, no message minter);
  // fn-802 added `reaper` (the autopilot window-reaper; no watcher, no message minter);
  // fn-875 added `bus` (the Agent Bus UDS relay; no watcher, no message minter —
  // owns its own bus.db + bus.sock, reads keeper.db read-only); fn-930 added
  // `usageScraper` (the in-process agentusage producer, gated on a resolvable `uv`
  // runtime — `spawnedWorkerNames` pins the config keys; no watcher, no message
  // minter — writes only on-disk envelopes the `usage` consumer folds).
  const spawned = spawnedWorkerNames();
  expect(spawned).toEqual([...ALL_WORKERS]);
  expect(spawned).toHaveLength(17);
  // And ALL_WORKERS itself is the exact set, pinned so a future worker add/rename
  // must consciously update this contract.
  expect([...ALL_WORKERS]).toEqual([
    "wake",
    "server",
    "transcript",
    "plan",
    "exit",
    "git",
    "usage",
    "builds",
    "usageScraper",
    "deadLetter",
    "eventsIngest",
    "autopilot",
    "maintenance",
    "restore",
    "renamer",
    "reaper",
    "bus",
  ]);
});

test("fn-749: passing the full ALL_WORKERS set is identical to passing no selector", () => {
  // The production default is ALL_WORKERS, so an explicit full set is a no-op.
  expect(spawnedWorkerNames({ workers: ALL_WORKERS })).toEqual([
    ...ALL_WORKERS,
  ]);
});

test("fn-749: a minimal selector spawns ONLY the named workers (no watcher worker)", () => {
  // The UDS/RPC/fold tier's set: wake (main's reducer pump) + server (UDS).
  const minimal = spawnedWorkerNames({ workers: ["wake", "server"] });
  expect(minimal).toEqual(["wake", "server"]);
  // Crucially NONE of the six @parcel/watcher workers spawned.
  for (const w of [
    "transcript",
    "plan",
    "git",
    "usage",
    "deadLetter",
    "eventsIngest",
  ] as const) {
    expect(minimal).not.toContain(w);
  }

  // The plan-fold tier's set additionally boots the plan worker — and ONLY it
  // among the watchers.
  const planSet = spawnedWorkerNames({ workers: ["wake", "server", "plan"] });
  expect(planSet).toEqual(["wake", "server", "plan"]);
});

// ---------------------------------------------------------------------------
// fn-929: the folded `keeper agent` launcher is keeper's sole launch transport
// (no tmux-launch fallback), so boot fail-fasts with a loud warning when the
// launcher SELF-check fails rather than spiralling into the per-launch ENOENT →
// never-bound breaker. The self-check self-invokes `<bun> <keeper.ts> agent
// --version` — the SAME launcher argv the dispatch path embeds.
// ---------------------------------------------------------------------------

const PROBE_PREFIX = ["/abs/bun", "/abs/cli/keeper.ts", "agent"];

test("checkKeeperAgentPresence: present (exit 0) returns true, self-invokes `--version`, logs the launcher", () => {
  const logs: string[] = [];
  const probed: string[][] = [];
  const ok = checkKeeperAgentPresence(PROBE_PREFIX, {
    spawn: (argv) => {
      probed.push(argv);
      return { success: true, exitCode: 0 };
    },
    log: (m) => logs.push(m),
  });
  expect(ok).toBe(true);
  // Self-check ran the SAME launcher argv the dispatch path embeds, + --version.
  expect(probed).toEqual([[...PROBE_PREFIX, "--version"]]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("/abs/cli/keeper.ts");
});

test("checkKeeperAgentPresence: non-zero exit returns false and warns with the launcher + repair hint", () => {
  const logs: string[] = [];
  const ok = checkKeeperAgentPresence(PROBE_PREFIX, {
    spawn: () => ({ success: false, exitCode: 127 }),
    log: (m) => logs.push(m),
  });
  expect(ok).toBe(false);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("WARNING");
  expect(logs[0]).toContain("/abs/cli/keeper.ts");
  expect(logs[0]).toContain("KEEPER_AGENT_PATH");
});

test("checkKeeperAgentPresence: a throwing spawn (unlaunchable launcher) returns false and warns", () => {
  const logs: string[] = [];
  const ok = checkKeeperAgentPresence(
    ["/no/such/bun", "/no/keeper.ts", "agent"],
    {
      spawn: () => {
        throw new Error("ENOENT");
      },
      log: (m) => logs.push(m),
    },
  );
  expect(ok).toBe(false);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("WARNING");
  expect(logs[0]).toContain("/no/keeper.ts");
});
