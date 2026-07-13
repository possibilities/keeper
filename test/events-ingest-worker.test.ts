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
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackstopCounters } from "../src/backstop-telemetry";
import type { EventsIngestContext } from "../src/daemon";
import {
  INGEST_EVENTS_COLUMNS,
  recoverOneDeadLetter,
  scanEventsLogDir,
} from "../src/daemon";
import type { EventLogRecord } from "../src/dead-letter";
import { serializeEventLogRecord } from "../src/dead-letter";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let eventsLogDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-events-ingest-test-"));
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
      plan_op: null,
      plan_target: null,
      plan_epic_id: null,
      plan_task_id: null,
      plan_subject_present: null,
      tool_use_id: null,
      config_dir: "/Users/x/.claude",
      bash_mutation_kind: null,
      bash_mutation_targets: null,
      plan_files: null,
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
  const { db } = freshMemDb();
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
  const { db } = freshMemDb();
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
  const { db } = freshMemDb();
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
  const { db } = freshMemDb();
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
  const { db, stmts } = freshMemDb();
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
    $plan_op: bindings.plan_op,
    $plan_target: bindings.plan_target,
    $plan_epic_id: bindings.plan_epic_id,
    $plan_task_id: bindings.plan_task_id,
    $plan_subject_present: bindings.plan_subject_present,
    $tool_use_id: bindings.tool_use_id,
    $config_dir: bindings.config_dir,
    $bash_mutation_kind: bindings.bash_mutation_kind,
    $bash_mutation_targets: bindings.bash_mutation_targets,
    $plan_files: bindings.plan_files,
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
  const { db } = freshMemDb();
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
  const { db } = freshMemDb();
  // Do NOT create eventsLogDir — task .1 ships before the hook flip, so the dir
  // is normally absent.
  expect(() => scanEventsLogDir(db, eventsLogDir)).not.toThrow();
  const count = (
    db.query("SELECT count(*) AS c FROM events").get() as { c: number }
  ).c;
  expect(count).toBe(0);
  db.close();
});

// ---------------------------------------------------------------------------
// fn-762 — poison-line parking + replay column binding.
// ---------------------------------------------------------------------------

/**
 * Build the optional telemetry sink `scanEventsLogDir` threads through so a
 * parked poison line emits an `events-ingest-poison` backstop record. The
 * NDJSON path lands under the per-test tmpdir.
 */
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

test("scanEventsLogDir parks a poison line, advances past it, and ingests the following valid line in the same scan", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const { ctx, backstopLogPath } = makeIngestCtx();

  // valid line, POISON line (garbage JSON), valid line — all newline-terminated.
  const v1 = serializeEventLogRecord(makeRecord("aaa"));
  const poisonLine = `{not valid json at all\n`;
  const v2 = serializeEventLogRecord(makeRecord("bbb"));
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, v1 + poisonLine + v2);

  scanEventsLogDir(db, eventsLogDir, ctx);

  // Both valid lines ingested in the SAME scan — the loop continued past the
  // poison line instead of stopping at it.
  const rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa", "bbb"]);

  // Offset advanced to EOF (every complete line consumed, poison included).
  const offRow = db
    .query("SELECT offset FROM event_ingest_offsets WHERE path = ?")
    .get(file) as { offset: number };
  expect(offRow.offset).toBe(Buffer.byteLength(v1 + poisonLine + v2, "utf8"));

  // The poison line is parked with status='poison' and the deterministic dl_id
  // keyed on (basename, inode, absolute start offset).
  const dl = db
    .query(
      "SELECT dl_id, status, hook_event, session_id, source_file, bindings FROM dead_letters",
    )
    .all() as {
    dl_id: string;
    status: string;
    hook_event: string;
    session_id: string;
    source_file: string;
    bindings: string;
  }[];
  expect(dl.length).toBe(1);
  const row = dl[0];
  if (!row) throw new Error("expected one poison dead_letters row");
  expect(row.status).toBe("poison");
  expect(row.hook_event).toBe("PoisonLine");
  expect(row.session_id).toBe("poison");
  const absStart = Buffer.byteLength(v1, "utf8");
  // dl_id = `poison:<basename>:<inode>:<absStart>`. The inode is runtime-
  // dependent, so assert the prefix (basename) and suffix (absolute start
  // offset) rather than hard-coding the middle.
  expect(row.dl_id.startsWith(`poison:${LIVE_PID}.ndjson:`)).toBe(true);
  expect(row.dl_id.endsWith(`:${absStart}`)).toBe(true);
  // Bindings carry the capped raw + byte span for triage.
  const parsedBindings = JSON.parse(row.bindings) as Record<string, unknown>;
  expect(parsedBindings.start_offset).toBe(absStart);
  expect(typeof parsedBindings.raw).toBe("string");

  // One backstop record emitted post-COMMIT.
  const recs = readBackstopRecords(backstopLogPath);
  const poisonRecs = recs.filter((r) => r.backstop === "events-ingest-poison");
  expect(poisonRecs.length).toBe(1);
  const rec = poisonRecs[0];
  if (!rec) throw new Error("expected one poison backstop record");
  expect(rec.class).toBe("timeout");
  expect(rec.rescued).toBe(true);
  expect((rec.detail as Record<string, string>).dl_id).toBe(row.dl_id);

  db.close();
});

