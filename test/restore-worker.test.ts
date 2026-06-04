/**
 * Restore-snapshot worker tests (epic fn-677 task .3, two-tier rework fn-702).
 *
 * Exercise the pure `buildRestoreTier`, `serializeForHash`,
 * `serializeForWrite`, `parsePersistedRestore`/`readPersistedRestore`, and
 * `restorePulse` symbols against a fresh writer DB seeded by direct
 * `INSERT INTO jobs` / `INSERT INTO epics`. The worker's lifecycle (Worker
 * thread, watchLoop, parentPort) is NOT spawned — the `isMainThread` guard
 * keeps the plain `import` inert, the same shape every other worker test uses.
 *
 * `KEEPER_RESTORE_FILE` is set per-test so the worker code never touches the
 * user's real `~/.local/state/keeper/restore.json` (the sandboxed-base-env
 * pattern from CLAUDE.md's test-isolation rules).
 *
 * Coverage (two-tier model — epic fn-702):
 *  - `buildRestoreTier`: filters to live jobs (`working`/`stopped`), drops
 *    `ended`/`killed`, drops `backend_exec_session_id == null`, drops empty
 *    job_id; groups by session; sorts agents by job_id; pre-resolves tier via
 *    the shared helper.
 *  - `serializeForHash`: strips each tier's `captured_at`; the whole-file
 *    scope flips when `last_session` freezes even if `current` is byte-stable.
 *  - `serializeForWrite`: keeps per-tier `captured_at`, schema v2, trailing \n.
 *  - boot-promote: seeds `last_session` from the persisted FILE (v1 legacy
 *    `sessions`, v2 `current` over `last_session`, first-ever-boot null).
 *  - collapse-freeze: the `>0→0` edge freezes the high-water peak (full
 *    pre-collapse count) into `last_session`, not the last survivor; a partial
 *    collapse freezes nothing; a reseed never clobbers a populated
 *    `last_session`.
 *  - the fn-689 empty-skip floor is RETIRED: an empty live set writes an empty
 *    `current` tier.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, resolveRestorePath } from "../src/db";
import {
  buildRestoreTier,
  parsePersistedRestore,
  type RestoreDescriptor,
  type RestoreTier,
  readPersistedRestore,
  restorePulse,
  serializeForHash,
  serializeForWrite,
} from "../src/restore-worker";
import type { Epic, Job } from "../src/types";

/** Build a fresh two-tier PulseState for the pulse driver tests. */
function freshState(): {
  lastHash: string | null;
  parentDirEnsured: boolean;
  epochHighWater: RestoreTier | null;
  lastSession: RestoreTier | null;
  bootPromoted: boolean;
} {
  return {
    lastHash: null,
    parentDirEnsured: false,
    epochHighWater: null,
    lastSession: null,
    bootPromoted: false,
  };
}

/** Read + parse the two-tier file off disk for assertions. */
function readFile(path: string): RestoreDescriptor {
  return JSON.parse(readFileSync(path, "utf8")) as RestoreDescriptor;
}

/** The session-name → job_id[] view of a tier, for compact assertions. */
function tierKeys(tier: RestoreTier | null): Record<string, string[]> {
  if (tier == null) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [name, bucket] of Object.entries(tier.sessions)) {
    out[name] = bucket.agents.map((a) => a.job_id);
  }
  return out;
}

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
  const out = buildRestoreTier(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual(["live", "rest"]);
});

test("buildRestoreDescriptor omits jobs whose backend_exec_session_id is null", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "with", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "without", backend_exec_session_id: null }),
  ];
  const out = buildRestoreTier(jobs, new Map(), 1000);
  expect(Object.keys(out.sessions)).toEqual(["s1"]);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual(["with"]);
});

test("buildRestoreDescriptor omits jobs with empty job_id (defensive)", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "real", backend_exec_session_id: "s1" }),
  ];
  const out = buildRestoreTier(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual(["real"]);
});

