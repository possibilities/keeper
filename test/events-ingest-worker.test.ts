/**
 * Tests for the events-log ingest path (fn-736 task .1). Drives
 * `scanEventsLogDir` directly against a tmp DB + tmp NDJSON tree — no Worker
 * spawned. The worker thread itself just posts contentless notifications
 * (covered by the daemon integration surface); these tests focus on the
 * main-side ingest contract:
 *
 *  - exactly-once: double-ingest (re-scan the same file) yields NO duplicate
 *    `events` rows (the durable per-pid byte-offset is the idempotency key);
 *  - strict torn-tail: a partial final line is NOT folded and the offset does
 *    NOT advance past it — a later complete append re-reads the now-whole line;
 *  - re-fold parity: a NDJSON-ingested event lands `events` columns
 *    byte-identical to a direct `INSERT INTO events` of the same bindings
 *    (incl SessionStart-scraped fields);
 *  - empty/absent dir boot tolerance (task .1 ships before the hook flip, so
 *    the dir is normally absent — a true no-op).
 *
 * Mirrors `test/dead-letter-worker.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEventsLogDir } from "../src/daemon";
import { openDb } from "../src/db";
import type { EventLogRecord } from "../src/dead-letter";
import { serializeEventLogRecord } from "../src/dead-letter";

let tmpDir: string;
let dbPath: string;
let eventsLogDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-events-ingest-test-"));
  dbPath = join(tmpDir, "keeper.db");
  eventsLogDir = join(tmpDir, "events-log");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a fully-populated events-log record. The bindings carry every column
 * the hook would bind for a SessionStart event, including the scraped
 * `spawn_name` / `start_time` / `config_dir` fields that are unrecoverable
 * later — so the parity test proves they round-trip.
 */
function makeRecord(
  sessionId: string,
  hookEvent = "SessionStart",
): EventLogRecord {
  return {
    bindings: {
      ts: 1_700_000_000.5,
      session_id: sessionId,
      pid: 4242,
      hook_event: hookEvent,
      event_type: "session",
      tool_name: null,
      matcher: null,
      cwd: "/Users/x/code/keeper",
      permission_mode: "default",
      agent_id: null,
      agent_type: null,
      stop_hook_active: false,
      data: JSON.stringify({ hook_event_name: hookEvent }),
      subagent_agent_id: null,
      spawn_name: "work:worker",
      start_time: "2026-06-08T00:00:00Z",
      slash_command: null,
      skill_name: null,
      planctl_op: null,
      planctl_target: null,
      planctl_epic_id: null,
      planctl_task_id: null,
      planctl_subject_present: null,
      tool_use_id: null,
      config_dir: "/Users/x/.claude",
      planctl_queue_jump: null,
      bash_mutation_kind: null,
      bash_mutation_targets: null,
      planctl_files: null,
      backend_exec_type: "zellij",
      backend_exec_session_id: "zsess",
      backend_exec_pane_id: "0",
      background_task_id: null,
    },
  };
}

/**
 * The current process pid — a guaranteed-LIVE pid, so a `<LIVE_PID>.ndjson`
 * file is never reaped by the cleanup gate (`offset-at-EOF && !pidAlive`)
 * between scans. Most ingest tests reuse the same file across re-scans, so they
 * key it on this live pid to keep it on disk. The reap test uses a separate
 * non-existent pid to exercise the dead-pid cleanup branch.
 */
const LIVE_PID = process.pid;

test("scanEventsLogDir ingests each NDJSON line as an events row", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  const records = [makeRecord("aaa"), makeRecord("bbb"), makeRecord("ccc")];
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, records.map(serializeEventLogRecord).join(""));

  scanEventsLogDir(db, eventsLogDir);

  const rows = db
    .query(
      "SELECT session_id, hook_event, spawn_name, config_dir FROM events ORDER BY id ASC",
    )
    .all() as {
    session_id: string;
    hook_event: string;
    spawn_name: string | null;
    config_dir: string | null;
  }[];

  expect(rows.length).toBe(3);
  expect(rows.map((r) => r.session_id)).toEqual(["aaa", "bbb", "ccc"]);
  for (const row of rows) {
    expect(row.hook_event).toBe("SessionStart");
    expect(row.spawn_name).toBe("work:worker");
    expect(row.config_dir).toBe("/Users/x/.claude");
  }

  db.close();
});

