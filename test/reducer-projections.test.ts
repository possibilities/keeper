/**
 * Reducer tests — shard 4 of 4 (fn-769 fast-tier split of the former
 * monolithic reducer.test.ts). Theme: autopilot, dispatch, name-history, planctl-file, backend-exec, monitors projections.
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
  type BuildSnapshotPayload,
  drain,
  extractBuildSnapshot,
  serializeBuildSnapshot,
} from "../src/reducer";
import type { Event } from "../src/types";
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
    planctl_files?: string | null;
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
    planctl_op: overrides.planctl_op ?? null,
    planctl_target: overrides.planctl_target ?? null,
    planctl_epic_id: overrides.planctl_epic_id ?? null,
    planctl_task_id: overrides.planctl_task_id ?? null,
    planctl_subject_present: overrides.planctl_subject_present ?? null,
    tool_use_id: overrides.tool_use_id ?? null,
    config_dir: overrides.config_dir ?? null,
    // Schema v30: queue-jump sparse column; NULL unless this is a planctl
    // event whose envelope carried `queue_jump: true` (stamped 1) or any
    // other planctl event (stamped 0). The test helper defaults to NULL so
    // every non-planctl event lands NULL — matches the live hook's stamping
    // contract (see `plugin/hooks/events-writer.ts`).
    planctl_queue_jump: overrides.planctl_queue_jump ?? null,
    // Schema v31: bash-mutation deriver sparse columns. NULL on every row
    // whose payload didn't match a mutation pattern; defaults to NULL here
    // so a non-Bash event lands NULL. Tests covering bash attribution pass
    // these explicitly via the overrides.
    bash_mutation_kind: overrides.bash_mutation_kind ?? null,
    bash_mutation_targets: overrides.bash_mutation_targets ?? null,
    // Schema v46 / fn-666: planctl_files sparse JSON-array column carrying
    // the envelope's repo-relative `files` array. NULL on every non-planctl
    // event; planctl-mint tests pass this explicitly via overrides.
    planctl_files: overrides.planctl_files ?? null,
    // Schema v48 / fn-668: backend-exec coordinates (terminal-multiplexer
    // session/pane the parent Claude ran under). NULL on every event outside a
    // managed multiplexer; backend-exec-mint tests pass these via overrides.
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
       planctl_op, planctl_target, planctl_epic_id, planctl_task_id,
       planctl_subject_present, tool_use_id, config_dir, planctl_queue_jump,
       bash_mutation_kind, bash_mutation_targets, planctl_files,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
       background_task_id
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
      row.planctl_op,
      row.planctl_target,
      row.planctl_epic_id,
      row.planctl_task_id,
      row.planctl_subject_present,
      row.tool_use_id,
      row.config_dir,
      row.planctl_queue_jump,
      row.bash_mutation_kind,
      row.bash_mutation_targets,
      row.planctl_files,
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

const TEST_OID = "0123456789abcdef0123456789abcdef01234567";

const TEST_OID_2 = "fedcba9876543210fedcba9876543210fedcba98";

const TEST_UUID = "01234567-89ab-cdef-0123-456789abcdef";

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
   * Planctl-native effort tier (fn-602): rides FREE in the embedded JSON
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

function planctlEvent(args: {
  sessionId: string;
  op: string;
  target: string | null;
  epicId: string | null;
  taskId?: string | null;
  subjectPresent: boolean;
  // Schema v30: optional queue-jump flag. Defaults `false` so existing tests
  // (every one written before v30) keep their old shape; new tests opt in by
  // passing `queueJump: true` to drive the `/plan:queue` projection path.
  queueJump?: boolean;
  // Schema v46 / fn-666: optional repo-relative `files[]` to lift into
  // `events.planctl_files` AND inline into the envelope's `state_repo`
  // payload (so the reducer's mint can read `state_repo` from event.data).
  // Defaults `undefined` — existing tests keep their old null-on-planctl
  // shape and the mint becomes a no-op for them.
  files?: string[];
  stateRepo?: string;
  ts?: number;
}): number {
  // When mint-test args (`files` + `stateRepo`) are passed, also inline the
  // canonical envelope `{tool_response:{stdout:JSON({planctl_invocation:
  // {state_repo, files, op, target, ...}})}}` into `data` so the reducer's
  // `extractPlanctlStateRepo` can lift `state_repo` at fold time. Existing
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
    planctl_op: args.op,
    planctl_target: args.target,
    planctl_epic_id: args.epicId,
    planctl_task_id: args.taskId ?? null,
    planctl_subject_present: args.subjectPresent ? 1 : 0,
    planctl_queue_jump: args.queueJump ? 1 : 0,
    planctl_files: args.files != null ? JSON.stringify(args.files) : null,
    data,
  });
}

// ---------------------------------------------------------------------------
// Profiles projection (schema v33, fn-639) — `config_dir`-keyed correlation
// of the last `rate_limit` ApiError with each Claude profile.
// ---------------------------------------------------------------------------

test("SessionStart seeds a profiles row keyed on config_dir; NULL config_dir collapses to the '' sentinel (fn-639)", () => {
  // Three SessionStarts on three distinct config dirs (including NULL).
  // Each seeds its own row; the NULL bucket collapses to '' via the
  // COALESCE in the seed UPSERT. Quiet profiles (no rate_limit) carry
  // NULL last_rate_limit_at — the seed only stamps last_event_id +
  // updated_at.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-a",
    config_dir: "/Users/x/.claude-profiles/multi-claude-1",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-b",
    config_dir: "/Users/x/.claude-profiles/multi-claude-2",
  });
  // NULL → '' sentinel.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default",
    config_dir: null,
  });
  drainAll();
  const rows = db
    .query(
      "SELECT config_dir, last_rate_limit_at, last_rate_limit_session_id FROM profiles ORDER BY config_dir ASC",
    )
    .all() as {
    config_dir: string;
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
  }[];
  expect(rows).toEqual([
    {
      config_dir: "",
      last_rate_limit_at: null,
      last_rate_limit_session_id: null,
    },
    {
      config_dir: "/Users/x/.claude-profiles/multi-claude-1",
      last_rate_limit_at: null,
      last_rate_limit_session_id: null,
    },
    {
      config_dir: "/Users/x/.claude-profiles/multi-claude-2",
      last_rate_limit_at: null,
      last_rate_limit_session_id: null,
    },
  ]);
});

test("SessionStart seed is INSERT OR IGNORE: a duplicate SessionStart on the same config_dir does not re-stamp last_event_id (fn-639)", () => {
  // First SessionStart seeds the row. A second SessionStart on the SAME
  // config_dir (resume, or a different session under the same profile)
  // must NOT overwrite — INSERT OR IGNORE keeps the first seed's
  // (last_event_id, updated_at).
  const id1 = insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-a",
    config_dir: "/p/A",
  });
  drainAll();
  const after1 = db
    .query(
      "SELECT last_event_id, updated_at FROM profiles WHERE config_dir = '/p/A'",
    )
    .get() as { last_event_id: number; updated_at: number };
  expect(after1.last_event_id).toBe(id1);

  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-b",
    config_dir: "/p/A",
  });
  drainAll();
  const after2 = db
    .query(
      "SELECT last_event_id, updated_at FROM profiles WHERE config_dir = '/p/A'",
    )
    .get() as { last_event_id: number; updated_at: number };
  // Unchanged — the first seed's last_event_id stuck.
  expect(after2.last_event_id).toBe(id1);
  expect(after2.updated_at).toBe(after1.updated_at);
});

test("RateLimited UPSERTs last_rate_limit_at + last_rate_limit_session_id keyed on the session's config_dir (fn-639)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-rl",
    config_dir: "/Users/x/.claude-profiles/multi-claude-3",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rl" });
  const rlId = insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-rl",
  });
  drainAll();
  const row = db
    .query(
      "SELECT config_dir, last_rate_limit_at, last_rate_limit_session_id, last_event_id FROM profiles WHERE config_dir = ?",
    )
    .get("/Users/x/.claude-profiles/multi-claude-3") as {
    config_dir: string;
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
    last_event_id: number;
  };
  expect(row.last_rate_limit_at).not.toBeNull();
  expect(row.last_rate_limit_session_id).toBe("sess-rl");
  expect(row.last_event_id).toBe(rlId);
});

test("ApiError(kind='rate_limit') folds to byte-identical profiles row as a sibling RateLimited (fn-639)", () => {
  // Dual-case parity: the legacy RateLimited synthetic and the v24 ApiError
  // with data.kind='rate_limit' MUST land identical (last_rate_limit_session_id,
  // config_dir) on the profile row. Two parallel sessions under TWO distinct
  // config dirs — one fires RateLimited, the other fires ApiError(rate_limit) —
  // then assert both profiles carry the matching last_rate_limit_session_id.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-legacy",
    config_dir: "/p/legacy",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-legacy" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-legacy" });

  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-new",
    config_dir: "/p/new",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-new" });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-new",
    data: JSON.stringify({ kind: "rate_limit" }),
  });
  drainAll();
  const legacy = db
    .query(
      "SELECT last_rate_limit_session_id FROM profiles WHERE config_dir = '/p/legacy'",
    )
    .get() as { last_rate_limit_session_id: string };
  expect(legacy.last_rate_limit_session_id).toBe("sess-legacy");
  const fresh = db
    .query(
      "SELECT last_rate_limit_session_id FROM profiles WHERE config_dir = '/p/new'",
    )
    .get() as { last_rate_limit_session_id: string };
  expect(fresh.last_rate_limit_session_id).toBe("sess-new");
});

test("Non-rate_limit ApiError kinds do NOT touch the profiles row (fn-639)", () => {
  // Profiles is the rate_limit-only correlation surface; the five non-
  // rate_limit ApiErrorKind values must not stamp the rate-limit columns
  // (the seed row stays NULL on last_rate_limit_*).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-auth",
    config_dir: "/p/auth",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-auth" });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-auth",
    data: JSON.stringify({ kind: "authentication_failed" }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT last_rate_limit_at, last_rate_limit_session_id FROM profiles WHERE config_dir = '/p/auth'",
    )
    .get() as {
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
  };
  expect(row.last_rate_limit_at).toBeNull();
  expect(row.last_rate_limit_session_id).toBeNull();
});

test("Last-write-wins: a second rate_limit on the same profile overwrites the first (fn-639)", () => {
  // Two RateLimited events under the same config_dir from two distinct
  // sessions. Events fold in id order, so the SECOND (higher id) lands on
  // the row.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-first",
    config_dir: "/p/shared",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-first" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-first" });

  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-second",
    config_dir: "/p/shared",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-second" });
  const secondRlId = insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-second",
  });
  drainAll();
  const row = db
    .query(
      "SELECT last_rate_limit_session_id, last_event_id FROM profiles WHERE config_dir = '/p/shared'",
    )
    .get() as { last_rate_limit_session_id: string; last_event_id: number };
  expect(row.last_rate_limit_session_id).toBe("sess-second");
  expect(row.last_event_id).toBe(secondRlId);
});

test("NULL-config rate_limit lands on the '' sentinel row that the seed seeded (fn-639)", () => {
  // Identical COALESCE expression in seed + UPSERT — a NULL-config session's
  // rate_limit must land on the exact '' row the seed minted (no orphaned
  // duplicate bucket).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default",
    config_dir: null,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-default" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-default" });
  drainAll();
  const rows = db
    .query("SELECT config_dir, last_rate_limit_session_id FROM profiles")
    .all() as {
    config_dir: string;
    last_rate_limit_session_id: string | null;
  }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]?.config_dir).toBe("");
  expect(rows[0]?.last_rate_limit_session_id).toBe("sess-default");
});

test("rate_limit before SessionStart is null-guarded (no jobs row → skip; cursor still advances) (fn-639)", () => {
  // The rate_limit fan-out reads jobs.config_dir; if the jobs row is
  // absent (rate_limit landing before SessionStart on a brand-new
  // session) the read returns null and the UPSERT is skipped — the
  // cursor still advances per the "never throw inside fold" invariant.
  const id = insertEvent({
    hook_event: "RateLimited",
    session_id: "ghost-session",
  });
  drainAll();
  expect(getCursor()).toBe(id);
  // No profile row was stamped — the jobs row was missing.
  const n = (
    db.query("SELECT COUNT(*) AS n FROM profiles").get() as { n: number }
  ).n;
  expect(n).toBe(0);
});

test("from-scratch re-fold reproduces the profiles projection byte-identically (fn-639)", () => {
  // Mirrors the usage re-fold determinism test (~:2450-2502). Seed a
  // sequence covering: (a) two distinct profiles, (b) a NULL-config
  // session collapsing to '', (c) a rate_limit, (d) a second rate_limit
  // on the same profile from a different session (last-write-wins), and
  // (e) an unrelated ApiError(authentication_failed) that must NOT stamp
  // the profile rate-limit fields.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A",
    config_dir: "/p/A",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-B",
    config_dir: "/p/B",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default",
    config_dir: null,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-A" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-A" });
  // Second session under same profile A — last write wins.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A2",
    config_dir: "/p/A",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-A2" });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-A2",
    data: JSON.stringify({ kind: "rate_limit" }),
  });
  // Unrelated kind under profile B — must not touch last_rate_limit_*.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-B" });
  insertEvent({
    hook_event: "ApiError",
    session_id: "sess-B",
    data: JSON.stringify({ kind: "authentication_failed" }),
  });
  drainAll();
  const before = db
    .query("SELECT * FROM profiles ORDER BY config_dir ASC")
    .all();
  // Rewind + wipe + re-drain. Re-fold determinism: the post-rewind rows
  // must equal byte-for-byte the pre-rewind rows.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM profiles");
  drainAll();
  const after = db
    .query("SELECT * FROM profiles ORDER BY config_dir ASC")
    .all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v40 (fn-652): jobs.name_history append on title-advance
// ---------------------------------------------------------------------------

/** Read the persisted `name_history` for `jobId` as a parsed string array. */
function getNameHistory(jobId = "sess-a"): string[] | null {
  const row = db
    .query("SELECT name_history FROM jobs WHERE job_id = ?")
    .get(jobId) as { name_history: string } | null;
  if (row == null) return null;
  return JSON.parse(row.name_history) as string[];
}

test("SessionStart with spawn_name seeds name_history = [spawn_name]", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "work::foo" });
  drainAll();
  expect(getNameHistory()).toEqual(["work::foo"]);
});

test("SessionStart without spawn_name seeds name_history = []", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  expect(getNameHistory()).toEqual([]);
});

test("title precedence-write appends the new distinct title to name_history", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "work::foo" });
  // A payload-source title advances over the priority-1 spawn source.
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "real-title" }),
  });
  drainAll();
  expect(getNameHistory()).toEqual(["work::foo", "real-title"]);
});

test("repeating the same title is a no-op (tail-dedupe)", () => {
  insertEvent({ hook_event: "SessionStart" });
  // Two payload-source title events with the SAME title — the second is a
  // pure no-op (precedence-write rule skips the UPDATE when persisted ===
  // incoming), so name_history must NOT carry a duplicate tail.
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "foo" }),
  });
  insertEvent({
    hook_event: "Notification",
    data: JSON.stringify({ session_title: "foo" }),
  });
  drainAll();
  expect(getNameHistory()).toEqual(["foo"]);
});

test("revert to earlier title appends again (history records the bounce)", () => {
  insertEvent({ hook_event: "SessionStart" });
  // foo → bar → foo: each transition advances `title` and appends a new
  // entry to name_history. Dedupe is tail-only — repeating an EARLIER value
  // still records the bounce.
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "foo" }),
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "bar" }),
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "foo" }),
  });
  drainAll();
  expect(getNameHistory()).toEqual(["foo", "bar", "foo"]);
});

test("name_history caps at the most-recent 20 entries", () => {
  insertEvent({ hook_event: "SessionStart" });
  // 25 distinct titles → only the last 20 should remain.
  for (let i = 0; i < 25; i++) {
    insertEvent({
      hook_event: "UserPromptSubmit",
      data: JSON.stringify({ session_title: `t-${i}` }),
    });
  }
  drainAll();
  const history = getNameHistory();
  expect(history?.length).toBe(20);
  // Tail is the latest title; head is t-5 (first 5 sliced off).
  expect(history?.[history.length - 1]).toBe("t-24");
  expect(history?.[0]).toBe("t-5");
});

test("RESUME (duplicate SessionStart) does NOT touch name_history", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "work::foo" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "real-title" }),
  });
  drainAll();
  expect(getNameHistory()).toEqual(["work::foo", "real-title"]);
  // Now end the session and resume with a different spawn name — the
  // RESUME path's ON CONFLICT branch MUST leave name_history alone
  // (precedence-owned, mirrors title/title_source).
  insertEvent({
    hook_event: "SessionEnd",
    data: JSON.stringify({ reason: "stop" }),
  });
  insertEvent({
    hook_event: "SessionStart",
    spawn_name: "work::different-spawn-name",
  });
  drainAll();
  // The resume's spawn name was NOT prepended/appended; history stays put.
  expect(getNameHistory()).toEqual(["work::foo", "real-title"]);
});

test("higher-priority title source (transcript over payload) appends a new entry", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "spawn-x" });
  // Tier 2 payload-source seeds title='foo'.
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "foo" }),
  });
  // Tier 3 transcript-source promotes title='bar' over the payload source.
  // Even though 'bar' was never in history, it gets appended via the
  // distinct-advance rule.
  insertEvent({
    hook_event: "TranscriptTitle",
    data: JSON.stringify({ session_title: "bar" }),
  });
  drainAll();
  expect(getNameHistory()).toEqual(["spawn-x", "foo", "bar"]);
});

test("name_history is re-fold deterministic: rewind + re-drain reproduces it byte-for-byte", () => {
  insertEvent({ hook_event: "SessionStart", spawn_name: "spawn-z" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "alpha" }),
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "beta" }),
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "alpha" }),
  });
  drainAll();
  const before = getNameHistory();
  expect(before).toEqual(["spawn-z", "alpha", "beta", "alpha"]);

  // Rewind + wipe + re-drain. The persisted `name_history` after re-fold
  // must equal the pre-rewind value byte-for-byte (pure function of the
  // event log + reducer logic; no Date.now/env reads).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  expect(getNameHistory()).toEqual(before);
});

test("title fold with a malformed persisted name_history blob folds to [] then appends safely", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  // Corrupt the persisted cell to a non-array string (should never happen
  // in steady-state — the column is NOT NULL DEFAULT '[]' and every writer
  // JSON.stringify's a real array — but the defensive parse must fold
  // safely). The next title-advance must produce a healthy ['x'] history.
  db.run("UPDATE jobs SET name_history = ? WHERE job_id = 'sess-a'", [
    "{ not a json array",
  ]);
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ session_title: "x" }),
  });
  drainAll();
  expect(getNameHistory()).toEqual(["x"]);
});

