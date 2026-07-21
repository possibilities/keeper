/**
 * Reducer tests — shard 2 of 4 (fn-769 fast-tier split of the former
 * monolithic reducer.test.ts). Theme: Killed reap, title/transcript folds, drain batching, plan (epic/task) projection.
 *
 * Each test clones the per-process migrated `:memory:` template via
 * `freshMemDb` (`Database.deserialize` ~0.2ms vs the ~28ms migration
 * ladder), seeds raw `events` rows, drives the reducer, and asserts the
 * projection + cursor. Module-level helpers (tsCounter, insertEvent,
 * drainAll, …) are DUPLICATED verbatim into every shard rather than
 * shared: under a single-process run the files share module state, so a
 * shared tsCounter would shift absolute ts values some tests assume. Each
 * shard keeps its own private counter starting at 1000 — byte-identical to
 * the pre-split file. Test titles are preserved verbatim so failure-history
 * greps still resolve.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  __resetEpicIndexMemoForTest,
  applyEvent,
  DEFAULT_BATCH_SIZE,
  drain,
} from "../src/reducer";
import { seedKilledSweep } from "../src/seed-sweep";
import type { Event } from "../src/types";
import { bindGitObservationWatermark } from "./helpers/git-event-payload";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  // fn-769: each test clones the per-process migrated `:memory:` template
  // (`freshMemDb` — `Database.deserialize` ~0.2ms vs the ~28ms full migration
  // ladder `openDb(":memory:")` paid here before; 28.9s → 6.5s for this file).
  // The clone is an ordinary private writable connection, so the
  // refold-determinism tests (~:337, ~:2229) that rewind the cursor + DELETE the
  // projection tables + re-drain on this SAME connection still hold byte-for-byte
  // in memory. No body-level test opens a second connection that would need to
  // see this DB's rows.
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
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
  overrides: Partial<Event> & {
    hook_event: string;
    bash_mutation_kind?: string | null;
    bash_mutation_targets?: string | null;
    plan_files?: string | null;
    backend_exec_type?: string | null;
    backend_exec_session_id?: string | null;
    backend_exec_pane_id?: string | null;
    // Schema v51 / fn-682: sparse derived column carrying the
    // PostToolUse:Monitor `tool_response.taskId` or PostToolUse:Bash
    // `tool_response.backgroundTaskId`. NULL on every other event;
    // monitors-projection tests pass this explicitly via overrides.
    background_task_id?: string | null;
  },
): number {
  const ts = overrides.ts ?? tsCounter++;
  const eventData = bindGitObservationWatermark(
    db,
    overrides.hook_event,
    overrides.data ?? "{}",
  );
  const row = {
    ts,
    session_id: overrides.session_id ?? "sess-a",
    // Honor an EXPLICIT `pid: null` (fn-743: NULL-pid SessionStart seeds a
    // NULL-pid jobs row — the stuck-`stopped` origin). `?? 4242` would coalesce
    // null away, so key off presence: omitted → 4242, present (incl. null) →
    // the given value.
    pid: "pid" in overrides ? (overrides.pid ?? null) : 4242,
    hook_event: overrides.hook_event,
    event_type: overrides.event_type ?? overrides.hook_event,
    tool_name: overrides.tool_name ?? null,
    matcher: overrides.matcher ?? null,
    cwd: overrides.cwd ?? "/tmp/work",
    permission_mode: overrides.permission_mode ?? null,
    agent_id: overrides.agent_id ?? null,
    agent_type: overrides.agent_type ?? null,
    stop_hook_active: overrides.stop_hook_active ?? null,
    data: eventData,
    subagent_agent_id: overrides.subagent_agent_id ?? null,
    spawn_name: overrides.spawn_name ?? null,
    start_time: overrides.start_time ?? null,
    slash_command: overrides.slash_command ?? null,
    skill_name: overrides.skill_name ?? null,
    plan_op: overrides.plan_op ?? null,
    plan_target: overrides.plan_target ?? null,
    plan_epic_id: overrides.plan_epic_id ?? null,
    plan_task_id: overrides.plan_task_id ?? null,
    plan_subject_present: overrides.plan_subject_present ?? null,
    tool_use_id: overrides.tool_use_id ?? null,
    config_dir: overrides.config_dir ?? null,
    // Schema v31: bash-mutation deriver sparse columns. NULL on every row
    // whose payload didn't match a mutation pattern; defaults to NULL here
    // so a non-Bash event lands NULL. Tests covering bash attribution pass
    // these explicitly via the overrides.
    bash_mutation_kind: overrides.bash_mutation_kind ?? null,
    bash_mutation_targets: overrides.bash_mutation_targets ?? null,
    // Schema v46 / fn-666: plan_files sparse JSON-array column carrying
    // the envelope's repo-relative `files` array. NULL on every non-plan
    // event; plan-mint tests pass this explicitly via overrides.
    plan_files: overrides.plan_files ?? null,
    // Schema v48 / fn-668: backend-exec coordinates (terminal-multiplexer
    // session/pane the parent Claude ran under). NULL on every non-zellij
    // event; backend-exec-mint tests pass these explicitly via overrides.
    backend_exec_type: overrides.backend_exec_type ?? null,
    backend_exec_session_id: overrides.backend_exec_session_id ?? null,
    backend_exec_pane_id: overrides.backend_exec_pane_id ?? null,
    // Schema v51 / fn-682: sparse `background_task_id` deriver column
    // (PostToolUse:Monitor `tool_response.taskId` or PostToolUse:Bash
    // `tool_response.backgroundTaskId`). NULL on every other event;
    // monitors-projection tests pass this explicitly via overrides.
    background_task_id: overrides.background_task_id ?? null,
  };
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
       plan_op, plan_target, plan_epic_id, plan_task_id,
       plan_subject_present, tool_use_id, config_dir,
       bash_mutation_kind, bash_mutation_targets, plan_files,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
       background_task_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.start_time,
      row.slash_command,
      row.skill_name,
      row.plan_op,
      row.plan_target,
      row.plan_epic_id,
      row.plan_task_id,
      row.plan_subject_present,
      row.tool_use_id,
      row.config_dir,
      row.bash_mutation_kind,
      row.bash_mutation_targets,
      row.plan_files,
      row.backend_exec_type,
      row.backend_exec_session_id,
      row.backend_exec_pane_id,
      row.background_task_id,
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
    start_time: string | null;
    plan_verb: string | null;
    plan_ref: string | null;
  } | null;
}

function getCursor(): number {
  const row = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  return row.last_event_id;
}

/** Insert a synthetic Killed event carrying the (pid, start_time) payload. */
function killedEvent(
  pid: number,
  start_time: string | null,
  session_id = "sess-a",
): number {
  return insertEvent({
    hook_event: "Killed",
    session_id,
    data: JSON.stringify({ pid, start_time }),
  });
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

function getEpicJobs(epicId: string): {
  job_id: string;
  plan_verb: string;
  state: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
}[] {
  const row = db
    .query("SELECT jobs FROM epics WHERE epic_id = ?")
    .get(epicId) as { jobs: string | null } | null;
  if (row == null || row.jobs == null || row.jobs.length === 0) {
    return [];
  }
  return JSON.parse(row.jobs);
}

// ---------------------------------------------------------------------------
// Killed fold (synthetic Killed → state='killed', terminal-but-revivable)
// ---------------------------------------------------------------------------

test("Killed with matching (pid, start_time) folds to killed", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:Wed May 22 10:00:00 2026",
  });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.start_time).toBe("macos:Wed May 22 10:00:00 2026");

  const killedId = killedEvent(1234, "macos:Wed May 22 10:00:00 2026");
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("killed");
  expect(job?.last_event_id).toBe(killedId);
  expect(getCursor()).toBe(killedId);
});

test("Killed with mismatched start_time is a safe no-op (cursor still advances)", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:Wed May 22 10:00:00 2026",
  });
  drainAll();
  const beforeLastId = getJob()?.last_event_id;

  // Same pid, different start_time — pid was recycled into a different process.
  const killedId = killedEvent(1234, "macos:Fri Nov 13 12:00:00 2026");
  drainAll();
  const job = getJob();
  // Row unchanged: state still 'stopped', last_event_id unchanged (no row write).
  expect(job?.state).toBe("stopped");
  expect(job?.last_event_id).toBe(beforeLastId ?? 0);
  // Cursor STILL advanced past the stale Killed event (safe no-op).
  expect(getCursor()).toBe(killedId);
});

