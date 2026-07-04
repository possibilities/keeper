/**
 * Codex resume-target back-fill producer (fn-1103) — the daemon-side sweep that
 * resolves a tracked codex job's native rollout uuid and has MAIN mint a
 * `ResumeTargetResolved` synthetic event. Two surfaces under test:
 *
 *  - The pure resolver ({@link resolveCodexResumeTarget}) — originator
 *    exact-match precedence over the cwd + created-at refuse-to-guess fallback,
 *    reading ONLY each rollout's SessionMeta head, tolerating a partial line.
 *  - The producer glue ({@link findCodexResumeCandidates} /
 *    {@link resolveCodexResumeCandidates}) — candidate selection off the `jobs`
 *    projection and the end-to-end round-trip through the `ResumeTargetResolved`
 *    fold arm onto `jobs.resume_target`.
 *
 * Each test clones the migrated `:memory:` template via `freshMemDb`, seeds raw
 * `events`, and drives the reducer — no daemon, worker, or real codex process.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexResumeTarget } from "../src/agent/codex-session-index";
import {
  findCodexResumeCandidates,
  resolveCodexResumeCandidates,
} from "../src/daemon";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
});

const ROLLOUT_A = "019eec30-d7eb-7142-9363-5c1535537ee6";
const ROLLOUT_B = "019eec31-aaaa-7142-9363-5c1535537ee7";
const JOB_A = "job-aaaa-1111-2222-3333-444455556666";
const JOB_B = "job-bbbb-1111-2222-3333-444455556666";

function codexHome(): string {
  return mkdtempSync(join(tmpdir(), "keeper-codex-resume-"));
}

/** Write a rollout file whose SessionMeta head carries id/cwd/originator. */
function writeRollout(
  home: string,
  opts: {
    id: string;
    cwd: string;
    startedAtMs: number;
    originator: string;
  },
): void {
  const date = new Date(opts.startedAtMs);
  const dir = join(
    home,
    "sessions",
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-21T17-58-04-${opts.id}.jsonl`),
    `${JSON.stringify({
      timestamp: date.toISOString(),
      type: "session_meta",
      payload: {
        id: opts.id,
        cwd: opts.cwd,
        originator: opts.originator,
      },
    })}\n` +
      // A subsequent conversation turn line — the producer must NEVER read past
      // the SessionMeta head, so a secret here is irrelevant to resolution.
      `${JSON.stringify({ type: "message", payload: { text: "SECRET" } })}\n`,
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

/** Seed a raw event row (all columns default NULL; overrides win). */
function insertRawEvent(overrides: {
  hook_event: string;
  session_id: string;
  ts: number;
  cwd?: string | null;
  harness?: string | null;
  resume_target?: string | null;
}): void {
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
      overrides.ts,
      overrides.session_id,
      4242,
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
    ],
  );
}

/** Seed a tracked codex job (SessionStart) and fold it into a `jobs` row. */
function seedCodexJob(jobId: string, cwd: string, ts: number): void {
  insertRawEvent({
    hook_event: "SessionStart",
    session_id: jobId,
    ts,
    cwd,
    harness: "codex",
  });
  drainAll();
}

function resumeTargetOf(jobId: string): string | null {
  const row = db
    .query("SELECT resume_target FROM jobs WHERE job_id = ?")
    .get(jobId) as { resume_target: string | null } | null;
  return row?.resume_target ?? null;
}

// ---------------------------------------------------------------------------
// resolveCodexResumeTarget — attribution precedence
// ---------------------------------------------------------------------------

test("originator exact-match wins over a same-cwd decoy", () => {
  const home = codexHome();
  const started = Date.now();
  // Two concurrent codex sessions in the SAME cwd — the collision the cwd
  // fallback must refuse. Each carries its keeper job id as SessionMeta
  // originator (CODEX_INTERNAL_ORIGINATOR_OVERRIDE), so both resolve positively.
  writeRollout(home, {
    id: ROLLOUT_A,
    cwd: "/w",
    startedAtMs: started,
    originator: JOB_A,
  });
  writeRollout(home, {
    id: ROLLOUT_B,
    cwd: "/w",
    startedAtMs: started,
    originator: JOB_B,
  });

  expect(
    resolveCodexResumeTarget({
      codexHome: home,
      jobId: JOB_A,
      expectedCwd: "/w",
      startedAtMs: started,
    }),
  ).toBe(ROLLOUT_A);
  expect(
    resolveCodexResumeTarget({
      codexHome: home,
      jobId: JOB_B,
      expectedCwd: "/w",
      startedAtMs: started,
    }),
  ).toBe(ROLLOUT_B);
});

test("same-cwd collision without the originator override leaves it unresolved", () => {
  const home = codexHome();
  const started = Date.now();
  // Override stripped (a user-modified launch): both rollouts carry codex's
  // default originator, so the fallback sees two same-cwd candidates and refuses
  // to guess rather than pinning the wrong session's rollout.
  writeRollout(home, {
    id: ROLLOUT_A,
    cwd: "/w",
    startedAtMs: started,
    originator: "codex-tui",
  });
  writeRollout(home, {
    id: ROLLOUT_B,
    cwd: "/w",
    startedAtMs: started,
    originator: "codex-tui",
  });

  expect(
    resolveCodexResumeTarget({
      codexHome: home,
      jobId: JOB_A,
      expectedCwd: "/w",
      startedAtMs: started,
    }),
  ).toBeNull();
});

test("cwd fallback resolves a sole candidate when the override is absent", () => {
  const home = codexHome();
  const started = Date.now();
  writeRollout(home, {
    id: ROLLOUT_A,
    cwd: "/w",
    startedAtMs: started,
    originator: "codex-tui",
  });
  expect(
    resolveCodexResumeTarget({
      codexHome: home,
      jobId: JOB_A,
      expectedCwd: "/w",
      startedAtMs: started,
    }),
  ).toBe(ROLLOUT_A);
});

test("a partially-written SessionMeta line is tolerated (skipped, never thrown)", () => {
  const home = codexHome();
  const started = Date.now();
  // A truncated meta line (codex collects git fields async) — invalid JSON.
  const date = new Date(started);
  const dir = join(
    home,
    "sessions",
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-06-21T17-58-04-${ROLLOUT_B}.jsonl`),
    `{"type":"session_meta","payload":{"id":"${ROLLOUT_B}","cwd":"/w"`, // truncated
  );
  // A well-formed originator-matching rollout alongside it still resolves.
  writeRollout(home, {
    id: ROLLOUT_A,
    cwd: "/w",
    startedAtMs: started,
    originator: JOB_A,
  });
  expect(
    resolveCodexResumeTarget({
      codexHome: home,
      jobId: JOB_A,
      expectedCwd: "/w",
      startedAtMs: started,
    }),
  ).toBe(ROLLOUT_A);
});

