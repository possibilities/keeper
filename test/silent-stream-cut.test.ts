/**
 * SILENT_STREAM_CUT detector reducer folds.
 *
 * Covers the keeper-side drop-recovery path: a subagent whose turn the harness
 * terminates mid-stream (between a tool_result and the model's next API
 * response) emits a `SubagentStop` with NO `Killed`/`ApiError`/`SessionEnd`. The
 * transcript worker mints a synthetic `SubagentTurn` event carrying the cut
 * disposition; the reducer's SubagentStop / SubagentTurn arms recognize it and
 * flip the still-`working` parent job to `stopped` so readiness re-dispatches
 * the dropped task faster than the ~60s dead-pid reprobe.
 *
 * Fixtures are shaped after the observed evidence signatures: the `cut` case
 * is a last assistant `stop_reason='tool_use'` with a dangling tool_result and
 * no terminal text; the `clean` negative control is `stop_reason='end_turn'`
 * with terminal text.
 *
 * Uses `freshMemDb` (the migrated `:memory:` template clone) so the migration
 * ladder is paid once per process; folds run through the real `applyEvent` /
 * `drain` so the BEGIN-IMMEDIATE + cursor-advance path is exercised end to end.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
});

let tsCounter = 1_000;

/**
 * Insert one event row with sane sparse-column defaults; only the columns the
 * lifecycle / subagent folds read are settable. Returns the auto-assigned id;
 * `ts` auto-increments so total order is stable.
 */
function insertEvent(overrides: {
  hook_event: string;
  session_id?: string;
  agent_id?: string | null;
  agent_type?: string | null;
  pid?: number | null;
  spawn_name?: string | null;
  data?: string;
  ts?: number;
}): number {
  const ts = overrides.ts ?? tsCounter++;
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, matcher, cwd,
       permission_mode, agent_id, agent_type, stop_hook_active, data,
       subagent_agent_id, spawn_name, start_time, slash_command, skill_name,
       plan_op, plan_target, plan_epic_id, plan_task_id,
       plan_subject_present, tool_use_id, config_dir,
       bash_mutation_kind, bash_mutation_targets, plan_files,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
       background_task_id
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, '/tmp/work', NULL, ?, ?, NULL, ?,
       NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
    [
      ts,
      overrides.session_id ?? "sess-a",
      "pid" in overrides ? (overrides.pid ?? null) : 4242,
      overrides.hook_event,
      overrides.hook_event,
      overrides.agent_id ?? null,
      overrides.agent_type ?? null,
      overrides.data ?? "{}",
      overrides.spawn_name ?? null,
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
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

function jobState(jobId = "sess-a"): string | null {
  const row = db
    .query("SELECT state FROM jobs WHERE job_id = ?")
    .get(jobId) as { state: string } | null;
  return row?.state ?? null;
}

function subRow(jobId: string, agentId: string) {
  return db
    .query(
      `SELECT status, duration_ms, last_disposition FROM subagent_invocations
        WHERE job_id = ? AND agent_id = ? ORDER BY turn_seq DESC LIMIT 1`,
    )
    .get(jobId, agentId) as {
    status: string;
    duration_ms: number | null;
    last_disposition: string | null;
  } | null;
}

/**
 * Drive a parent worker session into the live `working` state with one running
 * subagent. Returns nothing — leaves `sess-a` `working` and an open turn-0
 * subagent row for `agent_id`.
 */
function seedWorkingWithSubagent(agentId: string): void {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  // UserPromptSubmit flips the parent to 'working' (the live worker state the
  // drop recovery must clear).
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-a" });
  insertEvent({
    hook_event: "SubagentStart",
    session_id: "sess-a",
    agent_id: agentId,
    agent_type: "work:worker-high",
  });
}

// ---------------------------------------------------------------------------

test("cut disposition then SubagentStop flips the still-working parent to stopped", () => {
  seedWorkingWithSubagent("agent-cut");
  // Transcript worker observed the last assistant turn as a stream cut.
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-cut",
    data: JSON.stringify({ disposition: "cut", settled: true }),
  });
  // Then the harness emits SubagentStop with no terminal error.
  insertEvent({
    hook_event: "SubagentStop",
    session_id: "sess-a",
    agent_id: "agent-cut",
  });
  drainAll();

  // Parent flipped working → stopped: readiness predicate 5 clears, the dropped
  // task re-dispatches without the dead-pid reprobe.
  expect(jobState()).toBe("stopped");
  const sub = subRow("sess-a", "agent-cut");
  expect(sub?.last_disposition).toBe("cut");
  expect(sub?.duration_ms).not.toBeNull(); // turn closed by SubagentStop
});

test("clean (end_turn) turn then SubagentStop leaves the parent working (negative control)", () => {
  seedWorkingWithSubagent("agent-clean");
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-clean",
    data: JSON.stringify({ disposition: "clean" }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    session_id: "sess-a",
    agent_id: "agent-clean",
  });
  drainAll();

  // No false-positive: a cleanly-completed subagent turn does NOT drop the
  // parent. The parent stays 'working' (its own Stop/SessionEnd governs it).
  expect(jobState()).toBe("working");
  expect(subRow("sess-a", "agent-clean")?.last_disposition).toBe("clean");
});