test("Killed with mismatched pid is a safe no-op", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:t1",
  });
  drainAll();
  const beforeLastId = getJob()?.last_event_id;

  const killedId = killedEvent(9999, "macos:t1");
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.last_event_id).toBe(beforeLastId ?? 0);
  expect(getCursor()).toBe(killedId);
});

test("Killed against legacy row (start_time NULL) loose-matches on pid alone", () => {
  // Legacy rows whose SessionStart pre-dated schema v9 carry start_time=NULL.
  // Per Q7, the Killed fold loose-matches on pid alone for these rows.
  insertEvent({ hook_event: "SessionStart", pid: 1234 }); // no start_time
  drainAll();
  expect(getJob()?.start_time).toBeNull();

  const killedId = killedEvent(1234, "macos:any-value-ignored");
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("killed");
  expect(job?.last_event_id).toBe(killedId);
});

test("Killed for a non-existent jobs row is a safe no-op", () => {
  const killedId = killedEvent(1234, "macos:t1", "ghost");
  drainAll();
  expect(getJob("ghost")).toBeNull();
  expect(getCursor()).toBe(killedId);
});

test("Killed with malformed data blob skip-and-logs and advances cursor", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:t1",
  });
  drainAll();
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    const badId = insertEvent({
      hook_event: "Killed",
      data: "{not valid json",
    });
    drainAll();
    // Row unchanged; cursor advanced past the bad event.
    expect(getJob()?.state).toBe("stopped");
    expect(getCursor()).toBe(badId);
    expect(errors.some((e) => e.includes("Killed payload"))).toBe(true);
  } finally {
    console.error = originalError;
  }
});

test("Killed with missing pid in payload is a safe no-op", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:t1",
  });
  drainAll();
  const beforeLastId = getJob()?.last_event_id;
  const killedId = insertEvent({
    hook_event: "Killed",
    data: JSON.stringify({ start_time: "macos:t1" }), // no pid
  });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.last_event_id).toBe(beforeLastId ?? 0);
  expect(getCursor()).toBe(killedId);
});

// ---------------------------------------------------------------------------
// fn-743: pidless reap of NULL-pid stopped rows (the stuck-`stopped` incident)
// ---------------------------------------------------------------------------

/** Insert a synthetic PIDLESS Killed event (`pid: null`) — fn-743 reap. */
function pidlessKilledEvent(
  start_time: string | null = null,
  session_id = "sess-a",
): number {
  return insertEvent({
    hook_event: "Killed",
    session_id,
    data: JSON.stringify({ pid: null, start_time }),
  });
}

test("fn-743: pidless Killed reaps a NULL-pid stopped row to killed", () => {
  // A SessionStart whose pid binding landed NULL (ingester schema-skew /
  // dead-letter replay / legacy row) seeds a stopped row with pid=NULL — the
  // unwatchable row the exit-watcher's old `pid IS NOT NULL` filter never
  // armed, so it lived forever.
  insertEvent({ hook_event: "SessionStart", pid: null });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.pid).toBeNull();

  const killedId = pidlessKilledEvent();
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("killed");
  expect(job?.last_event_id).toBe(killedId);
  expect(getCursor()).toBe(killedId);
});

test("fn-743: pidless Killed NEVER reaps a row that carries a real pid", () => {
  // A watchable (pid-bearing) row is the live exit-watcher's / seed-sweep's
  // job, matched on the strict (pid, start_time) identity. A pidless reap that
  // happened to race a resume (row gained a pid) must be a safe no-op.
  insertEvent({
    hook_event: "SessionStart",
    pid: 1234,
    start_time: "macos:t1",
  });
  drainAll();
  const beforeLastId = getJob()?.last_event_id;

  const killedId = pidlessKilledEvent();
  drainAll();
  const job = getJob();
  // Untouched: a pidless reap must not knock out a watchable row.
  expect(job?.state).toBe("stopped");
  expect(job?.last_event_id).toBe(beforeLastId ?? 0);
  expect(getCursor()).toBe(killedId);
});

test("fn-743: pidless Killed on an already-terminal NULL-pid row is a no-op", () => {
  // Seed a NULL-pid stopped row, reap it once (→ killed), then re-emit the
  // pidless Killed. The terminal-state guard must keep it killed without a
  // fresh row write (no resurrection, idempotent re-fold).
  insertEvent({ hook_event: "SessionStart", pid: null });
  drainAll();
  const firstKill = pidlessKilledEvent();
  drainAll();
  expect(getJob()?.state).toBe("killed");
  expect(getJob()?.last_event_id).toBe(firstKill);

  const secondKill = pidlessKilledEvent();
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("killed");
  // No fresh write — last_event_id stays pinned to the FIRST kill.
  expect(job?.last_event_id).toBe(firstKill);
  expect(getCursor()).toBe(secondKill);
});

test("fn-743: pidless Killed for a non-existent jobs row is a safe no-op", () => {
  const killedId = pidlessKilledEvent(null, "ghost");
  drainAll();
  expect(getJob("ghost")).toBeNull();
  expect(getCursor()).toBe(killedId);
});

test("SessionStart re-opens a killed row: killed -> stopped, pid+start_time refreshed", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  killedEvent(1000, "macos:t1");
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // A fresh `claude --resume` lands a new SessionStart with a new (pid, start_time).
  insertEvent({
    hook_event: "SessionStart",
    pid: 2000,
    start_time: "macos:t2",
  });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.pid).toBe(2000);
  expect(job?.start_time).toBe("macos:t2");
});

test("UserPromptSubmit re-opens a killed row with new pid: killed -> working, pid refreshed, start_time CLEARED", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  killedEvent(1000, "macos:t1");
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // A prompt arriving with a new pid (the live re-attached process). UPS does
  // not carry start_time, but the persisted "macos:t1" now describes a
  // dead/recycled process — leaving it stuck would let the next boot's seed
  // sweep emit a synthetic Killed that the reducer's strict (pid, start_time)
  // match would fold the live row to 'killed'. The fold clears start_time to
  // NULL on pid change so producers fall back to the legacy-loose branch
  // ("pid alive + no stored start_time → cannot prove recycle. Leave alone.")
  // until the next SessionStart refreshes it.
  insertEvent({ hook_event: "UserPromptSubmit", pid: 2000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.pid).toBe(2000);
  expect(job?.start_time).toBe(null);
});

