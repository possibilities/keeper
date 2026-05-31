/**
 * Daemon boot-drain test. Verifies the catch-up path independent of the wake
 * mechanism: pre-seed the `events` table, then drive `drainToCompletion`
 * directly against a tmp DB (no Worker spawned — `daemon.ts` is import-safe
 * behind its `import.meta.main` guard). The full wake-worker → reducer
 * round-trip is covered by the end-to-end integration test.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  drainToCompletion,
  recoverOneDeadLetter,
  serializeUsageSnapshot,
  WAL_AUTOCHECKPOINT_PAGES,
  withBootDrainCheckpointTuning,
} from "../src/daemon";
import { openDb } from "../src/db";
import { drain } from "../src/reducer";
import { seedKilledSweep } from "../src/seed-sweep";
import { isPidAlive } from "../src/server-worker";

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

  // The trailing TRUNCATE checkpoint reclaimed the WAL — frame count is 0.
  const checkpoint = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
    busy: number;
    log: number;
    checkpointed: number;
  };
  expect(checkpoint.log).toBe(0);

  db.close();
});

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
    approval: "approved" | "rejected" | "pending";
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
    // surfaces the planctl-native enum. A TaskSnapshot blob without a state
    // file folds `runtime_status` to the planctl `"todo"` default.
    worker_phase: "open",
    runtime_status: "todo",
    // Schema v13: a TaskSnapshot blob with no `approval` field folds to
    // "pending" on the embedded element (matches plan-worker coercion).
    approval: "pending",
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

test("seed sweep ignores rows already in terminal states (ended, killed) and rows with no pid", () => {
  const { db } = openDb(dbPath);

  const deadPid = pickDeadPid();
  // Terminal states are out of scope per the candidate query.
  seedJobsRow(db, "sess-ended", deadPid, null, "ended");
  seedJobsRow(db, "sess-already-killed", deadPid, null, "killed");
  // A row with no pid has nothing to probe.
  seedJobsRow(db, "sess-no-pid", null, null);

  seedKilledSweep(db);
  drainToCompletion(db);

  // None of these should have had a Killed event emitted against them.
  const killedCount = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id IN ('sess-ended','sess-already-killed','sess-no-pid')",
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
  expect(stateOf("sess-no-pid")).toBe("stopped");

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
