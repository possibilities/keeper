/**
 * Reducer tests — shard 3 of 4 (fn-769 fast-tier split of the former
 * monolithic reducer.test.ts). Theme: embedded jobs, plan-link fan-out, subagent / input-request / notification projections.
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
import { drain } from "../src/reducer";
import type { Event } from "../src/types";
import { deriveSeedMutationPath } from "./helpers/seed-mutation-path";
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
    data: overrides.data ?? "{}",
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
    // Schema v73 / fn-836: promoted git-attribution column. Honor an EXPLICIT
    // override; otherwise DERIVE it from `data` via the same pure deriver the
    // live hook + ingester run, so a seeded mutation row carries `mutation_path`
    // exactly as a production row does — the post-flip attribution scan reads
    // the COLUMN, not the JSON body.
    mutation_path:
      "mutation_path" in overrides
        ? (overrides.mutation_path ?? null)
        : deriveSeedMutationPath(
            overrides.hook_event,
            overrides.tool_name ?? null,
            overrides.data ?? "{}",
          ),
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
       background_task_id, mutation_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.mutation_path,
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

const TEST_OID = "0123456789abcdef0123456789abcdef01234567";

const TEST_OID_2 = "fedcba9876543210fedcba9876543210fedcba98";

const TEST_UUID = "01234567-89ab-cdef-0123-456789abcdef";

const TEST_UUID_2 = "fedcba98-7654-3210-fedc-ba9876543210";

function drainAll(): number {
  let total = 0;
  let n: number;
  do {
    n = drain(db);
    total += n;
  } while (n > 0);
  return total;
}

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
  worker_phase?: string | null;
  runtime_status?: string;
  depends_on: string[];
  jobs?: unknown[];
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
  } | null;
}

function getTasks(epicId: string): EmbeddedTask[] {
  const row = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get(epicId) as { tasks: string | null } | null;
  if (row == null || row.tasks == null || row.tasks.length === 0) {
    return [];
  }
  return JSON.parse(row.tasks) as EmbeddedTask[];
}

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

// ---------------------------------------------------------------------------
// Embedded jobs (syncJobIntoEpic): schema v11
// ---------------------------------------------------------------------------

/** Helper: read an epic's embedded `jobs` array (NULL/missing → []). */
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

/** Helper: read a task element's embedded `jobs` sub-array (NULL/missing → []). */
function getTaskJobs(taskId: string): {
  job_id: string;
  plan_verb: string;
  state: string;
  title: string | null;
  created_at: number;
  updated_at: number;
  last_event_id: number;
}[] {
  const task = getTask(taskId);
  if (task == null || !Array.isArray(task.jobs)) {
    return [];
  }
  return task.jobs as ReturnType<typeof getTaskJobs>;
}

test("SessionStart with epic-level plan_ref fans into epic.jobs (verb plan)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-plan",
    spawn_name: "plan::fn-575-osc-parser",
  });
  drainAll();
  const jobs = getEpicJobs("fn-575-osc-parser");
  expect(jobs.length).toBe(1);
  expect(jobs[0]?.job_id).toBe("sess-plan");
  expect(jobs[0]?.plan_verb).toBe("plan");
  expect(jobs[0]?.state).toBe("stopped");
  expect(jobs[0]?.title).toBe("plan::fn-575-osc-parser");
  expect(getTasks("fn-575-osc-parser")).toEqual([]);
});

test("SessionStart with epic-level plan_ref fans into epic.jobs (verb close)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-close",
    spawn_name: "close::fn-9-bar",
  });
  drainAll();
  const jobs = getEpicJobs("fn-9-bar");
  expect(jobs.length).toBe(1);
  expect(jobs[0]?.plan_verb).toBe("close");
});

test("SessionStart with task-level plan_ref fans into task.jobs (verb work)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-work",
    spawn_name: "work::fn-575-foo.3",
  });
  drainAll();
  const epic = getEpic("fn-575-foo");
  expect(epic).not.toBeNull();
  expect(epic?.epic_number).toBeNull();
  expect(epic?.title).toBeNull();
  expect(getEpicJobs("fn-575-foo")).toEqual([]);
  const tasks = getTasks("fn-575-foo");
  expect(tasks.length).toBe(1);
  expect(tasks[0]?.task_id).toBe("fn-575-foo.3");
  const taskJobs = getTaskJobs("fn-575-foo.3");
  expect(taskJobs.length).toBe(1);
  expect(taskJobs[0]?.job_id).toBe("sess-work");
  expect(taskJobs[0]?.plan_verb).toBe("work");
  expect(taskJobs[0]?.state).toBe("stopped");
});

test("SessionEnd on a plan_ref job updates the embedded entry's state to ended", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-end",
    spawn_name: "plan::fn-1-foo",
  });
  drainAll();
  expect(getEpicJobs("fn-1-foo")[0]?.state).toBe("stopped");
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-end" });
  drainAll();
  expect(getEpicJobs("fn-1-foo")[0]?.state).toBe("ended");
});

test("UserPromptSubmit on a plan_ref job updates embedded state to working", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-ups",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ups" });
  drainAll();
  const taskJobs = getTaskJobs("fn-1-foo.1");
  expect(taskJobs[0]?.state).toBe("working");
});

test("fn-1056: the bare tool-event un-stop of a plan_ref job fans into the embedded task entry (stopped → working)", () => {
  // A plan_ref job dropped to 'stopped' by a plain Stop must revive its embedded
  // task.jobs mirror when a tool event un-stops it — the new arm's syncIfPlanRef
  // fan-out is gated on changes > 0 exactly like the sibling arms.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-unstop-fan",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-unstop-fan",
  });
  insertEvent({ hook_event: "Stop", session_id: "sess-unstop-fan" });
  drainAll();
  expect(getTaskJobs("fn-1-foo.1")[0]?.state).toBe("stopped");

  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-unstop-fan",
  });
  drainAll();
  // The embedded mirror followed the jobs-row un-stop.
  expect(getTaskJobs("fn-1-foo.1")[0]?.state).toBe("working");
});

test("title change on a plan_ref job propagates to the embedded entry", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-title",
    spawn_name: "plan::fn-1-bar",
  });
  drainAll();
  expect(getEpicJobs("fn-1-bar")[0]?.title).toBe("plan::fn-1-bar");
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-title",
    data: JSON.stringify({ session_title: "Real Title" }),
  });
  drainAll();
  expect(getEpicJobs("fn-1-bar")[0]?.title).toBe("Real Title");
});

test("Killed-mismatch path does NOT fan into the embedded entry", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-killed",
    pid: 1234,
    start_time: "real-start",
    spawn_name: "close::fn-7-x",
  });
  drainAll();
  const before = getEpicJobs("fn-7-x")[0];
  expect(before?.state).toBe("stopped");
  const beforeEventId = before?.last_event_id;
  // A Killed event with the WRONG (pid, start_time) — stale/recycled.
  insertEvent({
    hook_event: "Killed",
    session_id: "sess-killed",
    data: JSON.stringify({ pid: 9999, start_time: "wrong-start" }),
  });
  drainAll();
  // The jobs row stayed unchanged → no sync fired, embedded entry stayed put.
  const after = getEpicJobs("fn-7-x")[0];
  expect(after?.state).toBe("stopped");
  expect(after?.last_event_id).toBe(beforeEventId ?? 0);
});

test("Killed matching path DOES fan into the embedded entry (state -> killed)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-killed-match",
    pid: 1234,
    start_time: "real-start",
    spawn_name: "close::fn-8-y",
  });
  drainAll();
  insertEvent({
    hook_event: "Killed",
    session_id: "sess-killed-match",
    data: JSON.stringify({ pid: 1234, start_time: "real-start" }),
  });
  drainAll();
  expect(getEpicJobs("fn-8-y")[0]?.state).toBe("killed");
});

test("an invalid plan_ref shape never throws and the cursor still advances", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-bad",
    spawn_name: "work::not_a_ref!",
  });
  drainAll();
  expect(getCursor()).toBeGreaterThan(0);
});

test("Stop on a still-terminal job does NOT fan (no write happened)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-stop-terminal",
    spawn_name: "plan::fn-2-z",
  });
  insertEvent({
    hook_event: "SessionEnd",
    session_id: "sess-stop-terminal",
  });
  drainAll();
  const beforeId = getEpicJobs("fn-2-z")[0]?.last_event_id;
  expect(getEpicJobs("fn-2-z")[0]?.state).toBe("ended");
  insertEvent({ hook_event: "Stop", session_id: "sess-stop-terminal" });
  drainAll();
  expect(getEpicJobs("fn-2-z")[0]?.state).toBe("ended");
  expect(getEpicJobs("fn-2-z")[0]?.last_event_id).toBe(beforeId ?? 0);
});

test("multiple plan_ref jobs sort (created_at desc, job_id asc)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-a-id",
    spawn_name: "plan::fn-1-multi",
    ts: 1000,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-b-id",
    spawn_name: "plan::fn-1-multi",
    ts: 2000,
  });
  drainAll();
  const jobs = getEpicJobs("fn-1-multi");
  expect(jobs.map((j) => j.job_id)).toEqual(["sess-b-id", "sess-a-id"]);

  insertEvent({
    hook_event: "SessionStart",
    session_id: "alpha",
    spawn_name: "plan::fn-1-tie",
    ts: 5000,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "beta",
    spawn_name: "plan::fn-1-tie",
    ts: 5000,
  });
  drainAll();
  expect(getEpicJobs("fn-1-tie").map((j) => j.job_id)).toEqual([
    "alpha",
    "beta",
  ]);
});

test("EpicSnapshot ON CONFLICT preserves epic.jobs (carve-out works)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-shell",
    spawn_name: "plan::fn-1-shell",
  });
  drainAll();
  expect(getEpicJobs("fn-1-shell").length).toBe(1);
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-1-shell",
    data: JSON.stringify({
      epic_number: 1,
      title: "Real",
      project_dir: "/repo",
      status: "open",
    }),
  });
  drainAll();
  const epic = getEpic("fn-1-shell");
  expect(epic?.title).toBe("Real");
  expect(epic?.status).toBe("open");
  expect(getEpicJobs("fn-1-shell").length).toBe(1);
  expect(getEpicJobs("fn-1-shell")[0]?.job_id).toBe("sess-shell");
});

test("TaskSnapshot RMW preserves the task element's jobs sub-array", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-pre-task",
    spawn_name: "work::fn-5-pre.2",
  });
  drainAll();
  expect(getTaskJobs("fn-5-pre.2").length).toBe(1);
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-5-pre.2",
    data: JSON.stringify({
      epic_id: "fn-5-pre",
      task_number: 2,
      title: "Real Task",
      target_repo: "/repo",
      // Schema v19: ship the new field names; the reducer also reads the
      // legacy `status` defensively (`worker_phase ?? status`) for re-fold
      // determinism across the boundary.
      worker_phase: "open",
      runtime_status: "todo",
    }),
  });
  drainAll();
  const task = getTask("fn-5-pre.2");
  expect(task?.title).toBe("Real Task");
  expect(task?.worker_phase).toBe("open");
  expect(task?.runtime_status).toBe("todo");
  expect(getTaskJobs("fn-5-pre.2").length).toBe(1);
  expect(getTaskJobs("fn-5-pre.2")[0]?.job_id).toBe("sess-pre-task");
});

test("syncJobIntoEpic carve-out preserves worker_phase + runtime_status across a jobs-write fan-out (schema v19)", () => {
  // The OLD-element carve-out at `reducer.ts:syncJobIntoEpic` spreads the
  // prior task element's scalars when re-attaching the freshly-merged jobs
  // sub-array (`{ ...oldTask, jobs: nextTaskJobs }`). Schema v19 added two
  // new scalar fields (`worker_phase` + `runtime_status`); without the spread
  // they'd be stomped to NULL/"todo" on every job tick. This test pins the
  // invariant: fold a TaskSnapshot first (planting both fields), then drive
  // a jobs-write that fans into the same task's embedded `jobs` sub-array,
  // and assert both fields survive verbatim.

  // 1. Plant a TaskSnapshot carrying both new fields. The reducer writes
  // the embedded task element with `worker_phase: "done"` and
  // `runtime_status: "in_progress"`.
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-5-carve.3",
    data: JSON.stringify({
      epic_id: "fn-5-carve",
      task_number: 3,
      title: "Carve task",
      target_repo: "/repo",
      worker_phase: "done",
      runtime_status: "in_progress",
    }),
  });
  drainAll();
  // Sanity: the snapshot landed.
  const before = getTask("fn-5-carve.3");
  expect(before?.worker_phase).toBe("done");
  expect(before?.runtime_status).toBe("in_progress");

  // 2. Drive a `work::` SessionStart whose `spawn_name` keys this task —
  // the jobs row inserts with `plan_ref` set, `syncIfPlanRef` fires, and
  // `syncJobIntoEpic` runs the OLD-element spread.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-carve-worker",
    spawn_name: "work::fn-5-carve.3",
  });
  drainAll();

  // 3. The carve-out invariant: BOTH new scalars must survive the fan-out
  // verbatim. A regression here (e.g. an inline rebuild that omits the
  // spread) would stomp them to NULL / "todo".
  const after = getTask("fn-5-carve.3");
  expect(after?.worker_phase).toBe("done");
  expect(after?.runtime_status).toBe("in_progress");
  // And the jobs sub-array picked up the new session.
  expect(getTaskJobs("fn-5-carve.3").length).toBe(1);
  expect(getTaskJobs("fn-5-carve.3")[0]?.job_id).toBe("sess-carve-worker");
});

test("TaskSnapshot reducer defensively folds a legacy `status` blob (no `worker_phase`/`runtime_status`) so pre-v19 events re-fold deterministically", () => {
  // Re-fold determinism across the v18→v19 boundary: the immutable event
  // log carries pre-v19 TaskSnapshot blobs that have `status: "open"` and
  // NO `worker_phase` / `runtime_status` keys. The reducer reads
  // `worker_phase ?? status` (= "open") and defaults `runtime_status` to
  // "todo" per plan's `merge_task_state` convention. Without those
  // defensive reads, a from-scratch re-fold of an existing DB would either
  // throw or land NULL on the embedded element, breaking the byte-identical
  // re-fold invariant.
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-5-legacy.1",
    data: JSON.stringify({
      epic_id: "fn-5-legacy",
      task_number: 1,
      title: "Legacy",
      target_repo: "/repo",
      // Note: legacy `status` key only, no v19 keys.
      status: "open",
    }),
  });
  drainAll();
  const task = getTask("fn-5-legacy.1");
  expect(task?.worker_phase).toBe("open");
  expect(task?.runtime_status).toBe("todo");
});

test("dual-array fan-out: epic.jobs + task.jobs co-populated, survive EpicSnapshot ON CONFLICT", () => {
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-1-dual",
    data: JSON.stringify({ epic_number: 1, title: "Dual", status: "open" }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-dual-plan",
    spawn_name: "plan::fn-1-dual",
    ts: 100,
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-1-dual.1",
    data: JSON.stringify({
      epic_id: "fn-1-dual",
      task_number: 1,
      title: "Dual T1",
      status: "open",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-dual-work",
    spawn_name: "work::fn-1-dual.1",
    ts: 200,
  });
  drainAll();

  const epicJobsBefore = getEpicJobs("fn-1-dual");
  const taskJobsBefore = getTaskJobs("fn-1-dual.1");
  expect(epicJobsBefore.length).toBe(1);
  expect(epicJobsBefore[0]?.job_id).toBe("sess-dual-plan");
  expect(taskJobsBefore.length).toBe(1);
  expect(taskJobsBefore[0]?.job_id).toBe("sess-dual-work");

  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-1-dual",
    data: JSON.stringify({
      epic_number: 1,
      title: "Dual Updated",
      status: "open",
    }),
  });
  drainAll();

  const epic = getEpic("fn-1-dual");
  expect(epic?.title).toBe("Dual Updated");
  const epicJobsAfter = getEpicJobs("fn-1-dual");
  const taskJobsAfter = getTaskJobs("fn-1-dual.1");
  expect(epicJobsAfter).toEqual(epicJobsBefore);
  expect(taskJobsAfter).toEqual(taskJobsBefore);
});

test("malformed stored epic.jobs blob folds to [] in-txn (never wedges)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-seed",
    spawn_name: "plan::fn-99-mal",
  });
  drainAll();
  db.run("UPDATE epics SET jobs = '{not json' WHERE epic_id = 'fn-99-mal'");
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-seed-2",
    spawn_name: "plan::fn-99-mal",
  });
  drainAll();
  const jobs = getEpicJobs("fn-99-mal");
  expect(jobs.length).toBe(1);
  expect(jobs[0]?.job_id).toBe("sess-seed-2");
});

test("from-scratch re-fold reproduces byte-identical embedded jobs arrays", () => {
  // Mixed arrival orderings: epic-first, task-first, job-first.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-A",
    data: JSON.stringify({ epic_number: 1, title: "A", status: "open" }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A",
    spawn_name: "plan::fn-A",
    ts: 100,
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-B.1",
    data: JSON.stringify({
      epic_id: "fn-B",
      task_number: 1,
      title: "B1",
      status: "open",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-B",
    spawn_name: "work::fn-B.1",
    ts: 200,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-C",
    spawn_name: "work::fn-C.5",
    ts: 300,
  });
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-C",
    data: JSON.stringify({ epic_number: 3, title: "C", status: "open" }),
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-C.5",
    data: JSON.stringify({
      epic_id: "fn-C",
      task_number: 5,
      title: "C5",
      status: "open",
    }),
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-A" });
  insertEvent({ hook_event: "Stop", session_id: "sess-A" });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-B" });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsAfter = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
});

test("a job with no plan_ref does not create an epic row (no fan-out)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-plain",
  });
  drainAll();
  expect(getJob("sess-plain")).not.toBeNull();
  const epicCount = db.query("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);
});