test("UserPromptSubmit with SAME pid preserves start_time (no-op on identity)", () => {
  // When pid is unchanged, start_time still describes the live process —
  // clearing it would be a regression (we'd lose the recycle-safe identity
  // we already have). The fold's CASE leaves start_time alone in this branch.
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  insertEvent({ hook_event: "UserPromptSubmit", pid: 1000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.pid).toBe(1000);
  expect(job?.start_time).toBe("macos:t1");
});

test("UserPromptSubmit with missing pid (legacy hook) preserves persisted pid + start_time", () => {
  // Legacy hook payloads omit pid. The COALESCE leaves pid alone; the CASE's
  // first conjunct (`event.pid IS NOT NULL`) is false, so start_time is also
  // preserved. Behavior unchanged from pre-fix.
  //
  // We insert the UPS event row directly with raw SQL because the test
  // helper's `??` defaults `pid: null` to 4242 — the bypass is the only way
  // to express "event.pid is genuinely NULL" given that helper.
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher,
       cwd, permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time
     ) VALUES (?, 'sess-a', NULL, 'UserPromptSubmit', 'UserPromptSubmit',
              NULL, NULL, '/tmp/work', NULL, NULL, NULL, NULL, '{}',
              NULL, NULL, NULL)`,
    [tsCounter++],
  );
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.pid).toBe(1000);
  expect(job?.start_time).toBe("macos:t1");
});

test("cross-boot: kill -> UPS-resume-new-pid -> daemon restart (seed sweep) keeps row 'working'", () => {
  // The end-to-end regression chain documented in
  // fn-579-fix-stale-start-time-on-ups-resume.1:
  //
  //   1. SessionStart(pid=1000, start_time=X)  → (stopped, 1000, X)
  //   2. Killed(pid=1000, start_time=X)        → (killed,  1000, X)
  //   3. UserPromptSubmit(pid=process.pid)     → (working, process.pid, NULL)
  //          ^ live pid; without the fix, start_time stayed at X.
  //   4. seedKilledSweep against the same DB simulates daemon restart. The
  //      row's pid is alive (we use process.pid). With start_time stuck at X
  //      the sweep would compare osStart != X and emit a synthetic Killed
  //      carrying the stored X — the reducer would strict-match (process.pid,
  //      X) against the row's (process.pid, X) and fold to 'killed', silently
  //      hiding the live resumed session from the default jobs view.
  //
  //   With the fix (start_time cleared to NULL on pid change in the UPS fold),
  //   the sweep takes the legacy-loose branch ("pid alive + no stored
  //   start_time → cannot prove recycle. Leave alone.") and emits NOTHING.
  //   The row stays 'working' across the simulated boot.
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  killedEvent(1000, "macos:t1");
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // Resume into a live process. process.pid is alive for the duration of the
  // test, so seedKilledSweep's `isPidAlive` probe will return true.
  const livePid = process.pid;
  insertEvent({ hook_event: "UserPromptSubmit", pid: livePid });
  drainAll();
  {
    const job = getJob();
    expect(job?.state).toBe("working");
    expect(job?.pid).toBe(livePid);
    // The fix: start_time cleared, so the row is now in the loose-pid-only
    // identity state until the next SessionStart refreshes it.
    expect(job?.start_time).toBe(null);
  }

  // Snapshot the synthetic Killed event count before the simulated boot.
  const killedBefore = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-a'",
      )
      .get() as { n: number }
  ).n;

  // Simulate daemon restart: run the seed sweep against the same DB and drain.
  seedKilledSweep(db);
  drainAll();

  // The sweep emitted NO new Killed event (legacy-loose branch: pid alive +
  // stored start_time is NULL → leave alone).
  const killedAfter = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event = 'Killed' AND session_id = 'sess-a'",
      )
      .get() as { n: number }
  ).n;
  expect(killedAfter).toBe(killedBefore);

  // And the row is still 'working' — the live resumed session survives the
  // restart.
  const after = getJob();
  expect(after?.state).toBe("working");
  expect(after?.pid).toBe(livePid);
  expect(after?.start_time).toBe(null);
});

test("fn-743 seed sweep: a NULL-pid stopped row is reaped to killed at boot", () => {
  // A SessionStart whose pid binding landed NULL seeds a stopped row with
  // pid=NULL — the unwatchable, unprobeable row that lived forever (the
  // 2026-06-08 stuck-`stopped` incident). The boot seed sweep now reaps it via
  // a pidless Killed.
  insertEvent({ hook_event: "SessionStart", pid: null });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.pid).toBeNull();

  seedKilledSweep(db);
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // Idempotent: a second boot sweep emits another pidless Killed, but the
  // terminal guard keeps the row killed without a fresh write.
  const lastIdAfterFirst = getJob()?.last_event_id;
  seedKilledSweep(db);
  drainAll();
  expect(getJob()?.state).toBe("killed");
  expect(getJob()?.last_event_id).toBe(lastIdAfterFirst ?? 0);
});

test("fn-743 seed sweep: a live-pid stopped row is left untouched (idle != terminal)", () => {
  // The reaper must NOT touch a row whose process is still alive. process.pid
  // is alive for the duration of the test, with a NULL stored start_time, so
  // the legacy-loose branch leaves it alone.
  const livePid = process.pid;
  insertEvent({ hook_event: "SessionStart", pid: livePid }); // no start_time
  drainAll();
  expect(getJob()?.state).toBe("stopped");

  seedKilledSweep(db);
  drainAll();
  // Untouched — a live (idle-but-alive) session is not terminal.
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.pid).toBe(livePid);
});

test("fn-743 seed sweep: a dead-pid stopped row is reaped to killed", () => {
  // A pid that is no longer alive (we pick a high pid unlikely to exist; the
  // sweep's `isPidAlive` returns false → emit Killed regardless of start_time).
  const deadPid = 2_000_000_000; // above any live macOS/Linux pid
  insertEvent({
    hook_event: "SessionStart",
    pid: deadPid,
    start_time: "macos:t1",
  });
  drainAll();
  expect(getJob()?.state).toBe("stopped");

  seedKilledSweep(db);
  drainAll();
  expect(getJob()?.state).toBe("killed");
});

test("Stop on a killed row is a no-op (terminal guard)", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  drainAll();
  const beforeLastId = getJob()?.last_event_id;
  insertEvent({ hook_event: "Stop" });
  drainAll();
  // Row still killed, last_event_id unchanged (the guard skipped the write).
  expect(getJob()?.state).toBe("killed");
  expect(getJob()?.last_event_id).toBe(beforeLastId ?? 0);
});

test("SessionEnd on a killed row is a no-op (terminal guard, killed stays)", () => {
  // killed carries the proven-dead (pid, start_time) evidence — more
  // informative than ended — so a late SessionEnd must not clobber it.
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  drainAll();
  const beforeLastId = getJob()?.last_event_id;
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("killed");
  expect(getJob()?.last_event_id).toBe(beforeLastId ?? 0);
});

test("SessionEnd from a different pid cannot close a live resumed row", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  drainAll();

  insertEvent({ hook_event: "SessionStart", pid: 2000, start_time: "t2" });
  const liveId = insertEvent({ hook_event: "UserPromptSubmit", pid: 2000 });
  drainAll();
  const before = getJob();
  expect(before?.state).toBe("working");
  expect(before?.pid).toBe(2000);
  expect(before?.start_time).toBe("t2");
  expect(before?.last_event_id).toBe(liveId);

  const staleEndId = insertEvent({ hook_event: "SessionEnd", pid: 1000 });
  drainAll();

  const after = getJob();
  expect(after?.state).toBe("working");
  expect(after?.pid).toBe(2000);
  expect(after?.start_time).toBe("t2");
  expect(after?.last_event_id).toBe(liveId);
  expect(getCursor()).toBe(staleEndId);
});

test("PostToolUse / Notification on a killed row are no-ops (default branch, no state write)", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  drainAll();
  insertEvent({ hook_event: "PostToolUse", tool_name: "Bash" });
  const lastId = insertEvent({ hook_event: "Notification" });
  drainAll();
  // Default branch writes no state; the row stays killed and the cursor advances.
  expect(getJob()?.state).toBe("killed");
  expect(getCursor()).toBe(lastId);
});

test("Killed -> SessionStart -> Stop -> SessionEnd full revival cycle folds correctly", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  drainAll();
  expect(getJob()?.state).toBe("killed");

  // Re-attach: new process, new identity.
  insertEvent({ hook_event: "SessionStart", pid: 2000, start_time: "t2" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");

  // Live work + clean end.
  insertEvent({ hook_event: "UserPromptSubmit" });
  drainAll();
  expect(getJob()?.state).toBe("working");

  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");

  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("Killed re-folds idempotently: rewind + redrain reproduces killed byte-identically", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:t1",
  });
  killedEvent(1000, "macos:t1");
  drainAll();
  const before = getJob();
  expect(before?.state).toBe("killed");

  // Rewind cursor + projection; the SAME event log must replay to the same row.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after).toEqual(before);
});

test("Killed re-fold determinism with interleaved revival: SessionStart -> Killed -> SessionStart", () => {
  // A killed row revived by a SessionStart, then killed again by a new Killed
  // event targeting the NEW (pid, start_time) — re-fold from scratch must
  // reproduce the same final state.
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  killedEvent(1000, "t1");
  insertEvent({ hook_event: "SessionStart", pid: 2000, start_time: "t2" });
  killedEvent(2000, "t2");
  drainAll();
  const before = getJob();
  expect(before?.state).toBe("killed");
  expect(before?.pid).toBe(2000);
  expect(before?.start_time).toBe("t2");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after).toEqual(before);
});

test("SessionStart seeds jobs.start_time from event.start_time (set-once on first sight)", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 1000,
    start_time: "macos:Wed May 22 10:00:00 2026",
  });
  drainAll();
  expect(getJob()?.start_time).toBe("macos:Wed May 22 10:00:00 2026");
});

test("SessionStart with no start_time leaves jobs.start_time NULL (legacy)", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000 });
  drainAll();
  expect(getJob()?.start_time).toBeNull();
});

test("SessionStart resume COALESCEs start_time: persisted value preserved when new event has none", () => {
  insertEvent({ hook_event: "SessionStart", pid: 1000, start_time: "t1" });
  drainAll();
  expect(getJob()?.start_time).toBe("t1");
  // A resume SessionStart with no captured start_time MUST NOT clobber the
  // persisted value (COALESCE(excluded.start_time, jobs.start_time)).
  insertEvent({ hook_event: "SessionStart", pid: 2000 });
  drainAll();
  const job = getJob();
  expect(job?.pid).toBe(2000);
  expect(job?.start_time).toBe("t1");
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
  // No SessionStart for "ghost" — the title rule's SELECT finds no row. Use a
  // TranscriptTitle (NULL pid, daemon-synthesized) rather than a UserPromptSubmit:
  // fn-816's fork-attribution seed mints a row on a PID-BEARING UPS, so a
  // pid-bearing title event would no longer exercise the title-rule-no-op path.
  const id = insertEvent({
    hook_event: "TranscriptTitle",
    session_id: "ghost",
    pid: null,
    data: JSON.stringify({ session_title: "foo" }),
  });
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
// plan_verb / plan_ref derivation (spawn_name → jobs columns, v10)
// ---------------------------------------------------------------------------

test("SessionStart with work::<ref> seeds plan_verb='work' / plan_ref=<ref>", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-575-osc-parser.3",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-575-osc-parser.3");
});

test("SessionStart with close::<epic> seeds plan_verb='close' / plan_ref=<epic>", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "close::fn-575-osc-parser",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("close");
  expect(job?.plan_ref).toBe("fn-575-osc-parser");
});

test("SessionStart with plan::<ref> seeds plan_verb='plan' / plan_ref=<ref>", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "plan::fn-100-new-thing",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("plan");
  expect(job?.plan_ref).toBe("fn-100-new-thing");
});

test("SessionStart with audit::<ref> leaves plan_verb/plan_ref NULL (whitelist excludes audit)", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "audit::fn-1-foo",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBeNull();
  expect(job?.plan_ref).toBeNull();
});

test("SessionStart with no spawn_name leaves plan_verb/plan_ref NULL", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBeNull();
  expect(job?.plan_ref).toBeNull();
});

test("SessionStart with malformed verb::ref::extra leaves both NULL", () => {
  // The `$` anchor rejects extra `::` segments — the spawn name can never
  // partial-match and land wrong data in the projection.
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-1-foo::extra",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBeNull();
  expect(job?.plan_ref).toBeNull();
});

test("SessionStart with non-fn-shaped ref leaves both NULL", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::not-an-fn-ref",
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBeNull();
  expect(job?.plan_ref).toBeNull();
});

test("duplicate SessionStart leaves plan_verb/plan_ref untouched (set-once identity)", () => {
  // First SessionStart seeds (work, fn-575-foo.1). A second SessionStart with
  // a DIFFERENT verb/ref must NOT overwrite — set-once mirrors the title /
  // title_source precedence rule on RESUME.
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-575-foo.1",
    pid: 1000,
  });
  drainAll();
  expect(getJob()?.plan_verb).toBe("work");
  expect(getJob()?.plan_ref).toBe("fn-575-foo.1");

  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "close::fn-999-other",
    pid: 2000,
  });
  drainAll();
  const job = getJob();
  // pid refreshed via RESUME, but plan_verb / plan_ref stay at the first-sight
  // values — even though the new spawn_name parses cleanly.
  expect(job?.pid).toBe(2000);
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-575-foo.1");
});

test("duplicate SessionStart that clears spawn_name leaves plan_verb/plan_ref untouched", () => {
  // RESUME with no spawn_name also must not clear the seeded pair — the ON
  // CONFLICT branch never touches these columns, regardless of incoming value.
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-575-foo.1",
  });
  drainAll();
  expect(getJob()?.plan_verb).toBe("work");

  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-575-foo.1");
});

test("plan_verb/plan_ref re-fold idempotently: rewind + redrain reproduces seeded pair", () => {
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "close::fn-575-osc-parser",
  });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  const before = getJob();
  expect(before?.plan_verb).toBe("close");
  expect(before?.plan_ref).toBe("fn-575-osc-parser");

  // The pair is a pure function of the event log — a rewind + DELETE + redrain
  // must reproduce identical (plan_verb, plan_ref).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = getJob();
  expect(after?.plan_verb).toBe("close");
  expect(after?.plan_ref).toBe("fn-575-osc-parser");
});

test("plan_verb/plan_ref re-fold idempotency on RESUME: rewind reproduces FIRST spawn (not later)", () => {
  // Two SessionStarts with different spawn_names. The first wins (set-once
  // identity on RESUME). A rewind+redrain must reproduce that same first-wins
  // outcome — the second SessionStart's spawn_name never lands in the row.
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-1-first",
  });
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "close::fn-2-second",
  });
  drainAll();
  expect(getJob()?.plan_verb).toBe("work");
  expect(getJob()?.plan_ref).toBe("fn-1-first");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  expect(getJob()?.plan_verb).toBe("work");
  expect(getJob()?.plan_ref).toBe("fn-1-first");
});

test("plan_verb/plan_ref HEAL on resume: a NULL-pair fork-seed row fills when the SessionStart folds late", () => {
  // Fold-ordering race: an out-of-order UserPromptSubmit (carrying a pid, no
  // spawn_name) mints the jobs row with a NULL plan correlator BEFORE the
  // session's SessionStart folds. The SessionStart's ON CONFLICT branch
  // COALESCE-fills the pair (fill-only-when-NULL), so the row heals to the
  // spawn name's parsed pair instead of staying orphaned.
  insertEvent({ hook_event: "UserPromptSubmit", pid: 7000 });
  drainAll();
  // Fork-seed minted a row with no plan correlator.
  expect(getJob()?.plan_verb).toBeNull();
  expect(getJob()?.plan_ref).toBeNull();

  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::fn-832-foo.1",
    pid: 7000,
  });
  drainAll();
  const job = getJob();
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-832-foo.1");
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
  // fn-744 .2: shrunk 200 -> 50 so a GitSnapshot/Commit fold burst can't run
  // 200 expensive per-event transactions uninterrupted in one drain() call —
  // a smaller batch yields the writer lock back to contending hook INSERTs ~4x
  // more often (one window per drain() boundary). Throughput is unchanged: the
  // caller loops until drain() returns 0.
  expect(DEFAULT_BATCH_SIZE).toBe(50);
  insertEvent({ hook_event: "SessionStart" });
  expect(drain(db)).toBe(1);
  expect(drain(db)).toBe(0);
});

test("fold is batch-size-invariant — same log, same projection + cursor (fn-744 .2)", () => {
  // fn-744 .2 shrank DEFAULT_BATCH_SIZE 200 -> 50. The batch size is purely a
  // writer-lock-yield granularity knob; it must never change WHAT the fold
  // produces. This pins the determinism safety net the batch-tuning lever rests
  // on: a mixed log folded at batch=50 vs batch=200 yields a BYTE-IDENTICAL
  // jobs/git_status/epics projection AND an identical cursor. (The "delta board
  // == full-snapshot board" acceptance, expressed in fold terms — a smaller
  // batch can't drop or reorder a fold.)
  const seed = (): void => {
    // A SessionStart + lifecycle on one session, plus the two expensive arms the
    // .1 finding fingered (GitSnapshot re-fans git-status, Commit re-fans
    // plan-links) so the invariance covers the costly multi-table folds, not
    // just the cheap jobs upsert.
    insertEvent({ hook_event: "SessionStart" });
    insertEvent({ hook_event: "UserPromptSubmit" });
    insertEvent({
      hook_event: "GitSnapshot",
      session_id: "/repo",
      cwd: "/repo",
      data: JSON.stringify({
        project_dir: "/repo",
        dirty_count: 3,
        unattributed_to_live_count: 1,
        orphan_count: 0,
        attributions: [],
      }),
    });
    for (let i = 0; i < 120; i++) {
      insertEvent({ hook_event: "PreToolUse", tool_name: "Bash" });
      insertEvent({ hook_event: "PostToolUse", tool_name: "Bash" });
    }
    insertEvent({ hook_event: "Stop" });
  };

  // Pass A — fold the whole log at batch=50 (the shipped default).
  seed();
  let n: number;
  do {
    n = drain(db, 50);
  } while (n > 0);
  const cursorA = getCursor();
  const jobsA = JSON.stringify(
    db.query("SELECT * FROM jobs ORDER BY job_id").all(),
  );
  const gitA = JSON.stringify(
    db.query("SELECT * FROM git_status ORDER BY project_dir").all(),
  );
  const epicsA = JSON.stringify(
    db.query("SELECT * FROM epics ORDER BY epic_id").all(),
  );

  // Re-fold the identical log from cursor=0 at batch=200 (the pre-fn-744 .2
  // size). Drop the projections, rewind, re-drain at the larger batch.
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM epics");
  __resetEpicIndexMemoForTest(db);
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  do {
    n = drain(db, 200);
  } while (n > 0);

  expect(getCursor()).toBe(cursorA);
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(jobsA);
  expect(
    JSON.stringify(
      db.query("SELECT * FROM git_status ORDER BY project_dir").all(),
    ),
  ).toBe(gitA);
  expect(
    JSON.stringify(db.query("SELECT * FROM epics ORDER BY epic_id").all()),
  ).toBe(epicsA);
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
    jobs: string;
    job_links: string;
    last_validated_at: string | null;
    // Schema v34 (fn-637): NULL = not-yet-computed; '[]' = computed, no deps.
    resolved_epic_deps: string | null;
    // Schema v32 (fn-634): VIRTUAL generated column SQLite computes from
    // `status` via `CASE WHEN status IS NOT NULL AND status='open' THEN 1 ELSE
    // 0 END` (fn-756 dropped the `approval` branch). `SELECT *` enumerates it
    // like any other column.
    default_visible: number;
    // Schema v104 (fn-1083 task .2): nullable TEXT carrying the epic-level
    // parked-closer question.
    question: string | null;
    // Schema v117 (fn-1216 task .1): nullable TEXT carrying the blocking
    // follow-up close-gate pointer (the source epic id a follow-up gates).
    blocks_closing_of: string | null;
  } | null;
}

