/**
 * Codex live-state producer (fn-1103) — the daemon-side rollout tailer that
 * surfaces a tracked codex session's live STOP-churn. Surfaces under test:
 *
 *  - The pure tail/collect core ({@link tailCodexStopSignals} /
 *    {@link collectCodexStopSignals} / {@link locateCodexRolloutByUuid}) —
 *    forward-tailing an attributed rollout, EOF-anchoring on first sight so a
 *    boot scan never re-mints a rollout's whole stop history, reading ONLY
 *    markers + per-line timestamps (never message content), and idling when a
 *    rollout is unattributed/absent.
 *  - The producer glue ({@link findLiveCodexStateJobs}) — candidate selection off
 *    the `jobs` projection (idles on a NULL `resume_target`).
 *  - The end-to-end fold: a minted `Stop` stamped with the rollout line's ts
 *    flips a working codex row to stopped, and NEVER revives a killed row (the
 *    replay non-revive guarantee).
 *
 * Each test sandboxes CODEX_HOME with fixture rollout files and clones the
 * migrated `:memory:` template — no daemon, worker, or real codex process.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCodexStopSignals,
  locateCodexRolloutByUuid,
  type RolloutCursor,
  tailCodexStopSignals,
} from "../src/codex-state-worker";
import { findLiveCodexStateJobs } from "../src/daemon";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
});

const UUID = "019eec30-d7eb-7142-9363-5c1535537ee6";
const JOB = "job-aaaa-1111-2222-3333-444455556666";
const CWD = "/w";
const STOP_TS = "2026-07-03T12:00:00.000Z";
const STOP_TS_SEC = Date.parse(STOP_TS) / 1000;

function codexHome(): string {
  return mkdtempSync(join(tmpdir(), "keeper-codex-state-"));
}

function rolloutPath(home: string, uuid: string, createdAtMs: number): string {
  const date = new Date(createdAtMs);
  const dir = join(
    home,
    "sessions",
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, `rollout-2026-07-03T12-00-00-${uuid}.jsonl`);
}

function metaLine(uuid: string, cwd: string, createdAtMs: number): string {
  return `${JSON.stringify({
    timestamp: new Date(createdAtMs).toISOString(),
    type: "session_meta",
    payload: { id: uuid, cwd, originator: JOB },
  })}\n`;
}

function taskCompleteLine(ts: string, message = "SECRET"): string {
  return `${JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    // last_agent_message carries session CONTENT the producer must never surface.
    payload: { type: "task_complete", last_agent_message: message },
  })}\n`;
}

// ---------------------------------------------------------------------------
// tailCodexStopSignals — parse markers + rollout-line ts, never content
// ---------------------------------------------------------------------------

test("tail parses a task_complete into a signal stamped with the rollout line's ts", () => {
  const home = codexHome();
  const created = Date.now();
  const path = rolloutPath(home, UUID, created);
  writeFileSync(path, metaLine(UUID, CWD, created) + taskCompleteLine(STOP_TS));

  const { signals, nextOffset } = tailCodexStopSignals(path, JOB, 0);
  expect(signals).toHaveLength(1);
  expect(signals[0]).toEqual({
    jobId: JOB,
    reason: "task_complete",
    tsSec: STOP_TS_SEC,
  });
  // The offset advanced to EOF so a re-tail from it yields nothing.
  expect(tailCodexStopSignals(path, JOB, nextOffset).signals).toHaveLength(0);
});

test("the signal carries only markers + ts — never the rollout's message content", () => {
  const home = codexHome();
  const created = Date.now();
  const path = rolloutPath(home, UUID, created);
  writeFileSync(
    path,
    metaLine(UUID, CWD, created) +
      taskCompleteLine(STOP_TS, "a-secret-the-model-said"),
  );

  const { signals } = tailCodexStopSignals(path, JOB, 0);
  expect(signals).toHaveLength(1);
  // Structural: exactly the three marker/identity fields, no content leak.
  expect(Object.keys(signals[0] ?? {}).sort()).toEqual([
    "jobId",
    "reason",
    "tsSec",
  ]);
  expect(JSON.stringify(signals[0])).not.toContain("a-secret-the-model-said");
});

test("tail ignores session_meta, agent_message, and non-stop lines", () => {
  const home = codexHome();
  const created = Date.now();
  const path = rolloutPath(home, UUID, created);
  writeFileSync(
    path,
    metaLine(UUID, CWD, created) +
      `${JSON.stringify({
        timestamp: STOP_TS,
        type: "event_msg",
        payload: { type: "agent_message", message: "mid-turn text" },
      })}\n` +
      `${JSON.stringify({ type: "response_item", payload: {} })}\n`,
  );
  expect(tailCodexStopSignals(path, JOB, 0).signals).toHaveLength(0);
});

test("a stop marker with no readable line timestamp is dropped (never wall-clock)", () => {
  const home = codexHome();
  const created = Date.now();
  const path = rolloutPath(home, UUID, created);
  writeFileSync(
    path,
    metaLine(UUID, CWD, created) +
      `${JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete" },
      })}\n`,
  );
  expect(tailCodexStopSignals(path, JOB, 0).signals).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// locateCodexRolloutByUuid — exact suffix match, refuse a wrong uuid
// ---------------------------------------------------------------------------

test("locate finds the rollout by uuid suffix and misses a wrong uuid", () => {
  const home = codexHome();
  const created = Date.now();
  const path = rolloutPath(home, UUID, created);
  writeFileSync(path, metaLine(UUID, CWD, created));

  expect(locateCodexRolloutByUuid(home, UUID, created)).toBe(path);
  expect(
    locateCodexRolloutByUuid(
      home,
      "ffffffff-0000-0000-0000-000000000000",
      created,
    ),
  ).toBeNull();
});

// ---------------------------------------------------------------------------
// collectCodexStopSignals — EOF-anchor on first sight, churn on new turns
// ---------------------------------------------------------------------------

test("first sight EOF-anchors (no history replay); a later turn yields churn", () => {
  const home = codexHome();
  const created = Date.now();
  const path = rolloutPath(home, UUID, created);
  // A pre-existing stop marker: first sight must NOT re-mint it (bounded boot).
  writeFileSync(path, metaLine(UUID, CWD, created) + taskCompleteLine(STOP_TS));
  const cursors = new Map<string, RolloutCursor>();
  const jobs = [{ jobId: JOB, resumeTarget: UUID, createdAtMs: created }];

  expect(collectCodexStopSignals(jobs, home, cursors)).toHaveLength(0);
  expect(cursors.has(JOB)).toBe(true);

  // A new turn completes → the second tick surfaces exactly that stop.
  const nextTs = "2026-07-03T12:05:00.000Z";
  appendFileSync(path, taskCompleteLine(nextTs));
  const churn = collectCodexStopSignals(jobs, home, cursors);
  expect(churn).toHaveLength(1);
  expect(churn[0]?.tsSec).toBe(Date.parse(nextTs) / 1000);
});

test("collect idles (no signals) on an empty job list and an unlocated rollout", () => {
  const home = codexHome();
  const cursors = new Map<string, RolloutCursor>();
  // Empty list — the pure idle path, no filesystem read.
  expect(collectCodexStopSignals([], home, cursors)).toHaveLength(0);
  // Attributed job whose rollout file does not exist yet — idle, no cursor.
  const jobs = [{ jobId: JOB, resumeTarget: UUID, createdAtMs: Date.now() }];
  expect(collectCodexStopSignals(jobs, home, cursors)).toHaveLength(0);
  expect(cursors.has(JOB)).toBe(false);
});

test("cursors are GC'd once a job leaves the live set", () => {
  const home = codexHome();
  const created = Date.now();
  const path = rolloutPath(home, UUID, created);
  writeFileSync(path, metaLine(UUID, CWD, created));
  const cursors = new Map<string, RolloutCursor>();
  const jobs = [{ jobId: JOB, resumeTarget: UUID, createdAtMs: created }];

  collectCodexStopSignals(jobs, home, cursors);
  expect(cursors.has(JOB)).toBe(true);
  // Job now terminal / gone → absent from the list → cursor pruned.
  collectCodexStopSignals([], home, cursors);
  expect(cursors.has(JOB)).toBe(false);
});

// ---------------------------------------------------------------------------
// findLiveCodexStateJobs — candidate selection off the jobs projection
// ---------------------------------------------------------------------------

/** Seed a raw event row (all columns default NULL; overrides win). */
function insertRawEvent(overrides: {
  hook_event: string;
  session_id: string;
  ts: number;
  cwd?: string | null;
  harness?: string | null;
  resume_target?: string | null;
}): void {
  const cols = [
    overrides.ts,
    overrides.session_id,
    4242, // pid — shared across a session's events (recycle-stable).
    overrides.hook_event,
    overrides.hook_event,
    null,
    null,
    overrides.cwd ?? null,
    null,
    null,
    null,
    null,
    "{}",
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    overrides.session_id,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    overrides.harness ?? null,
    overrides.resume_target ?? null,
  ];
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
    cols,
  );
}

