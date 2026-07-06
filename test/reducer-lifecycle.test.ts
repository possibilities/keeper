/**
 * Reducer tests — shard 1 of 4 (fn-769 fast-tier split of the former
 * monolithic reducer.test.ts). Theme: lifecycle / git-cleanliness / attribution / commit / usage folds.
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
  __resetGitAttribMemoForTest,
  applyEvent,
  drain,
  warmGitAttribMemo,
} from "../src/reducer";
import { __resetSubagentPreParseMemoForTest } from "../src/subagent-invocations";
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
    // Schema v94 / fn-997: durable worktree-lane BRANCH captured at SessionStart.
    // NULL on every non-worktree event; worktree-fold tests pass it via overrides.
    worktree?: string | null;
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
    // Schema v94 / fn-997: durable worktree-lane BRANCH. NULL by default so a
    // non-worktree SessionStart folds jobs.worktree NULL; worktree tests set it.
    worktree: overrides.worktree ?? null,
    // Schema v107 / fn-1103: launching harness + native resume target. NULL by
    // default so a claude/legacy SessionStart folds both NULL; harness-fold and
    // ResumeTargetResolved tests set them via overrides.
    harness: overrides.harness ?? null,
    resume_target: overrides.resume_target ?? null,
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
       background_task_id, mutation_path, worktree, harness, resume_target
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.worktree,
      row.harness,
      row.resume_target,
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
    active_since: number | null;
  } | null;
}

function getCursor(): number {
  const row = db
    .query("SELECT last_event_id FROM reducer_state WHERE id = 1")
    .get() as { last_event_id: number };
  return row.last_event_id;
}

test("GitSnapshot folds into git_status and advances the cursor", () => {
  const id = insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: "abc123",
      upstream: "origin/main",
      ahead: 1,
      behind: 2,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });

  expect(drain(db)).toBe(1);
  const row = db
    .query("SELECT * FROM git_status WHERE project_dir = ?")
    .get("/repo") as {
    branch: string;
    head_oid: string;
    upstream: string;
    ahead: number;
    behind: number;
    dirty_count: number;
    orphaned_count: number;
    dirty_files: string;
    orphaned_files: string;
    jobs: string;
    last_event_id: number;
  } | null;

  expect(row).not.toBeNull();
  expect(row?.branch).toBe("main");
  expect(row?.head_oid).toBe("abc123");
  expect(row?.upstream).toBe("origin/main");
  expect(row?.ahead).toBe(1);
  expect(row?.behind).toBe(2);
  expect(row?.dirty_count).toBe(1);
  // No mutation events touched src/a.ts → strict-mystery orphan; the
  // file has zero active attributions.
  expect(row?.orphaned_count).toBe(1);
  // The rendered `dirty_files[].attributions[]` is empty (no mutation
  // events → no explicit attribution; no mtime → no inferred either).
  // v44 / fn-664: the rendered shape now also carries `worktree_oid` /
  // `index_oid` / `worktree_mode` lifted straight from the snapshot
  // payload — additive, all `null` here because this test's
  // GitSnapshot payload doesn't set them.
  expect(JSON.parse(row?.dirty_files ?? "[]")).toEqual([
    {
      path: "src/a.ts",
      xy: " M",
      orig_path: null,
      mtime_ms: null,
      worktree_oid: null,
      index_oid: null,
      worktree_mode: null,
      attributions: [],
    },
  ]);
  // Project-broadcast `jobs[]` canonical attribution is empty — no
  // session was on the hook for any file.
  expect(JSON.parse(row?.jobs ?? "[]")).toEqual([]);
  expect(row?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("GitRootDropped DELETEs the git_status row and advances the cursor", () => {
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: ".planctl/epics/x.json", xy: " D" }],
      orphaned_files: [{ path: ".planctl/epics/x.json", xy: " D" }],
      jobs: [],
    }),
  });
  const dropId = insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/repo",
    cwd: "/repo",
    data: "",
  });

  expect(drainAll()).toBe(2);
  const row = db
    .query("SELECT * FROM git_status WHERE project_dir = ?")
    .get("/repo");
  expect(row).toBeNull();
  expect(getCursor()).toBe(dropId);
});

test("GitRootDropped on an unknown project_dir is a safe no-op", () => {
  const id = insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/never-folded",
    cwd: "/never-folded",
    data: "",
  });
  expect(drainAll()).toBe(1);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM git_status").get() as { n: number }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(id);
});

// ---------------------------------------------------------------------------
// fn-690 — re-fold determinism. The dynamic watch-membership gate (epic
// fn-690) is a producer-side decision that depends on wall-clock time, fs
// state, and the live watched set. NONE of those facts leak into any
// emitted event payload — `GitSnapshot`, `GitRootDropped`, and `Commit`
// carry only what was true at producer time. So a re-fold from cursor=0
// over the persisted event log MUST reproduce byte-identical projections
// regardless of whether the events were emitted by a worker with empty
// or pre-warmed membership history.
// ---------------------------------------------------------------------------

test("fn-690 re-fold determinism: same event log → byte-identical projections regardless of membership history", () => {
  // Drive a non-trivial mix of GitSnapshot + Commit + GitRootDropped events
  // across two projects, then re-fold from cursor=0 and assert the
  // projections are byte-identical to the first fold. The test would FAIL
  // if any membership-aware state (cwdRootCache, watchProbeCache,
  // cleanSinceByRoot, currentlyWatched, performance.now) had leaked into
  // an event payload — none of it does, by design.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-w",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-w",
    cwd: "/repo-a",
    data: JSON.stringify({ tool_input: { file_path: "/repo-a/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-a",
    cwd: "/repo-a",
    data: JSON.stringify({
      project_dir: "/repo-a",
      branch: "main",
      head_oid: "abc",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      dirty_files: [
        { path: "src/a.ts", xy: " M", mtime_ms: 1_700_000_000_000 },
      ],
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-b",
    cwd: "/repo-b",
    data: JSON.stringify({
      project_dir: "/repo-b",
      branch: "feature",
      head_oid: "def",
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [],
    }),
  });
  insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/repo-b",
    cwd: "/repo-b",
    data: "",
  });
  expect(drainAll()).toBeGreaterThan(0);

  // Capture the first fold's projection state. Snapshot every table whose
  // shape any producer-side membership decision could conceivably affect.
  const cursor1 = getCursor();
  const gitStatus1 = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();
  const fileAttrib1 = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();
  const jobs1 = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const epics1 = db.query("SELECT * FROM epics ORDER BY epic_id").all();

  // Re-fold from cursor=0. Drop every projection row, reset the cursor,
  // re-drain. The folded shape must be byte-identical (JSON.stringify
  // equality on every row).
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  expect(drainAll()).toBeGreaterThan(0);

  expect(getCursor()).toBe(cursor1);
  expect(
    JSON.stringify(
      db.query("SELECT * FROM git_status ORDER BY project_dir").all(),
    ),
  ).toBe(JSON.stringify(gitStatus1));
  expect(
    JSON.stringify(
      db
        .query(
          "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
        )
        .all(),
    ),
  ).toBe(JSON.stringify(fileAttrib1));
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(JSON.stringify(jobs1));
  expect(
    JSON.stringify(db.query("SELECT * FROM epics ORDER BY epic_id").all()),
  ).toBe(JSON.stringify(epics1));
});

test("fn-784 re-fold determinism: active_since (stamped + restarted + NULL) re-folds byte-identical", () => {
  // Two jobs prove both edges of the active_since fold survive a from-scratch
  // re-fold: `sess-prompted` is driven through a stamp → Stop → genuine
  // restart (a second rising edge re-stamps to a later ts), while `sess-idle`
  // is a SessionStart-only job that never prompts (active_since stays NULL).
  // The fold reads only `event.ts` and the pre-update `state`, never
  // wall-clock — so the re-fold from cursor=0 MUST reproduce both the stamped
  // REAL and the NULL byte-for-byte.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-prompted" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-prompted",
    ts: 5000,
  });
  insertEvent({ hook_event: "Stop", session_id: "sess-prompted" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-prompted",
    ts: 6000,
  });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-idle" });
  expect(drainAll()).toBeGreaterThan(0);

  // Sanity: the first fold landed the expected active_since values.
  const prompted1 = db
    .query("SELECT active_since FROM jobs WHERE job_id = 'sess-prompted'")
    .get() as { active_since: number | null };
  const idle1 = db
    .query("SELECT active_since FROM jobs WHERE job_id = 'sess-idle'")
    .get() as { active_since: number | null };
  expect(prompted1.active_since).toBe(6000);
  expect(idle1.active_since).toBeNull();

  const cursor1 = getCursor();
  const jobs1 = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  // Re-fold from cursor=0: drop the projection, rewind, re-drain.
  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  expect(drainAll()).toBeGreaterThan(0);

  expect(getCursor()).toBe(cursor1);
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(JSON.stringify(jobs1));
});

// ---------------------------------------------------------------------------
// fn-816 — fork-session job attribution. A `claude --fork-session` session
// gets a fresh session id that NEVER emits a SessionStart, so the first
// pid-bearing UserPromptSubmit must mint a standalone jobs row (the other
// fold arms are all UPDATE … WHERE job_id, silent no-ops without it).
// ---------------------------------------------------------------------------

test("fn-816 fork happy path: first pid-bearing UserPromptSubmit with no SessionStart mints a working job", () => {
  // Fork-shaped stream: a daemon-synthesized TranscriptTitle (NULL pid) lands
  // first and mints NOTHING, then the real first prompt (pid + cwd + backend
  // coords + a payload session_title) seeds the row and flips it to working.
  insertEvent({
    hook_event: "TranscriptTitle",
    session_id: "fork-a",
    pid: null,
    data: JSON.stringify({ session_title: "transcript-title" }),
  });
  const upsId = insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "fork-a",
    pid: 9001,
    cwd: "/tmp/fork",
    ts: 7000,
    backend_exec_type: "tmux",
    backend_exec_session_id: "tsess",
    backend_exec_pane_id: "%7",
    data: JSON.stringify({ session_title: "fork-prompt-title" }),
  });
  expect(drainAll()).toBeGreaterThan(0);

  const job = getJob("fork-a");
  expect(job).not.toBeNull();
  expect(job?.state).toBe("working");
  // created_at and active_since both stamp the UPS ts — the seed lands
  // created_at=ts and the immediate UPDATE stamps active_since=ts on the
  // 'stopped' → 'working' rising edge (identical to a normal first prompt).
  expect(job?.created_at).toBe(7000);
  expect(job?.active_since).toBe(7000);
  expect(job?.pid).toBe(9001);
  expect(job?.cwd).toBe("/tmp/fork");
  expect(job?.last_event_id).toBe(upsId);
  // start_time stays NULL (UPS carries none) — the loose-pid-only match that
  // keeps a seeded fork row out of the pidless reap.
  expect(job?.start_time).toBeNull();
  // The earlier TranscriptTitle title rule was a no-op (no row yet); the
  // post-switch title rule on the minting UPS lands the payload title.
  expect(job?.title).toBe("fork-prompt-title");

  // Backend coords landed on the now-present row (REQUIRED for restore
  // visibility). fn-907: the env session is FORENSIC — it lands in
  // `backend_exec_birth_session_id`, NOT the live `backend_exec_session_id`
  // (owned solely by the TmuxTopologySnapshot fold). type + pane stay pure env
  // reads.
  const coords = db
    .query(
      "SELECT backend_exec_type, backend_exec_session_id, backend_exec_birth_session_id, backend_exec_pane_id FROM jobs WHERE job_id = ?",
    )
    .get("fork-a") as {
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_birth_session_id: string | null;
    backend_exec_pane_id: string | null;
  };
  expect(coords.backend_exec_type).toBe("tmux");
  expect(coords.backend_exec_birth_session_id).toBe("tsess");
  expect(coords.backend_exec_session_id).toBeNull();
  expect(coords.backend_exec_pane_id).toBe("%7");

  // Plan-fan-in columns stay NULL — a fork seed is a standalone job with no
  // dispatch lineage.
  const plan = db
    .query("SELECT plan_verb, plan_ref FROM jobs WHERE job_id = ?")
    .get("fork-a") as { plan_verb: string | null; plan_ref: string | null };
  expect(plan.plan_verb).toBeNull();
  expect(plan.plan_ref).toBeNull();
});

test("fn-816 re-fold determinism: a fork-shaped (UPS-only) stream re-folds byte-identical", () => {
  // Keystone assertion: the seed reads ONLY event fields, so a from-scratch
  // re-fold reproduces the minted row byte-for-byte. A leak of wall-clock /
  // env / fs / liveness into the seed would diverge here.
  insertEvent({
    hook_event: "TranscriptTitle",
    session_id: "fork-rf",
    pid: null,
    data: JSON.stringify({ session_title: "tt" }),
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "fork-rf",
    pid: 9100,
    cwd: "/tmp/fork-rf",
    ts: 7100,
    backend_exec_type: "tmux",
    backend_exec_session_id: "rfsess",
    backend_exec_pane_id: "%9",
    data: JSON.stringify({ session_title: "rf-title" }),
  });
  insertEvent({ hook_event: "Stop", session_id: "fork-rf", ts: 7200 });
  expect(drainAll()).toBeGreaterThan(0);

  const cursor1 = getCursor();
  const jobs1 = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  expect(drainAll()).toBeGreaterThan(0);

  expect(getCursor()).toBe(cursor1);
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(JSON.stringify(jobs1));
});

test("fn-816 a NULL-pid UserPromptSubmit mints NO row (guard skip)", () => {
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "fork-nopid",
    pid: null,
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(getJob("fork-nopid")).toBeNull();
});

test("fn-816 a killed-task-notification UserPromptSubmit mints NO row, and a TranscriptTitle-only stream mints NO row", () => {
  // The killed-task-notification early-break fires BEFORE the seed, so no row
  // is minted even with a real pid.
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "fork-killed",
    pid: 9200,
    data: JSON.stringify({
      prompt: "<task-notification><status>killed</status></task-notification>",
    }),
  });
  // A NULL-pid TranscriptTitle on its own never mints (the title rule's SELECT
  // finds no row).
  insertEvent({
    hook_event: "TranscriptTitle",
    session_id: "fork-tt-only",
    pid: null,
    data: JSON.stringify({ session_title: "lonely" }),
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(getJob("fork-killed")).toBeNull();
  expect(getJob("fork-tt-only")).toBeNull();
});

test("fn-816 a later real SessionStart hydrates a UPS-minted fork via ON CONFLICT, healing the plan pair and discharging pending_dispatches", () => {
  // Seed a pending dispatch keyed on a plan ref. The fork's first prompt mints
  // a standalone row with a NULL plan pair; a later real SessionStart for the
  // SAME id (carrying pid / start_time / config_dir and a work-verb spawn name)
  // hydrates the row via ON CONFLICT. The row pre-existed so this is NOT a
  // spawn-INSERT, but the ON CONFLICT branch COALESCE-heals the NULL pair and
  // the widened discharge gate fires on that NULL->non-NULL transition — so the
  // worker binds to its task and the launch-window slot is reaped (fn-832: the
  // fold-order race that previously orphaned the worker forever).
  db.run(
    "INSERT INTO pending_dispatches (verb, id, dir, dispatched_at, last_event_id) VALUES (?, ?, ?, ?, ?)",
    ["work", "fn-99-x.1", "/tmp/fork-hyd", 100, 1],
  );
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "fork-hyd",
    pid: 9300,
    cwd: "/tmp/fork-hyd",
    ts: 7300,
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "fork-hyd",
    pid: 9301,
    start_time: "111",
    config_dir: "/Users/x/.claude",
    spawn_name: "work::fn-99-x.1",
    ts: 7400,
  });
  expect(drainAll()).toBeGreaterThan(0);

  const row = db
    .query(
      "SELECT pid, start_time, config_dir, plan_verb, plan_ref FROM jobs WHERE job_id = ?",
    )
    .get("fork-hyd") as {
    pid: number;
    start_time: string | null;
    config_dir: string | null;
    plan_verb: string | null;
    plan_ref: string | null;
  };
  // ON CONFLICT COALESCEd in the SessionStart's pid / start_time / config_dir.
  expect(row.pid).toBe(9301);
  expect(row.start_time).toBe("111");
  expect(row.config_dir).toBe("/Users/x/.claude");
  // The ON CONFLICT branch COALESCE-fills the NULL pair (fill-only-when-NULL),
  // so the fork-seed row heals to the spawn name's parsed pair.
  expect(row.plan_verb).toBe("work");
  expect(row.plan_ref).toBe("fn-99-x.1");

  // Discharge-on-bind fires on the NULL->non-NULL heal (keyed on the PRE-UPSERT
  // NULL prior pair), so the pending dispatch is reaped.
  const pending = db
    .query("SELECT 1 AS one FROM pending_dispatches WHERE verb = ? AND id = ?")
    .get("work", "fn-99-x.1");
  expect(pending).toBeNull();
});

// ---------------------------------------------------------------------------
// Schema v94 / fn-997 — durable per-job worktree-lane BRANCH marker. The
// SessionStart ON CONFLICT arm folds `events.worktree` set-once onto
// `jobs.worktree` via COALESCE (mirrors config_dir): a first launch records the
// branch, a resume (emitting NULL) preserves it, a non-worktree launch is NULL.
// ---------------------------------------------------------------------------

const worktreeOf = (jobId: string): string | null =>
  (
    db.query("SELECT worktree FROM jobs WHERE job_id = ?").get(jobId) as {
      worktree: string | null;
    }
  ).worktree;

test("fn-997 a worktree-mode SessionStart folds jobs.worktree to the verbatim lane branch", () => {
  // Base lane (closer / inheriting / root) → the bare `keeper/epic/<id>` branch.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-base",
    spawn_name: "close::fn-986",
    worktree: "keeper/epic/fn-986",
  });
  // Rib lane → the FLAT `keeper/epic/<id>--<task>` branch, recorded verbatim
  // (no normalization — it is a canonical ref).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-rib",
    spawn_name: "work::fn-986.2",
    worktree: "keeper/epic/fn-986--fn-986.2",
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(worktreeOf("sess-base")).toBe("keeper/epic/fn-986");
  expect(worktreeOf("sess-rib")).toBe("keeper/epic/fn-986--fn-986.2");
});

test("fn-997 a serial (non-worktree) SessionStart folds jobs.worktree NULL", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-serial",
    spawn_name: "work::fn-1-x.1",
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(worktreeOf("sess-serial")).toBeNull();
});

test("fn-997 a resume (empty branch → NULL) preserves the first-launch branch via set-once COALESCE", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-resume",
    spawn_name: "work::fn-986.3",
    worktree: "keeper/epic/fn-986--fn-986.3",
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(worktreeOf("sess-resume")).toBe("keeper/epic/fn-986--fn-986.3");

  // A resume SessionStart for the SAME session emits a NULL worktree (the
  // always-emitted env carried empty). COALESCE(excluded.worktree, jobs.worktree)
  // must PRESERVE the first-launch branch — the set-once invariant resume depends
  // on (the every-event backend_exec arm would have wiped it; this arm must not).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-resume",
    spawn_name: "work::fn-986.3",
    worktree: null,
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(worktreeOf("sess-resume")).toBe("keeper/epic/fn-986--fn-986.3");
});

// ---------------------------------------------------------------------------
// Schema v107 / fn-1103 — the harness + resume_target multi-harness columns.
// The SessionStart arm folds `events.{harness,resume_target}` verbatim via
// COALESCE (never synthesizing a value); a separate ResumeTargetResolved arm
// idempotently replaces ONLY resume_target and never touches lifecycle state.
// ---------------------------------------------------------------------------

const harnessOf = (jobId: string): string | null =>
  (
    db.query("SELECT harness FROM jobs WHERE job_id = ?").get(jobId) as {
      harness: string | null;
    }
  ).harness;

const resumeTargetOf = (jobId: string): string | null =>
  (
    db.query("SELECT resume_target FROM jobs WHERE job_id = ?").get(jobId) as {
      resume_target: string | null;
    }
  ).resume_target;

test("fn-1103 a SessionStart carrying harness/resume_target folds both onto the row", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-claude",
    spawn_name: "work::fn-1-x.1",
    harness: "claude",
    resume_target: "sess-claude",
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(harnessOf("sess-claude")).toBe("claude");
  expect(resumeTargetOf("sess-claude")).toBe("sess-claude");
});

test("fn-1103 a legacy NULL-harness SessionStart leaves both columns NULL (fold never synthesizes claude)", () => {
  // The NULL=claude reading is a CONSUMER convention; the fold itself must store
  // the event's value verbatim, so a pre-stamp / non-claude-tagged SessionStart
  // folds harness NULL — a synthesized "claude" here would break re-fold
  // byte-identity on the legacy log.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-legacy",
    spawn_name: "work::fn-1-y.1",
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(harnessOf("sess-legacy")).toBeNull();
  expect(resumeTargetOf("sess-legacy")).toBeNull();
});

test("fn-1103 a resume (NULL harness/resume_target) preserves the seeded values via COALESCE", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-r",
    spawn_name: "work::fn-1-z.1",
    harness: "codex",
    resume_target: "rollout-abc",
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(harnessOf("sess-r")).toBe("codex");
  expect(resumeTargetOf("sess-r")).toBe("rollout-abc");

  // A resume SessionStart emitting NULL for both must NOT clobber the seed.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-r",
    spawn_name: "work::fn-1-z.1",
    harness: null,
    resume_target: null,
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(harnessOf("sess-r")).toBe("codex");
  expect(resumeTargetOf("sess-r")).toBe("rollout-abc");
});

test("fn-1103 ResumeTargetResolved sets resume_target on a killed row WITHOUT changing state", () => {
  // Seed a job, then kill it (proven-dead reap), then back-fill its resume target.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-k",
    pid: 5150,
    start_time: "darwin:seed",
    spawn_name: "work::fn-1-k.1",
    harness: "codex",
  });
  insertEvent({
    hook_event: "Killed",
    session_id: "sess-k",
    data: JSON.stringify({
      pid: 5150,
      start_time: "darwin:seed",
      close_kind: "signaled",
      reason: "exit_watched",
    }),
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(getJob("sess-k")?.state).toBe("killed");
  expect(resumeTargetOf("sess-k")).toBeNull();

  // The late back-fill sets resume_target and leaves state 'killed' — the
  // explicit regression case a separate arm (never the reviving SessionStart
  // arm) exists to protect.
  insertEvent({
    hook_event: "ResumeTargetResolved",
    session_id: "sess-k",
    resume_target: "rollout-late-99",
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(resumeTargetOf("sess-k")).toBe("rollout-late-99");
  expect(getJob("sess-k")?.state).toBe("killed");
  expect(harnessOf("sess-k")).toBe("codex");
});

test("fn-1103 ResumeTargetResolved with a NULL target or no jobs row is a safe no-op", () => {
  // No jobs row for this session — must not throw or mint a row.
  insertEvent({
    hook_event: "ResumeTargetResolved",
    session_id: "sess-absent",
    resume_target: "rt-x",
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(
    db.query("SELECT 1 FROM jobs WHERE job_id = ?").get("sess-absent"),
  ).toBeNull();

  // A row exists but the event carries a NULL target — no write.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-nt",
    spawn_name: "work::fn-1-nt.1",
    harness: "pi",
    resume_target: "seed-nt",
  });
  insertEvent({
    hook_event: "ResumeTargetResolved",
    session_id: "sess-nt",
    resume_target: null,
  });
  expect(drainAll()).toBeGreaterThan(0);
  expect(resumeTargetOf("sess-nt")).toBe("seed-nt");
});

// ---------------------------------------------------------------------------
// Schema-v28 GitSnapshot → jobs fan-out — fn-620 mechanical git-cleanliness gate
// ---------------------------------------------------------------------------

test("GitSnapshot fans out git counts into jobs and the embedded jobs[] array", () => {
  // Seed a worker session with a plan_ref so syncJobIntoEpic fires.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-worker",
    spawn_name: "work::fn-1-foo.1",
  });
  // UserPromptSubmit flips the session to 'working' (live). Without
  // this the session is in the default 'stopped' state — still live for
  // unattributed-to-live purposes, but more honestly modeled as a
  // working session in this test.
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-worker" });
  // Seed a task snapshot so the parent epic / task element exists when the
  // fan-out lands. Without it, syncJobIntoEpic would still shell-insert,
  // but the explicit fold makes the test assertion easier to read.
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-1-foo.1",
    data: JSON.stringify({
      task_id: "fn-1-foo.1",
      epic_id: "fn-1-foo",
      task_number: 1,
      title: "task",
      target_repo: null,
      worker_phase: "open",
      runtime_status: "todo",
      approval: "pending",
      depends_on: [],
    }),
  });
  // Two tool mutations by sess-worker on the two dirty files — these
  // mint the file_attributions rows the new fold reads.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-worker",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Edit",
    session_id: "sess-worker",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/b.ts" } }),
  });

  const snapshotId = insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: "abc",
      upstream: null,
      ahead: null,
      behind: null,
      // Three dirty files: src/a.ts + src/b.ts (attributed via the
      // mutation events above), and orph.txt with no mutation event —
      // strict-mystery orphan.
      dirty_files: [
        { path: "src/a.ts", xy: " M", mtime_ms: null },
        { path: "src/b.ts", xy: " M", mtime_ms: null },
        { path: "orph.txt", xy: " M", mtime_ms: null },
      ],
    }),
  });

  expect(drainAll()).toBe(6);

  // jobs row carries per-job dirty count + project-broadcast strict-
  // mystery orphan + project-broadcast unattributed-to-live counts.
  // sess-worker is live ('working'), so unattributed-to-live counts ONLY
  // the strict-mystery file (orph.txt — no attribution); src/a.ts and
  // src/b.ts have a live attribution. git_orphan_count is the same
  // strict-mystery count (one file with zero attributions).
  const row = db
    .query(
      "SELECT git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-worker") as {
    git_dirty_count: number;
    git_unattributed_to_live_count: number;
    git_orphan_count: number;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.git_dirty_count).toBe(2);
  expect(row?.git_unattributed_to_live_count).toBe(1);
  expect(row?.git_orphan_count).toBe(1);

  // Embedded task element's jobs[] carries the same counts.
  const epicRow = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get("fn-1-foo") as { tasks: string } | null;
  expect(epicRow).not.toBeNull();
  const tasksArr = JSON.parse(epicRow?.tasks ?? "[]") as Array<{
    task_id: string;
    jobs: Array<{
      job_id: string;
      git_dirty_count: number;
      git_unattributed_to_live_count: number;
      git_orphan_count: number;
    }>;
  }>;
  const task = tasksArr.find((t) => t.task_id === "fn-1-foo.1");
  expect(task).not.toBeUndefined();
  const embeddedJob = task?.jobs.find((j) => j.job_id === "sess-worker");
  expect(embeddedJob).not.toBeUndefined();
  expect(embeddedJob?.git_dirty_count).toBe(2);
  expect(embeddedJob?.git_unattributed_to_live_count).toBe(1);
  expect(embeddedJob?.git_orphan_count).toBe(1);

  expect(getCursor()).toBe(snapshotId);
});

test("GitSnapshot UPDATE matches zero rows for a job with no SessionStart yet (safe no-op)", () => {
  // The new attribution fold: a mutation event by `sess-never-started`
  // arrives BEFORE its SessionStart. The fold mints a file_attributions
  // row keyed on the session id, then enumerates the session in the
  // per-job rollup — but the UPDATE against jobs matches zero rows
  // (no jobs row yet). No throw, no shell-insert; cursor advances.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-never-started",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  const snapshotId = insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });

  expect(drainAll()).toBe(2);
  // No jobs row (no SessionStart yet). The file_attributions row
  // exists, the UPDATE was a no-op for this session. Cursor advanced.
  const jobsCount = (
    db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }
  ).n;
  expect(jobsCount).toBe(0);
  const attribCount = (
    db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  expect(attribCount).toBe(1);
  expect(getCursor()).toBe(snapshotId);
});

test("GitRootDropped zeroes git counts via the canonical attribution; unrelated jobs untouched", () => {
  // Seed two worker sessions in two different projects. A GitSnapshot in
  // project A stamps worker A; a GitSnapshot in project B stamps worker B.
  // GitRootDropped on project A clears worker A only; worker B stays put.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-a",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-b",
    spawn_name: "work::fn-2-bar.1",
  });

  // Mutation events that mint file_attributions rows.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo-a",
    data: JSON.stringify({ tool_input: { file_path: "/repo-a/x.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-b",
    cwd: "/repo-b",
    data: JSON.stringify({ tool_input: { file_path: "/repo-b/p.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-b",
    cwd: "/repo-b",
    data: JSON.stringify({ tool_input: { file_path: "/repo-b/q.ts" } }),
  });

  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-a",
    cwd: "/repo-a",
    data: JSON.stringify({
      project_dir: "/repo-a",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "x.ts", xy: " M", mtime_ms: null }],
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-b",
    cwd: "/repo-b",
    data: JSON.stringify({
      project_dir: "/repo-b",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "p.ts", xy: " M", mtime_ms: null },
        { path: "q.ts", xy: " M", mtime_ms: null },
      ],
    }),
  });
  const dropId = insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/repo-a",
    cwd: "/repo-a",
    data: "",
  });

  expect(drainAll()).toBe(8);

  // sess-a counts cleared by the symmetric clear (file_attributions for
  // /repo-a also deleted symmetrically).
  const rowA = db
    .query(
      "SELECT git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-a") as {
    git_dirty_count: number;
    git_unattributed_to_live_count: number;
    git_orphan_count: number;
  } | null;
  expect(rowA?.git_dirty_count).toBe(0);
  expect(rowA?.git_unattributed_to_live_count).toBe(0);
  expect(rowA?.git_orphan_count).toBe(0);

  // sess-b in the other project stays untouched (still attributed to
  // both p.ts and q.ts).
  const rowB = db
    .query(
      "SELECT git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-b") as {
    git_dirty_count: number;
    git_unattributed_to_live_count: number;
    git_orphan_count: number;
  } | null;
  expect(rowB?.git_dirty_count).toBe(2);
  expect(rowB?.git_unattributed_to_live_count).toBe(0);
  expect(rowB?.git_orphan_count).toBe(0);

  // file_attributions rows for /repo-a wiped symmetrically.
  const attribsA = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM file_attributions WHERE project_dir = ?",
      )
      .get("/repo-a") as { n: number }
  ).n;
  expect(attribsA).toBe(0);
  // /repo-b attributions untouched.
  const attribsB = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM file_attributions WHERE project_dir = ?",
      )
      .get("/repo-b") as { n: number }
  ).n;
  expect(attribsB).toBe(2);

  expect(getCursor()).toBe(dropId);
});

// ---------------------------------------------------------------------------
// fn-656.1: `git_status.jobs` retains only `dirty > 0` sessions
// ---------------------------------------------------------------------------

test("fn-656.1 dirty->clean transition: session zeroes once on transition snapshot then drops from git_status.jobs", () => {
  // Lifecycle:
  //  1. SessionStart for a worker with plan_ref → epic jobs[] mirrors counts.
  //  2. PostToolUse mints a file_attributions row.
  //  3. GitSnapshot with the file dirty → sess-w lands in git_status.jobs
  //     with dirty=1 and jobs.git_dirty_count=1.
  //  4. GitSnapshot with no dirty_files → sess-w STILL enumerated via
  //     priorSessions, its UPDATE zeroes jobs.git_dirty_count, embedded
  //     epic jobs[] count clears to 0, AND sess-w is DROPPED from the
  //     persisted git_status.jobs JSON (dirty == 0).
  //  5. Third GitSnapshot, still no dirty_files → sess-w no longer in
  //     priorSessions, not enumerated; still absent from git_status.jobs.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-w",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-1-foo.1",
    data: JSON.stringify({
      task_id: "fn-1-foo.1",
      epic_id: "fn-1-foo",
      task_number: 1,
      title: "task",
      target_repo: null,
      worker_phase: "open",
      runtime_status: "todo",
      approval: "pending",
      depends_on: [],
    }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-w",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();

  // Step 3 assertions: sess-w in git_status.jobs with dirty=1.
  type JobsEntry = { job_id: string; dirty: number };
  const gitRowDirty = db
    .query("SELECT jobs FROM git_status WHERE project_dir = ?")
    .get("/repo") as { jobs: string } | null;
  expect(gitRowDirty).not.toBeNull();
  const jobsDirty = JSON.parse(gitRowDirty?.jobs ?? "[]") as JobsEntry[];
  expect(jobsDirty).toEqual([{ job_id: "sess-w", dirty: 1 }]);
  const jobsRowDirty = db
    .query("SELECT git_dirty_count FROM jobs WHERE job_id = ?")
    .get("sess-w") as { git_dirty_count: number } | null;
  expect(jobsRowDirty?.git_dirty_count).toBe(1);

  // Step 4: clean snapshot. sess-w still enumerated (via priorSessions);
  // gets its clearing UPDATE + epic jobs[] clear; THEN drops from
  // git_status.jobs.
  // Commit discharge first so file_attributions stops keeping sess-w in
  // sessionsWithAttribution. Otherwise the undischarged attribution
  // would re-enumerate sess-w even after dirty_files emptied, but the
  // dirty count remains 0 — so it would STILL drop from git_status.jobs
  // under the guard. Discharging makes the test exercise the explicit
  // priorSessions-only transition path.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: "deadbeef",
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: "sess-w",
      committed_at_ms: 5_000_000,
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [],
    }),
  });
  drainAll();

  const gitRowClean = db
    .query("SELECT jobs FROM git_status WHERE project_dir = ?")
    .get("/repo") as { jobs: string } | null;
  expect(gitRowClean).not.toBeNull();
  const jobsClean = JSON.parse(gitRowClean?.jobs ?? "[]") as JobsEntry[];
  // sess-w DROPPED from git_status.jobs on the transition snapshot.
  expect(jobsClean).toEqual([]);
  // jobs row counts zeroed.
  const jobsRowClean = db
    .query("SELECT git_dirty_count FROM jobs WHERE job_id = ?")
    .get("sess-w") as { git_dirty_count: number } | null;
  expect(jobsRowClean?.git_dirty_count).toBe(0);
  // Embedded epic jobs[] git count cleared.
  const epicRow = db
    .query("SELECT tasks FROM epics WHERE epic_id = ?")
    .get("fn-1-foo") as { tasks: string } | null;
  expect(epicRow).not.toBeNull();
  const tasksArr = JSON.parse(epicRow?.tasks ?? "[]") as Array<{
    task_id: string;
    jobs: Array<{ job_id: string; git_dirty_count: number }>;
  }>;
  const task = tasksArr.find((t) => t.task_id === "fn-1-foo.1");
  const embeddedJob = task?.jobs.find((j) => j.job_id === "sess-w");
  expect(embeddedJob).not.toBeUndefined();
  expect(embeddedJob?.git_dirty_count).toBe(0);

  // Step 5: another clean snapshot. priorSessions is now empty for
  // sess-w (we just dropped it), so it isn't enumerated; still absent.
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [],
    }),
  });
  drainAll();
  const gitRowStill = db
    .query("SELECT jobs FROM git_status WHERE project_dir = ?")
    .get("/repo") as { jobs: string } | null;
  const jobsStill = JSON.parse(gitRowStill?.jobs ?? "[]") as JobsEntry[];
  expect(jobsStill).toEqual([]);
});

test("fn-656.1 undischarged-but-not-currently-dirty session is absent from git_status.jobs; retract-after-zero is a no-op", () => {
  // Lifecycle:
  //  1. Two sessions mutate two different files in /repo.
  //  2. GitSnapshot with BOTH files dirty → both in git_status.jobs.
  //  3. GitSnapshot with only file-a dirty → sess-a remains; sess-b
  //     has dirtyForSession==0 (its file isn't in dirty_files), but the
  //     prior snapshot persisted sess-b into git_status.jobs, so it
  //     surfaces in priorSessions on this fold. sess-b gets its
  //     clearing UPDATE and DROPS from git_status.jobs.
  //  4. GitRootDropped retract → walks git_status.jobs (sess-a only),
  //     zeroes sess-a; sess-b is NOT walked (already zeroed in step 3)
  //     and that's the safe no-op behavior.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/file-a.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-b",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/file-b.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "file-a.ts", xy: " M", mtime_ms: null },
        { path: "file-b.ts", xy: " M", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  type JobsEntry = { job_id: string; dirty: number };
  const both = JSON.parse(
    (
      db
        .query("SELECT jobs FROM git_status WHERE project_dir = ?")
        .get("/repo") as { jobs: string }
    ).jobs,
  ) as JobsEntry[];
  // Sorted by sortedSessions order: alphabetical sess-a, sess-b.
  expect(both).toEqual([
    { job_id: "sess-a", dirty: 1 },
    { job_id: "sess-b", dirty: 1 },
  ]);

  // Step 3: GitSnapshot drops file-b from dirty_files. sess-b is NOT
  // in this snapshot's sessionDirtyCount (no dirty attribution this
  // tick) but the prior snapshot persisted it into git_status.jobs, so
  // it surfaces via priorSessions and STILL gets a clearing UPDATE —
  // its dirtyForSession is 0, so the guard sheds it from git_status.jobs.
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "file-a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();

  const onlyA = JSON.parse(
    (
      db
        .query("SELECT jobs FROM git_status WHERE project_dir = ?")
        .get("/repo") as { jobs: string }
    ).jobs,
  ) as JobsEntry[];
  expect(onlyA).toEqual([{ job_id: "sess-a", dirty: 1 }]);
  // sess-b's jobs.git_dirty_count cleared by the unconditional UPDATE.
  const rowB = db
    .query("SELECT git_dirty_count FROM jobs WHERE job_id = ?")
    .get("sess-b") as { git_dirty_count: number } | null;
  expect(rowB?.git_dirty_count).toBe(0);
  // sess-a still counted.
  const rowA = db
    .query("SELECT git_dirty_count FROM jobs WHERE job_id = ?")
    .get("sess-a") as { git_dirty_count: number } | null;
  expect(rowA?.git_dirty_count).toBe(1);

  // Step 4: GitRootDropped. retractGitStatus walks the persisted
  // git_status.jobs (sess-a only) and zeroes it. sess-b stays zero
  // (already zeroed in step 3) — safe no-op for the dropped session.
  insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/repo",
    cwd: "/repo",
    data: "",
  });
  drainAll();
  const rowAAfter = db
    .query("SELECT git_dirty_count FROM jobs WHERE job_id = ?")
    .get("sess-a") as { git_dirty_count: number } | null;
  expect(rowAAfter?.git_dirty_count).toBe(0);
  const rowBAfter = db
    .query("SELECT git_dirty_count FROM jobs WHERE job_id = ?")
    .get("sess-b") as { git_dirty_count: number } | null;
  expect(rowBAfter?.git_dirty_count).toBe(0);
  // git_status row gone.
  const gone = db
    .query("SELECT COUNT(*) AS n FROM git_status WHERE project_dir = ?")
    .get("/repo") as { n: number };
  expect(gone.n).toBe(0);
});

// ---------------------------------------------------------------------------
// Schema-v31 attribution fold (fn-633.6) — file_attributions / per-file
// attributions[] / per-job rollups / discharge rule
// ---------------------------------------------------------------------------

test("GitSnapshot attribution pass 1: tool Write mints a file_attributions row", () => {
  // A PostToolUse:Write event by sess-a on src/a.ts → a file_attributions
  // row lands on the snapshot fold. last_mutation_at = the event's ts.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  const attrib = getAttribution("/repo", "sess-a", "src/a.ts");
  expect(attrib).not.toBeUndefined();
  expect(attrib?.last_mutation_at).toBe(100);
  expect(attrib?.last_commit_at).toBeNull();
});

test("GitSnapshot attribution pass 1: Edit, MultiEdit, NotebookEdit all mint attribution rows", () => {
  // Each of the four tool mutation kinds is recognized by the explicit
  // attribution pass.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Edit",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/edit.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "MultiEdit",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/multi.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "NotebookEdit",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/nb.ipynb" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "edit.ts", xy: " M", mtime_ms: null },
        { path: "multi.ts", xy: " M", mtime_ms: null },
        { path: "nb.ipynb", xy: " M", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  expect(getAttribution("/repo", "sess-a", "edit.ts")).not.toBeUndefined();
  expect(getAttribution("/repo", "sess-a", "multi.ts")).not.toBeUndefined();
  expect(getAttribution("/repo", "sess-a", "nb.ipynb")).not.toBeUndefined();
  const sources = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? ORDER BY file_path",
    )
    .all("/repo") as Array<{ op: string; source: string }>;
  // All three rows lifted via the tool source.
  expect(sources.every((r) => r.source === "tool")).toBe(true);
  // The op column carries the tool name.
  expect(sources.map((r) => r.op).sort()).toEqual([
    "Edit",
    "MultiEdit",
    "NotebookEdit",
  ]);
});

test("GitSnapshot attribution pass 1: bash mutation lands a 'bash'-source row", () => {
  // A PostToolUse:Bash event whose bash_mutation_targets array contains
  // the dirty file's path mints a `source='bash'` attribution row.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    bash_mutation_kind: "fs-remove",
    bash_mutation_targets: JSON.stringify(["/repo/del.ts"]),
    data: JSON.stringify({ tool_input: { command: "rm del.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "del.ts", xy: " D", mtime_ms: null }],
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-a", "del.ts") as {
    op: string;
    source: string;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.source).toBe("bash");
  expect(row?.op).toBe("fs-remove");
});

// ---------------------------------------------------------------------------
// fn-648 deletion-attribution: git-rm / git-mv events match dirty files via
// exact + directory-prefix + fnmatch against bash_mutation_targets. The .1
// deriver task stamps `bash_mutation_kind ∈ {git-rm, git-mv}` for these; this
// task wires the reducer's pass-1 to match the snapshot-known deleted/renamed
// paths against them so the file doesn't fall to `<orphan>`.
// ---------------------------------------------------------------------------

test("GitSnapshot deletion-attribution: git-rm exact token attributes the deleted file", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rm" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rm" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-rm",
    cwd: "/repo",
    bash_mutation_kind: "git-rm",
    bash_mutation_targets: JSON.stringify(["/repo/apps/jobctl/src/main.ts"]),
    data: JSON.stringify({
      tool_input: { command: "git rm apps/jobctl/src/main.ts" },
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      // Deleted file → xy=" D", mtime_ms=null (file is gone) — pass-2
      // inferred cannot fire; pass-1 exact must.
      dirty_files: [
        { path: "apps/jobctl/src/main.ts", xy: " D", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-rm", "apps/jobctl/src/main.ts") as {
    op: string;
    source: string;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.source).toBe("bash");
  expect(row?.op).toBe("git-rm");
  // Project-wide rollups: file has an attribution → not orphaned,
  // and sess-rm is live ('working') → not unattributed-to-live.
  const jobRow = db
    .query(
      "SELECT git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-rm") as {
    git_dirty_count: number;
    git_unattributed_to_live_count: number;
    git_orphan_count: number;
  } | null;
  expect(jobRow?.git_dirty_count).toBe(1);
  expect(jobRow?.git_unattributed_to_live_count).toBe(0);
  expect(jobRow?.git_orphan_count).toBe(0);
});

test("GitSnapshot deletion-attribution: git-rm -r directory-prefix attributes every file under the dir", () => {
  // `git rm -r dir/` (post-resolveAgainstCwd) stamps `/repo/dir` as the
  // sole target token. The reducer's directory-prefix mode then
  // attributes every file whose path starts with `/repo/dir/`.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rmdir" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rmdir" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-rmdir",
    cwd: "/repo",
    bash_mutation_kind: "git-rm",
    bash_mutation_targets: JSON.stringify(["/repo/apps/legacy"]),
    data: JSON.stringify({ tool_input: { command: "git rm -r apps/legacy" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "apps/legacy/a.ts", xy: " D", mtime_ms: null },
        { path: "apps/legacy/sub/b.ts", xy: " D", mtime_ms: null },
        // Negative control: a file outside the dir-prefix MUST NOT match.
        { path: "apps/other/c.ts", xy: " D", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  const inside1 = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-rmdir", "apps/legacy/a.ts");
  const inside2 = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-rmdir", "apps/legacy/sub/b.ts");
  const outside = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-rmdir", "apps/other/c.ts");
  expect(inside1).not.toBeNull();
  expect(inside2).not.toBeNull();
  expect(outside).toBeNull();
  // Project-wide: 1 orphan (apps/other/c.ts), 2 attributed.
  const jobRow = db
    .query(
      "SELECT git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-rmdir") as {
    git_dirty_count: number;
    git_unattributed_to_live_count: number;
    git_orphan_count: number;
  } | null;
  expect(jobRow?.git_dirty_count).toBe(2);
  expect(jobRow?.git_unattributed_to_live_count).toBe(1);
  expect(jobRow?.git_orphan_count).toBe(1);
});

test("GitSnapshot deletion-attribution: git-rm -r dir/ (trailing slash) attributes every file under the dir", () => {
  // fn-653: `git rm -r dir/` (resolveAgainstCwd preserves the trailing
  // `/`) stamps `/repo/dir/` as the target token. The reducer must
  // strip the trailing slash before the directory-prefix probe so
  // slash-terminated tokens still attribute their children.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-rmslash" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rmslash" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-rmslash",
    cwd: "/repo",
    bash_mutation_kind: "git-rm",
    bash_mutation_targets: JSON.stringify(["/repo/dir/"]),
    data: JSON.stringify({ tool_input: { command: "git rm -r dir/" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "dir/file.ts", xy: " D", mtime_ms: null },
        { path: "dir/sub/nested.ts", xy: " D", mtime_ms: null },
        // Negative control: a sibling dir MUST NOT match.
        { path: "other/c.ts", xy: " D", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  const inside1 = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-rmslash", "dir/file.ts");
  const inside2 = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-rmslash", "dir/sub/nested.ts");
  const outside = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-rmslash", "other/c.ts");
  expect(inside1).not.toBeNull();
  expect(inside2).not.toBeNull();
  expect(outside).toBeNull();
});

test("GitSnapshot deletion-attribution: git-rm fnmatch glob token matches *.ts", () => {
  // `git rm '*.ts'` (post-resolveAgainstCwd) → `/repo/*.ts`. The
  // fnmatch path attributes files matching `[^/]*\.ts` (a single
  // segment only — `*` does NOT cross `/`).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-glob" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-glob" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-glob",
    cwd: "/repo",
    bash_mutation_kind: "git-rm",
    bash_mutation_targets: JSON.stringify(["/repo/*.ts"]),
    data: JSON.stringify({ tool_input: { command: "git rm '*.ts'" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        // Top-level .ts files match.
        { path: "a.ts", xy: " D", mtime_ms: null },
        { path: "b.ts", xy: " D", mtime_ms: null },
        // Nested files MUST NOT match (`*` doesn't cross `/`).
        { path: "src/c.ts", xy: " D", mtime_ms: null },
        // Wrong extension MUST NOT match.
        { path: "d.js", xy: " D", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  const a = db
    .query(
      "SELECT 1 FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-glob", "a.ts");
  const b = db
    .query(
      "SELECT 1 FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-glob", "b.ts");
  const c = db
    .query(
      "SELECT 1 FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-glob", "src/c.ts");
  const d = db
    .query(
      "SELECT 1 FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-glob", "d.js");
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(c).toBeNull();
  expect(d).toBeNull();
});

test("GitSnapshot deletion-attribution: git-mv attributes both source and destination", () => {
  // `git mv old.ts new.ts` → `bash_mutation_targets = ["/repo/old.ts",
  // "/repo/new.ts"]`. The snapshot reports the rename as a single dirty
  // file with `path=new.ts, orig_path=old.ts` (the git porcelain `R `
  // status). The reducer probes BOTH candidate paths (path + orig_path)
  // so the renamed file attributes on both ends.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-mv" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-mv" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-mv",
    cwd: "/repo",
    bash_mutation_kind: "git-mv",
    bash_mutation_targets: JSON.stringify(["/repo/old.ts", "/repo/new.ts"]),
    data: JSON.stringify({ tool_input: { command: "git mv old.ts new.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "new.ts", orig_path: "old.ts", xy: "R ", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  // The attribution row is keyed on the SNAPSHOT path (`new.ts`) — the
  // file_path the upsert uses is `file.path`, not the matched token.
  const row = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-mv", "new.ts") as {
    op: string;
    source: string;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.source).toBe("bash");
  expect(row?.op).toBe("git-mv");
  // No orphan — the rename is fully attributed.
  const jobRow = db
    .query("SELECT git_orphan_count FROM jobs WHERE job_id = ?")
    .get("sess-mv") as { git_orphan_count: number } | null;
  expect(jobRow?.git_orphan_count).toBe(0);
});

test("GitSnapshot deletion-attribution: __TREE__ sentinel never matches a real file", () => {
  // A `git checkout` event (tree-mutator, no pathspec) stamps the
  // `__TREE__` sentinel as its sole target. The deletion-attribution
  // pass MUST NOT prefix-match or glob-match `__TREE__` against any
  // real path — the sentinel signals "no pathspec, attribute nothing
  // via this token" and the reducer enforces that by skipping the
  // literal token before the prefix/glob probes.
  //
  // We use a `git-rm` event (the kind the deletion path scans) carrying
  // ONLY the sentinel to prove the skip — even if a future change
  // routed sentinel-bearing rows through the kind filter, the file
  // still wouldn't attribute.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-sentinel" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-sentinel" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-sentinel",
    cwd: "/repo",
    bash_mutation_kind: "git-rm",
    bash_mutation_targets: JSON.stringify(["__TREE__"]),
    data: JSON.stringify({
      tool_input: { command: "git rm --pathspec-from-file=list" },
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "real.ts", xy: " D", mtime_ms: null }],
    }),
  });
  drainAll();
  // The sentinel must NOT attribute the file — zero file_attributions
  // rows for this (project, session, file) tuple.
  const row = db
    .query(
      "SELECT 1 FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-sentinel", "real.ts");
  expect(row).toBeNull();
  // Project-wide rollup confirms the file is a strict-mystery orphan.
  const statusRow = db
    .query("SELECT orphaned_count FROM git_status WHERE project_dir = ?")
    .get("/repo") as { orphaned_count: number } | null;
  expect(statusRow?.orphaned_count).toBe(1);
});

test("GitSnapshot deletion-attribution: plain modification still attributes via exact match (negative control)", () => {
  // Regression guard: the new prefix/glob path must not regress the
  // existing exact-match behavior on a non-deletion event. A plain
  // `git checkout file.ts` deriver-stamped as `git-tree-mutate` with a
  // single exact target still attributes the modification via the SQL
  // exact path (NOT the new git-rm/git-mv JS scan, which is gated on
  // kind ∈ {git-rm, git-mv}).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-mod" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-mod" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-mod",
    cwd: "/repo",
    bash_mutation_kind: "git-tree-mutate",
    bash_mutation_targets: JSON.stringify(["/repo/file.ts"]),
    data: JSON.stringify({
      tool_input: { command: "git checkout -- file.ts" },
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      // Plain modification (not a delete).
      dirty_files: [{ path: "file.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-mod", "file.ts") as {
    op: string;
    source: string;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.source).toBe("bash");
  expect(row?.op).toBe("git-tree-mutate");
});

test("fn-787 re-fold determinism: hoisted pass-1 scans (tool + bash-exact + git-rm/git-mv) re-fold byte-identical", () => {
  // The pass-1 explicit-attribution scans (tool ARM A/B, bash exact-match,
  // git-rm/git-mv deletion) are hoisted ONCE per snapshot and matched per file
  // in JS. The hoist reorders evaluation relative to the old per-file scans, so
  // the newest-wins `(ts, id)` tie-break must still produce byte-identical
  // `file_attributions` rows. Drive every arm across multiple files + sessions
  // (including a same-file tie between two sessions and a git-mv rename probing
  // both candidate paths), then re-fold from cursor=0 and assert byte-equality.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-t" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-t" });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-u" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-u" });
  // Tool arm: two sessions write the SAME file at distinct ts → newest-wins.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-t",
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/shared.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Edit",
    session_id: "sess-u",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/shared.ts" } }),
  });
  // Bash exact-match arm.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-t",
    cwd: "/repo",
    ts: 150,
    bash_mutation_kind: "fs-remove",
    bash_mutation_targets: JSON.stringify(["/repo/gen/out.ts"]),
    data: JSON.stringify({ tool_input: { command: "rm gen/out.ts" } }),
  });
  // git-rm directory-prefix arm.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-u",
    cwd: "/repo",
    ts: 160,
    bash_mutation_kind: "git-rm",
    bash_mutation_targets: JSON.stringify(["/repo/legacy"]),
    data: JSON.stringify({ tool_input: { command: "git rm -r legacy" } }),
  });
  // git-mv rename arm — probes both path and orig_path.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-t",
    cwd: "/repo",
    ts: 170,
    bash_mutation_kind: "git-mv",
    bash_mutation_targets: JSON.stringify(["/repo/old.ts", "/repo/new.ts"]),
    data: JSON.stringify({ tool_input: { command: "git mv old.ts new.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: "abc",
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "src/shared.ts", xy: " M", mtime_ms: null },
        { path: "gen/out.ts", xy: " D", mtime_ms: null },
        { path: "legacy/a.ts", xy: " D", mtime_ms: null },
        { path: "legacy/sub/b.ts", xy: " D", mtime_ms: null },
        { path: "new.ts", orig_path: "old.ts", xy: "R ", mtime_ms: null },
        // Orphan negative control — no mutation references it.
        { path: "untracked.ts", xy: " D", mtime_ms: null },
      ],
    }),
  });
  expect(drainAll()).toBeGreaterThan(0);

  const cursor1 = getCursor();
  const fileAttrib1 = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();
  const gitStatus1 = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();
  const jobs1 = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  // The shared file resolves to the newest writer (sess-u @ ts=200).
  expect(
    getAttribution("/repo", "sess-u", "src/shared.ts")?.last_mutation_at,
  ).toBe(200);

  // Re-fold from cursor=0: drop the projections, rewind, re-drain.
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  expect(drainAll()).toBeGreaterThan(0);

  expect(getCursor()).toBe(cursor1);
  expect(
    JSON.stringify(
      db
        .query(
          "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
        )
        .all(),
    ),
  ).toBe(JSON.stringify(fileAttrib1));
  expect(
    JSON.stringify(
      db.query("SELECT * FROM git_status ORDER BY project_dir").all(),
    ),
  ).toBe(JSON.stringify(gitStatus1));
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(JSON.stringify(jobs1));
});

test("fn-892 incremental pass-1 memo: warm-cache fold equals a cold full rescan byte-for-byte", () => {
  // The pass-1 bash + git-rm/git-mv scans are memoized per `Database` (fn-892):
  // each fold scans only `id > maxId` and appends to the cached structures. This
  // proves the WARM path (memo built incrementally across several GitSnapshots,
  // each interleaving NEW mutations) reproduces the SAME `file_attributions` as a
  // COLD full rescan (memo forced cold, one `id > 0` scan) over the identical log.
  // Equivalence rests on the scans being a faithful superset (append-only log) and
  // the consumer being newest-wins on (ts, id) — order-insensitive.
  //
  // Three snapshot rounds, each preceded by a fresh bash + git-rm mutation, so the
  // memo's incremental delta is non-empty on every fold (not just the first).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-w" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-w" });

  function seedRound(n: number): void {
    insertEvent({
      hook_event: "PostToolUse",
      tool_name: "Bash",
      session_id: "sess-w",
      cwd: "/repo",
      ts: 1000 + n * 10,
      bash_mutation_kind: "fs-remove",
      bash_mutation_targets: JSON.stringify([`/repo/gen/out${n}.ts`]),
      data: JSON.stringify({ tool_input: { command: `rm gen/out${n}.ts` } }),
    });
    insertEvent({
      hook_event: "PostToolUse",
      tool_name: "Bash",
      session_id: "sess-w",
      cwd: "/repo",
      ts: 1000 + n * 10 + 1,
      bash_mutation_kind: "git-rm",
      bash_mutation_targets: JSON.stringify([`/repo/legacy${n}`]),
      data: JSON.stringify({ tool_input: { command: `git rm -r legacy${n}` } }),
    });
    insertEvent({
      hook_event: "GitSnapshot",
      session_id: "/repo",
      cwd: "/repo",
      ts: 1000 + n * 10 + 2,
      data: JSON.stringify({
        project_dir: "/repo",
        branch: "main",
        head_oid: `oid${n}`,
        upstream: null,
        ahead: null,
        behind: null,
        // Every round's snapshot carries EVERY round's files so far, so a later
        // fold must still see earlier-round mutation rows (proving the memo
        // retained them across appends, not just the latest delta).
        dirty_files: Array.from({ length: n + 1 }, (_, i) => [
          { path: `gen/out${i}.ts`, xy: " D" as const, mtime_ms: null },
          { path: `legacy${i}/a.ts`, xy: " D" as const, mtime_ms: null },
        ]).flat(),
      }),
    });
  }

  // WARM path: drain after EACH round so the memo accumulates incrementally.
  for (let n = 0; n < 3; n++) {
    seedRound(n);
    drainAll();
  }
  const warm = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();
  // Sanity: the run produced bash + git-rm attributions across all three rounds.
  expect(warm.length).toBeGreaterThan(0);

  // COLD path: rewind the cursor + wipe the projection, FORCE the memo cold, then
  // re-drain the whole log in one pass — the memo does a single `id > 0` rescan.
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  __resetGitAttribMemoForTest(db);
  drainAll();
  const cold = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();

  // Byte-identical: the incremental append equals the full scan.
  expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
});

test("fn-1052 SubagentStart parse cache: warm-cache folds equal a cold (reset + single-drain) rebuild byte-for-byte", () => {
  // The SubagentStart FIFO bridge probe (`findPendingPreToolUseForStart`)
  // memoizes each candidate blob's `JSON.parse` per event id in a per-`Database`
  // WeakMap. This proves the WARM path (memo accumulated across several drains,
  // each interleaving a fresh bridge round) reproduces the SAME
  // `subagent_invocations` as a COLD rebuild (memo forced cold, one drain) over
  // the identical log. Two permanently-unbound candidates (a malformed body and
  // a non-matching subagent_type) stay in the anti-join result on every later
  // SubagentStart, exercising the negative-cache path across folds.
  const SESS = "sub-parse-cache-sess";
  insertEvent({ hook_event: "SessionStart", session_id: SESS });
  // Malformed body → cached negative; never binds.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    session_id: SESS,
    tool_use_id: "tu-bad",
    data: "{ not json",
  });
  // Non-matching subagent_type → parsed once, never matches "worker".
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    session_id: SESS,
    tool_use_id: "tu-ghost",
    data: JSON.stringify({
      tool_input: { subagent_type: "ghost", description: "g", prompt: "gg" },
    }),
  });
  drainAll();

  function bridgeRound(n: number): void {
    // A matching PreToolUse:Agent below the round's SubagentStart, then the
    // SubagentStart that FIFO-binds it (its id ceiling includes this candidate,
    // excludes any later round's).
    insertEvent({
      hook_event: "PreToolUse",
      tool_name: "Agent",
      session_id: SESS,
      tool_use_id: `tu-${n}`,
      data: JSON.stringify({
        tool_input: {
          subagent_type: "worker",
          description: `d${n}`,
          prompt: `prompt-${n}`,
        },
      }),
    });
    insertEvent({
      hook_event: "SubagentStart",
      session_id: SESS,
      agent_id: `agent-${n}`,
      agent_type: "worker",
    });
  }

  // WARM path: drain after EACH round so the memo accumulates incrementally.
  for (let n = 0; n < 3; n++) {
    bridgeRound(n);
    drainAll();
  }
  const warm = db
    .query(
      "SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq",
    )
    .all();
  // Sanity: each round's SubagentStart lifted its matching candidate at start.
  expect(warm.length).toBe(3);
  expect(
    (warm as Array<{ tool_use_id: string | null }>).map((r) => r.tool_use_id),
  ).toEqual(["tu-0", "tu-1", "tu-2"]);

  // COLD path: rewind the cursor + wipe the projection, FORCE the parse cache
  // cold, then re-drain the whole log in one pass.
  db.run("DELETE FROM subagent_invocations");
  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  __resetSubagentPreParseMemoForTest(db);
  drainAll();
  const cold = db
    .query(
      "SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq",
    )
    .all();

  // Byte-identical: the warm parse cache equals a cold rebuild.
  expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
});

test("fn-1052 SubagentStart id ceiling: a SubagentStart does NOT bind a FUTURE PreToolUse:Agent (live-vs-refold divergence closed)", () => {
  // The ONLY matching candidate is folded AFTER the SubagentStart (higher id).
  // Because a test drain pre-inserts every row, WITHOUT the ceiling the
  // SubagentStart fold would see the future PreToolUse:Agent and bind it — the
  // exact latent divergence from live-fold semantics. WITH the ceiling
  // (`id < currentEventId`) neither a live fold nor a re-fold at this id sees
  // it, so the turn-0 row keeps its unbound seed.
  const SESS = "sub-future-cand-sess";
  insertEvent({ hook_event: "SessionStart", session_id: SESS });
  insertEvent({
    hook_event: "SubagentStart",
    session_id: SESS,
    agent_id: "agent-fut",
    agent_type: "scout",
  });
  // Future matching candidate (higher event id than the SubagentStart above).
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Agent",
    session_id: SESS,
    tool_use_id: "tu-future",
    data: JSON.stringify({
      tool_input: {
        subagent_type: "scout",
        description: "future",
        prompt: "later",
      },
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT tool_use_id, description, prompt_chars, subagent_type FROM subagent_invocations WHERE agent_id = 'agent-fut'",
    )
    .get() as {
    tool_use_id: string | null;
    description: string | null;
    prompt_chars: number;
    subagent_type: string | null;
  };
  // Unbound seed preserved — the future candidate was ignored.
  expect(row.tool_use_id).toBeNull();
  expect(row.description).toBeNull();
  expect(row.prompt_chars).toBe(0);
  expect(row.subagent_type).toBe("scout");

  // Re-fold determinism: rewind + wipe + re-drain reproduces the same unbound
  // row (the ceiling makes both re-fold and live agree).
  db.run("DELETE FROM subagent_invocations");
  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  __resetSubagentPreParseMemoForTest(db);
  drainAll();
  const refold = db
    .query(
      "SELECT tool_use_id FROM subagent_invocations WHERE agent_id = 'agent-fut'",
    )
    .get() as { tool_use_id: string | null };
  expect(refold.tool_use_id).toBeNull();
});

test("fn-921 warmGitAttribMemo: pre-warming before the first fold yields the SAME file_attributions as lazy warm-on-first-fold", () => {
  // The boot-seed pre-warms the per-`Database` memo OUTSIDE the per-root fold
  // loop (so the cold O(history) scan doesn't run inside a lock-held fold racing
  // the seed budget). Pre-warming must be a PURE optimization: the resulting
  // projection bytes are identical to lazily warming the memo on the first fold.
  // Same log, same connection: drain LAZILY, then rewind + wipe + reset the memo
  // and re-drain with an explicit pre-warm — the two projections must match.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-pw" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-pw",
    cwd: "/repo",
    ts: 2000,
    bash_mutation_kind: "git-rm",
    bash_mutation_targets: JSON.stringify(["/repo/old"]),
    data: JSON.stringify({ tool_input: { command: "git rm -r old" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-pw",
    cwd: "/repo",
    ts: 2001,
    mutation_path: "/repo/new.ts",
    data: JSON.stringify({ tool_input: { file_path: "/repo/new.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 2002,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: "oidpw",
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "old/a.ts", xy: " D" as const, mtime_ms: null },
        { path: "new.ts", xy: " M" as const, mtime_ms: null },
      ],
    }),
  });

  // LAZY path: drain (the first fold warms the memo on its own).
  drainAll();
  const lazy = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();
  expect(lazy.length).toBeGreaterThan(0); // the run actually attributed something

  // PRE-WARM path: rewind the cursor, wipe the projection + memo, then warm the
  // memo BEFORE re-draining — the explicit hoist the boot-seed performs.
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM git_status");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  __resetGitAttribMemoForTest(db);
  warmGitAttribMemo(db); // pre-warm before any fold
  drainAll();
  const prewarmed = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();
  // Byte-identical projection: pre-warming changed no output.
  expect(JSON.stringify(prewarmed)).toBe(JSON.stringify(lazy));
});

test("fn-921 warmGitAttribMemo: warming an empty log is a no-op (no throw, leaves the memo at the head)", () => {
  // The boot-seed warms the memo unconditionally; on an empty/near-empty log it
  // must be a safe no-op. A subsequent fold over a fresh GitSnapshot still
  // attributes correctly (the memo was warmed to head, not corrupted).
  expect(() => warmGitAttribMemo(db)).not.toThrow();
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 3000,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: "oid-empty",
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [],
    }),
  });
  drainAll();
  // A clean snapshot still lands a git_status row (proving the fold ran after the
  // warm, unperturbed).
  const row = db
    .query("SELECT dirty_count FROM git_status WHERE project_dir = '/repo'")
    .get() as { dirty_count: number } | null;
  expect(row?.dirty_count ?? 0).toBe(0);
});

test("fn-892 incremental pass-1 memo: a malformed bash_mutation_targets row advances the watermark (no stall, no throw)", () => {
  // A permanently-malformed `bash_mutation_targets` row must still advance the
  // memo watermark past itself — otherwise it would re-anchor every later scan
  // and re-process the whole tail forever. Seed a malformed bash row BEFORE a
  // valid one + snapshot; the valid attribution must land and a re-drain on the
  // warmed memo must reproduce it byte-for-byte.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-m" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-m",
    cwd: "/repo",
    ts: 500,
    bash_mutation_kind: "fs-remove",
    // Malformed JSON — the parse `continue`s, but the watermark must still move.
    bash_mutation_targets: "{not valid json",
    data: JSON.stringify({ tool_input: { command: "rm x" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-m",
    cwd: "/repo",
    ts: 510,
    bash_mutation_kind: "fs-remove",
    bash_mutation_targets: JSON.stringify(["/repo/good.ts"]),
    data: JSON.stringify({ tool_input: { command: "rm good.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 520,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "good.ts", xy: " D", mtime_ms: null }],
    }),
  });
  // Never throws — the malformed row safe-folds.
  expect(() => drainAll()).not.toThrow();
  const good = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-m", "good.ts") as {
    op: string;
    source: string;
  } | null;
  expect(good).not.toBeNull();
  expect(good?.source).toBe("bash");

  // Re-fold on the SAME warmed connection (memo already past the malformed row)
  // reproduces the attribution byte-for-byte — the watermark did not stall.
  const warm = JSON.stringify(
    db
      .query(
        "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
      )
      .all(),
  );
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  __resetGitAttribMemoForTest(db);
  drainAll();
  const cold = JSON.stringify(
    db
      .query(
        "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
      )
      .all(),
  );
  expect(warm).toBe(cold);
});

test("GitSnapshot multi-attribution: two sessions touch the same file → both rows in attributions[]", () => {
  // Sess-a writes src/a.ts, then sess-b also writes src/a.ts. The
  // snapshot's per-file attributions[] embeds BOTH sessions.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-a" });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b" });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-b" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-b",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  const row = db
    .query("SELECT dirty_files FROM git_status WHERE project_dir = ?")
    .get("/repo") as { dirty_files: string } | null;
  const files = JSON.parse(row?.dirty_files ?? "[]") as Array<{
    path: string;
    attributions: Array<{ session_id: string; state: string }>;
  }>;
  const file = files.find((f) => f.path === "src/a.ts");
  expect(file).not.toBeUndefined();
  expect(file?.attributions.length).toBe(2);
  const sessionIds = file?.attributions.map((a) => a.session_id).sort();
  expect(sessionIds).toEqual(["sess-a", "sess-b"]);
  // Both sessions are live ('working'), so neither file is unattributed
  // -to-live; per-session counts: each session counts THIS file once
  // (multi-attribution overcount documented in the spec).
  const counts = db
    .query(
      "SELECT job_id, git_dirty_count FROM jobs WHERE job_id IN ('sess-a','sess-b') ORDER BY job_id",
    )
    .all() as Array<{ job_id: string; git_dirty_count: number }>;
  expect(counts.map((c) => c.git_dirty_count)).toEqual([1, 1]);
});

test("GitSnapshot multi-attribution: tool + bash on the same file → bash-source wins on newer ts", () => {
  // Sess-a does a tool Write at ts=100, then a bash rm at ts=200. The
  // attribution row carries `source='bash'` and `last_mutation_at=200`
  // because the bash event is newer.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/x.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 200,
    bash_mutation_kind: "fs-remove",
    bash_mutation_targets: JSON.stringify(["/repo/x.ts"]),
    data: JSON.stringify({ tool_input: { command: "rm x.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "x.ts", xy: " D", mtime_ms: null }],
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT op, source, last_mutation_at FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", "sess-a", "x.ts") as {
    op: string;
    source: string;
    last_mutation_at: number;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.source).toBe("bash");
  expect(row?.last_mutation_at).toBe(200);
});

test("GitSnapshot discharge rule: a session that committed AFTER its mutation drops out of attributions[]", () => {
  // Sess-a writes src/a.ts at ts=100, then commits it at ts=200 (via
  // synthetic Commit event). The next GitSnapshot should NOT embed
  // sess-a in src/a.ts's attributions[] (the row exists but
  // last_commit_at > last_mutation_at — DISCHARGED).
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  // GitSnapshot first to create the file_attributions row.
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
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  // Commit at ts=200, sets last_commit_at = 200.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  // Another GitSnapshot — same dirty file (e.g. session re-touched but
  // didn't commit yet, OR another file is also dirty). For this test
  // we keep src/a.ts dirty but discharged.
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 300,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  const row = db
    .query("SELECT dirty_files FROM git_status WHERE project_dir = ?")
    .get("/repo") as { dirty_files: string } | null;
  const files = JSON.parse(row?.dirty_files ?? "[]") as Array<{
    path: string;
    attributions: Array<{ session_id: string }>;
  }>;
  // src/a.ts in dirty_files, but discharged → empty attributions.
  expect(files[0]?.attributions).toEqual([]);
  // sess's per-session count: 0 (no on-the-hook files).
  const count = db
    .query("SELECT git_dirty_count FROM jobs WHERE job_id = ?")
    .get(TEST_UUID) as { git_dirty_count: number } | null;
  expect(count?.git_dirty_count).toBe(0);
});

test("GitSnapshot re-discharge: mutate → commit → re-mutate → file back in attributions[]", () => {
  // Sess-a writes, commits, then writes AGAIN. The third snapshot
  // shows sess-a back in attributions[].
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
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
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  // Re-mutate after commit.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Edit",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 300,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 400,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  // last_mutation_at=300 > last_commit_at=200 → back on the hook.
  const row = db
    .query("SELECT dirty_files FROM git_status WHERE project_dir = ?")
    .get("/repo") as { dirty_files: string } | null;
  const files = JSON.parse(row?.dirty_files ?? "[]") as Array<{
    attributions: Array<{ session_id: string }>;
  }>;
  expect(files[0]?.attributions.length).toBe(1);
  expect(files[0]?.attributions[0]?.session_id).toBe(TEST_UUID);
});

// ---------------------------------------------------------------------------
// fn-664.2: content-aware discharge gate. `foldCommit` compares the commit's
// per-file `(blob_oid, committed_mode)` against the file_attributions row's
// stored `(worktree_oid, worktree_mode)` and SUPPRESSES discharge when the
// worktree diverged from the committed bytes/mode — the stage→re-edit→commit
// case that orphaned dirty files pre-v45.
// ---------------------------------------------------------------------------

test("fn-664.2 content-aware gate: stage→re-edit→commit (committed_oid != worktree_oid) STAYS attributed", () => {
  // Session writes src/a.ts at ts=100, snapshot at ts=150 observes
  // worktree_oid=A (the latest dirty bytes). Commit at ts=200 captures
  // a DIFFERENT blob_oid=B (e.g. the user staged earlier, then re-edited
  // the worktree, then committed the staged blob). Without the gate the
  // discharge would orphan the file. With the gate, foldCommit reads
  // back worktree_oid=A != committed B → suppresses discharge →
  // attribution stays live, file does NOT orphan.
  const WORKTREE_OID = TEST_OID; // bytes currently in the worktree
  const COMMITTED_OID = TEST_OID_2; // the (older, staged) bytes the commit captured
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  // GitSnapshot freezes the latest worktree_oid into file_attributions.
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
          path: "src/a.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: WORKTREE_OID,
          worktree_mode: "100644",
        },
      ],
    }),
  });
  // Commit captures a different blob (the staged bytes, not the
  // worktree bytes). Same mode, mismatching oid.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID_2,
      parent_oid: null,
      files: [
        {
          path: "src/a.ts",
          blob_oid: COMMITTED_OID,
          committed_mode: "100644",
        },
      ],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  // A subsequent snapshot still shows the file dirty with the same
  // worktree_oid (still the post-re-edit bytes).
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 300,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "src/a.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: WORKTREE_OID,
          worktree_mode: "100644",
        },
      ],
    }),
  });
  drainAll();
  // The gate suppressed discharge: last_commit_at is still NULL on
  // the attribution row.
  const fa = db
    .query(
      "SELECT last_commit_at FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", TEST_UUID, "src/a.ts") as
    | { last_commit_at: number | null }
    | undefined;
  expect(fa?.last_commit_at).toBeNull();
  // The dirty file's attributions[] still carries the session — it did
  // NOT orphan.
  const row = db
    .query("SELECT dirty_files FROM git_status WHERE project_dir = ?")
    .get("/repo") as { dirty_files: string } | null;
  const files = JSON.parse(row?.dirty_files ?? "[]") as Array<{
    attributions: Array<{ session_id: string }>;
  }>;
  expect(files[0]?.attributions.length).toBe(1);
  expect(files[0]?.attributions[0]?.session_id).toBe(TEST_UUID);
  // And `git_orphan_count` is 0 (the file has an active attribution).
  const status = db
    .query("SELECT orphaned_count FROM git_status WHERE project_dir = ?")
    .get("/repo") as { orphaned_count: number } | null;
  expect(status?.orphaned_count).toBe(0);
});

test("fn-664.2 content-aware gate: commit captured the worktree (committed_oid == worktree_oid && mode ==) DISCHARGES as before", () => {
  // Regression: the legacy discharge path must still fire when the
  // commit really did capture the latest worktree bytes + mode. Verifies
  // the gate didn't accidentally break the happy path.
  const OID = TEST_OID;
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
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
          path: "src/a.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: OID,
          worktree_mode: "100644",
        },
      ],
    }),
  });
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID_2,
      parent_oid: null,
      files: [{ path: "src/a.ts", blob_oid: OID, committed_mode: "100644" }],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 300,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "src/a.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: OID,
          worktree_mode: "100644",
        },
      ],
    }),
  });
  drainAll();
  // Discharge fired: last_commit_at stamped, attribution dropped from
  // the rendered list.
  const fa = db
    .query(
      "SELECT last_commit_at FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", TEST_UUID, "src/a.ts") as
    | { last_commit_at: number | null }
    | undefined;
  expect(fa?.last_commit_at).toBe(200);
  const row = db
    .query("SELECT dirty_files FROM git_status WHERE project_dir = ?")
    .get("/repo") as { dirty_files: string } | null;
  const files = JSON.parse(row?.dirty_files ?? "[]") as Array<{
    attributions: Array<{ session_id: string }>;
  }>;
  expect(files[0]?.attributions).toEqual([]);
});

test("fn-664.2 content-aware gate: chmod-only (equal blob_oid, different worktree_mode) STAYS attributed", () => {
  // The worktree bytes equal the committed bytes (worktree_oid ==
  // blob_oid), but the worktree mode is 100755 while the commit
  // captured 100644 (e.g. user chmod +x'd the worktree, then committed
  // the bytes without the mode change). Without the mode check the
  // file would wrongly discharge; with it, attribution stays live.
  const OID = TEST_OID;
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/script.sh" } }),
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
          path: "script.sh",
          xy: " M",
          mtime_ms: null,
          worktree_oid: OID,
          worktree_mode: "100755",
        },
      ],
    }),
  });
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID_2,
      parent_oid: null,
      files: [{ path: "script.sh", blob_oid: OID, committed_mode: "100644" }],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 300,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "script.sh",
          xy: " M",
          mtime_ms: null,
          worktree_oid: OID,
          worktree_mode: "100755",
        },
      ],
    }),
  });
  drainAll();
  // Gate suppressed discharge on mode mismatch.
  const fa = db
    .query(
      "SELECT last_commit_at FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", TEST_UUID, "script.sh") as
    | { last_commit_at: number | null }
    | undefined;
  expect(fa?.last_commit_at).toBeNull();
  const row = db
    .query("SELECT dirty_files FROM git_status WHERE project_dir = ?")
    .get("/repo") as { dirty_files: string } | null;
  const files = JSON.parse(row?.dirty_files ?? "[]") as Array<{
    attributions: Array<{ session_id: string }>;
  }>;
  expect(files[0]?.attributions.length).toBe(1);
  expect(files[0]?.attributions[0]?.session_id).toBe(TEST_UUID);
});

test("fn-664.2 NULL-oid legacy event: pre-v44 Commit payload (files: string[]) falls back to unconditional timestamp discharge", () => {
  // Re-fold determinism guard: a legacy-shape Commit event (files
  // as a string array, no blob_oid / committed_mode) MUST discharge
  // unconditionally — identical to pre-v45 behavior. Otherwise a
  // cursor=0 re-fold over historical events would diverge from the
  // live projection. extractCommit normalizes legacy strings to
  // `{path, blob_oid: null, committed_mode: null}`; foldCommit's
  // gate sees both null and falls through to the legacy UPDATE.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/legacy.ts" } }),
  });
  // Snapshot WITH a worktree_oid (the live producer always emits it
  // now). The Commit event itself is legacy (string array) — so the
  // gate's `committed_oid` is null → fall back path.
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
          path: "src/legacy.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: TEST_OID,
          worktree_mode: "100644",
        },
      ],
    }),
  });
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID_2,
      parent_oid: null,
      // Legacy shape: string array, no blob_oid / committed_mode.
      files: ["src/legacy.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  drainAll();
  // Legacy fall-back fired: last_commit_at stamped.
  const fa = db
    .query(
      "SELECT last_commit_at FROM file_attributions WHERE project_dir = ? AND session_id = ? AND file_path = ?",
    )
    .get("/repo", TEST_UUID, "src/legacy.ts") as
    | { last_commit_at: number | null }
    | undefined;
  expect(fa?.last_commit_at).toBe(200);
});

test("fn-664.2 cursor=0 re-fold determinism: content-aware gate reproduces byte-identical projections", () => {
  // Plant a mixed-shape stream: legacy-shape commit + v45 mismatching
  // commit + v45 matching commit. Drain to steady state, snapshot
  // git_status + file_attributions, rewind cursor to 0, DELETE both
  // projection tables, re-drain, snapshot again. Byte-identical or
  // re-fold determinism is broken.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  // File 1: legacy commit (will discharge via fall-back).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/legacy.ts" } }),
  });
  // File 2: v45 mismatching commit (gate suppresses discharge).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 110,
    data: JSON.stringify({ tool_input: { file_path: "/repo/mismatch.ts" } }),
  });
  // File 3: v45 matching commit (discharge).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 120,
    data: JSON.stringify({ tool_input: { file_path: "/repo/match.ts" } }),
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
          path: "legacy.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: null,
          worktree_mode: null,
        },
        {
          path: "mismatch.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: TEST_OID,
          worktree_mode: "100644",
        },
        {
          path: "match.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: TEST_OID_2,
          worktree_mode: "100644",
        },
      ],
    }),
  });
  // Legacy commit: discharges legacy.ts via fall-back.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["legacy.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  // v45 mismatching commit: gate suppresses. blob_oid=TEST_OID_2 but
  // worktree_oid=TEST_OID.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 210,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID_2,
      parent_oid: null,
      files: [
        {
          path: "mismatch.ts",
          blob_oid: TEST_OID_2,
          committed_mode: "100644",
        },
      ],
      committer_session_id: TEST_UUID,
      committed_at_ms: 210_000,
    }),
  });
  // v45 matching commit: discharges match.ts (oid + mode equal).
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 220,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: [
        {
          path: "match.ts",
          blob_oid: TEST_OID_2,
          committed_mode: "100644",
        },
      ],
      committer_session_id: TEST_UUID,
      committed_at_ms: 220_000,
    }),
  });
  drainAll();

  // Snapshot live projection.
  const liveGitStatus = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();
  const liveAttributions = db
    .query(
      "SELECT project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source, last_event_id, updated_at, worktree_oid, worktree_mode FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();

  // Rewind: cursor=0 + DELETE both projections, then re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  // Also drop jobs counts that the fan-out wrote (re-fold also rewrites
  // them; comparing the file-attribution / git-status projections is
  // sufficient for the gate's determinism).
  drainAll();

  const refoldedGitStatus = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();
  const refoldedAttributions = db
    .query(
      "SELECT project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source, last_event_id, updated_at, worktree_oid, worktree_mode FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();

  expect(refoldedGitStatus).toEqual(liveGitStatus);
  expect(refoldedAttributions).toEqual(liveAttributions);
});

test("GitSnapshot global discharge: NULL committer clears every session's attribution", () => {
  // Two sessions write the same file. A NULL-committer commit (human or
  // CI commit, trailer-less) globally clears both attributions. The
  // next snapshot shows zero attributions on the file.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID_2 });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID_2,
    cwd: "/repo",
    ts: 110,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
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
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  // Global discharge: no committer_session_id.
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: null,
      committed_at_ms: 200_000,
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 300,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  // Both sessions discharged → empty attributions.
  const row = db
    .query("SELECT dirty_files FROM git_status WHERE project_dir = ?")
    .get("/repo") as { dirty_files: string } | null;
  const files = JSON.parse(row?.dirty_files ?? "[]") as Array<{
    attributions: unknown[];
  }>;
  expect(files[0]?.attributions).toEqual([]);
});

test("GitSnapshot inferred attribution: bash bracket containing the mtime mints an inferred row", () => {
  // Sess-a has a PreToolUse:Bash @ ts=100 and PostToolUse:Bash @ ts=200,
  // same tool_use_id, cwd=/repo. A dirty file with mtime_ms=150000
  // (150 seconds) falls inside the bracket. No explicit attribution
  // exists. Result: an inferred attribution row.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 100,
    tool_use_id: "toolu_inferred_x",
    data: JSON.stringify({ tool_input: { command: "make build" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 200,
    tool_use_id: "toolu_inferred_x",
    data: JSON.stringify({ tool_input: { command: "make build" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "build/out.o",
          xy: "??",
          mtime_ms: 150_000, // 150s; sits inside the (100, 200] bracket
        },
      ],
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT op, source, last_mutation_at FROM file_attributions WHERE project_dir = ? AND session_id = ?",
    )
    .get("/repo", "sess-a") as {
    op: string;
    source: string;
    last_mutation_at: number;
  } | null;
  expect(row).not.toBeNull();
  expect(row?.source).toBe("inferred");
  expect(row?.op).toBe("inferred");
  expect(row?.last_mutation_at).toBe(150); // mtime_ms / 1000
});

test("GitSnapshot inferred attribution: a window longer than MAX_BASH_WINDOW_SEC is NOT used (pre.ts lower-bound)", () => {
  // computeRepoBashWindows bounds the pre-side scan with
  // `pre.ts >= minMtime - MAX_BASH_WINDOW_SEC` (3600s). That bound is loss-free
  // for real windows (a bash command can't outlast the 600s tool timeout), but
  // it DOES exclude a synthetic window whose pre starts >3600s before the file
  // mtime. Here: pre @ ts=1000, post @ ts=5000 (a 4000s "window"), file
  // mtime=5000s. The exact bracket (1000 < 5000 <= 5000) would otherwise match,
  // but pre.ts=1000 < (5000 - 3600 = 1400), so the window is pruned and NO
  // inferred row is minted. This pins the bound that keeps the scan tight.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-cap" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-cap",
    cwd: "/repo",
    ts: 1000,
    tool_use_id: "toolu_cap_x",
    data: JSON.stringify({ tool_input: { command: "sleep 4000" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-cap",
    cwd: "/repo",
    ts: 5000,
    tool_use_id: "toolu_cap_x",
    data: JSON.stringify({ tool_input: { command: "sleep 4000" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "build/slow.o",
          xy: "??",
          mtime_ms: 5_000_000, // 5000s; inside (1000, 5000] but window > cap
        },
      ],
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT op, source FROM file_attributions WHERE project_dir = ? AND session_id = ?",
    )
    .get("/repo", "sess-cap") as { op: string; source: string } | null;
  // Pruned by the lower bound — the file falls through to orphan, not inferred.
  expect(row).toBeNull();
});

test("GitSnapshot inferred attribution: skipped when explicit attribution exists", () => {
  // Same setup as the inferred test, but ALSO a tool Write at ts=80
  // (BEFORE the bash bracket). Pass 2 skips the file because pass 1
  // already attributed.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 80,
    data: JSON.stringify({ tool_input: { file_path: "/repo/build/out.o" } }),
  });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 100,
    tool_use_id: "toolu_inferred_y",
    data: JSON.stringify({ tool_input: { command: "make build" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 200,
    tool_use_id: "toolu_inferred_y",
    data: JSON.stringify({ tool_input: { command: "make build" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "build/out.o", xy: " M", mtime_ms: 150_000 }],
    }),
  });
  drainAll();
  // Explicit tool attribution wins; no inferred row.
  const row = db
    .query(
      "SELECT op, source, last_mutation_at FROM file_attributions WHERE project_dir = ? AND session_id = ?",
    )
    .get("/repo", "sess-a") as {
    op: string;
    source: string;
    last_mutation_at: number;
  } | null;
  expect(row?.source).toBe("tool");
  expect(row?.op).toBe("Write");
  expect(row?.last_mutation_at).toBe(80);
});

test("GitSnapshot inferred attribution: runs when the only explicit attribution is DISCHARGED", () => {
  // Regression (fn-orphan-discharge): sess-a writes the file (ts=80),
  // commits it (ts=200 → discharges the explicit row), then a bash step
  // re-dirties it (a formatter / codegen run that leaves no Write/Edit
  // and no recognized bash_mutation) inside a (300, 400] Bash bracket.
  // The file's mtime (350) sits in that bracket. The explicit row still
  // EXISTS but is discharged (last_mutation_at=80 <= last_commit_at=200),
  // so pass 2 MUST run and mint an inferred row — otherwise the file
  // falls to <orphan> despite an available bracketing window. The old
  // guard skipped pass 2 on the mere presence of any explicit row.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 80,
    data: JSON.stringify({ tool_input: { file_path: "/repo/build/out.o" } }),
  });
  // A snapshot while the file is dirty mints the explicit row (ts=80),
  // so the later Commit has a row to stamp last_commit_at onto — the
  // real-world ordering the bug depends on.
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 120,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "build/out.o", xy: " M", mtime_ms: null }],
    }),
  });
  // Commit discharges sess-a's explicit attribution (last_commit_at=200).
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["build/out.o"],
      committer_session_id: "sess-a",
      committed_at_ms: 200_000,
    }),
  });
  // Post-commit bash bracket — no Write/Edit, no bash_mutation_kind.
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 300,
    tool_use_id: "toolu_discharged_infer",
    data: JSON.stringify({ tool_input: { command: "bun run lint" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 400,
    tool_use_id: "toolu_discharged_infer",
    data: JSON.stringify({ tool_input: { command: "bun run lint" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 500,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "build/out.o", xy: " M", mtime_ms: 350_000 }],
    }),
  });
  drainAll();
  // The discharged explicit row is re-stamped as an inferred attribution
  // (mtime 350 > last_commit_at 200 → active again).
  const row = db
    .query(
      "SELECT op, source, last_mutation_at FROM file_attributions WHERE project_dir = ? AND session_id = ?",
    )
    .get("/repo", "sess-a") as {
    op: string;
    source: string;
    last_mutation_at: number;
  } | null;
  expect(row?.source).toBe("inferred");
  expect(row?.op).toBe("inferred");
  expect(row?.last_mutation_at).toBe(350);
  // Not a strict-mystery orphan — the inferred attribution claims it.
  const gs = db
    .query(
      "SELECT orphaned_count, dirty_files FROM git_status WHERE project_dir = ?",
    )
    .get("/repo") as { orphaned_count: number; dirty_files: string } | null;
  expect(gs?.orphaned_count).toBe(0);
  const files = JSON.parse(gs?.dirty_files ?? "[]") as Array<{
    attributions: Array<{ session_id: string; source: string }>;
  }>;
  expect(files[0]?.attributions.length).toBe(1);
  expect(files[0]?.attributions[0]?.session_id).toBe("sess-a");
});

test("GitSnapshot inferred attribution: skipped when mtime_ms is null", () => {
  // No mtime → no inferred attribution path. File ends up strict-
  // mystery (zero attributions).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 100,
    tool_use_id: "toolu_no_mtime",
    data: JSON.stringify({ tool_input: { command: "make build" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 200,
    tool_use_id: "toolu_no_mtime",
    data: JSON.stringify({ tool_input: { command: "make build" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "build/out.o", xy: "??", mtime_ms: null }],
    }),
  });
  drainAll();
  const count = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM file_attributions WHERE project_dir = ?",
      )
      .get("/repo") as { n: number }
  ).n;
  expect(count).toBe(0);
  // Strict-mystery orphan: file with no attribution.
  const gs = db
    .query("SELECT orphaned_count FROM git_status WHERE project_dir = ?")
    .get("/repo") as { orphaned_count: number } | null;
  expect(gs?.orphaned_count).toBe(1);
});

test("GitSnapshot inferred attribution: cwd OUTSIDE project_dir does NOT match", () => {
  // Sess-a's bash window has cwd=/elsewhere, not /repo. Even though
  // the bracket contains the mtime, no attribution lands.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/elsewhere",
    ts: 100,
    tool_use_id: "toolu_elsewhere",
    data: JSON.stringify({ tool_input: { command: "make" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    session_id: "sess-a",
    cwd: "/elsewhere",
    ts: 200,
    tool_use_id: "toolu_elsewhere",
    data: JSON.stringify({ tool_input: { command: "make" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "build/out.o", xy: "??", mtime_ms: 150_000 }],
    }),
  });
  drainAll();
  const count = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM file_attributions WHERE project_dir = ?",
      )
      .get("/repo") as { n: number }
  ).n;
  expect(count).toBe(0);
});

test("GitSnapshot strict-mystery orphan: dirty file with NO event touch → orphaned_count++", () => {
  // No events have touched orph.txt → it's strict-mystery. After the
  // snapshot, git_orphan_count broadcasts onto every live job (but no
  // job is enumerated since no session is on the hook). The
  // project-broadcast value lives in git_status.orphaned_count.
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "orph.txt", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  const gs = db
    .query(
      "SELECT dirty_count, orphaned_count FROM git_status WHERE project_dir = ?",
    )
    .get("/repo") as { dirty_count: number; orphaned_count: number } | null;
  expect(gs?.dirty_count).toBe(1);
  expect(gs?.orphaned_count).toBe(1);
});

test("GitSnapshot unattributed-to-live: file attributed only to ENDED session → count++", () => {
  // Sess-a writes src/a.ts, then SessionEnd → state='ended'. The
  // snapshot's per-file attributions still carry sess-a (the row
  // exists, undischarged) but sess-a is not LIVE — so the file
  // counts toward project-wide unattributed_to_live_count.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({ hook_event: "SessionEnd", session_id: "sess-a" });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  // sess-a still has the attribution but is ended → not-live count == 1.
  const counts = db
    .query(
      "SELECT git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-a") as {
    git_dirty_count: number;
    git_unattributed_to_live_count: number;
    git_orphan_count: number;
  } | null;
  expect(counts?.git_dirty_count).toBe(1);
  expect(counts?.git_unattributed_to_live_count).toBe(1);
  expect(counts?.git_orphan_count).toBe(0); // file IS attributed
});

test("GitSnapshot rename: orig_path matches the historical mutation event", () => {
  // Sess-a wrote `old.ts` (the path the mutation event referenced); git
  // sees `new.ts` with orig_path=`old.ts`. The reducer's pass-1 query
  // checks BOTH path and orig_path, finding the attribution.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/old.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      // git rename: new path is `new.ts`, original was `old.ts`.
      dirty_files: [
        { path: "new.ts", xy: "R ", orig_path: "old.ts", mtime_ms: null },
      ],
    }),
  });
  drainAll();
  // Attribution row indexed under `new.ts` (the current path).
  const row = getAttribution("/repo", "sess-a", "new.ts");
  expect(row).not.toBeUndefined();
});

test("GitSnapshot dirty_files[].attributions[] carries title + state from jobs row", () => {
  // The rendered per-file attribution embeds the joined job's title
  // and state.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-a",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-a",
    data: JSON.stringify({ session_title: "writing tests" }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  const row = db
    .query("SELECT dirty_files FROM git_status WHERE project_dir = ?")
    .get("/repo") as { dirty_files: string } | null;
  const files = JSON.parse(row?.dirty_files ?? "[]") as Array<{
    attributions: Array<{
      session_id: string;
      title: string | null;
      state: string;
      op: string;
      source: string;
    }>;
  }>;
  const attrib = files[0]?.attributions[0];
  expect(attrib?.session_id).toBe("sess-a");
  expect(attrib?.title).toBe("writing tests");
  expect(attrib?.state).toBe("working");
  expect(attrib?.op).toBe("Write");
  expect(attrib?.source).toBe("tool");
});

test("GitSnapshot newest-wins: two mutations on same file by same session → latest ts persists", () => {
  // Sess-a edits src/a.ts at ts=100, then writes it again at ts=200.
  // The attribution row carries ts=200 (newest-wins).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Edit",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT op, last_mutation_at FROM file_attributions WHERE project_dir = ? AND session_id = ?",
    )
    .get("/repo", "sess-a") as { op: string; last_mutation_at: number } | null;
  expect(row?.last_mutation_at).toBe(200);
  expect(row?.op).toBe("Write");
});

test("GitSnapshot project isolation: file in /repo-a does not affect /repo-b's attributions", () => {
  // Sess-a writes a file in cwd=/repo-a. A snapshot of /repo-b that
  // includes the same path should NOT find the attribution (the
  // project_dir is part of the composite key).
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo-a",
    data: JSON.stringify({ tool_input: { file_path: "/repo-a/shared.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo-b",
    cwd: "/repo-b",
    data: JSON.stringify({
      project_dir: "/repo-b",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "shared.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();
  // Repo-anchored matching (fn-633 path-canonicalization fix): pass 1
  // builds the candidate as `<project_dir>/<file.path>`, so a /repo-b
  // snapshot probes for `/repo-b/shared.ts` and never matches sess-a's
  // `/repo-a/shared.ts` mutation. The cross-worktree leak the original
  // fn-633 shipped (where the bare relative path matched across repos) is
  // closed — no attribution row lands in /repo-b.
  const row = getAttribution("/repo-b", "sess-a", "shared.ts");
  expect(row).toBeNull();
});

test("GitSnapshot re-fold determinism over a full attribution lifecycle", () => {
  // Stress: SessionStart, mutations, GitSnapshot, Commit (discharge),
  // re-mutate, GitSnapshot. Then rewind cursor + delete projection
  // rows; re-drain produces byte-identical rows.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
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
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Edit",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 300,
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 400,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "src/a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  drainAll();

  const beforeAttribs = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();
  const beforeGit = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();
  const beforeJobs = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  // Rewind + DELETE every projection + redrain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  const afterAttribs = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();
  const afterGit = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();
  const afterJobs = db.query("SELECT * FROM jobs ORDER BY job_id").all();

  expect(afterAttribs).toEqual(beforeAttribs);
  expect(afterGit).toEqual(beforeGit);
  expect(afterJobs).toEqual(beforeJobs);
});

test("GitSnapshot retract DELETEs file_attributions rows AND zeroes per-job counts symmetrically", () => {
  // Cover the symmetric retract: file_attributions for /repo wiped;
  // jobs row counts zeroed; rows for /other-repo untouched.
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-a",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [{ path: "a.ts", xy: " M", mtime_ms: null }],
    }),
  });
  // Drop /repo.
  insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/repo",
    cwd: "/repo",
    data: "",
  });
  drainAll();
  // file_attributions for /repo wiped.
  const attribs = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM file_attributions WHERE project_dir = ?",
      )
      .get("/repo") as { n: number }
  ).n;
  expect(attribs).toBe(0);
  // jobs row counts zeroed symmetrically.
  const counts = db
    .query(
      "SELECT git_dirty_count, git_unattributed_to_live_count, git_orphan_count FROM jobs WHERE job_id = ?",
    )
    .get("sess-a") as {
    git_dirty_count: number;
    git_unattributed_to_live_count: number;
    git_orphan_count: number;
  } | null;
  expect(counts?.git_dirty_count).toBe(0);
  expect(counts?.git_unattributed_to_live_count).toBe(0);
  expect(counts?.git_orphan_count).toBe(0);
});

test("from-scratch re-fold reproduces the GitSnapshot fan-out byte-identically", () => {
  // Seed a sequence: SessionStart, TaskSnapshot, mutation events,
  // GitSnapshot (stamps counts), GitSnapshot (refresh — different dirty
  // count). After every fold the jobs row + embedded array + git_status
  // + file_attributions carry the predictable counts. Rewind cursor +
  // DELETE every projection + redrain; post-rewind rows must equal
  // byte-for-byte the pre-rewind rows.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-w",
    spawn_name: "work::fn-1-foo.1",
  });
  insertEvent({
    hook_event: "TaskSnapshot",
    session_id: "fn-1-foo.1",
    data: JSON.stringify({
      task_id: "fn-1-foo.1",
      epic_id: "fn-1-foo",
      task_number: 1,
      title: "task",
      target_repo: null,
      worker_phase: "open",
      runtime_status: "todo",
      approval: "pending",
      depends_on: [],
    }),
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: "sess-w",
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/src/a.ts" } }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        { path: "src/a.ts", xy: " M", mtime_ms: null },
        { path: "orph.txt", xy: " M", mtime_ms: null },
      ],
    }),
  });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [],
    }),
  });
  drainAll();

  const beforeJobs = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const beforeEpics = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const beforeGit = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();
  const beforeAttribs = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();

  // Rewind + wipe + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  drainAll();

  const afterJobs = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  const afterEpics = db.query("SELECT * FROM epics ORDER BY epic_id").all();
  const afterGit = db
    .query("SELECT * FROM git_status ORDER BY project_dir")
    .all();
  const afterAttribs = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();

  expect(afterJobs).toEqual(beforeJobs);
  expect(afterEpics).toEqual(beforeEpics);
  expect(afterGit).toEqual(beforeGit);
  expect(afterAttribs).toEqual(beforeAttribs);
});

// ---------------------------------------------------------------------------
// Commit reducer arm — fn-633.4 commit-driven file_attributions discharge
// ---------------------------------------------------------------------------

/**
 * Insert a single file_attributions row matching the task .2 schema. The
 * fold path that creates rows lives in fn-633.6; this helper lets the
 * fn-633.4 tests stage rows directly so the discharge fold's UPDATE
 * matches.
 */