test("buildRestoreDescriptor groups agents by backend_exec_session_id", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "a", backend_exec_session_id: "sx" }),
    fakeJob({ job_id: "b", backend_exec_session_id: "sy" }),
    fakeJob({ job_id: "c", backend_exec_session_id: "sx" }),
  ];
  const out = buildRestoreTier(jobs, new Map(), 1000);
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
  const out = buildRestoreTier(jobs, new Map(), 1000);
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
  const out = buildRestoreTier(jobs, epicsById, 1000);
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
  const out = buildRestoreTier(jobs, new Map(), 1000);
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
  const out = buildRestoreTier(jobs, new Map(), 1000);
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
  const out = buildRestoreTier(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents[0].resume_target).toBe("sess-xyz");
});

test("buildRestoreTier sets captured_at on the tier shape (empty live set)", () => {
  const out = buildRestoreTier([], new Map(), 1234);
  expect(out.captured_at).toBe(1234);
  expect(out.sessions).toEqual({});
});

/** Wrap a `current` tier into a full two-tier descriptor for serialize tests. */
function descFor(
  current: RestoreTier,
  last: RestoreTier | null = null,
): RestoreDescriptor {
  return { schema_version: 2, last_session: last, current };
}

// ---------------------------------------------------------------------------
// serializeForHash — per-tier captured_at exclusion, whole-file scope
// ---------------------------------------------------------------------------

test("serializeForHash strips captured_at so timestamp drift doesn't churn the hash", () => {
  const jobs: Job[] = [fakeJob({ job_id: "a", backend_exec_session_id: "s1" })];
  const epicsById = new Map<string, Epic>();
  const a = descFor(buildRestoreTier(jobs, epicsById, 1000));
  const b = descFor(buildRestoreTier(jobs, epicsById, 9999));
  expect(serializeForHash(a)).toBe(serializeForHash(b));
});

test("serializeForHash changes when the current tier's content changes", () => {
  const a = descFor(
    buildRestoreTier(
      [fakeJob({ job_id: "a", backend_exec_session_id: "s1" })],
      new Map(),
      1000,
    ),
  );
  const b = descFor(
    buildRestoreTier(
      [fakeJob({ job_id: "b", backend_exec_session_id: "s1" })],
      new Map(),
      1000,
    ),
  );
  expect(serializeForHash(a)).not.toBe(serializeForHash(b));
});

test("serializeForHash changes when last_session flips even if current is byte-stable", () => {
  // The collapse-freeze edge: current goes empty but last_session gets the
  // frozen peak — the whole-file hash MUST change so the write fires.
  const current = buildRestoreTier([], new Map(), 1000);
  const frozen = buildRestoreTier(
    [fakeJob({ job_id: "a", backend_exec_session_id: "s1" })],
    new Map(),
    500,
  );
  const before = descFor(current, null);
  const after = descFor(current, frozen);
  expect(serializeForHash(after)).not.toBe(serializeForHash(before));
});

// ---------------------------------------------------------------------------
// serializeForWrite — disk shape keeps per-tier captured_at, ends with \n
// ---------------------------------------------------------------------------

test("serializeForWrite keeps per-tier captured_at, schema v2, ends with \\n", () => {
  const out = serializeForWrite(descFor(buildRestoreTier([], new Map(), 1234)));
  expect(out.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(out) as {
    schema_version: number;
    current: { captured_at: number };
    last_session: unknown;
  };
  expect(parsed.schema_version).toBe(2);
  expect(parsed.current.captured_at).toBe(1234);
  expect(parsed.last_session).toBeNull();
});

// ---------------------------------------------------------------------------
// restorePulse — write-on-change gate
// ---------------------------------------------------------------------------

test("restorePulse writes the two-tier file on first call", () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s1",
    cwd: "/tmp/x",
  });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  expect(existsSync(restorePath)).toBe(true);
  const parsed = readFile(restorePath);
  expect(parsed.schema_version).toBe(2);
  expect(tierKeys(parsed.current)).toEqual({ s1: ["a"] });
  // No collapse edge yet, no persisted file → last_session stays null.
  expect(parsed.last_session).toBeNull();
  expect(state.lastHash).not.toBeNull();
});

