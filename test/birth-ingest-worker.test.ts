/**
 * Tests for the births-tree ingest path (fn-1103). Drives `scanBirthDir`
 * directly against a tmp DB + tmp births maildir — no Worker spawned (the worker
 * thread just posts contentless notifications, covered by the daemon
 * ALL_WORKERS pin). These tests focus on the main-side ingest contract, the
 * process-then-retire twin of `scanEventsLogDir`:
 *
 *  - mint + fold: a birth record mints ONE synthetic SessionStart that the
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackstopCounters } from "../src/backstop-telemetry";
import {
  BIRTH_RECORD_SCHEMA_VERSION,
  type BirthRecord,
  writeBirthRecord,
} from "../src/birth-record";
import type { EventsIngestContext } from "../src/daemon";
import { drainToCompletion, scanBirthDir } from "../src/daemon";
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
 * A fully-populated non-claude birth record. Every field the launcher captures
 * is set (all nullable coords non-null) so the fold + parity assertions exercise
 * the whole column mapping. `launch_ts` is fixed so the minted `events.ts` is
 * deterministic.
 */
function makeBirthRecord(overrides: Partial<BirthRecord> = {}): BirthRecord {
  return {
    schema_version: BIRTH_RECORD_SCHEMA_VERSION,
    session_id: "birth-sess-a",
    harness: "codex",
    pid: LIVE_PID,
    start_time: "darwin:Mon Jun  8 00:00:00 2026",
    cwd: "/Users/x/code/keeper",
    spawn_name: "pair",
    config_dir: "/Users/x/.codex",
    backend_exec_type: "tmux",
    backend_exec_session_id: "tsess",
    backend_exec_pane_id: "%7",
    worktree: "keeper/epic/fn-1103",
    launch_ts: "2026-07-03T12:00:00.000Z",
    resume_target: "codex-rollout-uuid",
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

  // Presence: a fresh non-claude session lands as `stopped` (present, no live
  // activity yet), with the recycle-safe (pid, start_time) identity so the
  // exit-watcher can arm killed-detection.
  expect(job.state).toBe("stopped");
  expect(job.pid).toBe(record.pid);
  expect(job.start_time).toBe(record.start_time);
  // Harness tag + resume target ride the v107 columns (no reducer arm added).
  expect(job.harness).toBe("codex");
  expect(job.resume_target).toBe("codex-rollout-uuid");
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
