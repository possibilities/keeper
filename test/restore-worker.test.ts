/**
 * Restore-snapshot worker tests (epic fn-677 task .3; single-tier reshape
 * fn-817 T4).
 *
 * Exercise the pure `buildRestoreTier`, `serializeForHash`,
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
 * Coverage (single-tier dumb-current-mirror model — epic fn-817):
 *  - `buildRestoreTier`: filters to live jobs (`working`/`stopped`), drops
 *    `ended`/`killed`, drops `backend_exec_session_id == null`, drops empty
 *    job_id; groups by session; sorts agents by job_id; stamps `resume_target`
 *    as the latest name (job_id fallback); pre-resolves tier via the shared helper.
 *  - `serializeForHash`: strips `current.captured_at`; an index change rewrites.
 *  - `serializeForWrite`: keeps `captured_at`, schema v3, trailing \n, no
 *    `last_session` field.
 *  - `restorePulse`: write-on-change gate; the live set mirrors empty without a
 *    frozen `last_session` (the freeze machinery is GONE); window_index capture;
 *    tmux pane-snapshot + window-index posts.
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
import { resolveRestorePath } from "../src/db";
import {
  type BackendExecStartMessage,
  buildRestoreTier,
  probeServerGeneration,
  probeTmuxPanes,
  RESTORE_SCHEMA_VERSION,
  type RestoreDescriptor,
  type RestoreTier,
  restorePulse,
  type SpawnSyncFn,
  seedLastGenerationHash,
  serializeForHash,
  serializeForWrite,
  type TmuxPaneSnapshotMessage,
  type WindowIndexSnapshotMessage,
} from "../src/restore-worker";
import type { Epic, Job } from "../src/types";
import { freshMemDb } from "./helpers/template-db";

/** Build a fresh single-tier PulseState for the pulse driver tests. */
function freshState(): {
  lastHash: string | null;
  parentDirEnsured: boolean;
  lastSnapshotHash: string | null;
  lastWindowIndexByJobId: Map<string, number>;
  lastWindowIndexHash: string | null;
  lastGenerationHash: string | null;
} {
  return {
    lastHash: null,
    parentDirEnsured: false,
    lastSnapshotHash: null,
    lastWindowIndexByJobId: new Map(),
    lastWindowIndexHash: null,
    lastGenerationHash: null,
  };
}

/** A `SpawnSyncFn` that returns the given tab-delimited
 *  `#{pane_id}\t#{window_index}\t#{session_name}` lines as a successful
 *  `tmux list-panes` capture. */
function stubTmuxPanes(lines: string[]): SpawnSyncFn {
  return () => ({
    success: true,
    exitCode: 0,
    stdout: Buffer.from(lines.join("\n")),
  });
}

/**
 * A `SpawnSyncFn` that dispatches on the tmux subcommand: a `display-message`
 * probe (the server-pid generation handle) returns `pid`; a `list-panes` probe
 * returns the given pane lines. One stub feeds BOTH consumers the pulse drives
 * off a single injected `spawnSync`. A `null` `pid` makes the display-message
 * probe a failed (no-server) capture.
 */
function stubTmux(opts: { pid: string | null; panes?: string[] }): SpawnSyncFn {
  return (cmd: string[]) => {
    if (cmd.includes("display-message")) {
      if (opts.pid == null) {
        return { success: false, exitCode: 1, stdout: Buffer.from("") };
      }
      return { success: true, exitCode: 0, stdout: Buffer.from(opts.pid) };
    }
    return {
      success: true,
      exitCode: 0,
      stdout: Buffer.from((opts.panes ?? []).join("\n")),
    };
  };
}

/** Insert one `BackendExecStart` event carrying `generation_id` so the boot-seed
 *  reads it as the last logged generation. */