function insertAttribution(opts: {
  project_dir: string;
  session_id: string;
  file_path: string;
  last_mutation_at: number;
  last_commit_at?: number | null;
  op?: string;
  source?: "tool" | "bash" | "inferred";
}): void {
  db.run(
    `INSERT INTO file_attributions
       (project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source, last_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.project_dir,
      opts.session_id,
      opts.file_path,
      opts.last_mutation_at,
      opts.last_commit_at ?? null,
      opts.op ?? "write",
      opts.source ?? "tool",
      0,
      opts.last_mutation_at,
    ],
  );
}

function getAttribution(
  project_dir: string,
  session_id: string,
  file_path: string,
):
  | {
      last_mutation_at: number;
      last_commit_at: number | null;
      last_event_id: number | null;
      updated_at: number;
    }
  | undefined {
  return db
    .query(
      `SELECT last_mutation_at, last_commit_at, last_event_id, updated_at
         FROM file_attributions
        WHERE project_dir = ? AND session_id = ? AND file_path = ?`,
    )
    .get(project_dir, session_id, file_path) as
    | {
        last_mutation_at: number;
        last_commit_at: number | null;
        last_event_id: number | null;
        updated_at: number;
      }
    | undefined;
}

const TEST_OID = "0123456789abcdef0123456789abcdef01234567";
const TEST_OID_2 = "fedcba9876543210fedcba9876543210fedcba98";
const TEST_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const TEST_UUID_2 = "fedcba98-7654-3210-fedc-ba9876543210";

test("Commit with a valid trailer discharges ONE session's attribution for the named files", () => {
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID_2,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });

  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: TEST_OID_2,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });

  expect(drainAll()).toBe(1);
  // Committing session's attribution discharged.
  const committed = getAttribution("/repo", TEST_UUID, "src/a.ts");
  expect(committed?.last_commit_at).toBe(200);
  expect(committed?.last_event_id).toBe(id);
  // Other session's attribution untouched (per-session discharge).
  const other = getAttribution("/repo", TEST_UUID_2, "src/a.ts");
  expect(other?.last_commit_at).toBeNull();
  expect(getCursor()).toBe(id);
});

test("Commit with NULL committer_session_id globally discharges every session's attribution", () => {
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID_2,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });

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
      committed_at_ms: 300_000,
    }),
  });

  expect(drainAll()).toBe(1);
  // Both sessions' attributions cleared.
  expect(getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at).toBe(
    300,
  );
  expect(getAttribution("/repo", TEST_UUID_2, "src/a.ts")?.last_commit_at).toBe(
    300,
  );
  expect(getCursor()).toBe(id);
});

test("Commit on a file with no attribution row is a safe no-op", () => {
  // No row in file_attributions. The fold's UPDATE matches zero rows;
  // never throws, cursor still advances.
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/unknown.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 100_000,
    }),
  });

  expect(drainAll()).toBe(1);
  // No row was created (discharge cannot resurrect a non-existent
  // attribution; row creation lives in task .6's mutation-fold path).
  const count = (
    db.query("SELECT COUNT(*) AS n FROM file_attributions").get() as {
      n: number;
    }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(id);
});

test("Commit with empty files array is a safe no-op", () => {
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: [],
      committer_session_id: TEST_UUID,
      committed_at_ms: 100_000,
    }),
  });

  expect(drainAll()).toBe(1);
  expect(
    getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at,
  ).toBeNull();
  expect(getCursor()).toBe(id);
});

test("Commit with malformed data blob is a safe no-op (cursor still advances)", () => {
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: "{not-json",
  });

  expect(drainAll()).toBe(1);
  expect(
    getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at,
  ).toBeNull();
  expect(getCursor()).toBe(id);
});

test("Commit with invalid commit_oid is a safe no-op", () => {
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: "bad-oid",
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 100_000,
    }),
  });

  expect(drainAll()).toBe(1);
  expect(
    getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at,
  ).toBeNull();
  expect(getCursor()).toBe(id);
});

test("Commit with a malformed committer_session_id folds to global discharge", () => {
  // The extractCommit deriver normalizes a non-UUID committer_session_id
  // to null, which the fold treats as global discharge — matching the
  // spec's "absent or malformed → committer_session_id = null → global
  // discharge" rule.
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID_2,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: "not-a-uuid",
      committed_at_ms: 400_000,
    }),
  });
  expect(drainAll()).toBe(1);
  // Both rows discharged (global discharge — malformed trailer ⇒ null).
  expect(getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at).toBe(
    400,
  );
  expect(getAttribution("/repo", TEST_UUID_2, "src/a.ts")?.last_commit_at).toBe(
    400,
  );
  expect(getCursor()).toBe(id);
});

// ---------------------------------------------------------------------------
// fn-670 (T1): a Job-Id-coalesced Commit now takes the PER-SESSION discharge
// arm (foldCommit's `committer_session_id != null` branch), not the global
// fall-through. The git-worker's coalesce lifts `Job-Id:` → `committer_
// session_id`; by the time the event reaches the reducer, the per-session vs
// global decision is already made by the payload's non-null vs null field —
// these tests pin that the fold honors the producer's classification. The
// re-fold-determinism cousin: a legacy no-trailer Commit (committer_session_
// id=null) still global-discharges over the historical event log.
// ---------------------------------------------------------------------------

test("fn-670: Job-Id-coalesced Commit (committer_session_id non-null) takes per-session discharge arm, not global", () => {
  // Two sessions touched the same file. The fn-670 git-worker coalesce
  // would have lifted the `Job-Id:` trailer on a `jobctl commit-work`
  // commit into `committer_session_id` — so by reducer entry the field
  // is non-null and the per-session arm fires. The OTHER session's
  // attribution stays undischarged (still on-the-hook).
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID_2,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      // Non-null committer_session_id — produced by the git-worker
      // coalesce on a Job-Id-only commit. The reducer cannot tell the
      // value's provenance (Session-Id vs Job-Id) and that's correct —
      // the discharge gate is per-session regardless of which trailer
      // carried the UUID.
      committer_session_id: TEST_UUID,
      task_ids: [],
      committed_at_ms: 200_000,
    }),
  });
  expect(drainAll()).toBe(1);
  // Per-session arm fired for TEST_UUID — last_commit_at stamped.
  expect(getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at).toBe(
    200,
  );
  // Other session's attribution untouched — proves NOT global discharge.
  expect(
    getAttribution("/repo", TEST_UUID_2, "src/a.ts")?.last_commit_at,
  ).toBeNull();
  expect(getCursor()).toBe(id);
});

