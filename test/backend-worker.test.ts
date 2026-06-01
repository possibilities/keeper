/**
 * Backend-exec tab-resolver worker tests (fn-668 / schema v48).
 *
 * Exercise the pure `runTick` + `readLiveJobsWithCoords` symbols against a
 * fresh writer DB seeded by direct `INSERT INTO jobs`, with a stubbed
 * `backend` carrying just the `resolveTabForPane` slot so no real `zellij`
 * ever spawns. The worker's lifecycle
 * (Worker thread, setInterval, parentPort.postMessage) is exercised
 * indirectly through these helpers — the same shape the autopilot-worker
 * + git-worker tests use.
 *
 * Coverage:
 *  - `readLiveJobsWithCoords`: only jobs with non-NULL session+pane AND
 *    non-resting state surface; ended/killed jobs are filtered out.
 *  - `runTick`: dedups by distinct session (one resolve per session
 *    even with many jobs), posts one snapshot per job sharing the
 *    (session, pane), skips coord-less rows entirely.
 *  - `runTick`: a `null` resolve result → NO post (tab tombstone =
 *    last-known sticks).
 *  - `runTick`: a thrown resolver → log + skip (no post).
 *  - `runTick`: per-session in-flight lock prevents double-spawn against
 *    the same session across overlapping ticks.
 *  - `runTick`: `isShuttingDown()` returning true between resolve and
 *    post suppresses the message.
 *  - `runTick`: numeric `tab_id` from the resolver is coerced to TEXT
 *    on the wire; `null` `tab_id` flows through as null.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BackendWorkerMessage,
  readLiveJobsWithCoords,
  runTick,
} from "../src/backend-worker";
import { openDb } from "../src/db";
import type { ExecBackend, ResolvedTabCoords } from "../src/exec-backend";

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-backend-worker-test-"));
  dbPath = join(tmpDir, "keeper.db");
  db = openDb(dbPath).db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert one row into `jobs` with the per-test backend coordinates and
 * lifecycle state. Defaults match a freshly-spawned working session.
 *
 * Keeps the per-row DEFAULTs the schema provides for everything else;
 * only the columns the tests touch are passed explicitly.
 */
