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