// ---------------------------------------------------------------------------
// syncPlanLinks fan-out (schema v14: jobs.epic_links + epics.job_links)
// ---------------------------------------------------------------------------

/**
 * Insert a `PreToolUse:Skill` `/plan:plan` event. Schema v77 ungated the
 * classifier from the `/plan:plan` time-window model, so this event is now a
 * HARMLESS no-op for linking — every epic-mutating op links regardless of
 * `/plan:plan` timing. It is kept in the tests that still call it only to
 * mirror a realistic event log; new tests need not insert it at all.
 */
function planPlanOpener(sessionId: string, ts?: number): number {
  return insertEvent({
    hook_event: "PreToolUse",
    session_id: sessionId,
    tool_name: "Skill",
    skill_name: "plan:plan",
    ts,
  });
}

/**
 * Insert a stamped plan invocation event. Mirrors what the hook +
 * `extractPlanInvocation` deriver would write — the test bypasses the
 * Bash-command parser and stamps the derived columns directly so the
 * fan-out test stays independent of the parser's edge cases.
 */
function planEvent(args: {
  sessionId: string;
  op: string;
  target: string | null;
  epicId: string | null;
  taskId?: string | null;
  subjectPresent: boolean;
  // Schema v46 / fn-666: optional repo-relative `files[]` to lift into
  // `events.plan_files` AND inline into the envelope's `state_repo`
  // payload (so the reducer's mint can read `state_repo` from event.data).
  // Defaults `undefined` — existing tests keep their old null-on-plan
  // shape and the mint becomes a no-op for them.
  files?: string[];
  stateRepo?: string;
  ts?: number;
}): number {
  // When mint-test args (`files` + `stateRepo`) are passed, also inline the
  // canonical envelope `{tool_response:{stdout:JSON({planctl_invocation:
  // {state_repo, files, op, target, ...}})}}` into `data` so the reducer's
  // `extractPlanStateRepo` can lift `state_repo` at fold time. Existing
  // tests pass neither and get the default empty `data: '{}'` (mint no-ops).
  const data =
    args.files != null && args.stateRepo != null
      ? JSON.stringify({
          tool_response: {
            stdout: JSON.stringify({
              planctl_invocation: {
                op: args.op,
                target: args.target,
                state_repo: args.stateRepo,
                files: args.files,
                subject: args.subjectPresent ? "x" : null,
              },
            }),
          },
        })
      : undefined;
  return insertEvent({
    hook_event: "PostToolUse",
    session_id: args.sessionId,
    tool_name: "Bash",
    ts: args.ts,
    plan_op: args.op,
    plan_target: args.target,
    plan_epic_id: args.epicId,
    plan_task_id: args.taskId ?? null,
    plan_subject_present: args.subjectPresent ? 1 : 0,
    plan_files: args.files != null ? JSON.stringify(args.files) : null,
    data,
  });
}

/** Read the persisted `jobs.epic_links` as a real array. */
function getEpicLinks(sessionId: string): { kind: string; target: string }[] {
  const row = db
    .query("SELECT epic_links FROM jobs WHERE job_id = ?")
    .get(sessionId) as { epic_links: string | null } | null;
  if (row == null || row.epic_links == null) {
    return [];
  }
  return JSON.parse(row.epic_links);
}

/**
 * Read the persisted `epics.job_links` as a real array of the schema-v25
 * widened JobLinkEntry shape
 * `{kind, job_id, title, state, last_api_error_at, last_api_error_kind,
 * last_input_request_at, last_input_request_kind}`. The reducer's
 * `enrichJobLink` helper denormalizes the last six fields off the linked
 * `jobs` row at write time.
 */
function getJobLinks(epicId: string): {
  kind: string;
  job_id: string;
  title: string | null;
  state: string;
  last_api_error_at: number | null;
  last_api_error_kind: string | null;
  last_input_request_at: number | null;
  last_input_request_kind: string | null;
  last_permission_prompt_at: number | null;
  last_permission_prompt_kind: string | null;
}[] {
  const row = db
    .query("SELECT job_links FROM epics WHERE epic_id = ?")
    .get(epicId) as { job_links: string | null } | null;
  if (row == null || row.job_links == null) {
    return [];
  }
  return JSON.parse(row.job_links);
}