test("scanEventsLogDir drains a multi-poison file: every poison line parked, every valid line ingested, in one scan", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const { ctx, backstopLogPath } = makeIngestCtx();

  const v1 = serializeEventLogRecord(makeRecord("aaa"));
  const v2 = serializeEventLogRecord(makeRecord("bbb"));
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, `garbage-one\n${v1}[1,2,3]\n${v2}also bad\n`);

  scanEventsLogDir(db, eventsLogDir, ctx);

  const rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa", "bbb"]);

  const poisonCount = (
    db
      .query("SELECT count(*) AS c FROM dead_letters WHERE status = 'poison'")
      .get() as { c: number }
  ).c;
  expect(poisonCount).toBe(3);

  // Offset at EOF — the whole file drained in one pass.
  const offRow = db
    .query("SELECT offset FROM event_ingest_offsets WHERE path = ?")
    .get(file) as { offset: number };
  expect(offRow.offset).toBe(
    Buffer.byteLength(`garbage-one\n${v1}[1,2,3]\n${v2}also bad\n`, "utf8"),
  );

  expect(
    readBackstopRecords(backstopLogPath).filter(
      (r) => r.backstop === "events-ingest-poison",
    ).length,
  ).toBe(3);

  db.close();
});

test("scanEventsLogDir advances past a blank line WITHOUT dead-lettering it", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const { ctx, backstopLogPath } = makeIngestCtx();

  const v1 = serializeEventLogRecord(makeRecord("aaa"));
  const v2 = serializeEventLogRecord(makeRecord("bbb"));
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  // A blank line (just "\n") and a whitespace-only line between two valid ones.
  writeFileSync(file, `${v1}\n   \n${v2}`);

  scanEventsLogDir(db, eventsLogDir, ctx);

  const rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa", "bbb"]);

  // No dead-letter rows — blank lines are NOT poison.
  const dlCount = (
    db.query("SELECT count(*) AS c FROM dead_letters").get() as { c: number }
  ).c;
  expect(dlCount).toBe(0);
  // No poison backstop records.
  expect(
    readBackstopRecords(backstopLogPath).filter(
      (r) => r.backstop === "events-ingest-poison",
    ).length,
  ).toBe(0);

  db.close();
});

test("scanEventsLogDir still blocks on a torn (no-newline) trailing garbage line — offset stays put", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const { ctx } = makeIngestCtx();

  const v1 = serializeEventLogRecord(makeRecord("aaa"));
  // Trailing garbage with NO newline — a hook killed mid-write. The poison arm
  // is unreachable for it (no terminator), so it must NOT be dead-lettered and
  // the offset must NOT advance past it.
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, `${v1}{garbage no newline`);

  scanEventsLogDir(db, eventsLogDir, ctx);

  const rows = db
    .query("SELECT session_id FROM events ORDER BY id ASC")
    .all() as { session_id: string }[];
  expect(rows.map((r) => r.session_id)).toEqual(["aaa"]);

  const offRow = db
    .query("SELECT offset FROM event_ingest_offsets WHERE path = ?")
    .get(file) as { offset: number };
  expect(offRow.offset).toBe(Buffer.byteLength(v1, "utf8"));

  // The torn tail is NOT dead-lettered (it could still be completed by a later
  // append).
  const dlCount = (
    db.query("SELECT count(*) AS c FROM dead_letters").get() as { c: number }
  ).c;
  expect(dlCount).toBe(0);

  db.close();
});