test("fn-670: historical no-trailer Commit (pre-fn-670, no task_ids field, committer_session_id=null) still global-discharges", () => {
  // Re-fold determinism: replay a historical Commit event (predating
  // fn-670 entirely — no `task_ids` field on the payload, no coalesce
  // applied to its `committer_session_id` because the producer ran on
  // an older binary that only knew about Session-Id). The defensive
  // extractCommit decoder defaults `task_ids` to `[]`, and the fold
  // path stays global because `committer_session_id` is null. Both
  // sessions' attributions clear identically to pre-fn-670 semantics.
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID_2,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      // Legacy string-array files shape (pre-v44) — exercises the
      // extractCommit legacy-normalize path alongside the missing
      // task_ids field.
      files: ["src/a.ts"],
      committer_session_id: null,
      // No `task_ids` field at all — pre-fn-670 events lack it. The
      // defensive decode defaults to []; the global-discharge arm
      // still fires because committer_session_id is null.
      committed_at_ms: 300_000,
    }),
  });
  expect(drainAll()).toBe(1);
  // Both rows discharged — global fall-through preserved.
  expect(getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at).toBe(
    300,
  );
  expect(getAttribution("/repo", TEST_UUID_2, "src/a.ts")?.last_commit_at).toBe(
    300,
  );
  expect(getCursor()).toBe(id);
});