test("syncPlanLinks: single-session single-window one creator emits creator edge in both directions", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-creator" });
  planPlanOpener("sess-creator");
  planEvent({
    sessionId: "sess-creator",
    op: "epic-create",
    target: "fn-1-new",
    epicId: "fn-1-new",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicLinks("sess-creator")).toEqual([
    { kind: "creator", target: "fn-1-new" },
  ]);
  expect(getJobLinks("fn-1-new")).toEqual([
    {
      kind: "creator",
      job_id: "sess-creator",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

test("syncPlanLinks: single-session create-then-refine same epic emits ONE creator edge (per-session suppression)", () => {
  // Windowless (schema v77): a session that creates an epic and later refines
  // the SAME epic emits exactly one `creator` edge — the creator-of-X
  // suppresses the later refiner-of-X within the session. The `/plan:plan`
  // openers no longer matter; they are harmless no-ops kept only to mirror a
  // realistic event log.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-cr" });
  planPlanOpener("sess-cr");
  planEvent({
    sessionId: "sess-cr",
    op: "epic-create",
    target: "fn-2-foo",
    epicId: "fn-2-foo",
    subjectPresent: true,
  });
  planPlanOpener("sess-cr");
  planEvent({
    sessionId: "sess-cr",
    op: "epic-set-title",
    target: "fn-2-foo",
    epicId: "fn-2-foo",
    subjectPresent: true,
  });
  drainAll();
  // One creator edge; the same-epic refiner is suppressed.
  expect(getEpicLinks("sess-cr")).toEqual([
    { kind: "creator", target: "fn-2-foo" },
  ]);
  expect(getJobLinks("fn-2-foo")).toEqual([
    {
      kind: "creator",
      job_id: "sess-cr",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

test("syncPlanLinks: read-only verb in a window emits no edges", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-readonly" });
  planPlanOpener("sess-readonly");
  // A `keeper plan cat` is a read-only verb; `subject_present: false` mirrors the
  // jobctl `subject is None` skip gate.
  planEvent({
    sessionId: "sess-readonly",
    op: "cat",
    target: "fn-3-bar",
    epicId: "fn-3-bar",
    subjectPresent: false,
  });
  drainAll();
  expect(getEpicLinks("sess-readonly")).toEqual([]);
  // No epic row created (the read-only invocation produced no edges, so
  // touchedEpics is empty and the per-epic re-derive loop never fired).
  const epicRow = db
    .query("SELECT epic_id FROM epics WHERE epic_id = ?")
    .get("fn-3-bar");
  expect(epicRow).toBeNull();
});

test("syncPlanLinks: two sessions touching the same epic both appear in job_links", () => {
  // Session A creates the epic.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a-fan" });
  planPlanOpener("sess-a-fan");
  planEvent({
    sessionId: "sess-a-fan",
    op: "epic-create",
    target: "fn-4-multi",
    epicId: "fn-4-multi",
    subjectPresent: true,
  });
  // Session B refines it.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b-fan" });
  planPlanOpener("sess-b-fan");
  planEvent({
    sessionId: "sess-b-fan",
    op: "epic-set-title",
    target: "fn-4-multi",
    epicId: "fn-4-multi",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicLinks("sess-a-fan")).toEqual([
    { kind: "creator", target: "fn-4-multi" },
  ]);
  expect(getEpicLinks("sess-b-fan")).toEqual([
    { kind: "refiner", target: "fn-4-multi" },
  ]);
  expect(getJobLinks("fn-4-multi")).toEqual([
    {
      kind: "creator",
      job_id: "sess-a-fan",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
    {
      kind: "refiner",
      job_id: "sess-b-fan",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

test("syncPlanLinks: cross-session sweep re-derives a touched epic's job_links across every session that ever touched it", () => {
  // Coverage for the cross-session expansion at `src/reducer.ts:1192` (the
  // `SELECT DISTINCT session_id ... WHERE plan_op IS NOT NULL AND
  // (plan_epic_id IN (...) OR plan_target IN (...))` sweep). Without it
  // a re-classification in session A would re-derive the touched epic's
  // `job_links` against session A's invocations only — silently dropping
  // every other session's edge on that epic. This test fails if the sweep is
  // short-circuited to same-session only.
  //
  // The drop mechanism here is the classifier's per-session
  // creator-suppression rule (see `deriveEpicLinks`): a creator-of-X
  // encountered earlier in the `(ts, event_id)` order suppresses any later
  // refiner-of-X in the SAME session. We exercise it by backdating the
  // follow-up `epic-create` (ts 100) so on re-classification it lands BEFORE
  // the existing `epic-set-title` (ts 110). Synthetic ordering — what matters
  // here is the cross-session fan-out behaviour, not the realism of the
  // wall-clock interleave.
  //
  // Scenario (windowless — the `/plan:plan` openers are harmless no-ops):
  //   1. Session A refines epic X via `epic-set-title` at t=110. A's
  //      epic_links = [refiner:X]; X's job_links = [refiner:A].
  //   2. Session B refines epic X via `epic-set-title` at t=210. The
  //      cross-session sweep from B's fold adds B → X's job_links =
  //      [refiner:A, refiner:B].
  //   3. Session A folds a backdated `epic-create` on X at t=100 — BEFORE the
  //      refiner. The classifier emits creator-X first, which suppresses the
  //      now-later refiner-X. A's epic_links collapse to [creator:X] — the
  //      refiner edge is dropped.
  //   4. The fan-out's cross-session sweep MUST re-derive X's job_links over
  //      both A and B — yielding [creator:A, refiner:B]. A short-circuited
  //      (same-session-only) sweep would yield [creator:A] only, silently
  //      losing B's refiner edge.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A-xs",
    ts: 80,
  });
  planPlanOpener("sess-A-xs", 90);
  planEvent({
    sessionId: "sess-A-xs",
    op: "epic-set-title",
    target: "fn-7-xs",
    epicId: "fn-7-xs",
    subjectPresent: true,
    ts: 110,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-B-xs",
    ts: 190,
  });
  planPlanOpener("sess-B-xs", 200);
  planEvent({
    sessionId: "sess-B-xs",
    op: "epic-set-title",
    target: "fn-7-xs",
    epicId: "fn-7-xs",
    subjectPresent: true,
    ts: 210,
  });
  drainAll();
  // Pre-state: both sessions refine the epic.
  expect(getEpicLinks("sess-A-xs")).toEqual([
    { kind: "refiner", target: "fn-7-xs" },
  ]);
  expect(getEpicLinks("sess-B-xs")).toEqual([
    { kind: "refiner", target: "fn-7-xs" },
  ]);
  expect(getJobLinks("fn-7-xs")).toEqual([
    {
      kind: "refiner",
      job_id: "sess-A-xs",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
    {
      kind: "refiner",
      job_id: "sess-B-xs",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);

  // Follow-up in session A — backdated `epic-create` at t=100 lands BEFORE
  // the refiner at t=110, so re-classification emits creator-X first which
  // suppresses the refiner via per-window-creator-of-X rule.
  planEvent({
    sessionId: "sess-A-xs",
    op: "epic-create",
    target: "fn-7-xs",
    epicId: "fn-7-xs",
    subjectPresent: true,
    ts: 100,
  });
  drainAll();

  // Session A's epic_links updated by the same-session re-derive (refiner
  // dropped → creator emitted).
  expect(getEpicLinks("sess-A-xs")).toEqual([
    { kind: "creator", target: "fn-7-xs" },
  ]);
  // Session B's epic_links are not directly touched by the fan-out on A —
  // they must still reach the correct post-state (B was never
  // re-classified, so its refiner edge persists verbatim).
  expect(getEpicLinks("sess-B-xs")).toEqual([
    { kind: "refiner", target: "fn-7-xs" },
  ]);
  // The acceptance assertion: epic X's job_links no longer carries the
  // stale session-A refiner edge, AND session B's refiner edge survives the
  // cross-session re-derive. Sort is total-order (kind, job_id) ASC —
  // creator < refiner lexicographically, so creator:A comes first.
  expect(getJobLinks("fn-7-xs")).toEqual([
    {
      kind: "creator",
      job_id: "sess-A-xs",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
    {
      kind: "refiner",
      job_id: "sess-B-xs",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

test("syncPlanLinks: EpicSnapshot ON CONFLICT preserves job_links (carve-out works)", () => {
  // Seed a creator edge via the fan-out → a shell epic with job_links.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-carveout" });
  planPlanOpener("sess-carveout");
  planEvent({
    sessionId: "sess-carveout",
    op: "epic-create",
    target: "fn-5-survive",
    epicId: "fn-5-survive",
    subjectPresent: true,
  });
  drainAll();
  expect(getJobLinks("fn-5-survive")).toEqual([
    {
      kind: "creator",
      job_id: "sess-carveout",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
  // Now fold an EpicSnapshot for the same epic — the ON CONFLICT clause
  // MUST omit job_links (alongside jobs / tasks) so the carve-out preserves
  // the projection. Without the carve-out an approval RPC → file write →
  // file-watcher → snapshot fold would wipe creator/refiner provenance.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-5-survive",
    data: JSON.stringify({
      epic_number: 5,
      title: "Survive Carve-out",
      project_dir: "/repo",
      status: "open",
    }),
  });
  drainAll();
  // Scalars filled, job_links preserved.
  const epic = getEpic("fn-5-survive");
  expect(epic?.title).toBe("Survive Carve-out");
  expect(getJobLinks("fn-5-survive")).toEqual([
    {
      kind: "creator",
      job_id: "sess-carveout",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

// ---------------------------------------------------------------------------
// Schema v54 / fn-695 (T3): syncPlanLinks unions the durable commit-
// trailer facts (Planctl-Op / Planctl-Target / Session-Id, frozen on the
// `Commit` payload by task .2) with the legacy stdout-scrape rows. A
// scaffold whose stdout scrape NULLed out still mints a creator edge via
// the commit channel; a scrape + a commit for the same op dedup to one
// edge; pre-fn-695 Commit events (no payload fields) are a re-fold no-op.
// ---------------------------------------------------------------------------

/**
 * Insert a synthetic `Commit` event carrying the fn-695 trailer facts the
 * git-worker freezes on the payload. `committerSessionId` MUST be a valid
 * UUID (extractCommit gates it via UUID_RE) and `planOp` is already
 * normalized (`scaffold`, not `epic-scaffold`) — mirroring the producer's
 * `normalizePlanOp` lift at git-worker time. `committedAtMs/1000` is the
 * classifier ts the `/plan:plan` windows compare against.
 */
function commitTrailerEvent(args: {
  projectDir: string;
  commitOid: string;
  committerSessionId: string;
  planOp: string | null;
  planTarget: string | null;
  committedAtMs: number;
  ts?: number;
}): number {
  return insertEvent({
    hook_event: "Commit",
    session_id: args.projectDir,
    cwd: args.projectDir,
    ts: args.ts,
    data: JSON.stringify({
      project_dir: args.projectDir,
      commit_oid: args.commitOid,
      parent_oid: null,
      // A `chore(plan)` commit names the .planctl JSON it wrote — one
      // file is enough for foldCommit's `files.length === 0` guard to pass.
      files: [
        { path: ".planctl/epics/x.json", blob_oid: null, committed_mode: null },
      ],
      committer_session_id: args.committerSessionId,
      task_ids: [],
      // Commit-event `data` payload keys — written by the git-worker trailer
      // layer and read back by `extractCommit` via `obj.plan_op` /
      // `obj.plan_target` (the v82 migration rewrote the historical events to
      // the `plan_*` spelling).
      plan_op: args.planOp,
      plan_target: args.planTarget,
      committed_at_ms: args.committedAtMs,
    }),
  });
}

test("fn-695: commit-only scaffold (scrape NULL) still mints a creator edge via the commit trailer", () => {
  // The fn-635-class fix-forward proof. The session opened /plan:plan and
  // ran `keeper plan scaffold` BUT its stdout was piped through grep, so the
  // envelope scrape never landed (`events.plan_op` is NULL — we insert
  // NO planEvent at all). The durable commit trailer carries the op.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  // No planEvent — the scrape NULLed out (the whole point of fn-695).
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: "scaffold",
    planTarget: "fn-1-commitonly",
    committedAtMs: 5_000_000, // ts=5000, inside the open-ended window
  });
  drainAll();
  // The creator edge appears in BOTH directions via the commit channel.
  expect(getEpicLinks(TEST_UUID)).toEqual([
    { kind: "creator", target: "fn-1-commitonly" },
  ]);
  expect(getJobLinks("fn-1-commitonly")).toEqual([
    {
      kind: "creator",
      job_id: TEST_UUID,
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

test("fn-695: scrape + commit for the same (epic, kind, job) dedup to one creator edge", () => {
  // Both channels fire for the same scaffold op. The classifier dedups by
  // `(kind, target)` / `(kind, job_id)`, so the union is exactly one edge.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  // Scrape channel: the stdout envelope DID land this time.
  planEvent({
    sessionId: TEST_UUID,
    op: "epic-scaffold",
    target: "fn-2-dedup",
    epicId: "fn-2-dedup",
    subjectPresent: true,
    ts: 2_000,
  });
  // Commit channel: the same op's durable trailer (normalized op).
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: "scaffold",
    planTarget: "fn-2-dedup",
    committedAtMs: 5_000_000,
  });
  drainAll();
  // Exactly one creator edge, not two — the dedup collapsed the channels.
  expect(getEpicLinks(TEST_UUID)).toEqual([
    { kind: "creator", target: "fn-2-dedup" },
  ]);
  expect(getJobLinks("fn-2-dedup")).toEqual([
    {
      kind: "creator",
      job_id: TEST_UUID,
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

test("fn-695: commit-channel refiner edge surfaces for a non-create op (set-title)", () => {
  // Session A creates the epic via the scrape channel. Session B refines it
  // via the commit channel ONLY (its scrape NULLed out). The commit-channel
  // session must appear in the per-epic job_links sweep (the
  // commitTrailerSessionsForEpics widening).
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  planEvent({
    sessionId: TEST_UUID,
    op: "epic-create",
    target: "fn-3-refine",
    epicId: "fn-3-refine",
    subjectPresent: true,
    ts: 2_000,
  });
  // Session B refines via the commit trailer alone.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID_2 });
  planPlanOpener(TEST_UUID_2, 3_000);
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID_2,
    committerSessionId: TEST_UUID_2,
    planOp: "set-title",
    planTarget: "fn-3-refine",
    committedAtMs: 6_000_000,
  });
  drainAll();
  expect(getEpicLinks(TEST_UUID)).toEqual([
    { kind: "creator", target: "fn-3-refine" },
  ]);
  expect(getEpicLinks(TEST_UUID_2)).toEqual([
    { kind: "refiner", target: "fn-3-refine" },
  ]);
  // The epic's job_links carries BOTH the scrape creator AND the commit-only
  // refiner — proof the cross-session sweep saw the commit-channel session.
  expect(getJobLinks("fn-3-refine")).toEqual([
    {
      kind: "creator",
      job_id: TEST_UUID,
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
    {
      kind: "refiner",
      job_id: TEST_UUID_2,
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

test("fn-695: pre-feature Commit event (NULL plan_op/target) mints no edge", () => {
  // A historical / non-plan Commit (a source commit, or a pre-fn-695
  // chore commit whose payload predates the trailer fields). extractCommit
  // defaults plan_op/target to null → the foldCommit trigger gate is
  // closed → no edge. Re-fold no-op over the historical log.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: null,
    planTarget: null,
    committedAtMs: 5_000_000,
  });
  drainAll();
  expect(getEpicLinks(TEST_UUID)).toEqual([]);
  // No epic shell created.
  expect(
    db
      .query("SELECT epic_id FROM epics WHERE epic_id = ?")
      .get("fn-1-commitonly"),
  ).toBeNull();
});

test("fn-695: from-scratch re-fold is byte-identical over a log with commit-trailer + pre-feature Commit events", () => {
  // Mixed log: a SessionStart, a /plan:plan opener, a commit-trailer
  // scaffold (mints an edge), AND a pre-feature Commit (NULL op → no-op).
  // The re-fold from cursor=0 must reproduce byte-identical jobs / epics.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: "scaffold",
    planTarget: "fn-9-refold",
    committedAtMs: 5_000_000,
  });
  // Pre-feature Commit — re-fold no-op.
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID_2,
    committerSessionId: TEST_UUID,
    planOp: null,
    planTarget: null,
    committedAtMs: 6_000_000,
  });
  expect(drainAll()).toBeGreaterThan(0);

  const cursor1 = getCursor();
  const jobs1 = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const epics1 = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  // Sanity: the commit-channel edge actually formed in the first fold.
  expect(getEpicLinks(TEST_UUID)).toEqual([
    { kind: "creator", target: "fn-9-refold" },
  ]);

  // Re-fold from cursor=0.
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM file_attributions");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  expect(drainAll()).toBeGreaterThan(0);

  expect(getCursor()).toBe(cursor1);
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(JSON.stringify(jobs1));
  expect(
    JSON.stringify(db.query("SELECT * FROM epics ORDER BY epic_id").all()),
  ).toBe(JSON.stringify(epics1));
});

// ---------------------------------------------------------------------------
// fn-807.1: the commit-trailer channel now performs ONE scan per
// syncPlanLinks call (loadAllCommitTrailerFacts) instead of the old ~2 +
// one-per-swept-session blob scans, and no SQL json_extract rides the WHERE —
// every survivor parses in JS via extractCommit (never throws). These cover
// the two load-bearing equivalences: malformed Commit data folds to no-facts
// without throwing, and a trailer-rich log (inline + relocated blobs + a
// commit-only session + a malformed blob) re-folds byte-identically.
// ---------------------------------------------------------------------------

// A third valid UUID/OID for the commit-only session in the re-fold seed.
const TEST_UUID_3 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const TEST_OID_3 = "abcdef0123456789abcdef0123456789abcdef01";

test("fn-807.1: a malformed Commit data blob folds to no trailer facts without throwing", () => {
  // The never-throw-inside-a-fold invariant for the commit-trailer channel.
  // The old json_extract in the WHERE could throw on malformed JSON BEFORE
  // extractCommit's try/catch ran; the single-scan loader parses every row in
  // JS, so a malformed blob is simply skipped.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  // A well-formed trailer scaffold that DOES mint an edge.
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: "scaffold",
    planTarget: "fn-1-ok",
    committedAtMs: 5_000_000,
  });
  // A malformed Commit blob (not valid JSON). extractCommit returns null →
  // the loader skips it; the fold must not throw and the row mints nothing.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    data: "{not valid json",
  });
  expect(() => drainAll()).not.toThrow();
  // The valid scaffold's creator edge is present; the malformed blob added no
  // facts (only one epic_link, no spurious target).
  expect(getEpicLinks(TEST_UUID)).toEqual([
    { kind: "creator", target: "fn-1-ok" },
  ]);
});

test("fn-807.1: from-scratch re-fold is byte-identical over a trailer-rich log (scrape + inline + commit-only session + malformed)", () => {
  // The whole-task equivalence proof. Seed the full mix the single-scan loader
  // must reproduce: a scrape-side plan creator, a commit dedup of that same
  // op, an inline trailer Commit (Commit is keep-set post-shed), a commit-only
  // session whose scrape NULLed out, and one malformed Commit blob (a no-fact
  // no-throw). The re-fold from cursor=0 must reproduce byte-identical jobs / epics.

  // Session 1: scrape-side creator for fn-1-mix, plus a commit trailer for the
  // SAME op — the channels dedup to one creator edge.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  planEvent({
    sessionId: TEST_UUID,
    op: "epic-scaffold",
    target: "fn-1-mix",
    epicId: "fn-1-mix",
    subjectPresent: true,
    ts: 2_000,
  });
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: "scaffold",
    planTarget: "fn-1-mix",
    committedAtMs: 5_000_000,
  });

  // Session 2: refines fn-1-mix via a commit-trailer blob ONLY (its scrape
  // NULLed out). Commit is keep-set so its body stays inline post-shed; the
  // single-scan loader reads commit_trailer_facts (populated at fold time from
  // events.data) so the commit-only refiner surfaces.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID_2 });
  planPlanOpener(TEST_UUID_2, 3_000);
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID_2,
    committerSessionId: TEST_UUID_2,
    planOp: "set-title",
    planTarget: "fn-1-mix",
    committedAtMs: 6_000_000,
  });

  // Session 3: a commit-only creator for a DIFFERENT epic (no scrape rows at
  // all) — proves a commit-only session still mints its own creator edge.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID_3 });
  planPlanOpener(TEST_UUID_3, 4_000);
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID_3,
    committerSessionId: TEST_UUID_3,
    planOp: "scaffold",
    planTarget: "fn-2-only",
    committedAtMs: 7_000_000,
  });

  // A malformed Commit blob — a no-fact, no-throw row riding the same log.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    data: "}{garbage",
  });

  expect(drainAll()).toBeGreaterThan(0);

  // Sanity: every channel's edge actually formed in the first fold.
  expect(getEpicLinks(TEST_UUID)).toEqual([
    { kind: "creator", target: "fn-1-mix" },
  ]);
  expect(getEpicLinks(TEST_UUID_2)).toEqual([
    { kind: "refiner", target: "fn-1-mix" },
  ]);
  expect(getEpicLinks(TEST_UUID_3)).toEqual([
    { kind: "creator", target: "fn-2-only" },
  ]);

  const cursor1 = getCursor();
  const jobs1 = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const epics1 = db.query("SELECT * FROM epics ORDER BY epic_id").all();

  // Re-fold from cursor=0 — the grouped single-scan facts must reproduce the
  // projections byte-for-byte.
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM file_attributions");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  expect(drainAll()).toBeGreaterThan(0);

  expect(getCursor()).toBe(cursor1);
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(JSON.stringify(jobs1));
  expect(
    JSON.stringify(db.query("SELECT * FROM epics ORDER BY epic_id").all()),
  ).toBe(JSON.stringify(epics1));
});

// ---------------------------------------------------------------------------
// fn-807.2: foldCommit writes the durable fact into the commit_trailer_facts
// projection table in its own transaction, and loadAllCommitTrailerFacts reads
// the table (zero Commit-blob scans in the fold read path). The re-fold from
// cursor=0 must reproduce the projection table — AND the link projections it
// feeds — byte-identically.
// ---------------------------------------------------------------------------

/** Read the commit_trailer_facts projection ordered by event_id. */
function getCommitTrailerFacts(): {
  event_id: number;
  committer_session_id: string;
  plan_op: string;
  plan_target: string;
  plan_epic_id: string | null;
  committed_at_ms: number;
}[] {
  return db
    .query("SELECT * FROM commit_trailer_facts ORDER BY event_id ASC")
    .all() as {
    event_id: number;
    committer_session_id: string;
    plan_op: string;
    plan_target: string;
    plan_epic_id: string | null;
    committed_at_ms: number;
  }[];
}

test("fn-807.2: foldCommit writes a commit_trailer_facts row in the same transaction (task-form target folds to its epic)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  const evId = commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: "set-title",
    planTarget: "fn-5-fact.2",
    committedAtMs: 5_000_000,
  });
  drainAll();
  // Exactly one fact row, keyed by the Commit event id, epic folded from the
  // task-form target.
  expect(getCommitTrailerFacts()).toEqual([
    {
      event_id: evId,
      committer_session_id: TEST_UUID,
      plan_op: "set-title",
      plan_target: "fn-5-fact.2",
      plan_epic_id: "fn-5-fact",
      committed_at_ms: 5_000_000,
    },
  ]);
  // The link projection the table feeds still forms (refiner, since set-title is
  // not a create op).
  expect(getEpicLinks(TEST_UUID)).toEqual([
    { kind: "refiner", target: "fn-5-fact" },
  ]);
});

test("fn-807.2: a non-plan / pre-feature Commit writes no fact row", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  // NULL op/target — the foldCommit fact-write condition is closed.
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: null,
    planTarget: null,
    committedAtMs: 5_000_000,
  });
  drainAll();
  expect(getCommitTrailerFacts()).toEqual([]);
});

test("fn-807.2: from-scratch re-fold reproduces commit_trailer_facts byte-identically (inline + malformed + non-plan in the log)", () => {
  // Session 1: an inline plan-trailer scaffold → one fact row + creator edge.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  planPlanOpener(TEST_UUID, 1_000);
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: "scaffold",
    planTarget: "fn-1-ctf",
    committedAtMs: 5_000_000,
  });
  // Session 2: a second plan trailer (Commit is keep-set post-shed, body
  // inline) → fact row via the loader. foldCommit writes the fact from
  // events.data at fold time; the re-fold reproduces it from the same inline body.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID_2 });
  planPlanOpener(TEST_UUID_2, 3_000);
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID_2,
    committerSessionId: TEST_UUID_2,
    planOp: "set-title",
    planTarget: "fn-1-ctf",
    committedAtMs: 6_000_000,
  });
  // A malformed Commit blob → no fact, no throw.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    data: "}{garbage",
  });
  // A non-plan Commit → no fact.
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID_3,
    committerSessionId: TEST_UUID_3,
    planOp: null,
    planTarget: null,
    committedAtMs: 7_000_000,
  });
  expect(drainAll()).toBeGreaterThan(0);

  const facts1 = getCommitTrailerFacts();
  // Sanity: exactly the two valid trailers landed (the relocated row's blob
  // was read inline at first fold).
  expect(facts1.map((r) => r.plan_target)).toEqual(["fn-1-ctf", "fn-1-ctf"]);
  const cursor1 = getCursor();
  const jobs1 = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const epics1 = db.query("SELECT * FROM epics ORDER BY epic_id").all();

  // Re-fold from cursor=0 — wipe the projection table AND the link projections
  // it feeds, then re-drain. The relocated blob now resolves via the loader's
  // COALESCE; the fact table + link projections must reproduce byte-for-byte.
  db.run("DELETE FROM commit_trailer_facts");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM file_attributions");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  expect(drainAll()).toBeGreaterThan(0);

  expect(getCursor()).toBe(cursor1);
  expect(JSON.stringify(getCommitTrailerFacts())).toBe(JSON.stringify(facts1));
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(JSON.stringify(jobs1));
  expect(
    JSON.stringify(db.query("SELECT * FROM epics ORDER BY epic_id").all()),
  ).toBe(JSON.stringify(epics1));
});

test("syncPlanLinks: re-fold determinism (rewind + DELETE + drain reproduces byte-identical projection)", () => {
  // Drive a full session: a creator + a same-session task-create (the refiner
  // is suppressed by per-session creator-suppression), plus a cross-session
  // refiner so both projections accumulate. The re-fold must reproduce the same
  // rows byte-for-byte regardless of the suppression outcome.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-A-det" });
  planPlanOpener("sess-A-det");
  planEvent({
    sessionId: "sess-A-det",
    op: "epic-create",
    target: "fn-6-det",
    epicId: "fn-6-det",
    subjectPresent: true,
  });
  planPlanOpener("sess-A-det");
  planEvent({
    sessionId: "sess-A-det",
    op: "task-create",
    target: "fn-6-det.1",
    epicId: "fn-6-det",
    taskId: "fn-6-det.1",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-B-det" });
  planPlanOpener("sess-B-det");
  planEvent({
    sessionId: "sess-B-det",
    op: "epic-set-title",
    target: "fn-6-det",
    epicId: "fn-6-det",
    subjectPresent: true,
  });
  drainAll();

  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  // Rewind + delete + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const jobsAfter = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  expect(epicsAfter).toEqual(epicsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
});

// ---------------------------------------------------------------------------
// syncJobLinksOnJobWrite — schema-v21 reverse fan-out from a jobs-write
// into every linked epic's `job_links` enrichment payload.
// ---------------------------------------------------------------------------

test("syncJobLinksOnJobWrite: state flip on UserPromptSubmit re-stamps embedded state on every linked epic", () => {
  // Seed: a plan creator edge → epic gets a job_links entry. The plan tool
  // events (opener + invocation) un-stop the row to "working", so a Stop is
  // folded to drive it back to "stopped" for a genuine flip. A subsequent
  // UserPromptSubmit flips state to "working" and the reverse fan-out must
  // re-stamp the entry. The fold keeps `job_links.state` fresh for the board's
  // `[creator]/[refiner] [working]` job-link line; no readiness predicate
  // consumes it.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-flip" });
  planPlanOpener("sess-flip");
  planEvent({
    sessionId: "sess-flip",
    op: "epic-create",
    target: "fn-12-flip",
    epicId: "fn-12-flip",
    subjectPresent: true,
  });
  // Stop drives the tool-event-working row back to "stopped".
  insertEvent({ hook_event: "Stop", session_id: "sess-flip" });
  drainAll();
  expect(getJobLinks("fn-12-flip")).toEqual([
    {
      kind: "creator",
      job_id: "sess-flip",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);

  // UserPromptSubmit flips state to "working" — the jobs-side branch
  // writes the row, then `syncIfPlanRef` → `syncJobLinksOnJobWrite`
  // re-stamps every linked epic's matching entry with fresh enrichment.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-flip" });
  drainAll();
  expect(getJobLinks("fn-12-flip")).toEqual([
    {
      kind: "creator",
      job_id: "sess-flip",
      title: null,
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);

  // Stop → state flips back to "stopped"; the reverse fan-out propagates.
  insertEvent({ hook_event: "Stop", session_id: "sess-flip" });
  drainAll();
  expect(getJobLinks("fn-12-flip")[0]?.state).toBe("stopped");
});

test("syncJobLinksOnJobWrite: title update on TranscriptTitle re-stamps embedded title on every linked epic", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-title" });
  planPlanOpener("sess-title");
  planEvent({
    sessionId: "sess-title",
    op: "epic-create",
    target: "fn-13-title",
    epicId: "fn-13-title",
    subjectPresent: true,
  });
  drainAll();
  expect(getJobLinks("fn-13-title")[0]?.title).toBeNull();

  // TranscriptTitle event drives the priority-3 title rule, which writes
  // jobs.{title, title_source}; the post-write `syncIfPlanRef` →
  // `syncJobLinksOnJobWrite` reverse-fans the new title into every
  // linked epic's job_links entry.
  insertEvent({
    hook_event: "TranscriptTitle",
    session_id: "sess-title",
    data: JSON.stringify({ session_title: "Live session title" }),
  });
  drainAll();
  expect(getJobLinks("fn-13-title")[0]?.title).toBe("Live session title");
});

test("syncJobLinksOnJobWrite: RateLimited (legacy alias) sets last_api_error_at + kind='rate_limit', revival clears both", () => {
  // Set up a working session linked to an epic.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rl" });
  planPlanOpener("sess-rl");
  planEvent({
    sessionId: "sess-rl",
    op: "epic-create",
    target: "fn-14-rl",
    epicId: "fn-14-rl",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rl" });
  drainAll();
  expect(getJobLinks("fn-14-rl")[0]?.last_api_error_at).toBeNull();
  expect(getJobLinks("fn-14-rl")[0]?.last_api_error_kind).toBeNull();

  // Schema v24: the `RateLimited` event_type is the legacy alias on the
  // dual-case fold arm — it forces `kind="rate_limit"` so the historical
  // event log re-folds byte-deterministically alongside any new `ApiError`
  // mints. Both columns stamp together (paired-NULL invariant); the
  // reverse fan-out propagates BOTH to the embedded entry.
  const rlId = insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-rl",
  });
  drainAll();
  const limited = getJobLinks("fn-14-rl")[0];
  expect(limited?.state).toBe("stopped");
  expect(limited?.last_api_error_at).not.toBeNull();
  expect(limited?.last_api_error_kind).toBe("rate_limit");

  // A fresh UserPromptSubmit revives the session — clears BOTH new
  // columns (paired-NULL clear) and flips state back to "working". The
  // reverse fan-out propagates the paired clear to the embedded entry.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rl" });
  drainAll();
  const revived = getJobLinks("fn-14-rl")[0];
  expect(revived?.state).toBe("working");
  expect(revived?.last_api_error_at).toBeNull();
  expect(revived?.last_api_error_kind).toBeNull();
  // Smoke: the RateLimited event was the trigger that minted the prior
  // stamp; the prior reference is preserved for clarity.
  expect(rlId).toBeGreaterThan(0);
});

test("syncJobLinksOnJobWrite: ApiError (new mint) with data.kind='rate_limit' folds to byte-identical rows as a sibling RateLimited event", () => {
  // Dual-case alias coverage gate (CLAUDE.md "byte-identical re-fold"):
  // an `ApiError` event carrying `data.kind="rate_limit"` MUST produce a
  // post-fold `jobs` row + `epics.job_links` entry that is JSON-equal to
  // the equivalent `RateLimited`-folded state. The only field that may
  // legitimately differ is `last_event_id` (event ids are
  // monotone-per-DB so the two events get distinct ids) — strip that
  // before compare.
  //
  // Build two parallel sessions, each linked to its own epic, each
  // folded through ONE api-error event of the opposite arm.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rl-legacy" });
  planPlanOpener("sess-rl-legacy");
  planEvent({
    sessionId: "sess-rl-legacy",
    op: "epic-create",
    target: "fn-16-rl-legacy",
    epicId: "fn-16-rl-legacy",
    subjectPresent: true,
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-rl-legacy",
  });
  insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-rl-legacy",
  });

  insertEvent({ hook_event: "SessionStart", session_id: "sess-rl-new" });
  planPlanOpener("sess-rl-new");
  planEvent({
    sessionId: "sess-rl-new",
    op: "epic-create",
    target: "fn-16-rl-new",
    epicId: "fn-16-rl-new",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rl-new" });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-rl-new",
    data: JSON.stringify({ kind: "rate_limit", text: "API quota exceeded" }),
  });

  drainAll();

  // The two embedded entries on their respective epics must match
  // field-for-field on (state, last_api_error_kind, last_api_error_at != null).
  const legacy = getJobLinks("fn-16-rl-legacy")[0];
  const newMint = getJobLinks("fn-16-rl-new")[0];
  expect(legacy?.state).toBe("stopped");
  expect(newMint?.state).toBe("stopped");
  expect(legacy?.last_api_error_kind).toBe("rate_limit");
  expect(newMint?.last_api_error_kind).toBe("rate_limit");
  expect(legacy?.last_api_error_at).not.toBeNull();
  expect(newMint?.last_api_error_at).not.toBeNull();

  // The jobs rows themselves must also carry the same kind value — proves
  // the dual-case alias landed at the jobs projection layer, not just the
  // fan-out side.
  const legacyJob = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-rl-legacy") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  const newJob = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-rl-new") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(legacyJob.state).toBe("stopped");
  expect(newJob.state).toBe("stopped");
  expect(legacyJob.last_api_error_kind).toBe("rate_limit");
  expect(newJob.last_api_error_kind).toBe("rate_limit");
  expect(legacyJob.last_api_error_at).not.toBeNull();
  expect(newJob.last_api_error_at).not.toBeNull();
});

test("ApiError fold: data.kind values outside the canonical ApiErrorKind allow-list fold to 'unknown'", () => {
  // Coverage for the unknown-fallback branch of `validateApiErrorKind`:
  // anything not in the canonical six-kind allow-list (including the SDK's
  // own `"unknown"` string AND garbage strings AND missing `kind`) folds
  // to the literal `"unknown"`. Pure function of the event payload — no
  // throw inside the fold transaction (CLAUDE.md "never throw inside the
  // fold tx").
  for (const [variant, payload] of [
    ["sdk-unknown", { kind: "unknown" }],
    ["garbage-string", { kind: "not-a-real-error-type" }],
    ["non-string", { kind: 42 }],
    ["missing", {}],
  ] as const) {
    const sessionId = `sess-ae-${variant}`;
    insertEvent({ hook_event: "SessionStart", session_id: sessionId });
    insertEvent({ hook_event: "UserPromptSubmit", session_id: sessionId });
    insertEvent({
      hook_event: "ApiError",
      session_id: sessionId,
      data: JSON.stringify(payload),
    });
  }
  drainAll();

  for (const variant of [
    "sdk-unknown",
    "garbage-string",
    "non-string",
    "missing",
  ]) {
    const row = db
      .query(
        "SELECT state, last_api_error_kind, last_api_error_at FROM jobs WHERE job_id = ?",
      )
      .get(`sess-ae-${variant}`) as {
      state: string;
      last_api_error_kind: string | null;
      last_api_error_at: number | null;
    };
    expect(row.state).toBe("stopped");
    expect(row.last_api_error_kind).toBe("unknown");
    expect(row.last_api_error_at).not.toBeNull();
  }
});

test("ApiError fold: each canonical ApiErrorKind round-trips + flips state to 'stopped' + stamps last_api_error_at", () => {
  // Sanity gate on the allow-list. The dual-case alias forces "rate_limit"
  // on RateLimited; the ApiError arm validates `data.kind` against the
  // canonical six-value union. Each canonical value must:
  //   (a) round-trip verbatim into `last_api_error_kind`
  //       (no normalization, no lower/upper-case mangling),
  //   (b) flip `jobs.state` from "working" → "stopped" (same terminal
  //       semantics as the legacy RateLimited arm), and
  //   (c) stamp `last_api_error_at` to a non-NULL real (paired-NULL
  //       invariant: both columns move together, both clear together).
  // Excludes "rate_limit" — covered by the legacy-alias test above; this
  // gate is the per-kind fold-arm coverage promised by task .2.
  const kinds = [
    "authentication_failed",
    "billing_error",
    "server_error",
    "invalid_request",
    "unknown",
  ] as const;
  for (const kind of kinds) {
    const sessionId = `sess-ae-canonical-${kind}`;
    insertEvent({ hook_event: "SessionStart", session_id: sessionId });
    insertEvent({ hook_event: "UserPromptSubmit", session_id: sessionId });
    insertEvent({
      hook_event: "ApiError",
      session_id: sessionId,
      data: JSON.stringify({ kind }),
    });
  }
  drainAll();
  for (const kind of kinds) {
    const row = db
      .query(
        "SELECT state, last_api_error_kind, last_api_error_at FROM jobs WHERE job_id = ?",
      )
      .get(`sess-ae-canonical-${kind}`) as {
      state: string;
      last_api_error_kind: string | null;
      last_api_error_at: number | null;
    };
    expect(row.last_api_error_kind).toBe(kind);
    expect(row.state).toBe("stopped");
    expect(row.last_api_error_at).not.toBeNull();
  }
});

test("ApiError fold: terminal-row guard preserved — ApiError on an 'ended' / 'killed' row does NOT resurrect (both new columns stay NULL)", () => {
  // Negative-coverage gate on the terminal guard. The pre-v24 RateLimited
  // arm carried a `state NOT IN ('ended','killed')` predicate to block
  // resurrection of a row whose lifecycle is already terminal for
  // unrelated reasons; the dual-case fold MUST preserve it verbatim.
  // Without this guard, a stray late-arriving api-error event could
  // mid-life-stamp an already-terminal row.

  // 'ended' row.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ended" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ended" });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-ended" });
  drainAll();
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-ended",
    data: JSON.stringify({ kind: "rate_limit" }),
  });
  drainAll();
  const ended = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-ended") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(ended.state).toBe("ended");
  expect(ended.last_api_error_at).toBeNull();
  expect(ended.last_api_error_kind).toBeNull();

  // 'killed' row — direct write via the schema (the live exit-watcher
  // would do this through a Killed event, but for this guard test we just
  // hand-set the state to verify the SQL predicate).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-killed" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-killed" });
  drainAll();
  db.run("UPDATE jobs SET state = 'killed' WHERE job_id = 'sess-killed'");
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-killed",
    data: JSON.stringify({ kind: "server_error" }),
  });
  drainAll();
  const killed = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-killed") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(killed.state).toBe("killed");
  expect(killed.last_api_error_at).toBeNull();
  expect(killed.last_api_error_kind).toBeNull();
});

test("syncJobLinksOnJobWrite: short-circuits when jobs.epic_links is '[]' (no fan-out)", () => {
  // A bare SessionStart with no plan footprint — `jobs.epic_links`
  // is `'[]'` and the reverse fan-out short-circuits on the
  // pre-parse byte-compare. Sanity check: no epic row is created and
  // no error is raised.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-no-links" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-no-links" });
  insertEvent({ hook_event: "Stop", session_id: "sess-no-links" });
  drainAll();
  const epicCount = db.query("SELECT count(*) AS c FROM epics").get() as {
    c: number;
  };
  expect(epicCount.c).toBe(0);
});

test("syncJobLinksOnJobWrite: cross-session OLD-entry carve-out preserves other entries verbatim", () => {
  // Two sessions both refine the same epic. A jobs-write on session A
  // must re-stamp ONLY A's entry on the epic — B's entry must survive
  // verbatim. Regression: a missing carve-out (e.g. an inline rebuild
  // that dropped every other entry instead of filtering by job_id)
  // would silently lose B's edge on every A jobs-write.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-A-carve" });
  planPlanOpener("sess-A-carve");
  planEvent({
    sessionId: "sess-A-carve",
    op: "epic-create",
    target: "fn-15-carve",
    epicId: "fn-15-carve",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-B-carve" });
  planPlanOpener("sess-B-carve");
  planEvent({
    sessionId: "sess-B-carve",
    op: "epic-set-title",
    target: "fn-15-carve",
    epicId: "fn-15-carve",
    subjectPresent: true,
  });
  drainAll();
  const initial = getJobLinks("fn-15-carve");
  expect(initial).toHaveLength(2);
  expect(initial[0]?.kind).toBe("creator");
  expect(initial[0]?.job_id).toBe("sess-A-carve");
  expect(initial[1]?.kind).toBe("refiner");
  expect(initial[1]?.job_id).toBe("sess-B-carve");

  // Drive A to "working" via UserPromptSubmit. B's entry on the epic
  // must survive byte-for-byte; only A's entry's `state` flips.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-A-carve" });
  drainAll();
  const after = getJobLinks("fn-15-carve");
  expect(after).toHaveLength(2);
  // A: kind=creator preserved, state working (A un-stopped on its plan tool
  // events and its UserPromptSubmit re-stamps the entry).
  expect(after[0]).toEqual({
    kind: "creator",
    job_id: "sess-A-carve",
    title: null,
    state: "working",
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
  });
  // B: untouched by A's jobs-write — survives verbatim as "working" (B
  // un-stopped on its own plan tool events).
  expect(after[1]).toEqual({
    kind: "refiner",
    job_id: "sess-B-carve",
    title: null,
    state: "working",
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
  });
});

test("syncJobLinksOnJobWrite: Killed state flip propagates to epics.job_links", () => {
  // CLAUDE.md invariant: "a `state` flip on UserPromptSubmit / Stop /
  // SessionEnd / Killed / RateLimited … propagates to every epic that
  // references the session." The Stop / UserPromptSubmit / RateLimited
  // arms are covered above; pin the Killed arm here.
  //
  // Seed: SessionStart with explicit (pid, start_time) so the Killed
  // event's strict-match path fires (the loose pid-only branch is the
  // legacy-row exception, not what we want to exercise). Then drive a
  // plan creator edge so `jobs.epic_links` is non-empty and the
  // reverse fan-out has a target.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-kill",
    pid: 7777,
    start_time: "macos:Wed May 26 12:00:00 2026",
  });
  planPlanOpener("sess-kill");
  planEvent({
    sessionId: "sess-kill",
    op: "epic-create",
    target: "fn-17-kill",
    epicId: "fn-17-kill",
    subjectPresent: true,
  });
  // UserPromptSubmit must carry the same pid as SessionStart — a
  // pid-change clears start_time to NULL (the legacy-loose path) and
  // would defeat the strict-match Killed exercise.
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-kill",
    pid: 7777,
  });
  drainAll();
  expect(getJobLinks("fn-17-kill")[0]?.state).toBe("working");

  // Killed with matching (pid, start_time) → jobs.state flips to
  // "killed"; syncIfPlanRef → syncJobLinksOnJobWrite re-stamps the
  // linked epic's entry.
  killedEvent(7777, "macos:Wed May 26 12:00:00 2026", "sess-kill");
  drainAll();
  expect(getJobLinks("fn-17-kill")[0]?.state).toBe("killed");
});

test("syncPlanLinks: missing jobs row at enrichment defaults to safe values (no throw inside fold)", () => {
  // The classifier's deriveJobLinks runs OVER the events log directly
  // and can emit edges for sessions that have NO backing jobs row
  // (plan invocation without a SessionStart — an orphan). The
  // enrichment helper must fold the missing row to defaults rather
  // than throw; rolling back the cursor would wedge the reducer.
  //
  // Drive an orphan plan invocation: no SessionStart for the
  // session, just a window opener + a plan create event. The
  // backing jobs row never gets inserted; the epic's job_links entry
  // for this session must land with `enrichJobLink`'s defaults.
  planPlanOpener("sess-orphan");
  planEvent({
    sessionId: "sess-orphan",
    op: "epic-create",
    target: "fn-16-orphan",
    epicId: "fn-16-orphan",
    subjectPresent: true,
  });
  drainAll();
  // The orphan session has no backing jobs row, so enrichment hits
  // the missing-row default branch.
  const orphanJob = db
    .query("SELECT job_id FROM jobs WHERE job_id = ?")
    .get("sess-orphan");
  expect(orphanJob).toBeNull();
  // The epic's job_links carries the entry with defaults.
  expect(getJobLinks("fn-16-orphan")).toEqual([
    {
      kind: "creator",
      job_id: "sess-orphan",
      title: null,
      state: "stopped",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

/**
 * Fold `steps` INCREMENTALLY (drain after EVERY step, so each fold sees only
 * `id <= itself`), snapshot the deterministic link projections, then rewind +
 * wipe them + batch re-drain (every fold now sees the WHOLE log — including
 * FUTURE rows) and re-snapshot. The INCLUSIVE `id <= eventId` ceiling on
 * `syncPlanLinks`' reads is what makes the two byte-identical: without it a
 * batch re-fold reads future invocations at an epic's last touch, which no later
 * fold reconciles. `commit_trailer_facts` is wiped too (a rewinding migration
 * wipes the deterministic-replayed class), so the facts are rebuilt in id order.
 * Returns both JSON snapshots for a byte comparison. Shard-local helper.
 */
function foldIncrementalVsBatch(steps: Array<() => void>): {
  incr: { epics: string; jobs: string };
  batch: { epics: string; jobs: string };
} {
  for (const step of steps) {
    step();
    drainAll();
  }
  const incr = {
    epics: JSON.stringify(
      db.query("SELECT * FROM epics ORDER BY epic_id").all(),
    ),
    jobs: JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  };
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM commit_trailer_facts");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  drainAll();
  const batch = {
    epics: JSON.stringify(
      db.query("SELECT * FROM epics ORDER BY epic_id").all(),
    ),
    jobs: JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  };
  return { incr, batch };
}

test("syncPlanLinks: orphan path merges cross-session job_links (bounded merge replaces the removed sweep)", () => {
  // The orphan path no longer runs a cross-session sweep (the O(history×board)
  // 437s time-bomb) — it merges its OWN slice into the epic's stored job_links,
  // which already carries the creator from the normal session's earlier fold.
  // Both edges must survive: proof the per-session replace-merge covers the
  // cross-session case the full rebuild used to.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-normal-x" });
  planPlanOpener("sess-normal-x");
  planEvent({
    sessionId: "sess-normal-x",
    op: "epic-create",
    target: "fn-20-xsess",
    epicId: "fn-20-xsess",
    subjectPresent: true,
  });
  // Orphan refiner — no SessionStart for sess-orphan-x, so it takes the
  // (now-merge) orphan path with no jobs-side write.
  planPlanOpener("sess-orphan-x");
  planEvent({
    sessionId: "sess-orphan-x",
    op: "epic-set-title",
    target: "fn-20-xsess",
    epicId: "fn-20-xsess",
    subjectPresent: true,
  });
  drainAll();
  expect(
    db.query("SELECT job_id FROM jobs WHERE job_id = ?").get("sess-orphan-x"),
  ).toBeNull();
  expect(
    getJobLinks("fn-20-xsess").map((e) => ({ kind: e.kind, job_id: e.job_id })),
  ).toEqual([
    { kind: "creator", job_id: "sess-normal-x" },
    { kind: "refiner", job_id: "sess-orphan-x" },
  ]);
});

test("syncPlanLinks: orphan as an epic's LAST touch is byte-identical under incremental vs batch re-fold", () => {
  // The divergence scenario the id ceiling closes: an orphan event is the last
  // touch of fn-21-lt (nothing touches it afterward, so no later fold would
  // reconcile a future-read), while the normal session STILL has a later plan
  // op (touching a different epic) that a ceiling-less batch re-fold would read
  // into fn-21-lt's last touch. With the inclusive ceiling, both folds agree.
  const { incr, batch } = foldIncrementalVsBatch([
    () => {
      insertEvent({ hook_event: "SessionStart", session_id: "s-lt" });
    },
    () => {
      planPlanOpener("s-lt");
      planEvent({
        sessionId: "s-lt",
        op: "epic-create",
        target: "fn-21-lt",
        epicId: "fn-21-lt",
        subjectPresent: true,
      });
    },
    () => {
      // Orphan (no SessionStart) refines fn-21-lt — its LAST touch.
      planPlanOpener("o-lt");
      planEvent({
        sessionId: "o-lt",
        op: "epic-set-title",
        target: "fn-21-lt",
        epicId: "fn-21-lt",
        subjectPresent: true,
      });
    },
    () => {
      // The normal session's FUTURE plan op (a different epic) — present in the
      // batch re-fold when fn-21-lt's last touch (the orphan above) re-folds.
      planPlanOpener("s-lt");
      planEvent({
        sessionId: "s-lt",
        op: "epic-create",
        target: "fn-21b-lt",
        epicId: "fn-21b-lt",
        subjectPresent: true,
      });
    },
  ]);
  expect(batch.epics).toBe(incr.epics);
  expect(batch.jobs).toBe(incr.jobs);
});

test("syncPlanLinks: orphan→normal transition (late SessionStart) is byte-identical under incremental vs batch re-fold", () => {
  // A session flips orphan→normal mid-history: it fires a plan op BEFORE its
  // SessionStart folds (orphan path, no jobs write), then the SessionStart mints
  // the jobs row, then a later plan op takes the normal path. The batch re-fold
  // sees the late SessionStart + the future plan op when the FIRST (orphan) op
  // re-folds; the inclusive ceiling keeps both folds byte-identical.
  const { incr, batch } = foldIncrementalVsBatch([
    () => {
      planPlanOpener("s-tr");
      planEvent({
        sessionId: "s-tr",
        op: "epic-create",
        target: "fn-23-tr",
        epicId: "fn-23-tr",
        subjectPresent: true,
      });
    },
    () => {
      insertEvent({ hook_event: "SessionStart", session_id: "s-tr" });
    },
    () => {
      planPlanOpener("s-tr");
      planEvent({
        sessionId: "s-tr",
        op: "epic-set-title",
        target: "fn-23-tr",
        epicId: "fn-23-tr",
        subjectPresent: true,
      });
    },
  ]);
  expect(batch.epics).toBe(incr.epics);
  expect(batch.jobs).toBe(incr.jobs);
});

test("syncPlanLinks: the triggering commit's OWN trailer fact lands (INCLUSIVE event-id clamp)", () => {
  // foldCommit INSERTs the commit's fact into commit_trailer_facts BEFORE it
  // calls syncPlanLinks, so the per-session facts read clamps INCLUSIVE of the
  // current event id (event_id <= eventId — a deliberate departure from the
  // exclusive `< currentEventId` memo pattern). An exclusive clamp would drop
  // the commit's own fact; a commit-only session (no scrape rows) makes that
  // fact the SOLE source of the edge, so the clamp is load-bearing.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  commitTrailerEvent({
    projectDir: "/repo",
    commitOid: TEST_OID,
    committerSessionId: TEST_UUID,
    planOp: "scaffold",
    planTarget: "fn-22-inclusive",
    committedAtMs: 5_000_000,
  });
  drainAll();
  expect(getEpicLinks(TEST_UUID)).toEqual([
    { kind: "creator", target: "fn-22-inclusive" },
  ]);
  expect(
    getJobLinks("fn-22-inclusive").map((e) => ({
      kind: e.kind,
      job_id: e.job_id,
    })),
  ).toEqual([{ kind: "creator", job_id: TEST_UUID }]);
});

test("syncPlanLinks: the triggering plan invocation's OWN edge lands (INCLUSIVE event-id clamp, scrape channel)", () => {
  // The events read clamps `id <= eventId` INCLUSIVE so the CURRENT invocation
  // (the one that fired the fold) is in its own input. An exclusive clamp would
  // drop it and mint no edge on the session's first/only plan op.
  insertEvent({ hook_event: "SessionStart", session_id: "s-inc" });
  planPlanOpener("s-inc");
  planEvent({
    sessionId: "s-inc",
    op: "epic-create",
    target: "fn-24-inc",
    epicId: "fn-24-inc",
    subjectPresent: true,
  });
  drainAll();
  expect(getEpicLinks("s-inc")).toEqual([
    { kind: "creator", target: "fn-24-inc" },
  ]);
});

test("syncPlanLinks: widened-shape EpicSnapshot ON CONFLICT does not blank enriched fields", () => {
  // Mirror the classic carve-out test but assert the WIDENED-shape
  // payload survives. Without the carve-out, an approval RPC → file
  // write → file-watcher → EpicSnapshot fold would wipe the entry's
  // enriched fields back to defaults; this test pins the invariant
  // for the v21 shape.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-wide" });
  planPlanOpener("sess-wide");
  planEvent({
    sessionId: "sess-wide",
    op: "epic-create",
    target: "fn-17-wide",
    epicId: "fn-17-wide",
    subjectPresent: true,
  });
  // Drive an enriched payload: state=working + a real title via
  // UserPromptSubmit carrying session_title.
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-wide",
    data: JSON.stringify({ session_title: "Wide enrichment" }),
  });
  drainAll();
  expect(getJobLinks("fn-17-wide")).toEqual([
    {
      kind: "creator",
      job_id: "sess-wide",
      title: "Wide enrichment",
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);

  // Fold an EpicSnapshot — must preserve the WIDENED enrichment fields.
  insertEvent({
    hook_event: "EpicSnapshot",
    session_id: "fn-17-wide",
    data: JSON.stringify({
      epic_number: 17,
      title: "Wide Survive Carve-out",
      project_dir: "/repo",
      status: "open",
    }),
  });
  drainAll();
  expect(getJobLinks("fn-17-wide")).toEqual([
    {
      kind: "creator",
      job_id: "sess-wide",
      title: "Wide enrichment",
      state: "working",
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
    },
  ]);
});

// ---------------------------------------------------------------------------
// subagent_invocations projection (schema v17, fn-600 task .3)
//
// Reducer arms wire SubagentStart, SubagentStop, PostToolUse:Agent, and
// PostToolUseFailure:Agent into the peer-table projection via the per-event
// helpers from `src/subagent-invocations.ts`. All writes ride the same
// `BEGIN IMMEDIATE` as the cursor advance — re-fold determinism + safe
// no-op fold on every orphan/malformed branch.
// ---------------------------------------------------------------------------

/** Read every subagent_invocations row for a job, sorted (agent_id, turn_seq). */
function getSubagentRows(jobId = "sess-a") {
  return db
    .query(
      `SELECT job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
              description, prompt_chars, status, duration_ms,
              last_event_id, updated_at
         FROM subagent_invocations
        WHERE job_id = ?
        ORDER BY agent_id, turn_seq`,
    )
    .all(jobId) as {
    job_id: string;
    agent_id: string;
    turn_seq: number;
    ts: number;
    tool_use_id: string | null;
    subagent_type: string | null;
    description: string | null;
    prompt_chars: number;
    status: string;
    duration_ms: number | null;
    last_event_id: number;
    updated_at: number;
  }[];
}

test("SubagentStart opens a row with status='running' and seeds subagent_type from agent_type", () => {
  insertEvent({ hook_event: "SessionStart" });
  const startId = insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-1",
    agent_type: "Explore",
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    job_id: "sess-a",
    agent_id: "agent-1",
    turn_seq: 0,
    tool_use_id: null,
    subagent_type: "Explore",
    description: null,
    prompt_chars: 0,
    status: "running",
    duration_ms: null,
    last_event_id: startId,
  });
  expect(getCursor()).toBe(startId);
});

test("SubagentStart with a NULL agent_id is a safe no-op (cursor still advances)", () => {
  insertEvent({ hook_event: "SessionStart" });
  const startId = insertEvent({
    hook_event: "SubagentStart",
    agent_id: null,
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(startId);
});

test("SubagentStart with empty agent_type seeds subagent_type as NULL (PreToolUse-wins applies later)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-2",
    agent_type: "",
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.subagent_type).toBeNull();
});

test("SubagentStart re-entrant on same agent_id increments turn_seq", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-r",
    agent_type: "Explore",
    ts: 1.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-r",
    ts: 1.5,
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-r",
    agent_type: "Explore",
    ts: 2.0,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows.map((r) => r.turn_seq)).toEqual([0, 1]);
});