test("restorePulse skips the write when the hashed content is unchanged", () => {
  insertJob({ job_id: "a", backend_exec_session_id: "s1" });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  const firstMtime = statSync(restorePath).mtimeMs;
  const firstHash = state.lastHash;

  // Re-run with a different timestamp. The disk file should NOT be rewritten
  // (the timestamps are excluded from the hash) — so the mtime is stable.
  Bun.sleepSync(2);
  restorePulse(db, restorePath, state, () => 9999);
  expect(state.lastHash).toBe(firstHash);
  expect(statSync(restorePath).mtimeMs).toBe(firstMtime);
});

test("restorePulse retires the empty-skip floor: current mirrors empty, writes an empty current tier", () => {
  // Populated pulse writes the file (current=[a]).
  insertJob({ job_id: "a", backend_exec_session_id: "s1" });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  expect(tierKeys(readFile(restorePath).current)).toEqual({ s1: ["a"] });

  // Drain the live set → current mirrors empty AND last_session freezes the
  // high-water (the >0→0 collapse edge). The file IS rewritten now (floor
  // retired) — current is empty, last_session carries the frozen peak.
  db.run("UPDATE jobs SET state='ended' WHERE job_id='a'");
  restorePulse(db, restorePath, state, () => 9999);

  const parsed = readFile(restorePath);
  expect(tierKeys(parsed.current)).toEqual({});
  expect(tierKeys(parsed.last_session)).toEqual({ s1: ["a"] });
});

// ---------------------------------------------------------------------------
// Boot-promote — seed last_session from the persisted FILE, not the projection
// ---------------------------------------------------------------------------

test("boot-promote from a populated v1 file lifts legacy top-level sessions into last_session", () => {
  // A pre-fn-702 v1 file frozen under last-non-empty-wins: top-level sessions.
  const v1 = {
    schema_version: 1,
    captured_at: 500,
    sessions: { s1: { agents: [legacyAgent("a"), legacyAgent("b")] } },
  };
  writeFileSync(restorePath, JSON.stringify(v1), "utf8");

  // Boot: seedKilledSweep emptied the live set; the worker reads the FILE.
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);

  const parsed = readFile(restorePath);
  // The legacy sessions become the frozen last_session restore source.
  expect(tierKeys(parsed.last_session)).toEqual({ s1: ["a", "b"] });
  // current mirrors the (empty) live set.
  expect(tierKeys(parsed.current)).toEqual({});
});

test("boot-promote from a populated v2 file lifts current into last_session", () => {
  // A v2 file written just before the reboot: current populated, no collapse.
  const v2 = {
    schema_version: 2,
    last_session: null,
    current: {
      captured_at: 500,
      sessions: { s1: { agents: [legacyAgent("a")] } },
    },
  };
  writeFileSync(restorePath, JSON.stringify(v2), "utf8");

  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);

  // current (the live mirror at the last write) is the restore source.
  expect(tierKeys(readFile(restorePath).last_session)).toEqual({ s1: ["a"] });
});

test("boot-promote prefers current over a populated last_session", () => {
  // Both tiers populated. current (newer live mirror) wins.
  const v2 = {
    schema_version: 2,
    last_session: {
      captured_at: 100,
      sessions: { sx: { agents: [legacyAgent("stale")] } },
    },
    current: {
      captured_at: 500,
      sessions: { sy: { agents: [legacyAgent("fresh")] } },
    },
  };
  writeFileSync(restorePath, JSON.stringify(v2), "utf8");

  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);

  expect(tierKeys(readFile(restorePath).last_session)).toEqual({
    sy: ["fresh"],
  });
});

test("boot-promote keeps last_session when persisted current is empty", () => {
  // current empty (e.g. the prior boot drained), last_session frozen.
  const v2 = {
    schema_version: 2,
    last_session: {
      captured_at: 100,
      sessions: { sx: { agents: [legacyAgent("frozen")] } },
    },
    current: { captured_at: 500, sessions: {} },
  };
  writeFileSync(restorePath, JSON.stringify(v2), "utf8");

  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);

  expect(tierKeys(readFile(restorePath).last_session)).toEqual({
    sx: ["frozen"],
  });
});

