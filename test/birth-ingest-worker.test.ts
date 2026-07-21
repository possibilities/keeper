/**
 * Tests for the births-tree ingest path (fn-1103). Drives `scanBirthDir`
 * directly against a tmp DB + tmp births maildir — no Worker spawned (the worker
 * thread just posts contentless notifications, covered by the daemon
 * ALL_WORKERS pin). These tests focus on the main-side ingest contract, the
 * process-then-retire twin of `scanEventsLogDir`:
 *
 *  - mint + fold: a Pi birth record mints ONE synthetic SessionStart that the
 *    EXISTING jobs fold turns into a tracked row (harness / title / pid /
 *    backend coords / resume_target), with no reducer arm added;
 *  - exactly-once: a processed record is retired, so a re-scan mints nothing new;
 *  - poison isolation: a malformed record parks to dead_letters without wedging
 *    the scan (a following valid record in the same scan still processes);
 *  - re-fold parity: the birth-minted SessionStart events row is byte-identical
 *    to a hand-authored canonical SessionStart INSERT of the same fields;
 *  - absent-tree boot tolerance (no births maildir → a true no-op).
 *
 * Mirrors `test/events-ingest-worker.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackstopCounters } from "../src/backstop-telemetry";
import {
  BIRTH_RECORD_SCHEMA_VERSION,
  type BirthRecord,
  consumeProviderLegGrant,
  promoteBirthIntent,
  writeBirthIntent,
  writeBirthRecord,
} from "../src/birth-record";
import type { EventsIngestContext } from "../src/daemon";
import {
  BIRTH_STUCK_STATUS,
  decideProviderLegGrantWaitLog,
  drainToCompletion,
  providerLegGrantStatus,
  scanBirthDir,
} from "../src/daemon";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let birthDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-birth-ingest-test-"));
  birthDir = join(tmpDir, "births");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** The current process pid — a guaranteed-LIVE pid, so the mint-GC's dead-pid
 *  gate never fires against a test record between scans. */
const LIVE_PID = process.pid;

/**
 * A fully-populated Pi birth record. Every field the launcher captures
 * is set (all nullable coords non-null) so the fold + parity assertions exercise
 * the whole column mapping. `launch_ts` is fixed so the minted `events.ts` is
 * deterministic.
 */
function makeBirthRecord(overrides: Partial<BirthRecord> = {}): BirthRecord {
  return {
    schema_version: BIRTH_RECORD_SCHEMA_VERSION,
    session_id: "birth-sess-a",
    harness: "pi",
    pid: LIVE_PID,
    start_time: "darwin:Mon Jun  8 00:00:00 2026",
    cwd: "/Users/x/code/keeper",
    spawn_name: "pair",
    config_dir: "/Users/x/.pi",
    backend_exec_type: "tmux",
    backend_exec_session_id: "tsess",
    backend_exec_pane_id: "%7",
    worktree: "keeper/epic/fn-1103",
    launch_ts: "2026-07-03T12:00:00.000Z",
    resume_target: "pi-session-id",
    dispatch_attempt_id: null,
    ...overrides,
  };
}

/** Count SessionStart events for a session. */
function sessionStartCount(
  db: ReturnType<typeof freshMemDb>["db"],
  sessionId: string,
): number {
  const row = db
    .query(
      "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'SessionStart' AND session_id = ?",
    )
    .get(sessionId) as { n: number };
  return row.n;
}

/** The `.json` records remaining in the maildir `new/` dir. */
function pendingRecords(): string[] {
  const newDir = join(birthDir, "new");
  if (!existsSync(newDir)) return [];
  return readdirSync(newDir).filter((n) => n.endsWith(".json"));
}

/** Build the optional telemetry sink, mirroring the events-ingest test. */
function makeIngestCtx(): {
  ctx: EventsIngestContext;
  backstopLogPath: string;
} {
  const backstopLogPath = join(tmpDir, "backstop.ndjson");
  return {
    ctx: { counters: new BackstopCounters(), backstopLogPath },
    backstopLogPath,
  };
}