test("an intermediate cut, SubagentStop, then clean settlement never stops the parent", () => {
  seedWorkingWithSubagent("agent-provisional");
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-provisional",
    data: JSON.stringify({ disposition: "cut", settled: false }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    session_id: "sess-a",
    agent_id: "agent-provisional",
  });
  drainAll();
  expect(jobState()).toBe("working");
  expect(subRow("sess-a", "agent-provisional")?.last_disposition).toBeNull();

  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-provisional",
    data: JSON.stringify({ disposition: "clean", settled: true }),
  });
  drainAll();
  expect(jobState()).toBe("working");
  expect(subRow("sess-a", "agent-provisional")?.last_disposition).toBe("clean");
});

test("SubagentStop before intermediate cut and clean settlement also stays working", () => {
  seedWorkingWithSubagent("agent-reordered-clean");
  insertEvent({
    hook_event: "SubagentStop",
    session_id: "sess-a",
    agent_id: "agent-reordered-clean",
  });
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-reordered-clean",
    data: JSON.stringify({ disposition: "cut", settled: false }),
  });
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-reordered-clean",
    data: JSON.stringify({ disposition: "clean", settled: true }),
  });
  drainAll();
  expect(jobState()).toBe("working");
  expect(subRow("sess-a", "agent-reordered-clean")?.last_disposition).toBe(
    "clean",
  );
});

test("SubagentStop with NO disposition stamped leaves the parent working", () => {
  // The disposition fact never folded (no SubagentTurn) — the SubagentStop fold
  // must not invent a cut. Parent stays working.
  seedWorkingWithSubagent("agent-none");
  insertEvent({
    hook_event: "SubagentStop",
    session_id: "sess-a",
    agent_id: "agent-none",
  });
  drainAll();
  expect(jobState()).toBe("working");
  expect(subRow("sess-a", "agent-none")?.last_disposition).toBeNull();
});

test("race tail: a cut SubagentTurn landing AFTER SubagentStop still flips the parent", () => {
  seedWorkingWithSubagent("agent-race");
  // SubagentStop closes the turn FIRST (the disposition hasn't folded yet).
  insertEvent({
    hook_event: "SubagentStop",
    session_id: "sess-a",
    agent_id: "agent-race",
  });
  drainAll();
  // At this point the parent is still working (no disposition was known).
  expect(jobState()).toBe("working");

  // The cut disposition lands AFTER the close — the SubagentTurn arm performs
  // the flip itself (target turn already has a non-null duration_ms).
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-race",
    data: JSON.stringify({ disposition: "cut", settled: true }),
  });
  drainAll();
  expect(jobState()).toBe("stopped");
});

test("no false-positive: a parent already moved off working (api_error) is left as-is", () => {
  seedWorkingWithSubagent("agent-apierr");
  // An ApiError already flipped the parent to 'stopped' (its sub-running guard
  // notwithstanding, model it as already-stopped here). Use a real ApiError on
  // a parent with no running subagent guard by closing the sub first.
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-apierr",
    data: JSON.stringify({ disposition: "cut" }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    session_id: "sess-a",
    agent_id: "agent-apierr",
  });
  drainAll();
  // The cut flipped working → stopped. A SECOND drain of the same shape is a
  // no-op (idempotent: the still-`working` guard finds nothing to flip).
  expect(jobState()).toBe("stopped");
  const before = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = 'sess-a'")
    .get() as { last_event_id: number };
  // Re-fire a redundant cut SubagentTurn — must not re-flip / re-fan.
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-apierr",
    data: JSON.stringify({ disposition: "cut" }),
  });
  drainAll();
  const after = db
    .query("SELECT state, last_event_id FROM jobs WHERE job_id = 'sess-a'")
    .get() as { state: string; last_event_id: number };
  expect(after.state).toBe("stopped");
  // The disposition stamp bumps last_event_id on the subagent row, but the jobs
  // row's state UPDATE is guarded on `state='working'` so the jobs row is NOT
  // re-touched by the redundant cut (the guard found it already 'stopped').
  expect(after.last_event_id).toBe(before.last_event_id);
});

test("re-fold determinism: the cut-drop path re-folds byte-identical from cursor=0", () => {
  seedWorkingWithSubagent("agent-cut");
  insertEvent({
    hook_event: "SubagentTurn",
    session_id: "sess-a",
    agent_id: "agent-cut",
    data: JSON.stringify({ disposition: "cut" }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    session_id: "sess-a",
    agent_id: "agent-cut",
  });
  drainAll();

  const cursor1 = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  const jobs1 = JSON.stringify(
    db.query("SELECT * FROM jobs ORDER BY job_id").all(),
  );
  const subs1 = JSON.stringify(
    db
      .query(
        "SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq",
      )
      .all(),
  );

  // Re-fold from scratch: drop the projections, rewind the cursor, re-drain.
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM subagent_invocations");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  drainAll();

  expect(
    (
      db
        .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
        .get() as {
        last_event_id: number;
      }
    ).last_event_id,
  ).toBe(cursor1);
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(jobs1);
  expect(
    JSON.stringify(
      db
        .query(
          "SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq",
        )
        .all(),
    ),
  ).toBe(subs1);
});
