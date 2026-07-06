/**
 * Reducer tests — shard 4 of 4 (fn-769 fast-tier split of the former
 * monolithic reducer.test.ts). Theme: autopilot, dispatch, name-history, plan-file, backend-exec, monitors projections.
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
import { raiseTmuxProjectionFloor } from "../src/db";
import {
  type BuildSnapshotPayload,
  drain,
  extractBuildSnapshot,
  serializeBuildSnapshot,
} from "../src/reducer";
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
    // Schema v73 / fn-836: promoted git-attribution column. Honor an EXPLICIT
    // override (a few tests set it directly); otherwise DERIVE it from `data`
    // via the same pure deriver the live hook + ingester run, so a seeded
    // mutation row carries `mutation_path` exactly as a production row does —
    // the post-flip attribution scan reads the COLUMN, not the JSON body.
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
  // canonical envelope `{tool_response:{stdout:JSON({plan_invocation:
  // {state_repo, files, op, target, ...}})}}` into `data` so the reducer's
  // `extractPlanStateRepo` can lift `state_repo` at fold time. Existing tests
  // pass neither and get the default empty `data: '{}'` (mint no-ops).
  const data =
    args.files != null && args.stateRepo != null
      ? JSON.stringify({
          tool_response: {
            stdout: JSON.stringify({
              plan_invocation: {
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

// ---------------------------------------------------------------------------
// Schema v98 (fn-1009.1) — `MergeEscalationAttempted` folds the escalate-once
// `dispatch_failures.merge_escalated_at` once-marker on a sticky
// `worktree-merge-conflict` CLOSE row. A TERMINAL outcome (`sent` /
// `queued_for_wake`) stamps `merge_escalated_at = event.ts` (gated IS NULL); a
// `send_failed` / unknown outcome leaves it NULL (re-sweepable). The marker
// PERSISTS across a `DispatchFailed` re-UPSERT of an uncleared row and is dropped
// with the row on `DispatchCleared`. Pure fold (event.ts + persisted row only).
// ---------------------------------------------------------------------------

function mergeEscalationEvent(
  id: string,
  outcome: string,
  ts: number,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "MergeEscalationAttempted",
    session_id: sessionId,
    ts,
    data: JSON.stringify({ id, outcome }),
  });
}

function getMergeEscalatedAt(verb: string, id: string): number | null {
  const row = db
    .query(
      "SELECT merge_escalated_at FROM dispatch_failures WHERE verb = ? AND id = ?",
    )
    .get(verb, id) as { merge_escalated_at: number | null } | null;
  return row?.merge_escalated_at ?? null;
}

test("MergeEscalationAttempted stamps merge_escalated_at = event.ts on a terminal outcome (sent / queued_for_wake)", () => {
  dispatchFailedEvent(
    "close",
    "fn-mc-1",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-1")).toBeNull();

  const sentId = mergeEscalationEvent("fn-mc-1", "sent", 1750);
  expect(drainAll()).toBe(1);
  expect(getMergeEscalatedAt("close", "fn-mc-1")).toBe(1750);
  expect(getCursor()).toBe(sentId);

  // `queued_for_wake` (no live subscriber, parked for wake) is also terminal.
  dispatchFailedEvent(
    "close",
    "fn-mc-2",
    "worktree-merge-conflict",
    "/r",
    1760,
  );
  mergeEscalationEvent("fn-mc-2", "queued_for_wake", 1770);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-2")).toBe(1770);
});

test("MergeEscalationAttempted with a send_failed / unknown outcome leaves merge_escalated_at NULL (re-sweepable)", () => {
  dispatchFailedEvent(
    "close",
    "fn-mc-sf",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  mergeEscalationEvent("fn-mc-sf", "send_failed", 1750);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-sf")).toBeNull();

  // An unknown / unexpected outcome is non-terminal too (terminal is a strict
  // allow-list: only a CONFIRMED delivery stamps the once-marker).
  mergeEscalationEvent("fn-mc-sf", "weird_outcome", 1760);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-sf")).toBeNull();

  // A later terminal retry over the same still-uncleared row stamps it.
  mergeEscalationEvent("fn-mc-sf", "sent", 1770);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-sf")).toBe(1770);
});

test("MergeEscalationAttempted on a missing close row is a safe no-op (cursor still advances)", () => {
  const id = mergeEscalationEvent("fn-mc-gone", "sent", 1750);
  expect(drainAll()).toBe(1);
  expect(getDispatchFailure("close", "fn-mc-gone")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("MergeEscalationAttempted only stamps a CLOSE-verb row (a same-id work failure is untouched)", () => {
  // The fold is verb-scoped to `close` — a non-close failure sharing the id must
  // never be marked, so the marker can't bleed across verbs.
  dispatchFailedEvent("work", "fn-mc-verb", "launch_failed", "/r", 1700);
  mergeEscalationEvent("fn-mc-verb", "sent", 1750);
  drainAll();
  expect(getMergeEscalatedAt("work", "fn-mc-verb")).toBeNull();
});

test("a DispatchFailed re-UPSERT of an uncleared close row preserves merge_escalated_at (escalate-once)", () => {
  dispatchFailedEvent(
    "close",
    "fn-mc-pres",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  mergeEscalationEvent("fn-mc-pres", "sent", 1750);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-pres")).toBe(1750);

  // A re-failure of the SAME uncleared close row (later ts, different dir) must
  // NOT reset the escalate-once marker — else the sweep would re-notify.
  dispatchFailedEvent(
    "close",
    "fn-mc-pres",
    "worktree-merge-conflict",
    "/r2",
    1800,
  );
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-pres")).toBe(1750);
});

test("DispatchCleared drops merge_escalated_at with the close row so a fresh conflict re-arms at NULL", () => {
  dispatchFailedEvent(
    "close",
    "fn-mc-clr",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  mergeEscalationEvent("fn-mc-clr", "sent", 1750);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-clr")).toBe(1750);

  dispatchClearedEvent("close", "fn-mc-clr");
  drainAll();
  expect(getDispatchFailure("close", "fn-mc-clr")).toBeNull();

  // A fresh conflict on the same key re-arms the marker at the column default.
  dispatchFailedEvent(
    "close",
    "fn-mc-clr",
    "worktree-merge-conflict",
    "/r",
    1800,
  );
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-clr")).toBeNull();
});

test("MergeEscalationAttempted with a malformed payload is a safe no-op (cursor advances, marker untouched)", () => {
  dispatchFailedEvent(
    "close",
    "fn-mc-mal",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  drainAll();
  const malformed = [
    "{ not json",
    JSON.stringify({ outcome: "sent" }), // missing id
    JSON.stringify({ id: "", outcome: "sent" }), // empty id
    JSON.stringify({ id: "fn-mc-mal" }), // missing outcome
    JSON.stringify({ id: "fn-mc-mal", outcome: "" }), // empty outcome
  ];
  let lastId = 0;
  for (const data of malformed) {
    lastId = insertEvent({
      hook_event: "MergeEscalationAttempted",
      session_id: "reconciler",
      data,
    });
  }
  expect(() => drainAll()).not.toThrow();
  expect(getCursor()).toBe(lastId);
  // No malformed event stamped the marker — it stays NULL.
  expect(getMergeEscalatedAt("close", "fn-mc-mal")).toBeNull();
});

// ---------------------------------------------------------------------------
// Schema v106 (fn-1088.1) — `ResolverDispatchAttempted` folds the dispatch-once
// `dispatch_failures.resolver_dispatched_at` once-marker on a sticky
// `worktree-merge-conflict` CLOSE row. The TERMINAL `dispatched` outcome stamps
// `resolver_dispatched_at = event.ts` (gated IS NULL); a `dispatch_failed` / unknown
// outcome leaves it NULL (re-sweepable). The marker PERSISTS across a `DispatchFailed`
// re-UPSERT of an uncleared row and is dropped with the row on `DispatchCleared`.
// INDEPENDENT of `merge_escalated_at`. Pure fold (event.ts + persisted row only).
// ---------------------------------------------------------------------------

function resolverDispatchEvent(
  id: string,
  outcome: string,
  ts: number,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "ResolverDispatchAttempted",
    session_id: sessionId,
    ts,
    data: JSON.stringify({ id, outcome }),
  });
}

function getResolverDispatchedAt(verb: string, id: string): number | null {
  const row = db
    .query(
      "SELECT resolver_dispatched_at FROM dispatch_failures WHERE verb = ? AND id = ?",
    )
    .get(verb, id) as { resolver_dispatched_at: number | null } | null;
  return row?.resolver_dispatched_at ?? null;
}

test("ResolverDispatchAttempted stamps resolver_dispatched_at = event.ts on the terminal dispatched outcome", () => {
  dispatchFailedEvent(
    "close",
    "fn-rd-1",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-rd-1")).toBeNull();

  const dispatchedId = resolverDispatchEvent("fn-rd-1", "dispatched", 1750);
  expect(drainAll()).toBe(1);
  expect(getResolverDispatchedAt("close", "fn-rd-1")).toBe(1750);
  expect(getCursor()).toBe(dispatchedId);
});

test("ResolverDispatchAttempted with a dispatch_failed / unknown outcome leaves resolver_dispatched_at NULL (re-sweepable)", () => {
  dispatchFailedEvent(
    "close",
    "fn-rd-df",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  resolverDispatchEvent("fn-rd-df", "dispatch_failed", 1750);
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-rd-df")).toBeNull();

  // An unknown / unexpected outcome is non-terminal too (terminal is a strict
  // allow-list: only a CONFIRMED launch stamps the once-marker).
  resolverDispatchEvent("fn-rd-df", "weird_outcome", 1760);
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-rd-df")).toBeNull();

  // A later terminal retry over the same still-uncleared row stamps it.
  resolverDispatchEvent("fn-rd-df", "dispatched", 1770);
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-rd-df")).toBe(1770);
});

test("ResolverDispatchAttempted only stamps a CLOSE-verb row (a same-id work failure is untouched)", () => {
  dispatchFailedEvent("work", "fn-rd-verb", "launch_failed", "/r", 1700);
  resolverDispatchEvent("fn-rd-verb", "dispatched", 1750);
  drainAll();
  expect(getResolverDispatchedAt("work", "fn-rd-verb")).toBeNull();
});

test("ResolverDispatchAttempted on a missing close row is a safe no-op (cursor still advances)", () => {
  const id = resolverDispatchEvent("fn-rd-gone", "dispatched", 1750);
  expect(drainAll()).toBe(1);
  expect(getDispatchFailure("close", "fn-rd-gone")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("resolver_dispatched_at is INDEPENDENT of merge_escalated_at (both latch on the same sticky)", () => {
  dispatchFailedEvent(
    "close",
    "fn-rd-ind",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  // Human escalation stamps merge_escalated_at but NOT resolver_dispatched_at.
  mergeEscalationEvent("fn-rd-ind", "sent", 1750);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-rd-ind")).toBe(1750);
  expect(getResolverDispatchedAt("close", "fn-rd-ind")).toBeNull();

  // Resolver dispatch stamps resolver_dispatched_at but leaves merge_escalated_at.
  resolverDispatchEvent("fn-rd-ind", "dispatched", 1760);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-rd-ind")).toBe(1750);
  expect(getResolverDispatchedAt("close", "fn-rd-ind")).toBe(1760);
});

test("a DispatchFailed re-UPSERT of an uncleared close row preserves resolver_dispatched_at (dispatch-once)", () => {
  dispatchFailedEvent(
    "close",
    "fn-rd-pres",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  resolverDispatchEvent("fn-rd-pres", "dispatched", 1750);
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-rd-pres")).toBe(1750);

  // A re-failure of the SAME uncleared close row must NOT reset the dispatch-once
  // marker — else the resolver sweep would re-dispatch.
  dispatchFailedEvent(
    "close",
    "fn-rd-pres",
    "worktree-merge-conflict",
    "/r2",
    1800,
  );
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-rd-pres")).toBe(1750);
});

test("DispatchCleared drops resolver_dispatched_at with the close row so a fresh conflict re-arms at NULL", () => {
  dispatchFailedEvent(
    "close",
    "fn-rd-clr",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  resolverDispatchEvent("fn-rd-clr", "dispatched", 1750);
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-rd-clr")).toBe(1750);

  dispatchClearedEvent("close", "fn-rd-clr");
  drainAll();
  expect(getDispatchFailure("close", "fn-rd-clr")).toBeNull();

  // A fresh conflict on the same key re-arms the marker at the column default.
  dispatchFailedEvent(
    "close",
    "fn-rd-clr",
    "worktree-merge-conflict",
    "/r",
    1800,
  );
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-rd-clr")).toBeNull();
});

test("ResolverDispatchAttempted with a malformed payload is a safe no-op (cursor advances, marker untouched)", () => {
  dispatchFailedEvent(
    "close",
    "fn-rd-mal",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  drainAll();
  const malformed = [
    "{ not json",
    JSON.stringify({ outcome: "dispatched" }), // missing id
    JSON.stringify({ id: "", outcome: "dispatched" }), // empty id
    JSON.stringify({ id: "fn-rd-mal" }), // missing outcome
    JSON.stringify({ id: "fn-rd-mal", outcome: "" }), // empty outcome
  ];
  let lastId = 0;
  for (const data of malformed) {
    lastId = insertEvent({
      hook_event: "ResolverDispatchAttempted",
      session_id: "reconciler",
      data,
    });
  }
  expect(() => drainAll()).not.toThrow();
  expect(getCursor()).toBe(lastId);
  expect(getResolverDispatchedAt("close", "fn-rd-mal")).toBeNull();
});

test("MergeEscalationAttempted also stamps merge_escalated_at on the terminal dispatched outcome (the deconflict-dispatch marker)", () => {
  // fn-1129.1 repurposes the merge-escalation marker: the sweep now DISPATCHES a
  // deconflict::<epic> session and records `dispatched` (terminal) instead of the
  // old planner@ bus-send `sent`. The fold stamps on `dispatched` too.
  dispatchFailedEvent(
    "close",
    "fn-mc-dsp",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-dsp")).toBeNull();

  const dispatchedId = mergeEscalationEvent("fn-mc-dsp", "dispatched", 1750);
  expect(drainAll()).toBe(1);
  expect(getMergeEscalatedAt("close", "fn-mc-dsp")).toBe(1750);
  expect(getCursor()).toBe(dispatchedId);

  // The launch-failed `dispatch_failed` outcome is NON-terminal — marker stays NULL.
  dispatchFailedEvent(
    "close",
    "fn-mc-dspf",
    "worktree-merge-conflict",
    "/r",
    1760,
  );
  mergeEscalationEvent("fn-mc-dspf", "dispatch_failed", 1770);
  drainAll();
  expect(getMergeEscalatedAt("close", "fn-mc-dspf")).toBeNull();
});

// ---------------------------------------------------------------------------
// Schema v110 (fn-1129.1) — `MergeHumanNotified` folds the terminal human-notify
// once-marker `dispatch_failures.human_notified_at` on a sticky
// `worktree-merge-conflict` CLOSE row — the DECONFLICT path's third stage. The
// TERMINAL `notified` outcome stamps `human_notified_at = event.ts` (gated IS
// NULL); a `notify_failed` / unknown outcome leaves it NULL (re-sweepable). The
// marker PERSISTS across a `DispatchFailed` re-UPSERT of an uncleared row and is
// dropped with the row on `DispatchCleared`. INDEPENDENT of merge_escalated_at /
// resolver_dispatched_at. Pure fold (event.ts + persisted row only).
// ---------------------------------------------------------------------------

function mergeHumanNotifiedEvent(
  id: string,
  outcome: string,
  ts: number,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "MergeHumanNotified",
    session_id: sessionId,
    ts,
    data: JSON.stringify({ id, outcome }),
  });
}

function getHumanNotifiedAt(verb: string, id: string): number | null {
  const row = db
    .query(
      "SELECT human_notified_at FROM dispatch_failures WHERE verb = ? AND id = ?",
    )
    .get(verb, id) as { human_notified_at: number | null } | null;
  return row?.human_notified_at ?? null;
}

test("MergeHumanNotified stamps human_notified_at = event.ts on the terminal notified outcome", () => {
  dispatchFailedEvent(
    "close",
    "fn-hn-1",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  drainAll();
  expect(getHumanNotifiedAt("close", "fn-hn-1")).toBeNull();

  const notifiedId = mergeHumanNotifiedEvent("fn-hn-1", "notified", 1750);
  expect(drainAll()).toBe(1);
  expect(getHumanNotifiedAt("close", "fn-hn-1")).toBe(1750);
  expect(getCursor()).toBe(notifiedId);
});

test("MergeHumanNotified with a notify_failed / unknown outcome leaves human_notified_at NULL (re-sweepable)", () => {
  dispatchFailedEvent(
    "close",
    "fn-hn-nf",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  mergeHumanNotifiedEvent("fn-hn-nf", "notify_failed", 1750);
  drainAll();
  expect(getHumanNotifiedAt("close", "fn-hn-nf")).toBeNull();

  // An unknown / unexpected outcome is non-terminal too (terminal is a strict
  // allow-list: only a CONFIRMED notification stamps the once-marker).
  mergeHumanNotifiedEvent("fn-hn-nf", "weird_outcome", 1760);
  drainAll();
  expect(getHumanNotifiedAt("close", "fn-hn-nf")).toBeNull();

  // A later terminal retry over the same still-uncleared row stamps it.
  mergeHumanNotifiedEvent("fn-hn-nf", "notified", 1770);
  drainAll();
  expect(getHumanNotifiedAt("close", "fn-hn-nf")).toBe(1770);
});

test("MergeHumanNotified only stamps a CLOSE-verb row (a same-id work failure is untouched)", () => {
  dispatchFailedEvent("work", "fn-hn-verb", "launch_failed", "/r", 1700);
  mergeHumanNotifiedEvent("fn-hn-verb", "notified", 1750);
  drainAll();
  expect(getHumanNotifiedAt("work", "fn-hn-verb")).toBeNull();
});

test("MergeHumanNotified on a missing close row is a safe no-op (cursor still advances)", () => {
  const id = mergeHumanNotifiedEvent("fn-hn-gone", "notified", 1750);
  expect(drainAll()).toBe(1);
  expect(getDispatchFailure("close", "fn-hn-gone")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("human_notified_at is INDEPENDENT of merge_escalated_at and resolver_dispatched_at (all three latch on the same sticky)", () => {
  dispatchFailedEvent(
    "close",
    "fn-hn-ind",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  resolverDispatchEvent("fn-hn-ind", "dispatched", 1740);
  mergeEscalationEvent("fn-hn-ind", "dispatched", 1750);
  drainAll();
  expect(getResolverDispatchedAt("close", "fn-hn-ind")).toBe(1740);
  expect(getMergeEscalatedAt("close", "fn-hn-ind")).toBe(1750);
  // The human-notify marker is still its own NULL latch until notified.
  expect(getHumanNotifiedAt("close", "fn-hn-ind")).toBeNull();

  mergeHumanNotifiedEvent("fn-hn-ind", "notified", 1760);
  drainAll();
  // Stamping the human-notify marker leaves the other two untouched.
  expect(getResolverDispatchedAt("close", "fn-hn-ind")).toBe(1740);
  expect(getMergeEscalatedAt("close", "fn-hn-ind")).toBe(1750);
  expect(getHumanNotifiedAt("close", "fn-hn-ind")).toBe(1760);
});

test("a DispatchFailed re-UPSERT of an uncleared close row preserves human_notified_at (notify-once)", () => {
  dispatchFailedEvent(
    "close",
    "fn-hn-pres",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  mergeHumanNotifiedEvent("fn-hn-pres", "notified", 1750);
  drainAll();
  expect(getHumanNotifiedAt("close", "fn-hn-pres")).toBe(1750);

  // A re-failure of the SAME uncleared close row must NOT reset the notify-once
  // marker — else the human-notify sweep would re-notify.
  dispatchFailedEvent(
    "close",
    "fn-hn-pres",
    "worktree-merge-conflict",
    "/r2",
    1800,
  );
  drainAll();
  expect(getHumanNotifiedAt("close", "fn-hn-pres")).toBe(1750);
});

test("DispatchCleared drops human_notified_at with the close row so a fresh conflict re-arms at NULL", () => {
  dispatchFailedEvent(
    "close",
    "fn-hn-clr",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  mergeHumanNotifiedEvent("fn-hn-clr", "notified", 1750);
  drainAll();
  expect(getHumanNotifiedAt("close", "fn-hn-clr")).toBe(1750);

  dispatchClearedEvent("close", "fn-hn-clr");
  drainAll();
  expect(getDispatchFailure("close", "fn-hn-clr")).toBeNull();

  // A fresh conflict on the same key re-arms the marker at the column default.
  dispatchFailedEvent(
    "close",
    "fn-hn-clr",
    "worktree-merge-conflict",
    "/r",
    1800,
  );
  drainAll();
  expect(getHumanNotifiedAt("close", "fn-hn-clr")).toBeNull();
});

test("MergeHumanNotified with a malformed payload is a safe no-op (cursor advances, marker untouched)", () => {
  dispatchFailedEvent(
    "close",
    "fn-hn-mal",
    "worktree-merge-conflict",
    "/r",
    1700,
  );
  drainAll();
  const malformed = [
    "{ not json",
    JSON.stringify({ outcome: "notified" }), // missing id
    JSON.stringify({ id: "", outcome: "notified" }), // empty id
    JSON.stringify({ id: "fn-hn-mal" }), // missing outcome
    JSON.stringify({ id: "fn-hn-mal", outcome: "" }), // empty outcome
  ];
  let lastId = 0;
  for (const data of malformed) {
    lastId = insertEvent({
      hook_event: "MergeHumanNotified",
      session_id: "reconciler",
      data,
    });
  }
  expect(() => drainAll()).not.toThrow();
  expect(getCursor()).toBe(lastId);
  expect(getHumanNotifiedAt("close", "fn-hn-mal")).toBeNull();
});

// ---------------------------------------------------------------------------
// Schema v110 (fn-1129.1) — the `block_escalations` latch gains STAGED escalation-
// dispatch outcomes and the terminal human-notify once-marker (the UNBLOCK path).
// `BlockEscalationAttempted` records a TERMINAL `dispatched` (→ status
// `attempted`) or a NON-TERMINAL `dispatch_failed` (→ status back to `pending`,
// re-sweepable). `BlockHumanNotified`'s terminal `notified` stamps the latch's
// `human_notified_at = event.ts` once-marker; the marker survives a
// BlockEscalationAttempted re-emit and is dropped only when the leave-blocked
// TaskSnapshot DELETE re-arms the whole latch. Latch armed via a TaskSnapshot
// transition into `blocked` (the real arm path; a single blocked snapshot on a
// first-sight task arms `pending`).
// ---------------------------------------------------------------------------

function armBlockLatch(epicId: string, taskId: string, ts?: number): number {
  return taskSnapshotEvent(taskId, {
    epic_id: epicId,
    task_number: 1,
    runtime_status: "blocked",
    ...(ts != null ? { ts } : {}),
  });
}

function unblockTask(
  epicId: string,
  taskId: string,
  runtimeStatus = "todo",
): number {
  return taskSnapshotEvent(taskId, {
    epic_id: epicId,
    task_number: 1,
    runtime_status: runtimeStatus,
  });
}

function blockAttemptedEvent(
  epicId: string,
  taskId: string,
  outcome: string,
  ts: number,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "BlockEscalationAttempted",
    session_id: sessionId,
    ts,
    data: JSON.stringify({ epic_id: epicId, task_id: taskId, outcome }),
  });
}

function blockHumanNotifiedEvent(
  epicId: string,
  taskId: string,
  outcome: string,
  ts: number,
  sessionId = "reconciler",
): number {
  return insertEvent({
    hook_event: "BlockHumanNotified",
    session_id: sessionId,
    ts,
    data: JSON.stringify({ epic_id: epicId, task_id: taskId, outcome }),
  });
}

function getBlockLatch(
  epicId: string,
  taskId: string,
): {
  status: string;
  outcome: string | null;
  human_notified_at: number | null;
} | null {
  return db
    .query(
      "SELECT status, outcome, human_notified_at FROM block_escalations WHERE epic_id = ? AND task_id = ?",
    )
    .get(epicId, taskId) as {
    status: string;
    outcome: string | null;
    human_notified_at: number | null;
  } | null;
}

test("BlockEscalationAttempted with the terminal dispatched outcome advances the latch to attempted", () => {
  armBlockLatch("fn-be-1", "fn-be-1.1");
  drainAll();
  expect(getBlockLatch("fn-be-1", "fn-be-1.1")?.status).toBe("pending");

  blockAttemptedEvent("fn-be-1", "fn-be-1.1", "dispatched", 1800);
  drainAll();
  const latch = getBlockLatch("fn-be-1", "fn-be-1.1");
  expect(latch?.status).toBe("attempted");
  expect(latch?.outcome).toBe("dispatched");
});

test("BlockEscalationAttempted with the non-terminal dispatch_failed outcome resets the latch to pending (re-sweepable)", () => {
  armBlockLatch("fn-be-2", "fn-be-2.1");
  drainAll();

  blockAttemptedEvent("fn-be-2", "fn-be-2.1", "dispatch_failed", 1800);
  drainAll();
  const latch = getBlockLatch("fn-be-2", "fn-be-2.1");
  // status back to pending so selectPendingBlockEscalations re-sweeps it, but the
  // outcome is recorded so the failure is observable.
  expect(latch?.status).toBe("pending");
  expect(latch?.outcome).toBe("dispatch_failed");

  // The bus-send `send_failed` outcome stays non-terminal too (backward compat).
  blockAttemptedEvent("fn-be-2", "fn-be-2.1", "send_failed", 1810);
  drainAll();
  expect(getBlockLatch("fn-be-2", "fn-be-2.1")?.status).toBe("pending");
});

test("BlockHumanNotified stamps the latch human_notified_at on terminal notified; non-terminal leaves it NULL", () => {
  armBlockLatch("fn-be-3", "fn-be-3.1");
  blockAttemptedEvent("fn-be-3", "fn-be-3.1", "dispatched", 1800);
  drainAll();
  expect(getBlockLatch("fn-be-3", "fn-be-3.1")?.human_notified_at).toBeNull();

  // A botctl failure is non-terminal — marker stays NULL, re-sweepable.
  blockHumanNotifiedEvent("fn-be-3", "fn-be-3.1", "notify_failed", 1810);
  drainAll();
  expect(getBlockLatch("fn-be-3", "fn-be-3.1")?.human_notified_at).toBeNull();

  const notifiedId = blockHumanNotifiedEvent(
    "fn-be-3",
    "fn-be-3.1",
    "notified",
    1820,
  );
  drainAll();
  expect(getBlockLatch("fn-be-3", "fn-be-3.1")?.human_notified_at).toBe(1820);
  expect(getCursor()).toBe(notifiedId);
});

test("BlockHumanNotified on a missing latch row is a safe no-op (cursor still advances)", () => {
  const id = blockHumanNotifiedEvent(
    "fn-be-gone",
    "fn-be-gone.1",
    "notified",
    1800,
  );
  expect(drainAll()).toBe(1);
  expect(getBlockLatch("fn-be-gone", "fn-be-gone.1")).toBeNull();
  expect(getCursor()).toBe(id);
});

test("a BlockEscalationAttempted re-emit preserves the latch human_notified_at once-marker (notify-once)", () => {
  armBlockLatch("fn-be-4", "fn-be-4.1");
  blockAttemptedEvent("fn-be-4", "fn-be-4.1", "dispatched", 1800);
  blockHumanNotifiedEvent("fn-be-4", "fn-be-4.1", "notified", 1810);
  drainAll();
  expect(getBlockLatch("fn-be-4", "fn-be-4.1")?.human_notified_at).toBe(1810);

  // A later escalation-dispatch attempt on the still-latched row (e.g. a
  // re-sweep) UPDATEs status/outcome but must NOT reset the human-notify marker.
  blockAttemptedEvent("fn-be-4", "fn-be-4.1", "dispatch_failed", 1820);
  drainAll();
  const latch = getBlockLatch("fn-be-4", "fn-be-4.1");
  expect(latch?.status).toBe("pending");
  expect(latch?.human_notified_at).toBe(1810);
});

test("leaving blocked drops the latch and its human_notified_at, and an unblock→re-block re-arms at NULL", () => {
  armBlockLatch("fn-be-5", "fn-be-5.1");
  blockAttemptedEvent("fn-be-5", "fn-be-5.1", "dispatched", 1800);
  blockHumanNotifiedEvent("fn-be-5", "fn-be-5.1", "notified", 1810);
  drainAll();
  expect(getBlockLatch("fn-be-5", "fn-be-5.1")?.human_notified_at).toBe(1810);

  // Leave blocked: the TaskSnapshot transition DELETEs the whole latch row.
  unblockTask("fn-be-5", "fn-be-5.1", "done");
  drainAll();
  expect(getBlockLatch("fn-be-5", "fn-be-5.1")).toBeNull();

  // Re-block: a fresh latch arms at pending with the once-marker back at NULL.
  armBlockLatch("fn-be-5", "fn-be-5.1");
  drainAll();
  const rearmed = getBlockLatch("fn-be-5", "fn-be-5.1");
  expect(rearmed?.status).toBe("pending");
  expect(rearmed?.human_notified_at).toBeNull();
});

test("BlockHumanNotified with a malformed payload is a safe no-op (cursor advances, marker untouched)", () => {
  armBlockLatch("fn-be-mal", "fn-be-mal.1");
  blockAttemptedEvent("fn-be-mal", "fn-be-mal.1", "dispatched", 1800);
  drainAll();
  const malformed = [
    "{ not json",
    JSON.stringify({ task_id: "fn-be-mal.1", outcome: "notified" }), // missing epic_id
    JSON.stringify({ epic_id: "fn-be-mal", outcome: "notified" }), // missing task_id
    JSON.stringify({ epic_id: "fn-be-mal", task_id: "fn-be-mal.1" }), // missing outcome
    JSON.stringify({
      epic_id: "",
      task_id: "fn-be-mal.1",
      outcome: "notified",
    }), // empty epic_id
  ];
  let lastId = 0;
  for (const data of malformed) {
    lastId = insertEvent({
      hook_event: "BlockHumanNotified",
      session_id: "reconciler",
      data,
    });
  }
  expect(() => drainAll()).not.toThrow();
  expect(getCursor()).toBe(lastId);
  expect(
    getBlockLatch("fn-be-mal", "fn-be-mal.1")?.human_notified_at,
  ).toBeNull();
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

test("DispatchCleared also deletes the pending_dispatches row so an operator clear immediately frees the slot (fn-870)", () => {
  // An operator clear (`keeper autopilot retry`) must free the launch-window slot
  // + per-root mutex immediately, not leave a stale pending until the TTL sweep.
  // Seed a sticky failure + an open pending for the same (verb, id).
  dispatchedEvent("approve", "fn-870-clear.1", "/repo", 1700);
  dispatchFailedEvent(
    "approve",
    "fn-870-clear.1",
    "ceiling-elapsed",
    "/repo",
    1750,
  );
  drainAll();
  // foldDispatchFailed already discharges the pending, so re-arm a fresh pending
  // AFTER the failure to model an operator clearing a key that still has a live
  // pending row alongside the sticky failure (e.g. a re-dispatch after the
  // failure landed). The clear must remove BOTH.
  dispatchedEvent("approve", "fn-870-clear.1", "/repo", 1800);
  drainAll();
  expect(getPendingDispatch("approve", "fn-870-clear.1")).not.toBeNull();
  expect(getDispatchFailure("approve", "fn-870-clear.1")).not.toBeNull();

  dispatchClearedEvent("approve", "fn-870-clear.1");
  drainAll();
  expect(getDispatchFailure("approve", "fn-870-clear.1")).toBeNull();
  expect(getPendingDispatch("approve", "fn-870-clear.1")).toBeNull();
});

test("DispatchCleared on a key with only a pending row (no failure) still deletes the pending — idempotent (fn-870)", () => {
  dispatchedEvent("work", "fn-870-clear-pending-only.1", "/r", 1700);
  drainAll();
  expect(
    getPendingDispatch("work", "fn-870-clear-pending-only.1"),
  ).not.toBeNull();

  // Two clears: the first deletes, the second is a safe no-op (idempotent).
  dispatchClearedEvent("work", "fn-870-clear-pending-only.1");
  dispatchClearedEvent("work", "fn-870-clear-pending-only.1");
  drainAll();
  expect(getPendingDispatch("work", "fn-870-clear-pending-only.1")).toBeNull();
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
  // for any spawn name outside the strict `{plan|work|close}::<ref>`
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

test("discharge-on-bind HEALS a fold-order race: UserPromptSubmit-before-SessionStart binds the pair AND discharges (fn-832)", () => {
  // Fold-ordering race that orphaned autopilot workers: the reconciler mints
  // `Dispatched(work, <ref>)` then launches a worker, but the worker's first
  // `UserPromptSubmit` (carrying a pid, NO spawn_name) folds BEFORE its
  // `SessionStart`. The UserPromptSubmit fork-seed mints the jobs row with a
  // NULL plan correlator, so the later SessionStart takes the ON CONFLICT
  // (resume) branch — which historically left the pair NULL and never
  // discharged, stranding the task `[::blocked:dispatch-pending]` forever.
  // The COALESCE-heal fills the NULL pair AND the widened gate discharges on
  // that NULL->non-NULL transition.
  const dispatchId = dispatchedEvent("work", "fn-832-race.1", "/repo", 1700);
  const promptId = insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-race",
    pid: 9100,
  });
  const sessionId = insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-race",
    spawn_name: "work::fn-832-race.1",
    pid: 9100,
  });
  drainAll();

  // (a) the pair healed onto the fork-seed row.
  const job = getJob("sess-race");
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-832-race.1");
  // (b) the pending dispatch discharged inline.
  expect(getPendingDispatch("work", "fn-832-race.1")).toBeNull();
  // (c) board-level outcome: `dispatch-pending` is driven SOLELY by an open
  // `pending_dispatches` row for `work::<task_id>` (see `taskHasPending` in
  // src/readiness.ts) — with the row discharged the verdict can no longer fire.
  expect(
    db
      .query(
        "SELECT COUNT(*) AS n FROM pending_dispatches WHERE verb = ? AND id = ?",
      )
      .get("work", "fn-832-race.1"),
  ).toEqual({ n: 0 });

  // (d) re-fold determinism: rewind + DELETE the projections + redrain must
  // reproduce byte-identical `jobs` + `pending_dispatches` (the mandatory
  // idiom — these folds are pure over the event log).
  const jobsBefore = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const pendingBefore = db
    .query("SELECT * FROM pending_dispatches ORDER BY verb, id")
    .all();
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM pending_dispatches");
  drainAll();
  expect(db.query("SELECT * FROM jobs ORDER BY job_id").all()).toEqual(
    jobsBefore,
  );
  expect(
    db.query("SELECT * FROM pending_dispatches ORDER BY verb, id").all(),
  ).toEqual(pendingBefore);
  // Sanity: the event ids fold in the intended order (prompt before session).
  expect(promptId).toBeGreaterThan(dispatchId);
  expect(sessionId).toBeGreaterThan(promptId);
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
// Schema v107 (fn-1107 task .1) — `jobs.dispatch_origin` provenance stamp. The
// SessionStart discharge-on-bind seam stamps `'autopilot'` ONLY when the
// pending_dispatches DELETE actually removes a row (a real autopilot Dispatched
// intent bound to this job); every manual/handoff/untitled session folds NULL.
// The airtight autopilot-vs-manual discriminator the autoclose worker scopes on.
// ---------------------------------------------------------------------------

function getDispatchOrigin(jobId: string): string | null {
  const row = db
    .query("SELECT dispatch_origin FROM jobs WHERE job_id = ?")
    .get(jobId) as { dispatch_origin: string | null } | null;
  return row?.dispatch_origin ?? null;
}

test("dispatch_origin: a SessionStart that discharges a pending dispatch folds dispatch_origin 'autopilot' (fn-1107)", () => {
  // Autopilot outbox flow: `Dispatched` mints the pending row, then the worker's
  // binding `SessionStart` discharges it — the discharge (changes > 0) is the
  // gate that stamps the job autopilot-owned.
  dispatchedEvent("work", "fn-1107-auto.1", "/repo", 1700);
  drainAll();
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-auto",
    spawn_name: "work::fn-1107-auto.1",
  });
  drainAll();
  expect(getPendingDispatch("work", "fn-1107-auto.1")).toBeNull();
  expect(getDispatchOrigin("sess-auto")).toBe("autopilot");
});

test("dispatch_origin: a plan-form SessionStart with NO pending row (manual dispatch) folds NULL (fn-1107)", () => {
  // A manual `keeper dispatch work::fn-N.M` is plan-form (spawn name matches the
  // whitelist) but mints NO `Dispatched` event — the CLI only READS
  // pending_dispatches as a race guard. So the discharge DELETE removes nothing
  // (changes == 0) and the row correctly stays NULL — the exclusion tripwire
  // that keeps manual plan workers out of the autoclose bucket.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-manual",
    spawn_name: "work::fn-1107-manual.1",
  });
  drainAll();
  const job = getJob("sess-manual");
  // The plan correlator still binds (spawn-name parse), but with no discharge…
  expect(job?.plan_verb).toBe("work");
  expect(job?.plan_ref).toBe("fn-1107-manual.1");
  // …the provenance stamp stays NULL.
  expect(getDispatchOrigin("sess-manual")).toBeNull();
});

test("dispatch_origin: handoff, untitled, and non-whitelist SessionStarts fold NULL (fn-1107)", () => {
  // A `handoff::<id>` spawn name is a SEPARATE class (`planVerbRefFromSpawnName`
  // returns null), so the discharge block never fires; an untitled session and a
  // human-launched arbitrary name likewise never reach the stamp. All NULL.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-handoff",
    spawn_name: "handoff::fn-1107-h1",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-untitled",
    // no spawn_name — a bare manual `claude` session
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-arbitrary",
    spawn_name: "human-launched-session",
  });
  drainAll();
  expect(getDispatchOrigin("sess-handoff")).toBeNull();
  expect(getDispatchOrigin("sess-untitled")).toBeNull();
  expect(getDispatchOrigin("sess-arbitrary")).toBeNull();
});

test("dispatch_origin: a same-key manual SessionStart AFTER the autopilot worker already discharged folds NULL (fn-1107)", () => {
  // The pending row is consumed by the FIRST binding SessionStart. A later
  // same-key session (e.g. a manual relaunch of the same task id) finds no
  // pending row to discharge, so it stays NULL — only the genuinely
  // autopilot-bound worker carries the stamp.
  dispatchedEvent("work", "fn-1107-once.1", "/repo", 1700);
  drainAll();
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-auto-once",
    spawn_name: "work::fn-1107-once.1",
  });
  drainAll();
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-manual-once",
    spawn_name: "work::fn-1107-once.1",
  });
  drainAll();
  expect(getDispatchOrigin("sess-auto-once")).toBe("autopilot");
  expect(getDispatchOrigin("sess-manual-once")).toBeNull();
});

test("from-scratch re-fold reproduces the dispatch_origin stamps byte-identically (fn-1107)", () => {
  // Seed a mix of stamped ('autopilot') and NULL (manual/handoff) jobs, then
  // rewind + wipe the deterministic `jobs` projection + the ephemeral
  // `pending_dispatches` and re-drain. The Dispatched events precede their
  // binding SessionStarts in the log, so the re-fold re-mints each pending row
  // and re-discharges it, reproducing identical dispatch_origin values — the
  // deterministic-replayed re-fold invariant.
  dispatchedEvent("work", "fn-1107-r-a.1", "/r1", 1700);
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-r-auto",
    spawn_name: "work::fn-1107-r-a.1",
  });
  // Manual (no Dispatched) → NULL.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-r-manual",
    spawn_name: "work::fn-1107-r-manual.1",
  });
  // Handoff → NULL.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-r-handoff",
    spawn_name: "handoff::fn-1107-r-h",
  });
  drainAll();

  const before = db
    .query("SELECT job_id, dispatch_origin FROM jobs ORDER BY job_id")
    .all();
  // Sanity: exactly one 'autopilot' stamp among the three seeded jobs.
  expect(before).toContainEqual({
    job_id: "sess-r-auto",
    dispatch_origin: "autopilot",
  });
  expect(before).toContainEqual({
    job_id: "sess-r-manual",
    dispatch_origin: null,
  });

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM pending_dispatches");
  drainAll();

  const after = db
    .query("SELECT job_id, dispatch_origin FROM jobs ORDER BY job_id")
    .all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v76 (fn-846) — `dispatch_never_bound` reducer projection + the
// never-bound circuit breaker. `foldDispatchExpired` increments a per-`(verb,
// id)` consecutive-`DispatchExpired`-without-bind counter; at K=3 it mints a
// sticky `dispatch_failures(reason='never-bound')` the `failedKeys` arm
// suppresses. A successful bind (discharge-on-bind) and a `DispatchCleared`
// (`keeper autopilot retry`) each reset the counter. All folds pure (no
// `Date.now`, no env, no liveness) — a from-scratch re-fold is byte-identical.
// ---------------------------------------------------------------------------

function getNeverBoundCounter(verb: string, id: string) {
  return db
    .query("SELECT * FROM dispatch_never_bound WHERE verb = ? AND id = ?")
    .get(verb, id) as {
    verb: string;
    id: string;
    consecutive_expired: number;
    last_event_id: number;
  } | null;
}

test("K=3 consecutive DispatchExpired without a bind mints DispatchFailed(never-bound) and clears the counter (fn-846)", () => {
  // Each expire bumps the counter; the failure does NOT exist until the
  // K-th expire trips the breaker.
  dispatchExpiredEvent("work", "fn-846-loop.1");
  drainAll();
  expect(
    getNeverBoundCounter("work", "fn-846-loop.1")?.consecutive_expired,
  ).toBe(1);
  expect(getDispatchFailure("work", "fn-846-loop.1")).toBeNull();

  dispatchExpiredEvent("work", "fn-846-loop.1");
  drainAll();
  expect(
    getNeverBoundCounter("work", "fn-846-loop.1")?.consecutive_expired,
  ).toBe(2);
  expect(getDispatchFailure("work", "fn-846-loop.1")).toBeNull();

  // The K-th (3rd) expire trips the breaker: a sticky never-bound failure is
  // minted AND the counter is cleared (so a post-retry re-arm starts at zero).
  const tripId = dispatchExpiredEvent("work", "fn-846-loop.1");
  drainAll();
  const failure = getDispatchFailure("work", "fn-846-loop.1");
  expect(failure).not.toBeNull();
  expect(failure?.reason).toBe("never-bound");
  expect(failure?.dir).toBeNull();
  expect(failure?.last_event_id).toBe(tripId);
  expect(getNeverBoundCounter("work", "fn-846-loop.1")).toBeNull();
});

test("a successful bind between expires resets the counter to 0 — the breaker never trips (fn-846)", () => {
  // Two expires, then a bind, then two more expires. Without the reset the
  // 3rd cumulative expire would trip; with it, the bind zeroes the count so
  // the post-bind run only reaches 2 — no never-bound failure.
  dispatchExpiredEvent("work", "fn-846-bind.1");
  dispatchExpiredEvent("work", "fn-846-bind.1");
  drainAll();
  expect(
    getNeverBoundCounter("work", "fn-846-bind.1")?.consecutive_expired,
  ).toBe(2);

  // Successful bind (discharge-on-bind spawn-INSERT) resets the counter.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-846-bind",
    spawn_name: "work::fn-846-bind.1",
  });
  drainAll();
  expect(getNeverBoundCounter("work", "fn-846-bind.1")).toBeNull();

  // Two more expires only reach 2 — below K, so no failure.
  dispatchExpiredEvent("work", "fn-846-bind.1");
  dispatchExpiredEvent("work", "fn-846-bind.1");
  drainAll();
  expect(
    getNeverBoundCounter("work", "fn-846-bind.1")?.consecutive_expired,
  ).toBe(2);
  expect(getDispatchFailure("work", "fn-846-bind.1")).toBeNull();
});

test("bound-then-died does NOT trip the breaker — a single bind clears any prior count (fn-846)", () => {
  // A worker that binds once (SessionStart) then dies is the exit-watcher's
  // path, not never-bound. The bind reset means even a prior near-miss count
  // is wiped, so a later death never contributes to a never-bound trip.
  dispatchExpiredEvent("work", "fn-846-died.1");
  dispatchExpiredEvent("work", "fn-846-died.1");
  drainAll();
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-846-died",
    spawn_name: "work::fn-846-died.1",
  });
  // The worker dies (synthetic Killed) — irrelevant to the never-bound counter.
  killedEvent(4242, null, "sess-846-died");
  drainAll();
  expect(getNeverBoundCounter("work", "fn-846-died.1")).toBeNull();
  expect(getDispatchFailure("work", "fn-846-died.1")).toBeNull();
});

test("DispatchCleared (keeper autopilot retry) clears BOTH the never-bound failure and the counter (fn-846)", () => {
  // Trip the breaker, then retry. The clear path must DELETE the
  // dispatch_failures row (so failedKeys stops suppressing) AND zero the
  // counter (so the next dispatch cycle re-arms from 0, not from K).
  dispatchExpiredEvent("work", "fn-846-retry.1");
  dispatchExpiredEvent("work", "fn-846-retry.1");
  dispatchExpiredEvent("work", "fn-846-retry.1");
  drainAll();
  expect(getDispatchFailure("work", "fn-846-retry.1")?.reason).toBe(
    "never-bound",
  );

  dispatchClearedEvent("work", "fn-846-retry.1");
  drainAll();
  expect(getDispatchFailure("work", "fn-846-retry.1")).toBeNull();
  expect(getNeverBoundCounter("work", "fn-846-retry.1")).toBeNull();

  // Re-armed from zero: a single post-retry expire is far below K — no
  // immediate re-trip.
  dispatchExpiredEvent("work", "fn-846-retry.1");
  drainAll();
  expect(
    getNeverBoundCounter("work", "fn-846-retry.1")?.consecutive_expired,
  ).toBe(1);
  expect(getDispatchFailure("work", "fn-846-retry.1")).toBeNull();
});

test("a Dispatched re-dispatch between expires PRESERVES the counter — the loop still trips at K (fn-846)", () => {
  // The real never-bound loop: expire → re-dispatch → expire → re-dispatch →
  // expire. The Dispatched UPSERT only touches pending_dispatches, NOT the
  // counter, so three consecutive expires (with re-dispatches but NO bind)
  // still trip the breaker.
  dispatchedEvent("work", "fn-846-cycle.1", "/r", 1700);
  dispatchExpiredEvent("work", "fn-846-cycle.1");
  dispatchedEvent("work", "fn-846-cycle.1", "/r", 1800);
  dispatchExpiredEvent("work", "fn-846-cycle.1");
  dispatchedEvent("work", "fn-846-cycle.1", "/r", 1900);
  dispatchExpiredEvent("work", "fn-846-cycle.1");
  drainAll();
  expect(getDispatchFailure("work", "fn-846-cycle.1")?.reason).toBe(
    "never-bound",
  );
});

test("an expiry of an already-failed key does NOT re-trip the breaker — no counter bump (fn-870)", () => {
  // BUG2 widened the TTL sweep to expire aged pendings UNCONDITIONALLY, so an
  // expiry can now land on a key that ALREADY holds a sticky dispatch_failures
  // row (e.g. a never-bound trip, then a re-dispatch, then another TTL expiry).
  // foldDispatchExpired must treat that as a pure slot release: delete the pending
  // but NOT bump the never-bound counter (which would re-trip the breaker and
  // churn last_event_id on an already-failed key).
  //
  // Trip the breaker (K=3 expires → sticky never-bound failure, counter cleared).
  dispatchExpiredEvent("work", "fn-870-already-failed.1");
  dispatchExpiredEvent("work", "fn-870-already-failed.1");
  dispatchExpiredEvent("work", "fn-870-already-failed.1");
  drainAll();
  expect(getDispatchFailure("work", "fn-870-already-failed.1")?.reason).toBe(
    "never-bound",
  );
  expect(getNeverBoundCounter("work", "fn-870-already-failed.1")).toBeNull();

  // Re-dispatch (the slow re-arm), then the widened sweep expires it again while
  // the sticky failure still stands. The expiry must NOT create a new counter row.
  dispatchedEvent("work", "fn-870-already-failed.1", "/r", 2000);
  drainAll();
  expect(getPendingDispatch("work", "fn-870-already-failed.1")).not.toBeNull();

  dispatchExpiredEvent("work", "fn-870-already-failed.1");
  drainAll();
  // Slot released, breaker NOT re-armed: pending gone, no counter, failure intact.
  expect(getPendingDispatch("work", "fn-870-already-failed.1")).toBeNull();
  expect(getNeverBoundCounter("work", "fn-870-already-failed.1")).toBeNull();
  expect(getDispatchFailure("work", "fn-870-already-failed.1")?.reason).toBe(
    "never-bound",
  );
});

test("DispatchExpired with a malformed payload does NOT touch dispatch_never_bound (cursor still advances) (fn-846)", () => {
  const malformed = [
    { hook_event: "DispatchExpired", data: "{ not json" },
    { hook_event: "DispatchExpired", data: JSON.stringify({}) },
    { hook_event: "DispatchExpired", data: JSON.stringify({ verb: "v" }) },
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
    db.query("SELECT COUNT(*) AS n FROM dispatch_never_bound").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(lastId);
});

test("zero-event projection: a fresh DB has zero dispatch_never_bound rows (fn-846)", () => {
  const count = (
    db.query("SELECT COUNT(*) AS n FROM dispatch_never_bound").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("from-scratch re-fold reproduces dispatch_never_bound + the never-bound failure byte-identically (fn-846)", () => {
  // A representative sequence exercising every counter arm:
  // - increment below K (a key that never trips)
  // - bind reset (a key whose count zeroes mid-stream)
  // - K-th expire mint + counter clear (a key that trips)
  // - retry clear (a tripped key cleared, then re-armed)
  dispatchExpiredEvent("work", "fn-846-rf-a.1"); // a: 1
  dispatchExpiredEvent("work", "fn-846-rf-b.1"); // b: 1
  dispatchExpiredEvent("work", "fn-846-rf-b.1"); // b: 2
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-rf-b",
    spawn_name: "work::fn-846-rf-b.1",
  }); // b: reset (gone)
  dispatchExpiredEvent("work", "fn-846-rf-c.1"); // c: 1
  dispatchExpiredEvent("work", "fn-846-rf-c.1"); // c: 2
  dispatchExpiredEvent("work", "fn-846-rf-c.1"); // c: 3 → trip + clear counter
  dispatchClearedEvent("work", "fn-846-rf-c.1"); // c: failure + counter cleared
  dispatchExpiredEvent("work", "fn-846-rf-c.1"); // c: re-armed → 1
  dispatchExpiredEvent("work", "fn-846-rf-b.1"); // b (post-reset): 1
  drainAll();

  const counterBefore = db
    .query("SELECT * FROM dispatch_never_bound ORDER BY verb ASC, id ASC")
    .all();
  const failuresBefore = db
    .query("SELECT * FROM dispatch_failures ORDER BY verb ASC, id ASC")
    .all();

  // Rewind cursor + wipe every projection these folds touch + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM dispatch_never_bound");
  db.run("DELETE FROM dispatch_failures");
  db.run("DELETE FROM pending_dispatches");
  db.run("DELETE FROM jobs");
  drainAll();

  const counterAfter = db
    .query("SELECT * FROM dispatch_never_bound ORDER BY verb ASC, id ASC")
    .all();
  const failuresAfter = db
    .query("SELECT * FROM dispatch_failures ORDER BY verb ASC, id ASC")
    .all();
  expect(counterAfter).toEqual(counterBefore);
  expect(failuresAfter).toEqual(failuresBefore);
});

// ---------------------------------------------------------------------------
// Schema v105 (fn-1086 task .1) — `dispatch_instant_death` reducer projection +
// the instant-death circuit breaker, the reducer-side SIBLING of never-bound.
// A worker that BINDS-and-works (`active_since` stamped) then dies via `Killed`
// within a sub-minute post-bind lifetime increments a per-`(verb, id)`
// consecutive-instant-death count; at K=3 it mints a sticky
// `dispatch_failures(reason='instant-death-breaker')` the `failedKeys` arm
// suppresses. Detection is cause-AGNOSTIC (post-bind lifetime from event `ts`
// only). A clean `SessionEnd` or a long-lived `Killed` RESETS the count; a
// successful bind does NOT (the whole signal is bind-then-die — the count must
// survive re-dispatch). `DispatchCleared` (retry) clears failure + count. All
// folds pure — a from-scratch re-fold is byte-identical.
// ---------------------------------------------------------------------------

function getInstantDeathCounter(verb: string, id: string) {
  return db
    .query("SELECT * FROM dispatch_instant_death WHERE verb = ? AND id = ?")
    .get(verb, id) as {
    verb: string;
    id: string;
    consecutive_deaths: number;
    last_event_id: number;
  } | null;
}

// Bind a fresh worker (SessionStart mints the `work::<ref>` job row; a
// UserPromptSubmit at `bindTs` flips it `working` and stamps `active_since`),
// then land its terminal at `endTs`: `kind='kill'` mints an abrupt `Killed`
// (loose pid-only match — start_time NULL), `kind='end'` a clean `SessionEnd`.
// Each call uses a DISTINCT session so the `(verb, id)` counter accumulates
// across re-dispatches exactly as production does. Returns the terminal event id.
let instantDeathSeq = 0;
function bindThenTerminate(
  ref: string,
  bindTs: number,
  endTs: number,
  kind: "kill" | "end",
): number {
  const session = `sess-idb-${instantDeathSeq++}`;
  insertEvent({
    hook_event: "SessionStart",
    session_id: session,
    spawn_name: `work::${ref}`,
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: session,
    ts: bindTs,
  });
  if (kind === "kill") {
    return insertEvent({
      hook_event: "Killed",
      session_id: session,
      ts: endTs,
      data: JSON.stringify({ pid: 4242, start_time: null }),
    });
  }
  return insertEvent({
    hook_event: "SessionEnd",
    session_id: session,
    ts: endTs,
  });
}

test("K=3 consecutive instant post-bind deaths mint DispatchFailed(instant-death-breaker) and clear the counter (fn-1086)", () => {
  // Each sub-minute bind-then-Killed bumps the counter; the sticky does NOT
  // exist until the K-th death trips the breaker. Every death carries its own
  // successful bind — proving a bind does NOT reset this counter (unlike
  // never-bound), the whole point of the bind-then-die signal.
  bindThenTerminate("fn-1086-loop.1", 100_000, 100_020, "kill");
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-loop.1")?.consecutive_deaths,
  ).toBe(1);
  expect(getDispatchFailure("work", "fn-1086-loop.1")).toBeNull();

  bindThenTerminate("fn-1086-loop.1", 200_000, 200_030, "kill");
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-loop.1")?.consecutive_deaths,
  ).toBe(2);
  expect(getDispatchFailure("work", "fn-1086-loop.1")).toBeNull();

  const tripId = bindThenTerminate("fn-1086-loop.1", 300_000, 300_010, "kill");
  drainAll();
  const failure = getDispatchFailure("work", "fn-1086-loop.1");
  expect(failure).not.toBeNull();
  expect(failure?.reason).toBe("instant-death-breaker");
  expect(failure?.dir).toBeNull();
  expect(failure?.last_event_id).toBe(tripId);
  expect(failure?.ts).toBe(300_010);
  // Counter cleared on trip — a post-retry re-arm starts at zero.
  expect(getInstantDeathCounter("work", "fn-1086-loop.1")).toBeNull();
});

test("a fast SUCCESSFUL task (clean SessionEnd, sub-minute) NEVER trips — no increment (fn-1086)", () => {
  // A quick success exits via SessionEnd, not an abrupt Killed. Three of them,
  // each sub-minute, leave the counter untouched — the explicit guard that a
  // legitimately-fast completion never trips the breaker.
  bindThenTerminate("fn-1086-fast.1", 100_000, 100_005, "end");
  bindThenTerminate("fn-1086-fast.1", 200_000, 200_005, "end");
  bindThenTerminate("fn-1086-fast.1", 300_000, 300_005, "end");
  drainAll();
  expect(getInstantDeathCounter("work", "fn-1086-fast.1")).toBeNull();
  expect(getDispatchFailure("work", "fn-1086-fast.1")).toBeNull();
});

test("a long-lived Killed (past the wall window) RESETS the count — consecutive means uninterrupted (fn-1086)", () => {
  // Two instant deaths, then a worker that lived well past a minute before
  // dying: real progress broke the fast-death streak, so the count resets. A
  // later instant death starts fresh at 1 — the breaker never trips at a
  // spurious cumulative 3.
  bindThenTerminate("fn-1086-long.1", 100_000, 100_020, "kill");
  bindThenTerminate("fn-1086-long.1", 200_000, 200_030, "kill");
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-long.1")?.consecutive_deaths,
  ).toBe(2);

  // Lifetime 600s ≫ 60s → not an instant death → reset.
  bindThenTerminate("fn-1086-long.1", 300_000, 300_600, "kill");
  drainAll();
  expect(getInstantDeathCounter("work", "fn-1086-long.1")).toBeNull();
  expect(getDispatchFailure("work", "fn-1086-long.1")).toBeNull();

  bindThenTerminate("fn-1086-long.1", 400_000, 400_010, "kill");
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-long.1")?.consecutive_deaths,
  ).toBe(1);
  expect(getDispatchFailure("work", "fn-1086-long.1")).toBeNull();
});

test("a clean SessionEnd between instant deaths RESETS the mid-streak count (fn-1086)", () => {
  // death, death, [clean SessionEnd], death → the success interrupts the
  // consecutive streak, so the final death is only count 1, not a trip.
  bindThenTerminate("fn-1086-mix.1", 100_000, 100_020, "kill");
  bindThenTerminate("fn-1086-mix.1", 200_000, 200_020, "kill");
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-mix.1")?.consecutive_deaths,
  ).toBe(2);

  bindThenTerminate("fn-1086-mix.1", 300_000, 300_010, "end"); // reset
  bindThenTerminate("fn-1086-mix.1", 400_000, 400_010, "kill"); // 1
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-mix.1")?.consecutive_deaths,
  ).toBe(1);
  expect(getDispatchFailure("work", "fn-1086-mix.1")).toBeNull();
});

test("a bind alone does NOT reset the counter — the count survives re-dispatch (fn-1086)", () => {
  // The key contrast with never-bound: never-bound resets on bind; instant-death
  // MUST NOT (the signal is bind-then-die). Two deaths → count 2, then a bare
  // re-dispatch bind (SessionStart + UserPromptSubmit, still live — no terminal)
  // leaves the count at 2.
  bindThenTerminate("fn-1086-bind.1", 100_000, 100_020, "kill");
  bindThenTerminate("fn-1086-bind.1", 200_000, 200_020, "kill");
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-bind.1")?.consecutive_deaths,
  ).toBe(2);

  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-idb-bindonly",
    spawn_name: "work::fn-1086-bind.1",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-idb-bindonly",
    ts: 300_000,
  });
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-bind.1")?.consecutive_deaths,
  ).toBe(2);
});

test("DispatchCleared (keeper autopilot retry) clears BOTH the instant-death failure and the counter (fn-1086)", () => {
  bindThenTerminate("fn-1086-retry.1", 100_000, 100_010, "kill");
  bindThenTerminate("fn-1086-retry.1", 200_000, 200_010, "kill");
  bindThenTerminate("fn-1086-retry.1", 300_000, 300_010, "kill");
  drainAll();
  expect(getDispatchFailure("work", "fn-1086-retry.1")?.reason).toBe(
    "instant-death-breaker",
  );

  dispatchClearedEvent("work", "fn-1086-retry.1");
  drainAll();
  expect(getDispatchFailure("work", "fn-1086-retry.1")).toBeNull();
  expect(getInstantDeathCounter("work", "fn-1086-retry.1")).toBeNull();

  // Re-armed from zero: a single post-retry instant death is below K.
  bindThenTerminate("fn-1086-retry.1", 400_000, 400_010, "kill");
  drainAll();
  expect(
    getInstantDeathCounter("work", "fn-1086-retry.1")?.consecutive_deaths,
  ).toBe(1);
  expect(getDispatchFailure("work", "fn-1086-retry.1")).toBeNull();
});

test("an instant death on an ALREADY-failed key does NOT re-trip or churn the counter (fn-1086)", () => {
  // Once the sticky stands, a late in-flight terminal is a slot release, not a
  // fresh trip — mirror never-bound's alreadyFailed guard (no bump, no re-mint).
  bindThenTerminate("fn-1086-already.1", 100_000, 100_010, "kill");
  bindThenTerminate("fn-1086-already.1", 200_000, 200_010, "kill");
  const tripId = bindThenTerminate(
    "fn-1086-already.1",
    300_000,
    300_010,
    "kill",
  );
  drainAll();
  expect(getDispatchFailure("work", "fn-1086-already.1")?.reason).toBe(
    "instant-death-breaker",
  );
  expect(getInstantDeathCounter("work", "fn-1086-already.1")).toBeNull();

  // A further instant death while the sticky stands: no counter row, failure
  // unchanged (its last_event_id is still the trip's, not the late death's).
  bindThenTerminate("fn-1086-already.1", 400_000, 400_010, "kill");
  drainAll();
  expect(getInstantDeathCounter("work", "fn-1086-already.1")).toBeNull();
  expect(getDispatchFailure("work", "fn-1086-already.1")?.last_event_id).toBe(
    tripId,
  );
});

test("a Killed of a NON-plan-keyed job never touches dispatch_instant_death (fn-1086)", () => {
  // A bare session (no spawn_name → NULL plan_verb/plan_ref) that binds and dies
  // fast is not a dispatch key — the breaker only tracks `(verb, id)` keys.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-idb-bare" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-idb-bare",
    ts: 100_000,
  });
  insertEvent({
    hook_event: "Killed",
    session_id: "sess-idb-bare",
    ts: 100_010,
    data: JSON.stringify({ pid: 4242, start_time: null }),
  });
  drainAll();
  const n = (
    db.query("SELECT COUNT(*) AS n FROM dispatch_instant_death").get() as {
      n: number;
    }
  ).n;
  expect(n).toBe(0);
});

test("zero-event projection: a fresh DB has zero dispatch_instant_death rows (fn-1086)", () => {
  const count = (
    db.query("SELECT COUNT(*) AS n FROM dispatch_instant_death").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("from-scratch re-fold reproduces dispatch_instant_death + the instant-death failure byte-identically (fn-1086)", () => {
  // A representative sequence exercising every arm: a below-K key, a key reset by
  // a clean SessionEnd mid-streak, a key that trips + clears its counter, and a
  // retry-cleared-then-re-armed key.
  bindThenTerminate("fn-1086-rf-a.1", 100_000, 100_010, "kill"); // a: 1
  bindThenTerminate("fn-1086-rf-b.1", 110_000, 110_010, "kill"); // b: 1
  bindThenTerminate("fn-1086-rf-b.1", 120_000, 120_005, "end"); // b: reset (gone)
  bindThenTerminate("fn-1086-rf-c.1", 130_000, 130_010, "kill"); // c: 1
  bindThenTerminate("fn-1086-rf-c.1", 140_000, 140_010, "kill"); // c: 2
  bindThenTerminate("fn-1086-rf-c.1", 150_000, 150_010, "kill"); // c: 3 → trip + clear
  drainAll();
  dispatchClearedEvent("work", "fn-1086-rf-c.1"); // c: failure + counter cleared
  bindThenTerminate("fn-1086-rf-c.1", 160_000, 160_010, "kill"); // c: re-armed → 1
  drainAll();

  const counterBefore = db
    .query("SELECT * FROM dispatch_instant_death ORDER BY verb ASC, id ASC")
    .all();
  const failuresBefore = db
    .query("SELECT * FROM dispatch_failures ORDER BY verb ASC, id ASC")
    .all();

  // Rewind cursor + wipe every projection these folds touch + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM dispatch_instant_death");
  db.run("DELETE FROM dispatch_failures");
  db.run("DELETE FROM pending_dispatches");
  db.run("DELETE FROM jobs");
  drainAll();

  const counterAfter = db
    .query("SELECT * FROM dispatch_instant_death ORDER BY verb ASC, id ASC")
    .all();
  const failuresAfter = db
    .query("SELECT * FROM dispatch_failures ORDER BY verb ASC, id ASC")
    .all();
  expect(counterAfter).toEqual(counterBefore);
  expect(failuresAfter).toEqual(failuresBefore);
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
// fn-953 — `AutopilotConfigSet{<partial patch>}` is the GENERIC runtime config
// event that REPLACES the boot-frozen `AutopilotCapSet` for setting the cap.
// The fold UPSERTs the singleton row setting ONLY the patched columns and
// preserving the rest (paused / mode / any unpatched config column). The
// `AutopilotCapSet` fold arm is retained for historical replay only.
// ---------------------------------------------------------------------------

function autopilotConfigSetEvent(
  patch: {
    max_concurrent_jobs?: number | null;
    max_concurrent_per_root?: number | null;
    worktree_mode?: boolean;
    worktree_multi_repo?: boolean;
  },
  sessionId = "autopilot",
): number {
  return insertEvent({
    hook_event: "AutopilotConfigSet",
    session_id: sessionId,
    data: JSON.stringify(patch),
  });
}

function getAutopilotStateConfig() {
  return db.query("SELECT * FROM autopilot_state WHERE id = 1").get() as {
    id: number;
    paused: number;
    last_event_id: number;
    created_at: number;
    updated_at: number;
    max_concurrent_jobs: number | null;
    mode: string;
    max_concurrent_per_root: number | null;
    worktree_mode: number | null;
    worktree_multi_repo: number | null;
  } | null;
}

test("AutopilotConfigSet sets max_concurrent_jobs and advances the cursor (fn-953)", () => {
  const eventId = autopilotConfigSetEvent({ max_concurrent_jobs: 8 });
  expect(drainAll()).toBe(1);
  const row = getAutopilotStateConfig();
  expect(row).not.toBeNull();
  expect(row?.id).toBe(1);
  expect(row?.max_concurrent_jobs).toBe(8);
  expect(row?.last_event_id).toBe(eventId);
  expect(getCursor()).toBe(eventId);
});

test("AutopilotConfigSet INSERT path (first autopilot_state event) defaults paused=1 + mode yolo (fn-953)", () => {
  // With the boot-append gone, an `AutopilotConfigSet` can be the FIRST event to
  // touch the row — its INSERT path must still materialize a boots-paused
  // singleton (paused=1) and the mode column's DEFAULT 'yolo'.
  autopilotConfigSetEvent({ max_concurrent_jobs: 2 });
  drainAll();
  const row = getAutopilotStateConfig();
  expect(row?.max_concurrent_jobs).toBe(2);
  expect(row?.paused).toBe(1);
  expect(row?.mode).toBe("yolo");
});

test("AutopilotConfigSet explicit null clears the cap to SQL NULL (= unlimited) (fn-953)", () => {
  autopilotConfigSetEvent({ max_concurrent_jobs: 5 });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(5);
  autopilotConfigSetEvent({ max_concurrent_jobs: null });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBeNull();
});

test("AutopilotConfigSet PRESERVES paused and mode (sibling columns it does not own) (fn-953)", () => {
  // Establish a non-default paused (play) AND a non-default mode (armed), then a
  // config patch must leave BOTH untouched while landing the cap.
  autopilotPausedEvent(false);
  autopilotModeEvent("armed");
  drainAll();
  expect(getAutopilotStateConfig()?.paused).toBe(0);
  expect(getAutopilotStateConfig()?.mode).toBe("armed");
  autopilotConfigSetEvent({ max_concurrent_jobs: 4 });
  drainAll();
  const row = getAutopilotStateConfig();
  expect(row?.max_concurrent_jobs).toBe(4); // cap landed
  expect(row?.paused).toBe(0); // play PRESERVED
  expect(row?.mode).toBe("armed"); // mode PRESERVED
});

test("a paused toggle and a mode flip both PRESERVE a config-set cap (fn-953)", () => {
  // The reverse direction: a cap set via AutopilotConfigSet must survive a later
  // pause toggle AND a later mode flip (sibling folds preserve the cap column).
  autopilotConfigSetEvent({ max_concurrent_jobs: 7 });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(7);
  autopilotPausedEvent(true);
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(7); // preserved
  autopilotModeEvent("armed");
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(7); // preserved
});

test("AutopilotConfigSet malformed/empty/non-positive payloads behave like the cap parser (fn-953)", () => {
  // Seed a cap first so the row exists, then fold each payload. An EMPTY patch
  // (no recognized field) and a structurally-bad blob fold to a NO-OP (the cap
  // is preserved); a present-but-bad value coerces to NULL (= unlimited).
  autopilotConfigSetEvent({ max_concurrent_jobs: 6 });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(6);

  // Empty patch → no-op (cap preserved).
  insertEvent({
    hook_event: "AutopilotConfigSet",
    session_id: "autopilot",
    data: JSON.stringify({}),
  });
  // Malformed JSON → no-op (cap preserved).
  insertEvent({
    hook_event: "AutopilotConfigSet",
    session_id: "autopilot",
    data: "{ not json",
  });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(6);

  // A present-but-non-positive / non-integer / non-number value coerces to NULL.
  for (const bad of [0, -3, 2.5, "9"]) {
    insertEvent({
      hook_event: "AutopilotConfigSet",
      session_id: "autopilot",
      data: JSON.stringify({ max_concurrent_jobs: bad }),
    });
    drainAll();
    expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBeNull();
    // Re-establish a positive cap for the next iteration.
    autopilotConfigSetEvent({ max_concurrent_jobs: 6 });
    drainAll();
  }
});

test("from-scratch re-fold reproduces autopilot_state byte-identically with mixed paused/mode/config events (fn-953)", () => {
  autopilotConfigSetEvent({ max_concurrent_jobs: 3 });
  autopilotPausedEvent(false);
  autopilotModeEvent("armed");
  autopilotConfigSetEvent({ max_concurrent_jobs: 9 });
  autopilotPausedEvent(true);
  drainAll();
  const before = db
    .query("SELECT * FROM autopilot_state ORDER BY id ASC")
    .all();
  expect(getAutopilotStateConfig()?.paused).toBe(1);
  expect(getAutopilotStateConfig()?.mode).toBe("armed");
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(9);
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM autopilot_state");
  drainAll();
  const after = db.query("SELECT * FROM autopilot_state ORDER BY id ASC").all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v90 (fn-954) — `max_concurrent_per_root` is the SECOND scalar config
// column riding the generic `AutopilotConfigSet` fold. Default NULL (= the
// in-memory DEFAULT = 1); set via a `{max_concurrent_per_root:N}` patch; the
// fold preserves it across sibling folds and preserves the OTHER columns when a
// patch touches only it. NO unlimited sentinel — a present-but-bad value coerces
// to NULL (= reset to default), never a dropped event.
// ---------------------------------------------------------------------------

test("fresh DB has no autopilot_state row → max_concurrent_per_root resolves to the default (fn-954)", () => {
  // No event touching the row: the column is absent (no row), which the
  // reconciler/board resolve `?? DEFAULT` = 1.
  expect(getAutopilotStateConfig()).toBeNull();
});

test("AutopilotConfigSet sets max_concurrent_per_root and advances the cursor (fn-954)", () => {
  const eventId = autopilotConfigSetEvent({ max_concurrent_per_root: 3 });
  expect(drainAll()).toBe(1);
  const row = getAutopilotStateConfig();
  expect(row?.max_concurrent_per_root).toBe(3);
  expect(row?.last_event_id).toBe(eventId);
  expect(getCursor()).toBe(eventId);
  // INSERT path still materializes the boots-paused / yolo defaults.
  expect(row?.paused).toBe(1);
  expect(row?.mode).toBe("yolo");
});

test("AutopilotConfigSet explicit null clears max_concurrent_per_root to SQL NULL (= reset to default) (fn-954)", () => {
  autopilotConfigSetEvent({ max_concurrent_per_root: 4 });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(4);
  autopilotConfigSetEvent({ max_concurrent_per_root: null });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBeNull();
});

test("AutopilotConfigSet {max_concurrent_per_root} PRESERVES paused, mode, and the cap (sibling columns) (fn-954)", () => {
  autopilotPausedEvent(false);
  autopilotModeEvent("armed");
  autopilotConfigSetEvent({ max_concurrent_jobs: 4 });
  drainAll();
  autopilotConfigSetEvent({ max_concurrent_per_root: 3 });
  drainAll();
  const row = getAutopilotStateConfig();
  expect(row?.max_concurrent_per_root).toBe(3); // landed
  expect(row?.max_concurrent_jobs).toBe(4); // cap PRESERVED
  expect(row?.paused).toBe(0); // play PRESERVED
  expect(row?.mode).toBe("armed"); // mode PRESERVED
});

test("a per-root patch and the cap patch in one combined frame both land (fn-954)", () => {
  autopilotConfigSetEvent({
    max_concurrent_jobs: 8,
    max_concurrent_per_root: 2,
  });
  drainAll();
  const row = getAutopilotStateConfig();
  expect(row?.max_concurrent_jobs).toBe(8);
  expect(row?.max_concurrent_per_root).toBe(2);
});

test("a cap-only patch, a pause toggle, and a mode flip all PRESERVE max_concurrent_per_root (fn-954)", () => {
  autopilotConfigSetEvent({ max_concurrent_per_root: 5 });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(5);
  autopilotConfigSetEvent({ max_concurrent_jobs: 2 });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(5); // preserved
  autopilotPausedEvent(true);
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(5); // preserved
  autopilotModeEvent("armed");
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(5); // preserved
});

test("AutopilotConfigSet present-but-bad max_concurrent_per_root coerces to NULL (= default) (fn-954)", () => {
  autopilotConfigSetEvent({ max_concurrent_per_root: 6 });
  drainAll();
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(6);
  for (const bad of [0, -3, 2.5, "9"]) {
    insertEvent({
      hook_event: "AutopilotConfigSet",
      session_id: "autopilot",
      data: JSON.stringify({ max_concurrent_per_root: bad }),
    });
    drainAll();
    expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBeNull();
    autopilotConfigSetEvent({ max_concurrent_per_root: 6 });
    drainAll();
  }
});

test("from-scratch re-fold reproduces autopilot_state byte-identically with a per-root config column (fn-954)", () => {
  autopilotConfigSetEvent({ max_concurrent_per_root: 3 });
  autopilotPausedEvent(false);
  autopilotConfigSetEvent({
    max_concurrent_jobs: 9,
    max_concurrent_per_root: 7,
  });
  autopilotModeEvent("armed");
  drainAll();
  const before = db
    .query("SELECT * FROM autopilot_state ORDER BY id ASC")
    .all();
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(7);
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(9);
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM autopilot_state");
  drainAll();
  const after = db.query("SELECT * FROM autopilot_state ORDER BY id ASC").all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v91 (fn-959) — `worktree_mode` is the THIRD scalar config column riding
// the generic `AutopilotConfigSet` fold. A BOOLEAN wire field stored as INTEGER
// 0/1 (DEFAULT NULL/absent = OFF); set via a `{worktree_mode:true|false}` patch;
// the fold preserves it across sibling folds and preserves the OTHER columns when
// a patch touches only it. A present field always lands a concrete 0/1 (no unset
// sentinel — the parser coerces `true`→1, anything-else→0).
// ---------------------------------------------------------------------------

test("fresh DB has no autopilot_state row → worktree_mode resolves to OFF (fn-959)", () => {
  // No event touching the row: the column is absent (no row), which the
  // reconciler/board resolve `?? OFF` = false.
  expect(getAutopilotStateConfig()).toBeNull();
});

test("AutopilotConfigSet {worktree_mode:true} sets the column to 1 and advances the cursor (fn-959)", () => {
  const eventId = autopilotConfigSetEvent({ worktree_mode: true });
  expect(drainAll()).toBe(1);
  const row = getAutopilotStateConfig();
  expect(row?.worktree_mode).toBe(1);
  expect(row?.last_event_id).toBe(eventId);
  expect(getCursor()).toBe(eventId);
  // INSERT path still materializes the boots-paused / yolo defaults.
  expect(row?.paused).toBe(1);
  expect(row?.mode).toBe("yolo");
});

test("AutopilotConfigSet {worktree_mode:false} sets the column to 0 (explicit OFF) (fn-959)", () => {
  autopilotConfigSetEvent({ worktree_mode: true });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1);
  autopilotConfigSetEvent({ worktree_mode: false });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(0);
});

test("AutopilotConfigSet {worktree_mode} PRESERVES paused, mode, and both concurrency columns (fn-959)", () => {
  autopilotPausedEvent(false);
  autopilotModeEvent("armed");
  autopilotConfigSetEvent({
    max_concurrent_jobs: 4,
    max_concurrent_per_root: 3,
  });
  drainAll();
  autopilotConfigSetEvent({ worktree_mode: true });
  drainAll();
  const row = getAutopilotStateConfig();
  expect(row?.worktree_mode).toBe(1); // landed
  expect(row?.max_concurrent_jobs).toBe(4); // cap PRESERVED
  expect(row?.max_concurrent_per_root).toBe(3); // per-root PRESERVED
  expect(row?.paused).toBe(0); // play PRESERVED
  expect(row?.mode).toBe("armed"); // mode PRESERVED
});

test("a cap/per-root patch, a pause toggle, and a mode flip all PRESERVE worktree_mode (fn-959)", () => {
  autopilotConfigSetEvent({ worktree_mode: true });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1);
  autopilotConfigSetEvent({ max_concurrent_jobs: 2 });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1); // preserved
  autopilotPausedEvent(true);
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1); // preserved
  autopilotModeEvent("armed");
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1); // preserved
});

test("AutopilotConfigSet present-but-non-boolean worktree_mode coerces to 0 (OFF) (fn-959)", () => {
  autopilotConfigSetEvent({ worktree_mode: true });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1);
  // A non-boolean present value (number/string/null) coerces to 0 (OFF) — the
  // parser only treats a literal `true` as ON.
  for (const bad of [1, 0, "true", null]) {
    insertEvent({
      hook_event: "AutopilotConfigSet",
      session_id: "autopilot",
      data: JSON.stringify({ worktree_mode: bad }),
    });
    drainAll();
    expect(getAutopilotStateConfig()?.worktree_mode).toBe(0);
    autopilotConfigSetEvent({ worktree_mode: true });
    drainAll();
  }
});

test("from-scratch re-fold reproduces autopilot_state byte-identically with a worktree_mode column (fn-959)", () => {
  autopilotConfigSetEvent({ worktree_mode: true });
  autopilotPausedEvent(false);
  autopilotConfigSetEvent({
    max_concurrent_jobs: 9,
    worktree_mode: false,
  });
  autopilotModeEvent("armed");
  autopilotConfigSetEvent({ worktree_mode: true });
  drainAll();
  const before = db
    .query("SELECT * FROM autopilot_state ORDER BY id ASC")
    .all();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1);
  expect(getAutopilotStateConfig()?.max_concurrent_jobs).toBe(9);
  expect(getAutopilotStateConfig()?.mode).toBe("armed");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM autopilot_state");
  drainAll();
  const after = db.query("SELECT * FROM autopilot_state ORDER BY id ASC").all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v101 (fn-1034) — `worktree_multi_repo` is the FOURTH scalar config column
// riding the generic `AutopilotConfigSet` fold, mirroring `worktree_mode`: a
// BOOLEAN wire field stored as INTEGER 0/1 (DEFAULT NULL/absent = OFF), the
// reconciler resolving `?? OFF` at read time — never in a fold. Behind it, a
// worktree-mode epic spanning >1 git toplevel provisions per-repo lane groups.
// ---------------------------------------------------------------------------

test("AutopilotConfigSet {worktree_multi_repo:true} sets the column to 1 and advances the cursor (fn-1034)", () => {
  const eventId = autopilotConfigSetEvent({ worktree_multi_repo: true });
  expect(drainAll()).toBe(1);
  const row = getAutopilotStateConfig();
  expect(row?.worktree_multi_repo).toBe(1);
  expect(row?.last_event_id).toBe(eventId);
  expect(getCursor()).toBe(eventId);
  // INSERT path still materializes the boots-paused / yolo defaults.
  expect(row?.paused).toBe(1);
  expect(row?.mode).toBe("yolo");
});

test("AutopilotConfigSet {worktree_multi_repo:false} sets the column to 0 (explicit OFF) (fn-1034)", () => {
  autopilotConfigSetEvent({ worktree_multi_repo: true });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_multi_repo).toBe(1);
  autopilotConfigSetEvent({ worktree_multi_repo: false });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_multi_repo).toBe(0);
});

test("AutopilotConfigSet {worktree_multi_repo} PRESERVES paused, mode, worktree_mode, and both concurrency columns (fn-1034)", () => {
  autopilotPausedEvent(false);
  autopilotModeEvent("armed");
  autopilotConfigSetEvent({
    max_concurrent_jobs: 4,
    max_concurrent_per_root: 3,
    worktree_mode: true,
  });
  drainAll();
  autopilotConfigSetEvent({ worktree_multi_repo: true });
  drainAll();
  const row = getAutopilotStateConfig();
  expect(row?.worktree_multi_repo).toBe(1); // landed
  expect(row?.worktree_mode).toBe(1); // worktree_mode PRESERVED
  expect(row?.max_concurrent_jobs).toBe(4); // cap PRESERVED
  expect(row?.max_concurrent_per_root).toBe(3); // per-root PRESERVED
  expect(row?.paused).toBe(0); // play PRESERVED
  expect(row?.mode).toBe("armed"); // mode PRESERVED
});

test("a worktree_mode patch and a pause toggle PRESERVE worktree_multi_repo (fn-1034)", () => {
  autopilotConfigSetEvent({ worktree_multi_repo: true });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_multi_repo).toBe(1);
  autopilotConfigSetEvent({ worktree_mode: true });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_multi_repo).toBe(1); // preserved
  autopilotPausedEvent(true);
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_multi_repo).toBe(1); // preserved
});

test("AutopilotConfigSet present-but-non-boolean worktree_multi_repo coerces to 0 (OFF) (fn-1034)", () => {
  autopilotConfigSetEvent({ worktree_multi_repo: true });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_multi_repo).toBe(1);
  for (const bad of [1, 0, "true", null]) {
    insertEvent({
      hook_event: "AutopilotConfigSet",
      session_id: "autopilot",
      data: JSON.stringify({ worktree_multi_repo: bad }),
    });
    drainAll();
    expect(getAutopilotStateConfig()?.worktree_multi_repo).toBe(0);
    autopilotConfigSetEvent({ worktree_multi_repo: true });
    drainAll();
  }
});

// ---------------------------------------------------------------------------
// fn-1134 — `max_concurrent_per_root` is DURABLE stored intent. Main mints every
// config patch VERBATIM (no worktree-off coerce/reject); the fold preserves any
// column a patch does not name. So a worktree toggle never mutates the stored
// per-root cap, and a stored value > 1 survives worktree-off untouched — the
// effective floor-to-1 lives at the read seams, not in the folded row.
// ---------------------------------------------------------------------------

test("worktree toggle never mutates the stored max_concurrent_per_root (fn-1134)", () => {
  // Worktree ON with per-root 3.
  autopilotConfigSetEvent({ worktree_mode: true, max_concurrent_per_root: 3 });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1);
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(3);
  // Flip worktree OFF without naming per-root — the fold preserves the untouched
  // column, so the STORED intent stays 3 (no coerce to 1). This is the "no re-set"
  // guarantee: the effective floor is derived at read time, not stamped here.
  autopilotConfigSetEvent({ worktree_mode: false });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(0);
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(3);
  // Flip worktree back ON (naming nothing else) — the prior 3 is restored with no
  // re-set, straight from the durable column the toggle never touched.
  autopilotConfigSetEvent({ worktree_mode: true });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1);
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(3);
});

test("setting max_concurrent_per_root > 1 while worktree is off is accepted and folds to the stored value (fn-1134)", () => {
  // Worktree OFF (the default) — materialize the row via a benign cap set.
  autopilotConfigSetEvent({ max_concurrent_jobs: 4 });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).not.toBe(1);
  const cursorBefore = getCursor();
  // No reject: the patch mints + folds, storing the intent verbatim.
  autopilotConfigSetEvent({ max_concurrent_per_root: 3 });
  drainAll();
  expect(getCursor()).toBeGreaterThan(cursorBefore);
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(3);
  expect(getAutopilotStateConfig()?.worktree_mode).not.toBe(1);
});

test("worktree-on: max_concurrent_per_root > 1 lands in the folded row (fn-1134)", () => {
  autopilotConfigSetEvent({ worktree_mode: true });
  drainAll();
  autopilotConfigSetEvent({ max_concurrent_per_root: 3 });
  drainAll();
  expect(getAutopilotStateConfig()?.worktree_mode).toBe(1);
  expect(getAutopilotStateConfig()?.max_concurrent_per_root).toBe(3);
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
// Schema v104 / fn-1083 task .2 — epics.question (epic-level parked question)
// ---------------------------------------------------------------------------

function getEpicQuestion(epicId: string): string | null {
  const row = db
    .query("SELECT question FROM epics WHERE epic_id = ?")
    .get(epicId) as { question: string | null } | null;
  return row?.question ?? null;
}

test("EpicSnapshot with a question folds onto epics.question; absent folds to NULL (fn-1083.2)", () => {
  epicSnapshotEvent("fn-30-question", {
    epic_number: 30,
    title: "parked",
    status: "open",
    question: "verify commit X reachable? to proceed, tell me exactly: yes/no",
  });
  drainAll();
  expect(getEpicQuestion("fn-30-question")).toBe(
    "verify commit X reachable? to proceed, tell me exactly: yes/no",
  );

  // A later EpicSnapshot with no `question` key folds to NULL (clears it) —
  // the fold is a pure function of the CURRENT blob, not a merge.
  epicSnapshotEvent("fn-30-question", {
    epic_number: 30,
    title: "parked",
    status: "open",
  });
  drainAll();
  expect(getEpicQuestion("fn-30-question")).toBeNull();
});

test("a fresh epic row with no EpicSnapshot.question reads NULL (zero-event default) (fn-1083.2)", () => {
  epicSnapshotEvent("fn-31-no-question", { epic_number: 31, status: "open" });
  drainAll();
  expect(getEpicQuestion("fn-31-no-question")).toBeNull();
});

test("from-scratch re-fold reproduces epics.question byte-identically (fn-1083.2)", () => {
  epicSnapshotEvent("fn-32-replay-q", {
    epic_number: 32,
    status: "open",
    question: "does the evidence check out?",
  });
  epicSnapshotEvent("fn-33-replay-noq", { epic_number: 33, status: "open" });
  drainAll();
  const before = db
    .query("SELECT epic_id, question FROM epics ORDER BY epic_id ASC")
    .all();
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM epic_tombstones");
  drainAll();
  const after = db
    .query("SELECT epic_id, question FROM epics ORDER BY epic_id ASC")
    .all();
  expect(after).toEqual(before);
  expect(getEpicQuestion("fn-32-replay-q")).toBe(
    "does the evidence check out?",
  );
  expect(getEpicQuestion("fn-33-replay-noq")).toBeNull();
});

test("EpicSnapshot ON CONFLICT update never wipes tasks/jobs when setting question (fn-1083.2)", () => {
  // Land a task first (shell-inserts the epic row with a non-empty `tasks`
  // array), then fold an EpicSnapshot carrying a question — the scalar-only
  // ON CONFLICT update must preserve the embedded tasks array.
  taskSnapshotEvent("fn-34-q-with-tasks.1", {
    epic_id: "fn-34-q-with-tasks",
    task_number: 1,
    title: "t1",
  });
  drainAll();
  expect(getTask("fn-34-q-with-tasks.1")).not.toBeNull();

  epicSnapshotEvent("fn-34-q-with-tasks", {
    epic_number: 34,
    status: "open",
    question: "ship or hold?",
  });
  drainAll();
  expect(getEpicQuestion("fn-34-q-with-tasks")).toBe("ship or hold?");
  expect(getTask("fn-34-q-with-tasks.1")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Schema v46 / fn-666 — plan-file attribution mint
// ---------------------------------------------------------------------------

test("plan mint: scaffold envelope mints source='plan' file_attributions for every named file", () => {
  // A keeper plan scaffold envelope carries a `files[]` of the JSON/spec paths
  // plan wrote. The reducer's mint fold lands one file_attributions row
  // per path, keyed under (state_repo, session, path), source='plan',
  // last_mutation_at=event.ts.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-mint" });
  const eventId = planEvent({
    sessionId: "sess-mint",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-mint",
    files: [
      ".keeper/epics/fn-1-foo.json",
      ".keeper/meta.json",
      ".keeper/specs/fn-1-foo.md",
      ".keeper/tasks/fn-1-foo.1.json",
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
    expect(r.source).toBe("plan");
    expect(r.op).toBe("scaffold");
    expect(r.last_mutation_at).toBe(555);
    expect(r.last_event_id).toBe(eventId);
  }
  expect(rows.map((r) => r.file_path)).toEqual([
    ".keeper/epics/fn-1-foo.json",
    ".keeper/meta.json",
    ".keeper/specs/fn-1-foo.md",
    ".keeper/tasks/fn-1-foo.1.json",
  ]);
});

test("plan mint: plan_invocation envelope mints source='plan' file_attributions", () => {
  // An envelope inlined under the `plan_invocation` key mints `source='plan'`
  // file_attributions. Single-path post-v78: the deriver reads only
  // `plan_invocation`; the migration rewrote any pre-flip stored row to match.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-mint-renamed" });
  const eventId = planEvent({
    sessionId: "sess-mint-renamed",
    op: "scaffold",
    target: "fn-2-bar",
    epicId: "fn-2-bar",
    subjectPresent: true,
    stateRepo: "/repo-mint-renamed",
    files: [".keeper/epics/fn-2-bar.json", ".keeper/meta.json"],
    ts: 777,
  });
  drainAll();
  const rows = db
    .query(
      `SELECT file_path, source, op, last_mutation_at, last_event_id
         FROM file_attributions
        WHERE project_dir = ? AND session_id = ?
        ORDER BY file_path`,
    )
    .all("/repo-mint-renamed", "sess-mint-renamed") as Array<{
    file_path: string;
    source: string;
    op: string;
    last_mutation_at: number;
    last_event_id: number;
  }>;
  expect(rows.length).toBe(2);
  for (const r of rows) {
    expect(r.source).toBe("plan");
    expect(r.op).toBe("scaffold");
    expect(r.last_mutation_at).toBe(777);
    expect(r.last_event_id).toBe(eventId);
  }
  expect(rows.map((r) => r.file_path)).toEqual([
    ".keeper/epics/fn-2-bar.json",
    ".keeper/meta.json",
  ]);
});

test("plan mint: null plan_files (read-only verb) mints no rows", () => {
  // A read-only verb (`keeper plan epics`) writes no files — the envelope's
  // `files` field is null, the deriver lifts to null, the mint is a no-op.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-readonly" });
  planEvent({
    sessionId: "sess-readonly",
    op: "epics",
    target: null,
    epicId: null,
    subjectPresent: false,
    // No files / stateRepo passed → plan_files=null, data='{}'.
  });
  drainAll();
  const count = (
    db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
});

test("plan mint: empty plan_files array mints no rows (defensive)", () => {
  // Should never happen at hook write time (the deriver folds empty to
  // null), but a backfill bug could theoretically write `[]` — the
  // reducer's `length > 0` guard catches it.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-empty" });
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-empty",
    tool_name: "Bash",
    plan_op: "scaffold",
    plan_target: "fn-1-foo",
    plan_epic_id: "fn-1-foo",
    plan_subject_present: 1,
    plan_files: "[]",
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

test("plan mint: missing state_repo (corrupt envelope) mints no rows", () => {
  // Defensive: a plan event whose envelope payload doesn't carry
  // state_repo (corrupt envelope or pre-fn-666 historical row) lands no
  // attributions. The mint silently no-ops, cursor still advances.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-norepo" });
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-norepo",
    tool_name: "Bash",
    plan_op: "scaffold",
    plan_target: "fn-1-foo",
    plan_epic_id: "fn-1-foo",
    plan_subject_present: 1,
    plan_files: JSON.stringify([".keeper/epics/fn-1-foo.json"]),
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

test("plan mint: malformed event.data folds to no-op (safe value invariant)", () => {
  // CLAUDE.md "a malformed `data` blob folds to a safe value" — the mint
  // catches the JSON.parse exception, falls to null state_repo, no-ops.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-garbage" });
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-garbage",
    tool_name: "Bash",
    plan_op: "scaffold",
    plan_target: "fn-1-foo",
    plan_epic_id: "fn-1-foo",
    plan_subject_present: 1,
    plan_files: JSON.stringify([".keeper/epics/fn-1-foo.json"]),
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

test("plan mint: malformed plan_files JSON folds to no-op", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-badjson" });
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "sess-badjson",
    tool_name: "Bash",
    plan_op: "scaffold",
    plan_target: "fn-1-foo",
    plan_epic_id: "fn-1-foo",
    plan_subject_present: 1,
    plan_files: "not valid json",
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

test("plan mint: absolute path in files[] is filtered out", () => {
  // Defensive: plan emits repo-relative paths, but a corrupt envelope
  // might carry an absolute path. The mint skips it (would never match the
  // dirty_files[].path tuple downstream, would strand as an orphan
  // attribution forever).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-abs" });
  planEvent({
    sessionId: "sess-abs",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-abs",
    files: [
      "/abs/path/spec.md", // skipped
      ".keeper/epics/fn-1-foo.json", // minted
    ],
  });
  drainAll();
  const rows = db
    .query("SELECT file_path FROM file_attributions ORDER BY file_path")
    .all() as Array<{ file_path: string }>;
  expect(rows.map((r) => r.file_path)).toEqual([".keeper/epics/fn-1-foo.json"]);
});

test("plan mint: path with `..` traversal is filtered out (defensive)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-trav" });
  planEvent({
    sessionId: "sess-trav",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-trav",
    files: ["../outside.md", ".keeper/specs/fn-1-foo.md"],
  });
  drainAll();
  const rows = db
    .query("SELECT file_path FROM file_attributions ORDER BY file_path")
    .all() as Array<{ file_path: string }>;
  expect(rows.map((r) => r.file_path)).toEqual([".keeper/specs/fn-1-foo.md"]);
});

test("plan mint: GitSnapshot following a mint renders the plan-source attribution (not orphan)", () => {
  // The end-to-end orphan-fix proof. A plan mint lands the
  // file_attributions row; the next GitSnapshot on a dirty .planctl file
  // surfaces it through pass-3 render (source='plan' badge), NOT
  // through the orphan_count rollup.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-snap" });
  planEvent({
    sessionId: "sess-snap",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-snap",
    files: [".keeper/epics/fn-1-foo.json"],
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
          path: ".keeper/epics/fn-1-foo.json",
          xy: "??",
          mtime_ms: null,
        },
      ],
    }),
  });
  drainAll();
  // The git_status row's attributions array carries the plan mint.
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
      source: "plan",
      op: "scaffold",
    }),
  );
});

test("plan mint: a plan file does NOT also get an inferred attribution (guard widened)", () => {
  // The pass-2 inferred-guard covers `IN ('tool','bash','plan')`
  // so a plan-attributed file is NOT also bracketed against this
  // session's Bash windows. Without that, the file would receive
  // TWO active attribution rows — `plan` AND `inferred` — which would
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
  // Plan event INSIDE the window, mints the file_attributions row.
  planEvent({
    sessionId: "sess-both",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-both",
    files: [".keeper/epics/fn-1-foo.json"],
    ts: 1000,
  });
  // GitSnapshot triggers pass-2 inference; the plan row should suppress
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
          path: ".keeper/epics/fn-1-foo.json",
          xy: "??",
          mtime_ms: 1050 * 1000, // inside the bash window
        },
      ],
    }),
  });
  drainAll();
  // Only ONE row, source='plan' — NOT plan + inferred.
  const rows = db
    .query(
      `SELECT source, op FROM file_attributions
        WHERE project_dir = ? AND session_id = ?
          AND file_path = ?
        ORDER BY source`,
    )
    .all("/repo-both", "sess-both", ".keeper/epics/fn-1-foo.json") as Array<{
    source: string;
    op: string;
  }>;
  expect(rows).toEqual([{ source: "plan", op: "scaffold" }]);
});

test("plan mint: re-fold determinism — cursor=0 reproduces byte-identical file_attributions", () => {
  // Drive a plan-op + snapshot + commit sequence, capture the
  // projection, rewind cursor + wipe table, re-fold from scratch, assert
  // byte-identical rows. The re-fold determinism invariant for the new
  // mint path.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rd", ts: 100 });
  planEvent({
    sessionId: "sess-rd",
    op: "scaffold",
    target: "fn-1-foo",
    epicId: "fn-1-foo",
    subjectPresent: true,
    stateRepo: "/repo-rd",
    files: [".keeper/epics/fn-1-foo.json", ".keeper/specs/fn-1-foo.md"],
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
        { path: ".keeper/epics/fn-1-foo.json", xy: "??", mtime_ms: null },
        { path: ".keeper/specs/fn-1-foo.md", xy: "??", mtime_ms: null },
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
  //
  // fn-907 precedence flip: the env `backend_exec_session_id` now lands in the
  // FORENSIC `backend_exec_birth_session_id` (COALESCE-fill, written once), NOT
  // the LIVE `backend_exec_session_id` (owned solely by the TmuxTopologySnapshot
  // fold). `backend_exec_type` + `backend_exec_pane_id` stay pure env reads.
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
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_birth_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("sess-be") as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_birth_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.backend_exec_type).toBe("tmux");
  // The env session is FORENSIC now — it lands in birth, never the live column.
  expect(row?.backend_exec_birth_session_id).toBe("mike-main");
  // Live session stays NULL until a TmuxTopologySnapshot resolves it.
  expect(row?.backend_exec_session_id).toBeNull();
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
  // Confirm seed landed (env session → birth column under fn-907).
  const seeded = db
    .query(
      "SELECT backend_exec_type, backend_exec_birth_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("sess-stick") as {
    backend_exec_type: string | null;
    backend_exec_birth_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
  expect(seeded?.backend_exec_type).toBe("tmux");
  expect(seeded?.backend_exec_birth_session_id).toBe("mike-main");
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
      "SELECT backend_exec_type, backend_exec_birth_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("sess-stick") as {
    backend_exec_type: string | null;
    backend_exec_birth_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
  expect(after?.backend_exec_type).toBe("tmux");
  expect(after?.backend_exec_birth_session_id).toBe("mike-main");
  expect(after?.backend_exec_pane_id).toBe("7");
});

test("partial backend_exec capture: COALESCE preserves the non-null field, advances the other", () => {
  // A partial capture (type + session set, pane NULL) must preserve the
  // prior pane. This covers the "one sub-var temporarily absent" edge case
  // the task spec explicitly calls out.
  //
  // fn-907: the env session is birth-COALESCE-fill (write-once). A LATER env
  // session change does NOT re-clobber birth (the env is constant per process,
  // so a real change can only be a different process/job). Birth holds the FIRST
  // env value; the live session column is untouched by this arm.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-part",
    backend_exec_type: "tmux",
    backend_exec_session_id: "mike-main",
    backend_exec_pane_id: "7",
  });
  // Partial: type set (gate fires), session env differs, pane NULL —
  // pane must remain '7' under COALESCE; birth holds the first value.
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
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_birth_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("sess-part") as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_birth_session_id: string | null;
    backend_exec_pane_id: string | null;
  } | null;
  expect(row?.backend_exec_type).toBe("tmux");
  // birth is write-once: the first env value wins, the second does not clobber.
  expect(row?.backend_exec_birth_session_id).toBe("mike-main");
  // live session never written by the env arm.
  expect(row?.backend_exec_session_id).toBeNull();
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
// TmuxTopologySnapshot live-location fold (fn-907). The SOLE owner of
// `backend_exec_session_id` + `window_index` — overwrites each matching LIVE
// tmux job, recycle-guarded on `(generation_id, pane_id)`, gated above the tmux
// skip-floor, preserving last-known on absent panes / NULL indices.
// ---------------------------------------------------------------------------

/** Seed a live tmux job (SessionStart with backend coords) and drain. The env
 *  arm stamps `backend_exec_type='tmux'` + `backend_exec_pane_id`; the live
 *  `backend_exec_session_id` + `backend_exec_generation_id` start NULL (only the
 *  topology fold writes them). Returns the seeded job_id. */