function insertBackendExecStart(generationId: string): void {
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, ?, ?, ?)`,
    [
      1000,
      "backend-exec-start",
      "BackendExecStart",
      "backend_exec_start",
      JSON.stringify({ backend_type: "tmux", generation_id: generationId }),
    ],
  );
}

/** Read + parse the single-tier file off disk for assertions. */
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
let restorePath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-restore-worker-test-"));
  restorePath = join(tmpDir, "restore.json");
  process.env.KEEPER_RESTORE_FILE = restorePath;
  // fn-769 mem variant: this suite holds a single in-process connection (no
  // second opener, no spawned Worker), so an in-memory clone of the migrated
  // template is correct and skips the per-test migration ladder.
  db = freshMemDb().db;
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
  backend_exec_type?: string | null;
  backend_exec_session_id?: string | null;
  backend_exec_pane_id?: string | null;
  created_at?: number;
}): void {
  const state = opts.state ?? "working";
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at,
       cwd, title, plan_verb, plan_ref,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id
     ) VALUES (?, ?, ?, 0, 1000, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.job_id,
      opts.created_at ?? 1000,
      state,
      opts.cwd ?? null,
      opts.title ?? null,
      opts.plan_verb ?? null,
      opts.plan_ref ?? null,
      opts.backend_exec_type ?? null,
      opts.backend_exec_session_id ?? null,
      opts.backend_exec_pane_id ?? null,
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
// buildRestoreTier — filtering + grouping
// ---------------------------------------------------------------------------

test("buildRestoreTier surfaces only working/stopped jobs", () => {
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

test("buildRestoreTier omits jobs whose backend_exec_session_id is null", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "with", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "without", backend_exec_session_id: null }),
  ];
  const out = buildRestoreTier(jobs, new Map(), 1000);
  expect(Object.keys(out.sessions)).toEqual(["s1"]);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual(["with"]);
});

test("buildRestoreTier omits jobs with empty job_id (defensive)", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "real", backend_exec_session_id: "s1" }),
  ];
  const out = buildRestoreTier(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents.map((a) => a.job_id)).toEqual(["real"]);
});

test("buildRestoreTier groups agents by backend_exec_session_id", () => {
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

test("buildRestoreTier stamps each bucket's backend from backend_exec_type (v3)", () => {
  const jobs: Job[] = [
    fakeJob({
      job_id: "t",
      backend_exec_session_id: "tsess",
      backend_exec_type: "tmux",
    }),
    fakeJob({
      job_id: "x",
      backend_exec_session_id: "xsess",
      backend_exec_type: "other",
    }),
  ];
  const out = buildRestoreTier(jobs, new Map(), 1000);
  // The tag is copied verbatim — the producer stamps whatever the row carries.
  expect(out.sessions.tsess.backend).toBe("tmux");
  expect(out.sessions.xsess.backend).toBe("other");
});

test("buildRestoreTier defaults a NULL backend_exec_type bucket to tmux", () => {
  const jobs: Job[] = [
    fakeJob({
      job_id: "a",
      backend_exec_session_id: "s1",
      backend_exec_type: null,
    }),
  ];
  const out = buildRestoreTier(jobs, new Map(), 1000);
  expect(out.sessions.s1.backend).toBe("tmux");
});

test("buildRestoreTier throws when a session bucket mixes backends", () => {
  const jobs: Job[] = [
    fakeJob({
      job_id: "a",
      backend_exec_session_id: "s1",
      backend_exec_type: "tmux",
    }),
    fakeJob({
      job_id: "b",
      backend_exec_session_id: "s1",
      backend_exec_type: "other",
    }),
  ];
  expect(() => buildRestoreTier(jobs, new Map(), 1000)).toThrow(
    /mixes exec backends/,
  );
});

test("buildRestoreTier sorts agents within a session bucket by job_id", () => {
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

test("buildRestoreTier pre-resolves tier via tierForJobFromEpics for work jobs", () => {
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

test("buildRestoreTier leaves tier null when no epicsById entry matches", () => {
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

test("buildRestoreTier stamps resume_target as the latest name, falling back to job_id", () => {
  // The resume key is the latest session name (the title) — read live from the
  // jobs projection, so a renamed session restores to its current name; a
  // never-named job falls back to its job_id.
  const named: Job[] = [
    fakeJob({
      job_id: "sess-xyz",
      backend_exec_session_id: "s1",
      title: "work::fn-1-foo.2",
    }),
  ];
  expect(
    buildRestoreTier(named, new Map(), 1000).sessions.s1.agents[0]
      .resume_target,
  ).toBe("work::fn-1-foo.2");

  const unnamed: Job[] = [
    fakeJob({ job_id: "sess-abc", backend_exec_session_id: "s1", title: null }),
  ];
  expect(
    buildRestoreTier(unnamed, new Map(), 1000).sessions.s1.agents[0]
      .resume_target,
  ).toBe("sess-abc");
});

test("buildRestoreTier sets captured_at on the tier shape (empty live set)", () => {
  const out = buildRestoreTier([], new Map(), 1234);
  expect(out.captured_at).toBe(1234);
  expect(out.sessions).toEqual({});
});

test("buildRestoreTier stamps window_index from the cache and created_at from the job", () => {
  const jobs: Job[] = [
    fakeJob({ job_id: "a", backend_exec_session_id: "s1", created_at: 7 }),
    fakeJob({ job_id: "b", backend_exec_session_id: "s1", created_at: 9 }),
  ];
  const cache = new Map<string, number>([
    ["a", 2],
    ["b", 0],
  ]);
  const out = buildRestoreTier(jobs, new Map(), 1000, cache);
  const byId = new Map(out.sessions.s1.agents.map((x) => [x.job_id, x]));
  expect(byId.get("a")?.window_index).toBe(2);
  expect(byId.get("a")?.created_at).toBe(7);
  expect(byId.get("b")?.window_index).toBe(0);
  expect(byId.get("b")?.created_at).toBe(9);
});

test("buildRestoreTier stamps window_index null on a cache miss (pane gone)", () => {
  const jobs: Job[] = [fakeJob({ job_id: "a", backend_exec_session_id: "s1" })];
  // Empty cache → no entry for "a".
  const out = buildRestoreTier(jobs, new Map(), 1000, new Map());
  expect(out.sessions.s1.agents[0].window_index).toBeNull();
});

test("buildRestoreTier defaults to an empty cache (4th param omitted)", () => {
  const jobs: Job[] = [fakeJob({ job_id: "a", backend_exec_session_id: "s1" })];
  const out = buildRestoreTier(jobs, new Map(), 1000);
  expect(out.sessions.s1.agents[0].window_index).toBeNull();
});

test("buildRestoreTier keeps the on-disk job_id sort regardless of window_index", () => {
  // Insert in reverse job_id order with window indices that do NOT match the
  // job_id sort — the on-disk array must still be job_id-sorted (visual order
  // is a restore-time concern, not the file's).
  const jobs: Job[] = [
    fakeJob({ job_id: "zeta", backend_exec_session_id: "s1" }),
    fakeJob({ job_id: "alpha", backend_exec_session_id: "s1" }),
  ];
  const cache = new Map<string, number>([
    ["zeta", 0],
    ["alpha", 1],
  ]);
  const out = buildRestoreTier(jobs, new Map(), 1000, cache);
  expect(out.sessions.s1.agents.map((x) => x.job_id)).toEqual([
    "alpha",
    "zeta",
  ]);
});

/** Wrap a `current` tier into a full single-tier descriptor for serialize tests. */
function descFor(current: RestoreTier): RestoreDescriptor {
  return {
    schema_version: RESTORE_SCHEMA_VERSION,
    current,
  };
}

// ---------------------------------------------------------------------------
// serializeForHash — captured_at exclusion
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

test("serializeForHash includes window_index (an index change rewrites the file)", () => {
  const base = descFor(
    buildRestoreTier(
      [fakeJob({ job_id: "j1", backend_exec_session_id: "work" })],
      new Map(),
      1000,
      new Map([["j1", 0]]),
    ),
  );
  const moved = descFor(
    buildRestoreTier(
      [fakeJob({ job_id: "j1", backend_exec_session_id: "work" })],
      new Map(),
      1000,
      new Map([["j1", 5]]),
    ),
  );
  // A pure window reorder (0 → 5) must change the file hash so the worker
  // rewrites restore.json with the new visual order.
  expect(serializeForHash(base)).not.toBe(serializeForHash(moved));
});

// ---------------------------------------------------------------------------
// serializeForWrite — disk shape keeps captured_at, schema v3, no last_session
// ---------------------------------------------------------------------------

test("serializeForWrite keeps captured_at, schema v3, ends with \\n, no last_session field", () => {
  const out = serializeForWrite(descFor(buildRestoreTier([], new Map(), 1234)));
  expect(out.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(out) as {
    schema_version: number;
    current: { captured_at: number };
  };
  expect(parsed.schema_version).toBe(RESTORE_SCHEMA_VERSION);
  expect(parsed.current.captured_at).toBe(1234);
  // The single-tier reshape dropped the top-level last_session field.
  expect("last_session" in parsed).toBe(false);
});

// ---------------------------------------------------------------------------
// restorePulse — write-on-change gate, dumb current mirror (no freeze)
// ---------------------------------------------------------------------------

test("restorePulse writes the single-tier file on first call", () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s1",
    cwd: "/tmp/x",
  });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  expect(existsSync(restorePath)).toBe(true);
  const parsed = readFile(restorePath);
  expect(parsed.schema_version).toBe(RESTORE_SCHEMA_VERSION);
  expect(tierKeys(parsed.current)).toEqual({ s1: ["a"] });
  // No frozen last_session field exists in the single-tier reshape.
  expect("last_session" in parsed).toBe(false);
  expect(state.lastHash).not.toBeNull();
});

test("restorePulse skips the write when the hashed content is unchanged", () => {
  insertJob({ job_id: "a", backend_exec_session_id: "s1" });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  const firstMtime = statSync(restorePath).mtimeMs;
  const firstHash = state.lastHash;

  // Re-run with a different timestamp. The disk file should NOT be rewritten
  // (the timestamp is excluded from the hash) — so the mtime is stable.
  Bun.sleepSync(2);
  restorePulse(db, restorePath, state, () => 9999);
  expect(state.lastHash).toBe(firstHash);
  expect(statSync(restorePath).mtimeMs).toBe(firstMtime);
});

test("restorePulse mirrors an emptied live set to an empty current tier (no freeze)", () => {
  // Populated pulse writes the file (current=[a]).
  insertJob({ job_id: "a", backend_exec_session_id: "s1" });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  expect(tierKeys(readFile(restorePath).current)).toEqual({ s1: ["a"] });

  // Drain the live set → current mirrors empty. There is NO frozen last_session
  // anymore — the file is just rewritten with an empty current tier.
  db.run("UPDATE jobs SET state='ended' WHERE job_id='a'");
  restorePulse(db, restorePath, state, () => 9999);

  const parsed = readFile(restorePath);
  expect(tierKeys(parsed.current)).toEqual({});
  expect("last_session" in parsed).toBe(false);
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

test("restorePulse on a first-ever empty boot writes an empty current tier", () => {
  // No prior file, empty live set. A file IS still written (no empty-skip
  // floor), and there is no last_session field.
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000);
  const parsed = readFile(restorePath);
  expect(tierKeys(parsed.current)).toEqual({});
  expect("last_session" in parsed).toBe(false);
});

test("restorePulse end-to-end pre-resolves tier and stamps the latest-name resume_target", () => {
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
      // resume_target is the latest name (the title), read live from the jobs row.
      resume_target: "work::fn-1-foo.2",
      tier: "mint",
      plan_verb: "work",
      plan_ref: "fn-1-foo.2",
      // No probe wired (pure-pulse path) and no pane id → unknown order.
      window_index: null,
      created_at: 1000,
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
  backend_exec_type?: string | null;
  backend_exec_session_id?: string | null;
  backend_exec_pane_id?: string | null;
  created_at?: number;
}): Job {
  return {
    job_id: opts.job_id,
    created_at: opts.created_at ?? 1000,
    state: opts.state ?? "working",
    cwd: opts.cwd ?? null,
    title: opts.title ?? null,
    plan_verb: opts.plan_verb ?? null,
    plan_ref: opts.plan_ref ?? null,
    backend_exec_type: opts.backend_exec_type ?? null,
    backend_exec_session_id: opts.backend_exec_session_id ?? null,
    backend_exec_pane_id: opts.backend_exec_pane_id ?? null,
  } as unknown as Job;
}

// ---------------------------------------------------------------------------
// probeTmuxPanes — parse + degrade
// ---------------------------------------------------------------------------

test("probeTmuxPanes parses tab-delimited pane/index/session rows", () => {
  const pairs = probeTmuxPanes(
    stubTmuxPanes(["%1\t0\twork", "%2\t1\tplay", "%3\t2\twork"]),
  );
  expect(pairs).toEqual([
    { pane_id: "%1", session_name: "work", window_index: 0 },
    { pane_id: "%2", session_name: "play", window_index: 1 },
    { pane_id: "%3", session_name: "work", window_index: 2 },
  ]);
});

test("probeTmuxPanes keeps session names containing spaces and tabs (name last)", () => {
  // The session name is the variable-length field LAST, so an embedded space
  // (or tab) cannot bleed into the numeric window_index.
  const pairs = probeTmuxPanes(stubTmuxPanes(["%1\t3\tmy session name"]));
  expect(pairs).toEqual([
    { pane_id: "%1", session_name: "my session name", window_index: 3 },
  ]);
});

test("probeTmuxPanes drops malformed lines (missing tab / empty pane / empty session)", () => {
  const pairs = probeTmuxPanes(
    stubTmuxPanes([
      "%1\t0\tok",
      "garbage-no-tab",
      "%2\tonlyonetab",
      "\t0\tonlysession",
      "%4\t0\t",
      "",
    ]),
  );
  expect(pairs).toEqual([
    { pane_id: "%1", session_name: "ok", window_index: 0 },
  ]);
});

test("probeTmuxPanes coerces a non-numeric / empty window_index to null (pair kept)", () => {
  const pairs = probeTmuxPanes(
    stubTmuxPanes(["%1\tNaN\twork", "%2\t\tplay", "%3\t1.5\tmid"]),
  );
  // A bad index leaves the pair intact with window_index null (the agent sinks
  // to the tail at restore time rather than being dropped); a non-integer
  // (1.5) is also rejected — window indices are integers.
  expect(pairs).toEqual([
    { pane_id: "%1", session_name: "work", window_index: null },
    { pane_id: "%2", session_name: "play", window_index: null },
    { pane_id: "%3", session_name: "mid", window_index: null },
  ]);
});

test("probeTmuxPanes is invoked with a locale-defaulted env (TAB-faithful)", () => {
  // The default spawn wraps env in localeDefaultedEnv so a C-locale TAB mangle
  // can't drop every row; the injected spawn here just records that the probe
  // ran and parsed a 3-field row end to end.
  let calls = 0;
  const pairs = probeTmuxPanes((cmd) => {
    calls += 1;
    expect(cmd).toContain("#{pane_id}\t#{window_index}\t#{session_name}");
    return {
      success: true,
      exitCode: 0,
      stdout: Buffer.from("%1\t4\twork"),
    };
  });
  expect(calls).toBe(1);
  expect(pairs).toEqual([
    { pane_id: "%1", session_name: "work", window_index: 4 },
  ]);
});

test("probeTmuxPanes degrades to [] on a thrown spawn (ENOENT — no tmux binary)", () => {
  const pairs = probeTmuxPanes(() => {
    throw new Error("ENOENT");
  });
  expect(pairs).toEqual([]);
});

test("probeTmuxPanes degrades to [] on a non-zero exit (no server)", () => {
  const pairs = probeTmuxPanes(() => ({
    success: false,
    exitCode: 1,
    stdout: Buffer.from(""),
  }));
  expect(pairs).toEqual([]);
});

// ---------------------------------------------------------------------------
// restorePulse — tmux pane-snapshot poll arm (gate / fill / dedup)
// ---------------------------------------------------------------------------

test("restorePulse posts a tmux-pane-snapshot when a live tmux job has a NULL session", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: null,
  });
  const posts: TmuxPaneSnapshotMessage[] = [];
  restorePulse(db, restorePath, freshState(), () => 1000, {
    spawnSync: stubTmuxPanes(["%1\t0\twork", "%9\t1\tother"]),
    post: (m) => posts.push(m),
  });
  expect(posts).toHaveLength(1);
  // Only the pane matching the NULL-session live job is posted (fillable filter).
  expect(posts[0].pairs).toEqual([
    { pane_id: "%1", session_name: "work", window_index: 0 },
  ]);
});

test("restorePulse poll arm is quiescent when NO live tmux job exists", () => {
  // Only a non-tmux NULL-session job — the wider gate (any live tmux job) is
  // false, so nothing spawns.
  insertJob({
    job_id: "non-tmux",
    backend_exec_type: "other",
    backend_exec_pane_id: "%2",
    backend_exec_session_id: null,
  });
  let spawned = false;
  const posts: TmuxPaneSnapshotMessage[] = [];
  restorePulse(db, restorePath, freshState(), () => 1000, {
    spawnSync: () => {
      spawned = true;
      return { success: true, exitCode: 0, stdout: Buffer.from("%1\t0\twork") };
    },
    post: (m) => posts.push(m),
  });
  expect(spawned).toBe(false); // gate false → no probe spawn
  expect(posts).toHaveLength(0);
});

test("restorePulse mints nothing when no probed pair would fill a NULL-session job", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: null,
  });
  const posts: TmuxPaneSnapshotMessage[] = [];
  // The server only shows panes keeper never tracked — nothing fills %1.
  restorePulse(db, restorePath, freshState(), () => 1000, {
    spawnSync: stubTmuxPanes(["%7\t0\tghost", "%8\t1\tphantom"]),
    post: (m) => posts.push(m),
  });
  expect(posts).toHaveLength(0);
});

test("restorePulse dedups: an unchanged topology does not re-post across pulses", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: null,
  });
  const posts: TmuxPaneSnapshotMessage[] = [];
  const state = freshState();
  const snapshot = {
    spawnSync: stubTmuxPanes(["%1\t0\twork"]),
    post: (m: TmuxPaneSnapshotMessage) => posts.push(m),
  };
  restorePulse(db, restorePath, state, () => 1000, snapshot);
  restorePulse(db, restorePath, state, () => 2000, snapshot);
  restorePulse(db, restorePath, state, () => 3000, snapshot);
  // The job stays NULL in this DB (no reducer here to fill it), so the gate
  // stays armed every pulse — but the dedup hash suppresses the repeat posts.
  expect(posts).toHaveLength(1);
});

test("restorePulse re-posts when the resolvable topology changes", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: null,
  });
  const posts: TmuxPaneSnapshotMessage[] = [];
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmuxPanes(["%1\t0\twork"]),
    post: (m) => posts.push(m),
  });
  // The pane moved to a different session — a genuine topology change.
  restorePulse(db, restorePath, state, () => 2000, {
    spawnSync: stubTmuxPanes(["%1\t0\tmoved"]),
    post: (m) => posts.push(m),
  });
  expect(posts).toHaveLength(2);
  expect(posts[1].pairs).toEqual([
    { pane_id: "%1", session_name: "moved", window_index: 0 },
  ]);
});

test("restorePulse fill post does NOT re-fire on a pure window reorder (hashPairs excludes window_index)", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: null,
  });
  const posts: TmuxPaneSnapshotMessage[] = [];
  const state = freshState();
  // First pulse posts the fillable pair.
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmuxPanes(["%1\t0\twork"]),
    post: (m) => posts.push(m),
  });
  // The window moved (index 0 → 5) but the (pane_id, session_name) pair is
  // unchanged — the fill-snapshot hash must NOT see the index, so no re-post.
  restorePulse(db, restorePath, state, () => 2000, {
    spawnSync: stubTmuxPanes(["%1\t5\twork"]),
    post: (m) => posts.push(m),
  });
  expect(posts).toHaveLength(1);
});

test("restorePulse poll arm is fully disabled when no post is wired (pure-pulse path)", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: null,
  });
  // No `snapshot` arg at all — the pure-pulse test path (no parentPort). The
  // restore-file write still runs; the tmux probe arm is skipped entirely
  // (no spawn, no post) even though the gate would otherwise be armed.
  restorePulse(db, restorePath, freshState(), () => 1000);
  expect(existsSync(restorePath)).toBe(true);
});

// ---------------------------------------------------------------------------
// restorePulse — window-index capture (the producer side of visual order)
// ---------------------------------------------------------------------------

/** Read one session bucket's agents keyed by job_id off disk. */
function agentsById(
  tier: RestoreTier | null,
  session: string,
): Map<string, { window_index: number | null; created_at: number }> {
  const out = new Map<
    string,
    { window_index: number | null; created_at: number }
  >();
  for (const a of tier?.sessions[session]?.agents ?? []) {
    out.set(a.job_id, {
      window_index: a.window_index,
      created_at: a.created_at,
    });
  }
  return out;
}

test("restorePulse stamps window_index into restore.json from the probe (correlated by pane id)", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: "work",
    created_at: 11,
  });
  insertJob({
    job_id: "j2",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%2",
    backend_exec_session_id: "work",
    created_at: 22,
  });
  const posts: TmuxPaneSnapshotMessage[] = [];
  restorePulse(db, restorePath, freshState(), () => 1000, {
    // j2's window sits LEFT of j1's (index 0 vs 3) — the visual order the
    // restore-agents util will replay.
    spawnSync: stubTmuxPanes(["%1\t3\twork", "%2\t0\twork"]),
    post: (m) => posts.push(m),
  });
  const byId = agentsById(readFile(restorePath).current, "work");
  expect(byId.get("j1")?.window_index).toBe(3);
  expect(byId.get("j2")?.window_index).toBe(0);
  expect(byId.get("j1")?.created_at).toBe(11);
  expect(byId.get("j2")?.created_at).toBe(22);
});

test("restorePulse keeps capturing window_index after ALL sessions resolve (wider gate)", () => {
  // The fill gate (NULL-session) is FALSE here — every job already has a
  // session. The wider gate (any live tmux job) must still arm the probe so
  // ongoing reorders are captured.
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: "work",
  });
  const posts: TmuxPaneSnapshotMessage[] = [];
  restorePulse(db, restorePath, freshState(), () => 1000, {
    spawnSync: stubTmuxPanes(["%1\t5\twork"]),
    post: (m) => posts.push(m),
  });
  // No fill post (no NULL-session job) but the index is still captured.
  expect(posts).toHaveLength(0);
  expect(
    agentsById(readFile(restorePath).current, "work").get("j1")?.window_index,
  ).toBe(5);
});

test("restorePulse does NOT stamp window_index on a recycled pane (session mismatch)", () => {
  // The pane id %1 hits, but the probe says it lives in session "other" while
  // the job's resolved session is "work" — a recycled `%N`. Must not stamp.
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: "work",
  });
  restorePulse(db, restorePath, freshState(), () => 1000, {
    spawnSync: stubTmuxPanes(["%1\t2\tother"]),
    post: () => {},
  });
  expect(
    agentsById(readFile(restorePath).current, "work").get("j1")?.window_index,
  ).toBeNull();
});

test("restorePulse window-index cache prunes entries for jobs no longer live", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: "work",
  });
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmuxPanes(["%1\t4\twork"]),
    post: () => {},
  });
  expect(state.lastWindowIndexByJobId.get("j1")).toBe(4);
  // The job ends → it is no longer live; the next pulse must drop its entry.
  db.run(`UPDATE jobs SET state = 'ended' WHERE job_id = 'j1'`);
  restorePulse(db, restorePath, state, () => 2000, {
    spawnSync: stubTmuxPanes(["%1\t4\twork"]),
    post: () => {},
  });
  expect(state.lastWindowIndexByJobId.has("j1")).toBe(false);
});

test("restorePulse posts a WindowIndexSnapshot when the layout changes, deduped on no change", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: "work",
  });
  insertJob({
    job_id: "j2",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%2",
    backend_exec_session_id: "work",
  });
  const wi: WindowIndexSnapshotMessage[] = [];
  const state = freshState();
  const pulse = (panes: string[], now: number): void => {
    restorePulse(db, restorePath, state, () => now, {
      spawnSync: stubTmuxPanes(panes),
      post: () => {},
      postWindowIndex: (m) => wi.push(m),
    });
  };
  // First pulse: a layout exists → ONE post carrying both entries.
  pulse(["%1\t0\twork", "%2\t1\twork"], 1000);
  expect(wi).toHaveLength(1);
  const entries0 = [...wi[0].entries].sort((a, b) =>
    a.job_id < b.job_id ? -1 : 1,
  );
  expect(entries0).toEqual([
    { job_id: "j1", window_index: 0 },
    { job_id: "j2", window_index: 1 },
  ]);
  // Identical layout → deduped, no new post.
  pulse(["%1\t0\twork", "%2\t1\twork"], 1500);
  expect(wi).toHaveLength(1);
  // A REORDER (swapped indices) re-fires — the layout hash includes the index.
  pulse(["%1\t1\twork", "%2\t0\twork"], 2000);
  expect(wi).toHaveLength(2);
  const entries1 = [...wi[1].entries].sort((a, b) =>
    a.job_id < b.job_id ? -1 : 1,
  );
  expect(entries1).toEqual([
    { job_id: "j1", window_index: 1 },
    { job_id: "j2", window_index: 0 },
  ]);
});

test("restorePulse re-posts a WindowIndexSnapshot when a job leaves the live set (prune-driven change)", () => {
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: "work",
  });
  const wi: WindowIndexSnapshotMessage[] = [];
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmuxPanes(["%1\t2\twork"]),
    post: () => {},
    postWindowIndex: (m) => wi.push(m),
  });
  expect(wi).toHaveLength(1);
  expect(wi[0].entries).toEqual([{ job_id: "j1", window_index: 2 }]);
  // The job ends → pruned from the cache → the layout shrank to empty → re-fire
  // with an empty entry set. The fold leaves j1's last-folded DB value intact;
  // the empty post simply records that no live window remains.
  db.run(`UPDATE jobs SET state = 'ended' WHERE job_id = 'j1'`);
  restorePulse(db, restorePath, state, () => 2000, {
    spawnSync: stubTmuxPanes(["%1\t2\twork"]),
    post: () => {},
    postWindowIndex: (m) => wi.push(m),
  });
  expect(wi).toHaveLength(2);
  expect(wi[1].entries).toEqual([]);
});

// ---------------------------------------------------------------------------
// probeServerGeneration — positive-int validation
// ---------------------------------------------------------------------------

test("probeServerGeneration returns the pid string for a positive integer", () => {
  expect(probeServerGeneration(stubTmux({ pid: "4242" }))).toBe("4242");
});

test("probeServerGeneration returns null on a non-zero exit (no server)", () => {
  expect(probeServerGeneration(stubTmux({ pid: null }))).toBeNull();
});

test("probeServerGeneration rejects garbage / non-positive-int output", () => {
  const cases = ["", "  ", "0", "-1", "12.5", "0x1f", "abc", "12 34", "1e3"];
  for (const out of cases) {
    const stub: SpawnSyncFn = () => ({
      success: true,
      exitCode: 0,
      stdout: Buffer.from(out),
    });
    expect(probeServerGeneration(stub)).toBeNull();
  }
});

test("probeServerGeneration trims surrounding whitespace from a valid pid", () => {
  const stub: SpawnSyncFn = () => ({
    success: true,
    exitCode: 0,
    stdout: Buffer.from("  777\n"),
  });
  expect(probeServerGeneration(stub)).toBe("777");
});

test("probeServerGeneration returns null when spawnSync throws (no binary)", () => {
  const stub: SpawnSyncFn = () => {
    throw new Error("ENOENT");
  };
  expect(probeServerGeneration(stub)).toBeNull();
});

// ---------------------------------------------------------------------------
// restorePulse — BackendExecStart generation boundary
// ---------------------------------------------------------------------------

test("restorePulse posts a BackendExecStart on the first observed generation, deduped on no change", () => {
  // No live tmux job: the generation arm is UNGATED, so it must still fire — the
  // post-crash state is exactly when no job is live.
  const bes: BackendExecStartMessage[] = [];
  const state = freshState();
  const pulse = (pid: string, now: number): void => {
    restorePulse(db, restorePath, state, () => now, {
      spawnSync: stubTmux({ pid }),
      post: () => {},
      postBackendExecStart: (m) => bes.push(m),
    });
  };
  // First observation → ONE post carrying backend_type + generation_id.
  pulse("1000", 1000);
  expect(bes).toHaveLength(1);
  expect(bes[0]).toEqual({
    kind: "backend-exec-start",
    backend_type: "tmux",
    generation_id: "1000",
  });
  // Unchanged server pid → deduped, no new post.
  pulse("1000", 1500);
  expect(bes).toHaveLength(1);
  // Server respawned (new pid) → a new boundary.
  pulse("2000", 2000);
  expect(bes).toHaveLength(2);
  expect(bes[1].generation_id).toBe("2000");
});

test("restorePulse emits no BackendExecStart when no tmux server is running", () => {
  const bes: BackendExecStartMessage[] = [];
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmux({ pid: null }),
    post: () => {},
    postBackendExecStart: (m) => bes.push(m),
  });
  expect(bes).toHaveLength(0);
  // A degraded probe must leave the gate untouched, so a later real generation
  // still posts (it is not silently swallowed as "already seen").
  expect(state.lastGenerationHash).toBeNull();
  restorePulse(db, restorePath, state, () => 2000, {
    spawnSync: stubTmux({ pid: "55" }),
    post: () => {},
    postBackendExecStart: (m) => bes.push(m),
  });
  expect(bes).toHaveLength(1);
  expect(bes[0].generation_id).toBe("55");
});

test("seedLastGenerationHash suppresses a same-pid re-emit across a keeperd restart", () => {
  // A prior boot logged BackendExecStart{pid:9999}. After a restart against the
  // SAME server, the boot-seed primes the gate so the first pulse is silent.
  insertBackendExecStart("9999");
  const bes: BackendExecStartMessage[] = [];
  const state = freshState();
  seedLastGenerationHash(db, state);
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmux({ pid: "9999" }),
    post: () => {},
    postBackendExecStart: (m) => bes.push(m),
  });
  expect(bes).toHaveLength(0);
  // A genuine respawn after the restart (different pid) DOES still post.
  restorePulse(db, restorePath, state, () => 2000, {
    spawnSync: stubTmux({ pid: "10000" }),
    post: () => {},
    postBackendExecStart: (m) => bes.push(m),
  });
  expect(bes).toHaveLength(1);
  expect(bes[0].generation_id).toBe("10000");
});

test("seedLastGenerationHash reads the LATEST BackendExecStart by id, not ts", () => {
  // Two generations logged; the latest by rowid is the one that must seed.
  insertBackendExecStart("100");
  insertBackendExecStart("200");
  const bes: BackendExecStartMessage[] = [];
  const state = freshState();
  seedLastGenerationHash(db, state);
  // Server still on the latest generation (200) → silent.
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmux({ pid: "200" }),
    post: () => {},
    postBackendExecStart: (m) => bes.push(m),
  });
  expect(bes).toHaveLength(0);
});

test("seedLastGenerationHash leaves the gate null when no BackendExecStart exists", () => {
  const bes: BackendExecStartMessage[] = [];
  const state = freshState();
  seedLastGenerationHash(db, state);
  expect(state.lastGenerationHash).toBeNull();
  // With no seed, the first observed generation is treated as a boundary.
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmux({ pid: "42" }),
    post: () => {},
    postBackendExecStart: (m) => bes.push(m),
  });
  expect(bes).toHaveLength(1);
  expect(bes[0].generation_id).toBe("42");
});

test("seedLastGenerationHash tolerates a malformed payload (leaves gate null)", () => {
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, ?, ?, ?)`,
    [1000, "backend-exec-start", "BackendExecStart", "backend_exec_start", "{"],
  );
  const state = freshState();
  seedLastGenerationHash(db, state);
  expect(state.lastGenerationHash).toBeNull();
});

test("restorePulse generation arm is independent of the window-index / pane arms", () => {
  // One live tmux job drives the pane + window arms; the generation arm fires off
  // the SAME single injected spawnSync, dispatched by subcommand.
  insertJob({
    job_id: "j1",
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%1",
    backend_exec_session_id: "work",
  });
  const wi: WindowIndexSnapshotMessage[] = [];
  const bes: BackendExecStartMessage[] = [];
  const state = freshState();
  restorePulse(db, restorePath, state, () => 1000, {
    spawnSync: stubTmux({ pid: "321", panes: ["%1\t0\twork"] }),
    post: () => {},
    postWindowIndex: (m) => wi.push(m),
    postBackendExecStart: (m) => bes.push(m),
  });
  expect(wi).toHaveLength(1);
  expect(wi[0].entries).toEqual([{ job_id: "j1", window_index: 0 }]);
  expect(bes).toHaveLength(1);
  expect(bes[0].generation_id).toBe("321");
});
