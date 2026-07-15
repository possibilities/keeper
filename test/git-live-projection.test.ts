/**
 * fn-868 — LIVE-ONLY git projection: the `applyEvent` skip-floor gates + the
 * `foldCommit` commit-split. The git surface (`git_status` + `file_attributions`
 * + the 3 `jobs` git-counter columns) is producer-fed, NOT replayed: every git
 * fold NO-OPS for `event.id <= git_projection_state.floor`, while the
 * DETERMINISTIC siblings (`commit_trailer_facts`, plan-links) stay unconditional.
 *
 * In-process unit tests over the migrated `:memory:` template (`freshMemDb`),
 * seeding raw `events` rows + driving the reducer directly, mirroring the
 * reducer-lifecycle shard helpers.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  LIVE_ONLY_JOBS_COLUMNS,
  LIVE_ONLY_PROJECTIONS,
  raiseGitProjectionFloor,
  raiseTmuxProjectionFloor,
  readGitProjectionFloor,
  readGitProjectionSeedRequired,
  readTmuxProjectionFloor,
  readTmuxProjectionSeedRequired,
  setGitProjectionSeedRequired,
  setTmuxProjectionSeedRequired,
} from "../src/db";
import { drain } from "../src/reducer";
import { bindGitObservationWatermark } from "./helpers/git-event-payload";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
});

let tsCounter = 5_000;

/** Minimal raw-event insert (the git/commit-relevant columns only). */
function insertEvent(overrides: {
  hook_event: string;
  session_id?: string;
  cwd?: string;
  data?: string;
  plan_op?: string | null;
  plan_target?: string | null;
  plan_epic_id?: string | null;
  plan_task_id?: string | null;
  plan_files?: string | null;
}): number {
  const ts = tsCounter++;
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, cwd, data,
       plan_op, plan_target, plan_epic_id, plan_task_id, plan_files
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts,
      overrides.session_id ?? "/repo",
      null,
      overrides.hook_event,
      overrides.hook_event,
      null,
      overrides.cwd ?? "/repo",
      bindGitObservationWatermark(
        db,
        overrides.hook_event,
        overrides.data ?? "{}",
      ),
      overrides.plan_op ?? null,
      overrides.plan_target ?? null,
      overrides.plan_epic_id ?? null,
      overrides.plan_task_id ?? null,
      overrides.plan_files ?? null,
    ],
  );
  return Number(
    (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
  );
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

function gitSnapshotData(projectDir: string, files: string[]): string {
  return JSON.stringify({
    project_dir: projectDir,
    branch: "main",
    head_oid: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    dirty_files: files.map((p) => ({ path: p, xy: " M", mtime_ms: null })),
  });
}

function gitStatusRow(projectDir: string): { dirty_count: number } | null {
  return db
    .query("SELECT dirty_count FROM git_status WHERE project_dir = ?")
    .get(projectDir) as { dirty_count: number } | null;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("registry: LIVE_ONLY_PROJECTIONS names exactly git_status + file_attributions + tmux_client_focus + worktree_repo_status + lane_merged, and the 5 live-only jobs columns (3 git counters + 2 tmux location)", () => {
  expect([...LIVE_ONLY_PROJECTIONS]).toEqual([
    "git_status",
    "file_attributions",
    "tmux_client_focus",
    "worktree_repo_status",
    "lane_merged",
  ]);
  expect([...LIVE_ONLY_JOBS_COLUMNS]).toEqual([
    "git_dirty_count",
    "git_unattributed_to_live_count",
    "git_orphan_count",
    "backend_exec_session_id",
    "window_index",
  ]);
});

test("the live-only tables + 3 jobs columns all exist in the migrated schema (registry stays in sync with the schema)", () => {
  for (const table of LIVE_ONLY_PROJECTIONS) {
    const info = db.query(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    expect(info.length).toBeGreaterThan(0);
  }
  const jobsCols = new Set(
    (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  for (const col of LIVE_ONLY_JOBS_COLUMNS) {
    expect(jobsCols.has(col)).toBe(true);
  }
});

test("fn-907 v83 schema: fresh DB has tmux_projection_state + the two new forensic jobs columns", () => {
  const tmuxState = db
    .query("PRAGMA table_info(tmux_projection_state)")
    .all() as { name: string }[];
  const tmuxCols = new Set(tmuxState.map((c) => c.name));
  expect(tmuxCols.has("floor")).toBe(true);
  expect(tmuxCols.has("seed_required")).toBe(true);
  // The singleton control row is seeded on a fresh DB.
  const seedRow = db
    .query("SELECT seed_required FROM tmux_projection_state WHERE id = 1")
    .get() as { seed_required: number } | null;
  expect(seedRow).not.toBeNull();

  const jobsCols = new Set(
    (db.query("PRAGMA table_info(jobs)").all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
  expect(jobsCols.has("backend_exec_generation_id")).toBe(true);
  expect(jobsCols.has("backend_exec_birth_session_id")).toBe(true);
});

// ---------------------------------------------------------------------------
// Floor accessors
// ---------------------------------------------------------------------------

test("floor accessors: fresh template seeds floor=0 + seed_required=true; raise is monotonic; seed_required toggles", () => {
  expect(readGitProjectionFloor(db)).toBe(0);
  // The unconditional seed marks a fresh DB as needing the boot-seed.
  expect(readGitProjectionSeedRequired(db)).toBe(true);

  raiseGitProjectionFloor(db, 100);
  expect(readGitProjectionFloor(db)).toBe(100);
  // Monotonic — a lower raise never lowers it.
  raiseGitProjectionFloor(db, 50);
  expect(readGitProjectionFloor(db)).toBe(100);
  raiseGitProjectionFloor(db, 150);
  expect(readGitProjectionFloor(db)).toBe(150);

  setGitProjectionSeedRequired(db, false);
  expect(readGitProjectionSeedRequired(db)).toBe(false);
  setGitProjectionSeedRequired(db, true);
  expect(readGitProjectionSeedRequired(db)).toBe(true);
});

test("tmux floor accessors (fn-907): fresh template seeds floor=0 + seed_required=true; raise is monotonic; seed_required toggles", () => {
  expect(readTmuxProjectionFloor(db)).toBe(0);
  expect(readTmuxProjectionSeedRequired(db)).toBe(true);

  raiseTmuxProjectionFloor(db, 100);
  expect(readTmuxProjectionFloor(db)).toBe(100);
  // Monotonic — a lower raise never lowers it.
  raiseTmuxProjectionFloor(db, 50);
  expect(readTmuxProjectionFloor(db)).toBe(100);
  raiseTmuxProjectionFloor(db, 150);
  expect(readTmuxProjectionFloor(db)).toBe(150);

  setTmuxProjectionSeedRequired(db, false);
  expect(readTmuxProjectionSeedRequired(db)).toBe(false);
  setTmuxProjectionSeedRequired(db, true);
  expect(readTmuxProjectionSeedRequired(db)).toBe(true);
});

// ---------------------------------------------------------------------------
// Cutoff-correctness: projectGitStatus / retractGitStatus
// ---------------------------------------------------------------------------

test("cutoff: a GitSnapshot at id <= floor NO-OPS (git_status stays empty); the cursor still advances", () => {
  const id = insertEvent({
    hook_event: "GitSnapshot",
    data: gitSnapshotData("/repo", ["a.ts"]),
  });
  // Floor at/above the event id ⇒ the git fold no-ops.
  raiseGitProjectionFloor(db, id);

  expect(drain(db)).toBe(1); // event folded (no-op git arm) — cursor advances
  expect(gitStatusRow("/repo")).toBeNull();
  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBe(id);
});

test("cutoff: a GitSnapshot at id > floor FOLDS normally (git_status populated)", () => {
  // Floor stays at the fresh-DB default 0 ⇒ every event is above floor ⇒ folds.
  insertEvent({
    hook_event: "GitSnapshot",
    data: gitSnapshotData("/repo", ["a.ts", "b.ts"]),
  });
  drainAll();
  expect(gitStatusRow("/repo")?.dirty_count).toBe(2);
});

test("cutoff: a GitRootDropped at id <= floor NO-OPS (does not DELETE a freshly-seeded row)", () => {
  // Seed a git_status row with the floor at the default 0 (event folds).
  insertEvent({
    hook_event: "GitSnapshot",
    data: gitSnapshotData("/repo", ["a.ts"]),
  });
  drainAll();
  expect(gitStatusRow("/repo")).not.toBeNull();

  // A GitRootDropped whose id is <= the floor must NOT retract.
  const dropId = insertEvent({
    hook_event: "GitRootDropped",
    session_id: "/repo",
  });
  raiseGitProjectionFloor(db, dropId);
  drainAll();
  // Row survives — the historical tombstone self-gated.
  expect(gitStatusRow("/repo")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// mintPlanFileAttributions gate
// ---------------------------------------------------------------------------

test("cutoff: a plan-file mint at id <= floor NO-OPS (no source='plan' attribution)", () => {
  const id = insertEvent({
    hook_event: "PostToolUse",
    session_id: "11111111-1111-1111-1111-111111111111",
    cwd: "/repo",
    data: JSON.stringify({
      plan_invocation: {
        op: "scaffold",
        target: "fn-1-x",
        state_repo: "/repo",
        files: [".keeper/epics/fn-1-x.json"],
      },
    }),
    plan_op: "scaffold",
    plan_target: "fn-1-x",
    plan_epic_id: "fn-1-x",
    plan_task_id: "fn-1-x",
    plan_files: JSON.stringify([".keeper/epics/fn-1-x.json"]),
  });
  raiseGitProjectionFloor(db, id);
  drainAll();
  const planAttribs = db
    .query("SELECT COUNT(*) AS n FROM file_attributions WHERE source = 'plan'")
    .get() as { n: number };
  expect(planAttribs.n).toBe(0);
});

test("above floor: a plan-file mint FOLDS (source='plan' attribution present)", () => {
  // Floor stays at the fresh-DB default 0 ⇒ the mint folds.
  insertEvent({
    hook_event: "PostToolUse",
    session_id: "11111111-1111-1111-1111-111111111111",
    cwd: "/repo",
    data: JSON.stringify({
      plan_invocation: {
        op: "scaffold",
        target: "fn-1-x",
        state_repo: "/repo",
        files: [".keeper/epics/fn-1-x.json"],
      },
    }),
    plan_op: "scaffold",
    plan_target: "fn-1-x",
    plan_epic_id: "fn-1-x",
    plan_task_id: "fn-1-x",
    plan_files: JSON.stringify([".keeper/epics/fn-1-x.json"]),
  });
  drainAll();
  const planAttribs = db
    .query("SELECT COUNT(*) AS n FROM file_attributions WHERE source = 'plan'")
    .get() as { n: number };
  expect(planAttribs.n).toBe(1);
});

// ---------------------------------------------------------------------------
// Commit-split: commit_trailer_facts UNCONDITIONAL, discharge GATED
// ---------------------------------------------------------------------------

test("commit-split: a Commit at id <= floor STILL inserts commit_trailer_facts but does NOT discharge file_attributions", () => {
  const SESS = "22222222-2222-2222-2222-222222222222";
  // 1. Mint an undischarged attribution via a GitSnapshot (floor default 0).
  // Seed a mutation so the file gets attributed to SESS.
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (?, ?, ?, 'PostToolUse', 'post_tool_use', 'Write', ?, ?, ?)`,
    [
      tsCounter++,
      SESS,
      null,
      "/repo",
      JSON.stringify({ file_path: "/repo/x.ts" }),
      "/repo/x.ts",
    ],
  );
  insertEvent({
    hook_event: "GitSnapshot",
    data: gitSnapshotData("/repo", ["x.ts"]),
  });
  drainAll();
  const beforeAttrib = db
    .query(
      "SELECT last_commit_at FROM file_attributions WHERE project_dir = '/repo' AND file_path = 'x.ts' AND session_id = ?",
    )
    .get(SESS) as { last_commit_at: number | null } | null;
  expect(beforeAttrib).not.toBeNull();
  expect(beforeAttrib?.last_commit_at).toBeNull(); // undischarged

  // 2. A Commit whose id is <= the floor: trailer-facts UNCONDITIONAL, discharge GATED.
  const commitId = insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: "1111111111111111111111111111111111111111",
      parent_oid: null,
      files: [{ path: "x.ts" }],
      committer_session_id: SESS,
      committed_at_ms: 9_000_000,
      plan_op: "done",
      plan_target: "fn-1-x.1",
    }),
  });
  raiseGitProjectionFloor(db, commitId);
  drainAll();

  // commit_trailer_facts landed (DETERMINISTIC — unconditional below floor).
  const facts = db
    .query("SELECT COUNT(*) AS n FROM commit_trailer_facts WHERE event_id = ?")
    .get(commitId) as { n: number };
  expect(facts.n).toBe(1);

  // file_attributions NOT discharged (LIVE-ONLY — gated below floor): last_commit_at still NULL.
  const afterAttrib = db
    .query(
      "SELECT last_commit_at FROM file_attributions WHERE project_dir = '/repo' AND file_path = 'x.ts' AND session_id = ?",
    )
    .get(SESS) as { last_commit_at: number | null } | null;
  expect(afterAttrib?.last_commit_at).toBeNull();
});

test("commit-split: a Commit ABOVE floor discharges file_attributions normally", () => {
  const SESS = "33333333-3333-3333-3333-333333333333";
  // Floor stays at the fresh-DB default 0 ⇒ both the GitSnapshot and the Commit
  // fold; the Commit discharges the attribution normally.
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (?, ?, ?, 'PostToolUse', 'post_tool_use', 'Write', ?, ?, ?)`,
    [
      tsCounter++,
      SESS,
      null,
      "/repo",
      JSON.stringify({ file_path: "/repo/y.ts" }),
      "/repo/y.ts",
    ],
  );
  insertEvent({
    hook_event: "GitSnapshot",
    data: gitSnapshotData("/repo", ["y.ts"]),
  });
  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: "2222222222222222222222222222222222222222",
      parent_oid: null,
      files: [{ path: "y.ts" }],
      committer_session_id: SESS,
      committed_at_ms: 9_500_000,
    }),
  });
  drainAll();
  const attrib = db
    .query(
      "SELECT last_commit_at FROM file_attributions WHERE project_dir = '/repo' AND file_path = 'y.ts' AND session_id = ?",
    )
    .get(SESS) as { last_commit_at: number | null } | null;
  expect(attrib?.last_commit_at).not.toBeNull(); // discharged
});

// ---------------------------------------------------------------------------
// Enumeration / charter: no DETERMINISTIC fold reads the live surface above-floor
// ---------------------------------------------------------------------------

test("charter: re-folding the full log with the floor RAISED leaves the deterministic projections identical and the live surface EMPTY", () => {
  // Seed a mixed corpus: a SessionStart (jobs — deterministic) + a GitSnapshot
  // (live) + a plan Commit (trailer-facts deterministic, discharge live).
  insertEvent({
    hook_event: "SessionStart",
    session_id: "44444444-4444-4444-4444-444444444444",
  });
  insertEvent({
    hook_event: "GitSnapshot",
    data: gitSnapshotData("/repo", ["z.ts"]),
  });
  // First fold with floor=0 (everything folds) to establish the deterministic baseline.
  drainAll();
  const jobsBaseline = db
    .query("SELECT job_id, state FROM jobs ORDER BY job_id")
    .all();

  // Now simulate the production live-only path: raise the floor past everything,
  // wipe the live surface, rewind the cursor, re-fold. The DETERMINISTIC jobs
  // projection must reproduce; the LIVE git_status must NOT (it's now empty).
  const maxId = (
    db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;
  raiseGitProjectionFloor(db, maxId);
  for (const table of LIVE_ONLY_PROJECTIONS) db.run(`DELETE FROM ${table}`);
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  drainAll();

  const jobsAfter = db
    .query("SELECT job_id, state FROM jobs ORDER BY job_id")
    .all();
  expect(jobsAfter).toEqual(jobsBaseline); // deterministic surface reproduced
  expect(gitStatusRow("/repo")).toBeNull(); // live surface stayed empty (gated)
});
