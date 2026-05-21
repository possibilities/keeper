/**
 * Reducer tests. Each test opens a fresh writer DB on a tmp path, seeds raw
 * `events` rows, then drives the reducer and asserts the `jobs` projection +
 * cursor. The assertions mirror the task Acceptance list:
 * - one transaction per fold with cursor advance,
 * - drain() batching + idempotency on re-run,
 * - all four lifecycle transitions + sticky-`ended`,
 * - title updates from session_title on any event,
 * - unknown/no-op event types advance the cursor without touching jobs,
 * - malformed data blob logs to stderr and advances the cursor (no halt),
 * - crash-mid-fold rolls back BOTH the jobs write and the cursor advance.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import { applyEvent, DEFAULT_BATCH_SIZE, drain } from "../src/reducer";
import type { Event } from "../src/types";

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-reducer-test-"));
  dbPath = join(tmpDir, "keeper.db");
  db = openDb(dbPath).db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tsCounter = 1_000;

/**
 * Insert one raw event row, mirroring what the hook writes. Returns the
 * auto-assigned event id. `overrides` set any non-default column; ts auto-
 * increments so ordering is stable.
 */
function insertEvent(
  overrides: Partial<Event> & { hook_event: string },
): number {
  const ts = overrides.ts ?? tsCounter++;
  const row = {
    ts,
    session_id: overrides.session_id ?? "sess-a",
    pid: overrides.pid ?? 4242,
    hook_event: overrides.hook_event,
    event_type: overrides.event_type ?? overrides.hook_event,
    tool_name: overrides.tool_name ?? null,
    matcher: overrides.matcher ?? null,
    cwd: overrides.cwd ?? "/tmp/work",
    permission_mode: overrides.permission_mode ?? null,
    agent_id: overrides.agent_id ?? null,
    agent_type: overrides.agent_type ?? null,
    stop_hook_active: overrides.stop_hook_active ?? null,
    data: overrides.data ?? "{}",
    subagent_agent_id: overrides.subagent_agent_id ?? null,
    spawn_name: overrides.spawn_name ?? null,
  };
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.ts,
      row.session_id,
      row.pid,
      row.hook_event,
      row.event_type,
      row.tool_name,
      row.matcher,
      row.cwd,
      row.permission_mode,
      row.agent_id,
      row.agent_type,
      row.stop_hook_active,
      row.data,
      row.subagent_agent_id,
      row.spawn_name,
    ],
  );
  const { id } = db.query("SELECT last_insert_rowid() AS id").get() as {
    id: number;
  };
  return id;
}

function getJob(jobId = "sess-a") {
  return db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as {
    job_id: string;
    created_at: number;
    cwd: string | null;
    pid: number | null;
    state: string;
    last_event_id: number;
    updated_at: number;
    title: string | null;
    title_source: string | null;
  } | null;
}

function getCursor(): number {
  const row = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  return row.last_event_id;
}

function drainAll(): number {
  let total = 0;
  let n: number;
  do {
    n = drain(db);
    total += n;
  } while (n > 0);
  return total;
}

// ---------------------------------------------------------------------------
// Per-transition tests (one per row in the state-machine table)
// ---------------------------------------------------------------------------

test("SessionStart inserts a job with default state", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job).not.toBeNull();
  expect(job?.state).toBe("stopped");
  expect(job?.cwd).toBe("/tmp/work");
  expect(job?.pid).toBe(4242);
});