test("scanEventsLogDir is exactly-once — a re-scan inserts no duplicate rows", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  const records = [makeRecord("aaa"), makeRecord("bbb")];
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, records.map(serializeEventLogRecord).join(""));

  scanEventsLogDir(db, eventsLogDir);
  const firstCount = (
    db.query("SELECT count(*) AS c FROM events").get() as { c: number }
  ).c;
  expect(firstCount).toBe(2);

  // Re-scan the UNCHANGED file: the durable per-pid byte-offset already points
  // past every line, so the scan reads zero new bytes and inserts nothing.
  scanEventsLogDir(db, eventsLogDir);
  const secondCount = (
    db.query("SELECT count(*) AS c FROM events").get() as { c: number }
  ).c;
  expect(secondCount).toBe(2);

  // The offset row tracks the full file length.
  const offRow = db
    .query("SELECT offset FROM event_ingest_offsets WHERE path = ?")
    .get(file) as { offset: number } | null;
  expect(offRow).not.toBeNull();

  db.close();
});

test("scanEventsLogDir picks up a record appended after the first scan", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, serializeEventLogRecord(makeRecord("aaa")));
  scanEventsLogDir(db, eventsLogDir);
  expect(
    (db.query("SELECT count(*) AS c FROM events").get() as { c: number }).c,
  ).toBe(1);

  // Append a second record (the hook's append-only growth pattern). The scan
  // reads ONLY the new tail from the durable offset — the first record is not
  // re-ingested.
  writeFileSync(
    file,
    serializeEventLogRecord(makeRecord("aaa")) +
      serializeEventLogRecord(makeRecord("bbb")),
  );
  scanEventsLogDir(db, eventsLogDir);

  const rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa", "bbb"]);

  db.close();
});

test("scanEventsLogDir does not fold a torn final line; re-reads it on a later complete append", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  const valid = serializeEventLogRecord(makeRecord("aaa"));
  // Append a partial JSON line (no closing brace, no newline) — a hook killed
  // mid-write.
  const torn = `${valid}{"bindings":{"session_id":"bbb","ts`;
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, torn);

  scanEventsLogDir(db, eventsLogDir);
  // Only the complete first record is folded; the torn tail is NOT.
  let rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa"]);

  // The offset advanced ONLY past the complete first line — it points at the
  // start of the torn bytes, NOT the file end.
  const offRow = db
    .query("SELECT offset FROM event_ingest_offsets WHERE path = ?")
    .get(file) as { offset: number };
  expect(offRow.offset).toBe(Buffer.byteLength(valid, "utf8"));

  // The hook completes the second line (the torn tail now finishes with a
  // valid record + newline). The next scan re-reads from the durable offset
  // and folds the now-whole line — no duplicate of the first record.
  writeFileSync(file, valid + serializeEventLogRecord(makeRecord("bbb")));
  scanEventsLogDir(db, eventsLogDir);

  rows = db.query("SELECT session_id FROM events ORDER BY id ASC").all() as {
    session_id: string;
  }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa", "bbb"]);

  db.close();
});

test("scanEventsLogDir re-fold parity: an NDJSON-ingested event matches a direct INSERT byte-for-byte", () => {
  const { db, stmts } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  const record = makeRecord("parity");
  // Direct INSERT of the SAME bindings via the canonical prepared statement
  // (the path the hook used pre-fn-736 / the daemon uses for synthetic mints).
  // `$`-prefixed keys mirror prepareStmts' insertEvent.
  const bindings = record.bindings;
  stmts.insertEvent.run({
    $ts: bindings.ts,
    $session_id: bindings.session_id,
    $pid: bindings.pid,
    $hook_event: bindings.hook_event,
    $event_type: bindings.event_type,
    $tool_name: bindings.tool_name,
    $matcher: bindings.matcher,
    $cwd: bindings.cwd,
    $permission_mode: bindings.permission_mode,
    $agent_id: bindings.agent_id,
    $agent_type: bindings.agent_type,
    $stop_hook_active: bindings.stop_hook_active ? 1 : 0,
    $data: bindings.data,
    $subagent_agent_id: bindings.subagent_agent_id,
    $spawn_name: bindings.spawn_name,
    $start_time: bindings.start_time,
    $slash_command: bindings.slash_command,
    $skill_name: bindings.skill_name,
    $planctl_op: bindings.planctl_op,
    $planctl_target: bindings.planctl_target,
    $planctl_epic_id: bindings.planctl_epic_id,
    $planctl_task_id: bindings.planctl_task_id,
    $planctl_subject_present: bindings.planctl_subject_present,
    $tool_use_id: bindings.tool_use_id,
    $config_dir: bindings.config_dir,
    $planctl_queue_jump: bindings.planctl_queue_jump,
    $bash_mutation_kind: bindings.bash_mutation_kind,
    $bash_mutation_targets: bindings.bash_mutation_targets,
    $planctl_files: bindings.planctl_files,
    $backend_exec_type: bindings.backend_exec_type,
    $backend_exec_session_id: bindings.backend_exec_session_id,
    $backend_exec_pane_id: bindings.backend_exec_pane_id,
    $background_task_id: bindings.background_task_id,
  });

  // NDJSON-ingest the SAME bindings.
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, serializeEventLogRecord(record));
  scanEventsLogDir(db, eventsLogDir);

  // Two rows now exist (direct then ingested). Compare every column EXCEPT the
  // AUTOINCREMENT `id` — they must be byte-identical, proving the ingested row
  // folds the same as a direct INSERT (re-fold determinism by construction).
  const rows = db.query("SELECT * FROM events ORDER BY id ASC").all() as Record<
    string,
    unknown
  >[];
  expect(rows.length).toBe(2);
  const direct = rows[0];
  const ingested = rows[1];
  if (!direct || !ingested) throw new Error("expected two events rows");
  const stripId = (r: Record<string, unknown>): Record<string, unknown> => {
    const { id: _id, ...rest } = r;
    return rest;
  };
  expect(stripId(ingested)).toEqual(stripId(direct));

  db.close();
});