test("Commit per-session discharge does NOT touch rows in a different project_dir", () => {
  // Same session_id + file_path under two different worktrees lands two
  // distinct file_attributions rows (the composite PK carries project_dir
  // as the first key). A commit on `/repo-a` must not discharge the
  // attribution on `/repo-b`.
  insertAttribution({
    project_dir: "/repo-a",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  insertAttribution({
    project_dir: "/repo-b",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });

  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo-a",
    cwd: "/repo-a",
    data: JSON.stringify({
      project_dir: "/repo-a",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 500_000,
    }),
  });

  expect(drainAll()).toBe(1);
  // /repo-a discharged; /repo-b untouched.
  expect(getAttribution("/repo-a", TEST_UUID, "src/a.ts")?.last_commit_at).toBe(
    500,
  );
  expect(
    getAttribution("/repo-b", TEST_UUID, "src/a.ts")?.last_commit_at,
  ).toBeNull();
  expect(getCursor()).toBe(id);
});

test("Commit discharges multiple files in one event", () => {
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/b.ts",
    last_mutation_at: 100,
  });
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/c.ts",
    last_mutation_at: 100,
  });

  const id = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["src/a.ts", "src/c.ts"], // not src/b.ts
      committer_session_id: TEST_UUID,
      committed_at_ms: 600_000,
    }),
  });

  expect(drainAll()).toBe(1);
  expect(getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at).toBe(
    600,
  );
  // b.ts is not in the file list → still on-the-hook.
  expect(
    getAttribution("/repo", TEST_UUID, "src/b.ts")?.last_commit_at,
  ).toBeNull();
  expect(getAttribution("/repo", TEST_UUID, "src/c.ts")?.last_commit_at).toBe(
    600,
  );
  expect(getCursor()).toBe(id);
});