/**
 * The element shape stored in `epics.tasks` as of schema v19. Schema v7
 * introduced the embedded array; v19 renamed `status` to `worker_phase` and
 * added the plan-native `runtime_status` sibling (defaults to `"todo"`).
 * (fn-756 dropped the `approval` element field.)
 */
interface EmbeddedTask {
  task_id: string;
  epic_id: string | null;
  task_number: number | null;
  title: string | null;
  target_repo: string | null;
  /**
   * Plan-native effort tier (fn-602): rides FREE in the embedded JSON
   * (no schema column, no SCHEMA_VERSION bump). Optional on the test
   * interface because pre-fn-602 events / serialised arrays lack the key;
   * the reducer reads `snapshot.tier ?? null` so a missing field folds to
   * `null` deterministically (graceful-degradation precedent shared with
   * `worker_phase`/`runtime_status`).
   */
  tier?: string | null;
  /**
   * Plan-native worker model (model axis of the worker matrix): rides FREE in
   * the embedded JSON alongside `tier` (no schema column). Optional for the same
   * graceful-degradation reason — a pre-model event folds `snapshot.model ?? null`.
   */
  model?: string | null;
  worker_phase?: string | null;
  runtime_status?: string;
  depends_on: string[];
  jobs?: unknown[];
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
    // No `plan_ref`-bearing jobs have folded into this epic yet → defaults to "[]".
    jobs: "[]",
    // No plan-invocation classifier edges have been folded yet → defaults to "[]".
    job_links: "[]",
    // No `last_validated_at` in the blob → folds to NULL (the schema column is
    // a plain nullable TEXT, no DEFAULT).
    last_validated_at: null,
    // Schema v34 (fn-637): the task-.3 forward stamp populates this
    // column from the shared `resolveEpicDep` helper inside the same
    // BEGIN IMMEDIATE transaction as the EpicSnapshot fold. A first-
    // sight epic with no `depends_on_epics` in the blob folds to '[]'
    // ("computed, no deps") — DISTINCT from `null` ("not-yet-computed")
    // which is the schema-v33→v34 transitional reading on a pre-fold
    // row.
    resolved_epic_deps: "[]",
    // Schema v32 (fn-634): default_visible is the VIRTUAL generated column.
    // fn-756 (v63) rewrote it to `status IS NOT NULL AND status='open'`;
    // status='open' → 1.
    default_visible: 1,
    // Schema v104 (fn-1083 task .2): no `question` in the blob → folds to
    // NULL (no parked closer question, the zero-event reading).
    question: null,
    // Schema v117 (fn-1216 task .1): no `blocks_closing_of` in the blob → folds
    // to NULL (an ordinary epic, not a blocking follow-up — the zero-event
    // reading).
    blocks_closing_of: null,
  });
  expect(epic?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("TaskSnapshot folds into the parent epic's tasks array with all element fields + derived worker_phase + runtime_status", () => {
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
    // fn-602: the producer ships `tier` (plan `low|medium|high|xhigh|max`)
    // verbatim from the task-def file's top-level `tier` field. Stored
    // opaque — the reducer never branches on the value.
    tier: "high",
    // The producer also ships `model` (the model axis of the worker matrix)
    // alongside `tier`; stored opaque and read `snapshot.model ?? null`.
    model: "opus",
    // Schema v19: the producer (plan-worker → daemon → synthetic event)
    // ships BOTH `worker_phase` (renamed from `status`) and `runtime_status`
    // (plan-native enum). The legacy `status` is still read defensively
    // (`worker_phase ?? status`) for re-fold determinism across the v18→v19
    // boundary, but new events ship the new key shape.
    worker_phase: "done",
    runtime_status: "in_progress",
  });
  drainAll();
  const task = getTask("fn-1-add-oauth.3");
  expect(task).toEqual({
    task_id: "fn-1-add-oauth.3",
    epic_id: "fn-1-add-oauth",
    task_number: 3,
    title: "Wire the callback",
    target_repo: "/Users/mike/code/keeper",
    tier: "high",
    model: "opus",
    worker_phase: "done",
    runtime_status: "in_progress",
    // No depends_on in the blob → the embedded element defaults to [].
    depends_on: [],
    // First-sight task element with no prior plan_ref-bearing jobs folded
    // into its embedded `jobs` sub-array → defaults to [] (schema v11).
    jobs: [],
  });
  // The fold bumps the parent epic's last_event_id (so it patches).
  expect(getEpic("fn-1-add-oauth")?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("fn-602: a pre-tier TaskSnapshot blob (no `tier` key) folds to `tier: null` on the embedded element (deterministic graceful degradation)", () => {
  // Re-fold determinism guard for fn-602: tier rides FREE in the
  // embedded-tasks JSON with no schema column and no SCHEMA_VERSION bump,
  // so historical TaskSnapshot events predate the field. The reducer reads
  // `snapshot.tier ?? null` and the embedded element initialises to `null`
  // — same graceful-degradation precedent as `worker_phase`/`runtime_status`
  // on the v18→v19 boundary, so a re-fold of the immutable event log
  // through the new reducer produces a byte-deterministic projection.
  epicSnapshotEvent("fn-602-decouple", {
    epic_number: 602,
    title: "Decouple",
    status: "open",
  });
  // Deliberately omit `tier` from the snapshot blob — this is the shape
  // every TaskSnapshot event in the log carries before fn-602.
  taskSnapshotEvent("fn-602-decouple.1", {
    epic_id: "fn-602-decouple",
    task_number: 1,
    title: "Project tier",
    target_repo: "/Users/mike/code/keeper",
    worker_phase: "open",
    runtime_status: "todo",
  });
  drainAll();
  const task = getTask("fn-602-decouple.1");
  expect(task?.tier).toBeNull();
  // Sanity-check that the other fields all populated normally — tier's null
  // default is the only graceful-degradation slot in play here.
  expect(task?.title).toBe("Project tier");
  expect(task?.worker_phase).toBe("open");
  expect(task?.runtime_status).toBe("todo");
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

// ---------------------------------------------------------------------------
// Schema v34 (fn-637): cross-epic dep projection — `resolved_epic_deps` +
// `epic_dep_edges`. The forward stamp + reverse fan-out maintain the
// projection inside the same BEGIN IMMEDIATE as the EpicSnapshot fold,
// and the EpicDeleted retract re-stamps downstream consumers to dangling.
// ---------------------------------------------------------------------------

/** Decode an epic's `resolved_epic_deps` JSON-TEXT column. NULL → null. */
function getResolvedEpicDeps(epicId: string): Array<{
  dep_token: string;
  resolved_epic_id: string | null;
  epic_number: number | null;
  project_basename: string | null;
  cross_project: boolean;
  state: "satisfied" | "blocked-incomplete" | "dangling";
}> | null {
  const row = db
    .query("SELECT resolved_epic_deps FROM epics WHERE epic_id = ?")
    .get(epicId) as { resolved_epic_deps: string | null } | null;
  if (row == null || row.resolved_epic_deps == null) {
    return null;
  }
  return JSON.parse(row.resolved_epic_deps);
}

test("fn-637: forward stamp on EpicSnapshot computes `resolved_epic_deps` for an empty deps list as '[]' (computed, no deps — distinct from NULL not-yet-computed)", () => {
  // A first-sight EpicSnapshot with no `depends_on_epics` in the blob lands
  // `resolved_epic_deps = '[]'` after the forward stamp runs, NOT NULL —
  // the column transitions from the "not-yet-computed" sentinel to the
  // "computed, no deps" terminal value inside the fold transaction.
  epicSnapshotEvent("fn-empty", {
    epic_number: 1,
    title: "Empty deps",
    project_dir: "/repo",
    status: "open",
  });
  drainAll();
  expect(getResolvedEpicDeps("fn-empty")).toEqual([]);
});

test("fn-637: forward stamp resolves a satisfied upstream (done + approved) to `state: satisfied`", () => {
  // Seed the upstream as done+approved FIRST (epicIsCompleted → true).
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Upstream",
    project_dir: "/repo",
    status: "done",
    approval: "approved",
  });
  // Then the consumer depending on the full upstream id.
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-1-up"],
  });
  drainAll();
  const resolved = getResolvedEpicDeps("fn-2-down");
  expect(resolved).toEqual([
    {
      dep_token: "fn-1-up",
      resolved_epic_id: "fn-1-up",
      epic_number: 1,
      project_basename: "repo",
      cross_project: false,
      state: "satisfied",
    },
  ]);
});