// ---------------------------------------------------------------------------
// findCodexResumeCandidates — selection off the jobs projection
// ---------------------------------------------------------------------------

test("candidates are live NULL-target codex jobs within the recency window", () => {
  const now = Date.now() / 1000;
  seedCodexJob(JOB_A, "/w", now);
  const found = findCodexResumeCandidates(db, now, 600);
  expect(found.map((c) => c.jobId)).toEqual([JOB_A]);
  expect(found[0]?.cwd).toBe("/w");
  expect(found[0]?.startedAtMs).toBeCloseTo(now * 1000, 0);
});

test("a non-codex job, a resolved job, and a stale job are all excluded", () => {
  const now = Date.now() / 1000;
  // claude (NULL harness) — never a codex candidate.
  insertRawEvent({
    hook_event: "SessionStart",
    session_id: "claude-1",
    ts: now,
  });
  // codex but already resolved — drops out.
  insertRawEvent({
    hook_event: "SessionStart",
    session_id: "codex-resolved",
    ts: now,
    harness: "codex",
    resume_target: "already-set",
  });
  // codex but launched before the recency window — goes quiet.
  seedCodexJob("codex-old", "/w", now - 10_000);
  drainAll();

  const found = findCodexResumeCandidates(db, now, 600);
  expect(found.map((c) => c.jobId)).toEqual([]);
});

// ---------------------------------------------------------------------------
// resolveCodexResumeCandidates + fold — the end-to-end back-fill
// ---------------------------------------------------------------------------

test("a tracked codex launch resolves and round-trips to jobs.resume_target", () => {
  const home = codexHome();
  const now = Date.now() / 1000;
  seedCodexJob(JOB_A, "/w", now);
  writeRollout(home, {
    id: ROLLOUT_A,
    cwd: "/w",
    startedAtMs: now * 1000,
    originator: JOB_A,
  });
  expect(resumeTargetOf(JOB_A)).toBeNull();

  const resolutions = resolveCodexResumeCandidates(db, home, now, 600);
  expect(resolutions).toEqual([{ jobId: JOB_A, resumeTarget: ROLLOUT_A }]);
  const resolution = resolutions[0];
  expect(resolution).toBeDefined();

  // Feed the producer's output as MAIN would: a ResumeTargetResolved event whose
  // fold sets jobs.resume_target without touching lifecycle state.
  insertRawEvent({
    hook_event: "ResumeTargetResolved",
    session_id: resolution?.jobId ?? "",
    ts: now + 1,
    resume_target: resolution?.resumeTarget ?? null,
  });
  drainAll();
  expect(resumeTargetOf(JOB_A)).toBe(ROLLOUT_A);
  const stateRow = db
    .query("SELECT state FROM jobs WHERE job_id = ?")
    .get(JOB_A) as { state: string } | null;
  expect(stateRow?.state).toBe("stopped");
});

test("no candidate jobs → no resolutions and no tree read (idle)", () => {
  const now = Date.now() / 1000;
  // No codex jobs at all — the producer idles: even a non-existent codex home is
  // never read because the candidate query returns nothing.
  expect(
    resolveCodexResumeCandidates(db, "/no/such/codex/home", now, 600),
  ).toEqual([]);
});