test("from-scratch re-fold reproduces the Commit attribution byte-identically", () => {
  // Seed: a mutation row (pre-staged the way task .6 will mint them), a
  // Commit that discharges it, then rewind + re-drain. The committed_at
  // must come back identical from the persisted event log alone — no
  // git re-shell, no FS read.
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
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
      committed_at_ms: 700_000,
    }),
  });
  drainAll();
  const before = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();

  // Rewind cursor; but file_attributions rows persist (the per-session
  // discharge is a deterministic function of the event log + the staged
  // attribution row, so re-fold from cursor=0 over a row whose
  // last_commit_at is already stamped should reproduce the same stamp).
  // Mirrors the existing v31 re-fold determinism check (in
  // `src/db.ts:2807`) for `file_attributions`.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run(
    "UPDATE file_attributions SET last_commit_at = NULL, last_event_id = NULL WHERE 1",
  );
  // Bump updated_at back to the original mutation timestamp so the
  // post-rewind read matches the pre-rewind read after the deterministic
  // re-fold restamps it.
  db.run("UPDATE file_attributions SET updated_at = 100 WHERE 1");
  drainAll();

  const after = db
    .query(
      "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
    )
    .all();
  expect(after).toEqual(before);
});

test("Commit fold runs in the SAME transaction as cursor advance (atomicity)", () => {
  // Synthetic crash mid-fold via the applyEvent test seam — both the
  // file_attributions UPDATE and the cursor advance must roll back
  // together. Re-folding from the rolled-back state restores both.
  insertAttribution({
    project_dir: "/repo",
    session_id: TEST_UUID,
    file_path: "src/a.ts",
    last_mutation_at: 100,
  });
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
      committed_at_ms: 800_000,
    }),
  });
  // Read the event from the events table for applyEvent.
  const event = db.query("SELECT * FROM events WHERE id = ?").get(id) as Event;
  expect(() => {
    applyEvent(db, event, {
      onBeforeCursorAdvance: () => {
        throw new Error("simulated crash");
      },
    });
  }).toThrow("simulated crash");
  // Cursor did NOT advance; file_attributions row did NOT update.
  expect(getCursor()).toBe(0);
  expect(
    getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at,
  ).toBeNull();
  // Re-fold without the crash seam — both writes land.
  applyEvent(db, event);
  expect(getCursor()).toBe(id);
  expect(getAttribution("/repo", TEST_UUID, "src/a.ts")?.last_commit_at).toBe(
    800,
  );
});

// ---------------------------------------------------------------------------
// UsageSnapshot / UsageDeleted reducer arms — fn-615-add-agentusage-usage-collection
// ---------------------------------------------------------------------------

test("UsageSnapshot folds into the usage projection and advances the cursor", () => {
  const id = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "2026-05-26T18:30:00-04:00",
      week_percent: 8.0,
      week_resets_at: "2026-06-01T20:00:00-04:00",
    }),
  });

  expect(drainAll()).toBe(1);
  const row = db
    .query("SELECT * FROM usage WHERE id = ?")
    .get("claude-default") as {
    id: string;
    target: string;
    multiplier: number;
    session_percent: number;
    session_resets_at: string;
    week_percent: number;
    week_resets_at: string;
    last_event_id: number;
    updated_at: number;
  } | null;

  expect(row).not.toBeNull();
  expect(row?.target).toBe("claude");
  expect(row?.multiplier).toBe(5);
  expect(row?.session_percent).toBe(12.0);
  expect(row?.session_resets_at).toBe("2026-05-26T18:30:00-04:00");
  expect(row?.week_percent).toBe(8.0);
  expect(row?.week_resets_at).toBe("2026-06-01T20:00:00-04:00");
  expect(row?.last_event_id).toBe(id);
  expect(getCursor()).toBe(id);
});

test("UsageSnapshot upserts on conflict and bumps last_event_id every write", () => {
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
    }),
  });
  const secondId = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 30.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
    }),
  });
  expect(drainAll()).toBe(2);
  const row = db
    .query("SELECT session_percent, last_event_id FROM usage WHERE id = ?")
    .get("claude-default") as {
    session_percent: number;
    last_event_id: number;
  };
  expect(row.session_percent).toBe(30.0);
  expect(row.last_event_id).toBe(secondId);
});

test("UsageSnapshot folds missing session/week to NULL (safe-value invariant)", () => {
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "x",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      // session/week fields omitted → fold to NULL.
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT session_percent, session_resets_at, week_percent, week_resets_at FROM usage WHERE id = ?",
    )
    .get("x") as {
    session_percent: number | null;
    session_resets_at: string | null;
    week_percent: number | null;
    week_resets_at: string | null;
  };
  expect(row.session_percent).toBeNull();
  expect(row.session_resets_at).toBeNull();
  expect(row.week_percent).toBeNull();
  expect(row.week_resets_at).toBeNull();
});

test("UsageSnapshot folds account_state through the UPSERT; malformed/absent → NULL (fn-1007)", () => {
  // A valid account_state persists through the UPSERT...
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "signed-out",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      status: "active",
      account_state: "signed_out",
    }),
  });
  // ...a malformed account_state folds to NULL (never throws — cursor advances)...
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "garbage",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      account_state: "not_a_state",
    }),
  });
  // ...and a pre-v97 (field-absent) event folds to NULL.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "legacy",
    data: JSON.stringify({ target: "claude", multiplier: 5 }),
  });
  expect(drainAll()).toBe(3);
  const rows = db
    .query(
      "SELECT id, account_state FROM usage WHERE id IN ('signed-out','garbage','legacy')",
    )
    .all() as { id: string; account_state: string | null }[];
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.account_state]));
  expect(byId["signed-out"]).toBe("signed_out");
  expect(byId.garbage).toBeNull();
  expect(byId.legacy).toBeNull();
});

test("UsageSnapshot with empty pk (session_id) is a safe no-op", () => {
  const id = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "",
    data: JSON.stringify({ target: "x" }),
  });
  expect(drainAll()).toBe(1);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM usage").get() as { n: number }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(id);
});

test("UsageSnapshot with malformed data blob is a safe no-op (cursor still advances)", () => {
  const id = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: "{ not json",
  });
  expect(drainAll()).toBe(1);
  const count = (
    db.query("SELECT COUNT(*) AS n FROM usage").get() as { n: number }
  ).n;
  expect(count).toBe(0);
  expect(getCursor()).toBe(id);
});

test("UsageDeleted DELETEs the usage row and advances the cursor", () => {
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "T",
      week_percent: 8.0,
      week_resets_at: "T",
    }),
  });
  const dropId = insertEvent({
    hook_event: "UsageDeleted",
    session_id: "claude-default",
    data: "",
  });
  expect(drainAll()).toBe(2);
  const row = db
    .query("SELECT * FROM usage WHERE id = ?")
    .get("claude-default");
  expect(row).toBeNull();
  expect(getCursor()).toBe(dropId);
});

test("UsageDeleted on an unknown id is a safe no-op (cursor still advances)", () => {
  const id = insertEvent({
    hook_event: "UsageDeleted",
    session_id: "ghost",
    data: "",
  });
  expect(drainAll()).toBe(1);
  expect(getCursor()).toBe(id);
});

test("from-scratch re-fold reproduces the usage projection byte-identically", () => {
  // Seed a sequence: snapshot, snapshot (upsert), delete, snapshot of another id.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 30.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "UsageDeleted",
    session_id: "claude-default",
    data: "",
  });
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "codex",
    data: JSON.stringify({
      target: "codex",
      multiplier: 1,
      session_percent: 1.0,
      session_resets_at: "T3",
      week_percent: 71.0,
      week_resets_at: "T4",
    }),
  });
  drainAll();
  const before = db.query("SELECT * FROM usage ORDER BY id").all();
  // Rewind + wipe + re-drain. Re-fold determinism: the post-rewind rows
  // must equal byte-for-byte the pre-rewind rows.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM usage");
  drainAll();
  const after = db.query("SELECT * FROM usage ORDER BY id").all();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// Schema v35 (fn-642) — bidirectional rate-limit fan-out between `usage` and
// `profiles`. `usage.id` joins against `profiles.profile_name` (the derived
// `projectBasename(config_dir)`); the `''` sentinel never participates.
// ---------------------------------------------------------------------------

test("forward fan-out: RateLimited stamps the matching usage row's last_rate_limit_* and bumps last_event_id (fn-642)", () => {
  // Profile dir `/Users/x/.claude-profiles/multi-claude-3` → basename
  // `multi-claude-3` → matching usage row id `multi-claude-3`.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "multi-claude-3",
    data: JSON.stringify({
      target: "claude",
      multiplier: 20,
      session_percent: 5.0,
      session_resets_at: "T1",
      week_percent: 10.0,
      week_resets_at: "T2",
    }),
  });
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
  const usageRow = db
    .query(
      "SELECT last_rate_limit_at, last_rate_limit_session_id, last_event_id FROM usage WHERE id = 'multi-claude-3'",
    )
    .get() as {
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
    last_event_id: number;
  };
  expect(usageRow.last_rate_limit_at).not.toBeNull();
  expect(usageRow.last_rate_limit_session_id).toBe("sess-rl");
  // last_event_id bumped to the rate-limit event id so the wire diff fires.
  expect(usageRow.last_event_id).toBe(rlId);
});

test("SessionStart stamps jobs.profile_name from config_dir; a NULL-config resume preserves it (v36)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-pn",
    config_dir: "/Users/x/.claude-profiles/multi-claude-3",
  });
  drainAll();
  const seeded = db
    .query("SELECT profile_name, config_dir FROM jobs WHERE job_id = 'sess-pn'")
    .get() as { profile_name: string | null; config_dir: string | null };
  // Derived basename of config_dir — same helper the profiles seed uses.
  expect(seeded.profile_name).toBe("multi-claude-3");

  // A resume (duplicate SessionStart) carrying NO config_dir must not clobber
  // the seeded name: config_dir COALESCE keeps the dir, and the mirrored
  // profile_name COALESCE keeps the name (excluded.profile_name is NULL).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-pn",
    config_dir: null,
  });
  drainAll();
  const resumed = db
    .query("SELECT profile_name, config_dir FROM jobs WHERE job_id = 'sess-pn'")
    .get() as { profile_name: string | null; config_dir: string | null };
  expect(resumed.profile_name).toBe("multi-claude-3");
  expect(resumed.config_dir).toBe("/Users/x/.claude-profiles/multi-claude-3");
});

