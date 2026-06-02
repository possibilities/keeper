/**
 * Restore-snapshot worker tests (epic fn-677 task .3).
 *
 * Exercise the pure `buildRestoreDescriptor`, `serializeForHash`,
 * `serializeForWrite`, and `restorePulse` symbols against a fresh writer DB
 * seeded by direct `INSERT INTO jobs` / `INSERT INTO epics`. The worker's
 * lifecycle (Worker thread, watchLoop, parentPort) is NOT spawned — the
 * `isMainThread` guard keeps the plain `import` inert, the same shape every
 * other worker test uses.
 *
 * `KEEPER_RESTORE_FILE` is set per-test so the worker code never touches the
 * user's real `~/.local/state/keeper/restore.json` (the sandboxed-base-env
 * pattern from CLAUDE.md's test-isolation rules).
 *
 * Coverage:
 *  - `buildRestoreDescriptor`: filters to live jobs (`working`/`stopped`),
 *    drops `ended`/`killed`, drops `backend_exec_session_id == null`, drops
 *    empty job_id; groups by session; sorts agents by job_id; pre-resolves
 *    tier via the shared helper.
 *  - `serializeForHash`: strips `captured_at` so a wall-clock-only change
 *    leaves the hash stable.
 *  - `serializeForWrite`: keeps `captured_at` and produces ASCII-escaped,
 *    sorted-key JSON ending in `\n` (the same shape as planctl JSON).
 *  - `restorePulse`: writes the file on first call, swallows redundant
 *    pulses when the descriptor (sans `captured_at`) is unchanged, rewrites
 *    when the descriptor genuinely changes.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resolveRestorePath } from "../src/db";
import {
  buildRestoreDescriptor,
  restorePulse,
  serializeForHash,
  serializeForWrite,
} from "../src/restore-worker";
import type { Epic, Job } from "../src/types";

let tmpDir: string;
let dbPath: string;
let restorePath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-restore-worker-test-"));
  dbPath = join(tmpDir, "keeper.db");
  restorePath = join(tmpDir, "restore.json");
  process.env.KEEPER_RESTORE_FILE = restorePath;
  db = openDb(dbPath).db;
});

afterEach(() => {
  db.close();
  delete process.env.KEEPER_RESTORE_FILE;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert one row into `jobs` with only the columns the descriptor builder
 * reads. Defaults match a freshly-spawned working session.
 */
function insertJob(opts: {
  job_id: string;
  state?: string;
  cwd?: string | null;
  title?: string | null;
  plan_verb?: string | null;
  plan_ref?: string | null;
  backend_exec_session_id?: string | null;
}): void {
  const state = opts.state ?? "working";
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at,
       cwd, title, plan_verb, plan_ref, backend_exec_session_id
     ) VALUES (?, 1000, ?, 0, 1000, ?, ?, ?, ?, ?)`,
    [
      opts.job_id,
      state,
      opts.cwd ?? null,
      opts.title ?? null,
      opts.plan_verb ?? null,
      opts.plan_ref ?? null,
      opts.backend_exec_session_id ?? null,
    ],
  );
}

/** Insert one minimal `epics` row carrying a tasks-list with a tier on task N. */
function insertEpicWithTier(opts: {
  epic_id: string;
  task_id: string;
  tier: string;
}): void {
  const tasks = JSON.stringify([
    {
      task_id: opts.task_id,
      title: "T",
      target_repo: "/repo",
      status: "open",
      tier: opts.tier,
      jobs: [],
    },
  ]);
  db.run(
    `INSERT INTO epics (epic_id, epic_number, title, project_dir, status, last_event_id, updated_at, tasks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [opts.epic_id, 1, "Epic", "/repo", "open", 1, 0, tasks],
  );
}

// ---------------------------------------------------------------------------
// buildRestoreDescriptor — filtering + grouping
// ---------------------------------------------------------------------------

test("buildRestoreDescriptor surfaces only working/stopped jobs", () => {
  const jobs: Job[] = [
    fakeJob({
      job_id: "live",
      state: "working",
      backend_exec_session_id: "s1",
    }),
    fakeJob({
      job_id: "rest",
      state: "stopped",
      backend_exec_session_id: "s1",
    }),
    fakeJob({ job_id: "done", state: "ended", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "kill", state: "killed", backend_exec_session_id: "s1" }),
  ];
  const out = buildRestoreDescriptor(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual(["live", "rest"]);
});

test("buildRestoreDescriptor omits jobs whose backend_exec_session_id is null", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "with", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "without", backend_exec_session_id: null }),
  ];
  const out = buildRestoreDescriptor(jobs, new Map(), 1000);
  expect(Object.keys(out.sessions)).toEqual(["s1"]);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual(["with"]);
});

test("buildRestoreDescriptor omits jobs with empty job_id (defensive)", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "real", backend_exec_session_id: "s1" }),
  ];
  const out = buildRestoreDescriptor(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual(["real"]);
});

