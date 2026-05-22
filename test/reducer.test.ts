/**
 * Reducer tests. Each test opens a fresh writer DB on a tmp path, seeds raw
 * `events` rows, then drives the reducer and asserts the `jobs` projection +
 * cursor. The assertions mirror the task Acceptance list:
 * - one transaction per fold with cursor advance,
 * - drain() batching + idempotency on re-run,
 * - all four lifecycle transitions + ended-as-resting-state / resume re-open,
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
// Ended-as-resting-state + resume re-open
// ---------------------------------------------------------------------------

test("UserPromptSubmit after SessionEnd re-opens the job to working", () => {
  // A prompt straight after an end (resume into a prompt with no SessionStart,
  // or a spurious mid-session SessionEnd) means the session is alive again.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("Stop after SessionEnd stays ended (no stray resurrection)", () => {
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

test("SessionStart re-opens an ended job (resume): ended -> stopped, pid refreshed", () => {
  // A full lifecycle ending in SessionEnd, then a fresh `claude --resume`
  // process fires SessionStart (new pid) with NO further interaction.
  insertEvent({ hook_event: "SessionStart", pid: 1000, spawn_name: "my-job" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  const ended = getJob();
  expect(ended?.state).toBe("ended");
  const createdAt = ended?.created_at;

  // Resume: a second SessionStart for the same session_id, new process pid.
  insertEvent({ hook_event: "SessionStart", pid: 2000, spawn_name: "my-job" });
  drainAll();
  const reopened = getJob();
  // Re-opened to the zero-event resting state (a later prompt flips to working).
  expect(reopened?.state).toBe("stopped");
  // New OS process: pid refreshed off the resume event.
  expect(reopened?.pid).toBe(2000);
  // Identity preserved: created_at unchanged, spawn title not re-seeded/clobbered.
  expect(reopened?.created_at).toBe(createdAt);
  expect(reopened?.title).toBe("my-job");
  expect(reopened?.title_source).toBe("spawn");
});

test("SessionStart on a stopped (non-ended) job leaves state stopped", () => {
  // The CASE only re-opens 'ended'; a resume/compact SessionStart on a stopped
  // row is a state no-op (it still bumps pid/last_event_id).
  insertEvent({ hook_event: "SessionStart", pid: 1000 });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  insertEvent({ hook_event: "SessionStart", pid: 2000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.pid).toBe(2000);
});

test("resume re-open re-folds idempotently: rebuild-from-scratch yields stopped", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000 });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({ hook_event: "SessionStart", pid: 2000 }); // resume
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.pid).toBe(2000);

  // The re-open is driven by the event log, not a direct jobs write, so a
  // rewind-and-redrain must reproduce the identical final (state, pid).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.pid).toBe(2000);
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

test("duplicate SessionStart on a live job leaves state + cwd untouched", () => {
  insertEvent({ hook_event: "SessionStart", cwd: "/first" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  // A duplicate SessionStart (compact/clear) on a NON-ended job: the upsert's
  // CASE leaves a working state as-is, and cwd is set-once identity (not in the
  // ON CONFLICT SET), so neither moves.
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

/**
 * A synthetic TranscriptTitle event (priority-3 'transcript' source). Mirrors
 * what keeperd's main thread inserts when the watcher sees a `custom-title`
 * line — title carried in `data.session_title`, same field as `titleEvent`.
 */
function transcriptTitleEvent(title: string, session_id = "sess-a"): number {
  return insertEvent({
    hook_event: "TranscriptTitle",
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
  // carrying a spawn_name (priority 1). The resume upsert never touches
  // title/title_source, so the lower-priority spawn name can't clobber payload.
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
// Transcript title source (priority 3) + transcript_path seed
// ---------------------------------------------------------------------------

test("TranscriptTitle folds at priority 3, beating payload and spawn", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "spawn-name" });
  titleEvent("payload-name");
  transcriptTitleEvent("transcript-name");
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("transcript-name");
  expect(job?.title_source).toBe("transcript");
  // The TranscriptTitle event triggers no lifecycle write — state stays at the
  // last lifecycle event (UserPromptSubmit → working).
  expect(job?.state).toBe("working");
});