/** Read the backstop NDJSON sidecar (one JSON object per line), or `[]`. */
function readBackstopRecords(logPath: string): Record<string, unknown>[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

type BirthDeadLetterRow = {
  dl_id: string;
  status: string;
  hook_event: string;
  session_id: string;
  pid: number | null;
  bindings: string;
  source_file: string | null;
};

function birthDeadLetterRows(
  db: ReturnType<typeof freshMemDb>["db"],
): BirthDeadLetterRow[] {
  return db
    .query(
      `SELECT dl_id, status, hook_event, session_id, pid, bindings, source_file
         FROM dead_letters
        ORDER BY dl_id ASC`,
    )
    .all() as BirthDeadLetterRow[];
}

function expectBirthStuckRow(
  row: BirthDeadLetterRow,
  full: string,
  record: BirthRecord,
): void {
  expect(row.status).toBe(BIRTH_STUCK_STATUS);
  expect(row.hook_event).toBe("StuckBirthRecord");
  expect(row.session_id).toBe(record.session_id);
  expect(row.pid).toBe(record.pid);
  expect(row.source_file).toBe(full);
  expect(row.dl_id).toBe(`birth-stuck:${full}`);
  const bindings = JSON.parse(row.bindings) as {
    file: string;
    record: BirthRecord;
  };
  expect(bindings.file).toBe(full);
  expect(bindings.record.session_id).toBe(record.session_id);
  expect(bindings.record.cwd).toBe(record.cwd);
  expect(bindings.record.pid).toBe(record.pid);
}

function soleNewRecordPath(): string {
  const records = pendingRecords();
  expect(records.length).toBe(1);
  const name = records[0];
  if (name === undefined) throw new Error("expected one new birth record");
  return join(birthDir, "new", name);
}

test("scanBirthDir mints a synthetic SessionStart that folds to a tracked jobs row (harness, title, backend coords, resume_target)", () => {
  const { db } = freshMemDb();
  const record = makeBirthRecord();
  writeBirthRecord(birthDir, record);

  scanBirthDir(db, birthDir);
  drainToCompletion(db);

  const job = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get(record.session_id) as Record<string, unknown> | null;
  if (!job) throw new Error("expected a jobs row for the birth session");

  // Presence: a fresh Pi session lands as `stopped` (present, no live
  // activity yet), with the recycle-safe (pid, start_time) identity so the
  // exit-watcher can arm killed-detection.
  expect(job.state).toBe("stopped");
  expect(job.pid).toBe(record.pid);
  expect(job.start_time).toBe(record.start_time);
  // Harness tag + resume target ride the v107 columns (no reducer arm added).
  expect(job.harness).toBe("pi");
  expect(job.resume_target).toBe("pi-session-id");
  // Title from spawn_name (priority-1 'spawn' source) → drives the tmux rename.
  expect(job.title).toBe("pair");
  expect(job.title_source).toBe("spawn");
  // Identity + lane fields.
  expect(job.cwd).toBe(record.cwd);
  expect(job.config_dir).toBe(record.config_dir);
  expect(job.worktree).toBe(record.worktree);
  // Backend coords fold via the every-event backend arm — the renamer needs
  // type + pane id to locate the window.
  expect(job.backend_exec_type).toBe("tmux");
  expect(job.backend_exec_pane_id).toBe("%7");

  // The record was retired from the maildir.
  expect(pendingRecords()).toEqual([]);

  db.close();
});

test("unsupported harness and wrong-version births cannot mint jobs", () => {
  const { db } = freshMemDb();
  mkdirSync(join(birthDir, "new"), { recursive: true });
  const rawRecords: Record<string, unknown>[] = [
    { ...makeBirthRecord({ session_id: "codex-birth" }), harness: "codex" },
    {
      ...makeBirthRecord({ session_id: "wrong-version-birth" }),
      schema_version: BIRTH_RECORD_SCHEMA_VERSION + 1,
    },
  ];
  rawRecords.forEach((record, index) => {
    writeFileSync(
      join(birthDir, "new", `${index}.json`),
      `${JSON.stringify(record)}\n`,
    );
  });

  scanBirthDir(db, birthDir);
  drainToCompletion(db);

  const events = db.query("SELECT COUNT(*) AS n FROM events").get() as {
    n: number;
  };
  expect(events.n).toBe(0);
  const jobs = db.query("SELECT COUNT(*) AS n FROM jobs").get() as {
    n: number;
  };
  expect(jobs.n).toBe(0);
  expect(pendingRecords()).toEqual([]);

  db.close();
});

test("a Pi birth binds only the exact current Dispatch claim", () => {
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
     VALUES (?, ?, 'Dispatched', 'pending_dispatches', ?)`,
    [
      1_700_000_000,
      "work::fn-1276-pi.1",
      JSON.stringify({
        verb: "work",
        id: "fn-1276-pi.1",
        dir: "/repo",
        ts: 1_700_000_000,
        attempt_id: 42,
        expected_attempt_id: null,
      }),
    ],
  );
  drainToCompletion(db);
  writeBirthRecord(
    birthDir,
    makeBirthRecord({
      session_id: "pi-exact",
      harness: "pi",
      spawn_name: "work::fn-1276-pi.1",
      dispatch_attempt_id: 42,
    }),
  );
  scanBirthDir(db, birthDir);
  drainToCompletion(db);

  const claim = db
    .query(
      "SELECT attempt_id, state, session_id FROM dispatch_claims WHERE verb = 'work' AND id = 'fn-1276-pi.1'",
    )
    .get() as Record<string, unknown>;
  expect(claim).toEqual({
    attempt_id: 42,
    state: "bound",
    session_id: "pi-exact",
  });
  const job = db
    .query("SELECT dispatch_origin FROM jobs WHERE job_id = 'pi-exact'")
    .get() as { dispatch_origin: string | null };
  expect(job.dispatch_origin).toBe("autopilot");
  db.close();
});

test("a stranded pending owned birth is granted and ingested once by leg_launch_id", () => {
  const { db } = freshMemDb();
  const wrapper = makeBirthRecord({
    session_id: "wrapper-owned-1",
    spawn_name: "work::fn-1300-durable-wrapper-leg-ownership-cascade.2",
    dispatch_attempt_id: 42,
  });
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
     VALUES (?, ?, 'Dispatched', 'pending_dispatches', ?)`,
    [
      1_700_000_000,
      wrapper.session_id,
      JSON.stringify({
        verb: "work",
        id: "fn-1300-durable-wrapper-leg-ownership-cascade.2",
        dir: "/repo",
        ts: 1_700_000_000,
        attempt_id: 42,
        expected_attempt_id: null,
      }),
    ],
  );
  drainToCompletion(db);
  writeBirthRecord(birthDir, wrapper);
  scanBirthDir(db, birthDir);
  drainToCompletion(db);
  expect(
    db
      .query(
        "SELECT attempt_id, state, session_id FROM dispatch_claims WHERE attempt_id = 42",
      )
      .get(),
  ).toEqual({
    attempt_id: 42,
    state: "bound",
    session_id: wrapper.session_id,
  });
  expect(
    db.query("SELECT state FROM jobs WHERE job_id = ?").get(wrapper.session_id),
  ).toEqual({ state: "stopped" });

  const owned = makeBirthRecord({
    session_id: "provider-leg-session",
    spawn_name: "fn-1300-durable-wrapper-leg-ownership-cascade.2",
    dispatch_attempt_id: null,
    leg_launch_id: "leg-pending-1",
    wrapper_job_id: wrapper.session_id,
    wrapper_dispatch_attempt_id: 42,
    launcher_pid: LIVE_PID,
    launcher_start_time: "linux:100",
  });
  const draft = { ...owned } as Record<string, unknown>;
  delete draft.pid;
  delete draft.start_time;
  const intentPath = writeBirthIntent(
    birthDir,
    draft as unknown as Parameters<typeof writeBirthIntent>[1],
    LIVE_PID,
  );
  promoteBirthIntent(intentPath, owned);

  scanBirthDir(db, birthDir);
  drainToCompletion(db);
  expect(sessionStartCount(db, owned.session_id)).toBe(1);
  expect(
    db
      .query(
        "SELECT COUNT(*) AS n FROM provider_leg_ownership WHERE leg_launch_id = ?",
      )
      .get("leg-pending-1"),
  ).toEqual({ n: 1 });
  expect(
    consumeProviderLegGrant(birthDir, {
      leg_launch_id: "leg-pending-1",
      wrapper_job_id: wrapper.session_id,
      wrapper_dispatch_attempt_id: 42,
    }),
  ).toBe(true);

  // Recreate the same crash-stranded full pending record. Both synthetic events
  // remain set-once on leg_launch_id even though the maildir delivery repeats.
  const replayIntent = writeBirthIntent(
    birthDir,
    draft as unknown as Parameters<typeof writeBirthIntent>[1],
    LIVE_PID,
  );
  promoteBirthIntent(replayIntent, owned);
  scanBirthDir(db, birthDir);
  drainToCompletion(db);
  expect(sessionStartCount(db, owned.session_id)).toBe(1);
  expect(
    db
      .query(
        `SELECT COUNT(*) AS n FROM events
          WHERE hook_event = 'ProviderLegBorn'
            AND json_extract(data, '$.leg_launch_id') = 'leg-pending-1'`,
      )
      .get(),
  ).toEqual({ n: 1 });
  expect(
    consumeProviderLegGrant(birthDir, {
      leg_launch_id: "leg-pending-1",
      wrapper_job_id: wrapper.session_id,
      wrapper_dispatch_attempt_id: 42,
    }),
  ).toBe(true);
  db.close();
});