test("SubagentStop closes the latest open turn with duration_ms in ms", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-d",
    agent_type: "Explore",
    ts: 100.0,
  });
  const stopId = insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-d",
    ts: 102.5,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "ok",
    duration_ms: 2500,
    last_event_id: stopId,
  });
});

test("SubagentStop with no open turn is a safe no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  const stopId = insertEvent({
    hook_event: "SubagentStop",
    agent_id: "ghost",
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(stopId);
});

test("SubagentStop with NULL agent_id is a safe no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  const stopId = insertEvent({
    hook_event: "SubagentStop",
    agent_id: null,
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(stopId);
});

test("PostToolUse:Agent folds PreToolUse metadata onto the turn-0 row via the bridge", () => {
  insertEvent({ hook_event: "SessionStart" });
  // SubagentStart seeds turn-0 with subagent_type='Explore'.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-X",
    agent_type: "Explore",
    ts: 10.0,
  });
  // PreToolUse:Agent carries the description + prompt + subagent_type.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_abc",
    data: JSON.stringify({
      tool_use_id: "toolu_abc",
      tool_input: {
        description: "Explore the codebase for X",
        prompt: "Find every usage of the X function and summarize.",
        subagent_type: "Explore",
      },
    }),
  });
  // PostToolUse:Agent — bridges via subagent_agent_id column.
  const postId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_abc",
    subagent_agent_id: "agent-X",
    data: JSON.stringify({
      tool_use_id: "toolu_abc",
      tool_response: { agentId: "agent-X" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    agent_id: "agent-X",
    turn_seq: 0,
    tool_use_id: "toolu_abc",
    subagent_type: "Explore",
    description: "Explore the codebase for X",
    prompt_chars: "Find every usage of the X function and summarize.".length,
    status: "ok",
    last_event_id: postId,
  });
});