test("fn-637: forward stamp resolves a non-done upstream to `state: blocked-incomplete`", () => {
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Upstream",
    project_dir: "/repo",
    status: "open",
  });
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-1-up"],
  });
  drainAll();
  const resolved = getResolvedEpicDeps("fn-2-down");
  expect(resolved?.[0]?.state).toBe("blocked-incomplete");
});

test("fn-637: forward stamp resolves an unknown token to `state: dangling`", () => {
  epicSnapshotEvent("fn-1-down", {
    epic_number: 1,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-99-nonexistent"],
  });
  drainAll();
  const resolved = getResolvedEpicDeps("fn-1-down");
  expect(resolved).toEqual([
    {
      dep_token: "fn-99-nonexistent",
      resolved_epic_id: null,
      epic_number: null,
      project_basename: null,
      cross_project: false,
      state: "dangling",
    },
  ]);
});

test("fn-637: forward stamp rebuilds `epic_dep_edges` rows for the consumer", () => {
  epicSnapshotEvent("fn-1-down", {
    epic_number: 1,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-99-x", "fn-7"],
  });
  drainAll();
  const edges = db
    .query(
      "SELECT consumer_id, dep_token FROM epic_dep_edges WHERE consumer_id = ? ORDER BY dep_token",
    )
    .all("fn-1-down") as { consumer_id: string; dep_token: string }[];
  expect(edges).toEqual([
    { consumer_id: "fn-1-down", dep_token: "fn-7" },
    { consumer_id: "fn-1-down", dep_token: "fn-99-x" },
  ]);
});