// ---------------------------------------------------------------------------
// Schema v43 (fn-661) — `dispatch_failures` reducer projection. The server-
// side autopilot reconciler mints `DispatchFailed` / `DispatchCleared`
// synthetic events that fold purely (no `Date.now`, no liveness re-probe,
// no `jobs` SELECT) into the `dispatch_failures` table. UPSERT keyed on
// `(verb, id)`; `created_at` preserved through UPSERT; DELETE on clear.
// A from-scratch re-fold (rewind cursor, DELETE FROM dispatch_failures,
// re-drain) MUST reproduce the table byte-identically.
// ---------------------------------------------------------------------------

function dispatchFailedEvent(
  verb: string,
  id: string,
  reason: string,
  dir: string | null,
  ts: number,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "DispatchFailed",
    session_id: sessionId,
    data: JSON.stringify({ verb, id, reason, dir, ts }),
  });
}

function dispatchClearedEvent(
  verb: string,
  id: string,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "DispatchCleared",
    session_id: sessionId,
    data: JSON.stringify({ verb, id }),
  });
}

function getDispatchFailure(verb: string, id: string) {
  return db
    .query("SELECT * FROM dispatch_failures WHERE verb = ? AND id = ?")
    .get(verb, id) as {
    verb: string;
    id: string;
    reason: string;
    dir: string | null;
    ts: number;
    last_event_id: number;
    created_at: number;
    updated_at: number;
  } | null;
}

test("DispatchFailed UPSERTs a new dispatch_failures row and advances the cursor", () => {
  const eventId = dispatchFailedEvent(
    "plan-plan",
    "fn-661-server-side-autopilot-reconciler.2",
    "confirm_timeout",
    "/Users/mike/code/keeper",
    1_700_000_000,
  );
  expect(drainAll()).toBe(1);
  const row = getDispatchFailure(
    "plan-plan",
    "fn-661-server-side-autopilot-reconciler.2",
  );
  expect(row).not.toBeNull();
  expect(row?.verb).toBe("plan-plan");
  expect(row?.id).toBe("fn-661-server-side-autopilot-reconciler.2");
  expect(row?.reason).toBe("confirm_timeout");
  expect(row?.dir).toBe("/Users/mike/code/keeper");
  expect(row?.ts).toBe(1_700_000_000);
  expect(row?.last_event_id).toBe(eventId);
  expect(row?.created_at).toBe(1_700_000_000);
  expect(getCursor()).toBe(eventId);
});

test("DispatchFailed UPSERT preserves created_at but updates reason / dir / ts / last_event_id / updated_at", () => {
  const firstId = dispatchFailedEvent(
    "plan-plan",
    "fn-X.1",
    "confirm_timeout",
    "/repo-a",
    1_700_000_000,
  );
  drainAll();
  const before = getDispatchFailure("plan-plan", "fn-X.1");
  expect(before).not.toBeNull();
  expect(before?.created_at).toBe(1_700_000_000);

  // A second DispatchFailed for the same (verb, id) — different reason,
  // different dir, later ts. The row must UPDATE in place, preserving
  // created_at (the "sticky since" semantic).
  const secondId = dispatchFailedEvent(
    "plan-plan",
    "fn-X.1",
    "launch_failed",
    "/repo-b",
    1_700_000_500,
  );
  drainAll();
  const after = getDispatchFailure("plan-plan", "fn-X.1");
  expect(after).not.toBeNull();
  expect(after?.reason).toBe("launch_failed");
  expect(after?.dir).toBe("/repo-b");
  expect(after?.ts).toBe(1_700_000_500);
  expect(after?.last_event_id).toBe(secondId);
  // Critical: created_at PRESERVED (not overwritten to 1_700_000_500).
  expect(after?.created_at).toBe(1_700_000_000);
  expect(after?.last_event_id).toBeGreaterThan(firstId);
});

test("DispatchFailed with a null/missing dir folds dir to NULL", () => {
  dispatchFailedEvent("plan-plan", "fn-Y.1", "confirm_timeout", null, 1700);
  drainAll();
  const row = getDispatchFailure("plan-plan", "fn-Y.1");
  expect(row).not.toBeNull();
  expect(row?.dir).toBeNull();
});

test("DispatchCleared deletes the (verb, id) row and advances the cursor", () => {
  dispatchFailedEvent("plan-plan", "fn-Z.1", "confirm_timeout", "/r", 1700);
  drainAll();
  expect(getDispatchFailure("plan-plan", "fn-Z.1")).not.toBeNull();

  const clearId = dispatchClearedEvent("plan-plan", "fn-Z.1");
  expect(drainAll()).toBe(1);
  expect(getDispatchFailure("plan-plan", "fn-Z.1")).toBeNull();
  expect(getCursor()).toBe(clearId);
});

test("DispatchCleared on a non-existent (verb, id) is a safe no-op (cursor still advances)", () => {
  const id = dispatchClearedEvent("plan-plan", "fn-never-failed.1");
  expect(drainAll()).toBe(1);
  expect(getDispatchFailure("plan-plan", "fn-never-failed.1")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("Distinct (verb, id) pairs coexist as separate rows", () => {
  dispatchFailedEvent("plan-plan", "fn-A.1", "confirm_timeout", null, 1700);
  dispatchFailedEvent("plan-defer", "fn-A.1", "launch_failed", null, 1701);
  dispatchFailedEvent("plan-plan", "fn-B.1", "confirm_timeout", null, 1702);
  drainAll();
  const rows = db
    .query("SELECT verb, id FROM dispatch_failures ORDER BY ts ASC")
    .all() as { verb: string; id: string }[];
  expect(rows).toEqual([
    { verb: "plan-plan", id: "fn-A.1" },
    { verb: "plan-defer", id: "fn-A.1" },
    { verb: "plan-plan", id: "fn-B.1" },
  ]);
});

test("DispatchFailed with a malformed payload is a safe no-op (cursor still advances, no row written)", () => {
  // Malformed shapes the extractor must reject: bad JSON, missing verb,
  // empty id, non-number ts, missing reason. Each must fold to a no-op.
  const malformed = [
    { hook_event: "DispatchFailed", data: "{ not json" },
    {
      hook_event: "DispatchFailed",
      data: JSON.stringify({ id: "x", reason: "r", ts: 1 }),
    }, // missing verb
    {
      hook_event: "DispatchFailed",
      data: JSON.stringify({ verb: "v", id: "", reason: "r", ts: 1 }),
    }, // empty id
    {
      hook_event: "DispatchFailed",
      data: JSON.stringify({ verb: "v", id: "x", reason: "r", ts: "soon" }),
    }, // non-number ts
    {
      hook_event: "DispatchFailed",
      data: JSON.stringify({ verb: "v", id: "x", ts: 1 }),
    }, // missing reason
  ];
  let lastId = 0;
  for (const ev of malformed) {
    lastId = insertEvent({
      hook_event: ev.hook_event,
      session_id: "reconciler",
      data: ev.data,
    });
  }
  expect(drainAll()).toBe(malformed.length);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM dispatch_failures").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(lastId);
});

test("from-scratch re-fold reproduces the dispatch_failures projection byte-identically (fn-661)", () => {
  // Seed a representative sequence: failure, UPSERT (same key, later
  // reason+ts), distinct-key failure, clear of the first key.
  dispatchFailedEvent("plan-plan", "fn-A.1", "confirm_timeout", "/r", 1700);
  dispatchFailedEvent("plan-plan", "fn-A.1", "launch_failed", "/r2", 1750);
  dispatchFailedEvent("plan-defer", "fn-B.1", "confirm_timeout", null, 1800);
  dispatchClearedEvent("plan-plan", "fn-A.1");
  // A second-clear after a re-fail proves stickiness through the clear:
  dispatchFailedEvent("plan-plan", "fn-A.1", "confirm_timeout", "/r3", 1850);
  drainAll();
  const before = db
    .query("SELECT * FROM dispatch_failures ORDER BY verb ASC, id ASC")
    .all();
  // Rewind cursor + wipe projection + re-drain. The post-rewind rows
  // must equal the pre-rewind rows byte-for-byte — the from-scratch
  // re-fold determinism invariant.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM dispatch_failures");
  drainAll();
  const after = db
    .query("SELECT * FROM dispatch_failures ORDER BY verb ASC, id ASC")
    .all();
  expect(after).toEqual(before);
});

test("zero-event projection: a fresh DB has zero dispatch_failures rows", () => {
  const count = (
    db.query("SELECT COUNT(*) AS n FROM dispatch_failures").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

// ---------------------------------------------------------------------------
// Schema v50 (fn-678) — `pending_dispatches` reducer projection. The autopilot
// reconciler mints `Dispatched{verb, id, dir, ts}` BEFORE invoking
// `ExecBackend.launch()` (outbox ordering); the reducer UPSERTs into
// `pending_dispatches` keyed on `(verb, id)`. Discharge fans out through
// three event-sourced paths — discharge-on-bind (SessionStart spawn-INSERT
// for a matching `(plan_verb, plan_ref)`), `DispatchFailed` (loops out the
// pending row in the same fold), and `DispatchExpired` (producer-side TTL
// sweep). All folds are pure (no `Date.now`, no env, no liveness re-probe)
// and a from-scratch re-fold reproduces the table byte-identically.
// ---------------------------------------------------------------------------

function dispatchedEvent(
  verb: string,
  id: string,
  dir: string | null,
  ts: number,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "Dispatched",
    session_id: sessionId,
    data: JSON.stringify({ verb, id, dir, ts }),
  });
}

function dispatchExpiredEvent(
  verb: string,
  id: string,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "DispatchExpired",
    session_id: sessionId,
    data: JSON.stringify({ verb, id }),
  });
}

function getPendingDispatch(verb: string, id: string) {
  return db
    .query("SELECT * FROM pending_dispatches WHERE verb = ? AND id = ?")
    .get(verb, id) as {
    verb: string;
    id: string;
    dir: string | null;
    dispatched_at: number;
    last_event_id: number;
  } | null;
}

test("Dispatched UPSERTs a new pending_dispatches row and advances the cursor (fn-678)", () => {
  const eventId = dispatchedEvent(
    "plan-plan",
    "fn-678-decouple-dispatch-from-tab-naming.3",
    "/Users/mike/code/keeper",
    1_700_000_000,
  );
  expect(drainAll()).toBe(1);
  const row = getPendingDispatch(
    "plan-plan",
    "fn-678-decouple-dispatch-from-tab-naming.3",
  );
  expect(row).not.toBeNull();
  expect(row?.verb).toBe("plan-plan");
  expect(row?.id).toBe("fn-678-decouple-dispatch-from-tab-naming.3");
  expect(row?.dir).toBe("/Users/mike/code/keeper");
  expect(row?.dispatched_at).toBe(1_700_000_000);
  expect(row?.last_event_id).toBe(eventId);
  expect(getCursor()).toBe(eventId);
});

test("Dispatched UPSERT updates dir / dispatched_at / last_event_id on collision (fn-678)", () => {
  const firstId = dispatchedEvent("plan-plan", "fn-X.1", "/repo-a", 1700);
  drainAll();
  const before = getPendingDispatch("plan-plan", "fn-X.1");
  expect(before).not.toBeNull();
  expect(before?.dir).toBe("/repo-a");
  expect(before?.dispatched_at).toBe(1700);

  // A second Dispatched for the same `(verb, id)` (a re-dispatch after a
  // prior failure/expire — possible across keeperd restarts). The UPSERT
  // refreshes every column to the latest mint's values: row presence IS
  // the signal, so there's no "first observation" semantic to preserve.
  const secondId = dispatchedEvent("plan-plan", "fn-X.1", "/repo-b", 1900);
  drainAll();
  const after = getPendingDispatch("plan-plan", "fn-X.1");
  expect(after).not.toBeNull();
  expect(after?.dir).toBe("/repo-b");
  expect(after?.dispatched_at).toBe(1900);
  expect(after?.last_event_id).toBe(secondId);
  expect(after?.last_event_id).toBeGreaterThan(firstId);
});

test("Dispatched with a null/missing dir folds dir to NULL (fn-678)", () => {
  dispatchedEvent("plan-plan", "fn-Y.1", null, 1700);
  drainAll();
  const row = getPendingDispatch("plan-plan", "fn-Y.1");
  expect(row).not.toBeNull();
  expect(row?.dir).toBeNull();
});

test("Dispatched with a malformed payload is a safe no-op (cursor still advances, no row written) (fn-678)", () => {
  // Malformed shapes the extractor must reject: bad JSON, missing verb,
  // empty id, non-number ts. Each must fold to a no-op.
  const malformed = [
    { hook_event: "Dispatched", data: "{ not json" },
    {
      hook_event: "Dispatched",
      data: JSON.stringify({ id: "x", ts: 1 }),
    }, // missing verb
    {
      hook_event: "Dispatched",
      data: JSON.stringify({ verb: "v", id: "", ts: 1 }),
    }, // empty id
    {
      hook_event: "Dispatched",
      data: JSON.stringify({ verb: "v", id: "x", ts: "soon" }),
    }, // non-number ts
    { hook_event: "Dispatched", data: JSON.stringify({ verb: "v", id: "x" }) }, // missing ts
  ];
  let lastId = 0;
  for (const ev of malformed) {
    lastId = insertEvent({
      hook_event: ev.hook_event,
      session_id: "reconciler",
      data: ev.data,
    });
  }
  expect(drainAll()).toBe(malformed.length);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM pending_dispatches").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(lastId);
});

test("DispatchExpired deletes the (verb, id) row and advances the cursor (fn-678)", () => {
  dispatchedEvent("plan-plan", "fn-Z.1", "/r", 1700);
  drainAll();
  expect(getPendingDispatch("plan-plan", "fn-Z.1")).not.toBeNull();

  const expireId = dispatchExpiredEvent("plan-plan", "fn-Z.1");
  expect(drainAll()).toBe(1);
  expect(getPendingDispatch("plan-plan", "fn-Z.1")).toBeNull();
  expect(getCursor()).toBe(expireId);
});

test("DispatchExpired on a non-existent (verb, id) is a safe no-op (cursor still advances, no throw) (fn-678)", () => {
  // The boot-drain race the spec calls out: a SessionStart already
  // discharged the row when the TTL sweep's `DispatchExpired` lands.
  // The fold MUST NOT throw on a missing row — a throw rolls back the
  // cursor and wedges the reducer.
  const id = dispatchExpiredEvent("plan-plan", "fn-never-pending.1");
  expect(drainAll()).toBe(1);
  expect(getPendingDispatch("plan-plan", "fn-never-pending.1")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("DispatchExpired with a malformed payload is a safe no-op (cursor still advances) (fn-678)", () => {
  const malformed = [
    { hook_event: "DispatchExpired", data: "{ not json" },
    { hook_event: "DispatchExpired", data: JSON.stringify({}) }, // missing both
    {
      hook_event: "DispatchExpired",
      data: JSON.stringify({ verb: "v" }),
    }, // missing id
    {
      hook_event: "DispatchExpired",
      data: JSON.stringify({ verb: "", id: "x" }),
    }, // empty verb
  ];
  let lastId = 0;
  for (const ev of malformed) {
    lastId = insertEvent({
      hook_event: ev.hook_event,
      session_id: "reconciler",
      data: ev.data,
    });
  }
  expect(drainAll()).toBe(malformed.length);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM pending_dispatches").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(lastId);
});

test("DispatchFailed deletes the matching pending_dispatches row in the same fold tx (fn-678)", () => {
  // The outbox ordering: `Dispatched` mints BEFORE `launch()`, so a launch
  // failure leaves the pending row + the dispatch_failures row both alive.
  // The widened `foldDispatchFailed` reconciles them in one fold.
  dispatchedEvent("plan-plan", "fn-fail.1", "/repo", 1700);
  drainAll();
  expect(getPendingDispatch("plan-plan", "fn-fail.1")).not.toBeNull();

  // Mint the DispatchFailed for the same `(verb, id)`. Reuse the
  // dispatchFailedEvent helper defined earlier in this file.
  dispatchFailedEvent("plan-plan", "fn-fail.1", "launch_failed", "/repo", 1750);
  drainAll();

  // Both projections must reflect: the failure row exists (sticky), the
  // pending row is gone.
  expect(getDispatchFailure("plan-plan", "fn-fail.1")).not.toBeNull();
  expect(getPendingDispatch("plan-plan", "fn-fail.1")).toBeNull();
});

test("DispatchFailed without a prior Dispatched is still a safe no-op on pending_dispatches (fn-678)", () => {
  // Idempotent: the widened DELETE matches zero rows — no error, the
  // dispatch_failures arm still UPSERTs normally.
  dispatchFailedEvent(
    "plan-plan",
    "fn-orphan.1",
    "confirm_timeout",
    "/r",
    1700,
  );
  drainAll();
  expect(getDispatchFailure("plan-plan", "fn-orphan.1")).not.toBeNull();
  expect(getPendingDispatch("plan-plan", "fn-orphan.1")).toBeNull();
});

test("discharge-on-bind: SessionStart spawn-INSERT clears the matching pending_dispatches row (fn-678)", () => {
  // Outbox flow: autopilot mints `Dispatched` then `launch()`s a worker
  // whose spawn name is `work::fn-678-foo.1`. The worker's first
  // `SessionStart` carries that spawn name and seeds the row's
  // `plan_verb='work' / plan_ref='fn-678-foo.1'`. The set-once stamp on
  // the spawn-INSERT branch discharges the pending dispatch in the SAME
  // fold transaction.
  dispatchedEvent("work", "fn-678-foo.1", "/repo", 1700);
  drainAll();
  expect(getPendingDispatch("work", "fn-678-foo.1")).not.toBeNull();

  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-bind",
    spawn_name: "work::fn-678-foo.1",
  });
  drainAll();
  // The session's row carries the plan correlator AND the pending row
  // was discharged inline.
  const job = getJob("sess-bind");
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-678-foo.1");
  expect(getPendingDispatch("work", "fn-678-foo.1")).toBeNull();
});

test("discharge-on-bind: a SessionStart on a spawn name NOT matching the plan-verb whitelist leaves pending_dispatches untouched (fn-678)", () => {
  // `planVerbRefFromSpawnName` returns `{ plan_verb: null, plan_ref: null }`
  // for any spawn name outside the strict `{plan|work|close|approve}::<ref>`
  // whitelist. The discharge guard requires BOTH non-null, so a non-matching
  // session leaves any pending row alive (it would only ever match a row
  // with verb/id null — which the table forbids).
  dispatchedEvent("work", "fn-678-keep.1", "/repo", 1700);
  drainAll();
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-arbitrary",
    spawn_name: "human-launched-session",
  });
  drainAll();
  expect(getPendingDispatch("work", "fn-678-keep.1")).not.toBeNull();
});

test("discharge-on-bind: SessionStart with NO matching pending row is a safe no-op (fn-678)", () => {
  // A worker can be human-launched with a `work::fn-X.1` spawn name even
  // when the autopilot never minted a `Dispatched` for it — the DELETE
  // must be idempotent.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-human",
    spawn_name: "work::fn-678-no-autopilot.1",
  });
  drainAll();
  const job = getJob("sess-human");
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-678-no-autopilot.1");
  // No pending row was ever minted; the discharge is a no-op DELETE.
  expect(getPendingDispatch("work", "fn-678-no-autopilot.1")).toBeNull();
});