test("PostToolUse:Agent PreToolUse-wins precedence: empty PreToolUse subagent_type does not overwrite seeded value", () => {
  insertEvent({ hook_event: "SessionStart" });
  // Seed turn-0 with subagent_type='Explore' from SubagentStart.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-Y",
    agent_type: "Explore",
  });
  // PreToolUse:Agent payload carries an EMPTY-string subagent_type — must NOT
  // overwrite the SubagentStart-seeded 'Explore'.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_xyz",
    data: JSON.stringify({
      tool_use_id: "toolu_xyz",
      tool_input: { subagent_type: "" },
    }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_xyz",
    subagent_agent_id: "agent-Y",
    data: JSON.stringify({
      tool_use_id: "toolu_xyz",
      tool_response: { agentId: "agent-Y" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows[0]?.subagent_type).toBe("Explore");
});

test("PostToolUse:Agent uses JSON-fallback bridge when subagent_agent_id column is NULL (pre-fn-390 row)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-legacy",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_leg",
    data: JSON.stringify({
      tool_use_id: "toolu_leg",
      tool_input: { description: "do work" },
    }),
  });
  // subagent_agent_id NULL — must fall back to data.tool_response.agentId.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_leg",
    subagent_agent_id: null,
    data: JSON.stringify({
      tool_use_id: "toolu_leg",
      tool_response: { agentId: "agent-legacy" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.description).toBe("do work");
  expect(rows[0]?.status).toBe("ok");
});

test("PostToolUse:Agent with no resolvable bridge is a safe no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-Z",
  });
  // Neither subagent_agent_id nor data.tool_response.agentId resolve.
  const postId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_noresolve",
    subagent_agent_id: null,
    data: JSON.stringify({ tool_use_id: "toolu_noresolve" }),
  });
  drainAll();
  // Row stays at SubagentStart's seed — unchanged.
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "running",
    tool_use_id: null,
    description: null,
  });
  expect(getCursor()).toBe(postId);
});

test("PostToolUse:Agent with no turn-0 row (PostToolUse-before-SubagentStart ordering) is a safe no-op", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_early",
    data: JSON.stringify({
      tool_use_id: "toolu_early",
      tool_input: { description: "early" },
    }),
  });
  const postId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_early",
    subagent_agent_id: "agent-noseed",
    data: JSON.stringify({
      tool_use_id: "toolu_early",
      tool_response: { agentId: "agent-noseed" },
    }),
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(postId);
});

test("PostToolUseFailure:Agent with no resolvable bridge is a safe no-op (orphan failure)", () => {
  // Bridge column NULL + no data.tool_response.agentId — resolveBridgeAgentId
  // returns null and the arm short-circuits. SubagentStop later lands the row
  // at 'ok' as if nothing happened.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-F",
    agent_type: "Explore",
    ts: 50.0,
  });
  const failId = insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "toolu_fail",
    data: JSON.stringify({ tool_use_id: "toolu_fail" }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-F",
    ts: 51.0,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "ok", duration_ms: 1000 });
  // Failure event still advanced the cursor — SubagentStop advanced past it.
  expect(getCursor()).toBeGreaterThanOrEqual(failId);
});

test("PostToolUseFailure:Agent with resolved bridge UPDATEs row to status='failed'", () => {
  // The bridge `subagent_agent_id` column resolves to the matching turn-0
  // row; UPDATE lands `status='failed'` even though a SubagentStop later
  // tries to flip it back. The terminal-status guard in the SubagentStop arm
  // preserves the `'failed'` signal.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-FF",
    agent_type: "Explore",
    ts: 60.0,
  });
  const failId = insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "toolu_ff",
    subagent_agent_id: "agent-FF",
    data: JSON.stringify({ tool_use_id: "toolu_ff" }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-FF",
    ts: 61.0,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  // 'failed' wins — SubagentStop's terminal-status guard preserves it.
  // duration_ms is still computed by SubagentStop (the row closes).
  expect(rows[0]).toMatchObject({ status: "failed", duration_ms: 1000 });
  expect(getCursor()).toBeGreaterThanOrEqual(failId);
});

test("PostToolUseFailure:Agent with non-Agent tool_name is a safe no-op", () => {
  // Symmetry with PostToolUse arm — non-Agent rows have no
  // subagent_invocations meaning.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-NA",
    agent_type: "Explore",
    ts: 70.0,
  });
  insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Bash",
    tool_use_id: "toolu_bash_fail",
    subagent_agent_id: "agent-NA",
    data: JSON.stringify({ tool_use_id: "toolu_bash_fail" }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  // Untouched — still running.
  expect(rows[0]?.status).toBe("running");
});

test("PostToolUseFailure:Agent orphan (no matching turn-0 row) is a safe no-op", () => {
  // Bridge resolves but no SubagentStart for this agent_id ever fired — the
  // UPDATE matches zero rows. Cursor still advances.
  insertEvent({ hook_event: "SessionStart" });
  const failId = insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "toolu_orphan",
    subagent_agent_id: "agent-missing",
    data: JSON.stringify({ tool_use_id: "toolu_orphan" }),
  });
  drainAll();
  expect(getSubagentRows()).toHaveLength(0);
  expect(getCursor()).toBe(failId);
});

test("SessionEnd sweeps open status='running' subagent rows to status='unknown'", () => {
  // Two open subagents: one closed cleanly (status='ok'), one still open.
  // SessionEnd's lifecycle write fires the sweep; the still-open row flips
  // to 'unknown'; the closed one is untouched (status='ok' is not 'running').
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-S1",
    agent_type: "Explore",
    ts: 100.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-S1",
    ts: 101.0,
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-S2",
    agent_type: "Plan",
    ts: 110.0,
  });
  insertEvent({ hook_event: "SessionEnd", ts: 120.0 });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(2);
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  expect(byAgent["agent-S1"]).toMatchObject({
    status: "ok",
    duration_ms: 1000,
  });
  // The orphaned subagent — closed by the SessionEnd sweep, NOT a real
  // SubagentStop, so duration_ms stays NULL.
  expect(byAgent["agent-S2"]).toMatchObject({
    status: "unknown",
    duration_ms: null,
  });
});

test("Killed sweeps open status='running' subagent rows to status='unknown' on the proven write path", () => {
  // Killed fires the sweep ONLY when the (pid, start_time) match lands.
  insertEvent({
    hook_event: "SessionStart",
    pid: 4242,
    start_time: "macos:t1",
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-K",
    agent_type: "Build",
    ts: 200.0,
  });
  killedEvent(4242, "macos:t1");
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "unknown", duration_ms: null });
});

test("Killed mismatch (stale pid) does NOT sweep open subagent rows", () => {
  // (pid, start_time) mismatch — the jobs row write short-circuits, and the
  // sweep MUST NOT fire (no lifecycle write happened).
  insertEvent({
    hook_event: "SessionStart",
    pid: 4242,
    start_time: "macos:t2",
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-K2",
    agent_type: "Build",
    ts: 200.0,
  });
  // Mismatched pid — Killed arm falls through without writing.
  killedEvent(9999, "macos:t2");
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("running");
});