test("boot-promote on first-ever boot (no file) degrades to a null last_session", () => {
  // No prior file. First pulse with an empty live set: current empty,
  // last_session null, but a file IS still written (floor retired).
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  const parsed = readFile(restorePath);
  expect(parsed.last_session).toBeNull();
  expect(tierKeys(parsed.current)).toEqual({});
});

test("boot-promote reboot incident: 8 reseeds to 2, last_session offers the full 8", () => {
  // Pre-crash file captured 8 agents (under v2 current).
  const eight: Record<string, { agents: { job_id: string }[] }> = {
    s1: {
      agents: Array.from({ length: 8 }, (_, i) => legacyAgent(`j${i}`)),
    },
  };
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 2,
      last_session: null,
      current: { captured_at: 500, sessions: eight },
    }),
    "utf8",
  );

  // Reboot reseeds only 2 live agents.
  insertJob({ job_id: "r1", backend_exec_session_id: "s1" });
  insertJob({ job_id: "r2", backend_exec_session_id: "s1" });

  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);

  const parsed = readFile(restorePath);
  // last_session offers the full pre-crash 8.
  expect(parsed.last_session?.sessions.s1.agents).toHaveLength(8);
  // current is the reseeded 2.
  expect(tierKeys(parsed.current)).toEqual({ s1: ["r1", "r2"] });
});

// ---------------------------------------------------------------------------
// Collapse-freeze — high-water capture across multi-pulse staggered death
// ---------------------------------------------------------------------------

test("collapse-freeze across staggered death freezes the high-water 8, not the last survivor", () => {
  // Seed 8 live agents.
  for (let i = 0; i < 8; i++) {
    insertJob({ job_id: `j${i}`, backend_exec_session_id: "s1" });
  }
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  expect(state.epochHighWater?.sessions.s1.agents).toHaveLength(8);

  // Staggered death across pulses: 8 → 5 → 1 → 0. Each non-zero pulse keeps
  // the high-water peak; ONLY the >0→0 edge freezes.
  db.run("UPDATE jobs SET state='ended' WHERE job_id IN ('j5','j6','j7')");
  restorePulse(db, restorePath, state, () => 2000);
  expect(tierKeys(readFile(restorePath).current).s1).toHaveLength(5);

  db.run("UPDATE jobs SET state='ended' WHERE job_id IN ('j1','j2','j3','j4')");
  restorePulse(db, restorePath, state, () => 3000);
  expect(tierKeys(readFile(restorePath).current).s1).toHaveLength(1);

  db.run("UPDATE jobs SET state='ended' WHERE job_id='j0'");
  restorePulse(db, restorePath, state, () => 4000);

  const parsed = readFile(restorePath);
  expect(tierKeys(parsed.current)).toEqual({});
  // The frozen last_session is the high-water 8, NOT the last survivor j0.
  expect(parsed.last_session?.sessions.s1.agents).toHaveLength(8);
  // The epoch resets after a successful freeze.
  expect(state.epochHighWater).toBeNull();
});

test("partial collapse (8 → 2, never 0) freezes nothing", () => {
  for (let i = 0; i < 8; i++) {
    insertJob({ job_id: `j${i}`, backend_exec_session_id: "s1" });
  }
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);

  // Shrink to 2 survivors but never reach 0 — no >0→0 edge, no freeze.
  db.run(
    "UPDATE jobs SET state='ended' WHERE job_id IN ('j2','j3','j4','j5','j6','j7')",
  );
  restorePulse(db, restorePath, state, () => 2000);

  const parsed = readFile(restorePath);
  expect(tierKeys(parsed.current).s1).toHaveLength(2);
  // No freeze happened — last_session stays null (no prior file / boot-promote).
  expect(parsed.last_session).toBeNull();
  // The high-water peak survives, ready for the next boot-promote to capture.
  expect(state.epochHighWater?.sessions.s1.agents).toHaveLength(8);
});