function seedTmuxJob(jobId: string, paneId: string): string {
  insertEvent({
    hook_event: "SessionStart",
    session_id: jobId,
    backend_exec_type: "tmux",
    backend_exec_session_id: "launch-sess",
    backend_exec_pane_id: paneId,
  });
  drainAll();
  return jobId;
}

/** Insert one synthetic TmuxTopologySnapshot event carrying `{generation_id,
 *  panes}`, mirroring what the daemon mints. Returns the event id. */
function tmuxTopologyEvent(
  generationId: string,
  panes: Array<{
    pane_id: string;
    session_name: string;
    window_index: number | null;
  }>,
): number {
  return insertEvent({
    hook_event: "TmuxTopologySnapshot",
    session_id: "tmux-topology-snapshot",
    data: JSON.stringify({ generation_id: generationId, panes }),
  });
}

function getTmuxLocation(jobId: string) {
  return db
    .query(
      "SELECT backend_exec_session_id, backend_exec_generation_id, window_index, state FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as {
    backend_exec_session_id: string | null;
    backend_exec_generation_id: string | null;
    window_index: number | null;
    state: string;
  } | null;
}

test("TmuxTopologySnapshot overwrites a live job's session + window_index and adopts the generation", () => {
  seedTmuxJob("topo-1", "%5");
  // Pre-fold: live session NULL (env routes to birth), generation NULL.
  const before = getTmuxLocation("topo-1");
  expect(before?.backend_exec_session_id).toBeNull();
  expect(before?.backend_exec_generation_id).toBeNull();

  tmuxTopologyEvent("gen-100", [
    { pane_id: "%5", session_name: "foreground", window_index: 3 },
  ]);
  drainAll();

  const after = getTmuxLocation("topo-1");
  // Live session overwritten, window index set, generation adopted on first match.
  expect(after?.backend_exec_session_id).toBe("foreground");
  expect(after?.window_index).toBe(3);
  expect(after?.backend_exec_generation_id).toBe("gen-100");

  // A second snapshot of the SAME generation moves the pane again — overwrite.
  tmuxTopologyEvent("gen-100", [
    { pane_id: "%5", session_name: "background", window_index: 7 },
  ]);
  drainAll();
  const moved = getTmuxLocation("topo-1");
  expect(moved?.backend_exec_session_id).toBe("background");
  expect(moved?.window_index).toBe(7);
  expect(moved?.backend_exec_generation_id).toBe("gen-100");
});