test("Late SubagentStop after SessionEnd sweep preserves status='unknown' (terminal guard)", () => {
  // The sweep lands 'unknown'; a later SubagentStop fires — terminal-status
  // guard preserves the 'unknown' value and refuses to flip to 'ok'.
  // duration_ms IS still computed because the gate is `duration_ms IS NULL`
  // alone (fn-480 invariant).
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-L",
    agent_type: "Explore",
    ts: 300.0,
  });
  insertEvent({ hook_event: "SessionEnd", ts: 310.0 });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-L",
    ts: 311.0,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "unknown", duration_ms: 11000 });
});

test("PostToolUse:Agent marks prior same-type same-job open running row as superseded", () => {
  // Two SubagentStarts with same subagent_type='Explore'; agent-A spawns
  // first, agent-B spawns second. agent-B's PostToolUse:Agent fires while
  // agent-A is still running — the bridged row's spawn ts is 102.0 (agent-B),
  // and the scan finds agent-A's row (ts=101.0 < 102.0, status='running',
  // same job, same subagent_type='Explore') and marks it superseded.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_A",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_A",
      tool_input: { subagent_type: "Explore", description: "A", prompt: "pA" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-supA",
    agent_type: "Explore",
    ts: 101.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_B",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_B",
      tool_input: { subagent_type: "Explore", description: "B", prompt: "pB" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-supB",
    agent_type: "Explore",
    ts: 102.0,
  });
  // agent-B's PostToolUse:Agent — this is the supersession trigger. agent-A
  // is still running at this point (no SubagentStop yet).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_B",
    subagent_agent_id: "agent-supB",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_B",
      tool_response: { agentId: "agent-supB" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(2);
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  // agent-A: superseded (it spawned first, still 'running' when agent-B's
  // PostToolUse:Agent bridged).
  expect(byAgent["agent-supA"]?.status).toBe("superseded");
  // agent-B: ok (its own PostToolUse:Agent fold).
  expect(byAgent["agent-supB"]?.status).toBe("ok");
});

test("PostToolUse:Agent does NOT supersede already-closed peers (status='ok'/'failed')", () => {
  // agent-A closes cleanly (status='ok') BEFORE agent-B's PostToolUse:Agent
  // lands. The scan's `status='running'` gate skips agent-A — no supersession.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_closed_A",
    data: JSON.stringify({
      tool_use_id: "toolu_closed_A",
      tool_input: { subagent_type: "Explore", description: "A", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-closedA",
    agent_type: "Explore",
    ts: 201.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-closedA",
    ts: 201.5,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_closed_B",
    data: JSON.stringify({
      tool_use_id: "toolu_closed_B",
      tool_input: { subagent_type: "Explore", description: "B", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-closedB",
    agent_type: "Explore",
    ts: 202.0,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_closed_B",
    subagent_agent_id: "agent-closedB",
    data: JSON.stringify({
      tool_use_id: "toolu_closed_B",
      tool_response: { agentId: "agent-closedB" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  // Both remain 'ok' — supersession scan didn't fire on agent-A because its
  // status was already 'ok' when agent-B's PostToolUse:Agent ran.
  expect(byAgent["agent-closedA"]?.status).toBe("ok");
  expect(byAgent["agent-closedB"]?.status).toBe("ok");
});

test("PostToolUse:Agent only supersedes same subagent_type — different types are independent", () => {
  // agent-A is subagent_type='Explore', agent-B is subagent_type='Plan'. The
  // group scan keys on subagent_type so agent-A is untouched by agent-B's
  // PostToolUse:Agent.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_diffty_A",
    data: JSON.stringify({
      tool_use_id: "toolu_diffty_A",
      tool_input: { subagent_type: "Explore", description: "A", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-diffA",
    agent_type: "Explore",
    ts: 301.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_diffty_B",
    data: JSON.stringify({
      tool_use_id: "toolu_diffty_B",
      tool_input: { subagent_type: "Plan", description: "B", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-diffB",
    agent_type: "Plan",
    ts: 302.0,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_diffty_B",
    subagent_agent_id: "agent-diffB",
    data: JSON.stringify({
      tool_use_id: "toolu_diffty_B",
      tool_response: { agentId: "agent-diffB" },
    }),
  });
  drainAll();
  const rows = getSubagentRows();
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  // Different subagent_type — agent-A stays running, NOT superseded.
  expect(byAgent["agent-diffA"]?.status).toBe("running");
  expect(byAgent["agent-diffB"]?.status).toBe("ok");
});

test("Late SubagentStop on superseded row preserves status='superseded' (terminal guard)", () => {
  // Reuses the supersession scenario; agent-A is superseded, then its
  // SubagentStop fires later. Terminal guard preserves 'superseded'.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_lateA",
    data: JSON.stringify({
      tool_use_id: "toolu_lateA",
      tool_input: { subagent_type: "Explore", description: "A", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-lateA",
    agent_type: "Explore",
    ts: 401.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_lateB",
    data: JSON.stringify({
      tool_use_id: "toolu_lateB",
      tool_input: { subagent_type: "Explore", description: "B", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-lateB",
    agent_type: "Explore",
    ts: 402.0,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_lateB",
    subagent_agent_id: "agent-lateB",
    data: JSON.stringify({
      tool_use_id: "toolu_lateB",
      tool_response: { agentId: "agent-lateB" },
    }),
  });
  // agent-A's SubagentStop lands LATER — must preserve 'superseded'.
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-lateA",
    ts: 403.0,
  });
  drainAll();
  const rows = getSubagentRows();
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent_id, r]));
  expect(byAgent["agent-lateA"]?.status).toBe("superseded");
  // duration_ms still computes (the row closes; only the status is sticky).
  expect(byAgent["agent-lateA"]?.duration_ms).toBe(2000);
});

test("subagent_invocations re-fold is byte-identical with new arms (failed/unknown/superseded)", () => {
  // Exercise all three new arms in one fold + a clean-close peer, then
  // rewind + DELETE + re-drain and assert byte-identical row set.
  insertEvent({ hook_event: "SessionStart" });
  // Clean close — exercises the unchanged path.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-cln",
    agent_type: "Build",
    ts: 500.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-cln",
    ts: 501.0,
  });
  // PostToolUseFailure → 'failed'.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-fld",
    agent_type: "Explore",
    ts: 510.0,
  });
  insertEvent({
    hook_event: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "toolu_fld",
    subagent_agent_id: "agent-fld",
    data: JSON.stringify({ tool_use_id: "toolu_fld" }),
  });
  // Supersession pair on subagent_type='Plan'.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_X",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_X",
      tool_input: { subagent_type: "Plan", description: "X", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-supX",
    agent_type: "Plan",
    ts: 520.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_Y",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_Y",
      tool_input: { subagent_type: "Plan", description: "Y", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-supY",
    agent_type: "Plan",
    ts: 521.0,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_sup_Y",
    subagent_agent_id: "agent-supY",
    data: JSON.stringify({
      tool_use_id: "toolu_sup_Y",
      tool_response: { agentId: "agent-supY" },
    }),
  });
  // Lifecycle sweep — open subagents + SessionEnd → 'unknown'. fn-1008: the
  // sweep now matches the full open-turn predicate, so BOTH the bare `running`
  // orphan (agent-swp) AND the open-`ok` survivor whose SubagentStop never
  // landed (agent-supY, flipped to `ok` with NULL duration_ms by its
  // PostToolUse:Agent) are closed to `unknown`. The `superseded` peer
  // (agent-supX) is terminal and never swept.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-swp",
    agent_type: "Refactor",
    ts: 530.0,
  });
  insertEvent({ hook_event: "SessionEnd", ts: 540.0 });
  drainAll();
  const before = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const after = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  // Spot-check the four expected statuses landed correctly.
  const byAgent = Object.fromEntries(
    (after as Array<{ agent_id: string; status: string }>).map((r) => [
      r.agent_id,
      r.status,
    ]),
  );
  expect(byAgent["agent-cln"]).toBe("ok"); // closed via SubagentStop (finished)
  expect(byAgent["agent-fld"]).toBe("failed");
  expect(byAgent["agent-supX"]).toBe("superseded");
  // fn-1008: open-`ok` orphan (no SubagentStop) swept to `unknown` on SessionEnd.
  expect(byAgent["agent-supY"]).toBe("unknown");
  expect(byAgent["agent-swp"]).toBe("unknown");
});

test("PostToolUse:Agent fires BEFORE SubagentStop (Task call ordering); SubagentStop still closes the row", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-O",
    agent_type: "Explore",
    ts: 100.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_O",
    data: JSON.stringify({
      tool_use_id: "toolu_O",
      tool_input: { description: "ordering test", prompt: "hello world" },
    }),
  });
  // PostToolUse:Agent lands FIRST — flips status to 'ok'.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_O",
    subagent_agent_id: "agent-O",
    ts: 102.0,
    data: JSON.stringify({
      tool_use_id: "toolu_O",
      tool_response: { agentId: "agent-O" },
    }),
  });
  // SubagentStop lands SECOND — must still close (gate is duration_ms IS
  // NULL, NOT status='running').
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-O",
    ts: 102.5,
  });
  drainAll();
  const rows = getSubagentRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    status: "ok",
    duration_ms: 2500,
    description: "ordering test",
    prompt_chars: "hello world".length,
  });
});

test("PostToolUse:Agent with malformed JSON data folds to safe no-op (no throw)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-M",
  });
  // Malformed JSON in data — resolveBridgeAgentId returns null. Reducer must
  // NOT throw; cursor advances.
  const postId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_M",
    subagent_agent_id: null,
    data: "{not valid json",
  });
  drainAll();
  expect(getCursor()).toBe(postId);
  // Row stays at SubagentStart seed — unchanged.
  expect(getSubagentRows()[0]?.status).toBe("running");
});

test("Bridge lookup isolates session_id — cross-job tool_use_id collision does not contaminate", () => {
  // Two separate sessions, same tool_use_id. The PreToolUse-payload bridge
  // must scope to session_id, not just tool_use_id.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b" });
  // sess-a's subagent.
  insertEvent({
    hook_event: "SubagentStart",
    session_id: "sess-a",
    agent_id: "agent-a",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "PreToolUse",
    session_id: "sess-a",
    tool_name: "Agent",
    tool_use_id: "toolu_COLLIDE",
    data: JSON.stringify({
      tool_use_id: "toolu_COLLIDE",
      tool_input: { description: "from session a" },
    }),
  });
  // sess-b's subagent — DIFFERENT description, same tool_use_id.
  insertEvent({
    hook_event: "SubagentStart",
    session_id: "sess-b",
    agent_id: "agent-b",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "PreToolUse",
    session_id: "sess-b",
    tool_name: "Agent",
    tool_use_id: "toolu_COLLIDE",
    data: JSON.stringify({
      tool_use_id: "toolu_COLLIDE",
      tool_input: { description: "from session b" },
    }),
  });
  // sess-a's PostToolUse — must lift sess-a's description, NOT sess-b's.
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-a",
    tool_name: "Agent",
    tool_use_id: "toolu_COLLIDE",
    subagent_agent_id: "agent-a",
    data: JSON.stringify({
      tool_use_id: "toolu_COLLIDE",
      tool_response: { agentId: "agent-a" },
    }),
  });
  // sess-b's PostToolUse.
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-b",
    tool_name: "Agent",
    tool_use_id: "toolu_COLLIDE",
    subagent_agent_id: "agent-b",
    data: JSON.stringify({
      tool_use_id: "toolu_COLLIDE",
      tool_response: { agentId: "agent-b" },
    }),
  });
  drainAll();
  const sessA = getSubagentRows("sess-a");
  const sessB = getSubagentRows("sess-b");
  expect(sessA[0]?.description).toBe("from session a");
  expect(sessB[0]?.description).toBe("from session b");
});

test("subagent_invocations re-fold is byte-identical (rewind + DELETE + drain)", () => {
  // Seed a full quartet plus a still-open second subagent for variety.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-A",
    agent_type: "Explore",
    ts: 10.0,
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_A",
    data: JSON.stringify({
      tool_use_id: "toolu_A",
      tool_input: { description: "AAA", prompt: "p" },
    }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_A",
    subagent_agent_id: "agent-A",
    data: JSON.stringify({
      tool_use_id: "toolu_A",
      tool_response: { agentId: "agent-A" },
    }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-A",
    ts: 12.0,
  });
  // Still-open second agent — must round-trip as status='running'.
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-B",
    agent_type: "Build",
    ts: 20.0,
  });
  drainAll();
  const before = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  // Rewind + DELETE + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const after = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  expect(after).toEqual(before);
});

test("subagent_invocations coexists with plan_links fan-out — both projections populate, both deterministic on re-fold", () => {
  // fn-598 + fn-600 coexistence: a session that runs both plan invocations
  // and Agent calls keeps both projections populated; both reproduce on
  // re-fold.
  insertEvent({ hook_event: "SessionStart" });
  // A plan invocation (fn-598 fan-out into jobs.epic_links /
  // epics.job_links).
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    plan_op: "epic-create",
    plan_target: "fn-1-foo",
    plan_epic_id: "fn-1-foo",
    plan_subject_present: 1,
  });
  // /plan:plan opener (PreToolUse:Skill) — opens the window for the plan
  // event above to be classified as a creator edge.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Skill",
    skill_name: "plan:plan",
  });
  // An Agent subagent invocation (fn-600 projection).
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "agent-C",
    agent_type: "Explore",
    ts: 30.0,
  });
  insertEvent({
    hook_event: "SubagentStop",
    agent_id: "agent-C",
    ts: 31.0,
  });
  drainAll();

  // Both projections populated.
  const subagentBefore = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const epicsBefore = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(subagentBefore.length).toBeGreaterThan(0);
  expect(jobsBefore.length).toBeGreaterThan(0);

  // Re-fold from scratch — both projections reproduce byte-identically.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const subagentAfter = db
    .query(
      `SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq`,
    )
    .all();
  const jobsAfter = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const epicsAfter = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  expect(subagentAfter).toEqual(subagentBefore);
  expect(jobsAfter).toEqual(jobsBefore);
  expect(epicsAfter).toEqual(epicsBefore);
});

// ---------------------------------------------------------------------------
// config_dir capture (schema v22) — SessionStart fold + COALESCE on resume
// ---------------------------------------------------------------------------

test("SessionStart seeds jobs.config_dir from events.config_dir", () => {
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-a",
  });
  drainAll();
  const row = db
    .query("SELECT config_dir FROM jobs WHERE job_id = ?")
    .get("sess-a") as { config_dir: string | null };
  expect(row.config_dir).toBe("/Users/x/.claude-profiles/profile-a");
});

test("SessionStart with NULL config_dir leaves jobs.config_dir NULL (zero-event reading)", () => {
  insertEvent({ hook_event: "SessionStart", config_dir: null });
  drainAll();
  const row = db
    .query("SELECT config_dir FROM jobs WHERE job_id = ?")
    .get("sess-a") as { config_dir: string | null };
  expect(row.config_dir).toBeNull();
});

test("resume SessionStart with NULL config_dir preserves prior non-NULL via COALESCE", () => {
  // The locked design: a second SessionStart on the same session_id that
  // captures NULL (e.g. resume launched without the env var) must NOT
  // clobber the prior non-NULL value. The reducer's ON CONFLICT SET clause
  // wraps the column in `COALESCE(excluded.config_dir, jobs.config_dir)`
  // exactly for this case.
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-a",
  });
  drainAll();
  expect(
    (
      db
        .query("SELECT config_dir FROM jobs WHERE job_id = ?")
        .get("sess-a") as {
        config_dir: string | null;
      }
    ).config_dir,
  ).toBe("/Users/x/.claude-profiles/profile-a");

  // Resume — same session_id, NULL config_dir. COALESCE keeps the prior value.
  insertEvent({ hook_event: "SessionStart", config_dir: null });
  drainAll();
  expect(
    (
      db
        .query("SELECT config_dir FROM jobs WHERE job_id = ?")
        .get("sess-a") as {
        config_dir: string | null;
      }
    ).config_dir,
  ).toBe("/Users/x/.claude-profiles/profile-a");
});

test("resume SessionStart with a fresh non-NULL config_dir overwrites the prior value", () => {
  // Latest-non-NULL-wins: COALESCE on excluded means a populated incoming
  // value DOES win (the column is not set-once like title — env attribution
  // tracks the most-recent SessionStart's profile).
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-a",
  });
  drainAll();
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-b",
  });
  drainAll();
  const row = db
    .query("SELECT config_dir FROM jobs WHERE job_id = ?")
    .get("sess-a") as { config_dir: string | null };
  expect(row.config_dir).toBe("/Users/x/.claude-profiles/profile-b");
});