function drainAll(): void {
  while (drain(db) > 0) {
    /* fold to quiescence */
  }
}

function stateOf(jobId: string): string | null {
  const row = db
    .query("SELECT state FROM jobs WHERE job_id = ?")
    .get(jobId) as { state: string } | null;
  return row?.state ?? null;
}

test("findLiveCodexStateJobs returns only attributed, non-terminal codex jobs", () => {
  // Attributed codex job (has a resume_target) — included.
  insertRawEvent({
    hook_event: "SessionStart",
    session_id: JOB,
    ts: 1000,
    cwd: CWD,
    harness: "codex",
    resume_target: UUID,
  });
  // codex job with NULL resume_target — the producer idles on it (excluded).
  insertRawEvent({
    hook_event: "SessionStart",
    session_id: "job-unattributed",
    ts: 1000,
    cwd: CWD,
    harness: "codex",
  });
  // A claude (NULL-harness) job — not codex, excluded.
  insertRawEvent({
    hook_event: "SessionStart",
    session_id: "job-claude",
    ts: 1000,
    cwd: CWD,
    resume_target: "some-claude-uuid",
  });
  drainAll();

  const jobs = findLiveCodexStateJobs(db);
  expect(jobs.map((j) => j.jobId)).toEqual([JOB]);
  expect(jobs[0]).toEqual({
    jobId: JOB,
    resumeTarget: UUID,
    createdAtMs: 1000 * 1000,
  });
});