test("TmuxTopologySnapshot recycle guard: a NEW generation never overwrites a prior-generation job", () => {
  seedTmuxJob("topo-recycle", "%9");
  // First snapshot adopts generation gen-A and sets the location.
  tmuxTopologyEvent("gen-A", [
    { pane_id: "%9", session_name: "alpha", window_index: 1 },
  ]);
  drainAll();
  const adopted = getTmuxLocation("topo-recycle");
  expect(adopted?.backend_exec_session_id).toBe("alpha");
  expect(adopted?.backend_exec_generation_id).toBe("gen-A");

  // A recycled %9 in a NEW tmux server (gen-B) reuses the pane id but is a
  // DIFFERENT pane. The recycle guard must reject the overwrite — gen-A's job
  // keeps alpha/1.
  tmuxTopologyEvent("gen-B", [
    { pane_id: "%9", session_name: "stranger", window_index: 42 },
  ]);
  drainAll();
  const guarded = getTmuxLocation("topo-recycle");
  expect(guarded?.backend_exec_session_id).toBe("alpha");
  expect(guarded?.window_index).toBe(1);
  expect(guarded?.backend_exec_generation_id).toBe("gen-A");
});

test("TmuxTopologySnapshot upgrades a pid-only live generation for the same pane", () => {
  seedTmuxJob("topo-generation-upgrade", "%8");
  tmuxTopologyEvent("123", [
    { pane_id: "%8", session_name: "pid-only", window_index: 1 },
  ]);
  drainAll();
  expect(
    getTmuxLocation("topo-generation-upgrade")?.backend_exec_generation_id,
  ).toBe("123");

  tmuxTopologyEvent("123:456", [
    { pane_id: "%8", session_name: "composite", window_index: 2 },
  ]);
  drainAll();
  const upgraded = getTmuxLocation("topo-generation-upgrade");
  expect(upgraded?.backend_exec_session_id).toBe("composite");
  expect(upgraded?.window_index).toBe(2);
  expect(upgraded?.backend_exec_generation_id).toBe("123:456");
});