test("buildRestoreDescriptor groups agents by backend_exec_session_id", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "a", backend_exec_session_id: "sx" }),
    fakeJob({ job_id: "b", backend_exec_session_id: "sy" }),
    fakeJob({ job_id: "c", backend_exec_session_id: "sx" }),
  ];
  const out = buildRestoreDescriptor(jobs, new Map(), 1000);
  expect(Object.keys(out.sessions).sort()).toEqual(["sx", "sy"]);
  expect(out.sessions.sx.agents.map((a) => a.job_id)).toEqual(["a", "c"]);
  expect(out.sessions.sy.agents.map((a) => a.job_id)).toEqual(["b"]);
});

test("buildRestoreDescriptor sorts agents within a session bucket by job_id", () => {
  // Insert in REVERSE order to prove the sort happens.
  const jobs: Job[] = [
    fakeJob({ job_id: "zeta", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "alpha", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "mid", backend_exec_session_id: "s1" }),
  ];
  const out = buildRestoreDescriptor(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual([
    "alpha",
    "mid",
    "zeta",
  ]);
});

test("buildRestoreDescriptor pre-resolves tier via tierForJobFromEpics for work jobs", () => {
  const jobs: Job[] = [
    fakeJob({
      job_id: "a",
      backend_exec_session_id: "s1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.2",
    }),
  ];
  const epicsById = new Map<string, Epic>([
    [
      "fn-1-foo",
      // Minimal Epic shape — only `tasks` is touched by tierForJobFromEpics.
      {
        epic_id: "fn-1-foo",
        tasks: [
          {
            task_id: "fn-1-foo.2",
            tier: "mint",
          },
        ],
      } as unknown as Epic,
    ],
  ]);
  const out = buildRestoreDescriptor(jobs, epicsById, 1000);
  expect(out.sessions.s1.agents[0].tier).toBe("mint");
});

test("buildRestoreDescriptor leaves tier null when no epicsById entry matches", () => {
  const jobs: Job[] = [
    fakeJob({
      job_id: "a",
      backend_exec_session_id: "s1",
      plan_verb: "work",
      plan_ref: "fn-1-foo.2",
    }),
  ];
  const out = buildRestoreDescriptor(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents[0].tier).toBeNull();
});

test("buildRestoreDescriptor uses title as resume_target when present", () => {
  const jobs: Job[] = [
    fakeJob({
      job_id: "sess-xyz",
      backend_exec_session_id: "s1",
      title: "work::fn-1-foo.2",
    }),
  ];
  const out = buildRestoreDescriptor(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents[0].resume_target).toBe("work::fn-1-foo.2");
});

test("buildRestoreDescriptor falls back to job_id when title is null", () => {
  const jobs: Job[] = [
    fakeJob({
      job_id: "sess-xyz",
      backend_exec_session_id: "s1",
      title: null,
    }),
  ];
  const out = buildRestoreDescriptor(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents[0].resume_target).toBe("sess-xyz");
});

test("buildRestoreDescriptor sets schema_version and captured_at on the top-level shape", () => {
  const out = buildRestoreDescriptor([], new Map(), 1234);
  expect(out.schema_version).toBe(1);
  expect(out.captured_at).toBe(1234);
  expect(out.sessions).toEqual({});
});

// ---------------------------------------------------------------------------
// serializeForHash — captured_at exclusion
// ---------------------------------------------------------------------------

test("serializeForHash strips captured_at so timestamp drift doesn't churn the hash", () => {
  const jobs: Job[] = [fakeJob({ job_id: "a", backend_exec_session_id: "s1" })];
  const epicsById = new Map<string, Epic>();
  const a = buildRestoreDescriptor(jobs, epicsById, 1000);
  const b = buildRestoreDescriptor(jobs, epicsById, 9999);
  expect(serializeForHash(a)).toBe(serializeForHash(b));
});

test("serializeForHash changes when the descriptor's content changes", () => {
  const a = buildRestoreDescriptor(
    [fakeJob({ job_id: "a", backend_exec_session_id: "s1" })],
    new Map(),
    1000,
  );
  const b = buildRestoreDescriptor(
    [fakeJob({ job_id: "b", backend_exec_session_id: "s1" })],
    new Map(),
    1000,
  );
  expect(serializeForHash(a)).not.toBe(serializeForHash(b));
});

// ---------------------------------------------------------------------------
// serializeForWrite — disk shape includes captured_at, ends with \n
// ---------------------------------------------------------------------------

test("serializeForWrite includes captured_at and ends with \\n", () => {
  const out = serializeForWrite(buildRestoreDescriptor([], new Map(), 1234));
  expect(out.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(out) as { captured_at: number };
  expect(parsed.captured_at).toBe(1234);
});

// ---------------------------------------------------------------------------
// restorePulse — write-on-change gate
// ---------------------------------------------------------------------------

test("restorePulse writes the file on first call", () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s1",
    cwd: "/tmp/x",
  });
  const state = { lastHash: null as string | null, parentDirEnsured: false };
  restorePulse(db, restorePath, state, () => 1000);
  expect(existsSync(restorePath)).toBe(true);
  const parsed = JSON.parse(readFileSync(restorePath, "utf8")) as {
    sessions: Record<string, { agents: { job_id: string }[] }>;
  };
  expect(parsed.sessions.s1.agents.map((a) => a.job_id)).toEqual(["a"]);
  expect(state.lastHash).not.toBeNull();
});