test("a later payload title does NOT clobber a transcript title", () => {
  insertEvent({ hook_event: "SessionStart" });
  transcriptTitleEvent("transcript-name");
  drainAll();
  expect(getJob()?.title_source).toBe("transcript");
  // A payload (priority 2) arriving AFTER the transcript title (priority 3)
  // with a DIFFERENT value must not write — the persisted source outranks it.
  titleEvent("stale-payload");
  drainAll();
  const job = getJob();
  expect(job?.title).toBe("transcript-name");
  expect(job?.title_source).toBe("transcript");
});

test("transcript re-folds idempotently with synthetic + lifecycle events interleaved", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "seed" });
  titleEvent("from-prompt");
  transcriptTitleEvent("from-transcript");
  insertEvent({ hook_event: "Stop" });
  drainAll();
  const before = getJob();
  expect(before?.title).toBe("from-transcript");
  expect(before?.title_source).toBe("transcript");
  expect(before?.state).toBe("stopped");

  // Rewind + rebuild from scratch — the title MUST come from the event log, not
  // a direct jobs write, so the rebuild reproduces identical (title, source).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after?.title).toBe("from-transcript");
  expect(after?.title_source).toBe("transcript");
  expect(after?.state).toBe("stopped");
});

function getTranscriptPath(jobId = "sess-a"): string | null {
  const row = db
    .query("SELECT transcript_path FROM jobs WHERE job_id = ?")
    .get(jobId) as { transcript_path: string | null } | null;
  return row?.transcript_path ?? null;
}

test("SessionStart seeds transcript_path from event.data", () => {
  insertEvent({
    hook_event: "SessionStart",
    data: JSON.stringify({
      transcript_path: "/home/u/.claude/projects/x.jsonl",
    }),
  });
  drainAll();
  expect(getTranscriptPath()).toBe("/home/u/.claude/projects/x.jsonl");
});

test("SessionStart with no transcript_path leaves it NULL", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  expect(getTranscriptPath()).toBeNull();
});

test("SessionStart with malformed data blob leaves transcript_path NULL without throwing", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    insertEvent({ hook_event: "SessionStart", data: "{not valid json" });
    drainAll();
    expect(getTranscriptPath()).toBeNull();
    // Row still inserted; reducer did not halt.
    expect(getJob()?.state).toBe("stopped");
    expect(errors.some((e) => e.includes("failed to parse data blob"))).toBe(
      true,
    );
  } finally {
    console.error = originalError;
  }
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

// ---------------------------------------------------------------------------
// Plan fold (EpicSnapshot / TaskSnapshot → epics / tasks)
// ---------------------------------------------------------------------------

/**
 * Insert a synthetic EpicSnapshot event. The entity id rides in `session_id`
 * (the generic entity-key overload), the pre-computed snapshot rides in the
 * `data` blob — mirroring what keeperd's main thread inserts on a plan-worker
 * message.
 */
function epicSnapshotEvent(
  epicId: string,
  snapshot: Record<string, unknown>,
): number {
  return insertEvent({
    hook_event: "EpicSnapshot",
    session_id: epicId,
    data: JSON.stringify(snapshot),
  });
}

/** Insert a synthetic TaskSnapshot event (entity id in `session_id`). */
function taskSnapshotEvent(
  taskId: string,
  snapshot: Record<string, unknown>,
): number {
  return insertEvent({
    hook_event: "TaskSnapshot",
    session_id: taskId,
    data: JSON.stringify(snapshot),
  });
}

function getEpic(epicId: string) {
  return db.query("SELECT * FROM epics WHERE epic_id = ?").get(epicId) as {
    epic_id: string;
    epic_number: number | null;
    title: string | null;
    project_dir: string | null;
    status: string | null;
    last_event_id: number | null;
    updated_at: number;
    tasks: string;
    depends_on_epics: string;
  } | null;
}

/** The element shape stored in `epics.tasks` as of schema v7. */
interface EmbeddedTask {
  task_id: string;
  epic_id: string | null;
  task_number: number | null;
  title: string | null;
  target_repo: string | null;
  status: string | null;
  depends_on: string[];
}

/** Decode an epic's embedded tasks array (schema v7). NULL/missing → []. */
function getTasks(epicId: string): EmbeddedTask[] {
  const row = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get(epicId) as { tasks: string | null } | null;
  if (row == null || row.tasks == null || row.tasks.length === 0) {
    return [];
  }
  return JSON.parse(row.tasks) as EmbeddedTask[];
}