test("TmuxTopologySnapshot preserves last-known on an absent pane and a NULL window_index", () => {
  seedTmuxJob("topo-preserve", "%3");
  tmuxTopologyEvent("gen-X", [
    { pane_id: "%3", session_name: "home", window_index: 5 },
  ]);
  drainAll();
  expect(getTmuxLocation("topo-preserve")?.window_index).toBe(5);

  // A later snapshot whose pane is ABSENT (e.g. a transient probe that saw other
  // panes but not this one) must NOT wipe the job — no matching pane, no UPDATE.
  tmuxTopologyEvent("gen-X", [
    { pane_id: "%99", session_name: "elsewhere", window_index: 0 },
  ]);
  drainAll();
  const stillThere = getTmuxLocation("topo-preserve");
  expect(stillThere?.backend_exec_session_id).toBe("home");
  expect(stillThere?.window_index).toBe(5);

  // A snapshot carrying the pane but a NULL window_index (the producer could not
  // read a valid integer): session overwrites, window_index COALESCEs to the
  // last-known good value — never wiped (crash-restore sorting depends on it).
  tmuxTopologyEvent("gen-X", [
    { pane_id: "%3", session_name: "relocated", window_index: null },
  ]);
  drainAll();
  const coalesced = getTmuxLocation("topo-preserve");
  expect(coalesced?.backend_exec_session_id).toBe("relocated");
  expect(coalesced?.window_index).toBe(5);
});