test("discharge-on-bind FIRES ONLY on the spawn-INSERT branch, NOT on resume (fn-678)", () => {
  // First SessionStart with a matching spawn name → spawn-INSERT branch,
  // discharge fires.
  dispatchedEvent("work", "fn-678-resume.1", "/repo", 1700);
  drainAll();
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-resume",
    spawn_name: "work::fn-678-resume.1",
  });
  drainAll();
  expect(getPendingDispatch("work", "fn-678-resume.1")).toBeNull();

  // Now: the autopilot mints a FRESH `Dispatched` for the SAME
  // `(verb, id)` (the prior session ended; the reconciler re-dispatched
  // a new worker). A subsequent duplicate SessionStart on the SAME
  // `sess-resume` (a resume of the original session — NOT the freshly
  // dispatched worker) MUST NOT discharge the legitimately re-pending
  // row. This is the "resume must not clear a re-pending dispatch"
  // invariant the spec calls out.
  dispatchedEvent("work", "fn-678-resume.1", "/repo", 1800);
  drainAll();
  expect(getPendingDispatch("work", "fn-678-resume.1")).not.toBeNull();

  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-resume",
    spawn_name: "work::fn-678-resume.1",
  });
  drainAll();
  // The pending row survives — the resume hit the ON CONFLICT branch,
  // not the spawn-INSERT branch.
  const row = getPendingDispatch("work", "fn-678-resume.1");
  expect(row).not.toBeNull();
  expect(row?.dispatched_at).toBe(1800);
});

