/**
 * Tests for the dead-letter import path (fn-643 task .3). Drives
 * `scanDeadLetterDir` directly against a tmp DB + tmp NDJSON tree — no
 * Worker spawned. The worker thread itself just posts contentless
 * notifications (covered by the full daemon integration test); these tests
 * focus on the main-side import contract: idempotent INSERT OR IGNORE,
 * partial-line tolerance, missing-dir tolerance, never-throw discipline.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDeadLetterDir } from "../src/daemon";
import type { DeadLetterRecord } from "../src/dead-letter";
import { serializeDeadLetterRecord } from "../src/dead-letter";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let deadLetterDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-dead-letter-import-test-"));
  deadLetterDir = join(tmpDir, "dead-letters");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeRecord(
  dlId: string,
  hookEvent = "SessionStart",
): DeadLetterRecord {
  return {
    dl_id: dlId,
    session_id: `sess-${dlId}`,
    hook_event: hookEvent,
    ts: 1_700_000_000.5,
    dl_written_at: 1_700_000_001.0,
    pid: 12345,
    bindings: {
      session_id: `sess-${dlId}`,
      hook_event: hookEvent,
      ts: 1_700_000_000.5,
    },
  };
}

test("scanDeadLetterDir imports each NDJSON line as a `waiting` row", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  const records = [makeRecord("aaa"), makeRecord("bbb"), makeRecord("ccc")];
  const file = join(deadLetterDir, "12345.ndjson");
  writeFileSync(file, records.map(serializeDeadLetterRecord).join(""));

  scanDeadLetterDir(db, deadLetterDir);

  const rows = db
    .query(
      "SELECT dl_id, status, source_file, session_id, hook_event, ts, dl_written_at, pid FROM dead_letters ORDER BY dl_id ASC",
    )
    .all() as {
    dl_id: string;
    status: string;
    source_file: string;
    session_id: string;
    hook_event: string;
    ts: number;
    dl_written_at: number;
    pid: number | null;
  }[];

  expect(rows.length).toBe(3);
  expect(rows.map((r) => r.dl_id)).toEqual(["aaa", "bbb", "ccc"]);
  for (const row of rows) {
    expect(row.status).toBe("waiting");
    expect(row.source_file).toBe(file);
    expect(row.session_id).toBe(`sess-${row.dl_id}`);
    expect(row.hook_event).toBe("SessionStart");
    expect(row.ts).toBe(1_700_000_000.5);
    expect(row.dl_written_at).toBe(1_700_000_001.0);
    expect(row.pid).toBe(12345);
  }

  db.close();
});

test("scanDeadLetterDir skips a truncated trailing line", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  const valid = [makeRecord("aaa"), makeRecord("bbb")];
  const validLines = valid.map(serializeDeadLetterRecord).join("");
  // Append a partial JSON line (no closing brace, no newline) — simulates a
  // hook process killed mid-write.
  const truncated = `${validLines}{"dl_id":"ccc","sess`;
  const file = join(deadLetterDir, "12345.ndjson");
  writeFileSync(file, truncated);

  scanDeadLetterDir(db, deadLetterDir);

  const rows = db
    .query("SELECT dl_id FROM dead_letters ORDER BY dl_id ASC")
    .all() as { dl_id: string }[];

  // The two valid records imported; the truncated tail was skipped.
  expect(rows.map((r) => r.dl_id)).toEqual(["aaa", "bbb"]);

  db.close();
});

test("scanDeadLetterDir is idempotent — a re-scan adds nothing", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  const records = [makeRecord("aaa"), makeRecord("bbb")];
  const file = join(deadLetterDir, "12345.ndjson");
  writeFileSync(file, records.map(serializeDeadLetterRecord).join(""));

  scanDeadLetterDir(db, deadLetterDir);
  const firstCount = (
    db.query("SELECT count(*) AS c FROM dead_letters").get() as { c: number }
  ).c;
  expect(firstCount).toBe(2);

  // Re-scan: INSERT OR IGNORE on the dl_id PK collapses both duplicates.
  scanDeadLetterDir(db, deadLetterDir);
  const secondCount = (
    db.query("SELECT count(*) AS c FROM dead_letters").get() as { c: number }
  ).c;
  expect(secondCount).toBe(2);

  db.close();
});

test("scanDeadLetterDir picks up a new record appended to an existing file", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  const file = join(deadLetterDir, "12345.ndjson");
  writeFileSync(file, serializeDeadLetterRecord(makeRecord("aaa")));
  scanDeadLetterDir(db, deadLetterDir);
  expect(
    (db.query("SELECT count(*) AS c FROM dead_letters").get() as { c: number })
      .c,
  ).toBe(1);

  // Append a new record (the hook's append-only NDJSON growth pattern).
  writeFileSync(
    file,
    serializeDeadLetterRecord(makeRecord("aaa")) +
      serializeDeadLetterRecord(makeRecord("bbb")),
  );
  scanDeadLetterDir(db, deadLetterDir);

  const rows = db
    .query("SELECT dl_id FROM dead_letters ORDER BY dl_id ASC")
    .all() as { dl_id: string }[];
  expect(rows.map((r) => r.dl_id)).toEqual(["aaa", "bbb"]);

  db.close();
});

test("scanDeadLetterDir reads multiple per-pid files in one pass", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  writeFileSync(
    join(deadLetterDir, "12345.ndjson"),
    serializeDeadLetterRecord(makeRecord("aaa")),
  );
  writeFileSync(
    join(deadLetterDir, "67890.ndjson"),
    serializeDeadLetterRecord(makeRecord("bbb")),
  );

  scanDeadLetterDir(db, deadLetterDir);

  const rows = db
    .query("SELECT dl_id FROM dead_letters ORDER BY dl_id ASC")
    .all() as { dl_id: string }[];
  expect(rows.map((r) => r.dl_id)).toEqual(["aaa", "bbb"]);

  db.close();
});

test("scanDeadLetterDir ignores non-ndjson files in the dir", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  // A stray file that does NOT match the per-pid `<pid>.ndjson` shape (e.g.
  // an editor backup or a future tool dropping logs alongside) must be
  // ignored entirely — even though parseDeadLetterLine would reject its
  // contents, opening it at all costs an unnecessary stat+read.
  writeFileSync(join(deadLetterDir, "notes.txt"), "this is not ndjson");
  writeFileSync(
    join(deadLetterDir, "12345.ndjson"),
    serializeDeadLetterRecord(makeRecord("aaa")),
  );

  scanDeadLetterDir(db, deadLetterDir);

  const rows = db
    .query("SELECT dl_id FROM dead_letters ORDER BY dl_id ASC")
    .all() as { dl_id: string }[];
  expect(rows.map((r) => r.dl_id)).toEqual(["aaa"]);

  db.close();
});

test("scanDeadLetterDir tolerates a missing dir (fresh machine)", () => {
  const { db } = freshMemDb();
  // Do NOT create deadLetterDir — simulating a fresh machine where the hook
  // has never hit a drop.

  // Must NOT throw. Must be a no-op (no rows inserted).
  expect(() => scanDeadLetterDir(db, deadLetterDir)).not.toThrow();
  const count = (
    db.query("SELECT count(*) AS c FROM dead_letters").get() as { c: number }
  ).c;
  expect(count).toBe(0);

  db.close();
});

test("scanDeadLetterDir skips a malformed-JSON line and imports the rest", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  // Mix valid records around a malformed line (bad JSON, missing braces). The
  // scan should import the valid records on either side and skip the bad
  // line silently.
  const content =
    serializeDeadLetterRecord(makeRecord("aaa")) +
    "this is not json\n" +
    serializeDeadLetterRecord(makeRecord("bbb"));
  writeFileSync(join(deadLetterDir, "12345.ndjson"), content);

  scanDeadLetterDir(db, deadLetterDir);

  const rows = db
    .query("SELECT dl_id FROM dead_letters ORDER BY dl_id ASC")
    .all() as { dl_id: string }[];
  expect(rows.map((r) => r.dl_id)).toEqual(["aaa", "bbb"]);

  db.close();
});

test("scanDeadLetterDir preserves a null pid", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  const record: DeadLetterRecord = { ...makeRecord("aaa"), pid: null };
  writeFileSync(
    join(deadLetterDir, "0.ndjson"),
    serializeDeadLetterRecord(record),
  );

  scanDeadLetterDir(db, deadLetterDir);

  const row = db
    .query("SELECT pid FROM dead_letters WHERE dl_id = 'aaa'")
    .get() as { pid: number | null };
  expect(row.pid).toBeNull();

  db.close();
});

test("scanDeadLetterDir round-trips bindings as JSON-TEXT", () => {
  const { db } = freshMemDb();
  mkdirSync(deadLetterDir, { recursive: true });

  const record: DeadLetterRecord = {
    ...makeRecord("aaa"),
    bindings: {
      session_id: "sess-aaa",
      hook_event: "SessionStart",
      ts: 1_700_000_000.5,
      stop_hook_active: false,
      spawn_name: "work:worker",
      config_dir: null,
    },
  };
  writeFileSync(
    join(deadLetterDir, "12345.ndjson"),
    serializeDeadLetterRecord(record),
  );

  scanDeadLetterDir(db, deadLetterDir);

  const row = db
    .query("SELECT bindings FROM dead_letters WHERE dl_id = 'aaa'")
    .get() as { bindings: string };
  const parsed = JSON.parse(row.bindings);
  expect(parsed).toEqual(record.bindings);

  db.close();
});