test("TmuxTopologySnapshot does NOT touch a killed job (recycle-guard live-state filter)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "topo-dead",
    backend_exec_type: "tmux",
    backend_exec_session_id: "launch-sess",
    backend_exec_pane_id: "%4",
  });
  // Kill the job — the (pid, start_time) payload matches the seeded row.
  insertEvent({
    hook_event: "Killed",
    session_id: "topo-dead",
    data: JSON.stringify({ pid: 4242, start_time: null }),
  });
  drainAll();
  expect(getTmuxLocation("topo-dead")?.state).toBe("killed");

  // A recycled %4 in a new server must NOT resurrect the dead row's location or
  // let it adopt the new generation.
  tmuxTopologyEvent("gen-new", [
    { pane_id: "%4", session_name: "ghost", window_index: 9 },
  ]);
  drainAll();
  const dead = getTmuxLocation("topo-dead");
  expect(dead?.backend_exec_session_id).toBeNull();
  expect(dead?.backend_exec_generation_id).toBeNull();
  expect(dead?.window_index).toBeNull();
});

test("TmuxTopologySnapshot below the skip-floor folds to a no-op", () => {
  seedTmuxJob("topo-floor", "%6");
  const evId = tmuxTopologyEvent("gen-Z", [
    { pane_id: "%6", session_name: "should-not-land", window_index: 8 },
  ]);
  // Raise the floor ABOVE this event so the fold gates it out — mirrors a
  // historical snapshot replaying below the boot-seed floor.
  raiseTmuxProjectionFloor(db, evId);
  drainAll();

  const gated = getTmuxLocation("topo-floor");
  // The live location stayed unwritten (the fold no-oped below the floor).
  expect(gated?.backend_exec_session_id).toBeNull();
  expect(gated?.window_index).toBeNull();
});