test("UserPromptSubmit moves state to working", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("Stop moves state to stopped", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("SessionEnd moves state to ended", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("no-op event types advance cursor without touching jobs", () => {
  insertEvent({ hook_event: "SessionStart" });
  const ptId = insertEvent({ hook_event: "PreToolUse", tool_name: "Bash" });
  insertEvent({ hook_event: "PostToolUse", tool_name: "Bash" });
  const lastId = insertEvent({ hook_event: "SubagentStop" });
  drainAll();
  // jobs row stays at the SessionStart projection — state untouched.
  expect(getJob()?.state).toBe("stopped");
  // cursor walked past every no-op row.
  expect(getCursor()).toBe(lastId);
  expect(getCursor()).toBeGreaterThan(ptId);
});

test("unknown forward-compat event type advances cursor, no jobs write", () => {
  insertEvent({ hook_event: "SessionStart" });
  const lastId = insertEvent({ hook_event: "SomeFutureEvent2030" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getCursor()).toBe(lastId);
});

// ---------------------------------------------------------------------------
// Sticky-ended
// ---------------------------------------------------------------------------

test("ended is sticky: UserPromptSubmit after SessionEnd is a no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("ended is sticky: Stop after SessionEnd is a no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("SessionEnd re-asserts ended idempotently", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("terminal event without prior SessionStart creates no row, advances cursor", () => {
  const id = insertEvent({ hook_event: "SessionEnd", session_id: "ghost" });
  drainAll();
  expect(getJob("ghost")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("duplicate SessionStart for same session_id is a no-op", () => {
  insertEvent({ hook_event: "SessionStart", cwd: "/first" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  // Second SessionStart must NOT clobber the working state via INSERT OR IGNORE.
  insertEvent({ hook_event: "SessionStart", cwd: "/second" });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.cwd).toBe("/first");
});

test("malformed data blob logs to stderr and advances cursor without halting", () => {
  insertEvent({ hook_event: "SessionStart" });
  // A non-JSON data blob hits the title rule's JSON.parse; it must be caught +
  // logged, not thrown.
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const badId = insertEvent({
      hook_event: "Notification",
      data: "{not valid json",
    });
    insertEvent({ hook_event: "UserPromptSubmit" });
    drainAll();
    // reducer did not halt — the later event still folded.
    expect(getJob()?.state).toBe("working");
    expect(getCursor()).toBeGreaterThan(badId);
    expect(errors.some((e) => e.includes("failed to parse data blob"))).toBe(
      true,
    );
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------------------
// Title fold (session_title → title)
// ---------------------------------------------------------------------------

/** A UserPromptSubmit carrying a session_title in its data blob. */
function titleEvent(title: string, session_id = "sess-a"): number {
  return insertEvent({
    hook_event: "UserPromptSubmit",
    session_id,
    data: JSON.stringify({ session_title: title }),
  });
}

test("first session_title seeds title", () => {
  insertEvent({ hook_event: "SessionStart" });
  titleEvent("foo");
  drainAll();
  expect(getJob()?.title).toBe("foo");
});

test("title follows the latest session_title (last-write-wins)", () => {
  insertEvent({ hook_event: "SessionStart" });
  titleEvent("foo");
  titleEvent("bar");
  titleEvent("foo"); // revert — title just follows the latest value
  drainAll();
  expect(getJob()?.title).toBe("foo");
});

test("unchanged title fires no write (last_event_id unchanged by the title rule)", () => {
  insertEvent({ hook_event: "SessionStart" });
  // Carry the title on a non-lifecycle event so ONLY the title rule could write
  // (a UserPromptSubmit would bump last_event_id via its own state-rule).
  insertEvent({
    hook_event: "Notification",
    data: JSON.stringify({ session_title: "foo" }),
  });
  drainAll();
  const afterFirst = getJob();
  const lastId = afterFirst?.last_event_id ?? 0;

  // A second identical title on another non-lifecycle event — the title rule
  // must skip the write (no last_event_id bump).
  const repeatId = insertEvent({
    hook_event: "Notification",
    data: JSON.stringify({ session_title: "foo" }),
  });
  drainAll();
  const afterRepeat = getJob();
  expect(afterRepeat?.last_event_id).toBe(lastId);
  expect(afterRepeat?.last_event_id).toBeLessThan(repeatId);
  expect(afterRepeat?.title).toBe("foo");
  // The cursor still advanced past the no-op title event.
  expect(getCursor()).toBe(repeatId);
});

test("title-bearing event for a non-existent job is a no-op", () => {
  // No SessionStart for "ghost" — the title rule's SELECT finds no row.
  const id = titleEvent("foo", "ghost");
  drainAll();
  expect(getJob("ghost")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("malformed data blob with a session_title still skip-and-logs and advances", () => {
  insertEvent({ hook_event: "SessionStart" });
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const badId = insertEvent({
      hook_event: "UserPromptSubmit",
      data: '{"session_title": "foo"', // truncated — invalid JSON
    });
    drainAll();
    // No title written (the parse failed) but the cursor advanced.
    expect(getJob()?.title).toBeNull();
    expect(getCursor()).toBe(badId);
    expect(errors.some((e) => e.includes("failed to parse data blob"))).toBe(
      true,
    );
  } finally {
    console.error = originalError;
  }
});

test("title fold re-folds idempotently: draining from scratch yields identical title", () => {
  insertEvent({ hook_event: "SessionStart" });
  titleEvent("foo");
  titleEvent("bar");
  titleEvent("foo");
  drainAll();
  expect(getJob()?.title).toBe("foo");

  // Rewind the cursor and projection, then re-fold the SAME event stream from
  // scratch — the persisted-title comparison must reproduce the identical title.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  expect(getJob()?.title).toBe("foo");
});

// ---------------------------------------------------------------------------
// Title provenance / precedence (spawn_name seed + {spawn:1, payload:2})
// ---------------------------------------------------------------------------

test("SessionStart with spawn_name seeds title + title_source='spawn'", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "fix-osc" });
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("fix-osc");
  expect(job?.title_source).toBe("spawn");
});

test("SessionStart without spawn_name leaves title NULL / title_source NULL", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job?.title).toBeNull();
  expect(job?.title_source).toBeNull();
  // Tier 0 still folds: a later payload title seeds at first UserPromptSubmit.
  titleEvent("from-payload");
  drainAll();
  const after = getJob();
  expect(after?.title).toBe("from-payload");
  expect(after?.title_source).toBe("payload");
});

test("payload title promotes a spawn-seeded title even when the value is identical", () => {
  // spawn (priority 1) seeds; a payload (priority 2) whose value EQUALS the
  // spawn name must still write — the priority rose (p > pp), proving the
  // promotion path independent of value change.
  insertEvent({ hook_event: "SessionStart", spawn_name: "same-name" });
  drainAll();
  expect(getJob()?.title_source).toBe("spawn");
  titleEvent("same-name");
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("same-name");
  expect(job?.title_source).toBe("payload");
});

test("payload title with a different value updates both value and source", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "spawn-name" });
  drainAll();
  titleEvent("payload-name");
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("payload-name");
  expect(job?.title_source).toBe("payload");
});

test("a spawn-priority source never overwrites a payload title (monotonicity)", () => {
  // Establish a payload title (priority 2), then fire a DUPLICATE SessionStart
  // carrying a spawn_name (priority 1). The INSERT OR IGNORE no-ops on the
  // existing row, so the lower-priority spawn name can't clobber the payload.
  insertEvent({ hook_event: "SessionStart", spawn_name: "spawn-name" });
  titleEvent("payload-name");
  drainAll();
  expect(getJob()?.title).toBe("payload-name");
  expect(getJob()?.title_source).toBe("payload");

  insertEvent({ hook_event: "SessionStart", spawn_name: "other-spawn" });
  drainAll();
  // Unchanged: spawn (1) cannot beat payload (2).
  expect(getJob()?.title).toBe("payload-name");
  expect(getJob()?.title_source).toBe("payload");
});

test("precedence re-folds idempotently: rebuild-from-scratch yields identical (title, source)", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "seed" });
  titleEvent("first");
  titleEvent("second");
  drainAll();
  const before = getJob();
  expect(before?.title).toBe("second");
  expect(before?.title_source).toBe("payload");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after?.title).toBe("second");
  expect(after?.title_source).toBe("payload");
});

// ---------------------------------------------------------------------------
// Cursor / transaction invariants
// ---------------------------------------------------------------------------

test("applyEvent advances the cursor to the event id in one transaction", () => {
  const id = insertEvent({ hook_event: "SessionStart" });
  const event = db.query("SELECT * FROM events WHERE id = ?").get(id) as Event;
  applyEvent(db, event);
  expect(getCursor()).toBe(id);
  expect(getJob()?.last_event_id).toBe(id);
});

test("crash mid-fold rolls back BOTH the jobs write and the cursor advance", () => {
  const startId = insertEvent({ hook_event: "SessionStart" });
  drainAll();
  expect(getCursor()).toBe(startId);

  const upsId = insertEvent({ hook_event: "UserPromptSubmit" });
  const event = db
    .query("SELECT * FROM events WHERE id = ?")
    .get(upsId) as Event;

  // Inject a throw AFTER the jobs write but BEFORE the cursor advance.
  expect(() => {
    applyEvent(db, event, {
      onBeforeCursorAdvance: () => {
        throw new Error("simulated crash mid-fold");
      },
    });
  }).toThrow("simulated crash mid-fold");

  // Whole transaction rolled back: state never flipped to working...
  expect(getJob()?.state).toBe("stopped");
  // ...and the cursor never advanced past the SessionStart.
  expect(getCursor()).toBe(startId);

  // Re-folding (boot drain) converges idempotently.
  drainAll();
  expect(getJob()?.state).toBe("working");
  expect(getCursor()).toBe(upsId);
});

// ---------------------------------------------------------------------------
// drain() batching + idempotency
// ---------------------------------------------------------------------------

test("drain consumes events id > cursor in batches and returns count", () => {
  insertEvent({ hook_event: "SessionStart" });
  for (let i = 0; i < 5; i++) {
    insertEvent({ hook_event: "PreToolUse", tool_name: "Bash" });
  }
  const lastId = insertEvent({ hook_event: "Stop" });

  // 7 events total (1 + 5 + 1). batchSize 3 -> 3, 3, 1, 0.
  expect(drain(db, 3)).toBe(3);
  expect(drain(db, 3)).toBe(3);
  expect(drain(db, 3)).toBe(1);
  expect(drain(db, 3)).toBe(0);
  expect(getCursor()).toBe(lastId);
});

test("drain default batch size is exported and used", () => {
  expect(DEFAULT_BATCH_SIZE).toBe(200);
  insertEvent({ hook_event: "SessionStart" });
  expect(drain(db)).toBe(1);
  expect(drain(db)).toBe(0);
});

test("drain returns 0 when caught up (no new event rows)", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  // A spurious data_version bump with no new rows: drain is a clean no-op.
  expect(drain(db)).toBe(0);
});

test("re-draining after full consumption is idempotent", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();

  const job1 = getJob();
  const cursor1 = getCursor();

  // Drain again: no new events, projection + cursor unchanged.
  const again = drainAll();
  expect(again).toBe(0);

  const job2 = getJob();
  expect(job2).toEqual(job1);
  expect(getCursor()).toBe(cursor1);
});

test("full lifecycle folds to ended", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", permission_mode: "plan" });
  insertEvent({ hook_event: "PreToolUse", tool_name: "Read" });
  insertEvent({ hook_event: "Stop", permission_mode: "acceptEdits" });
  const endId = insertEvent({ hook_event: "SessionEnd" });
  drainAll();

  const job = getJob();
  expect(job?.state).toBe("ended");
  expect(getCursor()).toBe(endId);
});