test("zero-event projection: a fresh DB has zero pending_dispatches rows (fn-678)", () => {
  const count = (
    db.query("SELECT COUNT(*) AS n FROM pending_dispatches").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("from-scratch re-fold over a historical pre-fn-678 log reproduces an empty pending_dispatches (fn-678)", () => {
  // Simulate a pre-v50 event log: SessionStart events but NO `Dispatched`
  // events. A from-scratch re-fold MUST reproduce an empty
  // `pending_dispatches` table — matching the zero-event projection
  // default (no events historically minted `Dispatched`).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-historical-1",
    spawn_name: "work::fn-678-old.1",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-historical-2",
    spawn_name: "plan::fn-678-old-epic",
  });
  drainAll();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM pending_dispatches");
  db.run("DELETE FROM jobs");
  drainAll();

  const count = (
    db.query("SELECT COUNT(*) AS n FROM pending_dispatches").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("from-scratch re-fold reproduces the pending_dispatches projection byte-identically (fn-678)", () => {
  // Seed a representative sequence exercising every fold arm:
  // - Dispatched (UPSERT)
  // - Dispatched UPSERT collision (same (verb, id), new dir/ts)
  // - Discharge-on-bind via SessionStart spawn-INSERT
  // - Distinct-key Dispatched (survives a sibling's discharge)
  // - DispatchFailed widened DELETE (loop-out a pending row)
  // - DispatchExpired idempotent DELETE
  dispatchedEvent("work", "fn-678-a.1", "/r1", 1700);
  dispatchedEvent("work", "fn-678-a.1", "/r2", 1750); // UPSERT collision
  dispatchedEvent("plan", "fn-678-b-epic", "/r3", 1800);
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A",
    spawn_name: "work::fn-678-a.1",
  });
  // After this point: fn-678-a.1 discharged (gone), fn-678-b-epic still pending.
  dispatchedEvent("work", "fn-678-c.1", "/r4", 1900);
  dispatchFailedEvent("work", "fn-678-c.1", "launch_failed", "/r4", 1950);
  // After this point: fn-678-c.1 also gone (failed → widened DELETE).
  dispatchedEvent("close", "fn-678-d-epic", "/r5", 2000);
  dispatchExpiredEvent("close", "fn-678-d-epic");
  // After this point: fn-678-d-epic also gone (TTL expired).
  dispatchedEvent("approve", "fn-678-e.1", "/r6", 2100);
  // After this point: ONLY fn-678-b-epic + fn-678-e.1 are still pending.
  drainAll();

  const before = db
    .query("SELECT * FROM pending_dispatches ORDER BY verb ASC, id ASC")
    .all();
  expect(before.length).toBe(2);

  // Rewind cursor + wipe projection + re-drain. The post-rewind rows
  // must equal the pre-rewind rows byte-for-byte — the from-scratch
  // re-fold determinism invariant.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM pending_dispatches");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM dispatch_failures");
  drainAll();

  const after = db
    .query("SELECT * FROM pending_dispatches ORDER BY verb ASC, id ASC")
    .all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v47 (fn-667) — `autopilot_state` singleton reducer projection. Main
// mints `AutopilotPaused{paused:boolean}` events (steady-state via the
// `set_autopilot_paused` RPC bridge, boot via the daemon's boot-append
// re-arm). The reducer folds them purely (no `Date.now`, no env, no
// `jobs` SELECT) into the singleton `autopilot_state` row keyed on
// `id = 1`. UPSERT on `id`; `created_at` preserved through UPSERT (the
// row's "first observation" stamp); no DELETE arm (a singleton control
// flag never "clears" — it just flips). A from-scratch re-fold (rewind
// cursor, DELETE FROM autopilot_state, re-drain) MUST reproduce the
// table byte-identically.
// ---------------------------------------------------------------------------

function autopilotPausedEvent(
  paused: boolean,
  sessionId = "autopilot",
): number {
  return insertEvent({
    hook_event: "AutopilotPaused",
    session_id: sessionId,
    data: JSON.stringify({ paused }),
  });
}

function getAutopilotState() {
  return db.query("SELECT * FROM autopilot_state WHERE id = 1").get() as {
    id: number;
    paused: number;
    last_event_id: number;
    created_at: number;
    updated_at: number;
  } | null;
}

test("AutopilotPaused UPSERTs the singleton row and advances the cursor (fn-667)", () => {
  const eventId = autopilotPausedEvent(true);
  expect(drainAll()).toBe(1);
  const row = getAutopilotState();
  expect(row).not.toBeNull();
  expect(row?.id).toBe(1);
  expect(row?.paused).toBe(1);
  expect(row?.last_event_id).toBe(eventId);
  expect(getCursor()).toBe(eventId);
});

test("AutopilotPaused UPSERT preserves created_at across flips but updates paused / last_event_id / updated_at (fn-667)", () => {
  // First event lands the row.
  const firstId = autopilotPausedEvent(true);
  drainAll();
  const before = getAutopilotState();
  expect(before).not.toBeNull();
  const createdAt = before?.created_at;
  expect(createdAt).not.toBeUndefined();

  // Flip to playing — UPSERT must change `paused` + bump `last_event_id`
  // + bump `updated_at`, but PRESERVE `created_at` (the row's "first
  // observation" stamp, mirroring foldDispatchFailed).
  const secondId = autopilotPausedEvent(false);
  drainAll();
  const after = getAutopilotState();
  expect(after).not.toBeNull();
  expect(after?.paused).toBe(0);
  expect(after?.last_event_id).toBe(secondId);
  expect(after?.last_event_id).toBeGreaterThan(firstId);
  // Critical: created_at PRESERVED across the flip.
  expect(after?.created_at).toBe(createdAt as number);
});

test("AutopilotPaused with a malformed payload is a safe no-op (cursor still advances, no row written) (fn-667)", () => {
  // Malformed shapes the extractor must reject: bad JSON, missing
  // `paused`, non-boolean `paused`, empty/missing data. Each must fold
  // to a no-op (no row, cursor still advances).
  const malformed = [
    { hook_event: "AutopilotPaused", data: "{ not json" },
    { hook_event: "AutopilotPaused", data: JSON.stringify({}) }, // missing paused
    {
      hook_event: "AutopilotPaused",
      data: JSON.stringify({ paused: 1 }),
    }, // non-boolean (number)
    {
      hook_event: "AutopilotPaused",
      data: JSON.stringify({ paused: "true" }),
    }, // non-boolean (string)
    {
      hook_event: "AutopilotPaused",
      data: JSON.stringify({ paused: null }),
    }, // non-boolean (null)
  ];
  let lastId = 0;
  for (const ev of malformed) {
    lastId = insertEvent({
      hook_event: ev.hook_event,
      session_id: "autopilot",
      data: ev.data,
    });
  }
  expect(drainAll()).toBe(malformed.length);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM autopilot_state").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(lastId);
});

test("from-scratch re-fold reproduces the autopilot_state projection byte-identically (fn-667)", () => {
  // Seed a representative sequence: pause (boot-style), play (RPC flip),
  // pause again, play again. The row must end at the final state's
  // `paused` and the latest `last_event_id` / `updated_at`, with
  // `created_at` stuck at the FIRST event's ts (the "first observation"
  // semantic).
  autopilotPausedEvent(true);
  autopilotPausedEvent(false);
  autopilotPausedEvent(true);
  autopilotPausedEvent(false);
  drainAll();
  const before = db
    .query("SELECT * FROM autopilot_state ORDER BY id ASC")
    .all();
  // Rewind cursor + wipe projection + re-drain. The post-rewind rows
  // must equal the pre-rewind rows byte-for-byte — the from-scratch
  // re-fold determinism invariant.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM autopilot_state");
  drainAll();
  const after = db.query("SELECT * FROM autopilot_state ORDER BY id ASC").all();
  expect(after).toEqual(before);
});

test("zero-event projection: a fresh DB has zero autopilot_state rows (fn-667)", () => {
  const count = (
    db.query("SELECT COUNT(*) AS n FROM autopilot_state").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

// ---------------------------------------------------------------------------
// Schema v60 (fn-725) — `AutopilotCapSet{max_concurrent_jobs}` folds the
// global autopilot concurrency cap into the SAME singleton `autopilot_state`
// row as `paused`. The two fold arms share `id = 1`, so each MUST preserve
// the other's column on conflict (a cap re-arm never clobbers the live
// pause flag; a pause toggle never resets the cap). Null-tolerant extractor:
// missing / null / non-positive / malformed → NULL (= unlimited).
// ---------------------------------------------------------------------------

function autopilotCapSetEvent(
  maxConcurrentJobs: number | null,
  sessionId = "autopilot",
): number {
  return insertEvent({
    hook_event: "AutopilotCapSet",
    session_id: sessionId,
    data: JSON.stringify({ max_concurrent_jobs: maxConcurrentJobs }),
  });
}

function getAutopilotStateFull() {
  return db.query("SELECT * FROM autopilot_state WHERE id = 1").get() as {
    id: number;
    paused: number;
    last_event_id: number;
    created_at: number;
    updated_at: number;
    max_concurrent_jobs: number | null;
  } | null;
}

test("AutopilotCapSet UPSERTs the singleton row with the cap and advances the cursor (fn-725)", () => {
  const eventId = autopilotCapSetEvent(3);
  expect(drainAll()).toBe(1);
  const row = getAutopilotStateFull();
  expect(row).not.toBeNull();
  expect(row?.id).toBe(1);
  expect(row?.max_concurrent_jobs).toBe(3);
  expect(row?.last_event_id).toBe(eventId);
  expect(getCursor()).toBe(eventId);
});

test("AutopilotCapSet null payload folds the cap to SQL NULL (= unlimited) (fn-725)", () => {
  autopilotCapSetEvent(null);
  drainAll();
  const row = getAutopilotStateFull();
  expect(row).not.toBeNull();
  expect(row?.max_concurrent_jobs).toBeNull();
});

test("AutopilotCapSet then AutopilotPaused: a pause toggle PRESERVES the cap (fn-725)", () => {
  // Boot order in daemon.ts is paused-then-cap, but the cross-preservation
  // invariant must hold regardless of order. Here: cap first, then a pause
  // flip — the cap MUST survive the pause UPSERT.
  autopilotCapSetEvent(3);
  drainAll();
  expect(getAutopilotStateFull()?.max_concurrent_jobs).toBe(3);
  autopilotPausedEvent(false);
  drainAll();
  const row = getAutopilotStateFull();
  expect(row?.paused).toBe(0); // pause flip landed
  expect(row?.max_concurrent_jobs).toBe(3); // cap PRESERVED across the toggle
});

test("AutopilotPaused then AutopilotCapSet: a cap re-arm PRESERVES paused (fn-725)", () => {
  // The daemon boot order: paused re-arm THEN cap re-arm. The cap UPSERT
  // must PRESERVE the just-folded `paused` flag (it omits `paused` from its
  // SET clause).
  autopilotPausedEvent(true);
  drainAll();
  expect(getAutopilotStateFull()?.paused).toBe(1);
  autopilotCapSetEvent(5);
  drainAll();
  const row = getAutopilotStateFull();
  expect(row?.max_concurrent_jobs).toBe(5); // cap landed
  expect(row?.paused).toBe(1); // paused PRESERVED across the cap UPSERT
});

test("AutopilotCapSet INSERT path (cap before any pause) defaults paused=1 (fn-725)", () => {
  // Defensive: a log whose FIRST autopilot_state event is a cap (no prior
  // pause) hits the INSERT branch, which binds paused=1 (autopilot's
  // boots-paused contract) so the NOT NULL column is satisfiable.
  autopilotCapSetEvent(2);
  drainAll();
  const row = getAutopilotStateFull();
  expect(row?.max_concurrent_jobs).toBe(2);
  expect(row?.paused).toBe(1);
});

test("AutopilotCapSet malformed/non-positive payloads fold to NULL (= unlimited), cursor advances (fn-725)", () => {
  // Null-tolerant extractor: unlike AutopilotPaused (which DROPS a malformed
  // event), the cap arm always lands a row with max_concurrent_jobs=NULL for
  // a bad/absent/non-positive value. Seed a pause first so the row exists,
  // then fold each malformed cap and assert the cap reads NULL.
  autopilotPausedEvent(true);
  drainAll();
  const malformed = [
    { data: "{ not json" },
    { data: JSON.stringify({}) }, // missing key
    { data: JSON.stringify({ max_concurrent_jobs: null }) },
    { data: JSON.stringify({ max_concurrent_jobs: 0 }) }, // non-positive
    { data: JSON.stringify({ max_concurrent_jobs: -3 }) }, // negative
    { data: JSON.stringify({ max_concurrent_jobs: 2.5 }) }, // non-integer
    { data: JSON.stringify({ max_concurrent_jobs: "3" }) }, // non-number
  ];
  let lastId = 0;
  for (const ev of malformed) {
    lastId = insertEvent({
      hook_event: "AutopilotCapSet",
      session_id: "autopilot",
      data: ev.data,
    });
  }
  expect(drainAll()).toBe(malformed.length);
  const row = getAutopilotStateFull();
  expect(row?.max_concurrent_jobs).toBeNull();
  expect(row?.paused).toBe(1); // paused preserved through every cap fold
  expect(getCursor()).toBe(lastId);
});

test("from-scratch re-fold reproduces autopilot_state byte-identically with mixed paused/cap events (fn-725)", () => {
  // Seed a representative boot+steady-state sequence interleaving both event
  // kinds. A cursor=0 rewind + DELETE + re-drain MUST reproduce the row
  // byte-for-byte (re-fold determinism — the cap is frozen in the payload).
  autopilotPausedEvent(true); // boot pause re-arm
  autopilotCapSetEvent(3); // boot cap re-arm
  autopilotPausedEvent(false); // RPC play flip
  autopilotCapSetEvent(5); // (e.g. restart re-mint)
  autopilotPausedEvent(true); // RPC pause flip
  drainAll();
  const before = db
    .query("SELECT * FROM autopilot_state ORDER BY id ASC")
    .all();
  // Final state sanity: latest paused=1, latest cap=5.
  expect(getAutopilotStateFull()?.paused).toBe(1);
  expect(getAutopilotStateFull()?.max_concurrent_jobs).toBe(5);
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM autopilot_state");
  drainAll();
  const after = db.query("SELECT * FROM autopilot_state ORDER BY id ASC").all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v62 (fn-751) — `AutopilotMode{mode}` folds the explicit autopilot
// mode enum into the SAME singleton `autopilot_state` row as `paused` /
// `max_concurrent_jobs`, and `EpicArmed{epic_id,armed}` folds the per-epic
// armed flag into the `armed_epics` PRESENCE table. The three autopilot_state
// fold arms (paused / cap / mode) share `id = 1`, so each MUST preserve the
// others' columns on conflict. `armed_epics` is a presence table: armed:true
// INSERT-OR-REPLACEs the row, armed:false DELETEs it. Both folds are re-fold
// deterministic and malformed payloads no-op without throwing.
// ---------------------------------------------------------------------------

function autopilotModeEvent(
  mode: "yolo" | "armed",
  sessionId = "autopilot",
): number {
  return insertEvent({
    hook_event: "AutopilotMode",
    session_id: sessionId,
    data: JSON.stringify({ mode }),
  });
}

function getAutopilotStateWithMode() {
  return db.query("SELECT * FROM autopilot_state WHERE id = 1").get() as {
    id: number;
    paused: number;
    last_event_id: number;
    created_at: number;
    updated_at: number;
    max_concurrent_jobs: number | null;
    mode: string;
  } | null;
}

function epicArmedEvent(
  epicId: string,
  armed: boolean,
  sessionId = "autopilot",
): number {
  return insertEvent({
    hook_event: "EpicArmed",
    session_id: sessionId,
    data: JSON.stringify({ epic_id: epicId, armed }),
  });
}

function getArmedEpics() {
  return db.query("SELECT * FROM armed_epics ORDER BY epic_id ASC").all() as {
    epic_id: string;
    last_event_id: number;
    created_at: number;
    updated_at: number;
  }[];
}

test("zero-event projection: a fresh DB has zero armed_epics rows and (when present) mode defaults yolo (fn-751)", () => {
  const armedCount = (
    db.query("SELECT COUNT(*) AS n FROM armed_epics").get() as { n: number }
  ).n;
  expect(armedCount).toBe(0);
  // The autopilot_state singleton is empty on a zero-event DB; a row only
  // lands once a paused/cap/mode event folds. The `mode` column's DEFAULT
  // 'yolo' guarantees the work-everything baseline whenever a row IS created
  // by a sibling fold (see the paused-INSERT-defaults-mode test below).
  const stateCount = (
    db.query("SELECT COUNT(*) AS n FROM autopilot_state").get() as { n: number }
  ).n;
  expect(stateCount).toBe(0);
});

test("AutopilotMode UPSERTs the singleton mode and advances the cursor (fn-751)", () => {
  const eventId = autopilotModeEvent("armed");
  expect(drainAll()).toBe(1);
  const row = getAutopilotStateWithMode();
  expect(row).not.toBeNull();
  expect(row?.id).toBe(1);
  expect(row?.mode).toBe("armed");
  expect(row?.last_event_id).toBe(eventId);
  expect(getCursor()).toBe(eventId);
});

test("AutopilotMode INSERT path (mode before any pause) defaults paused=1 and cap NULL (fn-751)", () => {
  // A log whose FIRST autopilot_state event is a mode set hits the INSERT
  // branch, which binds paused=1 (boots-paused) and leaves the cap NULL.
  autopilotModeEvent("armed");
  drainAll();
  const row = getAutopilotStateWithMode();
  expect(row?.mode).toBe("armed");
  expect(row?.paused).toBe(1);
  expect(row?.max_concurrent_jobs).toBeNull();
});

test("AutopilotPaused INSERT path defaults mode to 'yolo' (DEFAULT covers the boot re-arm) (fn-751)", () => {
  // The daemon's boot re-arm appends AutopilotPaused FIRST — that INSERT binds
  // no `mode`, so the NOT NULL column relies on its DEFAULT 'yolo'. Verify the
  // boot-order first-writer satisfies the constraint and reads yolo.
  autopilotPausedEvent(true);
  drainAll();
  const row = getAutopilotStateWithMode();
  expect(row?.paused).toBe(1);
  expect(row?.mode).toBe("yolo");
});

test("AutopilotMode preserves paused + max_concurrent_jobs on conflict (fn-751)", () => {
  // Seed paused + cap, then flip the mode — the mode UPSERT MUST preserve both
  // sibling columns (the three arms share id = 1).
  autopilotPausedEvent(false);
  autopilotCapSetEvent(4);
  drainAll();
  expect(getAutopilotStateWithMode()?.paused).toBe(0);
  expect(getAutopilotStateWithMode()?.max_concurrent_jobs).toBe(4);
  autopilotModeEvent("armed");
  drainAll();
  const row = getAutopilotStateWithMode();
  expect(row?.mode).toBe("armed"); // mode flip landed
  expect(row?.paused).toBe(0); // paused PRESERVED
  expect(row?.max_concurrent_jobs).toBe(4); // cap PRESERVED
});

test("sibling folds (paused / cap) preserve mode on conflict (fn-751)", () => {
  // Set mode armed, then a pause toggle + a cap re-arm — neither sibling UPSERT
  // may clobber the live mode.
  autopilotModeEvent("armed");
  drainAll();
  expect(getAutopilotStateWithMode()?.mode).toBe("armed");
  autopilotPausedEvent(true);
  drainAll();
  expect(getAutopilotStateWithMode()?.mode).toBe("armed"); // preserved by paused fold
  autopilotCapSetEvent(2);
  drainAll();
  expect(getAutopilotStateWithMode()?.mode).toBe("armed"); // preserved by cap fold
});

test("AutopilotMode UPSERT preserves created_at across a mode flip (fn-751)", () => {
  const firstId = autopilotModeEvent("yolo");
  drainAll();
  const createdAt = getAutopilotStateWithMode()?.created_at;
  expect(createdAt).not.toBeUndefined();
  const secondId = autopilotModeEvent("armed");
  drainAll();
  const after = getAutopilotStateWithMode();
  expect(after?.mode).toBe("armed");
  expect(after?.last_event_id).toBe(secondId);
  expect(after?.last_event_id).toBeGreaterThan(firstId);
  expect(after?.created_at).toBe(createdAt as number); // created_at PRESERVED
});

test("AutopilotMode with a malformed/unknown-enum payload is a safe no-op (fn-751)", () => {
  // Seed a known mode first so we can assert it is UNCHANGED by the bad folds.
  autopilotModeEvent("armed");
  drainAll();
  expect(getAutopilotStateWithMode()?.mode).toBe("armed");
  const malformed = [
    { data: "{ not json" },
    { data: JSON.stringify({}) }, // missing mode
    { data: JSON.stringify({ mode: "turbo" }) }, // unknown enum
    { data: JSON.stringify({ mode: 1 }) }, // non-string
    { data: JSON.stringify({ mode: null }) }, // null
  ];
  let lastId = 0;
  for (const ev of malformed) {
    lastId = insertEvent({
      hook_event: "AutopilotMode",
      session_id: "autopilot",
      data: ev.data,
    });
  }
  expect(drainAll()).toBe(malformed.length);
  expect(getAutopilotStateWithMode()?.mode).toBe("armed"); // UNCHANGED
  expect(getCursor()).toBe(lastId); // cursor still advances
});

test("EpicArmed armed:true INSERTs a presence row; armed:false DELETEs it (fn-751)", () => {
  const armId = epicArmedEvent("fn-10-foo", true);
  expect(drainAll()).toBe(1);
  let rows = getArmedEpics();
  expect(rows.length).toBe(1);
  expect(rows[0]?.epic_id).toBe("fn-10-foo");
  expect(rows[0]?.last_event_id).toBe(armId);
  expect(getCursor()).toBe(armId);

  // Disarm DELETEs the row.
  const disarmId = epicArmedEvent("fn-10-foo", false);
  drainAll();
  rows = getArmedEpics();
  expect(rows.length).toBe(0);
  expect(getCursor()).toBe(disarmId);
});

test("EpicArmed tracks multiple epics independently as a presence set (fn-751)", () => {
  epicArmedEvent("fn-10-foo", true);
  epicArmedEvent("fn-11-bar", true);
  epicArmedEvent("fn-12-baz", true);
  drainAll();
  expect(getArmedEpics().map((r) => r.epic_id)).toEqual([
    "fn-10-foo",
    "fn-11-bar",
    "fn-12-baz",
  ]);
  // Disarm only the middle one — the other two stay armed.
  epicArmedEvent("fn-11-bar", false);
  drainAll();
  expect(getArmedEpics().map((r) => r.epic_id)).toEqual([
    "fn-10-foo",
    "fn-12-baz",
  ]);
});

test("EpicArmed armed:false on an unarmed epic is a harmless no-op (fn-751)", () => {
  const id = epicArmedEvent("fn-99-never-armed", false);
  expect(drainAll()).toBe(1);
  expect(getArmedEpics().length).toBe(0);
  expect(getCursor()).toBe(id); // cursor advances on the no-op DELETE
});

test("EpicArmed with a malformed payload is a safe no-op (cursor still advances) (fn-751)", () => {
  const malformed = [
    { data: "{ not json" },
    { data: JSON.stringify({}) }, // missing both fields
    { data: JSON.stringify({ epic_id: "fn-1-x" }) }, // missing armed
    { data: JSON.stringify({ armed: true }) }, // missing epic_id
    { data: JSON.stringify({ epic_id: "", armed: true }) }, // empty epic_id
    { data: JSON.stringify({ epic_id: "fn-1-x", armed: "true" }) }, // non-boolean
  ];
  let lastId = 0;
  for (const ev of malformed) {
    lastId = insertEvent({
      hook_event: "EpicArmed",
      session_id: "autopilot",
      data: ev.data,
    });
  }
  expect(drainAll()).toBe(malformed.length);
  expect(getArmedEpics().length).toBe(0);
  expect(getCursor()).toBe(lastId);
});

test("from-scratch re-fold reproduces autopilot_state + armed_epics byte-identically (fn-751)", () => {
  // Mixed sequence across all four event kinds: boot pause+cap+mode re-arm,
  // steady-state mode flip, and a series of arm/disarm events that exercise
  // the presence-table INSERT/REPLACE/DELETE paths.
  autopilotPausedEvent(true);
  autopilotCapSetEvent(3);
  autopilotModeEvent("armed");
  autopilotModeEvent("yolo");
  autopilotModeEvent("armed");
  epicArmedEvent("fn-10-foo", true);
  epicArmedEvent("fn-11-bar", true);
  epicArmedEvent("fn-10-foo", false); // disarm
  epicArmedEvent("fn-12-baz", true);
  epicArmedEvent("fn-11-bar", true); // re-arm of an already-armed epic
  drainAll();
  const stateBefore = db
    .query("SELECT * FROM autopilot_state ORDER BY id ASC")
    .all();
  const armedBefore = db
    .query("SELECT * FROM armed_epics ORDER BY epic_id ASC")
    .all();
  // Sanity: final state.
  expect(getAutopilotStateWithMode()?.mode).toBe("armed");
  expect(getArmedEpics().map((r) => r.epic_id)).toEqual([
    "fn-11-bar",
    "fn-12-baz",
  ]);
  // Rewind + wipe BOTH projection tables (armed_epics MUST join the DELETE
  // list) + re-drain → byte-identical rows.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM autopilot_state");
  db.run("DELETE FROM armed_epics");
  drainAll();
  const stateAfter = db
    .query("SELECT * FROM autopilot_state ORDER BY id ASC")
    .all();
  const armedAfter = db
    .query("SELECT * FROM armed_epics ORDER BY epic_id ASC")
    .all();
  expect(stateAfter).toEqual(stateBefore);
  expect(armedAfter).toEqual(armedBefore);
});

test("EpicSnapshot done prunes the armed_epics row (fn-774)", () => {
  // Arm an epic, then fold a `{status:'done'}` EpicSnapshot for it — the
  // completion prune deletes the presence row. Keyed on event.session_id
  // (= the epic_id in this fold), so the right row drops.
  epicArmedEvent("fn-20-arm-then-done", true);
  drainAll();
  expect(getArmedEpics().map((r) => r.epic_id)).toEqual([
    "fn-20-arm-then-done",
  ]);
  const doneId = epicSnapshotEvent("fn-20-arm-then-done", {
    epic_number: 20,
    title: "arm then done",
    status: "done",
  });
  drainAll();
  expect(getArmedEpics().length).toBe(0); // pruned on completion
  expect(getCursor()).toBe(doneId); // cursor advanced
});

test("EpicSnapshot done on a never-armed epic is a harmless no-op (fn-774)", () => {
  // The common case: most done epics were never armed. The DELETE matches no
  // row, never throws, and the cursor still advances.
  const doneId = epicSnapshotEvent("fn-21-never-armed", {
    epic_number: 21,
    title: "never armed",
    status: "done",
  });
  expect(drainAll()).toBe(1);
  expect(getArmedEpics().length).toBe(0);
  expect(getCursor()).toBe(doneId);
});

test("EpicSnapshot with a non-done status leaves an armed row intact (fn-774)", () => {
  // The prune is gated STRICTLY on status === 'done'; an open/null status
  // EpicSnapshot for an armed epic must NOT touch its presence row.
  epicArmedEvent("fn-22-still-open", true);
  // status:'open' — not done.
  epicSnapshotEvent("fn-22-still-open", {
    epic_number: 22,
    title: "still open",
    status: "open",
  });
  // missing status — null, must not throw and must not prune.
  epicSnapshotEvent("fn-22-still-open", {
    epic_number: 22,
    title: "still open, no status",
  });
  drainAll();
  expect(getArmedEpics().map((r) => r.epic_id)).toEqual(["fn-22-still-open"]);
});

test("a repeat done EpicSnapshot for an already-pruned epic is a harmless no-op (fn-774)", () => {
  epicArmedEvent("fn-23-double-done", true);
  epicSnapshotEvent("fn-23-double-done", {
    epic_number: 23,
    title: "double done",
    status: "done",
  });
  drainAll();
  expect(getArmedEpics().length).toBe(0);
  // A SECOND done snapshot — the row is already gone; the DELETE no-ops.
  const secondDoneId = epicSnapshotEvent("fn-23-double-done", {
    epic_number: 23,
    title: "double done",
    status: "done",
  });
  drainAll();
  expect(getArmedEpics().length).toBe(0);
  expect(getCursor()).toBe(secondDoneId);
});

test("from-scratch re-fold over [EpicArmed X true, EpicSnapshot X done] leaves zero armed_epics rows (fn-774)", () => {
  // The determinism acceptance bar: an epic that ever folded to `done`
  // reproduces ZERO armed_epics rows on a cursor=0 re-fold. Wipe the
  // armed_epics + epics + epic_tombstones projections, rewind, re-drain →
  // byte-identical (empty) armed set.
  epicArmedEvent("fn-24-replay", true);
  epicArmedEvent("fn-25-stays-armed", true); // never completes — survives replay
  epicSnapshotEvent("fn-24-replay", {
    epic_number: 24,
    title: "replay",
    status: "done",
  });
  drainAll();
  const armedBefore = db
    .query("SELECT * FROM armed_epics ORDER BY epic_id ASC")
    .all();
  expect(getArmedEpics().map((r) => r.epic_id)).toEqual(["fn-25-stays-armed"]);
  // Rewind + wipe the touched projections + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM armed_epics");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM epic_tombstones");
  drainAll();
  const armedAfter = db
    .query("SELECT * FROM armed_epics ORDER BY epic_id ASC")
    .all();
  expect(armedAfter).toEqual(armedBefore); // byte-identical
  expect(getArmedEpics().map((r) => r.epic_id)).toEqual(["fn-25-stays-armed"]);
});

// ---------------------------------------------------------------------------
// Schema v46 / fn-666 — planctl-file attribution mint
// ---------------------------------------------------------------------------

test("planctl mint: scaffold envelope mints source='planctl' file_attributions for every named file", () => {
  // A planctl scaffold envelope carries a `files[]` of the JSON/spec paths
  // planctl wrote. The reducer's mint fold lands one file_attributions row
  // per path, keyed under (state_repo, session, path), source='planctl',
  // last_mutation_at=event.ts.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-mint" });
  const eventId = planctlEvent({
    sessionId: "sess-mint",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-mint",
    files: [
      ".planctl/epics/fn-1-foo.json",
      ".planctl/meta.json",
      ".planctl/specs/fn-1-foo.md",
      ".planctl/tasks/fn-1-foo.1.json",
    ],
    ts: 555,
  });
  drainAll();
  const rows = db
    .query(
      `SELECT file_path, source, op, last_mutation_at, last_event_id
         FROM file_attributions
        WHERE project_dir = ? AND session_id = ?
        ORDER BY file_path`,
    )
    .all("/repo-mint", "sess-mint") as Array<{
    file_path: string;
    source: string;
    op: string;
    last_mutation_at: number;
    last_event_id: number;
  }>;
  expect(rows.length).toBe(4);
  for (const r of rows) {
    expect(r.source).toBe("planctl");
    expect(r.op).toBe("scaffold");
    expect(r.last_mutation_at).toBe(555);
    expect(r.last_event_id).toBe(eventId);
  }
  expect(rows.map((r) => r.file_path)).toEqual([
    ".planctl/epics/fn-1-foo.json",
    ".planctl/meta.json",
    ".planctl/specs/fn-1-foo.md",
    ".planctl/tasks/fn-1-foo.1.json",
  ]);
});

test("planctl mint: null planctl_files (read-only verb) mints no rows", () => {
  // A read-only verb (`planctl epics`) writes no files — the envelope's
  // `files` field is null, the deriver lifts to null, the mint is a no-op.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-readonly" });
  planctlEvent({
    sessionId: "sess-readonly",
    op: "epics",
    target: null,
    epicId: null,
    subjectPresent: false,
    // No files / stateRepo passed → planctl_files=null, data='{}'.
  });
  drainAll();
  const count = (
    db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("planctl mint: empty planctl_files array mints no rows (defensive)", () => {
  // Should never happen at hook write time (the deriver folds empty to
  // null), but a backfill bug could theoretically write `[]` — the
  // reducer's `length > 0` guard catches it.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-empty" });
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-empty",
    tool_name: "Bash",
    planctl_op: "scaffold",
    planctl_target: "fn-1-foo",
    planctl_epic_id: "fn-1-foo",
    planctl_subject_present: 1,
    planctl_queue_jump: 0,
    planctl_files: "[]",
    data: JSON.stringify({
      tool_response: {
        stdout: JSON.stringify({
          planctl_invocation: {
            op: "scaffold",
            target: "fn-1-foo",
            state_repo: "/repo-empty",
          },
        }),
      },
    }),
  });
  drainAll();
  const count = (
    db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("planctl mint: missing state_repo (corrupt envelope) mints no rows", () => {
  // Defensive: a planctl event whose envelope payload doesn't carry
  // state_repo (corrupt envelope or pre-fn-666 historical row) lands no
  // attributions. The mint silently no-ops, cursor still advances.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-norepo" });
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-norepo",
    tool_name: "Bash",
    planctl_op: "scaffold",
    planctl_target: "fn-1-foo",
    planctl_epic_id: "fn-1-foo",
    planctl_subject_present: 1,
    planctl_queue_jump: 0,
    planctl_files: JSON.stringify([".planctl/epics/fn-1-foo.json"]),
    // data missing the state_repo field
    data: JSON.stringify({
      tool_response: {
        stdout: JSON.stringify({
          planctl_invocation: {
            op: "scaffold",
            target: "fn-1-foo",
            // no state_repo
          },
        }),
      },
    }),
  });
  drainAll();
  const count = (
    db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("planctl mint: malformed event.data folds to no-op (safe value invariant)", () => {
  // CLAUDE.md "a malformed `data` blob folds to a safe value" — the mint
  // catches the JSON.parse exception, falls to null state_repo, no-ops.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-garbage" });
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-garbage",
    tool_name: "Bash",
    planctl_op: "scaffold",
    planctl_target: "fn-1-foo",
    planctl_epic_id: "fn-1-foo",
    planctl_subject_present: 1,
    planctl_queue_jump: 0,
    planctl_files: JSON.stringify([".planctl/epics/fn-1-foo.json"]),
    data: "{this is not valid json",
  });
  drainAll();
  const count = (
    db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("planctl mint: malformed planctl_files JSON folds to no-op", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-badjson" });
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-badjson",
    tool_name: "Bash",
    planctl_op: "scaffold",
    planctl_target: "fn-1-foo",
    planctl_epic_id: "fn-1-foo",
    planctl_subject_present: 1,
    planctl_queue_jump: 0,
    planctl_files: "not valid json",
    data: JSON.stringify({
      tool_response: {
        stdout: JSON.stringify({
          planctl_invocation: { op: "scaffold", state_repo: "/repo" },
        }),
      },
    }),
  });
  drainAll();
  const count = (
    db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("planctl mint: absolute path in files[] is filtered out", () => {
  // Defensive: planctl emits repo-relative paths, but a corrupt envelope
  // might carry an absolute path. The mint skips it (would never match the
  // dirty_files[].path tuple downstream, would strand as an orphan
  // attribution forever).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-abs" });
  planctlEvent({
    sessionId: "sess-abs",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-abs",
    files: [
      "/abs/path/spec.md", // skipped
      ".planctl/epics/fn-1-foo.json", // minted
    ],
  });
  drainAll();
  const rows = db
    .query("SELECT file_path FROM file_attributions ORDER BY file_path")
    .all() as Array<{ file_path: string }>;
  expect(rows.map((r) => r.file_path)).toEqual([
    ".planctl/epics/fn-1-foo.json",
  ]);
});

test("planctl mint: path with `..` traversal is filtered out (defensive)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-trav" });
  planctlEvent({
    sessionId: "sess-trav",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-trav",
    files: ["../outside.md", ".planctl/specs/fn-1-foo.md"],
  });
  drainAll();
  const rows = db
    .query("SELECT file_path FROM file_attributions ORDER BY file_path")
    .all() as Array<{ file_path: string }>;
  expect(rows.map((r) => r.file_path)).toEqual([".planctl/specs/fn-1-foo.md"]);
});

test("planctl mint: GitSnapshot following a mint renders the planctl-source attribution (not orphan)", () => {
  // The end-to-end orphan-fix proof. A planctl mint lands the
  // file_attributions row; the next GitSnapshot on a dirty .planctl file
  // surfaces it through pass-3 render (source='planctl' badge), NOT
  // through the orphan_count rollup.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-snap" });
  planctlEvent({
    sessionId: "sess-snap",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-snap",
    files: [".planctl/epics/fn-1-foo.json"],
    ts: 1000,
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-snap",
    cwd: "/repo-snap",
    ts: 1001,
    data: JSON.stringify({
      project_dir: "/repo-snap",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: ".planctl/epics/fn-1-foo.json",
          xy: "??",
          mtime_ms: null,
        },
      ],
    }),
  });
  drainAll();
  // The git_status row's attributions array carries the planctl mint.
  // orphaned_count is the project-wide rollup of zero-attribution files
  // (the strict-mystery semantic) — with the mint live, it stays 0 on a
  // .planctl file that's dirty.
  const gs = db
    .query(
      "SELECT dirty_files, orphaned_count FROM git_status WHERE project_dir = ?",
    )
    .get("/repo-snap") as {
    dirty_files: string;
    orphaned_count: number;
  };
  expect(gs.orphaned_count).toBe(0);
  const dirty = JSON.parse(gs.dirty_files) as Array<{
    path: string;
    attributions: Array<{ session_id: string; source: string; op: string }>;
  }>;
  expect(dirty.length).toBe(1);
  expect(dirty[0].attributions.length).toBe(1);
  expect(dirty[0].attributions[0]).toEqual(
    expect.objectContaining({
      session_id: "sess-snap",
      source: "planctl",
      op: "scaffold",
    }),
  );
});

test("planctl mint: a planctl file does NOT also get an inferred attribution (guard widened)", () => {
  // The pass-2 inferred-guard widened to `IN ('tool','bash','planctl')`
  // so a planctl-attributed file is NOT also bracketed against this
  // session's Bash windows. Without the widening, the file would receive
  // TWO active attribution rows — `planctl` AND `inferred` — which would
  // mislabel the file's authorship.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-both", ts: 500 });
  // Pre-bracket Bash window so inference WOULD attribute if the guard
  // missed.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-both",
    cwd: "/repo-both",
    ts: 900,
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-both",
    cwd: "/repo-both",
    ts: 1100,
  });
  // Planctl event INSIDE the window, mints the file_attributions row.
  planctlEvent({
    sessionId: "sess-both",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-both",
    files: [".planctl/epics/fn-1-foo.json"],
    ts: 1000,
  });
  // GitSnapshot triggers pass-2 inference; the planctl row should suppress
  // the inferred attribution on this file.
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-both",
    cwd: "/repo-both",
    ts: 1200,
    data: JSON.stringify({
      project_dir: "/repo-both",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: ".planctl/epics/fn-1-foo.json",
          xy: "??",
          mtime_ms: 1050 * 1000, // inside the bash window
        },
      ],
    }),
  });
  drainAll();
  // Only ONE row, source='planctl' — NOT planctl + inferred.
  const rows = db
    .query(
      `SELECT source, op FROM file_attributions
        WHERE project_dir = ? AND session_id = ?
          AND file_path = ?
        ORDER BY source`,
    )
    .all("/repo-both", "sess-both", ".planctl/epics/fn-1-foo.json") as Array<{
    source: string;
    op: string;
  }>;
  expect(rows).toEqual([{ source: "planctl", op: "scaffold" }]);
});

test("planctl mint: re-fold determinism — cursor=0 reproduces byte-identical file_attributions", () => {
  // Drive a planctl-op + snapshot + commit sequence, capture the
  // projection, rewind cursor + wipe table, re-fold from scratch, assert
  // byte-identical rows. The re-fold determinism invariant for the new
  // mint path.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rd", ts: 100 });
  planctlEvent({
    sessionId: "sess-rd",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-rd",
    files: [".planctl/epics/fn-1-foo.json", ".planctl/specs/fn-1-foo.md"],
    ts: 200,
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-rd",
    cwd: "/repo-rd",
    ts: 300,
    data: JSON.stringify({
      project_dir: "/repo-rd",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: ".planctl/epics/fn-1-foo.json", xy: "??", mtime_ms: null },
        { path: ".planctl/specs/fn-1-foo.md", xy: "??", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  const before = db
    .query(
      `SELECT project_dir, session_id, file_path, last_mutation_at,
              last_commit_at, op, source, last_event_id, updated_at
         FROM file_attributions ORDER BY project_dir, session_id, file_path`,
    )
    .all();
  // Rewind cursor + wipe projection + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  drainAll();
  const after = db
    .query(
      `SELECT project_dir, session_id, file_path, last_mutation_at,
              last_commit_at, op, source, last_event_id, updated_at
         FROM file_attributions ORDER BY project_dir, session_id, file_path`,
    )
    .all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Backend-exec coordinates fold (fn-668 / schema v48)
// ---------------------------------------------------------------------------

test("backend_exec_* folds latest-non-NULL onto jobs across all event types", () => {
  // SessionStart seeds the job row; the new every-event arm fires on
  // any subsequent event whose hook stamped a non-null type. Cover a
  // mix of hook_events (UserPromptSubmit, PreToolUse, Stop) to prove
  // the fold isn't gated to a single hook_event.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-be",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "7",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-be",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "7",
  });
  // A different pane id arrives on PreToolUse — the latest-non-NULL
  // arm must advance the pane id to '11'.
  insertEvent({
    hook_event: "PreToolUse",
    session_id: "sess-be",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "11",
  });
  // Stop event also carries coords — proves the arm is fully hook-
  // event-agnostic, not just SessionStart-or-prompt.
  insertEvent({
    hook_event: "Stop",
    session_id: "sess-be",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "11",
  });
  drainAll();

  const row = db
    .query(
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("sess-be") as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.backend_exec_type).toBe("tmux");
  expect(row?.backend_exec_session_id).toBe("mike-main");
  expect(row?.backend_exec_pane_id).toBe("11");
});

test("NULL-carrying backend_exec event does NOT clobber a prior non-null capture", () => {
  // SessionStart stamps coords; a subsequent event fires outside the
  // multiplexer (all-NULL coords) and the prior values must stick.
  // This is the load-bearing COALESCE property — a single bare PreToolUse
  // outside the multiplexer can't wipe the session's identity.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-stick",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "7",
  });
  drainAll();
  // Confirm seed landed.
  const seeded = db
    .query(
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("sess-stick") as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
  expect(seeded?.backend_exec_type).toBe("tmux");
  expect(seeded?.backend_exec_session_id).toBe("mike-main");
  expect(seeded?.backend_exec_pane_id).toBe("7");

  // Now a NULL-carrying event — the fold's `type != null` gate skips
  // the UPDATE entirely, so the prior values stick byte-identically.
  insertEvent({
    hook_event: "PreToolUse",
    session_id: "sess-stick",
    backend_exec_type: null,
    backend_exec_session_id: null,
    backend_exec_pane_id: null,
  });
  drainAll();

  const after = db
    .query(
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("sess-stick") as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
  expect(after?.backend_exec_type).toBe("tmux");
  expect(after?.backend_exec_session_id).toBe("mike-main");
  expect(after?.backend_exec_pane_id).toBe("7");
});

test("partial backend_exec capture: COALESCE preserves the non-null field, advances the other", () => {
  // A partial capture (type + session set, pane NULL) must advance
  // the session if it changed and preserve the prior pane. This
  // covers the "one sub-var temporarily absent" edge case the
  // task spec explicitly calls out.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-part",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "7",
  });
  // Partial: type set (gate fires), session changes, pane NULL —
  // pane must remain '7' under COALESCE.
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-part",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-other",
    backend_exec_pane_id: null,
  });
  drainAll();

  const row = db
    .query(
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("sess-part") as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
  expect(row?.backend_exec_type).toBe("tmux");
  expect(row?.backend_exec_session_id).toBe("mike-other");
  expect(row?.backend_exec_pane_id).toBe("7");
});

test("backend_exec fold: cursor=0 re-fold reproduces byte-identical jobs rows", () => {
  // Re-fold determinism check: insert a sequence of mixed events
  // (SessionStart, UserPromptSubmit, PreToolUse, NULL-carrying PreToolUse,
  // Stop), drain once, snapshot, rewind cursor + DELETE jobs, re-drain.
  // The post-rewind jobs row MUST equal the pre-rewind row byte-for-byte
  // — proves the fold reads only the event payload (frozen at hook
  // time) and never re-reads env / wall-clock / process state.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-refold",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "7",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-refold",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "7",
  });
  // Pane moves.
  insertEvent({
    hook_event: "PreToolUse",
    session_id: "sess-refold",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "11",
  });
  // NULL-carrying event (gate skips the UPDATE — re-fold must produce
  // the same skip).
  insertEvent({
    hook_event: "PreToolUse",
    session_id: "sess-refold",
    backend_exec_type: null,
    backend_exec_session_id: null,
    backend_exec_pane_id: null,
  });
  insertEvent({
    hook_event: "Stop",
    session_id: "sess-refold",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-other",
    backend_exec_pane_id: "11",
  });
  drainAll();

  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-refold");
  expect(before).not.toBeNull();

  // Rewind cursor + wipe jobs + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();

  const after = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-refold");
  expect(after).toEqual(before);
});

test("config_dir fold unchanged: only SessionStart seeds it, subsequent events do not touch it", () => {
  // Regression guard: the new every-event backend_exec arm must NOT
  // disturb `config_dir`'s SessionStart-only fold. config_dir lands
  // via the SessionStart UPSERT's COALESCE ON CONFLICT; a non-
  // SessionStart event carrying NULL config_dir must NOT clobber.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-cfg",
    config_dir: "/tmp/profile-x",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-cfg",
    // Non-SessionStart events always carry NULL config_dir per the
    // hook contract; assert the fold leaves the prior value alone.
    config_dir: null,
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "7",
  });
  drainAll();

  const row = db
    .query("SELECT config_dir, backend_exec_type FROM jobs WHERE job_id = ?")
    .get("sess-cfg") as {
    config_dir: string | null;
    backend_exec_type: string | null;
  } | null;
  // config_dir held through the every-event fold; backend_exec_type
  // landed via the new arm — proves the two fold paths are independent.
  expect(row?.config_dir).toBe("/tmp/profile-x");
  expect(row?.backend_exec_type).toBe("tmux");
});

// ---------------------------------------------------------------------------
// Retired `BackendExecSnapshot` arm (fn-710). The synthetic-event TYPE and its
// historical rows persist in the immutable log, but the producer feed that
// produced them is gone and the dispatch arm is now an EXPLICIT empty no-op.
// CRITICAL regression guard: the arm must NOT fall through to `projectJobsRow`
// (the final `else`) — doing so would route a historical `BackendExecSnapshot`
// into the jobs projection and break re-fold determinism. These tests pin the
// no-op: the cursor advances, the jobs projection is untouched, and a cursor=0
// re-fold over a log containing one reproduces byte-identical rows.
// ---------------------------------------------------------------------------

test("historical BackendExecSnapshot folds to a no-op: cursor advances, jobs projection untouched", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "job-1" });
  // Snapshot of the jobs projection immediately AFTER SessionStart folds but
  // BEFORE the BackendExecSnapshot — the no-op must leave this byte-identical.
  expect(drainAll()).toBe(1);
  const beforeRow = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("job-1");

  const snapId = insertEvent({
    hook_event: "BackendExecSnapshot",
    session_id: "job-1",
    data: JSON.stringify({ tab_id: "3", tab_name: "agent-a" }),
  });
  // The retired arm folds: the cursor advances (the event is consumed) but
  // nothing is written to `jobs`.
  expect(drainAll()).toBe(1);
  expect(getCursor()).toBe(snapId);

  const afterRow = db.query("SELECT * FROM jobs WHERE job_id = ?").get("job-1");
  // Byte-identical: the no-op arm did NOT touch the jobs row (no
  // `last_event_id` bump, no projection write — proving it did not fall
  // through to `projectJobsRow`).
  expect(afterRow).toEqual(beforeRow);
});