test("TmuxTopologySnapshot with malformed / no-generation payload folds to a no-op", () => {
  seedTmuxJob("topo-bad", "%2");
  // No generation_id — the recycle guard cannot run, so the whole snapshot is
  // dropped (no overwrite).
  insertEvent({
    hook_event: "TmuxTopologySnapshot",
    session_id: "tmux-topology-snapshot",
    data: JSON.stringify({
      panes: [{ pane_id: "%2", session_name: "x", window_index: 1 }],
    }),
  });
  // Garbage JSON.
  insertEvent({
    hook_event: "TmuxTopologySnapshot",
    session_id: "tmux-topology-snapshot",
    data: "not json{",
  });
  drainAll();
  const row = getTmuxLocation("topo-bad");
  expect(row?.backend_exec_session_id).toBeNull();
  expect(row?.window_index).toBeNull();
});

// ---------------------------------------------------------------------------
// Terminal-state pane/generation clear (fn-977 task .2). A job folding to
// ended/killed must drop its `backend_exec_pane_id` + `backend_exec_generation_id`:
// tmux recycles a pane id `%N`, so a dead job that keeps its stale pane id could
// be mis-attributed as owning the fresh window that later inherits it. The
// post-switch COALESCE arm carries a matching terminal guard so a late hook
// event can't re-stamp the pane in the same (or a later) event.
// ---------------------------------------------------------------------------