test("jobs.config_dir is byte-identical on rewind-and-redrain (re-fold determinism)", () => {
  // CLAUDE.md byte-identical re-fold invariant: a from-scratch re-fold of
  // the event log must reproduce jobs.config_dir exactly. Exercises the
  // SessionStart INSERT-side write AND the ON CONFLICT COALESCE branch.
  insertEvent({
    hook_event: "SessionStart",
    config_dir: "/Users/x/.claude-profiles/profile-a",
  });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SessionStart", config_dir: null }); // resume
  drainAll();
  const before = db.query("SELECT * FROM jobs WHERE job_id = ?").get("sess-a");
  expect(before).not.toBeNull();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db.query("SELECT * FROM jobs WHERE job_id = ?").get("sess-a");
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// InputRequest fold (schema v25, fn-617 task .1)
// ---------------------------------------------------------------------------

/**
 * Read just `state` + the input-request pair off a jobs row by id. Used by
 * the fn-617 task .1 tests to assert the paired-NULL invariant + the
 * terminal guard.
 */
function getInputRequestState(jobId: string): {
  state: string;
  last_input_request_at: number | null;
  last_input_request_kind: string | null;
} | null {
  return db
    .query(
      "SELECT state, last_input_request_at, last_input_request_kind FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as {
    state: string;
    last_input_request_at: number | null;
    last_input_request_kind: string | null;
  } | null;
}

test("InputRequest fold: stamps both columns + flips state to 'stopped'", () => {
  // The keystone bullet of fn-617 task .1: a synthetic `InputRequest`
  // event minted from a transcript-worker `input-request` message flips
  // jobs.state to 'stopped' AND stamps `(last_input_request_at,
  // last_input_request_kind)` to the event ts + the matched kind in a
  // single compound UPDATE.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir" });
  drainAll();
  const before = getInputRequestState("sess-ir");
  expect(before?.state).toBe("working");
  expect(before?.last_input_request_at).toBeNull();
  expect(before?.last_input_request_kind).toBeNull();

  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const after = getInputRequestState("sess-ir");
  expect(after?.state).toBe("stopped");
  expect(after?.last_input_request_at).not.toBeNull();
  expect(after?.last_input_request_kind).toBe("ask_user_question");
});

test("InputRequest on a session with a running subagent_invocations row still flips state to 'stopped' and stamps the (at, kind) pair", () => {
  // Mirror of test/reducer.test.ts:524 ("Stop is a no-op on state while a
  // sub-agent is running"), but for InputRequest — and with the OPPOSITE
  // assertion. Stop and ApiError both skip the state flip when a
  // subagent_invocations row is running (parent yielded to a Task, the
  // session is conceptually still working). InputRequest intentionally
  // omits that guard: a question to a human really blocks forward progress
  // regardless of who's asking — parent OR sub-agent — so the state must
  // flip to 'stopped' and the (last_input_request_at,
  // last_input_request_kind) pair must stamp. This test pins that
  // behavioral asymmetry so a future "consistency" edit that adds the
  // sub-agent guard to InputRequest gets caught.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-sub" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-sub" });
  insertEvent({
    hook_event: "SubagentStart",
    session_id: "sess-ir-sub",
    agent_id: "sub-ir",
    agent_type: "Explore",
  });
  drainAll();
  // Pre-state: session is 'working', sub-agent is running, pair is NULL.
  const before = getInputRequestState("sess-ir-sub");
  expect(before?.state).toBe("working");
  expect(before?.last_input_request_at).toBeNull();
  expect(before?.last_input_request_kind).toBeNull();

  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-sub",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  // Post-state: state flipped to 'stopped' (opposite of Stop's no-op), pair
  // stamped — InputRequest does NOT consult the sub-agent guard.
  const after = getInputRequestState("sess-ir-sub");
  expect(after?.state).toBe("stopped");
  expect(after?.last_input_request_at).not.toBeNull();
  expect(after?.last_input_request_kind).toBe("ask_user_question");
});

test("InputRequest fold: terminal-row guard preserved — InputRequest on 'ended' / 'killed' row does NOT resurrect (both columns stay NULL)", () => {
  // Negative-coverage gate on the terminal guard cloned from the v24
  // RateLimited/ApiError arm. A stray late-arriving InputRequest on an
  // already-terminal row must NOT mid-life-stamp it.

  // 'ended' row.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-ended" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-ended" });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-ir-ended" });
  drainAll();
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-ended",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const ended = getInputRequestState("sess-ir-ended");
  expect(ended?.state).toBe("ended");
  expect(ended?.last_input_request_at).toBeNull();
  expect(ended?.last_input_request_kind).toBeNull();

  // 'killed' row — hand-set lifecycle to test the SQL predicate directly
  // (mirrors the v24 ApiError terminal-guard test shape).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-killed" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-killed" });
  drainAll();
  db.run("UPDATE jobs SET state = 'killed' WHERE job_id = 'sess-ir-killed'");
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-killed",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const killed = getInputRequestState("sess-ir-killed");
  expect(killed?.state).toBe("killed");
  expect(killed?.last_input_request_at).toBeNull();
  expect(killed?.last_input_request_kind).toBeNull();
});

test("InputRequest fold: data.kind outside the canonical allow-list folds to 'ask_user_question'", () => {
  // Single-member union sanity gate. Unlike `ApiErrorKind`, there is no
  // reserved `"unknown"` fallback — every unrecognized value folds to
  // the only member, `"ask_user_question"`. The matcher is expected to
  // only emit `input-request` messages for kinds it has explicitly
  // mapped, but the reducer must still be defensive (malformed blob /
  // unknown-string / missing-kind) to satisfy the never-throw-inside-
  // fold invariant.
  for (const [variant, payload] of [
    ["garbage-string", { kind: "not-a-real-kind" }],
    ["non-string", { kind: 42 }],
    ["missing", {}],
  ] as const) {
    const sessionId = `sess-ir-${variant}`;
    insertEvent({ hook_event: "SessionStart", session_id: sessionId });
    insertEvent({ hook_event: "UserPromptSubmit", session_id: sessionId });
    insertEvent({
      hook_event: "InputRequest",
      session_id: sessionId,
      data: JSON.stringify(payload),
    });
  }
  drainAll();
  for (const variant of ["garbage-string", "non-string", "missing"]) {
    const row = getInputRequestState(`sess-ir-${variant}`);
    expect(row?.state).toBe("stopped");
    expect(row?.last_input_request_kind).toBe("ask_user_question");
    expect(row?.last_input_request_at).not.toBeNull();
  }
});

test("InputRequest clear arms: UserPromptSubmit clears the pair (paired-NULL clear) and flips state to 'working'", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-ups" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-ups" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-ups",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const blocked = getInputRequestState("sess-ir-ups");
  expect(blocked?.state).toBe("stopped");
  expect(blocked?.last_input_request_at).not.toBeNull();
  expect(blocked?.last_input_request_kind).toBe("ask_user_question");

  // The human answers — UserPromptSubmit unconditionally clears BOTH
  // columns of the pair (paired-NULL invariant) and flips state to
  // 'working'.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-ups" });
  drainAll();
  const revived = getInputRequestState("sess-ir-ups");
  expect(revived?.state).toBe("working");
  expect(revived?.last_input_request_at).toBeNull();
  expect(revived?.last_input_request_kind).toBeNull();
});

test("InputRequest clear arms: SessionStart resume clears the pair (paired-NULL clear)", () => {
  // Set up a blocked row, then drive a resume via a duplicate SessionStart.
  // The ON CONFLICT branch is what fires on resume; that's the v25-extended
  // clear path.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-ss" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-ss" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-ss",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const blocked = getInputRequestState("sess-ir-ss");
  expect(blocked?.last_input_request_at).not.toBeNull();
  expect(blocked?.last_input_request_kind).toBe("ask_user_question");

  // Duplicate SessionStart — resume. The ON CONFLICT branch unconditionally
  // clears the input-request pair (paired-NULL invariant); the rest of the
  // ON CONFLICT semantics (terminal→stopped, pid/start_time COALESCE) are
  // unaffected.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-ss" });
  drainAll();
  const resumed = getInputRequestState("sess-ir-ss");
  expect(resumed?.last_input_request_at).toBeNull();
  expect(resumed?.last_input_request_kind).toBeNull();
});

test("InputRequest clear arms: PreToolUse + PostToolUse clear the pair (gated on IS NOT NULL)", () => {
  // The hot-path clear arms: AskUserQuestion fires no hook of its own, so
  // the closest "answered" signal is the next tool the agent uses. The
  // gate on `last_input_request_at IS NOT NULL` keeps the cost at zero
  // for the overwhelming majority of tool calls — without the gate, every
  // tool call in every session would no-op-write the pair to NULL.

  // PreToolUse arm: blocked → PreToolUse clears.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-pre" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-pre" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-pre",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  expect(
    getInputRequestState("sess-ir-pre")?.last_input_request_at,
  ).not.toBeNull();
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-pre",
  });
  drainAll();
  expect(getInputRequestState("sess-ir-pre")?.last_input_request_at).toBeNull();
  expect(
    getInputRequestState("sess-ir-pre")?.last_input_request_kind,
  ).toBeNull();
  // fn-808: the clear UPDATE also un-stops the row — a tool event proves the
  // human answered and the session resumed.
  expect(getInputRequestState("sess-ir-pre")?.state).toBe("working");

  // PostToolUse arm: blocked → PostToolUse clears.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-post" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-post" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-post",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  expect(
    getInputRequestState("sess-ir-post")?.last_input_request_at,
  ).not.toBeNull();
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-post",
  });
  drainAll();
  expect(
    getInputRequestState("sess-ir-post")?.last_input_request_at,
  ).toBeNull();
  expect(
    getInputRequestState("sess-ir-post")?.last_input_request_kind,
  ).toBeNull();
  // fn-808: PostToolUse un-stops the row too.
  expect(getInputRequestState("sess-ir-post")?.state).toBe("working");
});

test("InputRequest clear gate: PreToolUse/PostToolUse on a session with last_input_request_at IS NULL does NOT touch jobs (no last_event_id bump)", () => {
  // Hot-path no-op gate: without the `IS NOT NULL` predicate, every tool
  // call in every session would no-op-write the pair (already NULL),
  // bumping last_event_id + updated_at and re-fanning embedded arrays.
  // Pin the gate by asserting `last_event_id` does NOT advance past the
  // pre-tool-call snapshot when there's no annotation to clear.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-gate" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-gate" });
  drainAll();
  const before = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
    .get("sess-ir-gate") as { last_event_id: number };
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-gate",
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-gate",
  });
  drainAll();
  const after = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
    .get("sess-ir-gate") as { last_event_id: number };
  // No clear-arm UPDATE fired, so jobs.last_event_id stayed at the
  // UserPromptSubmit event id. (PreToolUse / PostToolUse have no other
  // jobs-write path on this session — no plan_ref, no plan_op.)
  expect(after.last_event_id).toBe(before.last_event_id);
});

test("InputRequest re-fold determinism: rewind-and-redrain reproduces byte-identical jobs row", () => {
  // CLAUDE.md byte-identical re-fold invariant: a from-scratch re-fold of
  // the event log must reproduce jobs row byte-for-byte. Exercises the
  // InputRequest stamp + a clear arm (UserPromptSubmit).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-redrain" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-ir-redrain",
  });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-redrain",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  // Then a fresh prompt clears the pair — exercises both the stamp arm
  // and the unconditional UPS clear arm on re-fold.
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-ir-redrain",
  });
  drainAll();
  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-ir-redrain");
  expect(before).not.toBeNull();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-ir-redrain");
  expect(after).toEqual(before);
});

test("syncJobLinksOnJobWrite: InputRequest stamp propagates to epics.job_links; UPS revival clears it", () => {
  // Mirrors the v24 RateLimited link-fan-out test shape: a session linked
  // to an epic gets blocked → the reverse fan-out propagates the
  // input-request pair into the linked epic's `epics.job_links[]` entry;
  // a fresh UserPromptSubmit revives → the reverse fan-out propagates
  // the paired clear back into the link entry.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-link" });
  planPlanOpener("sess-ir-link");
  planEvent({
    sessionId: "sess-ir-link",
    op: "epic-create",
    target: "fn-15-ir",
    epicId: "fn-15-ir",
    subjectPresent: true,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-link" });
  drainAll();
  // Initial: both fields NULL on the link entry.
  expect(getJobLinks("fn-15-ir")[0]?.last_input_request_at).toBeNull();
  expect(getJobLinks("fn-15-ir")[0]?.last_input_request_kind).toBeNull();

  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-link",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const blocked = getJobLinks("fn-15-ir")[0];
  expect(blocked?.state).toBe("stopped");
  expect(blocked?.last_input_request_at).not.toBeNull();
  expect(blocked?.last_input_request_kind).toBe("ask_user_question");

  // Revival via UserPromptSubmit — reverse fan-out propagates the paired
  // clear to the embedded entry.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-link" });
  drainAll();
  const revived = getJobLinks("fn-15-ir")[0];
  expect(revived?.state).toBe("working");
  expect(revived?.last_input_request_at).toBeNull();
  expect(revived?.last_input_request_kind).toBeNull();
});

// ---------------------------------------------------------------------------
// Pre/PostToolUse api-error clear + un-stop family (fn-808 task .1)
//
// A tool event after an ApiError/RateLimited or InputRequest stop proves the
// session resumed (CLI retried the transient error / human answered the
// question), so the Pre/PostToolUse fold clears the annotation pair AND
// un-stops the row back to `working` — the board never shows a dead/failed
// worker that is actually running.
// ---------------------------------------------------------------------------

/**
 * Read just `state` + the api-error pair + active_since off a jobs row by id.
 * Parallel to the v25 `getInputRequestState` helper; none existed for the
 * api-error pair before fn-808.
 */
function getApiErrorState(jobId: string): {
  state: string;
  last_api_error_at: number | null;
  last_api_error_kind: string | null;
  active_since: number | null;
} | null {
  return db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind, active_since FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
    active_since: number | null;
  } | null;
}

test("ApiError stale-stop → tool event un-stops to 'working', clears the pair, stamps active_since", () => {
  // Matrix item 1: a transient ApiError flips the row to 'stopped' and stamps
  // the (at, kind) pair; the next tool event proves the CLI resumed, so the
  // Pre/PostToolUse fold un-stops the row to 'working', NULLs the pair, and
  // stamps active_since to the tool-event ts (the genuine stopped→working
  // rising edge).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ae-unstop" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ae-unstop" });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-ae-unstop",
    data: JSON.stringify({ kind: "server_error" }),
  });
  drainAll();
  const stopped = getApiErrorState("sess-ae-unstop");
  expect(stopped?.state).toBe("stopped");
  expect(stopped?.last_api_error_at).not.toBeNull();
  expect(stopped?.last_api_error_kind).toBe("server_error");

  const toolId = insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ae-unstop",
  });
  drainAll();
  const resumed = getApiErrorState("sess-ae-unstop");
  expect(resumed?.state).toBe("working");
  expect(resumed?.last_api_error_at).toBeNull();
  expect(resumed?.last_api_error_kind).toBeNull();
  // active_since stamped to the tool-event ts on the stopped→working edge.
  const toolTs = (
    db.query("SELECT ts FROM events WHERE id = ?").get(toolId) as { ts: number }
  ).ts;
  expect(resumed?.active_since).toBe(toolTs);
});

test("RateLimited (legacy alias) stale-stop → tool event un-stops to 'working', clears the pair", () => {
  // Matrix item 2: the legacy `RateLimited` arm folds kind='rate_limit' onto
  // the same api-error pair as `ApiError`. A tool event un-stops it identically
  // — keeping the RateLimited/ApiError fold-equivalence honest across the new
  // clear arm too. PostToolUse this time (both Pre and Post drive the clear).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rl-unstop" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rl-unstop" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-rl-unstop" });
  drainAll();
  const stopped = getApiErrorState("sess-rl-unstop");
  expect(stopped?.state).toBe("stopped");
  expect(stopped?.last_api_error_kind).toBe("rate_limit");

  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-rl-unstop",
  });
  drainAll();
  const resumed = getApiErrorState("sess-rl-unstop");
  expect(resumed?.state).toBe("working");
  expect(resumed?.last_api_error_at).toBeNull();
  expect(resumed?.last_api_error_kind).toBeNull();
});

test("Subagent-suppressed api-error: pair stamped while state stayed 'working' → tool event clears pair, leaves state + active_since untouched", () => {
  // Matrix item 3: the ApiError arm suppresses the state flip while a subagent
  // is running (parent isn't making API calls while it waits on a sub) but
  // stamps the pair unconditionally. So the row carries the pair while state
  // stayed 'working'. The new clear's literal-'stopped' gate is load-bearing:
  // it NULLs the pair but, because state is NOT 'stopped', leaves both state
  // AND active_since untouched — the dash timeline sort key must not churn on
  // every tool event in this case.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ae-sub" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ae-sub" });
  insertEvent({
    hook_event: "SubagentStart",
    session_id: "sess-ae-sub",
    agent_id: "sub-ae",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-ae-sub",
    data: JSON.stringify({ kind: "server_error" }),
  });
  drainAll();
  const stamped = getApiErrorState("sess-ae-sub");
  // Pair stamped, but state stayed 'working' (sub-agent suppression).
  expect(stamped?.state).toBe("working");
  expect(stamped?.last_api_error_at).not.toBeNull();
  expect(stamped?.last_api_error_kind).toBe("server_error");
  const activeSinceBefore = stamped?.active_since;

  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ae-sub",
  });
  drainAll();
  const cleared = getApiErrorState("sess-ae-sub");
  // Pair cleared, but state stays 'working' and active_since is UNCHANGED —
  // there was no stopped→working edge to stamp.
  expect(cleared?.state).toBe("working");
  expect(cleared?.last_api_error_at).toBeNull();
  expect(cleared?.last_api_error_kind).toBeNull();
  expect(cleared?.active_since).toBe(activeSinceBefore ?? null);
});