test("restorePulse skips the write when the hashed content is unchanged", () => {
  insertJob({ job_id: "a", backend_exec_session_id: "s1" });
  const state = { lastHash: null as string | null, parentDirEnsured: false };
  restorePulse(db, restorePath, state, () => 1000);
  const firstMtime = statSync(restorePath).mtimeMs;
  const firstHash = state.lastHash;

  // Re-run with a different timestamp. The disk file should NOT be rewritten
  // (the timestamp is excluded from the hash) — so the mtime is stable.
  // Wait one ms to make any rewrite visible.
  Bun.sleepSync(2);
  restorePulse(db, restorePath, state, () => 9999);
  expect(state.lastHash).toBe(firstHash);
  expect(statSync(restorePath).mtimeMs).toBe(firstMtime);
});

test("restorePulse rewrites when the descriptor genuinely changes", () => {
  insertJob({ job_id: "a", backend_exec_session_id: "s1" });
  const state = { lastHash: null as string | null, parentDirEnsured: false };
  restorePulse(db, restorePath, state, () => 1000);
  const firstHash = state.lastHash;

  // Add another live job → descriptor diverges → file MUST rewrite.
  insertJob({ job_id: "b", backend_exec_session_id: "s1" });
  restorePulse(db, restorePath, state, () => 1000);
  expect(state.lastHash).not.toBe(firstHash);

  const parsed = JSON.parse(readFileSync(restorePath, "utf8")) as {
    sessions: Record<string, { agents: { job_id: string }[] }>;
  };
  expect(parsed.sessions.s1.agents.map((a) => a.job_id)).toEqual(["a", "b"]);
});

test("restorePulse end-to-end pre-resolves tier from the epics projection", () => {
  insertJob({
    job_id: "sess-xyz",
    backend_exec_session_id: "autopilot",
    cwd: "/repo",
    title: "work::fn-1-foo.2",
    plan_verb: "work",
    plan_ref: "fn-1-foo.2",
  });
  insertEpicWithTier({
    epic_id: "fn-1-foo",
    task_id: "fn-1-foo.2",
    tier: "mint",
  });
  const state = { lastHash: null as string | null, parentDirEnsured: false };
  restorePulse(db, restorePath, state, () => 1000);
  const parsed = JSON.parse(readFileSync(restorePath, "utf8")) as {
    sessions: Record<
      string,
      {
        agents: {
          job_id: string;
          cwd: string | null;
          resume_target: string;
          tier: string | null;
          plan_verb: string | null;
          plan_ref: string | null;
        }[];
      }
    >;
  };
  expect(parsed.sessions.autopilot.agents).toEqual([
    {
      job_id: "sess-xyz",
      cwd: "/repo",
      resume_target: "work::fn-1-foo.2",
      tier: "mint",
      plan_verb: "work",
      plan_ref: "fn-1-foo.2",
    },
  ]);
});

// ---------------------------------------------------------------------------
// KEEPER_RESTORE_FILE env-var isolation
// ---------------------------------------------------------------------------

test("resolveRestorePath honors KEEPER_RESTORE_FILE so the worker writes the sandbox path", () => {
  // The beforeEach setter wires KEEPER_RESTORE_FILE → tmpDir/restore.json;
  // confirm `resolveRestorePath` honors it (the worker calls this once at
  // startup, so an override mishap would leak into the user's real file).
  expect(resolveRestorePath()).toBe(restorePath);
});

// ---------------------------------------------------------------------------
// Helpers (test-local)
// ---------------------------------------------------------------------------

/**
 * Build an in-memory `Job` for the pure descriptor builder. Only the fields
 * `buildRestoreDescriptor` reads matter; defaults track a minimal live row.
 */
function fakeJob(opts: {
  job_id: string;
  state?: string;
  cwd?: string | null;
  title?: string | null;
  plan_verb?: string | null;
  plan_ref?: string | null;
  backend_exec_session_id?: string | null;
}): Job {
  return {
    job_id: opts.job_id,
    state: opts.state ?? "working",
    cwd: opts.cwd ?? null,
    title: opts.title ?? null,
    plan_verb: opts.plan_verb ?? null,
    plan_ref: opts.plan_ref ?? null,
    backend_exec_session_id: opts.backend_exec_session_id ?? null,
  } as unknown as Job;
}