function getBackendExec(jobId: string) {
  return db
    .query(
      "SELECT state, backend_exec_pane_id, backend_exec_generation_id FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as {
    state: string;
    backend_exec_pane_id: string | null;
    backend_exec_generation_id: string | null;
  } | null;
}

test("SessionEnd NULLs the backend_exec pane + generation coords (recycle guard)", () => {
  seedTmuxJob("term-end", "%200");
  // Adopt a live generation so we prove BOTH coords clear, not just the pane.
  tmuxTopologyEvent("gen-end", [
    { pane_id: "%200", session_name: "fg", window_index: 2 },
  ]);
  drainAll();
  const live = getBackendExec("term-end");
  expect(live?.backend_exec_pane_id).toBe("%200");
  expect(live?.backend_exec_generation_id).toBe("gen-end");

  // The SessionEnd itself carries the stale env pane id (the hook stamps every
  // event). The terminal arm clears the coords AND the post-switch COALESCE arm
  // must NOT re-stamp them in the same event — proving the terminal guard.
  insertEvent({
    hook_event: "SessionEnd",
    session_id: "term-end",
    backend_exec_type: "tmux",
    backend_exec_session_id: "launch-sess",
    backend_exec_pane_id: "%200",
  });
  drainAll();

  const dead = getBackendExec("term-end");
  expect(dead?.state).toBe("ended");
  expect(dead?.backend_exec_pane_id).toBeNull();
  expect(dead?.backend_exec_generation_id).toBeNull();
});

test("Killed NULLs the backend_exec pane + generation coords (recycle guard)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "term-kill",
    pid: 9191,
    backend_exec_type: "tmux",
    backend_exec_session_id: "launch-sess",
    backend_exec_pane_id: "%201",
  });
  tmuxTopologyEvent("gen-kill", [
    { pane_id: "%201", session_name: "fg", window_index: 4 },
  ]);
  drainAll();
  const live = getBackendExec("term-kill");
  expect(live?.backend_exec_pane_id).toBe("%201");
  expect(live?.backend_exec_generation_id).toBe("gen-kill");

  // The Killed payload matches the seeded (pid, start_time=null) → terminal flip.
  insertEvent({
    hook_event: "Killed",
    session_id: "term-kill",
    data: JSON.stringify({ pid: 9191, start_time: null }),
  });
  drainAll();

  const dead = getBackendExec("term-kill");
  expect(dead?.state).toBe("killed");
  expect(dead?.backend_exec_pane_id).toBeNull();
  expect(dead?.backend_exec_generation_id).toBeNull();
});

test("a late backend_exec event after a job is terminal does NOT re-stamp the pane id", () => {
  seedTmuxJob("term-late", "%202");
  // End the job WITHOUT backend coords on the SessionEnd, so only the terminal
  // arm clears the pane.
  insertEvent({ hook_event: "SessionEnd", session_id: "term-late" });
  drainAll();
  expect(getBackendExec("term-late")?.backend_exec_pane_id).toBeNull();

  // A straggler hook event (e.g. a late Stop the kernel delivered post-end)
  // carries the stale env pane id. The COALESCE arm's terminal guard must reject
  // the re-stamp — a recycled `%202` must never resurrect onto the dead row.
  insertEvent({
    hook_event: "Stop",
    session_id: "term-late",
    backend_exec_type: "tmux",
    backend_exec_session_id: "launch-sess",
    backend_exec_pane_id: "%202",
  });
  drainAll();

  const stillDead = getBackendExec("term-late");
  expect(stillDead?.state).toBe("ended");
  expect(stillDead?.backend_exec_pane_id).toBeNull();
});

test("terminal pane/generation clear is re-fold deterministic: rewind + re-drain reproduces NULL coords", () => {
  seedTmuxJob("term-refold", "%203");
  tmuxTopologyEvent("gen-refold", [
    { pane_id: "%203", session_name: "fg", window_index: 1 },
  ]);
  insertEvent({
    hook_event: "SessionEnd",
    session_id: "term-refold",
    backend_exec_type: "tmux",
    backend_exec_session_id: "launch-sess",
    backend_exec_pane_id: "%203",
  });
  drainAll();
  const pre = getBackendExec("term-refold");
  expect(pre?.state).toBe("ended");
  expect(pre?.backend_exec_pane_id).toBeNull();

  // Rewind cursor + wipe + re-drain. `backend_exec_pane_id` is a
  // deterministic-replayed column, so the post-rewind terminal row must be
  // byte-identical (pane NULL). `backend_exec_generation_id` is live-only (the
  // topology fold no-ops below the boot-seed floor on replay), so it re-folds to
  // NULL on a terminal row too — the SessionEnd clear is a NULL→NULL no-op there.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();

  const post = getBackendExec("term-refold");
  expect(post?.state).toBe("ended");
  expect(post?.backend_exec_pane_id).toBeNull();
  expect(post?.backend_exec_generation_id).toBeNull();
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

test("retired TmuxPaneSnapshot folds to a no-op: a matching tmux job is untouched", () => {
  // fn-907 retired the fn-789 fill-only fold; the arm is now an explicit no-op
  // (the TmuxTopologySnapshot fold owns live session). A historical
  // TmuxPaneSnapshot must advance the cursor WITHOUT routing into projectJobsRow.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-tmux",
    backend_exec_type: "tmux",
    backend_exec_session_id: null,
    backend_exec_pane_id: "%1",
  });
  expect(drainAll()).toBe(1);
  const before = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-tmux");

  const snapId = tmuxPaneSnapshotEvent([
    { pane_id: "%1", session_name: "human-work" },
  ]);
  expect(drainAll()).toBe(1);
  // Cursor advanced (the event is consumed) but the jobs row is byte-identical —
  // proves the no-op arm did NOT fall through to projectJobsRow.
  expect(getCursor()).toBe(snapId);
  const after = db
    .query("SELECT * FROM jobs WHERE job_id = ?")
    .get("sess-tmux");
  expect(after).toEqual(before);
  // The live session stays NULL — only TmuxTopologySnapshot writes it now.
  expect(getBackendCoords("sess-tmux")?.backend_exec_session_id).toBeNull();
});

test("retired TmuxPaneSnapshot against a missing job mints NO jobs row", () => {
  // The no-op arm must not mint a row for the snapshot's synthetic session id —
  // a fall-through to projectJobsRow would have.
  const id = tmuxPaneSnapshotEvent([
    { pane_id: "%1", session_name: "human-work" },
  ]);
  expect(drainAll()).toBe(1);
  expect(getCursor()).toBe(id);
  const row = db
    .query("SELECT job_id FROM jobs WHERE job_id = ?")
    .get("tmux-snapshot");
  expect(row).toBeNull();
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

test("retired TmuxPaneSnapshot in a history: cursor=0 re-fold reproduces byte-identical jobs rows", () => {
  // The retired no-op arm is the load-bearing re-fold invariant: historical
  // TmuxPaneSnapshot events interleaved with real lifecycle events must replay
  // byte-identically (the no-op never touches jobs, so the env-driven coords are
  // the only writer). A cursor=0 re-fold must rebuild the exact same row.
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
  // The retired snapshots no-oped — the live session is NULL (env never wrote it
  // and no TmuxTopologySnapshot ran). birth holds nothing here (env session was
  // NULL on every event).
  expect(
    (before as { backend_exec_session_id: string | null })
      .backend_exec_session_id,
  ).toBeNull();

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

test("fn-818 restore-set burst key invariant: a killed row's last_event_id (the burst-cluster sort key) is NOT moved by a subsequent unrelated fold targeting that row", () => {
  // restore-set.ts keys the crash-burst contiguous-cluster signature on
  // `jobs.last_event_id`, declared as "the Killed event's rowid" — but the
  // column is the GENERIC "last fold that touched this row" value. The burst
  // signature stays correct only because the reducer's terminal guard makes any
  // post-kill fold a no-op (so the column freezes at the Killed event's rowid).
  // That invariant is load-bearing for unknown/legacy-NULL `close_kind` rows
  // (whose only restore signal is burst membership) but is asserted nowhere.
  // This pins it: kill a row, then feed an unrelated Stop (the most common
  // per-event hook) targeting the same session, and assert `last_event_id` is
  // unchanged — the burst-cluster position does not move. The test FAILS if a
  // future late-stamping fold drops the `state NOT IN ('ended','killed')`
  // terminal guard and re-stamps the column.
  insertEvent({
    hook_event: "SessionStart",
    pid: 7373,
    start_time: "stamp-burst",
  });
  drainAll();
  const killId = killedEvent(7373, "stamp-burst");
  drainAll();
  const killed = getJob();
  expect(killed?.state).toBe("killed");
  // The burst key == the Killed event's rowid.
  expect(killed?.last_event_id).toBe(killId);

  // An unrelated Stop targeting the same session: a real per-event hook that
  // would re-stamp `last_event_id` on a live row, but must no-op on a killed
  // one (the terminal guard).
  const stopId = insertEvent({ hook_event: "Stop" });
  drainAll();
  const after = getJob();
  // Still killed, and the burst key did NOT advance to the Stop's rowid.
  expect(after?.state).toBe("killed");
  expect(after?.last_event_id).toBe(killId);
  expect(after?.last_event_id).not.toBe(stopId);
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
// Blob-driven re-fold determinism (post-shed: every body inline in events.data;
// fn-836.4 dropped the event_blobs side table + its COALESCE read plumbing)
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

// Seed one mixed stream exercising EVERY `data`-driven read site: PostToolUse
// mutations (drain SELECT + the `mutation_path` file-attribution scan), a
// GitSnapshot + Commit pair that discharges the attribution (drain SELECT), and
// a `chore(plan)` Commit carrying plan trailers (loadCommitTrailer{
// Invocations,SessionsForEpics}). Returns the discharged PostToolUse event id so
// a test can NULL its now-cold body in place (post-shed retention).
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
  // A `chore(plan)` Commit carrying the fn-695 trailer facts so the
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
      // Commit `data` payload keys (git-worker trailer layer) read by
      // `extractCommit` via `obj.plan_op` (v82 rewrote the historical events to
      // the `plan_*` spelling).
      plan_op: "create",
      plan_target: "fn-1-demo",
      session_id_trailer: TEST_UUID,
    }),
  });
  return { dischargedPostToolUseId };
}

test("blob-driven projections: cursor=0 re-fold is byte-identical (post-shed, bodies inline)", () => {
  // Post-shed every keep-set body is inline in `events.data` and every
  // shed-class mutation's file_path is in `mutation_path`, so a from-scratch
  // re-fold reproduces byte-identical projections (the sacred invariant). The
  // discharged PostToolUse:Write attribution is driven by the `mutation_path`
  // column (auto-derived by `insertEvent`), not the JSON body.
  seedBlobReadStream();
  drainAll();
  const live = snapshotBlobDrivenProjections();

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  expect(snapshotBlobDrivenProjections()).toEqual(live);
});

test("events.data is nullable — retention can NULL a cold non-keep payload in place", () => {
  // The v57→v58 rebuild relaxed `events.data` from NOT NULL → nullable; post-shed
  // (fn-836.4) that relax stands so the steady-state retention pass (fn-836.5)
  // can `UPDATE events SET data = NULL` on a cold non-keep payload IN PLACE (no
  // side table). A shed-class mutation row keeps its `mutation_path` after the
  // body is NULLed — the attribution scan reads the column, not the body.
  const { dischargedPostToolUseId } = seedBlobReadStream();
  drainAll();
  expect(() =>
    db.run("UPDATE events SET data = NULL WHERE id = ?", [
      dischargedPostToolUseId,
    ]),
  ).not.toThrow();
  const row = db
    .query("SELECT data, mutation_path FROM events WHERE id = ?")
    .get(dischargedPostToolUseId) as {
    data: string | null;
    mutation_path: string | null;
  };
  expect(row.data).toBeNull();
  // The promoted column survives the body NULL — the file_path is preserved.
  expect(row.mutation_path).toBe("/repo/cold.ts");
});

test("fn-836.3 idx_events_mutation_path serves the flipped file-attribution scan (EXPLAIN-verified)", () => {
  // The git-attribution tool scan flipped off the JSON body onto the promoted
  // `mutation_path` column (ARM B / event_blobs join deleted). The partial
  // index `idx_events_mutation_path WHERE mutation_path IS NOT NULL` must serve
  // the new `mutation_path = ?` predicate as a SEARCH (sub-ms covering SEEK),
  // never a full table SCAN — `= ?` implies NOT NULL so SQLite picks the
  // partial index. This is the EXACT query `buildExplicitAttribHoist` prepares.
  const plan = db
    .query(
      `EXPLAIN QUERY PLAN
         SELECT id, ts, session_id, tool_name
           FROM events
          WHERE hook_event = 'PostToolUse'
            AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')
            AND mutation_path = ?`,
    )
    .all("/repo/cold.ts") as { detail: string }[];
  const details = plan.map((r) => r.detail);
  const joined = details.join("\n");
  // The partial index is named (a SEARCH/SEEK, not a full scan).
  expect(joined).toContain("idx_events_mutation_path");
  // No plan line is a bare full SCAN of the events table (a covered SEARCH
  // line reads "SEARCH events USING ... idx_events_mutation_path").
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

// ---------------------------------------------------------------------------
// `HandoffRequested` (fn-946 task .2): folds into the durable `handoffs`
// projection (status='requested') AND writes the `handoff-from` HandoffLinkEntry
// onto the initiator job's `handoff_links` array. Pure (no Date.now/env), never
// throws (malformed → no-op), byte-identical re-fold.
// ---------------------------------------------------------------------------

function handoffRequestedEvent(opts: {
  handoff_id: string;
  doc: string;
  title?: string | null;
  target_session?: string | null;
  target_dir?: string | null;
  initiator_session?: string | null;
  initiator_pane?: string | null;
  initiator_job_id?: string | null;
}): number {
  return insertEvent({
    hook_event: "HandoffRequested",
    event_type: "handoffs",
    session_id: opts.handoff_id,
    data: JSON.stringify({
      handoff_id: opts.handoff_id,
      doc: opts.doc,
      title: opts.title ?? null,
      target_session: opts.target_session ?? null,
      target_dir: opts.target_dir ?? null,
      initiator_session: opts.initiator_session ?? null,
      initiator_pane: opts.initiator_pane ?? null,
      initiator_job_id: opts.initiator_job_id ?? null,
    }),
  });
}

/** Seed a jobs row via a SessionStart (the initiator-job substrate). */
function seedJobSession(sessionId: string): number {
  return insertEvent({ hook_event: "SessionStart", session_id: sessionId });
}

function getHandoffs() {
  return db
    .query("SELECT * FROM handoffs ORDER BY handoff_id ASC")
    .all() as Array<{
    handoff_id: string;
    status: string;
    doc: string;
    title: string | null;
    target_session: string | null;
    target_dir: string | null;
    initiator_session: string | null;
    initiator_pane: string | null;
    initiator_job_id: string | null;
    callee_job_id: string | null;
    claimed_at: number | null;
    never_bound_count: number;
    last_event_id: number;
  }>;
}

test("zero-event projection: a fresh DB has zero handoffs rows (fn-946)", () => {
  const n = (
    db.query("SELECT COUNT(*) AS n FROM handoffs").get() as { n: number }
  ).n;
  expect(n).toBe(0);
});

test("HandoffRequested folds into a handoffs row status=requested + advances the cursor (fn-946)", () => {
  const eventId = handoffRequestedEvent({
    handoff_id: "h-1",
    doc: "investigate X; context: ...",
    title: "explore X",
    target_session: "work",
    target_dir: "/Users/dev/code/other",
    initiator_session: "dash",
    initiator_pane: "%7",
  });
  expect(drainAll()).toBeGreaterThanOrEqual(1);
  const rows = getHandoffs();
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({
    handoff_id: "h-1",
    status: "requested",
    doc: "investigate X; context: ...",
    title: "explore X",
    target_session: "work",
    target_dir: "/Users/dev/code/other",
    initiator_session: "dash",
    initiator_pane: "%7",
    initiator_job_id: null,
    callee_job_id: null,
    claimed_at: null,
    never_bound_count: 0,
    last_event_id: eventId,
  });
  expect(getCursor()).toBe(eventId);
});

test("HandoffRequested without a target_dir folds to NULL (pre-v96 re-fold safety) (fn-1003)", () => {
  // A pre-feature event's data carries NO `target_dir` key — the fold must land
  // the column NULL byte-identically (re-fold determinism for old log entries).
  insertEvent({
    hook_event: "HandoffRequested",
    event_type: "handoffs",
    session_id: "h-nodir",
    data: JSON.stringify({
      handoff_id: "h-nodir",
      doc: "legacy handoff with no target_dir",
      title: null,
      target_session: "work",
      initiator_session: null,
      initiator_pane: null,
      initiator_job_id: null,
    }),
  });
  drainAll();
  const rows = getHandoffs();
  expect(rows.length).toBe(1);
  expect(rows[0]?.target_dir).toBeNull();
});

test("HandoffRequested writes the handoff-from link onto the initiator job (fn-946)", () => {
  seedJobSession("job-init");
  handoffRequestedEvent({
    handoff_id: "h-2",
    doc: "do Y",
    target_session: "work",
    initiator_job_id: "job-init",
  });
  drainAll();
  const job = db
    .query("SELECT handoff_links FROM jobs WHERE job_id = ?")
    .get("job-init") as { handoff_links: string };
  const links = JSON.parse(job.handoff_links) as Array<{
    kind: string;
    handoff_id: string;
    peer_job_id: string;
    status: string;
  }>;
  expect(links.length).toBe(1);
  expect(links[0]).toMatchObject({
    kind: "handoff-from",
    handoff_id: "h-2",
    peer_job_id: "",
    status: "requested",
  });
});

test("HandoffRequested with a null/orphan initiator_job_id writes the row but no from-link (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "h-3",
    doc: "orphan",
    target_session: "work",
    initiator_job_id: null,
  });
  drainAll();
  const rows = getHandoffs();
  expect(rows.length).toBe(1);
  expect(rows[0]?.initiator_job_id).toBeNull();
  // No jobs row was seeded → no from-link to write; the row still lands.
});

