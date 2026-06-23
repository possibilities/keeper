/**
 * fn-907 task .4 — LIVE-ONLY tmux location projection: the boot-seed PRODUCER
 * (`seedTmuxProjection`). Re-derives the whole-server pane topology BEFORE the
 * daemon serves, overwriting each live tmux job's `backend_exec_session_id` +
 * `window_index`, raises the skip-floor to the captured `max(events.id)`, and
 * manages the `seed_required` lifecycle (crash-recovery + degrade-not-fatal).
 *
 * NO REAL TMUX: the seed's ONLY tmux boundary is its injectable `buildSnapshot`
 * seam (defaulting to the real `probeServerGeneration` + `probeTmuxTopology`
 * producer). These tests drive the seed's fold / floor / seed_required DECISIONS
 * with synthetic `TmuxSeedSnapshot`s — a one-pane snapshot stands in for a live
 * tmux server, a `null` return stands in for a degraded probe (server gone /
 * transient / unresolvable generation). `freshMemDb` supplies a migrated DB
 * carrying the prepared `stmts.insertEvent` the seed reuses and the
 * `tmux_projection_state` control row the v83 migration created.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { KeeperDb } from "../src/db";
import {
  readTmuxProjectionFloor,
  readTmuxProjectionSeedRequired,
} from "../src/db";
import { drain } from "../src/reducer";
import type { TmuxTopologyPane } from "../src/restore-worker";
import {
  seedTmuxProjection,
  type TmuxSeedSnapshot,
} from "../src/tmux-boot-seed";
import { freshMemDb } from "./helpers/template-db";

let kdb: KeeperDb;

beforeEach(() => {
  kdb = freshMemDb();
});

afterEach(() => {
  kdb.db.close();
});

/** Drain-to-completion over this test's db (the callback the seed needs). */
function drainAll(): void {
  let n: number;
  do {
    n = drain(kdb.db);
  } while (n > 0);
}

/**
 * Insert a live (`working`) tmux job. `session`/`windowIndex` are its CURRENT
 * (stale) location; `generationId` is its adopted server generation (NULL = not
 * yet adopted, so the first snapshot's generation is taken).
 */
function insertTmuxJob(opts: {
  jobId: string;
  paneId: string;
  session?: string | null;
  windowIndex?: number | null;
  generationId?: string | null;
  state?: string;
}): void {
  kdb.db.run(
    `INSERT INTO jobs (
       job_id, created_at, updated_at, state,
       backend_exec_type, backend_exec_pane_id, backend_exec_session_id,
       backend_exec_generation_id, window_index
     ) VALUES (?, 1000, 1000, ?, 'tmux', ?, ?, ?, ?)`,
    [
      opts.jobId,
      opts.state ?? "working",
      opts.paneId,
      opts.session ?? null,
      opts.generationId ?? null,
      opts.windowIndex ?? null,
    ],
  );
}

function jobLocation(jobId: string): {
  backend_exec_session_id: string | null;
  window_index: number | null;
  backend_exec_generation_id: string | null;
} | null {
  return kdb.db
    .query(
      `SELECT backend_exec_session_id, window_index, backend_exec_generation_id
         FROM jobs WHERE job_id = ?`,
    )
    .get(jobId) as {
    backend_exec_session_id: string | null;
    window_index: number | null;
    backend_exec_generation_id: string | null;
  } | null;
}

function snapshot(
  generationId: string,
  panes: TmuxTopologyPane[],
): TmuxSeedSnapshot {
  return { generation_id: generationId, panes };
}

function seedRequired(): boolean {
  return readTmuxProjectionSeedRequired(kdb.db);
}

// ---------------------------------------------------------------------------
// Happy path: a successful probe overwrites live location + clears seed_required
// ---------------------------------------------------------------------------