test("scanEventsLogDir poison parking is idempotent under re-scan (ON CONFLICT) — no duplicate row, offset stable", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const { ctx } = makeIngestCtx();

  const poisonLine = `nope not json\n`;
  const v1 = serializeEventLogRecord(makeRecord("aaa"));
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, poisonLine + v1);

  scanEventsLogDir(db, eventsLogDir, ctx);
  const firstDl = db.query("SELECT dl_id FROM dead_letters").all() as {
    dl_id: string;
  }[];
  expect(firstDl.length).toBe(1);
  const firstOffset = (
    db
      .query("SELECT offset FROM event_ingest_offsets WHERE path = ?")
      .get(file) as { offset: number }
  ).offset;

  // Simulate a re-scan that re-presents the SAME poison line at the SAME offset
  // (e.g. a crash-before-commit on a real DB): force the offset back to 0 so the
  // poison line is re-read with the identical deterministic dl_id.
  db.query("UPDATE event_ingest_offsets SET offset = 0 WHERE path = ?").run(
    file,
  );
  scanEventsLogDir(db, eventsLogDir, ctx);

  // ON CONFLICT(dl_id) DO NOTHING — still exactly one poison row.
  const secondDl = db.query("SELECT dl_id FROM dead_letters").all() as {
    dl_id: string;
  }[];
  expect(secondDl.length).toBe(1);
  expect(secondDl[0]?.dl_id).toBe(firstDl[0]?.dl_id);

  // Offset re-converges to EOF (the valid line is NOT double-inserted because of
  // its own re-read; here we only assert the offset, the duplicate-event guard
  // is covered by the exactly-once test above).
  const secondOffset = (
    db
      .query("SELECT offset FROM event_ingest_offsets WHERE path = ?")
      .get(file) as { offset: number }
  ).offset;
  expect(secondOffset).toBe(firstOffset);

  db.close();
});

test("scanEventsLogDir parks poison even without a telemetry ctx (backstop emit is optional, parking is not)", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });

  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, `bad line here\n`);

  // No ctx — the dead-letter parking must STILL happen (it needs only `db`).
  scanEventsLogDir(db, eventsLogDir);

  const poisonCount = (
    db
      .query("SELECT count(*) AS c FROM dead_letters WHERE status = 'poison'")
      .get() as { c: number }
  ).c;
  expect(poisonCount).toBe(1);

  db.close();
});

test("recoverOneDeadLetter never recovers a status='poison' row (replay filters on status='waiting')", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const { ctx } = makeIngestCtx();

  // Seed one poison row via the ingester.
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(file, `garbage\n`);
  scanEventsLogDir(db, eventsLogDir, ctx);
  expect(
    (
      db
        .query("SELECT count(*) AS c FROM dead_letters WHERE status = 'poison'")
        .get() as { c: number }
    ).c,
  ).toBe(1);

  // Replay drains only `waiting` rows — a poison-only backlog returns null and
  // touches nothing.
  expect(recoverOneDeadLetter(db)).toBeNull();
  // The poison row is untouched (never flipped to 'recovered', no replay).
  const row = db
    .query("SELECT status, recovered_at FROM dead_letters")
    .get() as { status: string; recovered_at: number | null };
  expect(row.status).toBe("poison");
  expect(row.recovered_at).toBeNull();

  db.close();
});