test("BackendExecSnapshot against a missing job_id mints NO jobs row (no projectJobsRow fall-through)", () => {
  const id = insertEvent({
    hook_event: "BackendExecSnapshot",
    session_id: "no-such-job",
    data: JSON.stringify({ tab_id: "3", tab_name: "agent-a" }),
  });
  expect(drainAll()).toBe(1);
  expect(getCursor()).toBe(id);
  // If the arm had fallen through to `projectJobsRow`, this lone event would
  // have minted a `no-such-job` jobs row. The no-op arm mints nothing.
  const row = db
    .query("SELECT job_id FROM jobs WHERE job_id = ?")
    .get("no-such-job");
  expect(row).toBeNull();
});

test("cursor=0 re-fold over a log containing a historical BackendExecSnapshot stays byte-identical", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "job-1" });
  insertEvent({
    hook_event: "BackendExecSnapshot",
    session_id: "job-1",
    data: JSON.stringify({ tab_id: "7", tab_name: "agent-X" }),
  });
  drainAll();
  const before = db.query("SELECT * FROM jobs WHERE job_id = ?").get("job-1");

  // Rewind cursor + clear jobs, then re-drain from scratch — the projection
  // must rebuild byte-identical. A deleted (vs. no-op'd) arm would route the
  // BackendExecSnapshot through `projectJobsRow` on this re-fold and diverge.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db.query("SELECT * FROM jobs WHERE job_id = ?").get("job-1");

  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// fn-789: TmuxPaneSnapshot fold arm — fills `backend_exec_session_id` on a
// NULL-session tmux job from the restore-worker's pane-probe pairs. FILL-ONLY
// (never overwrites a non-NULL session), reads ONLY the event payload, never
// throws on a malformed payload, and a cursor=0 re-fold over a log containing
// one reproduces byte-identical rows. The retired BackendExecSnapshot arm above
// is a DISTINCT event name and stays a no-op.
// ---------------------------------------------------------------------------

/** Read the three backend_exec coords off a jobs row, or null if missing. */
function getBackendCoords(jobId: string): {
  backend_exec_type: string | null;
  backend_exec_session_id: string | null;
  backend_exec_pane_id: string | null;
} | null {
  return db
    .query(
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
}

/** Insert a synthetic TmuxPaneSnapshot event carrying the given pairs. */
function tmuxPaneSnapshotEvent(
  pairs: { pane_id: string; session_name: string }[],
): number {
  return insertEvent({
    hook_event: "TmuxPaneSnapshot",
    session_id: "tmux-snapshot",
    data: JSON.stringify({ pairs }),
  });
}

test("TmuxPaneSnapshot fills backend_exec_session_id on a matching NULL-session tmux job", () => {
  // A claude in a human-created tmux session: the hook stamped type + pane id
  // (from TMUX/TMUX_PANE) but NO KEEPER_TMUX_SESSION, so the COALESCE arm
  // leaves the session NULL.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-tmux",
    backend_exec_type: "tmux",
    backend_exec_session_id: null,
    backend_exec_pane_id: "%1",
  });
  drainAll();
  expect(getBackendCoords("sess-tmux")?.backend_exec_session_id).toBeNull();

  tmuxPaneSnapshotEvent([{ pane_id: "%1", session_name: "human-work" }]);
  expect(drainAll()).toBe(1);

  const row = getBackendCoords("sess-tmux");
  expect(row?.backend_exec_type).toBe("tmux");
  expect(row?.backend_exec_pane_id).toBe("%1");
  expect(row?.backend_exec_session_id).toBe("human-work"); // filled
});

test("TmuxPaneSnapshot never overwrites a non-NULL backend_exec_session_id", () => {
  // A managed launch: the hook injected KEEPER_TMUX_SESSION, so the session is
  // already set. A snapshot pair for the same pane must NOT clobber it.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-managed",
    backend_exec_type: "tmux",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "%1",
  });
  drainAll();

  tmuxPaneSnapshotEvent([{ pane_id: "%1", session_name: "human-work" }]);
  expect(drainAll()).toBe(1);

  // Fill-only guard: the prior non-NULL session sticks byte-identically.
  expect(getBackendCoords("sess-managed")?.backend_exec_session_id).toBe(
    "autopilot",
  );
});

test("TmuxPaneSnapshot does not fill a non-tmux job or a pane-id mismatch", () => {
  // A non-tmux job with a NULL session and a tmux job whose pane id no pair
  // matches: neither must be touched.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-non-tmux",
    backend_exec_type: "other",
    backend_exec_session_id: null,
    backend_exec_pane_id: "%1",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-tmux-other",
    backend_exec_type: "tmux",
    backend_exec_session_id: null,
    backend_exec_pane_id: "%9",
  });
  drainAll();

  // Pair targets %1 — but %1 belongs to the NON-TMUX job (wrong type), and the
  // tmux job is on %9.
  tmuxPaneSnapshotEvent([{ pane_id: "%1", session_name: "human-work" }]);
  expect(drainAll()).toBe(1);

  expect(getBackendCoords("sess-non-tmux")?.backend_exec_session_id).toBeNull();
  expect(
    getBackendCoords("sess-tmux-other")?.backend_exec_session_id,
  ).toBeNull();
});

test("TmuxPaneSnapshot with a malformed/empty payload folds to a no-op (cursor advances, jobs untouched)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-noop",
    backend_exec_type: "tmux",
    backend_exec_session_id: null,
    backend_exec_pane_id: "%1",
  });
  drainAll();
  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-noop");

  // Empty data, non-array pairs, and garbage entries — each must no-op without
  // throwing while still advancing the cursor.
  const id1 = insertEvent({ hook_event: "TmuxPaneSnapshot", data: "" });
  const id2 = insertEvent({
    hook_event: "TmuxPaneSnapshot",
    data: JSON.stringify({ pairs: "not-an-array" }),
  });
  const id3 = insertEvent({
    hook_event: "TmuxPaneSnapshot",
    data: JSON.stringify({ pairs: [{ pane_id: "", session_name: "x" }, 42] }),
  });
  expect(drainAll()).toBe(3);
  expect(getCursor()).toBe(id3);
  expect(id1).toBeLessThan(id2);

  const after = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-noop");
  expect(after).toEqual(before);
});