/** Find one embedded task by id across all epics (schema v7). */
function getTask(taskId: string): EmbeddedTask | null {
  const rows = db.query("SELECT tasks FROM epics").all() as {
    tasks: string | null;
  }[];
  for (const r of rows) {
    if (r.tasks == null || r.tasks.length === 0) {
      continue;
    }
    const arr = JSON.parse(r.tasks) as EmbeddedTask[];
    const found = arr.find((t) => t.task_id === taskId);
    if (found != null) {
      return found;
    }
  }
  return null;
}

test("EpicSnapshot folds into an epics row with all columns + monotonic last_event_id", () => {
  const id = epicSnapshotEvent("fn-1-add-oauth", {
    epic_number: 1,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "open",
  });
  drainAll();
  const epic = getEpic("fn-1-add-oauth");
  expect(epic).toEqual({
    epic_id: "fn-1-add-oauth",
    epic_number: 1,
    title: "Add OAuth",
    project_dir: "/Users/mike/code/keeper",
    status: "open",
    last_event_id: id,
    updated_at: epic?.updated_at ?? 0,
    // A first-sight EpicSnapshot defaults the embedded array to empty.
    tasks: "[]",
    // No depends_on_epics in the blob → the stored column defaults to "[]".
    depends_on_epics: "[]",
  });
  expect(epic?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("TaskSnapshot folds into the parent epic's tasks array with all element fields + derived status", () => {
  // Seed the parent epic first so the task folds via the UPDATE path.
  epicSnapshotEvent("fn-1-add-oauth", {
    epic_number: 1,
    title: "Add OAuth",
    status: "open",
  });
  const id = taskSnapshotEvent("fn-1-add-oauth.3", {
    epic_id: "fn-1-add-oauth",
    task_number: 3,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    status: "done",
  });
  drainAll();
  const task = getTask("fn-1-add-oauth.3");
  expect(task).toEqual({
    task_id: "fn-1-add-oauth.3",
    epic_id: "fn-1-add-oauth",
    task_number: 3,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    status: "done",
    // No depends_on in the blob → the embedded element defaults to [].
    depends_on: [],
  });
  // The fold bumps the parent epic's last_event_id (so it patches).
  expect(getEpic("fn-1-add-oauth")?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("TaskSnapshot before its epic inserts a shell row carrying the task", () => {
  const id = taskSnapshotEvent("fn-1-add-oauth.1", {
    epic_id: "fn-1-add-oauth",
    task_number: 1,
    title: "First",
    target_repo: "/repo",
    status: "open",
  });
  drainAll();
  // A shell epic row exists: epic_id set, scalar columns NULL, tasks carrying
  // the one task.
  const epic = getEpic("fn-1-add-oauth");
  expect(epic).not.toBeNull();
  expect(epic?.epic_number).toBeNull();
  expect(epic?.title).toBeNull();
  expect(epic?.status).toBeNull();
  expect(epic?.last_event_id).toBe(id);
  expect(getTasks("fn-1-add-oauth").map((t) => t.task_id)).toEqual([
    "fn-1-add-oauth.1",
  ]);
});

test("a later EpicSnapshot fills the shell scalars without clobbering the tasks array", () => {
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "T",
    status: "open",
  });
  const epicId = epicSnapshotEvent("fn-1", {
    epic_number: 1,
    title: "Real Title",
    status: "active",
  });
  drainAll();
  const epic = getEpic("fn-1");
  expect(epic?.title).toBe("Real Title");
  expect(epic?.status).toBe("active");
  expect(epic?.last_event_id).toBe(epicId);
  // The array the shell held survives the EpicSnapshot upsert.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.1"]);
});

test("multiple tasks sort deterministically by (task_number, task_id)", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  // Inserted out of order; the fold re-sorts on every write.
  taskSnapshotEvent("fn-1.2", { epic_id: "fn-1", task_number: 2, title: "B" });
  taskSnapshotEvent("fn-1.1", { epic_id: "fn-1", task_number: 1, title: "A" });
  taskSnapshotEvent("fn-1.3", { epic_id: "fn-1", task_number: 1, title: "C" });
  drainAll();
  // task_number asc, then task_id asc on the tie (1 < 1 → break on id).
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual([
    "fn-1.1",
    "fn-1.3",
    "fn-1.2",
  ]);
});

test("a TaskSnapshot for an existing task replaces (not appends) the element", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "old",
  });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "new",
  });
  drainAll();
  const tasks = getTasks("fn-1");
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.title).toBe("new");
});