test("recoverOneDeadLetter binds INGEST_EVENTS_COLUMNS — a replayed row carries the live v48/v51 columns", () => {
  const { db } = freshMemDb();

  // Seed a waiting dead-letter whose bindings include a column the OLD 29-col
  // EVENTS_COLUMNS list omitted (e.g. `background_task_id`, `backend_exec_type`).
  // After fn-762 repointed replay to INGEST_EVENTS_COLUMNS, that column must land.
  const bindings = {
    ts: 1_700_000_000.5,
    session_id: "replay-live-cols",
    hook_event: "PostToolUse",
    event_type: "tool_use",
    background_task_id: "bg-123",
    backend_exec_type: "zellij",
  };
  db.query(
    `INSERT INTO dead_letters
       (dl_id, session_id, hook_event, ts, dl_written_at, pid, bindings, status)
     VALUES ('dl-live', 'replay-live-cols', 'PostToolUse', 1700000000.5,
             1700000000.5, 4242, ?, 'waiting')`,
  ).run(JSON.stringify(bindings));

  const recovered = recoverOneDeadLetter(db);
  expect(recovered).toBe("dl-live");

  const ev = db
    .query(
      "SELECT session_id, background_task_id, backend_exec_type FROM events WHERE session_id = ?",
    )
    .get("replay-live-cols") as {
    session_id: string;
    background_task_id: string | null;
    backend_exec_type: string | null;
  } | null;
  expect(ev).not.toBeNull();
  // The columns the stale EVENTS_COLUMNS would have DROPPED now round-trip.
  expect(ev?.background_task_id).toBe("bg-123");
  expect(ev?.backend_exec_type).toBe("zellij");

  db.close();
});

test("fn-672 LOCKSTEP: INGEST_EVENTS_COLUMNS == live events table columns", () => {
  // The ingester AND dead-letter replay bind INGEST_EVENTS_COLUMNS. If a new
  // column is added to CREATE_EVENTS without a matching entry here, it silently
  // drops from BOTH ingest and replay — this set-equality pins the list to the
  // live migrated schema so that regression fails loud.
  const { db } = freshMemDb();
  let liveCols: Set<string>;
  try {
    const rows = db.prepare("PRAGMA table_info('events')").all() as {
      name: string;
    }[];
    liveCols = new Set(rows.map((r) => r.name).filter((n) => n !== "id"));
  } finally {
    db.close();
  }
  expect([...liveCols].sort()).toEqual([...INGEST_EVENTS_COLUMNS].sort());
});

test("scanEventsLogDir tolerates an empty dir (no .ndjson files)", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  expect(() => scanEventsLogDir(db, eventsLogDir)).not.toThrow();
  expect(
    (db.query("SELECT count(*) AS c FROM events").get() as { c: number }).c,
  ).toBe(0);
  db.close();
});

test("scanEventsLogDir ignores non-ndjson files in the dir", () => {
  const { db } = freshMemDb();
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
  const { db } = freshMemDb();
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
  const { db } = freshMemDb();
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

// ---------------------------------------------------------------------------
// fn-742 — a many-file concurrent-writers drain: scanEventsLogDir stays
// exactly-once when many per-pid files land in one scan.
// ---------------------------------------------------------------------------

test("fn-742 load: scanEventsLogDir drains many concurrent per-pid files exactly-once", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });

  // Intentionally minimal: multiple concurrent files matter, not row count.
  const N_FILES = 3;
  const LINES_PER = 2;
  for (let i = 0; i < N_FILES; i++) {
    // Distinct, almost-certainly-dead pids — one writer per file, the shape the
    // hook produces under concurrency (APFS O_APPEND non-interleave per file).
    const pid = 900_000 + i;
    const recs = [];
    for (let j = 0; j < LINES_PER; j++) {
      recs.push(makeRecord(`load-${i}-${j}`, "PreToolUse"));
    }
    writeFileSync(
      join(eventsLogDir, `${pid}.ndjson`),
      recs.map(serializeEventLogRecord).join(""),
    );
  }

  scanEventsLogDir(db, eventsLogDir);

  const total = (
    db.query("SELECT count(*) AS c FROM events").get() as { c: number }
  ).c;
  const distinct = (
    db.query("SELECT count(DISTINCT session_id) AS c FROM events").get() as {
      c: number;
    }
  ).c;
  // Every line landed, exactly once (no drop, no dup) in a single scan pass.
  expect(total).toBe(N_FILES * LINES_PER);
  expect(distinct).toBe(N_FILES * LINES_PER);

  // A redundant scan (the periodic fallback timer firing again) lands NO new
  // rows — idempotent under re-scan regardless of dead-pid file reaping.
  scanEventsLogDir(db, eventsLogDir);
  const total2 = (
    db.query("SELECT count(*) AS c FROM events").get() as { c: number }
  ).c;
  expect(total2).toBe(N_FILES * LINES_PER);

  db.close();
});