test("fn-637: forward stamp full-recomputes `epic_dep_edges` on a re-snapshot (deletes old deps not in the new list)", () => {
  epicSnapshotEvent("fn-1-down", {
    epic_number: 1,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-7", "fn-8"],
  });
  drainAll();
  // Re-snapshot with a different deps list — the old fn-8 edge must drop.
  epicSnapshotEvent("fn-1-down", {
    epic_number: 1,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-7", "fn-9"],
  });
  drainAll();
  const tokens = (
    db
      .query(
        "SELECT dep_token FROM epic_dep_edges WHERE consumer_id = ? ORDER BY dep_token",
      )
      .all("fn-1-down") as { dep_token: string }[]
  ).map((r) => r.dep_token);
  expect(tokens).toEqual(["fn-7", "fn-9"]);
});

test("fn-637: reverse fan-out re-stamps a downstream consumer when the upstream completes (the core bug)", () => {
  // Consumer first — it sees a non-existent upstream and stamps `dangling`.
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-1-up"],
  });
  drainAll();
  expect(getResolvedEpicDeps("fn-2-down")?.[0]?.state).toBe("dangling");

  // Upstream appears in `open` state — re-resolves to `blocked-incomplete`.
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Upstream",
    project_dir: "/repo",
    status: "open",
  });
  drainAll();
  expect(getResolvedEpicDeps("fn-2-down")?.[0]?.state).toBe(
    "blocked-incomplete",
  );

  // Upstream flips to done+approved — re-stamp to satisfied in the SAME fold.
  // The reverse fan-out keyed on `dep_token IN (id, fn-number)` catches the
  // downstream consumer and re-resolves it through `enrichEpicDep`.
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Upstream",
    project_dir: "/repo",
    status: "done",
    approval: "approved",
  });
  drainAll();
  expect(getResolvedEpicDeps("fn-2-down")?.[0]?.state).toBe("satisfied");
});

test("fn-637: reverse fan-out catches bare-id (`fn-N`) consumers when the upstream's snapshot lands", () => {
  // Consumer depends on bare `fn-1` (no slug). Initially dangling.
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-1"],
  });
  drainAll();
  expect(getResolvedEpicDeps("fn-2-down")?.[0]?.state).toBe("dangling");

  // Upstream appears with epic_number=1. The reverse fan-out's
  // `dep_token IN (epic_id, 'fn-' || epic_number)` lookup matches the
  // bare-id consumer and re-stamps it.
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Upstream",
    project_dir: "/repo",
    status: "done",
    approval: "approved",
  });
  drainAll();
  const resolved = getResolvedEpicDeps("fn-2-down");
  expect(resolved?.[0]?.dep_token).toBe("fn-1");
  expect(resolved?.[0]?.resolved_epic_id).toBe("fn-1-up");
  expect(resolved?.[0]?.state).toBe("satisfied");
});

test("fn-637: a new same-number epic flips a bare-id consumer to `dangling` (ambiguity)", () => {
  // First upstream — bare-id consumer resolves to it.
  epicSnapshotEvent("fn-1-foo", {
    epic_number: 1,
    title: "Foo",
    project_dir: "/repo-a",
    status: "open",
  });
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo-a",
    status: "open",
    depends_on_epics: ["fn-1"],
  });
  drainAll();
  expect(getResolvedEpicDeps("fn-2-down")?.[0]?.resolved_epic_id).toBe(
    "fn-1-foo",
  );

  // Second upstream with the SAME epic_number lands in a different project.
  // Now `fn-1` is ambiguous; the consumer's own project_dir basename
  // disambiguates (so it stays on fn-1-foo). To force the ambiguity branch
  // we use a different project on the consumer that matches NEITHER
  // candidate.
  epicSnapshotEvent("fn-1-bar", {
    epic_number: 1,
    title: "Bar",
    project_dir: "/repo-b",
    status: "open",
  });
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo-c",
    status: "open",
    depends_on_epics: ["fn-1"],
  });
  drainAll();
  // 2+ candidates, no same-project disambiguator → ambiguous → dangling.
  expect(getResolvedEpicDeps("fn-2-down")?.[0]?.state).toBe("dangling");
});

test("fn-637: EpicDeleted re-stamps downstream consumers to `dangling`", () => {
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Upstream",
    project_dir: "/repo",
    status: "done",
    approval: "approved",
  });
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-1-up"],
  });
  drainAll();
  expect(getResolvedEpicDeps("fn-2-down")?.[0]?.state).toBe("satisfied");

  // Tombstone the upstream — the downstream consumer's matching entry
  // flips to dangling in the same fold via the reverse fan-out.
  insertEvent({
    hook_event: "EpicDeleted",
    session_id: "fn-1-up",
    data: JSON.stringify({}),
  });
  drainAll();
  expect(getResolvedEpicDeps("fn-2-down")?.[0]?.state).toBe("dangling");
});

test("fn-637: ON CONFLICT carve-out preserves `resolved_epic_deps` across a re-snapshot of the consumer (approval RPC round-trip)", () => {
  // Seed the upstream + downstream with a real dep, so the consumer's
  // resolved_epic_deps holds a non-trivial enriched entry.
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Upstream",
    project_dir: "/repo",
    status: "done",
    approval: "approved",
  });
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-1-up"],
  });
  drainAll();
  const before = getResolvedEpicDeps("fn-2-down");

  // Re-snapshot the consumer with the SAME depends_on_epics list. The forward
  // stamp re-runs and produces the same projection — the byte-identical
  // re-emit confirms the carve-out + the forward stamp are end-to-end stable.
  epicSnapshotEvent("fn-2-down", {
    epic_number: 2,
    title: "Downstream",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-1-up"],
  });
  drainAll();
  const after = getResolvedEpicDeps("fn-2-down");
  expect(after).toEqual(before);
});