test("TmuxPaneSnapshot fold: cursor=0 re-fold reproduces byte-identical jobs rows", () => {
  // The order-insensitive fill-only property is the load-bearing re-fold
  // invariant: a SessionStart (tmux, NULL session) + a TmuxPaneSnapshot filling
  // it, then a later non-snapshot event. A cursor=0 re-fold must rebuild the
  // exact same jobs row — proves the fold reads only the frozen event payload.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-refold-tmux",
    backend_exec_type: "tmux",
    backend_exec_session_id: null,
    backend_exec_pane_id: "%3",
  });
  tmuxPaneSnapshotEvent([
    { pane_id: "%3", session_name: "human-A" },
    { pane_id: "%99", session_name: "unrelated" },
  ]);
  // A SECOND snapshot for the now-filled pane — fill-only makes this a no-op
  // both on the first drain and the re-fold (replay order-safety).
  tmuxPaneSnapshotEvent([{ pane_id: "%3", session_name: "human-B-stale" }]);
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-refold-tmux",
    backend_exec_type: "tmux",
    backend_exec_session_id: null,
    backend_exec_pane_id: "%3",
  });
  drainAll();

  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-refold-tmux");
  expect(before).not.toBeNull();
  // The FIRST snapshot won (fill-only); the stale second never clobbered.
  expect(
    (before as { backend_exec_session_id: string }).backend_exec_session_id,
  ).toBe("human-A");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();

  const after = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-refold-tmux");
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// fn-670 (T2): task→committing-session link write on foldCommit. Stamps
// `last_commit_for_task_at` on the embedded job element whose
// `job_id == committer_session_id` under each task element matching every
// id in the Commit payload's `task_ids[]`. Gated on BOTH non-null. The
// link survives a later jobs-row re-sync (clobber guard via the OLD-
// element carve-out in `buildEmbeddedJob`). A cursor=0 re-fold over a
// mixed pre-/post-v49 log reproduces byte-identical `epics` rows.
// ---------------------------------------------------------------------------

/**
 * Helper: read a specific embedded job element by (taskId, jobId), or
 * null if either the task or job is missing. Returns the raw object
 * including `last_commit_for_task_at` so the T2 link write can be
 * asserted directly.
 */
function getEmbeddedTaskJob(
  taskId: string,
  jobId: string,
): {
  job_id: string;
  plan_verb: string;
  state: string;
  last_event_id: number;
  updated_at: number;
  last_commit_for_task_at?: number | null;
} | null {
  const task = getTask(taskId);
  if (task == null || !Array.isArray(task.jobs)) {
    return null;
  }
  const j = (task.jobs as { job_id: string }[]).find((j) => j.job_id === jobId);
  return (j ?? null) as ReturnType<typeof getEmbeddedTaskJob>;
}

test("fn-670 T2: foldCommit stamps last_commit_for_task_at on the embedded job whose job_id == committer_session_id under each named task", () => {
  // Seed: a worker session under task `fn-1-foo.3`. The SessionStart
  // fan-out lands the embedded job element via `syncJobIntoEpic`. The
  // Commit event carries `committer_session_id == <session UUID>` and
  // `task_ids: ['fn-1-foo.3']`. `extractCommit` validates
  // `committer_session_id` against UUID_RE (job_id === session_id is a
  // keeper invariant), so the test session id IS a UUID — mirroring
  // production where Claude Code session IDs are UUIDs.
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.3",
  });
  drainAll();
  const before = getEmbeddedTaskJob("fn-1-foo.3", TEST_UUID);
  expect(before).not.toBeNull();
  expect(before?.last_commit_for_task_at).toBeNull();

  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      task_ids: ["fn-1-foo.3"],
      committed_at_ms: 1_700_000_000_000,
    }),
  });
  expect(drainAll()).toBe(1);

  // (a) The link is stamped on the embedded job element under the task.
  // (b) The job's `last_event_id` / `updated_at` advanced.
  const after = getEmbeddedTaskJob("fn-1-foo.3", TEST_UUID);
  expect(after?.last_commit_for_task_at).toBe(1_700_000_000); // ms → s
  expect(after?.last_event_id).toBe(id);
  // (c) Cursor advanced.
  expect(getCursor()).toBe(id);
});

test("fn-670 T2: multi-task Commit stamps the link on EVERY named task symmetrically", () => {
  // A single commit closing two tasks under different epics — the link
  // write fans across BOTH. (jobctl supports multi-Task commits; the
  // git-worker collect-all parser feeds this exact shape.)
  // `committer_session_id` must be a UUID per extractCommit's gate
  // (job_id === session_id is a keeper invariant).
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.1",
  });
  drainAll();

  // Seed the second task. The session's plan_ref binds it to fn-1-foo.1
  // so the syncJobIntoEpic fan-out only lands it under THAT task; for
  // fn-2-bar.2 we patch the epics row directly to inject the embedded
  // job element (test-only — the live path lands embedded jobs via
  // syncJobIntoEpic, and a single session can only have one plan_ref).
  epicSnapshotEvent("fn-2-bar", { epic_number: 2, title: "Bar" });
  taskSnapshotEvent("fn-2-bar.2", {
    epic_id: "fn-2-bar",
    task_number: 2,
    title: "Bar 2",
  });
  drainAll();
  const row = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get("fn-2-bar") as { tasks: string };
  const tasks = JSON.parse(row.tasks);
  const t2 = tasks.find(
    (t: { task_id: string }) => t.task_id === "fn-2-bar.2",
  ) as { jobs: unknown[] };
  t2.jobs = [
    {
      job_id: TEST_UUID,
      plan_verb: "work",
      state: "working",
      title: null,
      created_at: 1,
      updated_at: 1,
      last_event_id: 1,
      last_api_error_at: null,
      last_api_error_kind: null,
      last_input_request_at: null,
      last_input_request_kind: null,
      last_permission_prompt_at: null,
      last_permission_prompt_kind: null,
      git_dirty_count: 0,
      git_unattributed_to_live_count: 0,
      git_orphan_count: 0,
      last_commit_for_task_at: null,
    },
  ];
  db.run("UPDATE epics SET tasks = ? WHERE epic_id = ?", [
    JSON.stringify(tasks),
    "fn-2-bar",
  ]);

  // Now fire one Commit event naming BOTH tasks.
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID_2,
      parent_oid: null,
      files: ["src/x.ts"],
      committer_session_id: TEST_UUID,
      task_ids: ["fn-1-foo.1", "fn-2-bar.2"],
      committed_at_ms: 1_800_000_000_000,
    }),
  });
  expect(drainAll()).toBe(1);

  // Both embedded job elements stamped.
  const j1 = getEmbeddedTaskJob("fn-1-foo.1", TEST_UUID);
  const j2 = getEmbeddedTaskJob("fn-2-bar.2", TEST_UUID);
  expect(j1?.last_commit_for_task_at).toBe(1_800_000_000);
  expect(j2?.last_commit_for_task_at).toBe(1_800_000_000);
  expect(getCursor()).toBe(id);
});

test("fn-670 T2: no-op when committer_session_id is null (global-discharge path skips the link write)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.5",
  });
  drainAll();
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: null,
      task_ids: ["fn-1-foo.5"],
      committed_at_ms: 1_700_000_000_000,
    }),
  });
  expect(drainAll()).toBe(1);
  // Link still null — the global-discharge arm doesn't stamp the link.
  const j = getEmbeddedTaskJob("fn-1-foo.5", TEST_UUID);
  expect(j?.last_commit_for_task_at).toBeNull();
  expect(getCursor()).toBe(id);
});

test("fn-670 T2: no-op when task_ids is empty (pre-fn-670 historical event or no-trailer commit)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.6",
  });
  drainAll();
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      task_ids: [],
      committed_at_ms: 1_700_000_000_000,
    }),
  });
  expect(drainAll()).toBe(1);
  const j = getEmbeddedTaskJob("fn-1-foo.6", TEST_UUID);
  expect(j?.last_commit_for_task_at).toBeNull();
  expect(getCursor()).toBe(id);
});

test("fn-670 T2: pre-fn-670 Commit payload (no task_ids field) folds to []: link write is a safe no-op", () => {
  // Re-fold determinism over the historical event log. A pre-fn-670
  // Commit event has no `task_ids` field; extractCommit defaults to
  // `[]`. The fold treats `[]` exactly as the "no task linkage" case.
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.7",
  });
  drainAll();
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      // NO task_ids field at all — pre-fn-670 shape.
      committed_at_ms: 1_700_000_000_000,
    }),
  });
  expect(drainAll()).toBe(1);
  const j = getEmbeddedTaskJob("fn-1-foo.7", TEST_UUID);
  expect(j?.last_commit_for_task_at).toBeNull();
  expect(getCursor()).toBe(id);
});

test("fn-670 T2: clobber guard — a later syncJobIntoEpic re-sync PRESERVES last_commit_for_task_at", () => {
  // The headline-risk test. Stamp the link via foldCommit, then drive a
  // jobs-row re-sync (e.g. a UserPromptSubmit flipping state →
  // working) and assert the link survives. Without the
  // `buildEmbeddedJob` carve-out, the link would be clobbered by the
  // jobs-row re-emit.
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.8",
  });
  drainAll();
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      task_ids: ["fn-1-foo.8"],
      committed_at_ms: 1_900_000_000_000,
    }),
  });
  drainAll();
  const stamped = getEmbeddedTaskJob("fn-1-foo.8", TEST_UUID);
  expect(stamped?.last_commit_for_task_at).toBe(1_900_000_000);

  // Drive a jobs-row re-sync via UserPromptSubmit (flips state →
  // working AND fires `syncJobIntoEpic` for this session).
  insertEvent({ hook_event: "UserPromptSubmit", session_id: TEST_UUID });
  drainAll();

  const after = getEmbeddedTaskJob("fn-1-foo.8", TEST_UUID);
  // State flipped to working (the re-sync DID fire) — proving the path
  // exercised the carve-out.
  expect(after?.state).toBe("working");
  // The link survived.
  expect(after?.last_commit_for_task_at).toBe(1_900_000_000);
});

test("fn-670 T2: commit-before-claim (no embedded job element yet) is a deterministic no-op", () => {
  // The commit fold lands BEFORE the worker's SessionStart — the
  // documented edge case. On a synthetic event stream we craft this
  // by inserting Commit first, then SessionStart. The fold drops the
  // link rather than shelling a job element foldCommit doesn't
  // otherwise own; the cursor still advances. The SessionStart's
  // syncJobIntoEpic then lands the embedded job element with
  // `last_commit_for_task_at = null` (no prior element to carry the
  // field forward from).
  const idCommit = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      task_ids: ["fn-1-foo.9"],
      committed_at_ms: 2_000_000_000_000,
    }),
  });
  drainAll();
  expect(getCursor()).toBe(idCommit);
  // No epic row, no task element — the link write skipped at every
  // level.
  expect(getTask("fn-1-foo.9")).toBeNull();

  // Now SessionStart lands; the embedded job element appears with
  // `last_commit_for_task_at = null` (no prior to carry from).
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.9",
  });
  drainAll();
  const j = getEmbeddedTaskJob("fn-1-foo.9", TEST_UUID);
  expect(j).not.toBeNull();
  expect(j?.last_commit_for_task_at).toBeNull();
});

test("fn-670 T2: cursor=0 re-fold reproduces byte-identical epics rows over a mixed pre-/post-v49 Commit log", () => {
  // Determinism over a log carrying BOTH a pre-fn-670 Commit (no
  // task_ids field, extractCommit defaults to []) AND a post-fn-670
  // Commit (with task_ids). A from-scratch re-fold must reproduce
  // byte-identical `epics` rows.
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.10",
  });
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      // Legacy shape: no task_ids field.
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/legacy.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 1_500_000_000_000,
    }),
  });
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      // Post-fn-670 shape: task_ids present.
      project_dir: "/repo",
      commit_oid: TEST_OID_2,
      parent_oid: TEST_OID,
      files: ["src/new.ts"],
      committer_session_id: TEST_UUID,
      task_ids: ["fn-1-foo.10"],
      committed_at_ms: 1_900_000_000_000,
    }),
  });
  drainAll();
  const before = db
    .query("SELECT * FROM epics ORDER BY epic_id ASC")
    .all() as Record<string, unknown>[];

  // Rewind cursor + DELETE the projection, then re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  drainAll();
  const after = db
    .query("SELECT * FROM epics ORDER BY epic_id ASC")
    .all() as Record<string, unknown>[];

  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v51 (fn-682): jobs.monitors snapshot-replace on Stop +
// clear-on-terminal on SessionEnd / Killed.
// ---------------------------------------------------------------------------

/** Read the persisted `monitors` JSON for `jobId`, parsed. */
function getMonitors(
  jobId = "sess-a",
):
  | { id: string; kind: string; command?: string; description?: string }[]
  | null {
  const row = db
    .query("SELECT monitors FROM jobs WHERE job_id = ?")
    .get(jobId) as { monitors: string } | null;
  if (row == null) return null;
  return JSON.parse(row.monitors) as {
    id: string;
    kind: string;
    command?: string;
    description?: string;
  }[];
}

/**
 * Shorthand for an expected projected monitor entry. fn-718 (task 1): the
 * reducer always serializes command/description (default `""`) so the
 * `.toEqual` assertions name them explicitly.
 */
function mon(id: string, kind: string, command = "", description = "") {
  return { id, kind, command, description };
}

/**
 * Insert one PostToolUse:Monitor launch event in `sessionId`, stamping
 * the deriver column directly (the hook would do this at INSERT time;
 * tests skip the deriver call and pass the column explicitly).
 */
function insertMonitorLaunch(taskId: string, sessionId = "sess-a"): number {
  return insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Monitor",
    session_id: sessionId,
    background_task_id: taskId,
    data: JSON.stringify({ tool_response: { taskId } }),
  });
}

/**
 * Insert one PostToolUse:Bash `run_in_background` launch event in
 * `sessionId`.
 */
function insertBashBgLaunch(taskId: string, sessionId = "sess-a"): number {
  return insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: sessionId,
    background_task_id: taskId,
    data: JSON.stringify({ tool_response: { backgroundTaskId: taskId } }),
  });
}

/**
 * Insert one Stop event whose `data.background_tasks` carries the given
 * `(id, type)` entries.
 */
function insertStopWithTasks(
  tasks: {
    id: string;
    type: string;
    command?: string;
    description?: string;
  }[],
  sessionId = "sess-a",
): number {
  return insertEvent({
    hook_event: "Stop",
    session_id: sessionId,
    data: JSON.stringify({ background_tasks: tasks }),
  });
}

test("v51 monitors: Stop seeds jobs.monitors from data.background_tasks (shell allowlist)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertStopWithTasks([
    { id: "bash-a", type: "shell" },
    { id: "subagent-x", type: "subagent" },
  ]);
  drainAll();
  expect(getMonitors()).toEqual([mon("bash-a", "ambient")]);
});

test("v51 monitors: command/description survive into jobs.monitors (fn-718)", () => {
  // fn-718 (task 1): the Stop snapshot's command/description ride through
  // computeMonitors into the projected entry; `kind` still comes from the
  // provenance scan. A terminal-clear (SessionEnd) drops back to '[]'.
  insertEvent({ hook_event: "SessionStart" });
  insertMonitorLaunch("bash-m");
  insertStopWithTasks([
    {
      id: "bash-amb",
      type: "shell",
      command: "keeper await gitCleanState",
      description: "await clean",
    },
    {
      id: "bash-m",
      type: "shell",
      command: "chatctl watch-chat",
      description: "chatctl bus",
    },
  ]);
  drainAll();
  expect(getMonitors()).toEqual([
    mon("bash-amb", "ambient", "keeper await gitCleanState", "await clean"),
    mon("bash-m", "monitor", "chatctl watch-chat", "chatctl bus"),
  ]);
  // Terminal-clear still wins — the enriched entries drop to '[]'.
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  const row = db
    .query("SELECT monitors FROM jobs WHERE job_id = ?")
    .get("sess-a") as { monitors: string };
  expect(row.monitors).toBe("[]");
});

test("v51 monitors: empty background_tasks drops to '[]' (snapshot paradox)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertStopWithTasks([{ id: "bash-a", type: "shell" }]);
  drainAll();
  expect(getMonitors()).toEqual([mon("bash-a", "ambient")]);
  // Now a Stop with no live shells — the snapshot is authoritative.
  insertStopWithTasks([]);
  drainAll();
  expect(getMonitors()).toEqual([]);
});

test("v51 monitors: missing background_tasks field folds to []", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "Stop", data: "{}" });
  drainAll();
  expect(getMonitors()).toEqual([]);
});

test("v51 monitors: malformed Stop data blob folds to [] and cursor advances", () => {
  insertEvent({ hook_event: "SessionStart" });
  const stopId = insertEvent({ hook_event: "Stop", data: "{not-json" });
  drainAll();
  expect(getMonitors()).toEqual([]);
  expect(getCursor()).toBe(stopId);
});

test("v51 monitors: three-way provenance (monitor / bash-bg / ambient)", () => {
  insertEvent({ hook_event: "SessionStart" });
  // Monitor launch precedes the Stop; provenance for bash-m must be `monitor`.
  insertMonitorLaunch("bash-m");
  // Bash bg launch precedes the Stop; provenance for bash-b must be `bash-bg`.
  insertBashBgLaunch("bash-b");
  // bash-amb has no launch event in this session's stream → `ambient`.
  insertStopWithTasks([
    { id: "bash-amb", type: "shell" },
    { id: "bash-b", type: "shell" },
    { id: "bash-m", type: "shell" },
  ]);
  drainAll();
  expect(getMonitors()).toEqual([
    mon("bash-amb", "ambient"),
    mon("bash-b", "bash-bg"),
    mon("bash-m", "monitor"),
  ]);
});

test("v51 monitors: provenance scan is session-scoped (a launch in another session is NOT seen)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b" });
  // Monitor launch in sess-b mints task-1; sess-a's Stop sees the same id
  // but the in-fold scan is gated on session_id so provenance is `ambient`.
  insertMonitorLaunch("task-1", "sess-b");
  insertStopWithTasks([{ id: "task-1", type: "shell" }], "sess-a");
  drainAll();
  expect(getMonitors("sess-a")).toEqual([mon("task-1", "ambient")]);
});

test("v51 monitors: SessionEnd clears monitors to []", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertStopWithTasks([{ id: "bash-a", type: "shell" }]);
  drainAll();
  expect(getMonitors()).toEqual([mon("bash-a", "ambient")]);
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getMonitors()).toEqual([]);
});

test("v51 monitors: Killed clears monitors to []", () => {
  insertEvent({
    hook_event: "SessionStart",
    pid: 4242,
    start_time: "stamp-1",
  });
  insertStopWithTasks([{ id: "bash-a", type: "shell" }]);
  drainAll();
  expect(getMonitors()).toEqual([mon("bash-a", "ambient")]);
  killedEvent(4242, "stamp-1");
  drainAll();
  expect(getMonitors()).toEqual([]);
});