test("terminal owner between promotion and grant withholds paid-process authority", () => {
  const { db } = freshMemDb();
  const wrapper = makeBirthRecord({
    session_id: "wrapper-terminal-1",
    spawn_name: "work::fn-1300-durable-wrapper-leg-ownership-cascade.3",
    dispatch_attempt_id: 77,
  });
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
     VALUES (?, ?, 'Dispatched', 'pending_dispatches', ?)`,
    [
      1_700_000_000,
      wrapper.session_id,
      JSON.stringify({
        verb: "work",
        id: "fn-1300-durable-wrapper-leg-ownership-cascade.3",
        dir: "/repo",
        ts: 1_700_000_000,
        attempt_id: 77,
      }),
    ],
  );
  drainToCompletion(db);
  writeBirthRecord(birthDir, wrapper);
  scanBirthDir(db, birthDir);
  drainToCompletion(db);
  // Producer-side pre-exec validation reads the current projections. Seed the
  // exact between-promotion-and-grant terminal observation directly.
  db.run("UPDATE jobs SET state = 'ended' WHERE job_id = ?", [
    wrapper.session_id,
  ]);

  const owned = makeBirthRecord({
    session_id: "withheld-provider",
    dispatch_attempt_id: null,
    leg_launch_id: "leg-withheld-1",
    wrapper_job_id: wrapper.session_id,
    wrapper_dispatch_attempt_id: 77,
    launcher_pid: LIVE_PID,
    launcher_start_time: "linux:200",
  });
  const draft = { ...owned } as Record<string, unknown>;
  delete draft.pid;
  delete draft.start_time;
  const intentPath = writeBirthIntent(
    birthDir,
    draft as unknown as Parameters<typeof writeBirthIntent>[1],
    LIVE_PID,
  );
  promoteBirthIntent(intentPath, owned);
  scanBirthDir(db, birthDir);

  expect(sessionStartCount(db, owned.session_id)).toBe(0);
  expect(existsSync(intentPath)).toBe(false);
  expect(
    consumeProviderLegGrant(birthDir, {
      leg_launch_id: "leg-withheld-1",
      wrapper_job_id: wrapper.session_id,
      wrapper_dispatch_attempt_id: 77,
    }),
  ).toBe(false);
  const rows = birthDeadLetterRows(db);
  expect(rows.length).toBe(1);
  const row = rows[0];
  if (row === undefined) throw new Error("expected one birth-stuck row");
  expectBirthStuckRow(row, intentPath, owned);
  db.close();
});

test("a superseded exact owner never receives a provider grant", () => {
  const { db } = freshMemDb();
  const taskId = "fn-1300-durable-wrapper-leg-ownership-cascade.4";
  const wrapper = makeBirthRecord({
    session_id: "wrapper-superseded-1",
    spawn_name: `work::${taskId}`,
    dispatch_attempt_id: 88,
  });
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
     VALUES (?, ?, 'Dispatched', 'pending_dispatches', ?)`,
    [
      1_700_000_000,
      wrapper.session_id,
      JSON.stringify({
        verb: "work",
        id: taskId,
        dir: "/repo",
        ts: 1_700_000_000,
        attempt_id: 88,
      }),
    ],
  );
  drainToCompletion(db);
  writeBirthRecord(birthDir, wrapper);
  scanBirthDir(db, birthDir);
  drainToCompletion(db);
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
     VALUES (?, ?, 'DispatchClaimSuperseded', 'dispatch_claim_superseded', ?)`,
    [
      1_700_000_100,
      "reconciler",
      JSON.stringify({
        verb: "work",
        id: taskId,
        dir: "/repo",
        expected_attempt_id: 88,
        next_attempt_id: 89,
      }),
    ],
  );
  drainToCompletion(db);
  expect(
    db.query("SELECT attempt_id FROM dispatch_claims WHERE id = ?").get(taskId),
  ).toEqual({ attempt_id: 89 });

  const owned = makeBirthRecord({
    session_id: "superseded-provider",
    dispatch_attempt_id: null,
    leg_launch_id: "leg-superseded-1",
    wrapper_job_id: wrapper.session_id,
    wrapper_dispatch_attempt_id: 88,
    launcher_pid: LIVE_PID,
    launcher_start_time: "linux:300",
  });
  const draft = { ...owned } as Record<string, unknown>;
  delete draft.pid;
  delete draft.start_time;
  const intentPath = writeBirthIntent(
    birthDir,
    draft as unknown as Parameters<typeof writeBirthIntent>[1],
    LIVE_PID,
  );
  promoteBirthIntent(intentPath, owned);
  scanBirthDir(db, birthDir);

  expect(sessionStartCount(db, owned.session_id)).toBe(0);
  expect(existsSync(intentPath)).toBe(true);
  expect(
    consumeProviderLegGrant(birthDir, {
      leg_launch_id: "leg-superseded-1",
      wrapper_job_id: wrapper.session_id,
      wrapper_dispatch_attempt_id: 88,
    }),
  ).toBe(false);
  expect(birthDeadLetterRows(db)).toEqual([]);
  db.close();
});

test("a waiting owned birth parks as birth-stuck only after the dead-pid grace", () => {
  const { db } = freshMemDb();
  const record = makeBirthRecord({
    session_id: "wait-stuck-provider",
    pid: 9_876_543,
    start_time: "linux:9876543",
    dispatch_attempt_id: null,
    leg_launch_id: "leg-wait-stuck-1",
    wrapper_job_id: "wrapper-not-folded-yet",
    wrapper_dispatch_attempt_id: 99,
    launcher_pid: LIVE_PID,
    launcher_start_time: "linux:400",
  });
  writeBirthRecord(birthDir, record);
  const full = soleNewRecordPath();

  scanBirthDir(db, birthDir);

  expect(sessionStartCount(db, record.session_id)).toBe(0);
  expect(birthDeadLetterRows(db)).toEqual([]);
  expect(existsSync(full)).toBe(true);

  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(full, old, old);
  scanBirthDir(db, birthDir);

  let rows = birthDeadLetterRows(db);
  expect(rows.length).toBe(1);
  let row = rows[0];
  if (row === undefined) throw new Error("expected one birth-stuck row");
  expectBirthStuckRow(row, full, record);
  expect(existsSync(full)).toBe(false);

  writeBirthRecord(birthDir, record);
  const replayFull = soleNewRecordPath();
  expect(replayFull).toBe(full);
  utimesSync(replayFull, old, old);
  scanBirthDir(db, birthDir);

  rows = birthDeadLetterRows(db);
  expect(rows.length).toBe(1);
  row = rows[0];
  if (row === undefined) throw new Error("expected one birth-stuck row");
  expectBirthStuckRow(row, full, record);
  expect(existsSync(replayFull)).toBe(false);
  db.close();
});

test("scanBirthDir processes each record exactly once: retired after minting, a re-scan mints nothing new", () => {
  const { db } = freshMemDb();
  const record = makeBirthRecord();
  writeBirthRecord(birthDir, record);

  scanBirthDir(db, birthDir);
  expect(sessionStartCount(db, record.session_id)).toBe(1);
  expect(pendingRecords()).toEqual([]);

  // The file is gone, so a second scan (empty `new/`) adds no event.
  scanBirthDir(db, birthDir);
  expect(sessionStartCount(db, record.session_id)).toBe(1);

  // Even a re-announce (a fresh file for the SAME session) is HARMLESS at the
  // fold: the duplicate SessionStart is a resume, so the jobs row stays single.
  writeBirthRecord(birthDir, record);
  scanBirthDir(db, birthDir);
  drainToCompletion(db);
  expect(sessionStartCount(db, record.session_id)).toBe(2);
  const jobCount = db
    .query("SELECT COUNT(*) AS n FROM jobs WHERE job_id = ?")
    .get(record.session_id) as { n: number };
  expect(jobCount.n).toBe(1);
  expect(pendingRecords()).toEqual([]);

  db.close();
});

test("scanBirthDir parks a malformed record to dead_letters, retires it, and still ingests a valid record in the same scan", () => {
  const { db } = freshMemDb();
  const { ctx, backstopLogPath } = makeIngestCtx();

  // A valid record AND a raw garbage file, both in `new/`.
  const valid = makeBirthRecord({ session_id: "good-sess" });
  writeBirthRecord(birthDir, valid);
  const poisonPath = join(birthDir, "new", "99999.garbage.json");
  writeFileSync(poisonPath, "{not valid json at all");

  scanBirthDir(db, birthDir, ctx);

  // The valid record minted despite the poison sibling — the scan did not wedge.
  expect(sessionStartCount(db, "good-sess")).toBe(1);

  // The poison record is parked with status='poison' and a births-keyed dl_id.
  const dl = db
    .query(
      "SELECT dl_id, status, hook_event, session_id, source_file FROM dead_letters",
    )
    .all() as {
    dl_id: string;
    status: string;
    hook_event: string;
    session_id: string;
    source_file: string;
  }[];
  expect(dl.length).toBe(1);
  const row = dl[0];
  if (!row) throw new Error("expected one poison dead_letters row");
  expect(row.status).toBe("poison");
  expect(row.hook_event).toBe("PoisonBirthRecord");
  expect(row.session_id).toBe("poison");
  expect(row.dl_id).toBe(`birth-poison:${poisonPath}`);

  // Both files retired — the tree stays bounded.
  expect(pendingRecords()).toEqual([]);

  // One backstop record emitted for the parked record.
  const poisonRecs = readBackstopRecords(backstopLogPath).filter(
    (r) => r.backstop === "birth-ingest-poison",
  );
  expect(poisonRecs.length).toBe(1);
  const rec = poisonRecs[0];
  if (!rec) throw new Error("expected one birth-ingest-poison backstop record");
  expect(rec.rescued).toBe(true);
  expect((rec.detail as Record<string, string>).dl_id).toBe(row.dl_id);

  db.close();
});

test("scanBirthDir tolerates an absent births tree (no-op, no throw)", () => {
  const { db } = freshMemDb();

  // No births dir at all.
  scanBirthDir(db, join(tmpDir, "does-not-exist"));
  // A births dir with no `new/` subdir.
  mkdirSync(birthDir, { recursive: true });
  scanBirthDir(db, birthDir);

  const count = db.query("SELECT COUNT(*) AS n FROM events").get() as {
    n: number;
  };
  expect(count.n).toBe(0);

  db.close();
});

test("scanBirthDir re-fold parity: the birth-minted SessionStart events row is byte-identical to a canonical direct INSERT of the same fields", () => {
  const { db } = freshMemDb();
  const record = makeBirthRecord({ session_id: "parity" });

  // Producer path: mint via the births ingest.
  writeBirthRecord(birthDir, record);
  scanBirthDir(db, birthDir);

  // Direct path: hand-author the SAME SessionStart via a raw canonical INSERT
  // (an independent restatement of the column mapping — a drift guard). `ts` is
  // the launch_ts converted to unix seconds, matching the mint's `birthEventTs`.
  const ts = Date.parse(record.launch_ts) / 1000;
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
       plan_op, plan_target, plan_epic_id, plan_task_id,
       plan_subject_present, tool_use_id, config_dir,
       bash_mutation_kind, bash_mutation_targets, plan_files,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
       background_task_id, mutation_path, worktree, harness, resume_target
     ) VALUES (?, ?, ?, 'SessionStart', 'session_start', NULL, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [
      ts,
      record.session_id,
      record.pid,
      record.cwd,
      record.spawn_name,
      record.start_time,
      record.config_dir,
      record.backend_exec_type,
      record.backend_exec_session_id,
      record.backend_exec_pane_id,
      record.worktree,
      record.harness,
      record.resume_target,
    ],
  );

  // Two events rows now exist (minted then direct). Every column EXCEPT the
  // AUTOINCREMENT `id` must be byte-identical.
  const rows = db.query("SELECT * FROM events ORDER BY id ASC").all() as Record<
    string,
    unknown
  >[];
  expect(rows.length).toBe(2);
  const minted = rows[0];
  const direct = rows[1];
  if (!minted || !direct) throw new Error("expected two events rows");
  const stripId = (r: Record<string, unknown>): Record<string, unknown> => {
    const { id: _id, ...rest } = r;
    return rest;
  };
  expect(stripId(minted)).toEqual(stripId(direct));

  db.close();
});

// ---------------------------------------------------------------------------
// providerLegGrantStatus — cause-split classification. The prior single JOIN
// collapsed every non-grant state into a bare `wait`; the split names WHY while
// preserving every grant/wait/deny routing decision. Seed the exact claim/job
// state directly (deterministic, no fold) and assert the typed verdict.
// ---------------------------------------------------------------------------

const OWNED_LEG_OVERRIDES = {
  session_id: "grant-status-leg",
  dispatch_attempt_id: null,
  leg_launch_id: "leg-status-1",
  wrapper_job_id: "wrapper-status-1",
  wrapper_dispatch_attempt_id: 700,
  launcher_pid: LIVE_PID,
  launcher_start_time: "linux:700",
} satisfies Partial<BirthRecord>;

function seedWrapperJob(
  db: ReturnType<typeof freshMemDb>["db"],
  state: string,
): void {
  db.query(
    `INSERT INTO jobs (job_id, state, created_at, updated_at, last_event_id)
     VALUES ('wrapper-status-1', ?, 1, 1, 1)`,
  ).run(state);
}

function seedWrapperClaim(
  db: ReturnType<typeof freshMemDb>["db"],
  state: string,
  sessionId: string | null,
): void {
  db.query(
    `INSERT INTO dispatch_claims
       (verb, id, attempt_id, state, session_id, legacy_unfenced,
        acquired_at, bound_at, last_event_id, updated_at)
     VALUES ('work', 'fn-status.1', 700, ?, ?, 0, 1, 2, 1, 2)`,
  ).run(state, sessionId);
}

/**
 * Seed a `provider_leg_ownership` row directly (deterministic, no fold) so the
 * single-live-leg admission read has a sibling to consult. Defaults place the leg
 * on the `OWNED_LEG_OVERRIDES` attempt so it is a sibling of `leg-status-1`.
 */
function seedOwnershipRow(
  db: ReturnType<typeof freshMemDb>["db"],
  opts: {
    legLaunchId: string;
    wrapperJobId?: string;
    attemptId?: number;
    state?: string;
    legSessionId?: string | null;
  },
): void {
  db.query(
    `INSERT INTO provider_leg_ownership
       (leg_launch_id, wrapper_job_id, wrapper_dispatch_attempt_id,
        ownership_epoch_event_id, leg_session_id, state, last_event_id,
        created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?, 1, 1, 1)`,
  ).run(
    opts.legLaunchId,
    opts.wrapperJobId ?? "wrapper-status-1",
    opts.attemptId ?? 700,
    opts.legSessionId ?? null,
    opts.state ?? "live",
  );
}

/** Seed a leg session's own jobs row (its independent lifecycle state). */
function seedLegJob(
  db: ReturnType<typeof freshMemDb>["db"],
  jobId: string,
  state: string,
): void {
  db.query(
    `INSERT INTO jobs (job_id, state, created_at, updated_at, last_event_id)
     VALUES (?, ?, 1, 1, 1)`,
  ).run(jobId, state);
}

test("providerLegGrantStatus: no wrapper job row yet is a transient wrapper-unfolded wait", () => {
  const { db } = freshMemDb();
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "wait",
    cause: "wrapper-unfolded",
  });
  db.close();
});

test("providerLegGrantStatus: wrapper folded but the exact attempt has no claim is a claim-absent wait", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "wait",
    cause: "claim-absent",
  });
  db.close();
});

test("providerLegGrantStatus: an acquired-but-unbound claim is a claim-unbound wait", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "acquired", null);
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "wait",
    cause: "claim-unbound",
  });
  db.close();
});

test("providerLegGrantStatus: a claim bound to the exact wrapper session grants", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({ decision: "grant" });
  db.close();
});

test("providerLegGrantStatus: a claim bound to a DIFFERENT session denies claim-foreign", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "someone-else");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "deny",
    cause: "claim-foreign",
  });
  db.close();
});

test("providerLegGrantStatus: an ended wrapper job denies wrapper-terminal", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "ended");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "deny",
    cause: "wrapper-terminal",
  });
  db.close();
});

test("providerLegGrantStatus: an ended wrapper with NO claim denies wrapper-terminal immediately (never waits on an absent claim)", () => {
  const { db } = freshMemDb();
  // Ended wrapper, no claim seeded: positive terminality wins over claim-absence,
  // so the leg fails fast instead of burning the full grant gate.
  seedWrapperJob(db, "ended");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "deny",
    cause: "wrapper-terminal",
  });
  db.close();
});

test("providerLegGrantStatus: a killed wrapper with NO claim denies wrapper-terminal immediately", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "killed");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "deny",
    cause: "wrapper-terminal",
  });
  db.close();
});

test("providerLegGrantStatus: an incomplete owner tuple denies owner-incomplete", () => {
  const { db } = freshMemDb();
  // A legacy/non-owned birth (no leg_launch_id) carries no owner tuple.
  const record = makeBirthRecord({ session_id: "legacy-presence" });
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "deny",
    cause: "owner-incomplete",
  });
  db.close();
});

// ---------------------------------------------------------------------------
// providerLegGrantStatus — single-live-leg admission rail. An otherwise-grantable
// leg (working wrapper + claim bound to it) is admitted ONLY if no DIFFERENT leg
// still holds the exact same wrapper attempt live, so a wait-timeout / RESUME
// relaunch never double-mints two legs editing one lane concurrently.
// ---------------------------------------------------------------------------

test("providerLegGrantStatus: a DIFFERENT live sibling on the same attempt holds the grant as a sibling-live wait", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  // leg-sibling-1 already granted + live on attempt 700, its session still working.
  seedOwnershipRow(db, {
    legLaunchId: "leg-sibling-1",
    legSessionId: "leg-sibling-sess-1",
  });
  seedLegJob(db, "leg-sibling-sess-1", "working");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES); // leg-status-1, same attempt
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "wait",
    cause: "sibling-live",
    sibling: "leg-sibling-1",
  });
  db.close();
});

test("providerLegGrantStatus: a sibling whose ownership folded terminal no longer blocks (admits)", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  seedOwnershipRow(db, {
    legLaunchId: "leg-sibling-1",
    legSessionId: "leg-sibling-sess-1",
    state: "terminal",
  });
  seedLegJob(db, "leg-sibling-sess-1", "working");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({ decision: "grant" });
  db.close();
});

test("providerLegGrantStatus: the requesting leg's OWN live ownership row never self-blocks (idempotent re-poll grant)", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  // A crash-replayed delivery re-requests: leg-status-1's own row is already live.
  seedOwnershipRow(db, {
    legLaunchId: "leg-status-1",
    legSessionId: "grant-status-leg",
  });
  seedLegJob(db, "grant-status-leg", "working");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({ decision: "grant" });
  db.close();
});

test("providerLegGrantStatus: among legacy duplicates (two terminal + one live) only the live sibling blocks", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  seedOwnershipRow(db, {
    legLaunchId: "leg-old-a",
    state: "terminal",
    legSessionId: "leg-old-a-sess",
  });
  seedOwnershipRow(db, {
    legLaunchId: "leg-old-b",
    state: "terminal",
    legSessionId: "leg-old-b-sess",
  });
  seedOwnershipRow(db, {
    legLaunchId: "leg-live-c",
    state: "live",
    legSessionId: "leg-live-c-sess",
  });
  seedLegJob(db, "leg-live-c-sess", "working");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "wait",
    cause: "sibling-live",
    sibling: "leg-live-c",
  });
  db.close();
});

test("providerLegGrantStatus: a live-ownership sibling whose leg session folded terminal never wedges admission (admits)", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  // The ownership row is still 'live' but the leg's OWN session ended — exact
  // folded terminal evidence, so a stale/legacy duplicate can never block forever.
  seedOwnershipRow(db, {
    legLaunchId: "leg-dead-1",
    legSessionId: "leg-dead-sess-1",
    state: "live",
  });
  seedLegJob(db, "leg-dead-sess-1", "ended");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({ decision: "grant" });
  db.close();
});

test("providerLegGrantStatus: a live leg on a DIFFERENT attempt or wrapper never blocks this attempt's grant", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  seedOwnershipRow(db, {
    legLaunchId: "leg-other-attempt",
    attemptId: 701,
    legSessionId: "s1",
  });
  seedOwnershipRow(db, {
    legLaunchId: "leg-other-wrapper",
    wrapperJobId: "wrapper-other",
    legSessionId: "s2",
  });
  seedLegJob(db, "s1", "working");
  seedLegJob(db, "s2", "working");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({ decision: "grant" });
  db.close();
});

test("providerLegGrantStatus: a live sibling with no folded leg session (null) still blocks and the read never throws", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "wrapper-status-1");
  seedOwnershipRow(db, { legLaunchId: "leg-nulljob-1", legSessionId: null });
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "wait",
    cause: "sibling-live",
    sibling: "leg-nulljob-1",
  });
  db.close();
});

test("providerLegGrantStatus: the admission rail never overrides a terminal deny (a foreign claim denies even with a live sibling)", () => {
  const { db } = freshMemDb();
  seedWrapperJob(db, "working");
  seedWrapperClaim(db, "bound", "someone-else");
  seedOwnershipRow(db, {
    legLaunchId: "leg-sibling-1",
    legSessionId: "leg-sibling-sess-1",
  });
  seedLegJob(db, "leg-sibling-sess-1", "working");
  const record = makeBirthRecord(OWNED_LEG_OVERRIDES);
  expect(providerLegGrantStatus(db, record)).toEqual({
    decision: "deny",
    cause: "claim-foreign",
  });
  db.close();
});

test("scanBirthDir end-to-end: a second leg on a live attempt is withheld (no grant leaf, no mint, record retained) and admitted once the sibling settles", () => {
  const { db } = freshMemDb();
  // A live wrapper attempt with its claim bound, and leg-int-1 already live on it.
  db.query(
    `INSERT INTO jobs (job_id, state, created_at, updated_at, last_event_id)
     VALUES ('wrapper-int-1', 'working', 1, 1, 1)`,
  ).run();
  db.query(
    `INSERT INTO dispatch_claims
       (verb, id, attempt_id, state, session_id, legacy_unfenced,
        acquired_at, bound_at, last_event_id, updated_at)
     VALUES ('work', 'fn-int.1', 500, 'bound', 'wrapper-int-1', 0, 1, 2, 1, 2)`,
  ).run();
  seedOwnershipRow(db, {
    legLaunchId: "leg-int-1",
    wrapperJobId: "wrapper-int-1",
    attemptId: 500,
    legSessionId: "leg-int-1-session",
    state: "live",
  });
  seedLegJob(db, "leg-int-1-session", "working");

  const leg2 = makeBirthRecord({
    session_id: "leg-int-2-session",
    dispatch_attempt_id: null,
    leg_launch_id: "leg-int-2",
    wrapper_job_id: "wrapper-int-1",
    wrapper_dispatch_attempt_id: 500,
    launcher_pid: LIVE_PID,
    launcher_start_time: "linux:500",
  });
  writeBirthRecord(birthDir, leg2);
  const full = soleNewRecordPath();

  const memo = new Map<string, string>();
  const ctx: EventsIngestContext = {
    counters: new BackstopCounters(),
    backstopLogPath: join(tmpDir, "backstop.ndjson"),
    providerLegGrantWaitLog: memo,
  };

  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    scanBirthDir(db, birthDir, ctx);
  } finally {
    console.error = origError;
  }

  // Withheld: no synthetic events, no ownership row, no grant leaf, no park.
  expect(sessionStartCount(db, "leg-int-2-session")).toBe(0);
  expect(
    db
      .query(
        "SELECT COUNT(*) AS n FROM provider_leg_ownership WHERE leg_launch_id = 'leg-int-2'",
      )
      .get(),
  ).toEqual({ n: 0 });
  expect(
    consumeProviderLegGrant(birthDir, {
      leg_launch_id: "leg-int-2",
      wrapper_job_id: "wrapper-int-1",
      wrapper_dispatch_attempt_id: 500,
    }),
  ).toBe(false);
  expect(birthDeadLetterRows(db)).toEqual([]);
  // Retained for a later admission — a live pid, so the stuck-GC does not retire.
  expect(existsSync(full)).toBe(true);
  // Exactly one bounded visibility line, naming both legs.
  const waitLines = errors.filter((l) => l.includes("provider-leg grant wait"));
  expect(waitLines).toEqual([
    "[keeperd] provider-leg grant wait: leg leg-int-2 wrapper wrapper-int-1 attempt 500 cause sibling-live sibling leg-int-1",
  ]);

  // The sibling settles (its folded terminal transition lands): a re-scan admits.
  db.run(
    "UPDATE provider_leg_ownership SET state = 'terminal' WHERE leg_launch_id = 'leg-int-1'",
  );
  scanBirthDir(db, birthDir, ctx);
  drainToCompletion(db);

  expect(sessionStartCount(db, "leg-int-2-session")).toBe(1);
  expect(
    db
      .query(
        `SELECT COUNT(*) AS n FROM events
          WHERE hook_event = 'ProviderLegBorn'
            AND json_extract(data, '$.leg_launch_id') = 'leg-int-2'`,
      )
      .get(),
  ).toEqual({ n: 1 });
  expect(
    consumeProviderLegGrant(birthDir, {
      leg_launch_id: "leg-int-2",
      wrapper_job_id: "wrapper-int-1",
      wrapper_dispatch_attempt_id: 500,
    }),
  ).toBe(true);
  expect(existsSync(full)).toBe(false); // the granted record is consumed
  db.close();
});

test("scanBirthDir prunes a wait-log memo entry when the leg's birth record disappears without a terminal settle (bounds the resident memo)", () => {
  const { db } = freshMemDb();
  const memo = new Map<string, string>();
  const ctx: EventsIngestContext = {
    counters: new BackstopCounters(),
    backstopLogPath: join(tmpDir, "backstop.ndjson"),
    providerLegGrantWaitLog: memo,
  };
  // A leg whose wrapper never folds waits indefinitely (wrapper-unfolded).
  const leg = makeBirthRecord({
    session_id: "prune-leg-session",
    dispatch_attempt_id: null,
    leg_launch_id: "leg-prune-1",
    wrapper_job_id: "wrapper-never-folds",
    wrapper_dispatch_attempt_id: 321,
    launcher_pid: LIVE_PID,
    launcher_start_time: "linux:321",
  });
  writeBirthRecord(birthDir, leg);
  const full = soleNewRecordPath();

  // First scan: the leg waits, its memo entry lands, and the record is retained
  // (a live pid, so the stuck-GC does not retire it).
  scanBirthDir(db, birthDir, ctx);
  expect(memo.has("leg-prune-1")).toBe(true);
  expect(existsSync(full)).toBe(true);

  // The shim self-retires its own birth record with no terminal settle behind it.
  rmSync(full);

  // The next completed scan does not observe the leg, so it prunes the entry —
  // the memo cannot leak one entry per timed-out leg.
  scanBirthDir(db, birthDir, ctx);
  expect(memo.has("leg-prune-1")).toBe(false);
  expect(memo.size).toBe(0);
  db.close();
});

test("scanBirthDir keeps a still-waiting leg's memo entry across scans (prune only drops vanished legs)", () => {
  const { db } = freshMemDb();
  const memo = new Map<string, string>();
  const ctx: EventsIngestContext = {
    counters: new BackstopCounters(),
    backstopLogPath: join(tmpDir, "backstop.ndjson"),
    providerLegGrantWaitLog: memo,
  };
  const leg = makeBirthRecord({
    session_id: "keep-leg-session",
    dispatch_attempt_id: null,
    leg_launch_id: "leg-keep-1",
    wrapper_job_id: "wrapper-never-folds",
    wrapper_dispatch_attempt_id: 654,
    launcher_pid: LIVE_PID,
    launcher_start_time: "linux:654",
  });
  writeBirthRecord(birthDir, leg);

  scanBirthDir(db, birthDir, ctx);
  expect(memo.has("leg-keep-1")).toBe(true);
  // The record is still present and still waiting, so a second completed scan
  // re-observes it and retains the entry.
  scanBirthDir(db, birthDir, ctx);
  expect(memo.has("leg-keep-1")).toBe(true);
  db.close();
});

// ---------------------------------------------------------------------------
// decideProviderLegGrantWaitLog — ONE bounded visibility line per (leg, cause)
// transition, never once per poll.
// ---------------------------------------------------------------------------

test("decideProviderLegGrantWaitLog: one line per (leg, cause) transition, none per repeat poll", () => {
  const memo = new Map<string, string>();
  const leg = {
    legLaunchId: "leg-x",
    wrapperJobId: "work::fn-9.1",
    wrapperAttemptId: 42,
  };
  const lines: string[] = [];
  // A poll sequence: same cause repeats (no re-log), then transitions.
  for (const cause of [
    "wrapper-unfolded",
    "wrapper-unfolded",
    "claim-absent",
    "claim-absent",
    "claim-unbound",
  ] as const) {
    const line = decideProviderLegGrantWaitLog(memo, leg, cause);
    if (line !== null) lines.push(line);
  }
  expect(lines).toEqual([
    "[keeperd] provider-leg grant wait: leg leg-x wrapper work::fn-9.1 attempt 42 cause wrapper-unfolded",
    "[keeperd] provider-leg grant wait: leg leg-x wrapper work::fn-9.1 attempt 42 cause claim-absent",
    "[keeperd] provider-leg grant wait: leg leg-x wrapper work::fn-9.1 attempt 42 cause claim-unbound",
  ]);
});

test("decideProviderLegGrantWaitLog: distinct legs each get their own transition line", () => {
  const memo = new Map<string, string>();
  const a = decideProviderLegGrantWaitLog(
    memo,
    { legLaunchId: "leg-a", wrapperJobId: "w", wrapperAttemptId: 1 },
    "wrapper-unfolded",
  );
  const b = decideProviderLegGrantWaitLog(
    memo,
    { legLaunchId: "leg-b", wrapperJobId: "w", wrapperAttemptId: 2 },
    "wrapper-unfolded",
  );
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(a).not.toBe(b);
});

test("decideProviderLegGrantWaitLog: sibling-live names both legs and re-logs once when the blocker changes", () => {
  const memo = new Map<string, string>();
  const leg = {
    legLaunchId: "leg-x",
    wrapperJobId: "work::fn-9.1",
    wrapperAttemptId: 42,
  };
  const lines: string[] = [];
  // The blocker holds (no re-log), then a NEW sibling takes over (one re-log).
  for (const sibling of ["leg-a", "leg-a", "leg-b", "leg-b"]) {
    const line = decideProviderLegGrantWaitLog(
      memo,
      leg,
      "sibling-live",
      sibling,
    );
    if (line !== null) lines.push(line);
  }
  expect(lines).toEqual([
    "[keeperd] provider-leg grant wait: leg leg-x wrapper work::fn-9.1 attempt 42 cause sibling-live sibling leg-a",
    "[keeperd] provider-leg grant wait: leg leg-x wrapper work::fn-9.1 attempt 42 cause sibling-live sibling leg-b",
  ]);
});