test("HandoffRequested from-link is a no-op when the initiator job isn't yet folded (fn-946)", () => {
  // initiator_job_id is set but the backing jobs row does not exist (the pane
  // hasn't folded a SessionStart). The handoffs row lands; no orphan write.
  handoffRequestedEvent({
    handoff_id: "h-4",
    doc: "unfolded initiator",
    target_session: "work",
    initiator_job_id: "job-not-yet-folded",
  });
  drainAll();
  expect(getHandoffs().length).toBe(1);
  const job = db
    .query("SELECT job_id FROM jobs WHERE job_id = ?")
    .get("job-not-yet-folded");
  expect(job).toBeNull();
});

test("HandoffRequested with a malformed payload is a safe no-op (cursor still advances) (fn-946)", () => {
  const id = insertEvent({
    hook_event: "HandoffRequested",
    event_type: "handoffs",
    session_id: "h-bad",
    data: "{not json",
  });
  expect(drainAll()).toBeGreaterThanOrEqual(1);
  expect(getHandoffs().length).toBe(0);
  expect(getCursor()).toBe(id);
});

test("HandoffRequested missing handoff_id/doc folds to a no-op (fn-946)", () => {
  insertEvent({
    hook_event: "HandoffRequested",
    event_type: "handoffs",
    session_id: "h-bad2",
    data: JSON.stringify({ doc: "no id" }),
  });
  insertEvent({
    hook_event: "HandoffRequested",
    event_type: "handoffs",
    session_id: "h-bad3",
    data: JSON.stringify({ handoff_id: "h-bad3" }),
  });
  drainAll();
  expect(getHandoffs().length).toBe(0);
});

test("from-scratch re-fold reproduces handoffs + jobs.handoff_links byte-identically (fn-946)", () => {
  seedJobSession("job-a");
  seedJobSession("job-b");
  handoffRequestedEvent({
    handoff_id: "hr-1",
    doc: "first brief",
    title: "first",
    target_session: "work",
    initiator_session: "dash",
    initiator_pane: "%1",
    initiator_job_id: "job-a",
  });
  handoffRequestedEvent({
    handoff_id: "hr-2",
    doc: "second brief",
    target_session: "work",
    initiator_job_id: "job-b",
  });
  // A re-request on the same id (idempotency-key UPSERT) refreshes the requested
  // fields without doubling the row or the from-link.
  handoffRequestedEvent({
    handoff_id: "hr-1",
    doc: "first brief (revised)",
    title: "first revised",
    target_session: "work",
    initiator_session: "dash",
    initiator_pane: "%1",
    initiator_job_id: "job-a",
  });
  drainAll();
  const handoffsBefore = getHandoffs();
  const jobsBefore = db
    .query(
      "SELECT job_id, handoff_links FROM jobs WHERE handoff_links != '[]' ORDER BY job_id ASC",
    )
    .all();
  // Sanity: the UPSERT collapsed to one row per id with the revised doc.
  expect(handoffsBefore.length).toBe(2);
  expect(handoffsBefore.find((r) => r.handoff_id === "hr-1")?.doc).toBe(
    "first brief (revised)",
  );

  // Rewind + wipe handoffs + jobs + re-drain → byte-identical.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM handoffs");
  db.run("DELETE FROM jobs");
  drainAll();
  const handoffsAfter = getHandoffs();
  const jobsAfter = db
    .query(
      "SELECT job_id, handoff_links FROM jobs WHERE handoff_links != '[]' ORDER BY job_id ASC",
    )
    .all();
  expect(handoffsAfter).toEqual(handoffsBefore);
  expect(jobsAfter).toEqual(jobsBefore);
});

// ---------------------------------------------------------------------------
// `HandoffDispatching` / `HandoffLaunchFailed` (fn-946 task .3): the dispatcher's
// transactional-outbox lifecycle, folded onto the same `handoffs` row. Plus the
// `handoff::<id>` SessionStart bind arm (callee_job_id + status=bound + to-link).
// All time is event-ts-derived (claimed_at); folds never throw; re-fold identical.
// ---------------------------------------------------------------------------

function handoffDispatchingEvent(handoffId: string, ts?: number): number {
  return insertEvent({
    hook_event: "HandoffDispatching",
    event_type: "handoffs",
    session_id: handoffId,
    ...(ts !== undefined ? { ts } : {}),
    data: JSON.stringify({ handoff_id: handoffId }),
  });
}

function handoffLaunchFailedEvent(handoffId: string, reason: string): number {
  return insertEvent({
    hook_event: "HandoffLaunchFailed",
    event_type: "handoffs",
    session_id: handoffId,
    data: JSON.stringify({ handoff_id: handoffId, reason }),
  });
}

/** Seed a SessionStart bound to a handoff (the handoff-ee's `handoff::<id>` name). */
function bindHandoffSession(handoffId: string, calleeJobId: string): number {
  return insertEvent({
    hook_event: "SessionStart",
    session_id: calleeJobId,
    spawn_name: `handoff::${handoffId}`,
  });
}

test("HandoffDispatching advances the row to dispatching + stamps claimed_at from event ts (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "d-1",
    doc: "x",
    target_session: "work",
  });
  drainAll();
  const id = handoffDispatchingEvent("d-1", 1_700_000_111);
  drainAll();
  const row = getHandoffs().find((r) => r.handoff_id === "d-1");
  expect(row).toMatchObject({
    handoff_id: "d-1",
    status: "dispatching",
    claimed_at: 1_700_000_111,
    never_bound_count: 1,
    last_event_id: id,
  });
});

test("a handoff:: SessionStart binds callee_job_id + status=bound + resets never_bound_count (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "b-1",
    doc: "x",
    target_session: "work",
  });
  handoffDispatchingEvent("b-1");
  drainAll();
  bindHandoffSession("b-1", "callee-job-1");
  drainAll();
  const row = getHandoffs().find((r) => r.handoff_id === "b-1");
  expect(row).toMatchObject({
    handoff_id: "b-1",
    status: "bound",
    callee_job_id: "callee-job-1",
    never_bound_count: 0,
  });
});

test("a handoff:: SessionStart writes the handoff-to link on the callee job (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "b-2",
    doc: "x",
    target_session: "work",
  });
  drainAll();
  bindHandoffSession("b-2", "callee-job-2");
  drainAll();
  const job = db
    .query("SELECT handoff_links FROM jobs WHERE job_id = ?")
    .get("callee-job-2") as { handoff_links: string };
  const links = JSON.parse(job.handoff_links) as Array<{
    kind: string;
    handoff_id: string;
    status: string;
  }>;
  expect(links.length).toBe(1);
  expect(links[0]).toMatchObject({
    kind: "handoff-to",
    handoff_id: "b-2",
    status: "bound",
  });
});

test("the bind re-stamps the initiator's handoff-from peer to the bound callee (fn-946)", () => {
  seedJobSession("initiator-job");
  handoffRequestedEvent({
    handoff_id: "b-3",
    doc: "x",
    target_session: "work",
    initiator_job_id: "initiator-job",
  });
  drainAll();
  bindHandoffSession("b-3", "callee-job-3");
  drainAll();
  const job = db
    .query("SELECT handoff_links FROM jobs WHERE job_id = ?")
    .get("initiator-job") as { handoff_links: string };
  const links = JSON.parse(job.handoff_links) as Array<{
    kind: string;
    handoff_id: string;
    peer_job_id: string;
    status: string;
  }>;
  const fromLink = links.find((l) => l.kind === "handoff-from");
  expect(fromLink).toMatchObject({
    handoff_id: "b-3",
    peer_job_id: "callee-job-3", // was "" at request time, now the bound callee
    status: "bound",
  });
});

test("a plan:: SessionStart does NOT touch any handoffs row (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "b-4",
    doc: "x",
    target_session: "work",
  });
  drainAll();
  // A non-handoff spawn name must never bind — the handoff:: parser rejects it.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "plan-job",
    spawn_name: "work::fn-1-foo.2",
  });
  drainAll();
  const row = getHandoffs().find((r) => r.handoff_id === "b-4");
  expect(row?.status).toBe("requested");
  expect(row?.callee_job_id).toBeNull();
});

test("never-bound breaker: K=3 consecutive HandoffDispatching with no bind → sticky failed (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "k-1",
    doc: "x",
    target_session: "work",
  });
  drainAll();
  handoffDispatchingEvent("k-1");
  handoffDispatchingEvent("k-1");
  drainAll();
  // Two dispatches, still trying.
  expect(getHandoffs().find((r) => r.handoff_id === "k-1")?.status).toBe(
    "dispatching",
  );
  handoffDispatchingEvent("k-1"); // the 3rd
  drainAll();
  const row = getHandoffs().find((r) => r.handoff_id === "k-1");
  expect(row?.status).toBe("failed");
  expect(row?.never_bound_count).toBe(3);
});

test("a bind between dispatches resets the counter so the breaker never trips (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "k-2",
    doc: "x",
    target_session: "work",
  });
  handoffDispatchingEvent("k-2");
  handoffDispatchingEvent("k-2");
  drainAll();
  bindHandoffSession("k-2", "callee-k2"); // resets count to 0, status=bound
  drainAll();
  // A later stray dispatch on a bound row is ignored (terminal/settled).
  handoffDispatchingEvent("k-2");
  drainAll();
  const row = getHandoffs().find((r) => r.handoff_id === "k-2");
  expect(row?.status).toBe("bound");
  expect(row?.never_bound_count).toBe(0);
});

test("HandoffLaunchFailed flips the row to terminal failed (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "f-1",
    doc: "x",
    target_session: "work",
  });
  handoffDispatchingEvent("f-1");
  drainAll();
  handoffLaunchFailedEvent("f-1", "keeper agent exit 3");
  drainAll();
  expect(getHandoffs().find((r) => r.handoff_id === "f-1")?.status).toBe(
    "failed",
  );
});

test("HandoffLaunchFailed does NOT knock a bound handoff terminal (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "f-2",
    doc: "x",
    target_session: "work",
  });
  drainAll();
  bindHandoffSession("f-2", "callee-f2");
  drainAll();
  // A launch-failure mint racing a successful bind must leave the live one bound.
  handoffLaunchFailedEvent("f-2", "stale launch error");
  drainAll();
  expect(getHandoffs().find((r) => r.handoff_id === "f-2")?.status).toBe(
    "bound",
  );
});

test("malformed HandoffDispatching/HandoffLaunchFailed fold to safe no-ops (fn-946)", () => {
  handoffRequestedEvent({
    handoff_id: "m-1",
    doc: "x",
    target_session: "work",
  });
  drainAll();
  insertEvent({
    hook_event: "HandoffDispatching",
    event_type: "handoffs",
    session_id: "m-1",
    data: "{not json",
  });
  const lastId = insertEvent({
    hook_event: "HandoffLaunchFailed",
    event_type: "handoffs",
    session_id: "m-1",
    data: JSON.stringify({ reason: "no id" }),
  });
  expect(drainAll()).toBeGreaterThanOrEqual(1);
  // Row untouched (still requested); cursor advanced past the malformed events.
  expect(getHandoffs().find((r) => r.handoff_id === "m-1")?.status).toBe(
    "requested",
  );
  expect(getCursor()).toBe(lastId);
});

test("from-scratch re-fold reproduces the full handoff lifecycle byte-identically (fn-946)", () => {
  seedJobSession("rf-init");
  handoffRequestedEvent({
    handoff_id: "rf-1",
    doc: "brief",
    target_session: "work",
    initiator_job_id: "rf-init",
  });
  handoffDispatchingEvent("rf-1", 1_700_000_500);
  bindHandoffSession("rf-1", "rf-callee");
  // A second handoff that goes to the never-bound breaker.
  handoffRequestedEvent({ handoff_id: "rf-2", doc: "b2", target_session: "x" });
  handoffDispatchingEvent("rf-2", 1_700_000_600);
  handoffDispatchingEvent("rf-2", 1_700_000_700);
  handoffDispatchingEvent("rf-2", 1_700_000_800);
  drainAll();
  const handoffsBefore = getHandoffs();
  const jobsBefore = db
    .query(
      "SELECT job_id, handoff_links FROM jobs WHERE handoff_links != '[]' ORDER BY job_id ASC",
    )
    .all();
  // Sanity: rf-1 bound, rf-2 tripped the breaker.
  expect(handoffsBefore.find((r) => r.handoff_id === "rf-1")?.status).toBe(
    "bound",
  );
  expect(handoffsBefore.find((r) => r.handoff_id === "rf-2")?.status).toBe(
    "failed",
  );

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM handoffs");
  db.run("DELETE FROM jobs");
  drainAll();
  expect(getHandoffs()).toEqual(handoffsBefore);
  expect(
    db
      .query(
        "SELECT job_id, handoff_links FROM jobs WHERE handoff_links != '[]' ORDER BY job_id ASC",
      )
      .all(),
  ).toEqual(jobsBefore);
});

// ---------------------------------------------------------------------------
// SessionTelemetry — statusLine telemetry fold onto the six v100 jobs columns
// (fn-1024). Jobs-only, latest-wins, COALESCE-merge; NEVER touches
// state/active_since; NO phantom-row mint before SessionStart; malformed → safe
// no-op.
// ---------------------------------------------------------------------------

/** Build a `SessionTelemetry` event's `data` blob (the wire shape main serializes). */
function telemetryBlob(fields: {
  model_id?: string | null;
  model_display?: string | null;
  effort?: string | null;
  used_percentage?: number | null;
  input_tokens?: number | null;
  window_size?: number | null;
}): string {
  return JSON.stringify({
    model_id: fields.model_id ?? null,
    model_display: fields.model_display ?? null,
    effort: fields.effort ?? null,
    used_percentage: fields.used_percentage ?? null,
    input_tokens: fields.input_tokens ?? null,
    window_size: fields.window_size ?? null,
  });
}

interface TelemetryRow {
  state: string;
  active_since: number | null;
  current_model_id: string | null;
  current_model_display: string | null;
  current_effort: string | null;
  context_used_percentage: number | null;
  context_input_tokens: number | null;
  context_window_size: number | null;
}

function telemetryRow(session_id: string): TelemetryRow | null {
  return db
    .query(
      `SELECT state, active_since, current_model_id, current_model_display,
              current_effort, context_used_percentage, context_input_tokens,
              context_window_size
         FROM jobs WHERE job_id = ?`,
    )
    .get(session_id) as TelemetryRow | null;
}

test("SessionTelemetry folds onto the six jobs columns and NEVER touches state/active_since (fn-1024)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-t1" });
  // UserPromptSubmit flips stopped→working and stamps active_since — a live,
  // non-terminal row with a non-NULL active_since to prove the arm leaves both.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-t1" });
  drainAll();
  const before = telemetryRow("sess-t1");
  expect(before?.active_since).not.toBeNull();

  insertEvent({
    hook_event: "SessionTelemetry",
    session_id: "sess-t1",
    data: telemetryBlob({
      model_id: "claude-opus-4-8",
      model_display: "Opus",
      effort: "high",
      used_percentage: 42.5,
      input_tokens: 85000,
      window_size: 200000,
    }),
  });
  drainAll();
  const after = telemetryRow("sess-t1");
  expect(after).toMatchObject({
    current_model_id: "claude-opus-4-8",
    current_model_display: "Opus",
    current_effort: "high",
    context_used_percentage: 42.5,
    context_input_tokens: 85000,
    context_window_size: 200000,
  });
  // Lifecycle columns untouched — display telemetry must not perturb the job.
  expect(after?.state).toBe(before?.state ?? "");
  expect(after?.active_since).toBe(before?.active_since ?? null);
});

test("SessionTelemetry before SessionStart is a clean zero-row no-op — no phantom jobs row (fn-1024)", () => {
  insertEvent({
    hook_event: "SessionTelemetry",
    session_id: "sess-orphan",
    data: telemetryBlob({ model_id: "claude-opus-4-8", effort: "high" }),
  });
  // The event folds (cursor advances) but matches zero rows — no UPSERT-mint.
  expect(drainAll()).toBeGreaterThanOrEqual(1);
  expect(telemetryRow("sess-orphan")).toBeNull();
  expect(
    db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number },
  ).toEqual({ n: 0 });
});

test("a partial SessionTelemetry merges — effort-only leaves model/context intact (COALESCE) (fn-1024)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-t3" });
  insertEvent({
    hook_event: "SessionTelemetry",
    session_id: "sess-t3",
    data: telemetryBlob({
      model_id: "claude-opus-4-8",
      model_display: "Opus",
      effort: "high",
      used_percentage: 30,
      input_tokens: 60000,
      window_size: 200000,
    }),
  });
  drainAll();
  // A follow-up snapshot carrying ONLY effort — every other field null.
  insertEvent({
    hook_event: "SessionTelemetry",
    session_id: "sess-t3",
    data: telemetryBlob({ effort: "max" }),
  });
  drainAll();
  expect(telemetryRow("sess-t3")).toMatchObject({
    current_model_id: "claude-opus-4-8", // preserved
    current_model_display: "Opus", // preserved
    current_effort: "max", // updated
    context_used_percentage: 30, // preserved
    context_input_tokens: 60000, // preserved
    context_window_size: 200000, // preserved
  });
});

test("a malformed SessionTelemetry data blob never throws and leaves the columns intact (fn-1024)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-t4" });
  insertEvent({
    hook_event: "SessionTelemetry",
    session_id: "sess-t4",
    data: telemetryBlob({ model_id: "claude-opus-4-8", effort: "high" }),
  });
  drainAll();
  const before = telemetryRow("sess-t4");
  // Garbage body — the guarded parse must fold to a safe no-op, never throw.
  insertEvent({
    hook_event: "SessionTelemetry",
    session_id: "sess-t4",
    data: "{not valid json",
  });
  expect(() => drainAll()).not.toThrow();
  expect(telemetryRow("sess-t4")).toEqual(before);
});

test("SessionTelemetry on a terminal (ended) row is a no-op — the columns stay NULL (fn-1024)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-t5" });
  insertEvent({
    hook_event: "SessionEnd",
    session_id: "sess-t5",
    data: JSON.stringify({ reason: "stop" }),
  });
  drainAll();
  insertEvent({
    hook_event: "SessionTelemetry",
    session_id: "sess-t5",
    data: telemetryBlob({ model_id: "claude-opus-4-8", effort: "high" }),
  });
  drainAll();
  const row = telemetryRow("sess-t5");
  // The terminal guard (state NOT IN ended/killed) matched zero rows.
  expect(row?.state).toBe("ended");
  expect(row?.current_model_id).toBeNull();
  expect(row?.current_effort).toBeNull();
});