test("SessionStart with NULL config_dir leaves jobs.profile_name NULL (default profile, v36)", () => {
  // Tracks config_dir's own nullability — a NULL config_dir (default
  // ~/.claude, no CLAUDE_CONFIG_DIR) derives a NULL profile_name, NOT the
  // ''-collapse the profiles seed applies. The renderer maps NULL → (default).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default-pn",
    config_dir: null,
  });
  drainAll();
  const row = db
    .query("SELECT profile_name FROM jobs WHERE job_id = 'sess-default-pn'")
    .get() as { profile_name: string | null };
  expect(row.profile_name).toBeNull();
});

test("from-scratch re-fold reproduces jobs.profile_name byte-identically (v36)", () => {
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-rf-a",
    config_dir: "/Users/x/.claude-profiles/multi-claude-3",
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-rf-b",
    config_dir: null,
  });
  // A NULL-config resume on A — exercises the COALESCE-preserve path on re-fold.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-rf-a",
    config_dir: null,
  });
  drainAll();
  const before = db
    .query("SELECT job_id, profile_name, config_dir FROM jobs ORDER BY job_id")
    .all();
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db
    .query("SELECT job_id, profile_name, config_dir FROM jobs ORDER BY job_id")
    .all();
  expect(after).toEqual(before);
});

test("forward fan-out: a rate_limit on an untracked profile is a no-op — no phantom usage row minted (fn-642)", () => {
  // SessionStart on profile-A but agentusage never observed profile-A in
  // ~/.local/state/agentusage — there's no `usage` row to fan into. The
  // forward UPDATE must match zero rows and we must NOT mint a phantom.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-untracked",
    config_dir: "/Users/x/.claude-profiles/untracked-profile",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-untracked",
  });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-untracked" });
  drainAll();
  // The profiles row was seeded + rate-limit stamped (existing fn-639
  // behavior); but `usage` was never touched.
  const usageCount = (
    db.query("SELECT COUNT(*) AS n FROM usage").get() as { n: number }
  ).n;
  expect(usageCount).toBe(0);
});

test("reverse fan-out: UsageSnapshot pulls the current rate-limit from the matching profiles row (fn-642)", () => {
  // Rate limit lands FIRST (with no usage row yet), then the UsageSnapshot
  // arrives. The reverse fan-out's post-UPSERT SELECT must pull the
  // profile's rate-limit annotation onto the new usage row.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-A",
    config_dir: "/Users/x/.claude-profiles/multi-claude-1",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-A" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-A" });
  // Now the UsageSnapshot arrives.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "multi-claude-1",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      session_percent: 20.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT last_rate_limit_at, last_rate_limit_session_id FROM usage WHERE id = 'multi-claude-1'",
    )
    .get() as {
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
  };
  expect(row.last_rate_limit_at).not.toBeNull();
  expect(row.last_rate_limit_session_id).toBe("sess-A");
});

test("reverse fan-out is NULL-safe: a UsageSnapshot with no matching profiles row leaves rate-limit columns NULL (fn-642)", () => {
  // No SessionStart for the profile this usage corresponds to. The
  // UsageSnapshot UPSERTs the row; the reverse fan-out's SELECT returns
  // null; both columns stay NULL.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "lone-profile",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 1.0,
      session_resets_at: "T1",
      week_percent: 1.0,
      week_resets_at: "T2",
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT last_rate_limit_at, last_rate_limit_session_id FROM usage WHERE id = 'lone-profile'",
    )
    .get() as {
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
  };
  expect(row.last_rate_limit_at).toBeNull();
  expect(row.last_rate_limit_session_id).toBeNull();
});

test("ON CONFLICT carve-out: a re-UsageSnapshot does NOT clobber a prior rate-limit fan-out (fn-642)", () => {
  // A rate-limit lands BEFORE the second UsageSnapshot. The UPSERT must
  // NOT include last_rate_limit_* in its ON CONFLICT DO UPDATE SET clause —
  // otherwise the snapshot's NULL bindings would clobber the stamped value.
  // The reverse fan-out's post-UPSERT SELECT re-reads the profile row and
  // re-applies it (which keeps the value), so net effect is preservation.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "multi-claude-2",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      session_percent: 5.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-B",
    config_dir: "/Users/x/.claude-profiles/multi-claude-2",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-B" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-B" });
  // The usage row now carries the rate-limit. A second UsageSnapshot lands —
  // the carve-out must preserve last_rate_limit_*.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "multi-claude-2",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      session_percent: 30.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT session_percent, last_rate_limit_session_id FROM usage WHERE id = 'multi-claude-2'",
    )
    .get() as {
    session_percent: number;
    last_rate_limit_session_id: string | null;
  };
  // Quota numbers DO update on a re-snapshot.
  expect(row.session_percent).toBe(30.0);
  // Rate-limit annotation is preserved through the snapshot churn.
  expect(row.last_rate_limit_session_id).toBe("sess-B");
});

test("literal usage.id='' stays non-joinable — directional mapping is one-way (fn-662)", () => {
  // The v42 (fn-662) `''↔'default'` mapping is DIRECTIONAL — the helper
  // translates `''` → `'default'` (forward, profile→usage) and
  // `'default'` → `''` (reverse, usage→profile), but NEVER `''` → `''`. So a
  // pathological literal `usage.id=''` cannot join the `''` profile row.
  //
  // In steady state this is moot — `projectUsageRow`'s early empty-string
  // guard rejects any event whose session_id is empty, so no usage row
  // with id='' ever exists. This test asserts the early-guard's no-mint
  // behavior is preserved (the concrete invariant from the pre-v42 test
  // it replaces) AND that the `''` profile row's rate-limit annotation
  // colocates onto `usage.default` via the forward fan-out's mapping.
  // Seed `usage.default` first so the forward UPDATE has a row to land on.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 2.0,
      session_resets_at: "T1",
      week_percent: 2.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default",
    config_dir: null,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-default" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-default" });
  // A pathological UsageSnapshot with session_id='' — agentusage cannot mint
  // this in practice (`<id>.json` with empty basename is impossible on
  // disk), but the early guard must reject it regardless.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 1.0,
      session_resets_at: "T1",
      week_percent: 1.0,
      week_resets_at: "T2",
    }),
  });
  drainAll();
  // Sanity: no `usage.id=''` row was minted (empty session_id rejected by
  // projectUsageRow's early guard).
  const emptyIdRow = db.query("SELECT id FROM usage WHERE id = ''").get() as {
    id: string;
  } | null;
  expect(emptyIdRow).toBeNull();
  // The `''` profile row was stamped with the rate-limit (existing v33
  // behavior). The v42 forward mapping additionally colocates it onto
  // `usage.default`.
  const profileRow = db
    .query(
      "SELECT profile_name, last_rate_limit_session_id FROM profiles WHERE config_dir = ''",
    )
    .get() as {
    profile_name: string;
    last_rate_limit_session_id: string | null;
  };
  expect(profileRow.profile_name).toBe("");
  expect(profileRow.last_rate_limit_session_id).toBe("sess-default");
  // The seeded `usage.default` row carries the colocated annotation —
  // v42's whole point.
  const defaultRow = db
    .query(
      "SELECT last_rate_limit_at, last_rate_limit_session_id FROM usage WHERE id = 'default'",
    )
    .get() as {
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
  };
  expect(defaultRow.last_rate_limit_at).not.toBeNull();
  expect(defaultRow.last_rate_limit_session_id).toBe("sess-default");
});

test("forward fan-out: NULL-config RateLimited colocates onto usage.default via '' → 'default' mapping (fn-662)", () => {
  // The early-proof-point test for v42 (fn-662). A default-`~/.claude`
  // session (NULL config_dir → `''` sentinel) hits a rate limit; the
  // v42 forward mapping translates `''` → `"default"` so the existing
  // `usage.default` row picks up `last_rate_limit_at`.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 15.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default-fwd",
    config_dir: null,
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-default-fwd",
  });
  const rlId = insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-default-fwd",
  });
  drainAll();
  const row = db
    .query(
      "SELECT last_rate_limit_at, last_rate_limit_session_id, last_event_id FROM usage WHERE id = 'default'",
    )
    .get() as {
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
    last_event_id: number;
  };
  expect(row.last_rate_limit_at).not.toBeNull();
  expect(row.last_rate_limit_session_id).toBe("sess-default-fwd");
  // last_event_id bumped to the rate-limit event id (descriptor diff fires).
  expect(row.last_event_id).toBe(rlId);
});

test("reverse fan-out: 'default' UsageSnapshot pulls the '' profiles annotation via 'default' → '' mapping (fn-662)", () => {
  // The mirror direction. A NULL-config rate limit stamps the `''` profile
  // row's annotation FIRST (no usage.default row yet); then a `default`
  // UsageSnapshot lands and the reverse fan-out's post-UPSERT SELECT
  // translates `'default'` → `''` to pull the annotation onto `usage.default`.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default-rev",
    config_dir: null,
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-default-rev",
  });
  insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-default-rev",
  });
  // Now the UsageSnapshot for the default account lands.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      session_percent: 25.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT last_rate_limit_at, last_rate_limit_session_id FROM usage WHERE id = 'default'",
    )
    .get() as {
    last_rate_limit_at: number | null;
    last_rate_limit_session_id: string | null;
  };
  expect(row.last_rate_limit_at).not.toBeNull();
  expect(row.last_rate_limit_session_id).toBe("sess-default-rev");
});

test("from-scratch re-fold reproduces v42 default-mapped usage + profiles byte-identically (fn-662)", () => {
  // Re-fold determinism across the v42 mapping. Mix default-profile and
  // named-profile events in both forward and reverse orderings, then
  // rewind + wipe + re-drain and assert byte-identical projections.
  // (a) forward: usage.default exists, NULL-config SessionStart, RateLimited.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 7.0,
      session_resets_at: "T1",
      week_percent: 3.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default-fwd-rf",
    config_dir: null,
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-default-fwd-rf",
  });
  insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-default-fwd-rf",
  });
  // (b) reverse: default RateLimited lands BEFORE a default UsageSnapshot.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default-rev-rf",
    config_dir: null,
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-default-rev-rf",
  });
  insertEvent({
    hook_event: "RateLimited",
    session_id: "sess-default-rev-rf",
  });
  // (c) named profile mixed in — assert the mapping is one-way and named
  // profiles still route to their own usage row, not to default.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "multi-claude-3",
    data: JSON.stringify({
      target: "claude",
      multiplier: 20,
      session_percent: 12.0,
      session_resets_at: "T1",
      week_percent: 4.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-named",
    config_dir: "/Users/x/.claude-profiles/multi-claude-3",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-named" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-named" });
  drainAll();
  const beforeUsage = db.query("SELECT * FROM usage ORDER BY id ASC").all();
  const beforeProfiles = db
    .query("SELECT * FROM profiles ORDER BY config_dir ASC")
    .all();
  // Sanity: default-account annotation actually landed on usage.default,
  // not on usage with id='' (a pre-v42 regression check).
  const defaultRow = db
    .query("SELECT last_rate_limit_session_id FROM usage WHERE id = 'default'")
    .get() as { last_rate_limit_session_id: string | null };
  expect(defaultRow.last_rate_limit_session_id).not.toBeNull();
  // Rewind + wipe + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM usage");
  db.run("DELETE FROM profiles");
  drainAll();
  const afterUsage = db.query("SELECT * FROM usage ORDER BY id ASC").all();
  const afterProfiles = db
    .query("SELECT * FROM profiles ORDER BY config_dir ASC")
    .all();
  expect(afterUsage).toEqual(beforeUsage);
  expect(afterProfiles).toEqual(beforeProfiles);
});

test("from-scratch re-fold reproduces usage + profiles projections byte-identically (fn-642)", () => {
  // Cover both fan-out directions and event ordering:
  // (a) UsageSnapshot BEFORE SessionStart BEFORE RateLimited (forward path);
  // (b) RateLimited BEFORE UsageSnapshot (reverse path);
  // (c) untracked rate-limit (no usage row) mints nothing on usage;
  // (d) '' sentinel never cross-contaminates.
  // (a) forward: usage row exists, then SessionStart, then rate-limit fans in.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "multi-claude-3",
    data: JSON.stringify({
      target: "claude",
      multiplier: 20,
      session_percent: 15.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
    }),
  });
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-fwd",
    config_dir: "/Users/x/.claude-profiles/multi-claude-3",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-fwd" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-fwd" });
  // (b) reverse: rate-limit first under a profile whose usage row has not
  // yet been snapshotted; then the UsageSnapshot lands and pulls it in.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-rev",
    config_dir: "/Users/x/.claude-profiles/multi-claude-1",
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-rev" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-rev" });
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "multi-claude-1",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      session_percent: 25.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
    }),
  });
  // (c) untracked: rate-limit on a profile agentusage doesn't track.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-untracked",
    config_dir: "/Users/x/.claude-profiles/untracked",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-untracked",
  });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-untracked" });
  // (d) '' sentinel rate-limit (default ~/.claude).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-default",
    config_dir: null,
  });
  insertEvent({ hook_event: "UserPromptSubmit", session_id: "sess-default" });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-default" });
  drainAll();
  const beforeUsage = db.query("SELECT * FROM usage ORDER BY id ASC").all();
  const beforeProfiles = db
    .query("SELECT * FROM profiles ORDER BY config_dir ASC")
    .all();
  // Rewind + wipe + re-drain.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM usage");
  db.run("DELETE FROM profiles");
  drainAll();
  const afterUsage = db.query("SELECT * FROM usage ORDER BY id ASC").all();
  const afterProfiles = db
    .query("SELECT * FROM profiles ORDER BY config_dir ASC")
    .all();
  expect(afterUsage).toEqual(beforeUsage);
  expect(afterProfiles).toEqual(beforeProfiles);
});

// ---------------------------------------------------------------------------
// Schema v41 (fn-651) — UsageSnapshot ingests `lift_at` + stamps
// `last_usage_fold_at` only on a successful usage fold; rate-limit fan-out
// MUST NOT touch either column (carve-out symmetric to v35).
// ---------------------------------------------------------------------------

test("UsageSnapshot ingests top-level lift_at into usage.rate_limit_lifts_at (fn-651)", () => {
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-mc1",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 100.0,
      session_resets_at: "2026-05-30T20:30:00-04:00",
      week_percent: 50.0,
      week_resets_at: "2026-06-01T20:00:00-04:00",
      status: "active",
      // agentusage's derived unblock instant — soonest resets_at among >=100%
      // windows. Folds into usage.rate_limit_lifts_at on the percentage path.
      lift_at: "2026-05-30T20:30:00-04:00",
    }),
  });
  drainAll();
  const row = db
    .query(
      "SELECT rate_limit_lifts_at, last_usage_fold_at FROM usage WHERE id = ?",
    )
    .get("claude-mc1") as {
    rate_limit_lifts_at: string | null;
    last_usage_fold_at: number | null;
  };
  expect(row.rate_limit_lifts_at).toBe("2026-05-30T20:30:00-04:00");
  // Status active → successful fold → freshness stamped (non-null).
  expect(row.last_usage_fold_at).not.toBeNull();
});

test("UsageSnapshot stamps last_usage_fold_at from the event ts on a successful fold (fn-651)", () => {
  const id = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
      status: "active",
    }),
  });
  drainAll();
  // The event was inserted via the test helper at the synthetic ts — read it
  // back and assert the stamp equals it (the determinism boundary: never
  // Date.now()).
  const eventTs = (
    db.query("SELECT ts FROM events WHERE id = ?").get(id) as {
      ts: number;
    }
  ).ts;
  const row = db
    .query("SELECT last_usage_fold_at FROM usage WHERE id = ?")
    .get("claude-default") as { last_usage_fold_at: number | null };
  expect(row.last_usage_fold_at).toBe(eventTs);
});

test("UsageSnapshot does NOT bump last_usage_fold_at on an idle/stale fold (fn-651)", () => {
  // First write — a SUCCESSFUL fold stamps the freshness column. Read it
  // back so we can assert it survives a subsequent idle/stale write.
  const firstId = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 12.0,
      session_resets_at: "T1",
      week_percent: 8.0,
      week_resets_at: "T2",
      status: "active",
    }),
  });
  drainAll();
  const firstTs = (
    db.query("SELECT ts FROM events WHERE id = ?").get(firstId) as {
      ts: number;
    }
  ).ts;

  // Second write — STALE envelope with NO usage percents. The
  // `isSuccessfulFold` gate evaluates false (status != "active", all
  // percents null) → excluded.last_usage_fold_at is NULL → the UPSERT's
  // COALESCE preserves the prior successful stamp.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-default",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      // All percents null — a stale snapshot's typical shape.
      status: "stale",
    }),
  });
  drainAll();
  const row = db
    .query("SELECT status, last_usage_fold_at FROM usage WHERE id = ?")
    .get("claude-default") as {
    status: string | null;
    last_usage_fold_at: number | null;
  };
  // Status updated to stale on the re-snapshot.
  expect(row.status).toBe("stale");
  // But the freshness stamp survived (carve-out preserves it via COALESCE).
  expect(row.last_usage_fold_at).toBe(firstTs);
});

test("UsageSnapshot stamps last_usage_fold_at when any per-window percent is non-null (fn-651)", () => {
  // The "successful fold" gate is `status === "active" OR any percent
  // non-null`. A row with only `session_percent` (no status field at all)
  // still qualifies — agentusage's `active` status is a sufficient signal but
  // not a necessary one.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "codex-default",
    data: JSON.stringify({
      target: "codex",
      multiplier: 1,
      session_percent: 5.0,
      session_resets_at: "T1",
      // status field omitted; week_percent omitted.
    }),
  });
  drainAll();
  const row = db
    .query("SELECT last_usage_fold_at FROM usage WHERE id = ?")
    .get("codex-default") as { last_usage_fold_at: number | null };
  expect(row.last_usage_fold_at).not.toBeNull();
});

test("RateLimited fan-out does NOT clobber rate_limit_lifts_at or last_usage_fold_at (v41 carve-out)", () => {
  // The schema-v41 carve-out is symmetric to v35: the rate-limit fan-out's
  // forward UPDATE writes ONLY `last_rate_limit_*` + descriptor bookkeeping
  // and MUST NOT touch the two v41 columns. A percentage-path fold sets
  // both; a subsequent RateLimited fold against the same profile must
  // preserve them.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "multi-claude-1",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      session_percent: 100.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
      status: "active",
      lift_at: "2026-05-30T20:30:00-04:00",
    }),
  });
  drainAll();
  const before = db
    .query(
      "SELECT rate_limit_lifts_at, last_usage_fold_at FROM usage WHERE id = ?",
    )
    .get("multi-claude-1") as {
    rate_limit_lifts_at: string | null;
    last_usage_fold_at: number | null;
  };
  expect(before.rate_limit_lifts_at).toBe("2026-05-30T20:30:00-04:00");
  expect(before.last_usage_fold_at).not.toBeNull();

  // Now fire a RateLimited fold against the same profile. The forward
  // UPDATE writes only the rate-limit columns; the carve-out keeps the
  // lift instant + freshness stamp intact.
  insertEvent({
    hook_event: "SessionStart",
    session_id: "sess-rl-carveout",
    config_dir: "/Users/x/.claude-profiles/multi-claude-1",
  });
  insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: "sess-rl-carveout",
  });
  insertEvent({ hook_event: "RateLimited", session_id: "sess-rl-carveout" });
  drainAll();
  const after = db
    .query(
      "SELECT rate_limit_lifts_at, last_usage_fold_at, last_rate_limit_session_id FROM usage WHERE id = ?",
    )
    .get("multi-claude-1") as {
    rate_limit_lifts_at: string | null;
    last_usage_fold_at: number | null;
    last_rate_limit_session_id: string | null;
  };
  // Rate-limit fan-out DID stamp the rate-limit column (sanity check that
  // the fan-out fired at all).
  expect(after.last_rate_limit_session_id).toBe("sess-rl-carveout");
  // Lift instant + freshness stamp preserved through the rate-limit fold.
  expect(after.rate_limit_lifts_at).toBe(before.rate_limit_lifts_at);
  expect(after.last_usage_fold_at).toBe(before.last_usage_fold_at);
});

test("UsageSnapshot re-snapshot does NOT clobber a prior successful last_usage_fold_at via NULL excluded (fn-651)", () => {
  // ON CONFLICT carve-out check: even when a re-UsageSnapshot's gate
  // evaluates false (idle/stale), COALESCE(excluded.last_usage_fold_at,
  // usage.last_usage_fold_at) preserves the prior stamp. Companion to the
  // "idle/stale does not bump" test above — this one specifically asserts
  // the UPSERT's COALESCE preservation path.
  const firstId = insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-coalesce",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
      session_percent: 10.0,
      session_resets_at: "T1",
      week_percent: 10.0,
      week_resets_at: "T2",
      status: "active",
    }),
  });
  drainAll();
  const firstTs = (
    db.query("SELECT ts FROM events WHERE id = ?").get(firstId) as {
      ts: number;
    }
  ).ts;
  // Idle envelope — empty usage block, no status field, no percents.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "claude-coalesce",
    data: JSON.stringify({
      target: "claude",
      multiplier: 5,
    }),
  });
  drainAll();
  const row = db
    .query("SELECT last_usage_fold_at FROM usage WHERE id = ?")
    .get("claude-coalesce") as { last_usage_fold_at: number | null };
  expect(row.last_usage_fold_at).toBe(firstTs);
});

test("from-scratch re-fold reproduces usage.rate_limit_lifts_at + last_usage_fold_at byte-identically (fn-651)", () => {
  // Cover all three branches of the freshness gate + the lift_at field:
  // (a) successful fold with lift_at — both columns stamped;
  // (b) successful fold without lift_at — only freshness stamped;
  // (c) idle/stale fold against an existing row — preservation via COALESCE.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "rf-a",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      session_percent: 100.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
      status: "active",
      lift_at: "2026-05-30T20:30:00-04:00",
    }),
  });
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "rf-b",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      session_percent: 5.0,
      session_resets_at: "T1",
      week_percent: 5.0,
      week_resets_at: "T2",
      status: "active",
    }),
  });
  // Idle re-snapshot on rf-b — must preserve the freshness stamp on re-fold.
  insertEvent({
    hook_event: "UsageSnapshot",
    session_id: "rf-b",
    data: JSON.stringify({
      target: "claude",
      multiplier: 1,
      status: "stale",
    }),
  });
  drainAll();
  const before = db.query("SELECT * FROM usage ORDER BY id ASC").all();
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM usage");
  drainAll();
  const after = db.query("SELECT * FROM usage ORDER BY id ASC").all();
  expect(after).toEqual(before);
});

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

test("Stop is a no-op on state while a sub-agent is running (parent yielded to Task)", () => {
  // When the parent agent dispatches a Task tool, Claude Code emits Stop and
  // yields control to the sub-agent — but conceptually the session is still
  // working until the sub returns AND any post-sub follow-up Stops. Honoring
  // the mid-yield Stop would clear readiness predicate 5 prematurely and let
  // predicate 7 dup-fire (see autopilot's approval-pending notify).
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-1",
    agent_type: "Explore",
  });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  // State stays 'working' — Stop landed during the sub-agent's run.
  expect(getJob()?.state).toBe("working");
});