test("a TaskSnapshot with no epic_id is skipped-and-logged (orphan), cursor advances", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const orphanId = taskSnapshotEvent("orphan.1", {
      task_number: 1,
      title: "no parent",
    });
    drainAll();
    // No epic row created for the orphan; cursor still advanced past it.
    expect(getTask("orphan.1")).toBeNull();
    expect(getCursor()).toBe(orphanId);
    expect(errors.some((e) => e.includes("no epic_id"))).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test("a malformed stored tasks array folds to [] in-txn (never throws / wedges)", () => {
  // Plant a malformed array directly on an epic row, then fold a task into it.
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  drainAll();
  db.run("UPDATE epics SET tasks = '{not json' WHERE epic_id = 'fn-1'");
  const id = taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "T",
  });
  drainAll();
  // The fold treated the malformed array as [] and wrote just the new task —
  // no throw, the cursor advanced.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.1"]);
  expect(getCursor()).toBe(id);
});

test("a later epic snapshot for the same id upserts idempotently (last-write-wins)", () => {
  epicSnapshotEvent("fn-1-add-oauth", {
    epic_number: 1,
    title: "Add OAuth",
    project_dir: "/repo",
    status: "open",
  });
  const id2 = epicSnapshotEvent("fn-1-add-oauth", {
    epic_number: 1,
    title: "Add OAuth (renamed)",
    project_dir: "/repo",
    status: "done",
  });
  drainAll();
  const epic = getEpic("fn-1-add-oauth");
  expect(epic?.title).toBe("Add OAuth (renamed)");
  expect(epic?.status).toBe("done");
  expect(epic?.last_event_id).toBe(id2);
  // Exactly one row — the second snapshot updated, not inserted.
  const count = db.query("SELECT COUNT(*) AS n FROM epics").get() as {
    n: number;
  };
  expect(count.n).toBe(1);
});

test("malformed plan snapshot blob skips-and-logs but advances the cursor", () => {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const badId = insertEvent({
      hook_event: "EpicSnapshot",
      session_id: "fn-bad",
      data: "{not valid json",
    });
    const goodId = epicSnapshotEvent("fn-ok", {
      epic_number: 2,
      title: "Fine",
      project_dir: "/repo",
      status: "open",
    });
    drainAll();
    // The bad blob produced no epics row but did not wedge the reducer.
    expect(getEpic("fn-bad")).toBeNull();
    expect(getEpic("fn-ok")?.title).toBe("Fine");
    expect(getCursor()).toBe(goodId);
    expect(getCursor()).toBeGreaterThan(badId);
    expect(
      errors.some((e) => e.includes("failed to parse plan snapshot blob")),
    ).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test("plan folds do not touch the jobs projection", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", { epic_id: "fn-1", task_number: 1, title: "T" });
  drainAll();
  // Jobs folding is unchanged — the session row is still 'working'.
  expect(getJob()?.state).toBe("working");
  expect(getEpic("fn-1")?.title).toBe("E");
  expect(getTask("fn-1.1")?.title).toBe("T");
});

test("from-scratch re-fold reproduces byte-identical epics rows (incl. embedded tasks)", () => {
  // A TaskSnapshot BEFORE its EpicSnapshot exercises the shell-insert path on
  // replay; two tasks out of sort order exercise the deterministic re-sort.
  taskSnapshotEvent("fn-1.2", {
    epic_id: "fn-1",
    task_number: 2,
    title: "Second",
    target_repo: "/repo",
    status: "open",
  });
  epicSnapshotEvent("fn-1", {
    epic_number: 1,
    title: "Add OAuth",
    project_dir: "/repo",
    status: "open",
  });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "Wire callback",
    target_repo: "/repo",
    status: "done",
  });
  // A later snapshot for the epic (upsert) to exercise the conflict branch —
  // must NOT clobber the embedded tasks array.
  epicSnapshotEvent("fn-1", {
    epic_number: 1,
    title: "Add OAuth v2",
    project_dir: "/repo",
    status: "done",
  });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  // Sanity: the embedded array is sorted (task_number, task_id) — same key the
  // migration backfill uses, so a migrated row equals this re-folded one.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.1", "fn-1.2"]);

  // Rewind the cursor + DELETE the projection, then re-drain. drain() replays
  // events in autoincrement-id order (not FS-arrival order), so the fold is a
  // pure function of the persisted log — the rebuilt rows must be byte-identical.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
});