test("InputRequest stale-stop → tool event un-stops to 'working' (state now follows the pair clear)", () => {
  // Matrix item 4: the input-request clear already NULLed the pair on a tool
  // event (covered above); fn-808 folds the un-stop INTO that same UPDATE so
  // state follows. A human-answered question resumes the session.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ir-unstop" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ir-unstop" });
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-ir-unstop",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  expect(getInputRequestState("sess-ir-unstop")?.state).toBe("stopped");

  const toolId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-ir-unstop",
  });
  drainAll();
  const resumed = getInputRequestState("sess-ir-unstop");
  expect(resumed?.state).toBe("working");
  expect(resumed?.last_input_request_at).toBeNull();
  expect(resumed?.last_input_request_kind).toBeNull();
  // active_since stamped to the tool-event ts on the stopped→working edge.
  const toolTs = (
    db.query("SELECT ts FROM events WHERE id = ?").get(toolId) as { ts: number }
  ).ts;
  const activeSince = (
    db
      .query("SELECT active_since FROM jobs WHERE job_id = ?")
      .get("sess-ir-unstop") as { active_since: number | null }
  ).active_since;
  expect(activeSince).toBe(toolTs);
});

test("Terminal guard: killed row with a stale api-error pair → tool event clears the pair, state stays 'killed'", () => {
  // Matrix item 5: the literal-'stopped' un-stop gate can NEVER resurrect a
  // terminal row. A killed row carrying a stale api-error pair gets its pair
  // cleared on the next tool event, but state stays 'killed' (it is not
  // 'stopped', so the CASE is a no-op). This is the terminal-row guard rail.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ae-killed" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ae-killed" });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-ae-killed",
    data: JSON.stringify({ kind: "server_error" }),
  });
  // Kill the row while the pair is stamped (Killed forces state='killed';
  // the api-error pair stays on the row — Killed does not clear it).
  killedEvent(4242, null, "sess-ae-killed");
  drainAll();
  const killed = getApiErrorState("sess-ae-killed");
  expect(killed?.state).toBe("killed");
  expect(killed?.last_api_error_at).not.toBeNull();
  const activeSinceBefore = killed?.active_since;

  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ae-killed",
  });
  drainAll();
  const cleared = getApiErrorState("sess-ae-killed");
  // Pair cleared; state stays 'killed'; active_since untouched (no edge).
  expect(cleared?.state).toBe("killed");
  expect(cleared?.last_api_error_at).toBeNull();
  expect(cleared?.last_api_error_kind).toBeNull();
  expect(cleared?.active_since).toBe(activeSinceBefore ?? null);
});

test("api-error clear gate: PreToolUse/PostToolUse on a session with last_api_error_at IS NULL does NOT touch jobs (no last_event_id bump)", () => {
  // Matrix item 6 (mirror of the input-request no-op gate test): with both
  // pairs NULL, neither clear arm fires, so jobs.last_event_id must NOT advance
  // past the pre-tool-call snapshot. Pins the `IS NOT NULL` gate that keeps the
  // UPDATE cold on the 50+/turn tool-event path.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ae-gate" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-ae-gate" });
  drainAll();
  const before = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
    .get("sess-ae-gate") as { last_event_id: number };
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ae-gate",
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-ae-gate",
  });
  drainAll();
  const after = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
    .get("sess-ae-gate") as { last_event_id: number };
  expect(after.last_event_id).toBe(before.last_event_id);
});

test("api-error un-stop re-fold determinism: rewind-and-redrain reproduces byte-identical jobs row (stamp→stop→tool→working)", () => {
  // Matrix item 7 (CLAUDE.md byte-identical re-fold invariant): a from-scratch
  // re-fold of the stamp→stop→tool→working sequence must reproduce the jobs row
  // byte-for-byte. Exercises both the ApiError stamp arm and the new
  // Pre/PostToolUse clear+un-stop arm on re-fold.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-ae-redrain" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-ae-redrain",
  });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-ae-redrain",
    data: JSON.stringify({ kind: "server_error" }),
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-ae-redrain",
  });
  drainAll();
  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-ae-redrain");
  expect(before).not.toBeNull();
  // Sanity: the sequence really did un-stop the row.
  expect((before as { state: string }).state).toBe("working");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-ae-redrain");
  expect(after).toEqual(before);
});

test("both pairs set on one row → one tool event un-stops via the first UPDATE, second UPDATE no-ops (deterministic)", () => {
  // Risk-note coverage: if both the api-error and input-request pairs are set
  // on a 'stopped' row, ONE tool event fires both clear UPDATEs in fixed
  // statement order — the first un-stops + stamps active_since, the second's
  // CASEs see state already 'working' and no-op on state/active_since. Both
  // pairs end NULL; re-fold must reproduce it. The api-error arm runs first.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-both-pairs" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-both-pairs",
  });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-both-pairs",
    data: JSON.stringify({ kind: "server_error" }),
  });
  // A second stop event stamps the input-request pair on the same (now
  // 'stopped') row — the terminal guard lets it through (state is 'stopped',
  // not ended/killed), so both pairs co-exist.
  insertEvent({
    hook_event: "InputRequest",
    session_id: "sess-both-pairs",
    data: JSON.stringify({ kind: "ask_user_question" }),
  });
  drainAll();
  const stopped = db
    .query(
      "SELECT state, last_api_error_at, last_input_request_at FROM jobs WHERE job_id = ?",
    )
    .get("sess-both-pairs") as {
    state: string;
    last_api_error_at: number | null;
    last_input_request_at: number | null;
  };
  expect(stopped.state).toBe("stopped");
  expect(stopped.last_api_error_at).not.toBeNull();
  expect(stopped.last_input_request_at).not.toBeNull();

  const toolId = insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-both-pairs",
  });
  drainAll();
  const resumed = db
    .query(
      "SELECT state, last_api_error_at, last_input_request_at, active_since FROM jobs WHERE job_id = ?",
    )
    .get("sess-both-pairs") as {
    state: string;
    last_api_error_at: number | null;
    last_input_request_at: number | null;
    active_since: number | null;
  };
  expect(resumed.state).toBe("working");
  expect(resumed.last_api_error_at).toBeNull();
  expect(resumed.last_input_request_at).toBeNull();
  const toolTs = (
    db.query("SELECT ts FROM events WHERE id = ?").get(toolId) as { ts: number }
  ).ts;
  expect(resumed.active_since).toBe(toolTs);

  // Re-fold determinism over the both-pairs sequence.
  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-both-pairs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const refolded = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-both-pairs");
  expect(refolded).toEqual(before);
});

// ---------------------------------------------------------------------------
// Notification:permission_prompt / Notification:elicitation_dialog fold
// (schema v52, fn-686 task .1)
// ---------------------------------------------------------------------------

/**
 * Read just `state` + the permission-prompt pair off a jobs row by id.
 * Mirrors the v25 `getInputRequestState` helper so the fn-686 tests
 * follow the same shape, but excluding the state→pair coupling assertion
 * the input-request tests had (the permission-prompt arm intentionally
 * does NOT flip `state`).
 */
function getPermissionPromptState(jobId: string): {
  state: string;
  last_permission_prompt_at: number | null;
  last_permission_prompt_kind: string | null;
} | null {
  return db
    .query(
      "SELECT state, last_permission_prompt_at, last_permission_prompt_kind FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as {
    state: string;
    last_permission_prompt_at: number | null;
    last_permission_prompt_kind: string | null;
  } | null;
}

test("Notification:permission_prompt fold: stamps both columns and does NOT flip state from 'working'", () => {
  // Keystone bullet: a real `Notification` hook event whose `event_type`
  // is `permission_prompt` stamps `(last_permission_prompt_at,
  // last_permission_prompt_kind='permission')` and leaves state at
  // 'working' — the WHOLE POINT of the divergence from the InputRequest
  // arm. The pill layers on top of `[working]`, not replacing it.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp" });
  drainAll();
  const before = getPermissionPromptState("sess-pp");
  expect(before?.state).toBe("working");
  expect(before?.last_permission_prompt_at).toBeNull();
  expect(before?.last_permission_prompt_kind).toBeNull();

  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: "sess-pp",
  });
  drainAll();
  const after = getPermissionPromptState("sess-pp");
  expect(after?.state).toBe("working"); // NO state flip — distinct from InputRequest
  expect(after?.last_permission_prompt_at).not.toBeNull();
  expect(after?.last_permission_prompt_kind).toBe("permission");
});

test("Notification:elicitation_dialog fold: stamps kind='elicitation' and does NOT flip state", () => {
  // The second whitelisted subtype — folds identically to permission_prompt
  // but stamps `kind='elicitation'`. Both share the no-state-flip behavior.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-el" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-el" });
  drainAll();
  insertEvent({
    hook_event: "Notification",
    event_type: "elicitation_dialog",
    session_id: "sess-el",
  });
  drainAll();
  const after = getPermissionPromptState("sess-el");
  expect(after?.state).toBe("working");
  expect(after?.last_permission_prompt_at).not.toBeNull();
  expect(after?.last_permission_prompt_kind).toBe("elicitation");
});

test.each([["auth_success"], ["totally-unknown-subtype"], [""]])(
  "Notification:%s does NOT stamp (strict gate — only permission_prompt + elicitation_dialog stamp)",
  (eventType: string) => {
    // Strict gate: these `event_type` values outside the allow-list are no-ops.
    // Pin every one explicitly so a future code path that widens the map without
    // widening the allow-list gets caught. `idle_prompt` is deliberately NOT in
    // this set: it is a claude-authored POSITIVE idle signal that folds working
    // -> stopped as a quiescence (ADR 0013 layer 2), a separate discriminator
    // that never stamps the permission-prompt pair — its fold is exercised in
    // test/reducer-lifecycle.test.ts, not here.
    const sessionId = `sess-pp-gate-${eventType || "empty"}`;
    insertEvent({ hook_event: "SessionStart", session_id: sessionId });
    insertEvent({ hook_event: "UserPromptSubmit", session_id: sessionId });
    drainAll();
    const before = db
      .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
      .get(sessionId) as { last_event_id: number };
    insertEvent({
      hook_event: "Notification",
      event_type: eventType,
      session_id: sessionId,
    });
    drainAll();
    const after = getPermissionPromptState(sessionId);
    expect(after?.state).toBe("working");
    expect(after?.last_permission_prompt_at).toBeNull();
    expect(after?.last_permission_prompt_kind).toBeNull();
    // last_event_id MUST NOT advance — strict gate means a no-op,
    // not a defensive no-op-write.
    const afterEvtId = db
      .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
      .get(sessionId) as { last_event_id: number };
    expect(afterEvtId.last_event_id).toBe(before.last_event_id);
  },
);

test("Notification fold: terminal-row guard preserved — permission_prompt on 'ended' / 'killed' does NOT stamp", () => {
  // Clone of the v25 InputRequest terminal-guard test. The pair must NOT
  // mid-life-stamp an already-terminal row.

  // 'ended' row.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-ended" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-ended" });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-pp-ended" });
  drainAll();
  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: "sess-pp-ended",
  });
  drainAll();
  const ended = getPermissionPromptState("sess-pp-ended");
  expect(ended?.state).toBe("ended");
  expect(ended?.last_permission_prompt_at).toBeNull();
  expect(ended?.last_permission_prompt_kind).toBeNull();

  // 'killed' row — hand-set lifecycle.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-killed" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-killed" });
  drainAll();
  db.run("UPDATE jobs SET state = 'killed' WHERE job_id = 'sess-pp-killed'");
  insertEvent({
    hook_event: "Notification",
    event_type: "elicitation_dialog",
    session_id: "sess-pp-killed",
  });
  drainAll();
  const killed = getPermissionPromptState("sess-pp-killed");
  expect(killed?.state).toBe("killed");
  expect(killed?.last_permission_prompt_at).toBeNull();
  expect(killed?.last_permission_prompt_kind).toBeNull();
});

test("Notification clear arms: UserPromptSubmit clears the pair (paired-NULL clear)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-ups" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-ups" });
  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: "sess-pp-ups",
  });
  drainAll();
  const blocked = getPermissionPromptState("sess-pp-ups");
  expect(blocked?.last_permission_prompt_at).not.toBeNull();
  expect(blocked?.last_permission_prompt_kind).toBe("permission");

  // Human answers the dialog → next UserPromptSubmit clears the pair.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-ups" });
  drainAll();
  const revived = getPermissionPromptState("sess-pp-ups");
  expect(revived?.state).toBe("working");
  expect(revived?.last_permission_prompt_at).toBeNull();
  expect(revived?.last_permission_prompt_kind).toBeNull();
});

test("Notification clear arms: SessionStart resume clears the pair", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-ss" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-ss" });
  insertEvent({
    hook_event: "Notification",
    event_type: "elicitation_dialog",
    session_id: "sess-pp-ss",
  });
  drainAll();
  const blocked = getPermissionPromptState("sess-pp-ss");
  expect(blocked?.last_permission_prompt_at).not.toBeNull();
  expect(blocked?.last_permission_prompt_kind).toBe("elicitation");

  // Resume via duplicate SessionStart — ON CONFLICT clears the pair.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-ss" });
  drainAll();
  const resumed = getPermissionPromptState("sess-pp-ss");
  expect(resumed?.last_permission_prompt_at).toBeNull();
  expect(resumed?.last_permission_prompt_kind).toBeNull();
});

test("Notification clear arms: PreToolUse + PostToolUse clear the pair (gated on IS NOT NULL)", () => {
  // PreToolUse arm.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-pre" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-pre" });
  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: "sess-pp-pre",
  });
  drainAll();
  expect(
    getPermissionPromptState("sess-pp-pre")?.last_permission_prompt_at,
  ).not.toBeNull();
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-pp-pre",
  });
  drainAll();
  expect(
    getPermissionPromptState("sess-pp-pre")?.last_permission_prompt_at,
  ).toBeNull();
  expect(
    getPermissionPromptState("sess-pp-pre")?.last_permission_prompt_kind,
  ).toBeNull();

  // PostToolUse arm.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-post" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-post" });
  insertEvent({
    hook_event: "Notification",
    event_type: "elicitation_dialog",
    session_id: "sess-pp-post",
  });
  drainAll();
  expect(
    getPermissionPromptState("sess-pp-post")?.last_permission_prompt_at,
  ).not.toBeNull();
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-pp-post",
  });
  drainAll();
  expect(
    getPermissionPromptState("sess-pp-post")?.last_permission_prompt_at,
  ).toBeNull();
  expect(
    getPermissionPromptState("sess-pp-post")?.last_permission_prompt_kind,
  ).toBeNull();
});

test("Notification clear arms: Stop is the session-level backstop (gated on IS NOT NULL)", () => {
  // The one NEW clear arm relative to v25. Even if the dialog resolved
  // off-band (no tool call after, no UPS), a Stop sweeps the annotation —
  // a Stop logically cannot fire while a permission dialog is up.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-stop" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-stop" });
  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: "sess-pp-stop",
  });
  drainAll();
  expect(
    getPermissionPromptState("sess-pp-stop")?.last_permission_prompt_at,
  ).not.toBeNull();
  insertEvent({ hook_event: "Stop", session_id: "sess-pp-stop" });
  drainAll();
  expect(
    getPermissionPromptState("sess-pp-stop")?.last_permission_prompt_at,
  ).toBeNull();
  expect(
    getPermissionPromptState("sess-pp-stop")?.last_permission_prompt_kind,
  ).toBeNull();
});

test("Notification clear gate: PreToolUse/PostToolUse on a session with last_permission_prompt_at IS NULL does NOT touch jobs", () => {
  // Hot-path no-op gate clone of the v25 IR test. Without
  // `IS NOT NULL`, every tool call would no-op-write the pair and
  // re-fan embedded arrays. Pin the gate by asserting `last_event_id`
  // does NOT advance.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-gate-tool" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-pp-gate-tool",
  });
  drainAll();
  const before = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
    .get("sess-pp-gate-tool") as { last_event_id: number };
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-pp-gate-tool",
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-pp-gate-tool",
  });
  drainAll();
  const after = db
    .query("SELECT last_event_id FROM jobs WHERE job_id = ?")
    .get("sess-pp-gate-tool") as { last_event_id: number };
  expect(after.last_event_id).toBe(before.last_event_id);
});

test("Notification re-set: a second permission_prompt re-writes last_permission_prompt_at (not increment)", () => {
  // Pure monotone fold: a re-prompt re-stamps `_at` to the new event ts.
  // Re-fold determinism — the stamp value is `event.ts`, not a counter,
  // so a from-scratch re-fold reproduces the same final value.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-reset" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-pp-reset" });
  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: "sess-pp-reset",
  });
  drainAll();
  const first = getPermissionPromptState("sess-pp-reset");
  expect(first?.last_permission_prompt_at).not.toBeNull();
  const firstAt = first?.last_permission_prompt_at;

  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: "sess-pp-reset",
  });
  drainAll();
  const second = getPermissionPromptState("sess-pp-reset");
  expect(second?.last_permission_prompt_at).not.toBeNull();
  // Re-set, not increment — the second `_at` reflects the second event's
  // ts, which is `tsCounter`-advanced past the first.
  expect(second?.last_permission_prompt_at).not.toBe(firstAt);
});

test("Notification re-fold determinism: rewind-and-redrain reproduces byte-identical jobs row", () => {
  // CLAUDE.md byte-identical re-fold invariant: from-scratch re-fold
  // must reproduce the jobs row. Exercises permission_prompt stamp +
  // UserPromptSubmit clear + a second permission_prompt + final
  // UserPromptSubmit, so both arms ride the rewind. UNLIKE the v25 IR
  // rewind which folded zero historical events, this rewind DOES fold
  // real permission_prompt rows — the stamp value is pure `event.ts`,
  // so the redrain reproduces deterministic stamps.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pp-redrain" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-pp-redrain",
  });
  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: "sess-pp-redrain",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-pp-redrain",
  });
  insertEvent({
    hook_event: "Notification",
    event_type: "elicitation_dialog",
    session_id: "sess-pp-redrain",
  });
  drainAll();
  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-pp-redrain");
  expect(before).not.toBeNull();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-pp-redrain");
  expect(after).toEqual(before);
});