test("Stop after SubagentStop flips state to stopped (final post-sub Stop)", () => {
  // The honest read of the user's mental model: Stop is a real lifecycle
  // signal only when no sub-agent is still in flight. The exact bug repro
  // sequence: parent yields to sub via Stop, sub finishes, parent resumes
  // via UserPromptSubmit, parent finishes with a real Stop — and ONLY this
  // final Stop drops state to 'stopped'.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-2",
    agent_type: "plan:worker-high",
  });
  // Mid-yield Stop while sub-2 is running — should be a state no-op.
  insertEvent({ hook_event: "Stop" });
  // Sub finishes.
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-2" });
  // Parent resumes (Claude Code feeds sub results back via UserPromptSubmit).
  insertEvent({ hook_event: "UserPromptSubmit" });
  // Parent's real final Stop — no sub running now, this one applies.
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("Stop guard ignores `running` orphan when a later same-name row exists (fn-593.3 shape)", () => {
  // Wedged-projection repro. The existing supersession path (`findOpenRunning
  // InGroup` at PostToolUse:Agent) can miss an orphan in real traces — e.g.
  // when the later same-name spawn reuses agent_id, or the failure-path
  // didn't run supersession. The Stop guard MUST still let the parent
  // close: same-name collapse on (job_id, subagent_type) — any `running`
  // row with a higher-turn_seq sibling under the same name is ignored
  // for the guard. Mirrors the client-side `collapseSubagentsByName` rule.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  // Hand-write the wedged subagent_invocations shape: turn_seq=1 stuck at
  // `running`, turn_seq=2 finished `ok` — both share the same
  // subagent_type. Bypasses the SubagentStart/PostToolUse:Agent path so we
  // can pin the exact state the wedged production trace landed in. The
  // earlier `ok:turn_seq=0` from fn-593.3's trace is irrelevant to the
  // guard (status='ok' never blocks anything); omitted for brevity.
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-orphan",
      1,
      1_000,
      null,
      "plan:worker-high",
      null,
      0,
      "running",
      null,
      0,
      1_000,
    ],
  );
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-newer",
      2,
      2_000,
      null,
      "plan:worker-high",
      null,
      0,
      "ok",
      // fn-1008: the surviving turn_seq=2 row is FINISHED (non-NULL
      // duration_ms), not an open `ok`. Under the canonical open-turn predicate
      // (`duration_ms IS NULL AND status IN running|ok`) a NULL here would make
      // this survivor a fresh in-flight anchor and block the Stop — so the
      // wedged-trace intent (orphan turn_seq=1 collapsed away, parent closes) is
      // preserved by marking the survivor closed.
      5_000,
      0,
      2_000,
    ],
  );
  insertEvent({ hook_event: "Stop" });
  drainAll();
  // Before the collapse-aware guard this stayed 'working' forever; now the
  // orphan is filtered out and Stop's UPDATE writes 'stopped'.
  expect(getJob()?.state).toBe("stopped");
});

test("Stop guard still blocks when the only `running` row is NOT collapse-eligible", () => {
  // Counter-test: an orphan `running` with NO later same-name sibling
  // still blocks Stop — the collapse rule only fires when a higher
  // turn_seq exists for the same (job_id, subagent_type). This is the
  // normal mid-yield case (single in-flight sub-agent of its type),
  // preserved as a guard-rail against an overzealous filter.
  //
  // fn-638.1: ts values pinned explicitly so the surviving running row
  // sits well within `MAX_STOP_YIELD_GAP_SEC` of the Stop event's ts —
  // this test pins the "mid-yield with a single in-flight sub" branch,
  // not the bounded-recency release (covered separately below).
  insertEvent({ hook_event: "SessionStart", ts: 50_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 50_001 });
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "solo-agent",
      0,
      50_002,
      null,
      "plan:worker-high",
      null,
      0,
      "running",
      null,
      0,
      50_002,
    ],
  );
  insertEvent({ hook_event: "Stop", ts: 50_003 });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("Stop guard handles multiple concurrent sub-agents (releases only when ALL done)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-a",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-b",
    agent_type: "Explore",
  });
  // Stop while BOTH subs are running — no-op.
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-a" });
  // Stop while sub-b is still running — still a no-op.
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("working");
  // Sub-b finishes, then parent emits its real Stop.
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-b" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("ApiError during a sub-agent run stamps annotation without flipping state", () => {
  // Mirror of the Stop guard for the synthetic api-error fold: the (last_
  // api_error_at, last_api_error_kind) pair must stamp honestly even while
  // a sub-agent runs, but the state flip is suppressed so the session keeps
  // reading as 'working' for readiness predicate 5.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-api",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "ApiError",
    data: JSON.stringify({ kind: "rate_limit" }),
  });
  drainAll();
  const job = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-a") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(job.state).toBe("working");
  expect(job.last_api_error_at).not.toBeNull();
  expect(job.last_api_error_kind).toBe("rate_limit");
});

test("from-scratch re-fold of a sub-agent yield sequence is byte-deterministic", () => {
  // The sub-agent-aware Stop guard reads subagent_invocations, but every
  // SubagentStart/Stop was folded with a strictly-lower event id, so the
  // running-check is a pure function of the event log up to the Stop. Re-
  // fold from scratch must reproduce the same final state.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-rf",
    agent_type: "Explore",
  });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-rf" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  const firstJob = getJob();
  expect(firstJob?.state).toBe("stopped");

  // Rewind cursor + wipe projections, then re-drain the same event log.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const reJob = getJob();
  expect(reJob?.state).toBe("stopped");
  expect(reJob?.last_event_id).toBe(firstJob?.last_event_id);
});

// ---------------------------------------------------------------------------
// fn-638.1: bounded-recency release of a stuck sub-agent Stop guard.
//
// Closes problem-3: an orphan SubagentStart that never emits SubagentStop
// would pin its parent at `state='working'` until the window closed, because
// the sub-agent guard's `subRunning` query swallowed every Stop indefinitely.
// The bound: when the newest surviving running sub-agent's `ts` is older than
// `MAX_STOP_YIELD_GAP_SEC` (120s) relative to the Stop event's `ts`, the
// guard releases — Stop writes `state='stopped'` and fan-out runs normally.
// All timestamps are unix-SECONDS (same unit as events / subagent_invocations).
// ---------------------------------------------------------------------------

test("bounded Stop guard: stale orphan sub-agent (age > bound) releases to stopped", () => {
  // A SubagentStart that never got its SubagentStop, much older than the
  // Stop event's ts. Before fn-638.1 this stayed 'working' forever; now the
  // bound trips and the Stop writes 'stopped'.
  insertEvent({ hook_event: "SessionStart", ts: 10_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 10_001 });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-orphan",
    agent_type: "Explore",
    ts: 10_002,
  });
  // Stop lands well past the 120s bound — the orphan is treated as a
  // dropped SubagentStop and the gate releases.
  insertEvent({ hook_event: "Stop", ts: 10_500 });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("bounded Stop guard: fresh sub-agent (age <= bound) still swallows Stop", () => {
  // A legitimately in-flight sub-agent — the parent yielded recently, the
  // sub is still working. The Stop within the bound MUST still be a no-op
  // on state, otherwise readiness predicate 5 clears prematurely and
  // predicate 7 dup-fires `job-pending`.
  insertEvent({ hook_event: "SessionStart", ts: 10_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 10_001 });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-live",
    agent_type: "Explore",
    ts: 10_002,
  });
  // Stop 60s after sub start — within the 120s bound, guard holds.
  insertEvent({ hook_event: "Stop", ts: 10_062 });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("bounded Stop guard: boundary exactly at MAX_STOP_YIELD_GAP_SEC keeps swallowing", () => {
  // The release branch is `age > MAX_STOP_YIELD_GAP_SEC` (strict). At the
  // boundary the guard still swallows — gives clock-skew and same-second
  // wiggle room on the "still in-flight" side. Belt-and-suspenders against
  // the "negative/zero age" risk listed in the task spec.
  insertEvent({ hook_event: "SessionStart", ts: 10_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 10_001 });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-edge",
    agent_type: "Explore",
    ts: 10_002,
  });
  // Stop exactly 120s after sub start.
  insertEvent({ hook_event: "Stop", ts: 10_122 });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("bounded Stop guard: NULL ts on a running row keeps swallowing (safe branch)", () => {
  // Legacy/malformed `subagent_invocations` row with an untrustworthy
  // last-activity timestamp — the bound cannot honestly compute an age, so the
  // guard conservatively keeps swallowing (treat as not-stuck, never throw).
  // Spec edge case. fn-1008: the guard now anchors on `updated_at` (last
  // activity), NOT spawn `ts`, so the uncomputable sentinel lives on
  // `updated_at`. bun:sqlite rejects a literal NULL on the `NOT NULL REAL`
  // column, so we simulate "we can't trust this" with a 0 sentinel — the
  // helper's `updatedAt == null || updatedAt <= 0` guard treats both the same.
  insertEvent({ hook_event: "SessionStart", ts: 10_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 10_001 });
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-zero-ts",
      0,
      1_000,
      null,
      "plan:worker-high",
      null,
      0,
      "running",
      null,
      0,
      0, // updated_at sentinel: cannot honestly age this row
    ],
  );
  // Stop arrives at a normal far-future ts — without the safe-branch
  // guard, `age = 10_500 - 0 = 10_500 > 120` would release prematurely.
  insertEvent({ hook_event: "Stop", ts: 10_500 });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("bounded Stop guard: negative age (event ts < row ts) keeps swallowing", () => {
  // Clock skew / out-of-order ts ordering — `age = event.ts - row.ts` goes
  // negative. The strict `age > bound` check naturally rejects this, but
  // we pin the behavior with an explicit test so a future refactor that
  // takes `Math.abs(age)` would fail loudly.
  insertEvent({ hook_event: "SessionStart", ts: 10_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 10_001 });
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-future-ts",
      0,
      50_000, // future ts vs. the Stop below
      null,
      "plan:worker-high",
      null,
      0,
      "running",
      null,
      0,
      50_000,
    ],
  );
  insertEvent({ hook_event: "Stop", ts: 10_500 });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("bounded Stop guard: anchors on newest surviving running row, not the demoted orphan", () => {
  // Two same-name running rows: an OLD turn_seq=0 (the would-be orphan, but
  // collapsed away by the higher-turn_seq sibling) and a FRESH turn_seq=1
  // (the surviving max). The existing same-name `turn_seq` collapse filters
  // the old row out of the candidate set; the recency check must measure
  // against the SURVIVING row's ts — so the Stop within the bound is still
  // swallowed. Anchoring on the demoted orphan would release prematurely.
  insertEvent({ hook_event: "SessionStart", ts: 10_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 10_001 });
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-old",
      0,
      9_000, // ancient — well beyond the bound on its own
      null,
      "plan:worker-high",
      null,
      0,
      "running",
      null,
      0,
      9_000,
    ],
  );
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-new",
      1,
      10_050, // fresh — within the bound vs. the Stop at 10_060
      null,
      "plan:worker-high",
      null,
      0,
      "running",
      null,
      0,
      10_050,
    ],
  );
  insertEvent({ hook_event: "Stop", ts: 10_060 });
  drainAll();
  // If the recency check measured against agent-old (ts=9_000), age=1_060
  // would release. The collapse filter must drop agent-old first and the
  // check must read agent-new's ts (10_050), so age=10 < bound → swallow.
  expect(getJob()?.state).toBe("working");
});

test("bounded Stop guard: from-scratch re-fold of a bounded release is byte-deterministic", () => {
  // The recency comparison is `event.ts - row.ts` against a compile-time
  // constant — pure function of the event log. A from-scratch re-fold
  // (rewind cursor, wipe projections, re-drain) must reproduce the same
  // final state AND the same `last_event_id` stamp. Closes the "no
  // Date.now() in the fold" acceptance bullet operationally.
  insertEvent({ hook_event: "SessionStart", ts: 10_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 10_001 });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-rf-stale",
    agent_type: "Explore",
    ts: 10_002,
  });
  insertEvent({ hook_event: "Stop", ts: 10_500 }); // far past 120s bound
  drainAll();
  const firstJob = getJob();
  expect(firstJob?.state).toBe("stopped");

  // Rewind cursor + wipe projections, then re-drain the same event log.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const reJob = getJob();
  expect(reJob?.state).toBe("stopped");
  expect(reJob?.last_event_id).toBe(firstJob?.last_event_id);
});

// ---------------------------------------------------------------------------
// fn-1008: canonical open-turn liveness — the `updated_at` activity re-base,
// the open-`ok` background-hold, the ApiError guard's new freshness + collapse,
// and the sweep widening.
// ---------------------------------------------------------------------------

test("Stop guard: sub-agent activity (SubagentTurn) refreshes updated_at and re-arms the window", () => {
  // The whole point of anchoring on `updated_at` instead of spawn `ts`: a
  // long-lived sub that keeps emitting activity re-arms its 120s window. The
  // SubagentTurn lands 98s after spawn (a `ts`-anchored guard would already be
  // 98s into its 120s budget); the Stop lands 148s after SPAWN but only 50s
  // after the last ACTIVITY, so the `updated_at`-anchored guard still swallows.
  insertEvent({ hook_event: "SessionStart", ts: 10_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 10_001 });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-act",
    agent_type: "Explore",
    ts: 10_002,
  });
  // `clean` disposition — never triggers SILENT_STREAM_CUT; it only re-stamps
  // updated_at to 10_100.
  insertEvent({
    hook_event: "SubagentTurn",
    agent_id: "sub-act",
    ts: 10_100,
    data: JSON.stringify({ disposition: "clean" }),
  });
  // 148s past spawn, 50s past last activity → within bound on `updated_at`.
  insertEvent({ hook_event: "Stop", ts: 10_150 });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("Stop guard: open-`ok` background sub holds the parent `working`, then SubagentStop releases it", () => {
  // PostToolUse:Agent flips the turn to `ok` BEFORE its SubagentStop lands — a
  // backgrounded sub still in flight (NULL `duration_ms`). The canonical
  // open-turn predicate keeps the parent `working` across a Stop; once
  // SubagentStop stamps `duration_ms`, the row is finished and the next Stop
  // closes the job.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-bg",
    agent_type: "Explore",
  });
  // Bridge fold flips turn-0 to `ok` (duration_ms stays NULL).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_bg",
    subagent_agent_id: "sub-bg",
    data: JSON.stringify({
      tool_use_id: "toolu_bg",
      tool_response: { agentId: "sub-bg" },
    }),
  });
  // Mid-yield Stop while the open-`ok` sub is in flight — swallowed.
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("working");
  const openRow = db
    .query(
      "SELECT status, duration_ms FROM subagent_invocations WHERE agent_id = 'sub-bg'",
    )
    .get() as { status: string; duration_ms: number | null };
  expect(openRow.status).toBe("ok");
  expect(openRow.duration_ms).toBeNull();
  // SubagentStop closes the open turn (duration_ms IS NULL gate finds the `ok`
  // row), then the parent's real Stop applies.
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-bg" });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("ApiError guard: a STALE (>120s) in-flight sub no longer suppresses the state flip", () => {
  // The pre-fn-1008 ApiError guard had NO freshness bound — an orphan
  // SubagentStart would suppress the flip forever. Now it routes through the
  // same `updated_at` bound as Stop: 500s past spawn with no activity → release.
  insertEvent({ hook_event: "SessionStart", ts: 30_000 });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 30_001 });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-stale",
    agent_type: "Explore",
    ts: 30_002,
  });
  insertEvent({
    hook_event: "ApiError",
    data: JSON.stringify({ kind: "rate_limit" }),
    ts: 30_502,
  });
  drainAll();
  const job = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-a") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  // Stale → the state flips to `stopped` (the guard released)...
  expect(job.state).toBe("stopped");
  // ...and the annotation pair stamps unconditionally regardless.
  expect(job.last_api_error_at).not.toBeNull();
  expect(job.last_api_error_kind).toBe("rate_limit");
});

test("ApiError guard: a collapse-masked running orphan does NOT suppress the flip", () => {
  // The pre-fn-1008 ApiError guard had NO same-name collapse either — a bare
  // EXISTS(status='running') would have found the orphan turn_seq=1 and
  // suppressed. Now the helper masks it behind the later same-name finished
  // turn_seq=2, so the flip lands while the pair still stamps.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit" });
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "orphan",
      1,
      1_000,
      null,
      "Explore",
      null,
      0,
      "running",
      null,
      0,
      1_000,
    ],
  );
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "newer",
      2,
      2_000,
      null,
      "Explore",
      null,
      0,
      "ok",
      5_000,
      0,
      2_000,
    ],
  );
  insertEvent({
    hook_event: "ApiError",
    data: JSON.stringify({ kind: "rate_limit" }),
  });
  drainAll();
  const job = db
    .query(
      "SELECT state, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = ?",
    )
    .get("sess-a") as {
    state: string;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(job.state).toBe("stopped");
  expect(job.last_api_error_at).not.toBeNull();
  expect(job.last_api_error_kind).toBe("rate_limit");
});