// ---------------------------------------------------------------------------
// Plan retraction (TaskDeleted / EpicDeleted tombstones)
// ---------------------------------------------------------------------------

/** Insert a synthetic TaskDeleted tombstone (entity id in session_id, epic_id in blob). */
function taskDeletedEvent(taskId: string, epicId: string | null): number {
  return insertEvent({
    hook_event: "TaskDeleted",
    session_id: taskId,
    data: JSON.stringify({ epic_id: epicId }),
  });
}

/** Insert a synthetic EpicDeleted tombstone (entity id in session_id, no blob). */
function epicDeletedEvent(epicId: string): number {
  return insertEvent({
    hook_event: "EpicDeleted",
    session_id: epicId,
    data: "",
  });
}

test("TaskDeleted splices the element from the parent epic array and bumps last_event_id", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "One",
  });
  taskSnapshotEvent("fn-1.2", {
    epic_id: "fn-1",
    task_number: 2,
    title: "Two",
  });
  const delId = taskDeletedEvent("fn-1.1", "fn-1");
  drainAll();

  // The deleted element is gone; the surviving one remains, still sorted.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.2"]);
  // The retraction bumps the epic's version so the read surface patches it.
  expect(getEpic("fn-1")?.last_event_id).toBe(delId);
  expect(getCursor()).toBe(delId);
});

test("EpicDeleted removes the epic row (embedded tasks vanish with it)", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "One",
  });
  const delId = epicDeletedEvent("fn-1");
  drainAll();

  expect(getEpic("fn-1")).toBeNull();
  expect(getCursor()).toBe(delId);
});

test("TaskDeleted/EpicDeleted are idempotent no-ops on a missing target, cursor advances", () => {
  // No epic, no task — both tombstones are no-ops but still advance the cursor.
  const t = taskDeletedEvent("fn-9.9", "fn-9");
  drainAll();
  expect(getEpic("fn-9")).toBeNull();
  expect(getCursor()).toBe(t);

  const e = epicDeletedEvent("fn-9");
  drainAll();
  expect(getCursor()).toBe(e);

  // A TaskDeleted whose element is already absent does not bump the epic row.
  epicSnapshotEvent("fn-2", { epic_number: 2, title: "E2", status: "open" });
  drainAll();
  const before = getEpic("fn-2");
  taskDeletedEvent("fn-2.5", "fn-2"); // element never existed
  drainAll();
  expect(getEpic("fn-2")?.last_event_id).toBe(before?.last_event_id);
});

test("TaskDeleted with a null epic_id is a no-op (can't place the splice)", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "One",
  });
  drainAll();
  const before = getEpic("fn-1")?.last_event_id;
  taskDeletedEvent("fn-1.1", null);
  drainAll();
  // The element stays — a null epic_id can't be placed against a parent.
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.1"]);
  expect(getEpic("fn-1")?.last_event_id).toBe(before);
});

test("from-scratch re-fold reproduces the spliced state across a create→delete sequence", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  taskSnapshotEvent("fn-1.1", {
    epic_id: "fn-1",
    task_number: 1,
    title: "One",
  });
  taskSnapshotEvent("fn-1.2", {
    epic_id: "fn-1",
    task_number: 2,
    title: "Two",
  });
  taskDeletedEvent("fn-1.1", "fn-1");
  // An EpicDeleted followed by a later TaskSnapshot legitimately re-creates a
  // shell (the task still exists on disk) — replayed in id order it lands last.
  epicSnapshotEvent("fn-3", { epic_number: 3, title: "Gone", status: "open" });
  epicDeletedEvent("fn-3");
  taskSnapshotEvent("fn-3.1", {
    epic_id: "fn-3",
    task_number: 1,
    title: "Reborn",
  });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.2"]);
  // fn-3 was deleted then a later task re-created it as a shell.
  expect(getTasks("fn-3").map((t) => t.task_id)).toEqual(["fn-3.1"]);

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
});