test("v51 monitors: Stop on a still-live row refreshes monitors EVEN when the sub-agent guard would swallow the state flip", () => {
  // The monitors snapshot-replace is hoisted ABOVE the sub-agent guard
  // so a mid-Task-yield Stop still keeps `jobs.monitors` honest. The
  // state flip is suppressed (sub-agent still running) but the live
  // monitor set updates.
  insertEvent({ hook_event: "SessionStart" });
  insertStopWithTasks([{ id: "bash-a", type: "shell" }]);
  drainAll();
  expect(getMonitors()).toEqual([mon("bash-a", "ambient")]);
  // Inject a still-running subagent_invocations row so the guard fires.
  const subTs = tsCounter++;
  db.run(
    `INSERT INTO subagent_invocations (job_id, agent_id, turn_seq,
      subagent_type, status, ts, last_event_id, updated_at)
     VALUES ('sess-a', 'sub-1', 1, 'general', 'running', ?, ?, ?)`,
    [subTs, getCursor(), subTs],
  );
  // A second Stop with a different monitor set. The state flip is
  // swallowed by the sub-agent guard, but monitors still refresh.
  insertStopWithTasks([{ id: "bash-b", type: "shell" }]);
  drainAll();
  expect(getMonitors()).toEqual([mon("bash-b", "ambient")]);
});

test("v51 monitors: cursor=0 re-fold reproduces byte-identical jobs.monitors", () => {
  // Seed a mixed-provenance projection.
  insertEvent({ hook_event: "SessionStart" });
  insertMonitorLaunch("bash-m");
  insertBashBgLaunch("bash-b");
  insertStopWithTasks([
    { id: "bash-amb", type: "shell" },
    { id: "bash-b", type: "shell" },
    { id: "bash-m", type: "shell" },
  ]);
  drainAll();
  const before = db
    .query("SELECT job_id, monitors FROM jobs ORDER BY job_id ASC")
    .all() as { job_id: string; monitors: string }[];
  expect(before.length).toBeGreaterThan(0);
  // Rewind + wipe; re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db
    .query("SELECT job_id, monitors FROM jobs ORDER BY job_id ASC")
    .all() as { job_id: string; monitors: string }[];
  expect(after).toEqual(before);
});

test("v51 monitors: stable sort by id (re-fold determinism)", () => {
  insertEvent({ hook_event: "SessionStart" });
  // Insertion order in the snapshot is c, a, b — projected sort must be a, b, c.
  insertStopWithTasks([
    { id: "bash-c", type: "shell" },
    { id: "bash-a", type: "shell" },
    { id: "bash-b", type: "shell" },
  ]);
  drainAll();
  expect(getMonitors()).toEqual([
    mon("bash-a", "ambient"),
    mon("bash-b", "ambient"),
    mon("bash-c", "ambient"),
  ]);
});

test("v51 monitors: a launch AFTER this Stop is NOT seen (id < current gate)", () => {
  // The in-fold scan reads `id < event.id` strictly, so a launch that
  // arrives after the current Stop must NOT participate in provenance —
  // this guards against any future re-fold seeing the wrong order.
  insertEvent({ hook_event: "SessionStart" });
  insertStopWithTasks([{ id: "bash-late", type: "shell" }]);
  insertMonitorLaunch("bash-late"); // arrives AFTER the Stop
  drainAll();
  // Provenance for the Stop is `ambient` — the launch came later.
  expect(getMonitors()).toEqual([mon("bash-late", "ambient")]);
});

// ---------------------------------------------------------------------------
// Schema v59 (fn-719 task 1): has_live_worker_monitor occupancy fact on the
// embedded epics.tasks[].jobs[] element. Derived from jobs.monitors
// (provenance-filtered: monitor/bash-bg occupy, ambient never does), stamped
// at the Stop fold's monitors-write site, preserved across job-tick re-syncs
// via the buildEmbeddedJob carve-out, cleared to false on terminal.
// ---------------------------------------------------------------------------

/**
 * Read the embedded job element's `has_live_worker_monitor` for a (taskId,
 * jobId) pair, or `undefined` when the task / job is missing.
 */
function getEmbeddedMonitorFact(
  taskId: string,
  jobId: string,
): boolean | undefined {
  const task = getTask(taskId);
  if (task == null || !Array.isArray(task.jobs)) {
    return undefined;
  }
  const j = (task.jobs as { job_id: string }[]).find((j) => j.job_id === jobId);
  return (j as { has_live_worker_monitor?: boolean } | undefined)
    ?.has_live_worker_monitor;
}

/**
 * Insert one Stop event whose `data.background_tasks` carries the given
 * entries, scoped to a work session bound to a task (`session_id` defaults to
 * TEST_UUID so it matches the `work::` spawn-name binding the test seeds).
 */
function insertStopWithTasksFor(
  tasks: { id: string; type: string }[],
  sessionId = TEST_UUID,
): number {
  return insertEvent({
    hook_event: "Stop",
    session_id: sessionId,
    data: JSON.stringify({ background_tasks: tasks }),
  });
}

test("v59 monitor fact: a bash-bg monitor on a stopped work job sets has_live_worker_monitor=true on the embedded element", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.1",
  });
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.1", TEST_UUID)).toBe(false);

  // A backgrounded Bash launch precedes the Stop → provenance `bash-bg`.
  insertBashBgLaunch("suite-1", TEST_UUID);
  insertStopWithTasksFor([{ id: "suite-1", type: "shell" }]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.1", TEST_UUID)).toBe(true);
});

test("v59 monitor fact: a Monitor-kind entry also occupies (kind=monitor → true)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.2",
  });
  drainAll();
  insertMonitorLaunch("mon-1", TEST_UUID);
  insertStopWithTasksFor([{ id: "mon-1", type: "shell" }]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.2", TEST_UUID)).toBe(true);
});

test("v59 monitor fact: an ambient-only job NEVER occupies (has_live_worker_monitor stays false)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.3",
  });
  drainAll();
  // No launch event → provenance `ambient` (the plugin-armed chatctl bus
  // shape). The embedded occupancy fact must stay false.
  insertStopWithTasksFor([{ id: "amb-1", type: "shell" }]);
  drainAll();
  // The top-level monitors column DID record the ambient entry...
  expect(getMonitors(TEST_UUID)).toEqual([mon("amb-1", "ambient")]);
  // ...but the embedded occupancy fact is false (ambient never occupies).
  expect(getEmbeddedMonitorFact("fn-1-foo.3", TEST_UUID)).toBe(false);
});

test("v59 monitor fact: a mixed ambient+bash-bg snapshot still occupies (any worker monitor → true)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.4",
  });
  drainAll();
  insertBashBgLaunch("suite-mix", TEST_UUID);
  insertStopWithTasksFor([
    { id: "amb-mix", type: "shell" },
    { id: "suite-mix", type: "shell" },
  ]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.4", TEST_UUID)).toBe(true);
});

test("v59 monitor fact: a later Stop dropping the worker monitor flips it back to false", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.5",
  });
  drainAll();
  insertBashBgLaunch("suite-drop", TEST_UUID);
  insertStopWithTasksFor([{ id: "suite-drop", type: "shell" }]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.5", TEST_UUID)).toBe(true);
  // The suite finished — the next Stop's snapshot drops it (drop-when-dead).
  insertStopWithTasksFor([]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.5", TEST_UUID)).toBe(false);
});

test("v59 monitor fact: SessionEnd (terminal) forces has_live_worker_monitor=false even with a stale live monitor", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.6",
  });
  drainAll();
  insertBashBgLaunch("suite-end", TEST_UUID);
  insertStopWithTasksFor([{ id: "suite-end", type: "shell" }]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.6", TEST_UUID)).toBe(true);
  // Terminal write clears jobs.monitors to '[]'; the embedded fact must
  // resolve to false (the carve-out would otherwise preserve a stale true).
  insertEvent({ hook_event: "SessionEnd", session_id: TEST_UUID });
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.6", TEST_UUID)).toBe(false);
});

test("v59 monitor fact: Killed (terminal) forces has_live_worker_monitor=false even with a stale live monitor", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.7",
    pid: 5151,
    start_time: "stamp-k",
  });
  drainAll();
  insertBashBgLaunch("suite-kill", TEST_UUID);
  insertStopWithTasksFor([{ id: "suite-kill", type: "shell" }]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.7", TEST_UUID)).toBe(true);
  killedEvent(5151, "stamp-k", TEST_UUID);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.7", TEST_UUID)).toBe(false);
});

test("v59 monitor fact: clobber guard — a later syncJobIntoEpic re-sync PRESERVES has_live_worker_monitor", () => {
  // The headline-risk test (mirrors the fn-670 T2 clobber-guard test). Stamp
  // the fact via the Stop fold, then drive a jobs-row re-sync via
  // UserPromptSubmit (flips state → working AND fires syncJobIntoEpic) and
  // assert the fact survives. Without the buildEmbeddedJob carve-out, the
  // jobs-row re-emit would clobber it back to the false default.
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.8",
  });
  drainAll();
  insertBashBgLaunch("suite-clob", TEST_UUID);
  insertStopWithTasksFor([{ id: "suite-clob", type: "shell" }]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.8", TEST_UUID)).toBe(true);

  // Drive a jobs-row re-sync (flips state → working AND fires syncJobIntoEpic).
  insertEvent({ hook_event: "UserPromptSubmit", session_id: TEST_UUID });
  drainAll();

  const after = getEmbeddedTaskJob("fn-1-foo.8", TEST_UUID);
  expect(after?.state).toBe("working"); // proves the re-sync path fired
  // The fact survived the clobber.
  expect(getEmbeddedMonitorFact("fn-1-foo.8", TEST_UUID)).toBe(true);
});

test("v59 monitor fact: a planner session (kind=epic) never carries the occupancy fact", () => {
  // A close/plan session binds to an epic, not a task — it holds no working
  // tree, so its embedded epic-side job stays at the false default.
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "close::fn-1-foo",
  });
  drainAll();
  insertBashBgLaunch("suite-epic", TEST_UUID);
  insertStopWithTasksFor([{ id: "suite-epic", type: "shell" }]);
  drainAll();
  // The epic-side embedded job exists, but the per-task stamp helper skips
  // kind=epic, so the field stays at the carve-out false default.
  const row = db
    .query("SELECT jobs FROM epics WHERE epic_id = ?")
    .get("fn-1-foo") as { jobs: string } | null;
  const jobs = JSON.parse(row?.jobs ?? "[]") as {
    job_id: string;
    has_live_worker_monitor?: boolean;
  }[];
  const j = jobs.find((j) => j.job_id === TEST_UUID);
  expect(j).not.toBeUndefined();
  expect(j?.has_live_worker_monitor).toBe(false);
});

test("v59 monitor fact: cursor=0 re-fold reproduces byte-identical epics rows (fact converges)", () => {
  // Re-fold determinism: the embedded fact is a pure function of the event
  // log (derived from the event-derived jobs.monitors snapshot), so a
  // from-scratch re-fold (rewind cursor, wipe projections, re-drain)
  // reproduces byte-identical epics rows — the same convergence a
  // hypothetical rewind-and-redrain backfill would yield, proven WITHOUT
  // the migration needing to force one (v59 is fix-forward).
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.9",
  });
  insertBashBgLaunch("suite-refold", TEST_UUID);
  insertStopWithTasksFor([{ id: "suite-refold", type: "shell" }]);
  drainAll();
  expect(getEmbeddedMonitorFact("fn-1-foo.9", TEST_UUID)).toBe(true);

  const before = db
    .query("SELECT epic_id, tasks, jobs FROM epics ORDER BY epic_id ASC")
    .all() as { epic_id: string; tasks: string; jobs: string }[];
  expect(before.length).toBeGreaterThan(0);

  // Rewind + wipe the rewind-list projections; re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM subagent_invocations");
  db.run("DELETE FROM epic_tombstones");
  drainAll();

  const after = db
    .query("SELECT epic_id, tasks, jobs FROM epics ORDER BY epic_id ASC")
    .all() as { epic_id: string; tasks: string; jobs: string }[];
  expect(after).toEqual(before);
  // And the fact is still true after the re-fold.
  expect(getEmbeddedMonitorFact("fn-1-foo.9", TEST_UUID)).toBe(true);
});

test("v59 monitor fact: refreshes the embedded element EVEN when the sub-agent guard swallows the state flip", () => {
  // The keystone for the dedicated write site: the monitors snapshot-replace
  // is hoisted ABOVE the sub-agent guard, so a mid-Task-yield Stop refreshes
  // jobs.monitors but SKIPS the state='stopped' UPDATE + its syncIfPlanRef
  // fan-out. The explicit stampEmbeddedMonitorFact call must still update the
  // embedded occupancy fact in that swallow case.
  insertEvent({
    hook_event: "SessionStart",
    session_id: TEST_UUID,
    spawn_name: "work::fn-1-foo.10",
  });
  // Drive the job to `working` so the guard has a non-stopped state to
  // PROTECT (a SessionStart alone lands the job at `stopped`).
  insertEvent({ hook_event: "UserPromptSubmit", session_id: TEST_UUID });
  drainAll();
  expect(getEmbeddedTaskJob("fn-1-foo.10", TEST_UUID)?.state).toBe("working");
  // Inject a still-running subagent_invocations row so the guard fires.
  const subTs = tsCounter++;
  db.run(
    `INSERT INTO subagent_invocations (job_id, agent_id, turn_seq,
      subagent_type, status, ts, last_event_id, updated_at)
     VALUES (?, 'sub-g', 1, 'general', 'running', ?, ?, ?)`,
    [TEST_UUID, subTs, getCursor(), subTs],
  );
  // A Stop carrying a live bash-bg monitor. The state flip is swallowed by
  // the sub-agent guard (state stays `working`), but the embedded occupancy
  // fact must still update — proving the dedicated stamp site, not
  // syncIfPlanRef (which the guard skips), keeps the fact honest.
  insertBashBgLaunch("suite-guard", TEST_UUID);
  insertStopWithTasksFor([{ id: "suite-guard", type: "shell" }]);
  drainAll();
  // State NOT flipped to stopped (guard swallowed the flip)...
  expect(getEmbeddedTaskJob("fn-1-foo.10", TEST_UUID)?.state).toBe("working");
  // ...but the occupancy fact IS honest.
  expect(getEmbeddedMonitorFact("fn-1-foo.10", TEST_UUID)).toBe(true);
});

// ---------------------------------------------------------------------------
// fn-717.1 — cold-blob relocation (event_blobs) read plumbing
// ---------------------------------------------------------------------------

// Snapshot the three projections a `data`-blob read feeds: file_attributions
// + git_status (drain SELECT + file-attribution scan) and the jobs.epic_links
// / epics.job_links cells (the commit-trailer reads). Returned as plain JSON
// rows so an `expect(...).toEqual(...)` is a byte-for-byte diff.
function snapshotBlobDrivenProjections() {
  return {
    attributions: db
      .query(
        "SELECT project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source, last_event_id, updated_at, worktree_oid, worktree_mode FROM file_attributions ORDER BY project_dir, session_id, file_path",
      )
      .all(),
    gitStatus: db.query("SELECT * FROM git_status ORDER BY project_dir").all(),
    jobLinks: db
      .query("SELECT job_id, epic_links FROM jobs ORDER BY job_id")
      .all(),
    epicLinks: db
      .query("SELECT epic_id, job_links FROM epics ORDER BY epic_id")
      .all(),
  };
}

// Seed one mixed stream exercising EVERY rewritten `data`-blob read site:
// PostToolUse mutations (drain SELECT + file-attribution scan), a GitSnapshot
// + Commit pair that discharges the attribution (drain SELECT), and a
// `chore(planctl)` Commit carrying planctl trailers (loadCommitTrailer{
// Invocations,SessionsForEpics}). Returns the discharged PostToolUse event id
// so a test can relocate its now-cold blob.
function seedBlobReadStream(): { dischargedPostToolUseId: number } {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  const dischargedPostToolUseId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/cold.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 150,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "cold.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: null,
          worktree_mode: null,
        },
      ],
    }),
  });
  // Legacy-shape Commit (NULL-axis fall-back) discharges cold.ts — its
  // PostToolUse attribution goes cold, the realistic relocation candidate.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["cold.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  // A `chore(planctl)` Commit carrying the fn-695 trailer facts so the
  // commit-trailer reads (loadCommitTrailer*) have a row to resolve.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 210,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID_2,
      parent_oid: TEST_OID,
      files: [],
      committer_session_id: TEST_UUID,
      committed_at_ms: 210_000,
      planctl_op: "create",
      planctl_target: "fn-1-demo",
      session_id_trailer: TEST_UUID,
    }),
  });
  return { dischargedPostToolUseId };
}

test("fn-717.1 empty event_blobs: cursor=0 re-fold is byte-identical (lossless foundation)", () => {
  // The provably-lossless foundation: with event_blobs EMPTY, every
  // COALESCE(events.data, event_blobs.data) returns the inline value
  // (COALESCE(data, NULL) = data), so a from-scratch re-fold reproduces
  // byte-identical projections — behavior is unchanged from pre-v57.
  seedBlobReadStream();
  drainAll();
  const live = snapshotBlobDrivenProjections();

  // event_blobs must be empty in task .1 (no compaction yet).
  const blobCount = db.query("SELECT COUNT(*) AS n FROM event_blobs").get() as {
    n: number;
  };
  expect(blobCount.n).toBe(0);

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  expect(snapshotBlobDrivenProjections()).toEqual(live);
});

test("fn-717.2 events.data is now nullable — the compaction relocator can NULL the hot column", () => {
  // Task .1 PINNED `events.data NOT NULL`; task .2 RELAXES it (the v57→v58
  // stop-the-world rebuild in `migrate()`) so the compaction relocator can
  // `UPDATE events SET data = NULL` after copying the cold blob into
  // `event_blobs`. This test flips the .1 pin: the relocation's two steps —
  // copy into the side table, then NULL the hot column — both succeed now.
  const { dischargedPostToolUseId } = seedBlobReadStream();
  drainAll();
  // Step 1: copy the cold blob into event_blobs (the side-table NOT NULL is
  // satisfied by the real bytes).
  db.run(
    "INSERT INTO event_blobs (event_id, data) SELECT id, data FROM events WHERE id = ?",
    [dischargedPostToolUseId],
  );
  // Step 2: NULL the hot column — REJECTED in .1, now ACCEPTED under the
  // relaxed v58 schema.
  expect(() =>
    db.run("UPDATE events SET data = NULL WHERE id = ?", [
      dischargedPostToolUseId,
    ]),
  ).not.toThrow();
  const row = db
    .query("SELECT data FROM events WHERE id = ?")
    .get(dischargedPostToolUseId) as { data: string | null };
  expect(row.data).toBeNull();
});