test("fn-637: re-fold determinism — rewind + DELETE epics + DELETE epic_dep_edges + re-drain reproduces both projections byte-identically", () => {
  // Seed a mixed sequence: a satisfied upstream, a blocked-incomplete
  // upstream, a dangling consumer, plus a bare-id reverse fan-out, plus
  // an EpicDeleted.
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Up",
    project_dir: "/repo",
    status: "open",
  });
  epicSnapshotEvent("fn-2-up", {
    epic_number: 2,
    title: "Up2",
    project_dir: "/repo",
    status: "done",
    approval: "approved",
  });
  epicSnapshotEvent("fn-3-down", {
    epic_number: 3,
    title: "Down",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-1-up", "fn-2-up", "fn-99-missing"],
  });
  // Upstream flips to done+approved — downstream re-stamp.
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Up",
    project_dir: "/repo",
    status: "done",
    approval: "approved",
  });
  // Bare-id consumer + EpicDeleted on another upstream.
  epicSnapshotEvent("fn-4-bare", {
    epic_number: 4,
    title: "Bare",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-2"],
  });
  insertEvent({
    hook_event: "EpicDeleted",
    session_id: "fn-2-up",
    data: JSON.stringify({}),
  });
  drainAll();

  const beforeEpics = db
    .query(
      "SELECT epic_id, depends_on_epics, resolved_epic_deps FROM epics ORDER BY epic_id",
    )
    .all();
  const beforeEdges = db
    .query(
      "SELECT consumer_id, dep_token FROM epic_dep_edges ORDER BY consumer_id, dep_token",
    )
    .all();

  // Rewind + wipe + re-drain. Re-fold determinism: the post-rewind rows
  // must equal byte-for-byte the pre-rewind rows.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  __resetEpicIndexMemoForTest(db);
  db.run("DELETE FROM epic_dep_edges");
  drainAll();

  const afterEpics = db
    .query(
      "SELECT epic_id, depends_on_epics, resolved_epic_deps FROM epics ORDER BY epic_id",
    )
    .all();
  const afterEdges = db
    .query(
      "SELECT consumer_id, dep_token FROM epic_dep_edges ORDER BY consumer_id, dep_token",
    )
    .all();

  expect(afterEpics).toEqual(beforeEpics);
  expect(afterEdges).toEqual(beforeEdges);
});

test("fn-637: multiple deps preserve source order in `resolved_epic_deps` (mirrors `depends_on_epics`)", () => {
  // Source order is locked: the enriched entries appear in the same order
  // the consumer's `depends_on_epics` array lists them. A stable iteration
  // order is what readiness predicate 9 + the board pill consume.
  epicSnapshotEvent("fn-1-up", {
    epic_number: 1,
    title: "Up1",
    project_dir: "/repo",
    status: "open",
  });
  epicSnapshotEvent("fn-2-up", {
    epic_number: 2,
    title: "Up2",
    project_dir: "/repo",
    status: "done",
    approval: "approved",
  });
  epicSnapshotEvent("fn-3-down", {
    epic_number: 3,
    title: "Down",
    project_dir: "/repo",
    status: "open",
    depends_on_epics: ["fn-2-up", "fn-1-up", "fn-99-x"],
  });
  drainAll();
  const tokens = (getResolvedEpicDeps("fn-3-down") ?? []).map(
    (e) => e.dep_token,
  );
  expect(tokens).toEqual(["fn-2-up", "fn-1-up", "fn-99-x"]);
});

// ---------------------------------------------------------------------------
// last_validated_at folding (schema v16 — fn-599-epic-validation-pill)
// ---------------------------------------------------------------------------

test("EpicSnapshot folds `last_validated_at` into the epics row (explicit value)", () => {
  epicSnapshotEvent("fn-1-val", {
    epic_number: 1,
    title: "T",
    status: "open",
    last_validated_at: "2026-05-24T00:00:00Z",
  });
  drainAll();
  expect(getEpic("fn-1-val")?.last_validated_at).toBe("2026-05-24T00:00:00Z");
});

test("EpicSnapshot defaults missing `last_validated_at` to NULL on the projection", () => {
  // A blob from an older daemon build (no `last_validated_at` key) folds to
  // NULL — the schema column is plain nullable TEXT with no DEFAULT.
  epicSnapshotEvent("fn-2-val", {
    epic_number: 2,
    title: "T",
    status: "open",
  });
  drainAll();
  expect(getEpic("fn-2-val")?.last_validated_at).toBeNull();
});

test("EpicSnapshot ON CONFLICT updates `last_validated_at` (last-write-wins)", () => {
  epicSnapshotEvent("fn-3-val", {
    epic_number: 3,
    title: "T",
    status: "open",
    last_validated_at: "2026-05-23T00:00:00Z",
  });
  drainAll();
  expect(getEpic("fn-3-val")?.last_validated_at).toBe("2026-05-23T00:00:00Z");
  epicSnapshotEvent("fn-3-val", {
    epic_number: 3,
    title: "T",
    status: "open",
    last_validated_at: "2026-05-24T00:00:00Z",
  });
  drainAll();
  expect(getEpic("fn-3-val")?.last_validated_at).toBe("2026-05-24T00:00:00Z");
});

test("from-scratch re-fold reproduces `last_validated_at` byte-identically", () => {
  // Build a history exercising explicit + missing last_validated_at values.
  // Rewind + re-drain must reproduce the same row contents.
  epicSnapshotEvent("fn-4-val", {
    epic_number: 4,
    title: "E",
    status: "open",
    last_validated_at: "2026-05-24T00:00:00Z",
  });
  // An epic with no last_validated_at — exercises the NULL default path.
  epicSnapshotEvent("fn-5-val", {
    epic_number: 5,
    title: "E",
    status: "open",
  });
  drainAll();

  const before = db.query("SELECT * FROM epics ORDER BY epic_id").all();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  __resetEpicIndexMemoForTest(db);
  drainAll();

  const after = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(after).toEqual(before);
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
  __resetEpicIndexMemoForTest(db);
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
  // Schema v53 (fn-688): an EpicDeleted followed by a later TaskSnapshot
  // for the same epic_id is the deleted-epic resurrection vector this
  // change closes. The TaskSnapshot's shell-INSERT is now SUPPRESSED
  // by the `epic_tombstones` guard — a deleted epic stays deleted, even
  // when a later snapshot for one of its tasks lands (the task can't
  // place against a missing parent; it folds to a no-op). Pre-fn-688
  // this would have re-shelled `fn-3` as a NULL-scalar ghost row at
  // the top of `keeper board`; the assertion below proves the ghost
  // is gone.
  epicSnapshotEvent("fn-3", { epic_number: 3, title: "Gone", status: "open" });
  epicDeletedEvent("fn-3");
  taskSnapshotEvent("fn-3.1", {
    epic_id: "fn-3",
    task_number: 1,
    title: "Reborn",
  });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const tombstonesBefore = db
    .query("SELECT * FROM epic_tombstones ORDER BY epic_id")
    .all();
  expect(getTasks("fn-1").map((t) => t.task_id)).toEqual(["fn-1.2"]);
  // Schema v53 (fn-688): fn-3 is tombstoned; the later TaskSnapshot's
  // shell-INSERT is suppressed. The ghost row is gone.
  expect(getEpic("fn-3")).toBeNull();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  __resetEpicIndexMemoForTest(db);
  db.run("DELETE FROM epic_tombstones");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const tombstonesAfter = db
    .query("SELECT * FROM epic_tombstones ORDER BY epic_id")
    .all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(tombstonesAfter).toEqual(tombstonesBefore);
});

// ---------------------------------------------------------------------------
// Schema v53 (fn-688): epic_tombstones — deleted-epic resurrection guard
// ---------------------------------------------------------------------------

test("fn-688: EpicDeleted mints an epic_tombstones row carrying the delete event id", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  drainAll();
  expect(getEpic("fn-1")).not.toBeNull();
  const delId = epicDeletedEvent("fn-1");
  drainAll();

  // Epic row is gone (existing behavior).
  expect(getEpic("fn-1")).toBeNull();
  // New: tombstone exists, carries the delete event id (NOT wallclock).
  const tombstone = db
    .query(
      "SELECT epic_id, deleted_at_event_id FROM epic_tombstones WHERE epic_id = ?",
    )
    .get("fn-1") as { epic_id: string; deleted_at_event_id: number } | null;
  expect(tombstone).toEqual({ epic_id: "fn-1", deleted_at_event_id: delId });
});

test("fn-688: delete-before-snapshot still mints a tombstone (unconditional mint)", () => {
  // No EpicSnapshot — just an EpicDeleted. The reducer must still mint
  // (the delete vanishes the file on disk; we may never see the snapshot).
  const delId = epicDeletedEvent("fn-99");
  drainAll();
  const tombstone = db
    .query(
      "SELECT epic_id, deleted_at_event_id FROM epic_tombstones WHERE epic_id = ?",
    )
    .get("fn-99") as { epic_id: string; deleted_at_event_id: number } | null;
  expect(tombstone).toEqual({ epic_id: "fn-99", deleted_at_event_id: delId });
});