test("sweep: SessionEnd closes a backgrounded open-`ok` orphan to `unknown` but never clobbers a finished `ok`", () => {
  // The sweep widened from a bare `status='running'` to the full open-turn
  // predicate, so a backgrounded `ok` orphan (NULL `duration_ms`) is now closed
  // to `unknown` on a terminal job. The `duration_ms IS NULL` clause is
  // load-bearing: a FINISHED `ok` (non-null `duration_ms`) must NOT be clobbered.
  insertEvent({ hook_event: "SessionStart" });
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-open",
      0,
      1_000,
      null,
      "Explore",
      null,
      0,
      "ok",
      null,
      0,
      1_000,
    ],
  );
  db.run(
    `INSERT INTO subagent_invocations
       (job_id, agent_id, turn_seq, ts, tool_use_id, subagent_type,
        description, prompt_chars, status, duration_ms, last_event_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "sess-a",
      "agent-done",
      0,
      1_000,
      null,
      "Build",
      null,
      0,
      "ok",
      5_000,
      0,
      1_000,
    ],
  );
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  const openRow = db
    .query(
      "SELECT status, duration_ms FROM subagent_invocations WHERE agent_id = 'agent-open'",
    )
    .get() as { status: string; duration_ms: number | null };
  const doneRow = db
    .query(
      "SELECT status, duration_ms FROM subagent_invocations WHERE agent_id = 'agent-done'",
    )
    .get() as { status: string; duration_ms: number | null };
  expect(openRow.status).toBe("unknown");
  expect(openRow.duration_ms).toBeNull();
  expect(doneRow.status).toBe("ok"); // finished — never clobbered
  expect(doneRow.duration_ms).toBe(5_000);
});

test("fn-1008: from-scratch re-fold of an open-`ok` sweep is byte-deterministic", () => {
  // The new open-turn guard + sweep are pure reads over folded-state-at-fold-
  // time (event.ts, never wall-clock), so a from-scratch re-fold reproduces the
  // same final projection. Exercises the open-`ok` → swept-`unknown` path.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-rf-ok",
    agent_type: "Explore",
  });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "toolu_rf",
    subagent_agent_id: "sub-rf-ok",
    data: JSON.stringify({
      tool_use_id: "toolu_rf",
      tool_response: { agentId: "sub-rf-ok" },
    }),
  });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  const firstStatus = (
    db
      .query(
        "SELECT status FROM subagent_invocations WHERE agent_id = 'sub-rf-ok'",
      )
      .get() as { status: string }
  ).status;
  const firstJob = getJob();
  expect(firstStatus).toBe("unknown");
  expect(firstJob?.state).toBe("ended");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM subagent_invocations");
  drainAll();
  const reStatus = (
    db
      .query(
        "SELECT status FROM subagent_invocations WHERE agent_id = 'sub-rf-ok'",
      )
      .get() as { status: string }
  ).status;
  const reJob = getJob();
  expect(reStatus).toBe(firstStatus);
  expect(reJob?.state).toBe(firstJob?.state);
  expect(reJob?.last_event_id).toBe(firstJob?.last_event_id);
});

test("SessionEnd moves state to ended", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

test("no-op event types advance cursor without touching jobs", () => {
  insertEvent({ hook_event: "SessionStart" });
  // Agent-lifecycle events fold subagent_invocations, never jobs.state — a
  // genuine jobs no-op. (Pre/PostToolUse are NOT used here: they now un-stop a
  // 'stopped' row, so they would touch jobs — covered by the tool-event revival
  // tests below.)
  const startId = insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-noop",
    agent_type: "Explore",
  });
  const lastId = insertEvent({
    hook_event: "SubagentStop",
    agent_id: "sub-noop",
  });
  drainAll();
  // jobs row stays at the SessionStart projection — state untouched.
  expect(getJob()?.state).toBe("stopped");
  // cursor walked past every no-op row.
  expect(getCursor()).toBe(lastId);
  expect(getCursor()).toBeGreaterThan(startId);
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

// ---------------------------------------------------------------------------
// UserPromptSubmit task-notification carve-out
// ---------------------------------------------------------------------------

const TASK_NOTIFICATION_KILLED = [
  "<task-notification>",
  "<task-id>ba82oze4l</task-id>",
  "<output-file>/tmp/ba82oze4l.output</output-file>",
  "<status>killed</status>",
  '<summary>Monitor "chatctl bus" stopped</summary>',
  "</task-notification>",
].join("\n");

test("UserPromptSubmit with a killed task-notification leaves state stopped", () => {
  // Reproduces the closed-terminal flash: a session sitting idle (stopped)
  // receives a shutdown-housekeeping task-notification through the same
  // UserPromptSubmit hook a real prompt uses. The reducer must NOT flip
  // state to 'working' for the `<status>killed</status>` variant — the
  // session is dying, not picking up a new prompt.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ prompt: TASK_NOTIFICATION_KILLED }),
  });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
});

test("UserPromptSubmit with a killed task-notification still folds the session_title", () => {
  // Modest carve-out: only the lifecycle write is skipped. A
  // `session_title` on the task-notification still rides through the title
  // precedence rule below the switch so the row's displayed title stays
  // current.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({
      prompt: TASK_NOTIFICATION_KILLED,
      session_title: "remove-closed-epics",
    }),
  });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.title).toBe("remove-closed-epics");
  expect(job?.title_source).toBe("payload");
});

test("UserPromptSubmit with a completed task-notification still flips state to working", () => {
  // Modesty check: `<status>completed</status>` is a real signal the model
  // reacts to — the lifecycle write must still fire.
  const completed = TASK_NOTIFICATION_KILLED.replace(
    "<status>killed</status>",
    "<status>completed</status>",
  );
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "Stop" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ prompt: completed }),
  });
  drainAll();
  expect(getJob()?.state).toBe("working");
});

test("UserPromptSubmit with a killed task-notification on a terminal row stays terminal", () => {
  // The normal UserPromptSubmit re-opens an `ended` / `killed` row to
  // `working` — but the carve-out skips that branch, so a shutdown
  // notification that arrives after SessionEnd / Killed never resurrects a
  // terminal row.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "SessionEnd" });
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ prompt: TASK_NOTIFICATION_KILLED }),
  });
  drainAll();
  expect(getJob()?.state).toBe("ended");
});

// ---------------------------------------------------------------------------
// fn-1056 — bare tool-event un-stop: a PLAIN-stopped row (both annotation pairs
// NULL) folds back to 'working' on the next Pre/PostToolUse. A session that ended
// a turn to wait on background tasks reads 'stopped' via the plain Stop fold; when
// it resumes straight into tool events with no UserPromptSubmit, the two
// annotation-gated un-stops never fire. The third bare arm treats any
// current-session tool event as proof of liveness. The `state='stopped'` WHERE is
// the resurrection guard — terminal rows are untouchable by construction.
// ---------------------------------------------------------------------------

test("fn-1056: a plain-stopped row (both annotations NULL) folds back to working on the next PreToolUse", () => {
  // The red-first repro: SessionStart → UPS → Stop leaves a 'stopped' row with
  // NO annotation pair set; a following PreToolUse must un-stop it to 'working'
  // and stamp active_since to the tool-event ts (the stopped→working edge).
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");

  insertEvent({ hook_event: "PreToolUse", tool_name: "Bash", ts: 8000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.active_since).toBe(8000);
});

test("fn-1056: a plain-stopped row folds back to working on the next PostToolUse", () => {
  // Post as well as Pre — both drive the bare un-stop.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({ hook_event: "Stop" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");

  insertEvent({ hook_event: "PostToolUse", tool_name: "Bash", ts: 8000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.active_since).toBe(8000);
});

test("fn-1056: an ended row is NEVER resurrected by a tool event (terminal guard)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({ hook_event: "SessionEnd" });
  drainAll();
  expect(getJob()?.state).toBe("ended");
  const activeSinceBefore = getJob()?.active_since ?? null;

  insertEvent({ hook_event: "PreToolUse", tool_name: "Bash", ts: 8000 });
  insertEvent({ hook_event: "PostToolUse", tool_name: "Bash", ts: 8001 });
  drainAll();
  const job = getJob();
  // The `state='stopped'` WHERE can never match an 'ended' row.
  expect(job?.state).toBe("ended");
  expect(job?.active_since).toBe(activeSinceBefore);
});

test("fn-1056: a killed row is NEVER resurrected by a tool event (terminal guard)", () => {
  // SessionStart seeds pid 4242 / start_time NULL (helper default), so the
  // loose pid-only Killed match flips the row terminal.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({
    hook_event: "Killed",
    data: JSON.stringify({ pid: 4242, start_time: null }),
  });
  drainAll();
  expect(getJob()?.state).toBe("killed");
  const activeSinceBefore = getJob()?.active_since ?? null;

  insertEvent({ hook_event: "PostToolUse", tool_name: "Bash", ts: 8000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("killed");
  expect(job?.active_since).toBe(activeSinceBefore);
});

test("fn-1056: a WORKING row is untouched by a tool event (hot path cold — no active_since churn)", () => {
  // The 50+/turn tool path must not re-stamp active_since on an already-working
  // row: the `state='stopped'` WHERE no-ops, so active_since holds at the
  // original rising edge and last_event_id does NOT advance on the bare arm.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  drainAll();
  const before = getJob();
  expect(before?.state).toBe("working");
  expect(before?.active_since).toBe(5000);
  const lastEventIdBefore = before?.last_event_id;

  insertEvent({ hook_event: "PreToolUse", tool_name: "Bash", ts: 8000 });
  insertEvent({ hook_event: "PostToolUse", tool_name: "Bash", ts: 8001 });
  drainAll();
  const after = getJob();
  expect(after?.state).toBe("working");
  expect(after?.active_since).toBe(5000);
  // No annotation pair and already working → no arm fired → row untouched.
  expect(after?.last_event_id).toBe(lastEventIdBefore);
});

test("fn-1056: an annotation-carrying stopped row still revives through the EXISTING arm (ordering)", () => {
  // Composition: a stopped row with the api-error pair set un-stops + stamps
  // active_since through the api-error clear arm (which runs BEFORE the bare
  // arm); the bare arm then sees state already 'working' and no-ops. The pair
  // is cleared exactly once and active_since is stamped exactly once.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({
    hook_event: "ApiError",
    data: JSON.stringify({ kind: "server_error" }),
  });
  drainAll();
  const stopped = db
    .query("SELECT state, last_api_error_at FROM jobs WHERE job_id = 'sess-a'")
    .get() as { state: string; last_api_error_at: number | null };
  expect(stopped.state).toBe("stopped");
  expect(stopped.last_api_error_at).not.toBeNull();

  insertEvent({ hook_event: "PreToolUse", tool_name: "Bash", ts: 8000 });
  drainAll();
  const resumed = db
    .query(
      "SELECT state, active_since, last_api_error_at, last_api_error_kind FROM jobs WHERE job_id = 'sess-a'",
    )
    .get() as {
    state: string;
    active_since: number | null;
    last_api_error_at: number | null;
    last_api_error_kind: string | null;
  };
  expect(resumed.state).toBe("working");
  expect(resumed.active_since).toBe(8000);
  expect(resumed.last_api_error_at).toBeNull();
  expect(resumed.last_api_error_kind).toBeNull();
});

test("fn-1056 re-fold determinism: a stopped→tool-event→working sequence re-folds byte-identical", () => {
  // jobs is deterministic-replayed and the bare arm reads only event.ts + the
  // pre-update state, never wall-clock — a from-scratch re-fold must reproduce
  // the un-stopped row byte-for-byte.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({ hook_event: "Stop" });
  insertEvent({ hook_event: "PreToolUse", tool_name: "Bash", ts: 8000 });
  drainAll();
  const before = db.query("SELECT * FROM jobs WHERE job_id = 'sess-a'").get();
  expect((before as { state: string }).state).toBe("working");

  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  drainAll();
  const after = db.query("SELECT * FROM jobs WHERE job_id = 'sess-a'").get();
  expect(after).toEqual(before);
});

// ---------------------------------------------------------------------------
// fn-784 — `active_since`: the unified-timeline recency key, stamped on the
// rising edge into `working` and held otherwise.
// ---------------------------------------------------------------------------

test("active_since: stamped = the UserPromptSubmit ts on a first prompt (stopped → working)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.active_since).toBe(5000);
});

test("active_since: a brand-new SessionStart-only job that never prompted is NULL", () => {
  insertEvent({ hook_event: "SessionStart" });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.active_since).toBeNull();
});

test("active_since: HELD across Stop→stopped and subagent-lifecycle churn (no re-stamp)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  // Stop drops the row to 'stopped' but carries no active_since clause.
  insertEvent({ hook_event: "Stop" });
  // Sub-agent lifecycle churn mid-life: SubagentStart/Stop fold
  // subagent_invocations, never jobs.state, so the row stays 'stopped' and
  // active_since is untouched. (A Pre/PostToolUse WOULD un-stop the row and
  // re-stamp active_since to the tool-event ts — covered by the tool-event
  // revival tests below.)
  insertEvent({
    hook_event: "SubagentStart",
    agent_id: "sub-1",
    agent_type: "Explore",
  });
  insertEvent({ hook_event: "SubagentStop", agent_id: "sub-1" });
  drainAll();
  expect(getJob()?.state).toBe("stopped");
  expect(getJob()?.active_since).toBe(5000);
});

test("active_since: re-stamped on a genuine restart (stopped → UserPromptSubmit)", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({ hook_event: "Stop" });
  // A fresh prompt after the stop re-promotes: the rising edge fires again.
  insertEvent({ hook_event: "UserPromptSubmit", ts: 6000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.active_since).toBe(6000);
});

test("active_since: re-stamped on a killed → UserPromptSubmit re-open", () => {
  // SessionStart seeds pid 4242 / start_time NULL (the helper default), so the
  // Killed loose pid-only match flips the row terminal; the next live prompt
  // re-opens it from 'killed' and re-stamps the rising edge.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({
    hook_event: "Killed",
    data: JSON.stringify({ pid: 4242, start_time: null }),
  });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 7000 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.active_since).toBe(7000);
});

// ---------------------------------------------------------------------------
// Schema-v70 close_kind — the crash-restore discriminator the Killed fold copies
// verbatim from the producer-stamped payload (fn-817 task .1).
// ---------------------------------------------------------------------------

function getCloseKind(jobId = "sess-a"): string | null {
  const row = db
    .query("SELECT close_kind FROM jobs WHERE job_id = ?")
    .get(jobId) as { close_kind: string | null } | null;
  return row?.close_kind ?? null;
}

for (const kind of [
  "server_gone",
  "pid_died",
  "window_gone_server_alive",
  "unknown",
]) {
  test(`Killed fold copies close_kind="${kind}" onto the jobs row`, () => {
    insertEvent({ hook_event: "SessionStart" });
    insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
    insertEvent({
      hook_event: "Killed",
      data: JSON.stringify({ pid: 4242, start_time: null, close_kind: kind }),
    });
    drainAll();
    const job = getJob();
    expect(job?.state).toBe("killed");
    expect(getCloseKind()).toBe(kind);
  });
}

test("Killed fold leaves close_kind NULL when the payload omits it (legacy re-fold)", () => {
  // A pre-v70 Killed payload carries only (pid, start_time); close_kind folds
  // to NULL so a from-scratch re-fold reproduces the zero-event default.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({
    hook_event: "Killed",
    data: JSON.stringify({ pid: 4242, start_time: null }),
  });
  drainAll();
  expect(getJob()?.state).toBe("killed");
  expect(getCloseKind()).toBeNull();
});

test("Killed fold treats a non-string close_kind as NULL (defensive, never coerced)", () => {
  // A garbage close_kind value must not masquerade as a real kind — it folds to
  // NULL, and the row still flips to killed (the kill itself is honored).
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({
    hook_event: "Killed",
    data: JSON.stringify({ pid: 4242, start_time: null, close_kind: 42 }),
  });
  drainAll();
  expect(getJob()?.state).toBe("killed");
  expect(getCloseKind()).toBeNull();
});

test("Killed fold: a malformed payload folds to a safe no-op and still advances the cursor", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  // Non-JSON data blob → extractKilledPayload returns null → no-op, no throw.
  const killedId = insertEvent({ hook_event: "Killed", data: "not json{" });
  drainAll();
  const job = getJob();
  // The malformed Killed did not flip the row terminal.
  expect(job?.state).toBe("working");
  expect(getCloseKind()).toBeNull();
  // The cursor advanced past the malformed event (no wedge).
  expect(getCursor()).toBeGreaterThanOrEqual(killedId);
});

// ---------------------------------------------------------------------------
// Schema-v103 kill_reason — WHY keeper reaped the job (which Killed producer arm
// minted the reap), folded from the producer-stamped payload as an opaque string
// copy. Orthogonal to close_kind (HOW the session died). fn-1075 task .2.
// ---------------------------------------------------------------------------

function getKillReason(jobId = "sess-a"): string | null {
  const row = db
    .query("SELECT kill_reason FROM jobs WHERE job_id = ?")
    .get(jobId) as { kill_reason: string | null } | null;
  return row?.kill_reason ?? null;
}

for (const reason of [
  "exit_watched",
  "boot_unwatchable",
  "boot_pid_dead",
  "boot_pid_recycled",
]) {
  test(`Killed fold copies kill_reason="${reason}" onto the jobs row`, () => {
    insertEvent({ hook_event: "SessionStart" });
    insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
    insertEvent({
      hook_event: "Killed",
      data: JSON.stringify({
        pid: 4242,
        start_time: null,
        close_kind: "pid_died",
        reason,
      }),
    });
    drainAll();
    const job = getJob();
    expect(job?.state).toBe("killed");
    expect(getKillReason()).toBe(reason);
    // Orthogonal to close_kind — both fold independently.
    expect(getCloseKind()).toBe("pid_died");
  });
}

test("Killed fold leaves kill_reason NULL when the payload omits it (legacy re-fold)", () => {
  // A pre-v103 Killed payload carries no `reason`; kill_reason folds to NULL so
  // a from-scratch re-fold reproduces the zero-event default.
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({
    hook_event: "Killed",
    data: JSON.stringify({
      pid: 4242,
      start_time: null,
      close_kind: "pid_died",
    }),
  });
  drainAll();
  expect(getJob()?.state).toBe("killed");
  expect(getKillReason()).toBeNull();
});

test("Killed fold treats a non-string kill_reason as NULL (defensive, never coerced)", () => {
  // A garbage reason value must not masquerade as a real reason — it folds to
  // NULL, and the row still flips to killed (the kill itself is honored).
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  insertEvent({
    hook_event: "Killed",
    data: JSON.stringify({ pid: 4242, start_time: null, reason: 42 }),
  });
  drainAll();
  expect(getJob()?.state).toBe("killed");
  expect(getKillReason()).toBeNull();
});

// Batch-reap reclassification — the mass path where a whole cohort of live rows
// flips terminal at ONE instant (the boot seed sweep emitting a Killed per
// candidate row, or the steady-state exit-watcher reaping several at once after
// a downtime). Every reaper arm — `boot_pid_dead` / `boot_pid_recycled` /
// `boot_unwatchable` (pidless) / `exit_watched` — stamps its own `reason` into
// the per-event payload blob, so a batch is just N independent Killed folds. The
// verification here: seed a mixed cohort, reap it in a single same-ts batch, and
// assert EVERY row lands `killed` carrying ITS OWN reason (no cross-row bleed, no
// dropped reason on the mass path), refold-stable.
test("Killed fold: a same-instant batch reap carries each row's kill_reason (mass reclassification)", () => {
  // One entry per reaper arm the two producers emit. `pid: null` is the pidless
  // `boot_unwatchable` arm (reaped from `stopped`, never prompted); the rest bind
  // and work, then die. `start_time: null` on every row so the reducer's loose
  // pid-only match folds each Killed against its row.
  const cohort = [
    {
      jobId: "reap-dead",
      pid: 5001,
      reason: "boot_pid_dead",
      close: "pid_died",
    },
    {
      jobId: "reap-recycled",
      pid: 5002,
      reason: "boot_pid_recycled",
      close: "server_gone",
    },
    {
      jobId: "reap-watched",
      pid: 5003,
      reason: "exit_watched",
      close: "window_gone_server_alive",
    },
    {
      jobId: "reap-unwatchable",
      pid: null,
      reason: "boot_unwatchable",
      close: "unknown",
    },
  ] as const;

  // Bring each row to its pre-reap lifecycle: the pidless row stays `stopped`
  // (the stuck-unwatchable origin), the watchable rows advance to `working`.
  for (const c of cohort) {
    insertEvent({
      hook_event: "SessionStart",
      session_id: c.jobId,
      pid: c.pid,
    });
    if (c.pid != null) {
      // Carry the row's pid on the prompt too — the fold tracks jobs.pid from
      // the latest lifecycle event, so a default-pid prompt would clobber it and
      // desync the reap's (pid) match.
      insertEvent({
        hook_event: "UserPromptSubmit",
        session_id: c.jobId,
        pid: c.pid,
      });
    }
  }
  drainAll();
  for (const c of cohort) {
    expect(getJob(c.jobId)?.state).toBe(c.pid == null ? "stopped" : "working");
  }

  // The batch: one Killed per row, all sharing a single instant (the 14:43:37
  // flip shape). Each carries only its OWN (pid, reason, close_kind).
  const BATCH_TS = 200_000;
  for (const c of cohort) {
    insertEvent({
      hook_event: "Killed",
      session_id: c.jobId,
      ts: BATCH_TS,
      data: JSON.stringify({
        pid: c.pid,
        start_time: null,
        close_kind: c.close,
        reason: c.reason,
      }),
    });
  }
  drainAll();

  // Every row flipped terminal AND carries its own reason (+ orthogonal
  // close_kind) — no dropped or bled reason on the mass path.
  for (const c of cohort) {
    expect(getJob(c.jobId)?.state).toBe("killed");
    expect(getKillReason(c.jobId)).toBe(c.reason);
    expect(getCloseKind(c.jobId)).toBe(c.close);
  }

  // Refold-equivalence: rewind the cursor, drop + re-drain jobs from cursor=0,
  // assert byte-identical. A batch reap that read wall-clock or row-order state
  // instead of the per-event payload would diverge here.
  const cursor1 = getCursor();
  const jobs1 = db.query("SELECT * FROM jobs ORDER BY job_id").all();
  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  expect(drainAll()).toBeGreaterThan(0);
  expect(getCursor()).toBe(cursor1);
  expect(
    JSON.stringify(db.query("SELECT * FROM jobs ORDER BY job_id").all()),
  ).toBe(JSON.stringify(jobs1));
});

// ---------------------------------------------------------------------------
// Schema-v71 window_index — the visual window-order column the
// WindowIndexSnapshot was RETIRED in fn-907: the standalone window-index fold
// (fn-817) is subsumed by the TmuxTopologySnapshot live-location fold (which
// carries window_index per pane). The dispatch arm is now an EXPLICIT no-op so
// historical WindowIndexSnapshot events advance the cursor without routing into
// projectJobsRow. These tests pin the no-op contract.
// ---------------------------------------------------------------------------

function getWindowIndex(jobId = "sess-a"): number | null {
  const row = db
    .query("SELECT window_index FROM jobs WHERE job_id = ?")
    .get(jobId) as { window_index: number | null } | null;
  return row?.window_index ?? null;
}

test("retired WindowIndexSnapshot folds to a no-op: window_index is NOT written", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b" });
  insertEvent({
    hook_event: "WindowIndexSnapshot",
    data: JSON.stringify({
      entries: [
        { job_id: "sess-a", window_index: 0 },
        { job_id: "sess-b", window_index: 2 },
      ],
    }),
  });
  drainAll();
  // The retired arm no-ops — window_index stays NULL (only TmuxTopologySnapshot
  // writes it now).
  expect(getWindowIndex("sess-a")).toBeNull();
  expect(getWindowIndex("sess-b")).toBeNull();
});

test("retired WindowIndexSnapshot advances the cursor and leaves the jobs row byte-identical", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  expect(drainAll()).toBe(1);
  const before = db.query("SELECT * FROM jobs WHERE job_id = ?").get("sess-a");

  const evId = insertEvent({
    hook_event: "WindowIndexSnapshot",
    data: JSON.stringify({ entries: [{ job_id: "sess-a", window_index: 3 }] }),
  });
  expect(drainAll()).toBe(1);
  // Cursor advanced (event consumed), jobs row untouched (no fall-through to
  // projectJobsRow).
  expect(getCursor()).toBe(evId);
  const after = db.query("SELECT * FROM jobs WHERE job_id = ?").get("sess-a");
  expect(after).toEqual(before);
});

test("retired WindowIndexSnapshot against a missing job mints NO jobs row", () => {
  const evId = insertEvent({
    hook_event: "WindowIndexSnapshot",
    session_id: "window-index-snapshot",
    data: JSON.stringify({ entries: [{ job_id: "ghost", window_index: 1 }] }),
  });
  drainAll();
  expect(getCursor()).toBe(evId);
  // Neither the synthetic session id nor the entry's job_id mints a row.
  expect(getJob("window-index-snapshot")).toBeNull();
  expect(getJob("ghost")).toBeNull();
});

test("retired WindowIndexSnapshot: a malformed payload folds to a safe no-op and still advances the cursor", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  const evId = insertEvent({
    hook_event: "WindowIndexSnapshot",
    data: "not json{",
  });
  drainAll();
  expect(getWindowIndex("sess-a")).toBeNull();
  expect(getCursor()).toBeGreaterThanOrEqual(evId);
});

test("retired WindowIndexSnapshot re-fold determinism: a history with snapshots re-folds byte-identical", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({ hook_event: "SessionStart", session_id: "sess-b" });
  insertEvent({
    hook_event: "WindowIndexSnapshot",
    data: JSON.stringify({
      entries: [
        { job_id: "sess-a", window_index: 0 },
        { job_id: "sess-b", window_index: 1 },
      ],
    }),
  });
  insertEvent({
    hook_event: "WindowIndexSnapshot",
    data: JSON.stringify({
      entries: [
        { job_id: "sess-a", window_index: 1 },
        { job_id: "sess-b", window_index: 0 },
      ],
    }),
  });
  drainAll();
  const live = db
    .query("SELECT job_id, window_index FROM jobs ORDER BY job_id")
    .all() as { job_id: string; window_index: number | null }[];

  // Rewind the cursor + wipe the projection, then re-fold from scratch. The
  // retired no-op arm never touches jobs, so the rebuilt rows must be
  // byte-identical (window_index stays NULL throughout).
  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  drainAll();
  const refolded = db
    .query("SELECT job_id, window_index FROM jobs ORDER BY job_id")
    .all() as { job_id: string; window_index: number | null }[];

  expect(refolded).toEqual(live);
  expect(live.find((r) => r.job_id === "sess-a")?.window_index).toBeNull();
  expect(live.find((r) => r.job_id === "sess-b")?.window_index).toBeNull();
});

// ---------------------------------------------------------------------------
// BackendExecStart — generation-boundary marker (fn-819 task .1). The
// restore-worker mints one on a tmux server generation change; the reducer folds it
// via an explicit NO-OP dispatcher arm (the boundary lives in the event-log
// `id` order, NOT a projection column). The arm MUST be explicit: the
// inner-switch default routes unknown events to `projectJobsRow`, which would
// mint a bogus jobs row keyed on the synthetic `backend-exec-start` session.
// ---------------------------------------------------------------------------

test("BackendExecStart folds as a no-op: no jobs row minted, cursor still advances", () => {
  const evId = insertEvent({
    hook_event: "BackendExecStart",
    session_id: "backend-exec-start",
    data: JSON.stringify({ backend_type: "tmux", generation_id: "4242" }),
  });
  drainAll();
  // The synthetic per-kind session id must NOT mint a jobs row (the inner-switch
  // default would have created `backend-exec-start`).
  expect(getJob("backend-exec-start")).toBeNull();
  expect(
    (db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
  ).toBe(0);
  // The event still advanced the cursor (folded, not wedged).
  expect(getCursor()).toBeGreaterThanOrEqual(evId);
});

test("BackendExecStart never disturbs an existing jobs projection", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "BackendExecStart",
    session_id: "backend-exec-start",
    data: JSON.stringify({ backend_type: "tmux", generation_id: "100" }),
  });
  drainAll();
  // The real session is untouched; no second row appeared.
  expect(getJob("sess-a")).not.toBeNull();
  expect(getJob("backend-exec-start")).toBeNull();
  expect(
    (db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
  ).toBe(1);
});

test("BackendExecStart re-fold determinism: an empty jobs projection re-folds byte-identical", () => {
  insertEvent({ hook_event: "SessionStart", session_id: "sess-a" });
  insertEvent({
    hook_event: "BackendExecStart",
    session_id: "backend-exec-start",
    data: JSON.stringify({ backend_type: "tmux", generation_id: "100" }),
  });
  insertEvent({
    hook_event: "BackendExecStart",
    session_id: "backend-exec-start",
    data: JSON.stringify({ backend_type: "tmux", generation_id: "200" }),
  });
  drainAll();
  const live = db
    .query("SELECT job_id, state FROM jobs ORDER BY job_id")
    .all() as { job_id: string; state: string }[];

  db.run("DELETE FROM jobs");
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  drainAll();
  const refolded = db
    .query("SELECT job_id, state FROM jobs ORDER BY job_id")
    .all() as { job_id: string; state: string }[];

  expect(refolded).toEqual(live);
  // Only the real session row — the two BackendExecStart events left no trace.
  expect(live.map((r) => r.job_id)).toEqual(["sess-a"]);
});

test("BackendExecStart with a malformed payload folds to a safe no-op and advances the cursor", () => {
  const evId = insertEvent({
    hook_event: "BackendExecStart",
    session_id: "backend-exec-start",
    data: "not json{",
  });
  drainAll();
  expect(
    (db.query("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n,
  ).toBe(0);
  expect(getCursor()).toBeGreaterThanOrEqual(evId);
});

test("active_since: NOT re-stamped by a 2nd UserPromptSubmit while already working", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5000 });
  // A 2nd prompt mid-run (still 'working') must HOLD active_since — the
  // explicit ELSE branch keeps the original rising-edge value.
  insertEvent({ hook_event: "UserPromptSubmit", ts: 5500 });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("working");
  expect(job?.active_since).toBe(5000);
});

test("active_since: NOT stamped when the killed-task-notification guard swallows the prompt", () => {
  insertEvent({ hook_event: "SessionStart" });
  insertEvent({ hook_event: "Stop" });
  // The killed shutdown-housekeeping notification rides the UserPromptSubmit
  // hook but `break`s before the lifecycle UPDATE — active_since stays NULL.
  insertEvent({
    hook_event: "UserPromptSubmit",
    data: JSON.stringify({ prompt: TASK_NOTIFICATION_KILLED }),
    ts: 5000,
  });
  drainAll();
  const job = getJob();
  expect(job?.state).toBe("stopped");
  expect(job?.active_since).toBeNull();
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