test("scanEventsLogDir truncation guard: a file shorter than the stored offset is re-read from 0", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(
    file,
    serializeEventLogRecord(makeRecord("aaa")) +
      serializeEventLogRecord(makeRecord("bbb")),
  );
  scanEventsLogDir(db, eventsLogDir);
  expect(
    (db.query("SELECT count(*) AS c FROM events").get() as { c: number }).c,
  ).toBe(2);

  // Replace the file with a SHORTER one (simulating inode reuse / a wipe). The
  // stored offset now exceeds the new size → the guard falls to 0 and re-reads
  // from the top, landing the new single record.
  writeFileSync(file, serializeEventLogRecord(makeRecord("ccc")));
  scanEventsLogDir(db, eventsLogDir);

  const rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa", "bbb", "ccc"]);

  db.close();
});

test("scanEventsLogDir tolerates a missing dir (fresh machine / pre-hook-flip)", () => {
  const { db } = openDb(dbPath);
  // Do NOT create eventsLogDir — task .1 ships before the hook flip, so the dir
  // is normally absent.
  expect(() => scanEventsLogDir(db, eventsLogDir)).not.toThrow();
  const count = (
    db.query("SELECT count(*) AS c FROM events").get() as { c: number }
  ).c;
  expect(count).toBe(0);
  db.close();
});

test("scanEventsLogDir tolerates an empty dir (no .ndjson files)", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });
  expect(() => scanEventsLogDir(db, eventsLogDir)).not.toThrow();
  expect(
    (db.query("SELECT count(*) AS c FROM events").get() as { c: number }).c,
  ).toBe(0);
  db.close();
});

test("scanEventsLogDir ignores non-ndjson files in the dir", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  writeFileSync(join(eventsLogDir, "notes.txt"), "this is not ndjson");
  writeFileSync(
    join(eventsLogDir, `${LIVE_PID}.ndjson`),
    serializeEventLogRecord(makeRecord("aaa")),
  );

  scanEventsLogDir(db, eventsLogDir);

  const rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa"]);

  db.close();
});

test("scanEventsLogDir reaps a fully-drained dead-pid file, keeps a live-pid file", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  // A dead pid: pid 1 is init/launchd which we can't signal → EPERM → treated
  // as alive. Use a high pid that almost certainly does not exist. (The CI/dev
  // host won't have pid 999999.)
  const deadPid = 999_999;
  const deadFile = join(eventsLogDir, `${deadPid}.ndjson`);
  writeFileSync(deadFile, serializeEventLogRecord(makeRecord("dead")));

  // A live-pid file (the test process) must NEVER be reaped, even fully
  // drained, because the hook for that pid might still append.
  const liveFile = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(liveFile, serializeEventLogRecord(makeRecord("live")));

  scanEventsLogDir(db, eventsLogDir);

  // Both records ingested.
  const rows = db
    .query("SELECT session_id FROM events ORDER BY session_id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["dead", "live"]);

  // The dead-pid file was reaped (offset at EOF + pid not live); the live-pid
  // file survives.
  expect(existsSync(deadFile)).toBe(false);
  expect(existsSync(liveFile)).toBe(true);

  // The reaped file's offset row was pruned too.
  const deadOff = db
    .query("SELECT offset FROM event_ingest_offsets WHERE path = ?")
    .get(deadFile) as { offset: number } | null;
  expect(deadOff).toBeNull();

  db.close();
});

test("scanEventsLogDir skips a poison line (INSERT-safe) without advancing past it", () => {
  const { db } = openDb(dbPath);
  mkdirSync(eventsLogDir, { recursive: true });

  // A line that parses to a record but whose bindings carry NO recognized
  // events column (degenerate). The ingester consumes it as a no-op line
  // (advances the offset) and folds the valid record after it. This proves a
  // garbage-but-parseable line doesn't wedge the file.
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(
    file,
    `${JSON.stringify({ bindings: { not_a_column: "x" } })}\n` +
      serializeEventLogRecord(makeRecord("aaa")),
  );

  scanEventsLogDir(db, eventsLogDir);

  const rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa"]);

  db.close();
});