test("fn-688: double-delete is idempotent — tombstone preserves the FIRST delete event id", () => {
  epicSnapshotEvent("fn-2", { epic_number: 2, title: "E", status: "open" });
  drainAll();
  const firstDel = epicDeletedEvent("fn-2");
  drainAll();
  const secondDel = epicDeletedEvent("fn-2");
  drainAll();
  expect(firstDel).toBeLessThan(secondDel);
  const tombstone = db
    .query(
      "SELECT epic_id, deleted_at_event_id FROM epic_tombstones WHERE epic_id = ?",
    )
    .get("fn-2") as { epic_id: string; deleted_at_event_id: number } | null;
  // ON CONFLICT DO NOTHING — the first delete event id sticks.
  expect(tombstone).toEqual({ epic_id: "fn-2", deleted_at_event_id: firstDel });
});

test("fn-688: a re-creating EpicSnapshot clears the tombstone", () => {
  epicSnapshotEvent("fn-1", { epic_number: 1, title: "E", status: "open" });
  drainAll();
  epicDeletedEvent("fn-1");
  drainAll();
  // Tombstone present after the delete.
  expect(
    db
      .query("SELECT 1 AS hit FROM epic_tombstones WHERE epic_id = ?")
      .get("fn-1"),
  ).not.toBeNull();
  // Re-create.
  epicSnapshotEvent("fn-1", {
    epic_number: 1,
    title: "Reborn",
    status: "open",
  });
  drainAll();
  // Tombstone is cleared; the new row landed.
  expect(
    db
      .query("SELECT 1 AS hit FROM epic_tombstones WHERE epic_id = ?")
      .get("fn-1"),
  ).toBeNull();
  expect(getEpic("fn-1")?.title).toBe("Reborn");
});

test("fn-688: TaskSnapshot shell-INSERT for a tombstoned epic is suppressed (no scalar-NULL ghost)", () => {
  epicSnapshotEvent("fn-3", { epic_number: 3, title: "E", status: "open" });
  drainAll();
  epicDeletedEvent("fn-3");
  drainAll();
  // A later TaskSnapshot whose epic_id points at the tombstoned epic:
  // the guard suppresses the shell-INSERT.
  taskSnapshotEvent("fn-3.1", {
    epic_id: "fn-3",
    task_number: 1,
    title: "Orphan",
  });
  drainAll();
  // No ghost row.
  expect(getEpic("fn-3")).toBeNull();
});

test("fn-688: legit job-before-epic shell still lands for a NEVER-deleted epic", () => {
  // The legitimate shell-INSERT path the guard must NOT break. A
  // SessionStart with `spawn_name = plan::fn-688-pristine` fans into
  // the epic-kind syncJobIntoEpic arm; no tombstone exists, the shell
  // is created.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-legit",
    spawn_name: "plan::fn-688-pristine",
  });
  drainAll();
  const row = getEpic("fn-688-pristine");
  expect(row).not.toBeNull();
  // Shell scalars are NULL (matches pre-fn-688 legit-shell shape).
  expect(row?.epic_number).toBeNull();
  expect(row?.title).toBeNull();
  // The embedded job element is present.
  const jobs = getEpicJobs("fn-688-pristine");
  expect(jobs.length).toBe(1);
  expect(jobs[0]?.job_id).toBe("sess-legit");
});

test("fn-688: shell -> delete -> shell skips the second shell (tombstone blocks resurrection)", () => {
  // SessionStart creates a shell (job-before-epic vector).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-a",
    spawn_name: "plan::fn-688-shelled",
  });
  drainAll();
  expect(getEpic("fn-688-shelled")).not.toBeNull();
  // Delete the shell.
  epicDeletedEvent("fn-688-shelled");
  drainAll();
  expect(getEpic("fn-688-shelled")).toBeNull();
  // Another SessionStart for the same epic — the second shell is
  // BLOCKED by the tombstone (resurrection guard).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-b",
    spawn_name: "plan::fn-688-shelled",
  });
  drainAll();
  expect(getEpic("fn-688-shelled")).toBeNull();
});

test("fn-688: delete -> recreate -> job-fold lands the shell again (tombstone cleared)", () => {
  epicSnapshotEvent("fn-688-revive", {
    epic_number: 9,
    title: "E",
    status: "open",
  });
  drainAll();
  epicDeletedEvent("fn-688-revive");
  drainAll();
  // Re-create the epic — clears the tombstone.
  epicSnapshotEvent("fn-688-revive", {
    epic_number: 9,
    title: "Back",
    status: "open",
  });
  drainAll();
  // After recreate, the epic row is present; a later SessionStart
  // UPDATES the existing row's `jobs` array (no shell INSERT needed,
  // so the tombstone guard is not even consulted — the gate's
  // `epicRow == null` branch never fires).
  expect(getEpic("fn-688-revive")).not.toBeNull();
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-c",
    spawn_name: "plan::fn-688-revive",
  });
  drainAll();
  // The job folded into the existing (now-revived) row.
  expect(getEpicJobs("fn-688-revive").length).toBe(1);
});

test("fn-688: from-scratch re-fold reproduces the full delete -> job-fold -> recreate -> job-fold interleaving byte-identically", () => {
  // The reproduction sequence + a recreate + a second job-fold. Live
  // drain vs. rewind+wipe(+epic_tombstones)+redrain produce
  // byte-identical `epics` and `epic_tombstones` rows.
  epicSnapshotEvent("fn-688-ghost", {
    epic_number: 100,
    title: "Ghost",
    status: "open",
  });
  taskSnapshotEvent("fn-688-ghost.1", {
    epic_id: "fn-688-ghost",
    task_number: 1,
    title: "One",
  });
  taskSnapshotEvent("fn-688-ghost.2", {
    epic_id: "fn-688-ghost",
    task_number: 2,
    title: "Two",
  });
  epicDeletedEvent("fn-688-ghost");
  taskDeletedEvent("fn-688-ghost.1", "fn-688-ghost");
  // Job-side fold whose plan_ref points at the now-deleted epic — the
  // canonical ghost-resurrection vector.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-orphan",
    spawn_name: "approve::fn-688-ghost",
  });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-orphan" });
  // Re-create the epic — clears tombstone.
  epicSnapshotEvent("fn-688-ghost", {
    epic_number: 100,
    title: "Reborn",
    status: "open",
  });
  // Another job-fold — folds into the existing row.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-revive",
    spawn_name: "plan::fn-688-ghost",
  });
  drainAll();

  // Capture live state.
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const tombstonesBefore = db
    .query("SELECT * FROM epic_tombstones ORDER BY epic_id")
    .all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  // Rewind + wipe (INCLUDING epic_tombstones) + redrain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  __resetEpicIndexMemoForTest(db);
  db.run("DELETE FROM epic_tombstones");
  db.run("DELETE FROM subagent_invocations");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const tombstonesAfter = db
    .query("SELECT * FROM epic_tombstones ORDER BY epic_id")
    .all();
  const jobsAfter = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  expect(epicsAfter).toEqual(epicsBefore);
  expect(tombstonesAfter).toEqual(tombstonesBefore);
  expect(jobsAfter).toEqual(jobsBefore);
});

test("fn-688: the ghost-event sequence yields ZERO scalar-NULL epic rows", () => {
  // The exact repro from fn-637-throwaway-verify-fn-6356 (the bug):
  // EpicSnapshot, TaskSnapshot x2, EpicDeleted, TaskDeleted,
  // SessionEnd-approve whose plan_ref points at the deleted epic.
  // Pre-fn-688, this left a scalar-NULL "ghost" row on `epics`.
  epicSnapshotEvent("fn-688-bug", {
    epic_number: 637,
    title: "Bug",
    status: "open",
  });
  taskSnapshotEvent("fn-688-bug.1", {
    epic_id: "fn-688-bug",
    task_number: 1,
    title: "T1",
  });
  taskSnapshotEvent("fn-688-bug.2", {
    epic_id: "fn-688-bug",
    task_number: 2,
    title: "T2",
  });
  epicDeletedEvent("fn-688-bug");
  taskDeletedEvent("fn-688-bug.1", "fn-688-bug");
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-approve",
    spawn_name: "approve::fn-688-bug",
  });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-approve" });
  drainAll();

  // The acceptance assertion from the task spec:
  // `SELECT * FROM epics WHERE epic_id = '<deleted>'` returns zero rows.
  expect(getEpic("fn-688-bug")).toBeNull();

  // Generalised: no scalar-NULL ghost rows anywhere.
  const ghosts = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM epics WHERE title IS NULL AND epic_number IS NULL",
      )
      .get() as { n: number }
  ).n;
  expect(ghosts).toBe(0);
});