function insertJob(opts: {
  job_id: string;
  state?: string;
  backend_exec_session_id?: string | null;
  backend_exec_pane_id?: string | null;
}): void {
  const state = opts.state ?? "working";
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at,
       backend_exec_session_id, backend_exec_pane_id
     ) VALUES (?, 1000, ?, 0, 1000, ?, ?)`,
    [
      opts.job_id,
      state,
      opts.backend_exec_session_id ?? null,
      opts.backend_exec_pane_id ?? null,
    ],
  );
}

/**
 * Build an `ExecBackend`-shaped backend stub (only the slot `runTick`
 * actually reads — `resolveTabForPane`) that records each (session,
 * pane) invocation into `calls` and returns canned answers from a
 * (session, pane) → resolved-or-null table.
 */
function makeBackendStub(
  table: Record<string, ResolvedTabCoords | null>,
  calls: Array<{ session: string; pane: string }>,
): Pick<ExecBackend, "resolveTabForPane"> {
  return {
    async resolveTabForPane(session, pane) {
      calls.push({ session, pane });
      const key = `${session} ${pane}`;
      return table[key] ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// readLiveJobsWithCoords
// ---------------------------------------------------------------------------

test("readLiveJobsWithCoords: surfaces only jobs with BOTH session AND pane coords set", () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });
  insertJob({
    job_id: "b",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: null,
  }); // missing pane → filtered out
  insertJob({
    job_id: "c",
    backend_exec_session_id: null,
    backend_exec_pane_id: "13",
  }); // missing session → filtered out
  insertJob({
    job_id: "d",
    backend_exec_session_id: null,
    backend_exec_pane_id: null,
  }); // both null → filtered out

  const rows = readLiveJobsWithCoords(db);
  expect(rows.map((r) => r.job_id).sort()).toEqual(["a"]);
});

test("readLiveJobsWithCoords: filters out ended / killed jobs (pane is presumed gone)", () => {
  insertJob({
    job_id: "live",
    state: "working",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });
  insertJob({
    job_id: "stopped",
    state: "stopped",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "12",
  });
  insertJob({
    job_id: "ended",
    state: "ended",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "13",
  });
  insertJob({
    job_id: "killed",
    state: "killed",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "14",
  });

  const rows = readLiveJobsWithCoords(db);
  expect(rows.map((r) => r.job_id).sort()).toEqual(["live", "stopped"]);
});

// ---------------------------------------------------------------------------
// runTick — dedup, post shape, skip behavior
// ---------------------------------------------------------------------------

test("runTick: one resolve per distinct session (dedup), one snapshot per job", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });
  insertJob({
    job_id: "b",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  }); // SAME (session, pane) as 'a' — dedup at bucket, both jobs get a post
  insertJob({
    job_id: "c",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "12",
  }); // Same session, different pane — separate spawn
  insertJob({
    job_id: "d",
    backend_exec_session_id: "other",
    backend_exec_pane_id: "5",
  }); // Different session — separate spawn

  const calls: Array<{ session: string; pane: string }> = [];
  const backend = makeBackendStub(
    {
      "autopilot 11": { tab_id: 3, tab_name: "agent-a", tab_position: 0 },
      "autopilot 12": { tab_id: 4, tab_name: "agent-c", tab_position: 1 },
      "other 5": { tab_id: 1, tab_name: "elsewhere", tab_position: 0 },
    },
    calls,
  );
  const posted: BackendWorkerMessage[] = [];

  await runTick({
    db,
    inFlight: new Set(),
    backend,
    post: (m) => posted.push(m),
    isShuttingDown: () => false,
  });

  // Three distinct (session, pane) → three resolver calls.
  expect(calls).toHaveLength(3);
  expect(calls.map((c) => `${c.session} ${c.pane}`).sort()).toEqual([
    "autopilot 11",
    "autopilot 12",
    "other 5",
  ]);

  // Four jobs (a, b share a bucket; c and d distinct) → four posts.
  expect(posted).toHaveLength(4);
  const byJob = new Map(posted.map((m) => [m.job_id, m]));
  expect(byJob.get("a")).toEqual({
    kind: "backend-exec-snapshot",
    job_id: "a",
    tab_id: "3",
    tab_name: "agent-a",
  });
  expect(byJob.get("b")).toEqual({
    kind: "backend-exec-snapshot",
    job_id: "b",
    tab_id: "3",
    tab_name: "agent-a",
  });
  expect(byJob.get("c")).toEqual({
    kind: "backend-exec-snapshot",
    job_id: "c",
    tab_id: "4",
    tab_name: "agent-c",
  });
  expect(byJob.get("d")).toEqual({
    kind: "backend-exec-snapshot",
    job_id: "d",
    tab_id: "1",
    tab_name: "elsewhere",
  });
});

test("runTick: no live jobs → no resolver calls, no posts", async () => {
  // No jobs inserted.
  const calls: Array<{ session: string; pane: string }> = [];
  const backend = makeBackendStub({}, calls);
  const posted: BackendWorkerMessage[] = [];

  await runTick({
    db,
    inFlight: new Set(),
    backend,
    post: (m) => posted.push(m),
    isShuttingDown: () => false,
  });

  expect(calls).toEqual([]);
  expect(posted).toEqual([]);
});

test("runTick: null resolve result → NO post (tab tombstone = last-known sticks)", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });

  const calls: Array<{ session: string; pane: string }> = [];
  const backend = makeBackendStub({ "autopilot 11": null }, calls);
  const posted: BackendWorkerMessage[] = [];

  await runTick({
    db,
    inFlight: new Set(),
    backend,
    post: (m) => posted.push(m),
    isShuttingDown: () => false,
  });

  expect(calls).toHaveLength(1); // resolve was attempted
  expect(posted).toEqual([]); // but no clobbering snapshot
});

test("runTick: resolver throw → log + skip (no post, no wedge)", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });
  insertJob({
    job_id: "b",
    backend_exec_session_id: "other",
    backend_exec_pane_id: "5",
  });

  const calls: Array<{ session: string; pane: string }> = [];
  const backend: Pick<ExecBackend, "resolveTabForPane"> = {
    async resolveTabForPane(session, pane) {
      calls.push({ session, pane });
      if (session === "autopilot") {
        throw new Error("simulated resolver crash");
      }
      return { tab_id: 1, tab_name: "elsewhere", tab_position: 0 };
    },
  };
  const posted: BackendWorkerMessage[] = [];

  await runTick({
    db,
    inFlight: new Set(),
    backend,
    post: (m) => posted.push(m),
    isShuttingDown: () => false,
  });

  // Both resolvers attempted (one throws, one succeeds in parallel).
  expect(calls).toHaveLength(2);
  // Only the non-throwing one produced a post.
  expect(posted).toHaveLength(1);
  expect(posted[0]?.job_id).toBe("b");
});

test("runTick: per-session in-flight lock suppresses re-spawn against the same session", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });

  // Pre-populate the in-flight Set as if an earlier tick is still
  // running against `autopilot`. runTick must skip this session
  // entirely.
  const inFlight = new Set<string>(["autopilot"]);
  const calls: Array<{ session: string; pane: string }> = [];
  const backend = makeBackendStub(
    { "autopilot 11": { tab_id: 3, tab_name: "agent", tab_position: 0 } },
    calls,
  );
  const posted: BackendWorkerMessage[] = [];

  await runTick({
    db,
    inFlight,
    backend,
    post: (m) => posted.push(m),
    isShuttingDown: () => false,
  });

  // The resolver was never called (in-flight lock fired); no post.
  expect(calls).toEqual([]);
  expect(posted).toEqual([]);
  // The in-flight Set is untouched — the original tick still owns the lock.
  expect(inFlight.has("autopilot")).toBe(true);
});

test("runTick: per-session in-flight slot is released after the resolve settles", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });

  const inFlight = new Set<string>();
  const calls: Array<{ session: string; pane: string }> = [];
  const backend = makeBackendStub(
    { "autopilot 11": { tab_id: 3, tab_name: "agent", tab_position: 0 } },
    calls,
  );
  const posted: BackendWorkerMessage[] = [];

  await runTick({
    db,
    inFlight,
    backend,
    post: (m) => posted.push(m),
    isShuttingDown: () => false,
  });

  expect(calls).toHaveLength(1);
  expect(posted).toHaveLength(1);
  // The lock is released so the next tick can proceed.
  expect(inFlight.has("autopilot")).toBe(false);
});

test("runTick: isShuttingDown=true between resolve and post suppresses the message", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });

  let didResolve = false;
  const backend: Pick<ExecBackend, "resolveTabForPane"> = {
    async resolveTabForPane() {
      didResolve = true;
      return { tab_id: 3, tab_name: "agent", tab_position: 0 };
    },
  };
  const posted: BackendWorkerMessage[] = [];

  await runTick({
    db,
    inFlight: new Set(),
    backend,
    post: (m) => posted.push(m),
    // Shutdown flips between the resolve await and the post — runTick
    // must NOT post post-shutdown.
    isShuttingDown: () => didResolve,
  });

  expect(didResolve).toBe(true);
  expect(posted).toEqual([]);
});

test("runTick: numeric tab_id from resolver is coerced to TEXT; null tab_id flows through as null", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "11",
  });
  insertJob({
    job_id: "b",
    backend_exec_session_id: "autopilot",
    backend_exec_pane_id: "12",
  });

  const calls: Array<{ session: string; pane: string }> = [];
  const backend = makeBackendStub(
    {
      "autopilot 11": { tab_id: 42, tab_name: "named", tab_position: 0 },
      "autopilot 12": { tab_id: null, tab_name: "id-less", tab_position: null },
    },
    calls,
  );
  const posted: BackendWorkerMessage[] = [];

  await runTick({
    db,
    inFlight: new Set(),
    backend,
    post: (m) => posted.push(m),
    isShuttingDown: () => false,
  });

  const byJob = new Map(posted.map((m) => [m.job_id, m]));
  expect(byJob.get("a")?.tab_id).toBe("42");
  expect(byJob.get("b")?.tab_id).toBeNull();
});
