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
import { drainToCompletion } from "../src/daemon";
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
    status: string;
    depends_on: string[];
  }[];
  expect(tasks.length).toBe(1);
  expect(tasks[0]).toEqual({
    task_id: "fn-7-add-oauth.2",
    epic_id: "fn-7-add-oauth",
    task_number: 2,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    status: "open",
    depends_on: [],
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