test("fn-717.1 relocated blob (event_blobs): COALESCE drain read resolves the side-table value losslessly", () => {
  // Prove the rewritten read plumbing is lossless ACROSS relocation — the
  // property task .2's compaction relies on — WITHOUT depending on a NULLable
  // `events.data` (still NOT NULL in .1). Fold the stream inline, snapshot,
  // then build the post-relocation read shape on a scratch table whose
  // `data` IS nullable (the .2 schema shape) and assert the EXACT drain
  // COALESCE expression resolves the blob from `event_blobs` when the hot
  // column is NULL, byte-for-byte equal to the inline value.
  const { dischargedPostToolUseId } = seedBlobReadStream();
  drainAll();
  const inlineValue = db
    .query("SELECT data FROM events WHERE id = ?")
    .get(dischargedPostToolUseId) as { data: string };

  // Relocate the cold blob into the side table (the .2 INSERT step, which IS
  // allowed in .1 — only the subsequent hot-column NULL is gated).
  db.run(
    "INSERT INTO event_blobs (event_id, data) SELECT id, data FROM events WHERE id = ?",
    [dischargedPostToolUseId],
  );

  // .2 schema preview: a nullable-`data` events shape so we can NULL the hot
  // column and observe the COALESCE fall through to event_blobs. Mirrors the
  // exact LEFT JOIN + COALESCE the drain SELECT uses.
  db.run(
    "CREATE TABLE events_nullable (id INTEGER PRIMARY KEY, data TEXT, hook_event TEXT)",
  );
  db.run(
    "INSERT INTO events_nullable (id, data, hook_event) SELECT id, NULL, hook_event FROM events WHERE id = ?",
    [dischargedPostToolUseId],
  );
  const resolved = db
    .query(
      `SELECT COALESCE(events_nullable.data, event_blobs.data) AS data
         FROM events_nullable
         LEFT JOIN event_blobs ON event_blobs.event_id = events_nullable.id
        WHERE events_nullable.id = ?`,
    )
    .get(dischargedPostToolUseId) as { data: string };

  // The relocated value is recovered byte-for-byte from the side table.
  expect(resolved.data).toBe(inlineValue.data);
  expect(resolved.data).toBe(
    JSON.stringify({ tool_input: { file_path: "/repo/cold.ts" } }),
  );
});

test("fn-717.1 idx_events_tool_attr still serves the file-attribution scan (EXPLAIN-verified)", () => {
  // The file-attribution scan's WHERE filter STAYS on events.data (NOT
  // COALESCE), so the expression index idx_events_tool_attr keeps serving it
  // as a SEARCH (sub-ms SEEK), never a full table SCAN. EXPLAIN QUERY PLAN
  // must name the index — proving the .2 seam is documented, not broken.
  const plan = db
    .query(
      `EXPLAIN QUERY PLAN
         SELECT id, ts, session_id, tool_name
           FROM events
          WHERE hook_event = 'PostToolUse'
            AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
            AND json_extract(data, '$.tool_input.file_path') = ?`,
    )
    .all("/repo/cold.ts") as { detail: string }[];
  const details = plan.map((r) => r.detail);
  const joined = details.join("\n");
  // The index is named (a SEARCH/SEEK, not a full scan).
  expect(joined).toContain("idx_events_tool_attr");
  // No plan line is a bare full SCAN of the events table (a covered SEARCH
  // line reads "SEARCH events USING ... idx_events_tool_attr").
  expect(details.some((d) => /^SCAN events\b/.test(d.trim()))).toBe(false);
});

// ---------------------------------------------------------------------------
// Schema v64 (fn-781 task .1) — `builds` reducer projection. The server-side
// builds-worker mints `BuildSnapshot` (UPSERT) / `BuildDeleted` (tombstone)
// synthetic events from the buildbot REST API; they fold purely (no
// `Date.now`, no liveness re-probe) into the `builds` table keyed by builder
// NAME (`event.session_id`). `updated_at` is the event `ts`. A from-scratch
// re-fold (rewind cursor, DELETE FROM builds, re-drain) MUST reproduce the
// table byte-identically.
// ---------------------------------------------------------------------------

const RUNNING_BUILD: BuildSnapshotPayload = {
  builder_id: 7,
  build_number: 42,
  complete: 0,
  results: null,
  state_string: "building",
  started_at: 1_700_000_000,
  complete_at: null,
};

const FINISHED_BUILD: BuildSnapshotPayload = {
  builder_id: 7,
  build_number: 42,
  complete: 1,
  results: 0,
  state_string: "build successful",
  started_at: 1_700_000_000,
  complete_at: 1_700_000_300,
};

function buildSnapshotEvent(
  project: string,
  payload: BuildSnapshotPayload,
): number {
  return insertEvent({
    hook_event: "BuildSnapshot",
    session_id: project,
    data: serializeBuildSnapshot(payload),
  });
}

function buildDeletedEvent(project: string): number {
  return insertEvent({
    hook_event: "BuildDeleted",
    session_id: project,
  });
}

function getBuild(project: string) {
  return db.query("SELECT * FROM builds WHERE project = ?").get(project) as {
    project: string;
    builder_id: number | null;
    build_number: number | null;
    complete: number | null;
    results: number | null;
    state_string: string | null;
    started_at: number | null;
    complete_at: number | null;
    last_event_id: number;
    updated_at: number;
  } | null;
}

test("serializeBuildSnapshot → extractBuildSnapshot round-trips every payload field", () => {
  // fn-651 contract pin: each projection-meaningful field must survive
  // serializer → event.data → extractor identically, or it folds NULL forever.
  const eventId = buildSnapshotEvent("acme-ci", FINISHED_BUILD);
  const ev = db
    .query("SELECT * FROM events WHERE id = ?")
    .get(eventId) as Event;
  expect(extractBuildSnapshot(ev)).toEqual(FINISHED_BUILD);

  // Running shape (results / complete_at NULL) round-trips too.
  const runId = buildSnapshotEvent("acme-ci", RUNNING_BUILD);
  const runEv = db
    .query("SELECT * FROM events WHERE id = ?")
    .get(runId) as Event;
  expect(extractBuildSnapshot(runEv)).toEqual(RUNNING_BUILD);
});

test("extractBuildSnapshot folds malformed / empty / partial blobs null-safely", () => {
  // Empty + malformed data → null (the fold no-ops, never throws).
  const emptyEv = { id: 1, ts: 1, session_id: "x", data: "" } as Event;
  expect(extractBuildSnapshot(emptyEv)).toBeNull();
  const badEv = { id: 1, ts: 1, session_id: "x", data: "{not json" } as Event;
  expect(extractBuildSnapshot(badEv)).toBeNull();
  // A partial blob folds the absent fields to null rather than poisoning.
  const partialEv = {
    id: 1,
    ts: 1,
    session_id: "x",
    data: JSON.stringify({ build_number: 9 }),
  } as Event;
  expect(extractBuildSnapshot(partialEv)).toEqual({
    builder_id: null,
    build_number: 9,
    complete: null,
    results: null,
    state_string: null,
    started_at: null,
    complete_at: null,
  });
});

test("BuildSnapshot UPSERTs a running builds row keyed by builder name and advances the cursor", () => {
  const eventId = buildSnapshotEvent("acme-ci", RUNNING_BUILD);
  expect(drainAll()).toBe(1);
  const row = getBuild("acme-ci");
  expect(row).not.toBeNull();
  expect(row?.project).toBe("acme-ci");
  expect(row?.builder_id).toBe(7);
  expect(row?.build_number).toBe(42);
  expect(row?.complete).toBe(0);
  // Running build → results NULL, complete_at NULL.
  expect(row?.results).toBeNull();
  expect(row?.complete_at).toBeNull();
  expect(row?.state_string).toBe("building");
  expect(row?.started_at).toBe(1_700_000_000);
  expect(row?.last_event_id).toBe(eventId);
  // updated_at is the event ts (never a wall-clock read).
  const eventTs = (
    db.query("SELECT ts FROM events WHERE id = ?").get(eventId) as {
      ts: number;
    }
  ).ts;
  expect(row?.updated_at).toBe(eventTs);
  expect(getCursor()).toBe(eventId);
});

test("a build emits exactly two folds (start, finish): the finished BuildSnapshot UPSERTs the same row", () => {
  buildSnapshotEvent("acme-ci", RUNNING_BUILD);
  const finishId = buildSnapshotEvent("acme-ci", FINISHED_BUILD);
  expect(drainAll()).toBe(2);
  // Still ONE row (UPSERT keyed on builder NAME, not build number).
  const count = db
    .query("SELECT COUNT(*) AS n FROM builds WHERE project = 'acme-ci'")
    .get() as { n: number };
  expect(count.n).toBe(1);
  const row = getBuild("acme-ci");
  expect(row?.complete).toBe(1);
  expect(row?.results).toBe(0);
  expect(row?.state_string).toBe("build successful");
  expect(row?.complete_at).toBe(1_700_000_300);
  expect(row?.last_event_id).toBe(finishId);
});

test("BuildDeleted tombstones the builds row keyed by the same builder name", () => {
  buildSnapshotEvent("acme-ci", FINISHED_BUILD);
  drainAll();
  expect(getBuild("acme-ci")).not.toBeNull();
  const delId = buildDeletedEvent("acme-ci");
  expect(drainAll()).toBe(1);
  expect(getBuild("acme-ci")).toBeNull();
  // The tombstone still advanced the cursor.
  expect(getCursor()).toBe(delId);
});

test("a malformed BuildSnapshot blob no-ops with the cursor still advanced", () => {
  const eventId = insertEvent({
    hook_event: "BuildSnapshot",
    session_id: "acme-ci",
    data: "{ not valid json",
  });
  expect(drainAll()).toBe(1);
  // No row written, but the cursor advanced past the malformed event.
  expect(getBuild("acme-ci")).toBeNull();
  expect(getCursor()).toBe(eventId);
});

test("a BuildSnapshot with an empty builder name no-ops with the cursor advanced", () => {
  const eventId = insertEvent({
    hook_event: "BuildSnapshot",
    session_id: "",
    data: serializeBuildSnapshot(FINISHED_BUILD),
  });
  expect(drainAll()).toBe(1);
  const count = db.query("SELECT COUNT(*) AS n FROM builds").get() as {
    n: number;
  };
  expect(count.n).toBe(0);
  expect(getCursor()).toBe(eventId);
});

test("builds is re-fold deterministic: rewind + DELETE + re-drain reproduces it byte-for-byte", () => {
  buildSnapshotEvent("acme-ci", RUNNING_BUILD);
  buildSnapshotEvent("acme-ci", FINISHED_BUILD);
  buildSnapshotEvent("widget-build", RUNNING_BUILD);
  buildDeletedEvent("widget-build");
  buildSnapshotEvent("gizmo-build", FINISHED_BUILD);
  drainAll();

  const before = db
    .query("SELECT * FROM builds ORDER BY project")
    .all() as unknown[];
  // acme-ci finished + gizmo-build finished survive; widget-build tombstoned.
  expect(before.length).toBe(2);

  // Rewind cursor + wipe the projection + re-drain on the same connection. The
  // re-folded rows must equal the pre-rewind rows byte-for-byte (pure function
  // of the event log; updated_at derives from event.ts, no wall-clock).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM builds");
  drainAll();
  const after = db
    .query("SELECT * FROM builds ORDER BY project")
    .all() as unknown[];
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v68 (fn-813): scheduled_tasks projection from CronCreate/CronDelete
// ---------------------------------------------------------------------------

interface ScheduledTaskRow {
  job_id: string;
  cron_id: string;
  cron: string;
  human_schedule: string;
  recurring: number;
  durable: number;
  prompt_summary: string;
  status: string;
  ts: number;
  last_event_id: number;
  updated_at: number;
}

/** Insert a CronCreate PostToolUse event with the live payload shape. */
function cronCreateEvent(
  cronId: string,
  opts: {
    session_id?: string;
    cron?: string;
    humanSchedule?: string;
    recurring?: boolean;
    durable?: boolean;
    prompt?: string;
    hook_event?: string;
  } = {},
): number {
  return insertEvent({
    hook_event: opts.hook_event ?? "PostToolUse",
    session_id: opts.session_id ?? "sess-cron",
    tool_name: "CronCreate",
    data: JSON.stringify({
      tool_input: { cron: opts.cron ?? "0 * * * *", prompt: opts.prompt ?? "" },
      tool_response: {
        id: cronId,
        humanSchedule: opts.humanSchedule ?? "Every hour",
        recurring: opts.recurring ?? true,
        durable: opts.durable ?? false,
      },
    }),
  });
}

/** Insert a CronDelete PostToolUse event with the live payload shape. */
function cronDeleteEvent(
  cronId: string,
  opts: { session_id?: string; hook_event?: string } = {},
): number {
  return insertEvent({
    hook_event: opts.hook_event ?? "PostToolUse",
    session_id: opts.session_id ?? "sess-cron",
    tool_name: "CronDelete",
    data: JSON.stringify({
      tool_input: { id: cronId },
      tool_response: { id: cronId },
    }),
  });
}

function getScheduledTask(
  jobId = "sess-cron",
  cronId = "cron-1",
): ScheduledTaskRow | null {
  return db
    .query("SELECT * FROM scheduled_tasks WHERE job_id = ? AND cron_id = ?")
    .get(jobId, cronId) as ScheduledTaskRow | null;
}

test("CronCreate folds to an active scheduled_tasks row with the payload fields", () => {
  const id = cronCreateEvent("cron-1", {
    cron: "23 * * * *",
    humanSchedule: "Every hour at :23",
    recurring: true,
    durable: false,
    prompt: "Watch the deploy\nand report back",
  });
  drainAll();
  const row = getScheduledTask();
  expect(row).not.toBeNull();
  expect(row?.status).toBe("active");
  expect(row?.cron).toBe("23 * * * *");
  expect(row?.human_schedule).toBe("Every hour at :23");
  expect(row?.recurring).toBe(1);
  expect(row?.durable).toBe(0);
  // prompt_summary is the FIRST line only, not the whole multi-line prompt.
  expect(row?.prompt_summary).toBe("Watch the deploy");
  expect(row?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("CronCreate prompt_summary truncates the first line deterministically at 200 chars", () => {
  const longLine = "x".repeat(300);
  cronCreateEvent("cron-long", { prompt: `${longLine}\nsecond line` });
  drainAll();
  const row = getScheduledTask("sess-cron", "cron-long");
  expect(row?.prompt_summary.length).toBe(200);
  expect(row?.prompt_summary).toBe("x".repeat(200));
});

test("recurring/durable JSON booleans lift to INTEGER 0/1", () => {
  cronCreateEvent("cron-rd", { recurring: false, durable: true });
  drainAll();
  const row = getScheduledTask("sess-cron", "cron-rd");
  expect(row?.recurring).toBe(0);
  expect(row?.durable).toBe(1);
});

test("CronDelete flips the matching scheduled_tasks row to deleted", () => {
  cronCreateEvent("cron-1");
  const delId = cronDeleteEvent("cron-1");
  drainAll();
  const row = getScheduledTask();
  expect(row?.status).toBe("deleted");
  expect(row?.last_event_id).toBe(delId);
});

test("CronDelete without a matching create is a no-op with the cursor advancing", () => {
  const delId = cronDeleteEvent("ghost-cron");
  expect(drainAll()).toBe(1);
  expect(getScheduledTask("sess-cron", "ghost-cron")).toBeNull();
  expect(getCursor()).toBe(delId);
});

test("CronCreate after CronDelete resurrects the cron id to active (upsert)", () => {
  cronCreateEvent("cron-1", { humanSchedule: "Every hour" });
  cronDeleteEvent("cron-1");
  const reId = cronCreateEvent("cron-1", { humanSchedule: "Every 2 hours" });
  drainAll();
  const row = getScheduledTask();
  expect(row?.status).toBe("active");
  // Resurrection upserts the new payload, not the stale create.
  expect(row?.human_schedule).toBe("Every 2 hours");
  expect(row?.last_event_id).toBe(reId);
});

test("CronCreate with a missing tool_response.id folds to a no-op (cursor advances)", () => {
  const eventId = insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-cron",
    tool_name: "CronCreate",
    data: JSON.stringify({
      tool_input: { cron: "0 * * * *", prompt: "x" },
      tool_response: { humanSchedule: "Every hour" },
    }),
  });
  expect(drainAll()).toBe(1);
  const count = db.query("SELECT COUNT(*) AS n FROM scheduled_tasks").get() as {
    n: number;
  };
  expect(count.n).toBe(0);
  expect(getCursor()).toBe(eventId);
});

test("CronCreate with malformed JSON data folds to a no-op (no throw, cursor advances)", () => {
  const eventId = insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-cron",
    tool_name: "CronCreate",
    data: "{not valid json",
  });
  expect(drainAll()).toBe(1);
  const count = db.query("SELECT COUNT(*) AS n FROM scheduled_tasks").get() as {
    n: number;
  };
  expect(count.n).toBe(0);
  expect(getCursor()).toBe(eventId);
});

test("PostToolUseFailure on CronCreate never mints a scheduled_tasks row", () => {
  // The failure payload carries no tool_response; even if it did, the
  // PostToolUse-only gate at the dispatch site keeps it out.
  const eventId = insertEvent({
    hook_event: "PostToolUseFailure",
    session_id: "sess-cron",
    tool_name: "CronCreate",
    data: JSON.stringify({ tool_input: { cron: "0 * * * *", prompt: "x" } }),
  });
  expect(drainAll()).toBe(1);
  const count = db.query("SELECT COUNT(*) AS n FROM scheduled_tasks").get() as {
    n: number;
  };
  expect(count.n).toBe(0);
  expect(getCursor()).toBe(eventId);
});

test("scheduled_tasks is re-fold deterministic: rewind + DELETE + re-drain reproduces it byte-for-byte", () => {
  cronCreateEvent("cron-A", { humanSchedule: "Every hour", recurring: true });
  cronCreateEvent("cron-B", {
    session_id: "sess-other",
    humanSchedule: "Daily",
    recurring: true,
  });
  cronDeleteEvent("cron-A");
  cronCreateEvent("cron-A", { humanSchedule: "Every 30 min" });
  cronCreateEvent("cron-C", { recurring: false, durable: true });
  cronDeleteEvent("ghost", { session_id: "sess-cron" });
  drainAll();

  const before = db
    .query("SELECT * FROM scheduled_tasks ORDER BY job_id, cron_id")
    .all() as unknown[];
  expect(before.length).toBe(3);

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM scheduled_tasks");
  drainAll();
  const after = db
    .query("SELECT * FROM scheduled_tasks ORDER BY job_id, cron_id")
    .all() as unknown[];
  expect(after).toEqual(before);
});