/**
 * Build a PostToolUse:Write events-log record. `withMutationPath` controls
 * whether the binding is present (a forward, post-deriver hook line) or absent
 * (a pre-deriver hook line the ingester must recompute). `filePath` rides
 * `data.tool_input.file_path`; passing `null` for it omits a valid path so the
 * recompute folds to NULL.
 */
function makeWriteRecord(
  sessionId: string,
  opts: {
    withMutationPath?: boolean;
    filePath?: string | null;
  } = {},
): EventLogRecord {
  const filePath =
    opts.filePath === undefined ? "/repo/src/x.ts" : opts.filePath;
  const toolInput = filePath === null ? {} : { file_path: filePath };
  const data = JSON.stringify({ tool_input: toolInput });
  const bindings: EventLogRecord["bindings"] = {
    ts: 1_700_000_001.5,
    session_id: sessionId,
    pid: 4242,
    hook_event: "PostToolUse",
    event_type: "tool",
    tool_name: "Write",
    matcher: null,
    cwd: "/repo",
    permission_mode: "default",
    agent_id: null,
    agent_type: null,
    stop_hook_active: false,
    data,
    subagent_agent_id: null,
    spawn_name: null,
    start_time: null,
    slash_command: null,
    skill_name: null,
    plan_op: null,
    plan_target: null,
    plan_epic_id: null,
    plan_task_id: null,
    plan_subject_present: null,
    tool_use_id: null,
    config_dir: null,
    bash_mutation_kind: null,
    bash_mutation_targets: null,
    plan_files: null,
    backend_exec_type: null,
    backend_exec_session_id: null,
    backend_exec_pane_id: null,
    background_task_id: null,
  };
  if (opts.withMutationPath) {
    bindings.mutation_path = filePath;
  }
  return { bindings };
}

function readMutationPath(
  db: ReturnType<typeof freshMemDb>["db"],
  sessionId: string,
): string | null {
  const row = db
    .query("SELECT mutation_path FROM events WHERE session_id = ?")
    .get(sessionId) as { mutation_path: string | null } | null;
  if (row === null) throw new Error(`no events row for ${sessionId}`);
  return row.mutation_path;
}

test("scanEventsLogDir: a forward line's hook-derived mutation_path lands verbatim", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  writeFileSync(
    file,
    serializeEventLogRecord(
      makeWriteRecord("fwd", {
        withMutationPath: true,
        filePath: "/repo/src/a.ts",
      }),
    ),
  );

  scanEventsLogDir(db, eventsLogDir);

  expect(readMutationPath(db, "fwd")).toBe("/repo/src/a.ts");
  db.close();
});

test("scanEventsLogDir: a pre-deriver line lacking mutation_path is RECOMPUTED at the ingest seam", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  // No `mutation_path` binding — the sole-writer ingester must derive it from
  // the line's hook_event/tool_name/data via the same pure deriver the hook runs.
  writeFileSync(
    file,
    serializeEventLogRecord(
      makeWriteRecord("recompute", { filePath: "/repo/src/b.ts" }),
    ),
  );

  scanEventsLogDir(db, eventsLogDir);

  expect(readMutationPath(db, "recompute")).toBe("/repo/src/b.ts");
  db.close();
});

test("scanEventsLogDir: a pre-deriver line with a path-less payload recomputes to NULL (no throw)", () => {
  const { db } = freshMemDb();
  mkdirSync(eventsLogDir, { recursive: true });
  const file = join(eventsLogDir, `${LIVE_PID}.ndjson`);
  // A pre-deriver PostToolUse:Write line whose tool_input carries no file_path:
  // the recompute folds to NULL (the deriver's zero-event value) and the row
  // still lands. (A line with structurally-malformed `data` can never be a
  // Write/Edit row — the pre-existing idx_events_tool_attr expression index
  // rejects it at INSERT — so the deriver's never-throw-on-garbage contract is
  // unit-tested in derivers.test.ts, not exercised through the full INSERT here.)
  writeFileSync(
    file,
    serializeEventLogRecord(makeWriteRecord("nopath", { filePath: null })),
  );

  expect(() => scanEventsLogDir(db, eventsLogDir)).not.toThrow();

  expect(readMutationPath(db, "nopath")).toBeNull();
  db.close();
});