test("boot-seed overwrites a moved pane's live session + window_index from one whole-server snapshot", () => {
  // A job whose pane has been moved out-of-band: its row still shows the OLD
  // session/window; the live topology reports the NEW location.
  insertTmuxJob({
    jobId: "j-moved",
    paneId: "%5",
    session: "autopilot",
    windowIndex: 3,
    generationId: "9000",
  });

  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    buildSnapshot: () =>
      snapshot("9000", [
        { pane_id: "%5", session_name: "foreground", window_index: 0 },
      ]),
  });

  expect(result.seeded).toBe(true);
  const loc = jobLocation("j-moved");
  expect(loc?.backend_exec_session_id).toBe("foreground");
  expect(loc?.window_index).toBe(0);
  // seed_required cleared on a successful probe.
  expect(seedRequired()).toBe(false);
});

test("seed-freshness: the floor is raised to the captured max(events.id) and seed_required cleared on success", () => {
  // Pre-existing events so max(events.id) > 0.
  for (let i = 0; i < 3; i++) {
    kdb.db.run(
      "INSERT INTO events (ts, session_id, pid, hook_event, event_type, data) VALUES (?, 's', NULL, 'Stop', 'stop', '{}')",
      [1000 + i],
    );
  }
  const preMaxId = (
    kdb.db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;

  insertTmuxJob({ jobId: "j1", paneId: "%1", generationId: "100" });
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    buildSnapshot: () =>
      snapshot("100", [
        { pane_id: "%1", session_name: "sess", window_index: 1 },
      ]),
  });

  // The persisted floor equals the max id captured BEFORE the probe (the
  // synthetic TmuxTopologySnapshot the seed appended sits ABOVE it).
  expect(result.floor).toBe(preMaxId);
  expect(readTmuxProjectionFloor(kdb.db)).toBe(preMaxId);
  expect(seedRequired()).toBe(false);

  // The synthetic snapshot folded ABOVE the floor (its id > floor), so the live
  // location landed.
  expect(jobLocation("j1")?.backend_exec_session_id).toBe("sess");
});

test("server-up-with-no-panes is a settled state: an empty pane set seeds (clears seed_required) without wiping", () => {
  insertTmuxJob({
    jobId: "j-keep",
    paneId: "%7",
    session: "lastgood",
    windowIndex: 2,
    generationId: "200",
  });
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    // Server up, no panes — a valid settled state (not a probe failure).
    buildSnapshot: () => snapshot("200", []),
  });
  expect(result.seeded).toBe(true);
  expect(seedRequired()).toBe(false);
  // An empty pane set asserts nothing, so the last-known location is untouched.
  const loc = jobLocation("j-keep");
  expect(loc?.backend_exec_session_id).toBe("lastgood");
  expect(loc?.window_index).toBe(2);
});

// ---------------------------------------------------------------------------
// Degrade-not-fatal: a degraded probe keeps seed_required + never wipes location
// ---------------------------------------------------------------------------

test("degraded probe (null) leaves seed_required SET to re-seed next boot and never wipes location", () => {
  insertTmuxJob({
    jobId: "j-keep",
    paneId: "%3",
    session: "lastgood",
    windowIndex: 4,
    generationId: "300",
  });
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    // server gone / transient / unresolvable generation.
    buildSnapshot: () => null,
  });
  expect(result.seeded).toBe(false);
  expect(seedRequired()).toBe(true);
  // The last-known good location is untouched — no wiping empty topology.
  const loc = jobLocation("j-keep");
  expect(loc?.backend_exec_session_id).toBe("lastgood");
  expect(loc?.window_index).toBe(4);
});

test("a degraded probe still raises the floor (historical replay stays skipped)", () => {
  // An empty event log ⇒ floor 0; the raise is still issued (a real boot raises
  // it to the captured max id even when the probe fails).
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    buildSnapshot: () => null,
  });
  expect(result.floor).toBe(0);
  expect(readTmuxProjectionFloor(kdb.db)).toBe(0);
  expect(seedRequired()).toBe(true);
});