// ---------------------------------------------------------------------------
// End-to-end fold — churn on a live row, non-revive on a dead row
// ---------------------------------------------------------------------------

test("a minted Stop flips a working codex row to stopped, stamped with the rollout ts", () => {
  insertRawEvent({
    hook_event: "SessionStart",
    session_id: JOB,
    ts: 1000,
    cwd: CWD,
    harness: "codex",
    resume_target: UUID,
  });
  // A prompt drives the row to 'working' (the churn we then stop).
  insertRawEvent({
    hook_event: "UserPromptSubmit",
    session_id: JOB,
    ts: 1001,
    cwd: CWD,
  });
  drainAll();
  expect(stateOf(JOB)).toBe("working");

  // The producer's Stop mint: session_id = job id, ts = rollout-line ts (seconds).
  insertRawEvent({ hook_event: "Stop", session_id: JOB, ts: STOP_TS_SEC });
  drainAll();

  expect(stateOf(JOB)).toBe("stopped");
  const row = db
    .query("SELECT updated_at FROM jobs WHERE job_id = ?")
    .get(JOB) as { updated_at: number };
  expect(row.updated_at).toBe(STOP_TS_SEC);
});

test("replaying a dead session's stop never revives a killed row", () => {
  insertRawEvent({
    hook_event: "SessionStart",
    session_id: JOB,
    ts: 1000,
    cwd: CWD,
    harness: "codex",
    resume_target: UUID,
  });
  drainAll();
  // Drive the row terminal (killed), as the exit-watcher would.
  db.run("UPDATE jobs SET state = 'killed' WHERE job_id = ?", [JOB]);

  // A boot-scan / tail-catch-up replay of the rollout mints a Stop for the dead
  // session — the terminal-guarded fold must leave it killed.
  insertRawEvent({ hook_event: "Stop", session_id: JOB, ts: STOP_TS_SEC });
  drainAll();
  expect(stateOf(JOB)).toBe("killed");
});