test("reseed does not clobber a populated last_session (last=8, current=2)", () => {
  // Boot-promote seeds last_session=8 from the pre-crash file.
  const eight: Record<string, { agents: { job_id: string }[] }> = {
    s1: { agents: Array.from({ length: 8 }, (_, i) => legacyAgent(`j${i}`)) },
  };
  writeFileSync(
    restorePath,
    JSON.stringify({
      schema_version: 2,
      last_session: null,
      current: { captured_at: 500, sessions: eight },
    }),
    "utf8",
  );
  insertJob({ job_id: "r1", backend_exec_session_id: "s1" });
  insertJob({ job_id: "r2", backend_exec_session_id: "s1" });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  expect(readFile(restorePath).last_session?.sessions.s1.agents).toHaveLength(
    8,
  );

  // Another live job reseeds current; a smaller current must NOT clobber the
  // frozen 8 (last_session is written only at boot-promote / collapse).
  db.run("UPDATE jobs SET state='ended' WHERE job_id='r2'");
  restorePulse(db, restorePath, state, () => 2000);

  const parsed = readFile(restorePath);
  expect(tierKeys(parsed.current)).toEqual({ s1: ["r1"] });
  // last_session=8 is preserved across the reseed.
  expect(parsed.last_session?.sessions.s1.agents).toHaveLength(8);
});

test("restorePulse rewrites when the current tier genuinely changes", () => {
  insertJob({ job_id: "a", backend_exec_session_id: "s1" });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  const firstHash = state.lastHash;

  // Add another live job → current diverges → file MUST rewrite.
  insertJob({ job_id: "b", backend_exec_session_id: "s1" });
  restorePulse(db, restorePath, state, () => 1000);
  expect(state.lastHash).not.toBe(firstHash);
  expect(tierKeys(readFile(restorePath).current)).toEqual({ s1: ["a", "b"] });
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
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  const parsed = readFile(restorePath);
  expect(parsed.current?.sessions.autopilot.agents).toEqual([
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
// parsePersistedRestore / readPersistedRestore — safe boot-disk read
// ---------------------------------------------------------------------------

test("parsePersistedRestore coerces garbage to all-null tiers", () => {
  expect(parsePersistedRestore("not json")).toEqual({
    last_session: null,
    current: null,
    legacy: null,
  });
  expect(parsePersistedRestore("42")).toEqual({
    last_session: null,
    current: null,
    legacy: null,
  });
  expect(parsePersistedRestore("[]")).toEqual({
    last_session: null,
    current: null,
    legacy: null,
  });
});

test("parsePersistedRestore reads v2 tiers and a v1 legacy sessions block", () => {
  const v2 = parsePersistedRestore(
    JSON.stringify({
      schema_version: 2,
      last_session: { captured_at: 1, sessions: { a: { agents: [] } } },
      current: { captured_at: 2, sessions: { b: { agents: [] } } },
    }),
  );
  expect(Object.keys(v2.last_session?.sessions ?? {})).toEqual(["a"]);
  expect(Object.keys(v2.current?.sessions ?? {})).toEqual(["b"]);
  expect(v2.legacy).toBeNull();

  const v1 = parsePersistedRestore(
    JSON.stringify({
      schema_version: 1,
      captured_at: 9,
      sessions: { z: { agents: [] } },
    }),
  );
  expect(Object.keys(v1.legacy?.sessions ?? {})).toEqual(["z"]);
  expect(v1.legacy?.captured_at).toBe(9);
  expect(v1.last_session).toBeNull();
  expect(v1.current).toBeNull();
});

test("readPersistedRestore returns all-null on a missing file", () => {
  expect(readPersistedRestore(join(tmpDir, "nope.json"))).toEqual({
    last_session: null,
    current: null,
    legacy: null,
  });
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
 * Build an in-memory `Job` for the pure tier builder. Only the fields
 * `buildRestoreTier` reads matter; defaults track a minimal live row.
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

/**
 * An on-disk agent record (the shape the worker serializes), for hand-built
 * persisted-file fixtures in the boot-promote / reseed tests. Only `job_id`
 * is asserted on; the other fields carry minimal placeholders.
 */
function legacyAgent(job_id: string): {
  job_id: string;
  cwd: string | null;
  resume_target: string;
  tier: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
} {
  return {
    job_id,
    cwd: null,
    resume_target: job_id,
    tier: null,
    plan_verb: null,
    plan_ref: null,
  };
}