test("crash-recovery: an interrupted seed leaves seed_required=1 (set before probe, cleared only on success)", () => {
  // A drain callback that throws (mid-fold crash). The seed isolates it and never
  // throws; `seed_required` was set before the probe and is NOT cleared, so the
  // next boot re-seeds.
  insertTmuxJob({ jobId: "j1", paneId: "%1", generationId: "100" });
  let calls = 0;
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: () => {
      calls++;
      throw new Error("simulated mid-fold crash");
    },
    buildSnapshot: () =>
      snapshot("100", [
        { pane_id: "%1", session_name: "sess", window_index: 1 },
      ]),
  });
  expect(calls).toBeGreaterThan(0);
  expect(result.seeded).toBe(false);
  expect(seedRequired()).toBe(true);
});

test("a throwing buildSnapshot is isolated; the seed never throws and leaves seed_required set", () => {
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    buildSnapshot: () => {
      throw new Error("simulated probe throw");
    },
  });
  expect(result.seeded).toBe(false);
  expect(seedRequired()).toBe(true);
});

// ---------------------------------------------------------------------------
// Recycle guard: a recycled %N in a NEW generation never overwrites a prior job
// ---------------------------------------------------------------------------

test("recycle guard: a recycled %N in a NEW generation does not overwrite a prior generation's job", () => {
  // A job bound to pane %5 in generation 100. A snapshot from a NEW generation
  // (200) reports %5 with a different session — a RECYCLED pane id belonging to a
  // different server. The fold's `(generation_id, pane_id)` guard must NOT
  // overwrite the prior-generation job.
  insertTmuxJob({
    jobId: "j-old",
    paneId: "%5",
    session: "old-sess",
    windowIndex: 1,
    generationId: "100",
  });
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    buildSnapshot: () =>
      snapshot("200", [
        { pane_id: "%5", session_name: "new-sess", window_index: 9 },
      ]),
  });
  expect(result.seeded).toBe(true);
  // The prior-generation job is untouched — the recycle guard held.
  const loc = jobLocation("j-old");
  expect(loc?.backend_exec_session_id).toBe("old-sess");
  expect(loc?.window_index).toBe(1);
  expect(loc?.backend_exec_generation_id).toBe("100");
});

test("a job with a NULL generation adopts the snapshot's generation on first match", () => {
  insertTmuxJob({
    jobId: "j-fresh",
    paneId: "%2",
    session: null,
    windowIndex: null,
    generationId: null,
  });
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    buildSnapshot: () =>
      snapshot("777", [
        { pane_id: "%2", session_name: "adopted", window_index: 5 },
      ]),
  });
  expect(result.seeded).toBe(true);
  const loc = jobLocation("j-fresh");
  expect(loc?.backend_exec_session_id).toBe("adopted");
  expect(loc?.window_index).toBe(5);
  expect(loc?.backend_exec_generation_id).toBe("777");
});

// ---------------------------------------------------------------------------
// Last-known-good preservation under partial/garbage payloads
// ---------------------------------------------------------------------------

test("a NULL window_index in the payload preserves the job's last-known good index", () => {
  insertTmuxJob({
    jobId: "j",
    paneId: "%4",
    session: "old",
    windowIndex: 8,
    generationId: "500",
  });
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    buildSnapshot: () =>
      snapshot("500", [
        { pane_id: "%4", session_name: "new", window_index: null },
      ]),
  });
  expect(result.seeded).toBe(true);
  const loc = jobLocation("j");
  // session overwrites; window_index COALESCEs (NULL-in-payload keeps the old).
  expect(loc?.backend_exec_session_id).toBe("new");
  expect(loc?.window_index).toBe(8);
});

test("a killed/ended job is never adopted by a recycled pane in the topology", () => {
  insertTmuxJob({
    jobId: "j-killed",
    paneId: "%6",
    session: "gone-sess",
    windowIndex: 2,
    generationId: "600",
    state: "killed",
  });
  const result = seedTmuxProjection(kdb.db, kdb.stmts, {
    drainToCompletion: drainAll,
    buildSnapshot: () =>
      snapshot("601", [
        { pane_id: "%6", session_name: "recycled", window_index: 0 },
      ]),
  });
  expect(result.seeded).toBe(true);
  // The killed job's location is frozen — the fold's live-state filter blocks it.
  const loc = jobLocation("j-killed");
  expect(loc?.backend_exec_session_id).toBe("gone-sess");
  expect(loc?.window_index).toBe(2);
});
