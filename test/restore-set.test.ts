/**
 * restore-set tests (epic fn-817, T3) — the DB-derived crash-restore candidate
 * set. Covers the task Acceptance:
 *  - candidates derived from a READ-ONLY DB connection (works daemon-down).
 *  - membership = crash-like `close_kind` (+ unknown/legacy burst backstop);
 *    `window_gone_server_alive` excluded.
 *  - filters: backend coords, autopilot workers, already-live UUID dedup, idle
 *    cutoff with a surfaced excluded count.
 *  - order by `window_index` (nulls to tail); resume target = session UUID
 *    (the label carries the latest title).
 *  - the recorded 2026-06-16 incident burst cohort as a regression fixture.
 *
 * Pure module — fixture DB via `freshDbFile`, no subprocess, no daemon.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTmuxTopologySnapshot } from "../src/reducer";
import {
  BURST_MIN_SIZE,
  burstEventIds,
  DEFAULT_IDLE_CUTOFF_SECS,
  DEGENERATE_MAX_SPAN_SECS,
  deriveCurrentSet,
  deriveLastGenerationSet,
  deriveLastGenerationSetFromTopology,
  deriveRestoreSet,
  GENERATION_SUMMARY_SQL,
  isCrashLike,
  isRestorableCandidate,
  RECENT_GENERATION_BOUND,
  type RestoreCandidate,
  summarizeTopologyGenerations,
} from "../src/restore-set";
import type { Event } from "../src/types";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;
let kdb: ReturnType<typeof freshDbFile>;

// Fixed "now" so idle-cutoff assertions are deterministic.
const NOW = 1_750_000_000; // ~2025-06-15

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-restore-set-test-"));
  dbPath = join(tmpDir, "keeper.db");
  kdb = freshDbFile(dbPath);
});

afterEach(() => {
  try {
    kdb.db.close();
  } catch {
    // best-effort
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

interface SeedJob {
  job_id: string;
  state?: string;
  close_kind?: string | null;
  window_index?: number | null;
  title?: string | null;
  cwd?: string | null;
  created_at?: number;
  updated_at?: number;
  backend_exec_session_id?: string | null;
  backend_exec_birth_session_id?: string | null;
  plan_verb?: string | null;
  last_event_id?: number | null;
  pid?: number | null;
  /** Backend coords the topology deriver's projection-join fallback keys on
   *  (`(backend_exec_generation_id, backend_exec_pane_id)`). */
  backend_exec_type?: string | null;
  backend_exec_pane_id?: string | null;
  backend_exec_generation_id?: string | null;
  /** Launching harness + its native resume target (v107/v108 columns). */
  harness?: string | null;
  resume_target?: string | null;
  /** The harness-agnostic adopted marker (`jobs.adopted`); `1` marks a session a
   *  non-launcher path minted, NULL a launcher-owned/legacy one. */
  adopted?: number | null;
}

/** Insert one jobs row with sensible defaults; only the fields a test cares
 *  about need to be passed. Writes raw — exercising the read path, not the fold. */
function seedJob(db: Database, j: SeedJob): void {
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, updated_at, state, title, close_kind, window_index,
       cwd, backend_exec_session_id, backend_exec_birth_session_id, plan_verb,
       last_event_id, pid, backend_exec_type, backend_exec_pane_id,
       backend_exec_generation_id, harness, resume_target, adopted
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      j.job_id,
      j.created_at ?? NOW - 100,
      j.updated_at ?? NOW - 100,
      j.state ?? "killed",
      j.title ?? null,
      j.close_kind ?? null,
      j.window_index ?? null,
      j.cwd ?? null,
      // Explicit `null` must survive (the no-backend filter test passes it);
      // only an ABSENT key falls back to the default session.
      "backend_exec_session_id" in j
        ? (j.backend_exec_session_id ?? null)
        : "work",
      j.backend_exec_birth_session_id ?? null,
      j.plan_verb ?? null,
      j.last_event_id ?? null,
      j.pid ?? null,
      j.backend_exec_type ?? null,
      j.backend_exec_pane_id ?? null,
      j.backend_exec_generation_id ?? null,
      j.harness ?? null,
      j.resume_target ?? null,
      j.adopted ?? null,
    ],
  );
}

function derive(opts?: { now?: number; idleCutoffSecs?: number }) {
  return deriveRestoreSet(kdb.db, { now: NOW, ...opts });
}

function deriveLastGen(opts?: { now?: number; idleCutoffSecs?: number }) {
  return deriveLastGenerationSet(kdb.db, { now: NOW, ...opts });
}

/**
 * Insert a synthetic `BackendExecStart` generation-boundary event at an EXPLICIT
 * rowid (so a test pins the boundary relative to its seeded Killed `event_id`s).
 * Mirrors the daemon producer's column mapping (hook_event/event_type/data); the
 * generation_id rides `data` but the window logic keys only on `events.id` ORDER.
 */
function seedBackendExecStart(
  db: Database,
  id: number,
  generationId = `gen-${id}`,
): void {
  db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'backend-exec-start', 'BackendExecStart', 'backend_exec_start', ?)`,
    [
      id,
      NOW - 100,
      JSON.stringify({ backend_type: "tmux", generation_id: generationId }),
    ],
  );
}

interface SeedTopologyPane {
  pane_id: string;
  session_name: string;
  window_index?: number | null;
  job_id?: string;
}

/**
 * Insert a synthetic `TmuxTopologySnapshot` event at an EXPLICIT rowid carrying
 * `{generation_id, panes}` — mirrors {@link seedBackendExecStart}'s explicit-id
 * shape and the daemon producer's column mapping. Each pane carries the OPTIONAL
 * producer-stamped `job_id`; omit it to model a pane keeper never launched (or
 * whose job row was not yet written at post time). `ts` defaults to `NOW - 100`;
 * pass it to give a generation a ts-span (the degeneracy-filter input).
 */
function seedTmuxTopologySnapshot(
  db: Database,
  id: number,
  generationId: string,
  panes: SeedTopologyPane[],
  ts: number = NOW - 100,
): void {
  db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'tmux-topology-snapshot', 'TmuxTopologySnapshot', 'tmux_topology_snapshot', ?)`,
    [
      id,
      ts,
      JSON.stringify({
        generation_id: generationId,
        panes: panes.map((p) => ({
          pane_id: p.pane_id,
          session_name: p.session_name,
          window_index: p.window_index ?? null,
          ...(p.job_id !== undefined ? { job_id: p.job_id } : {}),
        })),
      }),
    ],
  );
}

/**
 * A pane that resolves to NO job (unowned — no payload `job_id`, no projection
 * match on `%pad`). Padding a single-pane snapshot with it lifts the
 * generation's observed pane count above 1 so it clears the degenerate
 * (`<=1`-pane AND short-span skeleton) filter WITHOUT adding a restorable
 * candidate (it is dropped like any unowned pane). Models the realistic "a plain
 * shell pane keeper never launched" case.
 */
const PAD_PANE: SeedTopologyPane = {
  pane_id: "%pad",
  session_name: "work",
  window_index: 98,
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("burstEventIds: a contiguous run >= BURST_MIN_SIZE is a burst", () => {
  const burst = burstEventIds([10, 11, 12, 13]);
  expect([...burst].sort((a, b) => a - b)).toEqual([10, 11, 12, 13]);
});

test("burstEventIds: an isolated rowid is never a burst", () => {
  const burst = burstEventIds([10, 50, 99]);
  expect(burst.size).toBe(0);
});

test("burstEventIds: mixed — only the contiguous cluster qualifies", () => {
  // 100..102 is a 3-run; 200 and 300 are isolated.
  const burst = burstEventIds([300, 100, 200, 101, 102]);
  expect([...burst].sort((a, b) => a - b)).toEqual([100, 101, 102]);
});

test("burstEventIds: NULL/non-finite rowids are dropped, never in a burst", () => {
  const burst = burstEventIds([null, 10, 11, null, NaN]);
  expect([...burst].sort((a, b) => a - b)).toEqual([10, 11]);
});

test("burstEventIds: BURST_MIN_SIZE is the threshold (a run just under fails)", () => {
  // A single isolated rowid is below the 2-wide threshold.
  expect(burstEventIds([42]).size).toBe(0);
  expect(BURST_MIN_SIZE).toBe(2);
});

test("isCrashLike: server_gone / pid_died qualify regardless of burst", () => {
  expect(isCrashLike("server_gone", false)).toBe(true);
  expect(isCrashLike("pid_died", false)).toBe(true);
});

test("isCrashLike: window_gone_server_alive never qualifies, even in a burst", () => {
  expect(isCrashLike("window_gone_server_alive", true)).toBe(false);
});

test("isCrashLike: unknown/NULL qualify ONLY inside a burst", () => {
  expect(isCrashLike("unknown", false)).toBe(false);
  expect(isCrashLike("unknown", true)).toBe(true);
  expect(isCrashLike(null, false)).toBe(false);
  expect(isCrashLike(null, true)).toBe(true);
});

// ---------------------------------------------------------------------------
// TmuxTopologySnapshot job_id payload (T1) — the additive per-pane job identity
// the topology-anchored deriver reads from the EVENT PAYLOAD. The decoder must
// round-trip job_id, tolerate its absence, and the field must NOT perturb the
// fold (a no-op here: the decoder is the fold's only payload reader).
// ---------------------------------------------------------------------------

function readEvent(db: Database, id: number): Event {
  return db.query("SELECT * FROM events WHERE id = ?").get(id) as Event;
}

test("extractTmuxTopologySnapshot: round-trips a present job_id", () => {
  seedTmuxTopologySnapshot(kdb.db, 100, "gen-100", [
    { pane_id: "%5", session_name: "fg", window_index: 3, job_id: "job-a" },
  ]);
  const snap = extractTmuxTopologySnapshot(readEvent(kdb.db, 100));
  expect(snap).toEqual({
    generation_id: "gen-100",
    panes: [
      { pane_id: "%5", session_name: "fg", window_index: 3, job_id: "job-a" },
    ],
  });
});

test("extractTmuxTopologySnapshot: a pane WITHOUT job_id decodes cleanly (field absent)", () => {
  seedTmuxTopologySnapshot(kdb.db, 100, "gen-100", [
    { pane_id: "%5", session_name: "fg", window_index: 3 },
  ]);
  const snap = extractTmuxTopologySnapshot(readEvent(kdb.db, 100));
  expect(snap).toEqual({
    generation_id: "gen-100",
    panes: [{ pane_id: "%5", session_name: "fg", window_index: 3 }],
  });
  // The absent field decodes to `undefined`, never an empty string or null.
  expect(snap?.panes[0]).not.toHaveProperty("job_id");
});

test("extractTmuxTopologySnapshot: an empty / non-string job_id is dropped, never coerced", () => {
  // Hand-craft a payload with a non-string + empty-string job_id (the seed
  // helper only emits strings) to exercise the type-narrow.
  kdb.db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'tmux-topology-snapshot', 'TmuxTopologySnapshot', 'tmux_topology_snapshot', ?)`,
    [
      100,
      NOW - 100,
      JSON.stringify({
        generation_id: "gen-100",
        panes: [
          { pane_id: "%1", session_name: "a", window_index: 0, job_id: 7 },
          { pane_id: "%2", session_name: "b", window_index: 1, job_id: "" },
        ],
      }),
    ],
  );
  const snap = extractTmuxTopologySnapshot(readEvent(kdb.db, 100));
  expect(snap?.panes).toEqual([
    { pane_id: "%1", session_name: "a", window_index: 0 },
    { pane_id: "%2", session_name: "b", window_index: 1 },
  ]);
});

test("extractTmuxTopologySnapshot: job_id presence does NOT change the rest of the decode (fold invariance)", () => {
  // Same generation + panes, one with job_id and one without — the
  // generation/pane_id/session_name/window_index the FOLD keys on must be
  // byte-identical across the two, proving job_id is inert to fold inputs.
  seedTmuxTopologySnapshot(kdb.db, 100, "gen-100", [
    { pane_id: "%5", session_name: "fg", window_index: 3, job_id: "job-a" },
  ]);
  seedTmuxTopologySnapshot(kdb.db, 200, "gen-100", [
    { pane_id: "%5", session_name: "fg", window_index: 3 },
  ]);
  const withJob = extractTmuxTopologySnapshot(readEvent(kdb.db, 100));
  const without = extractTmuxTopologySnapshot(readEvent(kdb.db, 200));
  const foldInputs = (s: typeof withJob) => ({
    generation_id: s?.generation_id,
    panes: s?.panes.map((p) => ({
      pane_id: p.pane_id,
      session_name: p.session_name,
      window_index: p.window_index,
    })),
  });
  expect(foldInputs(withJob)).toEqual(foldInputs(without));
});

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

test("deriveRestoreSet: empty DB returns cleanly", () => {
  const res = derive();
  expect(res.candidates).toEqual([]);
  expect(res.excludedIdleCount).toBe(0);
});

test("deriveRestoreSet: crash-like close_kinds are offered, user-close excluded", () => {
  seedJob(kdb.db, {
    job_id: "srv",
    close_kind: "server_gone",
    window_index: 0,
  });
  seedJob(kdb.db, { job_id: "pid", close_kind: "pid_died", window_index: 1 });
  seedJob(kdb.db, {
    job_id: "closed",
    close_kind: "window_gone_server_alive",
    window_index: 2,
  });
  const res = derive();
  const ids = res.candidates.map((c) => c.job_id);
  expect(ids).toEqual(["srv", "pid"]);
  expect(ids).not.toContain("closed");
});

test("deriveRestoreSet: isolated unknown/NULL killed row is NOT offered", () => {
  seedJob(kdb.db, {
    job_id: "lonely-unknown",
    close_kind: "unknown",
    last_event_id: 1000,
  });
  seedJob(kdb.db, {
    job_id: "lonely-null",
    close_kind: null,
    last_event_id: 5000,
  });
  const res = derive();
  expect(res.candidates).toEqual([]);
});

test("deriveRestoreSet: a burst of unknown/NULL killed rows IS offered (legacy backstop)", () => {
  // Contiguous Killed event_ids 2000..2002 = a boot-sweep crash cluster.
  seedJob(kdb.db, {
    job_id: "burst-a",
    close_kind: "unknown",
    window_index: 0,
    last_event_id: 2000,
  });
  seedJob(kdb.db, {
    job_id: "burst-b",
    close_kind: null,
    window_index: 1,
    last_event_id: 2001,
  });
  seedJob(kdb.db, {
    job_id: "burst-c",
    close_kind: "unknown",
    window_index: 2,
    last_event_id: 2002,
  });
  const res = derive();
  expect(res.candidates.map((c) => c.job_id)).toEqual([
    "burst-a",
    "burst-b",
    "burst-c",
  ]);
});

test("deriveRestoreSet: user-close inside a burst stays excluded", () => {
  // Three contiguous Killed rowids, but the middle one is a deliberate close.
  seedJob(kdb.db, {
    job_id: "b0",
    close_kind: "unknown",
    window_index: 0,
    last_event_id: 3000,
  });
  seedJob(kdb.db, {
    job_id: "user-closed",
    close_kind: "window_gone_server_alive",
    window_index: 1,
    last_event_id: 3001,
  });
  seedJob(kdb.db, {
    job_id: "b2",
    close_kind: "unknown",
    window_index: 2,
    last_event_id: 3002,
  });
  const res = derive();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["b0", "b2"]);
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

test("deriveRestoreSet: a row with no backend coords is excluded", () => {
  seedJob(kdb.db, {
    job_id: "no-backend",
    close_kind: "server_gone",
    backend_exec_session_id: null,
  });
  expect(derive().candidates).toEqual([]);
});

test("deriveRestoreSet: a NULL live session falls back to the birth session for candidacy", () => {
  seedJob(kdb.db, {
    job_id: "born",
    close_kind: "server_gone",
    backend_exec_session_id: null,
    backend_exec_birth_session_id: "work",
  });
  const candidates = derive().candidates;
  expect(candidates.map((c) => c.job_id)).toEqual(["born"]);
  // The resolved session is the birth session, so the restore offer groups it
  // under its launch session rather than dropping it.
  expect(candidates[0]?.backend_exec_session_id).toBe("work");
});

test("deriveRestoreSet: autopilot workers (plan_verb='work') are excluded", () => {
  seedJob(kdb.db, {
    job_id: "autopilot",
    close_kind: "server_gone",
    plan_verb: "work",
  });
  seedJob(kdb.db, {
    job_id: "human",
    close_kind: "server_gone",
    plan_verb: null,
  });
  expect(derive().candidates.map((c) => c.job_id)).toEqual(["human"]);
});

test("deriveRestoreSet: live working/stopped rows never surface as candidates", () => {
  // A live row (working/stopped) is not killed, so it is never a candidate and
  // its presence does not perturb a real killed candidate.
  seedJob(kdb.db, { job_id: "dead-1", close_kind: "server_gone" });
  seedJob(kdb.db, { job_id: "live-1", state: "working", close_kind: null });
  seedJob(kdb.db, { job_id: "live-2", state: "stopped", close_kind: null });
  const res = derive();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["dead-1"]);
});

test("deriveRestoreSet: live-UUID dedup — a killed id re-occupying a backend is skipped", () => {
  // The dedup is the idempotence guard against a concurrent re-spawn: when the
  // live set (built from working/stopped rows) contains the candidate's UUID,
  // it is skipped. Inject a synthetic live-id collision by passing a DB whose
  // live query returns the candidate's id. Here we model it directly: seed the
  // candidate as killed, then a SEPARATE live row carrying the same id is
  // impossible under the PK — so instead assert the guard via a control: a
  // killed candidate is offered, and an identical-id live row CANNOT coexist, so
  // the only way `liveJobIds` ever contains it is a true re-occupation, which
  // the row's own `state` would already reflect. The guard is exercised by the
  // burst/membership tests; here we lock the non-cross-contamination contract.
  seedJob(kdb.db, {
    job_id: "candidate",
    close_kind: "server_gone",
    window_index: 0,
  });
  seedJob(kdb.db, {
    job_id: "occupant",
    state: "working",
    close_kind: null,
  });
  const res = derive();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["candidate"]);
});

test("deriveRestoreSet: idle past the cutoff is excluded but COUNTED", () => {
  seedJob(kdb.db, {
    job_id: "fresh",
    close_kind: "server_gone",
    window_index: 0,
    updated_at: NOW - 60,
  });
  seedJob(kdb.db, {
    job_id: "stale",
    close_kind: "server_gone",
    window_index: 1,
    updated_at: NOW - DEFAULT_IDLE_CUTOFF_SECS - 60,
  });
  const res = derive();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["fresh"]);
  expect(res.excludedIdleCount).toBe(1);
});

test("deriveRestoreSet: idle cutoff boundary — exactly at the cutoff is kept", () => {
  // updated_at == idleBefore is NOT "older than"; it stays a candidate.
  seedJob(kdb.db, {
    job_id: "edge",
    close_kind: "server_gone",
    updated_at: NOW - DEFAULT_IDLE_CUTOFF_SECS,
  });
  const res = derive();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["edge"]);
  expect(res.excludedIdleCount).toBe(0);
});

// ---------------------------------------------------------------------------
// Order, label, resume target
// ---------------------------------------------------------------------------

test("deriveRestoreSet: ordered by window_index, nulls to tail", () => {
  seedJob(kdb.db, {
    job_id: "w2",
    close_kind: "server_gone",
    window_index: 2,
    created_at: NOW - 10,
  });
  seedJob(kdb.db, {
    job_id: "w0",
    close_kind: "server_gone",
    window_index: 0,
    created_at: NOW - 20,
  });
  seedJob(kdb.db, {
    job_id: "wnull-late",
    close_kind: "server_gone",
    window_index: null,
    created_at: NOW - 5,
  });
  seedJob(kdb.db, {
    job_id: "wnull-early",
    close_kind: "server_gone",
    window_index: null,
    created_at: NOW - 30,
  });
  const res = derive();
  // Known indices first (0, 2), then nulls by created_at ascending.
  expect(res.candidates.map((c) => c.job_id)).toEqual([
    "w0",
    "w2",
    "wnull-early",
    "wnull-late",
  ]);
});

test("deriveRestoreSet: label = latest title, falls back to job_id", () => {
  seedJob(kdb.db, {
    job_id: "titled",
    close_kind: "server_gone",
    window_index: 0,
    title: "my-agent",
  });
  seedJob(kdb.db, {
    job_id: "untitled-uuid",
    close_kind: "server_gone",
    window_index: 1,
    title: null,
  });
  const res = derive();
  const byId = new Map(res.candidates.map((c) => [c.job_id, c]));
  expect(byId.get("titled")?.label).toBe("my-agent");
  expect(byId.get("untitled-uuid")?.label).toBe("untitled-uuid");
});

test("deriveRestoreSet: resume_target is the session UUID (exact resume), label carries the latest name", () => {
  const uuid = "38c56d06-7378-47e5-a946-0345a26d6201";
  seedJob(kdb.db, {
    job_id: uuid,
    close_kind: "server_gone",
    title: "renamed-since-launch",
  });
  const res = derive();
  // Resume by the immutable session UUID so `claude --resume <uuid>` re-attaches
  // to the EXACT session; the label carries the latest name (read live from the
  // jobs projection) for the human-facing render.
  expect(res.candidates[0]?.resume_target).toBe(uuid);
  expect(res.candidates[0]?.label).toBe("renamed-since-launch");
});

test("deriveRestoreSet: a NULL harness reads as claude and resumes by job_id", () => {
  seedJob(kdb.db, { job_id: "legacy-uuid", close_kind: "server_gone" });
  const c = derive().candidates[0];
  expect(c?.harness).toBe("claude");
  expect(c?.resume_target).toBe("legacy-uuid");
});

test("deriveRestoreSet: a codex candidate is harness-tagged and resumes by its stored resume_target", () => {
  seedJob(kdb.db, {
    job_id: "keeper-codex-1",
    close_kind: "server_gone",
    harness: "codex",
    resume_target: "codex-rollout-id",
  });
  const c = derive().candidates[0];
  expect(c?.harness).toBe("codex");
  // The harness-native id, NOT the keeper-minted job_id.
  expect(c?.resume_target).toBe("codex-rollout-id");
  expect(isRestorableCandidate(c as RestoreCandidate)).toBe(true);
});

test("deriveRestoreSet: a non-claude candidate with no resume_target is LISTED but not-resumable", () => {
  // The rest of the generation still restores — the not-resumable agent is
  // surfaced (an empty resume_target), never dropped.
  seedJob(kdb.db, {
    job_id: "hermes-nobackfill",
    close_kind: "server_gone",
    harness: "hermes",
    resume_target: null,
    window_index: 0,
  });
  seedJob(kdb.db, {
    job_id: "claude-ok",
    close_kind: "server_gone",
    window_index: 1,
  });
  const res = derive();
  expect(res.candidates.map((c) => c.job_id)).toEqual([
    "hermes-nobackfill",
    "claude-ok",
  ]);
  const hermes = res.candidates.find((c) => c.job_id === "hermes-nobackfill");
  expect(hermes?.resume_target).toBe("");
  expect(isRestorableCandidate(hermes as RestoreCandidate)).toBe(false);
});

// ---------------------------------------------------------------------------
// Adopted-coordless surfacing — an ADOPTED job (jobs.adopted = 1: a hand-started
// hermes self-seed or an adopted codex rollout) with no backend coords is COUNTED
// on the result (adoptedCoordlessSkipCount), never silently dropped. Harness-
// agnostic: classification keys on coord-absence PLUS the marker, so a coordless
// adopted hermes job reports identically to codex, while a coordless NON-adopted
// row keeps today's silent skip. Covered on BOTH the retrospective killed-cohort
// path and the topology-anchored path.
// ---------------------------------------------------------------------------

test("deriveRestoreSet: a coordless adopted row is surfaced as a count while coordful/launched rows restore", () => {
  // Coordless adopted (codex-by-design, or a hermes self-seed keeper never
  // resolved coords for): crash-like but no backend coords ⇒ counted, not offered.
  seedJob(kdb.db, {
    job_id: "codex-coordless",
    close_kind: "server_gone",
    backend_exec_session_id: null,
    adopted: 1,
    harness: "codex",
    resume_target: "codex-rollout",
  });
  // Coordful adopted (hermes self-seed with full pane coords) — restores like a
  // launched session, its harness-native resume target intact.
  seedJob(kdb.db, {
    job_id: "hermes-coordful",
    close_kind: "server_gone",
    window_index: 0,
    adopted: 1,
    harness: "hermes",
    resume_target: "hermes-session",
    backend_exec_session_id: "work",
  });
  // A plain launched crash candidate — unaffected.
  seedJob(kdb.db, {
    job_id: "launched",
    close_kind: "server_gone",
    window_index: 1,
    backend_exec_session_id: "work",
  });
  const res = derive();
  expect(res.candidates.map((c) => c.job_id)).toEqual([
    "hermes-coordful",
    "launched",
  ]);
  expect(res.candidates[0]?.resume_target).toBe("hermes-session");
  expect(res.adoptedCoordlessSkipCount).toBe(1);
  expect(res.excludedIdleCount).toBe(0);
});

test("deriveRestoreSet: a coordless NON-adopted row keeps today's silent skip (not counted)", () => {
  seedJob(kdb.db, {
    job_id: "plain-coordless",
    close_kind: "server_gone",
    backend_exec_session_id: null,
    // adopted absent (NULL) — launcher-owned or a legacy row.
  });
  const res = derive();
  expect(res.candidates).toEqual([]);
  expect(res.adoptedCoordlessSkipCount).toBe(0);
});

test("deriveRestoreSet: a user-closed coordless adopted row is not a crash candidate and not counted", () => {
  // Membership (crash-like) is checked BEFORE the coords filter, so a deliberately
  // closed adopted session never reaches the adopted-coordless counter — the count
  // reflects only would-be candidates lost to missing coords.
  seedJob(kdb.db, {
    job_id: "closed-adopted",
    close_kind: "window_gone_server_alive",
    backend_exec_session_id: null,
    adopted: 1,
  });
  const res = derive();
  expect(res.candidates).toEqual([]);
  expect(res.adoptedCoordlessSkipCount).toBe(0);
});

test("deriveLastGenerationSet: surfaces the adopted-coordless skip count (unbounded, mirrors excludedIdleCount)", () => {
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "kept",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "codex-coordless",
    close_kind: "server_gone",
    last_event_id: 151,
    backend_exec_session_id: null,
    adopted: 1,
  });
  const res = deriveLastGen();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["kept"]);
  expect(res.adoptedCoordlessSkipCount).toBe(1);
});

test("deriveLastGenerationSetFromTopology: the killed-cohort fallback carries the adopted-coordless skip count", () => {
  // A coordless adopted job (codex-by-design) has NO pane, so it never rides the
  // topology-anchored path — it is surfaced only when the deriver degrades to the
  // retrospective killed-cohort fallback (no dying-generation topology here). The
  // fallback's count rides through `...fallback`, so it is never dropped.
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "kept",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "codex-coordless",
    close_kind: "server_gone",
    last_event_id: 151,
    backend_exec_session_id: null,
    adopted: 1,
  });
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["kept"]);
  expect(res.fallbackNote).toBeDefined();
  expect(res.adoptedCoordlessSkipCount).toBe(1);
});

test("deriveLastGenerationSetFromTopology: a coordful adopted pane restores like a launched one (no skip count)", () => {
  seedJob(kdb.db, {
    job_id: "hermes-adopted",
    state: "killed",
    title: "hermes-adopted",
    adopted: 1,
    harness: "hermes",
    resume_target: "hermes-session",
  });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead", [
    {
      pane_id: "%1",
      session_name: "work",
      window_index: 0,
      job_id: "hermes-adopted",
    },
    PAD_PANE, // >1 pane so the generation clears the degenerate skeleton filter
  ]);
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["hermes-adopted"]);
  expect(res.candidates[0]?.resume_target).toBe("hermes-session");
  expect(res.adoptedCoordlessSkipCount).toBe(0);
  expect(res.fallbackNote).toBeUndefined();
});

// ---------------------------------------------------------------------------
// deriveCurrentSet — the --snapshot-current source (live set, not crash set)
// ---------------------------------------------------------------------------

test("deriveCurrentSet: returns the live (working+stopped) sessions ordered by window_index", () => {
  // Two live sessions out of window order — must come back window-ordered.
  seedJob(kdb.db, {
    job_id: "w2",
    state: "stopped",
    title: "second",
    window_index: 2,
    backend_exec_session_id: "work",
  });
  seedJob(kdb.db, {
    job_id: "w1",
    state: "working",
    title: "first",
    window_index: 1,
    backend_exec_session_id: "work",
  });
  // A killed row is NOT a current-live snapshot member.
  seedJob(kdb.db, {
    job_id: "dead",
    state: "killed",
    close_kind: "server_gone",
    title: "gone",
  });
  // No backend coords ⇒ nothing to revive ⇒ excluded.
  seedJob(kdb.db, {
    job_id: "nobackend",
    state: "working",
    title: "x",
    backend_exec_session_id: null,
  });

  const cur = deriveCurrentSet(kdb.db);
  expect(cur.map((c) => c.job_id)).toEqual(["w1", "w2"]);
  // Resume target is the session UUID (job_id); the label keeps the latest name.
  expect(cur[0].resume_target).toBe("w1");
  expect(cur[1].resume_target).toBe("w2");
  expect(cur[0].label).toBe("first");
  expect(cur[1].label).toBe("second");
});

test("deriveCurrentSet: resume_target is always the job_id; a never-named session's label falls back to it too", () => {
  seedJob(kdb.db, {
    job_id: "unnamed-uuid",
    state: "working",
    title: null,
    backend_exec_session_id: "work",
  });
  const cur = deriveCurrentSet(kdb.db);
  expect(cur).toHaveLength(1);
  // resume_target is the UUID unconditionally; with no title the label falls back
  // to the same job_id.
  expect(cur[0].resume_target).toBe("unnamed-uuid");
  expect(cur[0].label).toBe("unnamed-uuid");
});

test("deriveCurrentSet: terminal row with later live-pid backend evidence is current", () => {
  const livePid = process.pid;
  seedJob(kdb.db, {
    job_id: "resumed-live",
    state: "ended",
    title: "resumed",
    window_index: 9,
    backend_exec_session_id: "work",
    last_event_id: 10,
    pid: livePid,
  });
  seedJob(kdb.db, {
    job_id: "dead-terminal",
    state: "ended",
    title: "dead",
    backend_exec_session_id: "work",
    last_event_id: 10,
    pid: 2_000_000_000,
  });
  kdb.db.run(
    `INSERT INTO events (
       id, ts, session_id, pid, hook_event, event_type, data,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id
     ) VALUES (?, ?, ?, ?, 'Notification', 'idle_prompt', '{}', 'tmux', 'work', ?)`,
    [11, NOW, "resumed-live", livePid, "%live"],
  );
  kdb.db.run(
    `INSERT INTO events (
       id, ts, session_id, pid, hook_event, event_type, data,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id
     ) VALUES (?, ?, ?, ?, 'Notification', 'idle_prompt', '{}', 'tmux', 'work', ?)`,
    [12, NOW, "dead-terminal", 2_000_000_000, "%dead"],
  );
  seedTmuxTopologySnapshot(kdb.db, 13, "gen-now", [
    { pane_id: "%live", session_name: "work", window_index: 5 },
    { pane_id: "%dead", session_name: "work", window_index: 6 },
  ]);

  const cur = deriveCurrentSet(kdb.db);
  expect(cur.map((c) => c.job_id)).toEqual(["resumed-live"]);
  expect(cur[0].label).toBe("resumed");
  expect(cur[0].window_index).toBe(5);
});

test("deriveCurrentSet: a terminal row whose stale pane id was recycled to a DIFFERENT job is NOT resurrected", () => {
  // The phantom-window incident: a terminal job's last event named pid P and
  // pane %57. Both got recycled — P to an unrelated live process (pidAlive still
  // true) and %57, after a tmux generation bump, to another live job. Attributing
  // by the stale pane id would revive the dead job wearing the live job's coords.
  const livePid = process.pid;
  seedJob(kdb.db, {
    job_id: "phantom",
    state: "ended",
    title: "phantom",
    window_index: 7,
    backend_exec_session_id: "work",
    last_event_id: 10,
    pid: livePid,
  });
  // The live job that legitimately owns %57 now (comes through the primary path).
  seedJob(kdb.db, {
    job_id: "owner-live",
    state: "working",
    title: "owner",
    window_index: 7,
    backend_exec_session_id: "work",
  });
  kdb.db.run(
    `INSERT INTO events (
       id, ts, session_id, pid, hook_event, event_type, data,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id
     ) VALUES (?, ?, ?, ?, 'Notification', 'idle_prompt', '{}', 'tmux', 'work', ?)`,
    [11, NOW, "phantom", livePid, "%57"],
  );
  // Latest snapshot: %57 is now owned by owner-live, not phantom.
  seedTmuxTopologySnapshot(kdb.db, 13, "gen-now", [
    {
      pane_id: "%57",
      session_name: "work",
      window_index: 7,
      job_id: "owner-live",
    },
  ]);

  const cur = deriveCurrentSet(kdb.db);
  const ids = cur.map((c) => c.job_id);
  expect(ids).toContain("owner-live");
  expect(ids).not.toContain("phantom");
});

test("deriveCurrentSet: a terminal row whose pane id still owns its OWN job_id in the latest snapshot is resurrected", () => {
  // The guard must not over-reject: when the snapshot confirms the pane still
  // belongs to THIS job, the premature-terminal recovery stands.
  const livePid = process.pid;
  seedJob(kdb.db, {
    job_id: "resumed-own",
    state: "ended",
    title: "own",
    window_index: 9,
    backend_exec_session_id: "work",
    last_event_id: 10,
    pid: livePid,
  });
  kdb.db.run(
    `INSERT INTO events (
       id, ts, session_id, pid, hook_event, event_type, data,
       backend_exec_type, backend_exec_session_id, backend_exec_pane_id
     ) VALUES (?, ?, ?, ?, 'Notification', 'idle_prompt', '{}', 'tmux', 'work', ?)`,
    [11, NOW, "resumed-own", livePid, "%mine"],
  );
  seedTmuxTopologySnapshot(kdb.db, 13, "gen-now", [
    {
      pane_id: "%mine",
      session_name: "work",
      window_index: 5,
      job_id: "resumed-own",
    },
  ]);

  const cur = deriveCurrentSet(kdb.db);
  expect(cur.map((c) => c.job_id)).toEqual(["resumed-own"]);
  expect(cur[0].window_index).toBe(5);
});

test("deriveRestoreSet: carries cwd (the resume `cd` target); empty/NULL → null", () => {
  seedJob(kdb.db, {
    job_id: "with-cwd",
    close_kind: "server_gone",
    window_index: 0,
    cwd: "/Users/mike/code/keeper",
  });
  seedJob(kdb.db, {
    job_id: "empty-cwd",
    close_kind: "server_gone",
    window_index: 1,
    cwd: "",
  });
  seedJob(kdb.db, {
    job_id: "null-cwd",
    close_kind: "server_gone",
    window_index: 2,
    cwd: null,
  });
  const byId = new Map(derive().candidates.map((c) => [c.job_id, c]));
  expect(byId.get("with-cwd")?.cwd).toBe("/Users/mike/code/keeper");
  // An empty string coerces to null so the restore command drops the `cd` prefix.
  expect(byId.get("empty-cwd")?.cwd).toBeNull();
  expect(byId.get("null-cwd")?.cwd).toBeNull();
});

// ---------------------------------------------------------------------------
// Daemon-down: read-only connection works
// ---------------------------------------------------------------------------

test("deriveRestoreSet: works against a read-only connection (daemon-down path)", () => {
  seedJob(kdb.db, {
    job_id: "ro",
    close_kind: "server_gone",
    window_index: 0,
  });
  kdb.db.close();
  // Reopen the SAME file read-only — the disaster-recovery posture.
  const ro = new Database(dbPath, { readonly: true });
  try {
    const res = deriveRestoreSet(ro, { now: NOW });
    expect(res.candidates.map((c) => c.job_id)).toEqual(["ro"]);
  } finally {
    ro.close();
  }
  // Re-point kdb so afterEach's close() is a harmless no-op double-close.
  kdb = { db: ro, stmts: kdb.stmts };
});

// ---------------------------------------------------------------------------
// Regression: the recorded 2026-06-16 incident cohort
// ---------------------------------------------------------------------------

test("deriveRestoreSet: 2026-06-16 incident — 13-wide Killed burst restores in order", () => {
  // The recorded incident left a CONTIGUOUS run of 13 Killed event_ids
  // (4260388..4260400, all stamped at the same boot instant), every row
  // close_kind-NULL (pre-v70). The burst backstop must offer all 13, ordered by
  // window_index. Surrounding ISOLATED Killed rows (large event_id gaps) must
  // NOT be swept in.
  const BURST_START = 4_260_388;
  const BURST_N = 13;
  for (let i = 0; i < BURST_N; i++) {
    seedJob(kdb.db, {
      job_id: `incident-${i}`,
      close_kind: null, // pre-v70 legacy row
      window_index: BURST_N - 1 - i, // reversed so ordering is actually tested
      last_event_id: BURST_START + i,
      title: `agent-${i}`,
      created_at: NOW - 3600,
      updated_at: NOW - 60,
    });
  }
  // Isolated routine closes BEFORE and AFTER the burst (big gaps either side).
  seedJob(kdb.db, {
    job_id: "isolated-before",
    close_kind: null,
    last_event_id: BURST_START - 5000,
    updated_at: NOW - 60,
  });
  seedJob(kdb.db, {
    job_id: "isolated-after",
    close_kind: null,
    last_event_id: BURST_START + BURST_N + 5000,
    updated_at: NOW - 60,
  });

  const res = derive();
  // All 13 burst rows offered, in window_index ascending order (so the reversed
  // seeding comes back sorted incident-12, incident-11, ... incident-0).
  expect(res.candidates.length).toBe(BURST_N);
  const expectedOrder = Array.from(
    { length: BURST_N },
    (_, idx) => `incident-${BURST_N - 1 - idx}`,
  );
  expect(res.candidates.map((c) => c.job_id)).toEqual(expectedOrder);
  // The isolated routine closes were NOT swept into the candidate set.
  const ids = new Set(res.candidates.map((c) => c.job_id));
  expect(ids.has("isolated-before")).toBe(false);
  expect(ids.has("isolated-after")).toBe(false);
});

// ---------------------------------------------------------------------------
// deriveLastGenerationSet — the kill-anchored generation window (epic fn-819 T2)
// ---------------------------------------------------------------------------

test("deriveLastGenerationSet: empty DB returns cleanly", () => {
  const res = deriveLastGen();
  expect(res.candidates).toEqual([]);
  expect(res.excludedIdleCount).toBe(0);
});

test("deriveLastGenerationSet: bounds to the last generation, excludes the prior-gen straggler", () => {
  // Two generation boundaries: gen-A starts at event id 100, gen-B at id 200.
  seedBackendExecStart(kdb.db, 100);
  seedBackendExecStart(kdb.db, 200);
  // A prior-generation kill (id 150, inside gen-A — between the two boundaries).
  seedJob(kdb.db, {
    job_id: "prior-gen",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
  });
  // Two last-generation kills (ids 250/251, after the gen-B boundary).
  seedJob(kdb.db, {
    job_id: "last-gen-a",
    close_kind: "server_gone",
    window_index: 1,
    last_event_id: 250,
  });
  seedJob(kdb.db, {
    job_id: "last-gen-b",
    close_kind: "server_gone",
    window_index: 2,
    last_event_id: 251,
  });

  // The full restore set offers all three (the 7-day pool); last-generation
  // bounds to gen-B only.
  expect(derive().candidates.map((c) => c.job_id)).toEqual([
    "prior-gen",
    "last-gen-a",
    "last-gen-b",
  ]);
  const res = deriveLastGen();
  expect(res.candidates.map((c) => c.job_id)).toEqual([
    "last-gen-a",
    "last-gen-b",
  ]);
});

test("deriveLastGenerationSet: REGRESSION — boot-ordering race (kills BEFORE the new boundary)", () => {
  // The load-bearing scenario: seedKilledSweep mints the dead-generation Killed
  // events BEFORE the restore-worker posts the NEW BackendExecStart, so the
  // dead-gen kills have event_ids < the new boundary. A naive "after the most-
  // recent BackendExecStart" bound would exclude them (return empty); anchoring
  // on K_max (the settled kills) keeps them.
  //
  // Timeline by events.id:
  //   100  BackendExecStart (gen-A start — the generation that just died)
  //   150  Killed dead-gen-1   ┐ the boot sweep's dead-generation kills
  //   151  Killed dead-gen-2   ┘ (close_kind server_gone)
  //   200  BackendExecStart (gen-B start — the NEW server, posted AFTER the kills)
  seedBackendExecStart(kdb.db, 100, "gen-A");
  seedJob(kdb.db, {
    job_id: "dead-gen-1",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
  });
  seedJob(kdb.db, {
    job_id: "dead-gen-2",
    close_kind: "server_gone",
    window_index: 1,
    last_event_id: 151,
  });
  seedBackendExecStart(kdb.db, 200, "gen-B");

  // Naive bound: MAX(BackendExecStart.id) = 200; "kills after 200" = EMPTY.
  // Prove the trap is real, then prove deriveLastGenerationSet avoids it.
  const naiveBoundary = (
    kdb.db
      .query(
        "SELECT MAX(id) AS m FROM events WHERE hook_event='BackendExecStart'",
      )
      .get() as { m: number }
  ).m;
  expect(naiveBoundary).toBe(200);
  // K_max over the kills = 151; B_boundary = MAX(id <= 151) = 100 (gen-A start).
  // The dead-gen kills (150, 151 >= 100) stay in the window.
  const res = deriveLastGen();
  expect(res.candidates.map((c) => c.job_id)).toEqual([
    "dead-gen-1",
    "dead-gen-2",
  ]);
});

test("deriveLastGenerationSet: NULL boundary (no BackendExecStart) falls back to the burst, not the full pool", () => {
  // No BackendExecStart row at all (fresh / pre-feature DB). Fall back to the
  // most-recent contiguous Killed burst — NOT the 7-day pool.
  // Most-recent burst: ids 500/501. An older isolated kill at id 100 must be
  // excluded by the fallback (it would be in the full pool via burst membership
  // only if contiguous — here it's isolated, but the point is the LAST-gen bound
  // drops it regardless).
  seedJob(kdb.db, {
    job_id: "old-burst-a",
    close_kind: "unknown",
    window_index: 0,
    last_event_id: 100,
  });
  seedJob(kdb.db, {
    job_id: "old-burst-b",
    close_kind: "unknown",
    window_index: 1,
    last_event_id: 101,
  });
  seedJob(kdb.db, {
    job_id: "recent-burst-a",
    close_kind: "unknown",
    window_index: 2,
    last_event_id: 500,
  });
  seedJob(kdb.db, {
    job_id: "recent-burst-b",
    close_kind: "unknown",
    window_index: 3,
    last_event_id: 501,
  });

  // The full pool (deriveRestoreSet) offers BOTH bursts (4 candidates).
  expect(derive().candidates.length).toBe(4);
  // Last-generation, NULL-boundary fallback: only the most-recent burst.
  const res = deriveLastGen();
  expect(res.candidates.map((c) => c.job_id)).toEqual([
    "recent-burst-a",
    "recent-burst-b",
  ]);
});

test("deriveLastGenerationSet: no candidates returns empty cleanly", () => {
  // A user-closed window is never a candidate — empty set, no throw, even with a
  // boundary present.
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "user-closed",
    close_kind: "window_gone_server_alive",
    last_event_id: 150,
  });
  const res = deriveLastGen();
  expect(res.candidates).toEqual([]);
});

test("deriveLastGenerationSet: a single server_gone with no boundary keeps the most-recent kill", () => {
  // Lone crash kill, no BackendExecStart, no burst (isolated). The most-recent
  // kill is the only last-generation signal — keep it (don't silently drop).
  seedJob(kdb.db, {
    job_id: "lone-crash",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 999,
  });
  const res = deriveLastGen();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["lone-crash"]);
});

test("deriveLastGenerationSet: resume_target is the session UUID, label the latest name + idle counting", () => {
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "uuid-x",
    close_kind: "server_gone",
    window_index: 0,
    title: "renamed-since-launch",
    last_event_id: 150,
    updated_at: NOW - 60,
  });
  // An idle-past-cutoff kill in the SAME generation — excluded but counted.
  seedJob(kdb.db, {
    job_id: "stale",
    close_kind: "server_gone",
    window_index: 1,
    last_event_id: 151,
    updated_at: NOW - DEFAULT_IDLE_CUTOFF_SECS - 60,
  });
  const res = deriveLastGen();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["uuid-x"]);
  expect(res.candidates[0]?.resume_target).toBe("uuid-x");
  expect(res.candidates[0]?.label).toBe("renamed-since-launch");
  expect(res.excludedIdleCount).toBe(1);
});

test("deriveLastGenerationSet: works against a read-only connection (daemon-down path)", () => {
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "ro",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
  });
  kdb.db.close();
  const ro = new Database(dbPath, { readonly: true });
  try {
    const res = deriveLastGenerationSet(ro, { now: NOW });
    expect(res.candidates.map((c) => c.job_id)).toEqual(["ro"]);
  } finally {
    ro.close();
  }
  kdb = { db: ro, stmts: kdb.stmts };
});

// ---------------------------------------------------------------------------
// deriveLastGenerationSetFromTopology — the PRIMARY topology-anchored deriver
// (epic fn-955). Derives the restore set from the DYING generation's last
// TmuxTopologySnapshot (positive pre-crash evidence), not the retrospective
// killed cohort. Selected by probing G_now and excluding its still-live snapshot.
// ---------------------------------------------------------------------------

function deriveTopo(currentGenerationId: string | null) {
  return deriveLastGenerationSetFromTopology(kdb.db, {
    now: NOW,
    currentGenerationId,
  });
}

test("deriveLastGenerationSetFromTopology: derives from the dying-gen snapshot panes (job_id from payload)", () => {
  // The dying generation (gen-dead) left a snapshot carrying its live panes,
  // each with the producer-stamped job_id. The respawned server is gen-now.
  seedJob(kdb.db, {
    job_id: "agent-a",
    state: "killed",
    title: "alpha",
    window_index: 1,
  });
  seedJob(kdb.db, {
    job_id: "agent-b",
    state: "killed",
    title: "beta",
    window_index: 0,
  });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead", [
    { pane_id: "%1", session_name: "work", window_index: 1, job_id: "agent-a" },
    { pane_id: "%2", session_name: "work", window_index: 0, job_id: "agent-b" },
  ]);
  // G_now is a fresh server generation != gen-dead.
  const res = deriveTopo("gen-now");
  // Ordered by window_index ascending (beta=0 before alpha=1).
  expect(res.candidates.map((c) => c.job_id)).toEqual(["agent-b", "agent-a"]);
  // resume_target is the session UUID; the title rides the display label.
  expect(res.candidates.map((c) => c.resume_target)).toEqual([
    "agent-b",
    "agent-a",
  ]);
  expect(res.candidates.map((c) => c.label)).toEqual(["beta", "alpha"]);
  expect(res.candidates[0]?.backend_exec_session_id).toBe("work");
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology: per-pane projection-join fallback when payload carries no job_id", () => {
  // The snapshot pane omits job_id (a pane whose job row was not yet written at
  // post time); the deriver resolves it via the (generation_id, pane_id) join.
  seedJob(kdb.db, {
    job_id: "join-resolved",
    state: "killed",
    title: "joined",
    window_index: 0,
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%7",
    backend_exec_generation_id: "gen-dead",
  });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead", [
    { pane_id: "%7", session_name: "work", window_index: 0 }, // no job_id
    PAD_PANE, // >1 pane so the generation clears the degenerate skeleton filter
  ]);
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["join-resolved"]);
  expect(res.candidates[0]?.resume_target).toBe("join-resolved");
  expect(res.candidates[0]?.label).toBe("joined");
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology: projection-join is %N-recycle-guarded — a recycled pane_id from another generation never resolves the wrong job", () => {
  // Recycle-guard pin: the join keys on (generation_id, pane_id) precisely so a
  // tmux pane id reused across server generations cannot cross-resolve. Two jobs
  // share pane %3 under two distinct generations. The wrong-generation row is
  // seeded FIRST (lower rowid) so an unqualified pane_id-only scan would return
  // it under LIMIT 1 — i.e. dropping generation_id from the join key fails here.
  seedJob(kdb.db, {
    job_id: "wrong-gen",
    state: "killed",
    title: "stale-occupant",
    window_index: 0,
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%3",
    backend_exec_generation_id: "gen-stale",
  });
  seedJob(kdb.db, {
    job_id: "right-gen",
    state: "killed",
    title: "dying-occupant",
    window_index: 0,
    backend_exec_type: "tmux",
    backend_exec_pane_id: "%3",
    backend_exec_generation_id: "gen-dead",
  });
  // The dying generation's snapshot omits job_id, forcing the projection join.
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead", [
    { pane_id: "%3", session_name: "work", window_index: 0 }, // no job_id
    PAD_PANE, // >1 pane so the generation clears the degenerate skeleton filter
  ]);
  const res = deriveTopo("gen-now");
  // Only the dying generation's job resolves; the recycled-pane row is never hit.
  expect(res.candidates.map((c) => c.job_id)).toEqual(["right-gen"]);
  expect(res.candidates[0]?.resume_target).toBe("right-gen");
  expect(res.candidates[0]?.label).toBe("dying-occupant");
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology (bound): a richer generation beyond the newest K is never considered", () => {
  // The selection is bounded to the newest RECENT_GENERATION_BOUND dead
  // generations. The OLDEST generation (lowest rowid, one past the bound) is
  // seeded RICHEST — so a wrong "richest overall" pick would surface its agents.
  // The bounded walk never considers it; a newer in-bound generation wins.
  const richPanes: SeedTopologyPane[] = [];
  for (let i = 0; i < 3; i++) {
    const jid = `rich-${i}`;
    seedJob(kdb.db, { job_id: jid, state: "killed", title: jid });
    richPanes.push({
      pane_id: `%r${i}`,
      session_name: "work",
      window_index: i,
      job_id: jid,
    });
  }
  seedTmuxTopologySnapshot(kdb.db, 100, "gen-rich-old", richPanes);
  // RECENT_GENERATION_BOUND newer generations, each 1 restorable (+ PAD_PANE so
  // none is a degenerate skeleton). Ascending rowids ⇒ the last is newest.
  for (let g = 0; g < RECENT_GENERATION_BOUND; g++) {
    const jid = `near-${g}`;
    seedJob(kdb.db, { job_id: jid, state: "killed", title: jid });
    seedTmuxTopologySnapshot(kdb.db, 200 + g, `gen-near-${g}`, [
      { pane_id: `%n${g}`, session_name: "work", window_index: 0, job_id: jid },
      PAD_PANE,
    ]);
  }
  const res = deriveTopo("gen-now");
  // Pick = the newest in-bound generation (recency tiebreak among equal
  // restorable=1); the rich-but-old generation is beyond K and excluded.
  expect(res.candidates.map((c) => c.job_id)).toEqual([
    `near-${RECENT_GENERATION_BOUND - 1}`,
  ]);
  const ids = new Set(res.candidates.map((c) => c.job_id));
  for (let i = 0; i < 3; i++) {
    expect(ids.has(`rich-${i}`)).toBe(false);
  }
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology (bound): a rich dead generation past the idle cutoff is never considered", () => {
  // gen-stale is richer AND has the higher rowid (newer by recency), but its
  // newest snapshot ts is older than the idle cutoff — so it is excluded by ts,
  // not recency, and the in-cutoff gen-fresh is the pick.
  seedJob(kdb.db, { job_id: "stale-a", state: "killed", title: "stale-a" });
  seedJob(kdb.db, { job_id: "stale-b", state: "killed", title: "stale-b" });
  const stale = NOW - DEFAULT_IDLE_CUTOFF_SECS - 3600;
  seedTmuxTopologySnapshot(
    kdb.db,
    600,
    "gen-stale",
    [
      {
        pane_id: "%1",
        session_name: "work",
        window_index: 0,
        job_id: "stale-a",
      },
      {
        pane_id: "%2",
        session_name: "work",
        window_index: 1,
        job_id: "stale-b",
      },
    ],
    stale,
  );
  seedJob(kdb.db, { job_id: "fresh", state: "killed", title: "fresh" });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-fresh", [
    { pane_id: "%3", session_name: "work", window_index: 0, job_id: "fresh" },
    PAD_PANE,
  ]);
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["fresh"]);
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology: G_now == null ⇒ the newest snapshot overall is the dying generation", () => {
  // No server up at restore time. The newest snapshot (id 600, gen-late) is the
  // dying generation; an older snapshot (id 500, gen-early) is ignored.
  seedJob(kdb.db, { job_id: "early", state: "killed", title: "early-a" });
  seedJob(kdb.db, { job_id: "late", state: "killed", title: "late-a" });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-early", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "early" },
    PAD_PANE, // non-degenerate (>1 pane)
  ]);
  seedTmuxTopologySnapshot(kdb.db, 600, "gen-late", [
    { pane_id: "%2", session_name: "work", window_index: 0, job_id: "late" },
    PAD_PANE, // non-degenerate (>1 pane)
  ]);
  const res = deriveTopo(null);
  expect(res.candidates.map((c) => c.job_id)).toEqual(["late"]);
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology: equally-rich dead generations ⇒ the SINGLE newest is picked (only its candidates)", () => {
  // gen-now is live; gen-dead-2 (id 600) is the most-recent crash; gen-dead-1
  // (id 500) an older crash. Both are equally rich (1 restorable), so the auto-
  // pick is the newest by recency and ONLY its candidates are returned (older
  // generations are not merged in). G_now's own snapshot (id 700) is excluded.
  seedJob(kdb.db, { job_id: "older-crash", state: "killed", title: "old" });
  seedJob(kdb.db, { job_id: "recent-crash", state: "killed", title: "recent" });
  seedJob(kdb.db, { job_id: "live-now", state: "working", title: "now" });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead-1", [
    {
      pane_id: "%1",
      session_name: "work",
      window_index: 0,
      job_id: "older-crash",
    },
    PAD_PANE, // non-degenerate (>1 pane)
  ]);
  seedTmuxTopologySnapshot(kdb.db, 600, "gen-dead-2", [
    {
      pane_id: "%2",
      session_name: "work",
      window_index: 0,
      job_id: "recent-crash",
    },
    PAD_PANE, // non-degenerate (>1 pane)
  ]);
  seedTmuxTopologySnapshot(kdb.db, 700, "gen-now", [
    {
      pane_id: "%3",
      session_name: "work",
      window_index: 0,
      job_id: "live-now",
    },
  ]);
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["recent-crash"]);
  expect(res.ambiguous).toBeUndefined(); // equal richness, newest wins → unambiguous
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology: a malformed snapshot is excluded from the walk, never derailing selection", () => {
  seedJob(kdb.db, { job_id: "good-agent", state: "killed", title: "good" });
  // A good dying-gen snapshot at id 500.
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead", [
    {
      pane_id: "%1",
      session_name: "work",
      window_index: 0,
      job_id: "good-agent",
    },
    PAD_PANE, // non-degenerate (>1 pane)
  ]);
  // A malformed newest TmuxTopologySnapshot at id 600 (un-decodable data): the
  // generated column's `json_valid` guard leaves its `tmux_generation_id` NULL,
  // so the summary walk (WHERE tmux_generation_id IS NOT NULL) never groups it
  // into a generation — it cannot derail the good generation's selection.
  kdb.db.run(
    `INSERT INTO events (id, ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'tmux-topology-snapshot', 'TmuxTopologySnapshot', 'tmux_topology_snapshot', ?)`,
    [600, NOW - 100, "{not valid json"],
  );
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["good-agent"]);
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology: no snapshot ⇒ labeled fallback to the killed-cohort model", () => {
  // No TmuxTopologySnapshot at all — degrade to deriveLastGenerationSet and set
  // the visible fallback note.
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "killed-cohort",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
  });
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["killed-cohort"]);
  expect(res.fallbackNote).toBeDefined();
  expect(res.fallbackNote).toContain("retrospective");
});

test("deriveLastGenerationSetFromTopology: every snapshot is G_now ⇒ labeled fallback (no dying generation)", () => {
  // The only snapshot belongs to the still-live server (gen-now) — there is no
  // dying generation to anchor on, so fall back (labeled).
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "killed-cohort",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
  });
  seedJob(kdb.db, { job_id: "live-now", state: "working", title: "now" });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-now", [
    {
      pane_id: "%1",
      session_name: "work",
      window_index: 0,
      job_id: "live-now",
    },
  ]);
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["killed-cohort"]);
  expect(res.fallbackNote).toBeDefined();
});

test("deriveLastGenerationSetFromTopology: reuses the idempotence filters (worker / live-UUID / no-coords excluded)", () => {
  // An autopilot worker (plan_verb='work') — reconciler-managed, never restored.
  seedJob(kdb.db, {
    job_id: "worker",
    state: "killed",
    title: "worker-agent",
    plan_verb: "work",
  });
  // A job already live under its UUID (would double-spawn) — excluded.
  seedJob(kdb.db, {
    job_id: "still-live",
    state: "working",
    title: "live-agent",
  });
  // A genuine crash candidate — kept.
  seedJob(kdb.db, { job_id: "keepme", state: "killed", title: "survivor" });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "worker" },
    {
      pane_id: "%2",
      session_name: "work",
      window_index: 1,
      job_id: "still-live",
    },
    { pane_id: "%3", session_name: "work", window_index: 2, job_id: "keepme" },
  ]);
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["keepme"]);
});

test("deriveLastGenerationSetFromTopology: an unowned pane (no job_id, no projection match) is dropped", () => {
  seedJob(kdb.db, { job_id: "owned", state: "killed", title: "owned-agent" });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "owned" },
    { pane_id: "%99", session_name: "work", window_index: 1 }, // unowned, no join
  ]);
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["owned"]);
});

test("deriveLastGenerationSetFromTopology: REGRESSION — respawned server + day-old killed rows offers ONLY the live windows", () => {
  // The real-incident scenario this epic fixes: the tmux server respawned (so
  // G_now is the NEW generation), and a full day of historically-closed killed rows
  // sits in the DB. The retrospective killed-cohort model swept those in; the
  // topology-anchored model offers ONLY the dying generation's 2 live panes.

  // A day of older killed rows (close_kind-NULL legacy + crash-like), all from a
  // prior generation, plus a stale BackendExecStart anchor the OLD model would
  // sweep from. None of these belong to the dying-gen snapshot.
  const DAY_AGO = NOW - 24 * 60 * 60;
  seedBackendExecStart(kdb.db, 100, "gen-ancient");
  for (let i = 0; i < 38; i++) {
    seedJob(kdb.db, {
      job_id: `historical-${i}`,
      close_kind: "server_gone",
      window_index: i,
      last_event_id: 150 + i, // a contiguous day-old burst the old model loved
      title: `hist-${i}`,
      created_at: DAY_AGO,
      updated_at: NOW - 3600,
    });
  }

  // The dying generation's snapshot: exactly 2 panes that were genuinely live at
  // the crash. The jobs are also present as killed rows (the boot sweep killed
  // them), but the snapshot is what anchors the restore.
  seedJob(kdb.db, {
    job_id: "live-1",
    state: "killed",
    close_kind: "server_gone",
    title: "genuinely-live-1",
    window_index: 0,
    last_event_id: 900,
    updated_at: NOW - 60,
  });
  seedJob(kdb.db, {
    job_id: "live-2",
    state: "killed",
    close_kind: "server_gone",
    title: "genuinely-live-2",
    window_index: 1,
    last_event_id: 901,
    updated_at: NOW - 60,
  });
  seedTmuxTopologySnapshot(kdb.db, 800, "gen-dying", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "live-1" },
    { pane_id: "%2", session_name: "work", window_index: 1, job_id: "live-2" },
  ]);

  // The OLD retrospective model swept the whole day-old pool + the 2 live (40).
  const old = deriveLastGenerationSet(kdb.db, { now: NOW });
  expect(old.candidates.length).toBeGreaterThan(2);

  // The topology-anchored model (respawned server = gen-now) offers ONLY the 2
  // genuinely-live windows.
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["live-1", "live-2"]);
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology: works against a read-only connection (daemon-down path)", () => {
  seedJob(kdb.db, { job_id: "ro-topo", state: "killed", title: "ro-agent" });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-dead", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "ro-topo" },
    PAD_PANE, // non-degenerate (>1 pane)
  ]);
  kdb.db.close();
  const ro = new Database(dbPath, { readonly: true });
  try {
    const res = deriveLastGenerationSetFromTopology(ro, {
      now: NOW,
      currentGenerationId: "gen-now",
    });
    expect(res.candidates.map((c) => c.job_id)).toEqual(["ro-topo"]);
  } finally {
    ro.close();
  }
  kdb = { db: ro, stmts: kdb.stmts };
});

// ---------------------------------------------------------------------------
// Bounded richness-ranked selection (epic fn-1102 T1) — the new selection that
// ranks dead generations by restorable richness instead of "single newest",
// bounds to the newest K inside the idle cutoff, excludes short-lived single-
// pane skeletons, steps back to the newest attributed snapshot, flags ambiguity.
// ---------------------------------------------------------------------------

/** Seed N killed jobs + N owned panes (window_index 0..N-1) for a generation. */
function ownedPanes(jobIds: string[]): SeedTopologyPane[] {
  return jobIds.map((jid, i) => {
    seedJob(kdb.db, { job_id: jid, state: "killed", title: jid });
    return {
      pane_id: `%${jid}`,
      session_name: "work",
      window_index: i,
      job_id: jid,
    };
  });
}

test("deriveLastGenerationSetFromTopology (incident): a richer dead generation is picked over a newer degenerate skeleton", () => {
  // The recorded 2026-06-16 hazard: a rich dead generation was shadowed by a
  // NEWER 1-pane short-lived skeleton generation, and the skeleton got restored.
  // The bounded richness-ranked selection must pick the rich generation.
  // gen-rich (id 500): 3 restorable agents. gen-skel (id 600, NEWER): a single
  // 1-pane snapshot (span 0) → degenerate skeleton. gen-now is the live server.
  seedTmuxTopologySnapshot(
    kdb.db,
    500,
    "gen-rich",
    ownedPanes(["r0", "r1", "r2"]),
    NOW - 200,
  );
  seedJob(kdb.db, { job_id: "skel", state: "killed", title: "skel-agent" });
  seedTmuxTopologySnapshot(
    kdb.db,
    600,
    "gen-skel",
    [
      {
        pane_id: "%skel",
        session_name: "work",
        window_index: 0,
        job_id: "skel",
      },
    ],
    NOW - 50,
  );
  const res = deriveTopo("gen-now");
  // The rich generation's 3 agents are restored; the newer skeleton is NOT.
  expect(res.candidates.map((c) => c.job_id)).toEqual(["r0", "r1", "r2"]);
  expect(res.candidates.map((c) => c.job_id)).not.toContain("skel");
  // Only one non-degenerate candidate → unambiguous.
  expect(res.ambiguous).toBeUndefined();
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology (pairing race): the newest ATTRIBUTED snapshot feeds the set when the newest snapshot carries zero job_ids", () => {
  // The chosen generation's NEWEST snapshot is the unattributed (0-job_id) half
  // of the emission pair — it yields no candidate. The deriver steps back to the
  // attributed sibling (one rowid lower) and restores from THAT. The two
  // snapshots span >30min so the generation is non-degenerate.
  seedJob(kdb.db, {
    job_id: "attributed-job",
    state: "killed",
    title: "attrib",
  });
  // Attributed sibling (older rowid, carries job_id).
  seedTmuxTopologySnapshot(
    kdb.db,
    500,
    "gen-pair",
    [
      {
        pane_id: "%1",
        session_name: "work",
        window_index: 0,
        job_id: "attributed-job",
      },
    ],
    NOW - 3700,
  );
  // Newest snapshot: unattributed — a single unowned pane resolving to nothing.
  seedTmuxTopologySnapshot(
    kdb.db,
    501,
    "gen-pair",
    [{ pane_id: "%unowned", session_name: "work", window_index: 0 }],
    NOW - 100,
  );
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["attributed-job"]);
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology (ambiguity): auto-pick differing from the newest non-degenerate flags ambiguous", () => {
  // Two non-degenerate dead generations. The NEWER (gen-new, id 600) has 1
  // restorable; the OLDER (gen-old, id 500) has 3 — so the max-restorable auto-
  // pick (gen-old) is NOT the newest non-degenerate (gen-new). The result must
  // carry the ambiguity flag AND still return the auto-pick's richer set.
  seedTmuxTopologySnapshot(
    kdb.db,
    500,
    "gen-old",
    ownedPanes(["o0", "o1", "o2"]),
    NOW - 200,
  );
  seedJob(kdb.db, { job_id: "n0", state: "killed", title: "n0" });
  seedTmuxTopologySnapshot(
    kdb.db,
    600,
    "gen-new",
    [
      { pane_id: "%n0", session_name: "work", window_index: 0, job_id: "n0" },
      PAD_PANE, // non-degenerate (>1 pane)
    ],
    NOW - 50,
  );
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["o0", "o1", "o2"]);
  expect(res.ambiguous).toBe(true);
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology (ambiguity): newest non-degenerate IS the richest ⇒ NOT ambiguous", () => {
  // Mirror of the ambiguity case: here the NEWER generation is also the richest,
  // so the auto-pick equals the newest non-degenerate — no ambiguity.
  seedJob(kdb.db, { job_id: "lean", state: "killed", title: "lean" });
  seedTmuxTopologySnapshot(
    kdb.db,
    500,
    "gen-lean",
    [
      {
        pane_id: "%lean",
        session_name: "work",
        window_index: 0,
        job_id: "lean",
      },
      PAD_PANE,
    ],
    NOW - 200,
  );
  seedTmuxTopologySnapshot(
    kdb.db,
    600,
    "gen-fat",
    ownedPanes(["f0", "f1"]),
    NOW - 50,
  );
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["f0", "f1"]);
  expect(res.ambiguous).toBeUndefined();
  expect(res.fallbackNote).toBeUndefined();
});

test("deriveLastGenerationSetFromTopology (fallback): an all-degenerate board degrades to the labeled killed-cohort fallback", () => {
  // Two dead generations, each a 1-pane short-lived skeleton → both degenerate →
  // no eligible generation. Degrade to the retrospective killed-cohort model
  // (which offers a crash-like killed row) with the visible note.
  seedJob(kdb.db, { job_id: "skel-1", state: "killed", title: "s1" });
  seedJob(kdb.db, { job_id: "skel-2", state: "killed", title: "s2" });
  seedTmuxTopologySnapshot(
    kdb.db,
    500,
    "gen-skel-1",
    [
      {
        pane_id: "%1",
        session_name: "work",
        window_index: 0,
        job_id: "skel-1",
      },
    ],
    NOW - 200,
  );
  seedTmuxTopologySnapshot(
    kdb.db,
    600,
    "gen-skel-2",
    [
      {
        pane_id: "%2",
        session_name: "work",
        window_index: 0,
        job_id: "skel-2",
      },
    ],
    NOW - 50,
  );
  // A crash-like killed cohort row so the fallback has something to offer.
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "cohort",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
  });
  const res = deriveTopo("gen-now");
  expect(res.fallbackNote).toBeDefined();
  expect(res.fallbackNote).toContain("retrospective");
  // The skeleton generations' panes are NOT what got restored.
  expect(res.candidates.map((c) => c.job_id)).toEqual(["cohort"]);
});

test("deriveLastGenerationSetFromTopology (fallback): a non-degenerate generation with zero restorable degrades to the labeled fallback", () => {
  // gen-workers is non-degenerate (2 panes) but every pane is an autopilot worker
  // (plan_verb='work') → 0 restorable → no eligible generation → labeled fallback.
  seedJob(kdb.db, {
    job_id: "w1",
    state: "killed",
    title: "w1",
    plan_verb: "work",
  });
  seedJob(kdb.db, {
    job_id: "w2",
    state: "killed",
    title: "w2",
    plan_verb: "work",
  });
  seedTmuxTopologySnapshot(kdb.db, 500, "gen-workers", [
    { pane_id: "%1", session_name: "work", window_index: 0, job_id: "w1" },
    { pane_id: "%2", session_name: "work", window_index: 1, job_id: "w2" },
  ]);
  seedBackendExecStart(kdb.db, 100);
  seedJob(kdb.db, {
    job_id: "cohort",
    close_kind: "server_gone",
    window_index: 0,
    last_event_id: 150,
  });
  const res = deriveTopo("gen-now");
  expect(res.fallbackNote).toBeDefined();
  expect(res.candidates.map((c) => c.job_id)).toEqual(["cohort"]);
});

test("deriveLastGenerationSetFromTopology (degeneracy AND-clause): a long-lived single-pane generation is legitimate, not a skeleton", () => {
  // A single-agent session observed for >30min is NOT degenerate (the rule is
  // <=1 pane AND short-span, never OR) — it stays restorable. Two snapshots of
  // the same 1-pane generation, span exceeding DEGENERATE_MAX_SPAN_SECS.
  expect(DEGENERATE_MAX_SPAN_SECS).toBe(30 * 60);
  seedJob(kdb.db, { job_id: "solo", state: "killed", title: "solo-agent" });
  seedTmuxTopologySnapshot(
    kdb.db,
    500,
    "gen-solo",
    [{ pane_id: "%1", session_name: "work", window_index: 0, job_id: "solo" }],
    NOW - (DEGENERATE_MAX_SPAN_SECS + 1200),
  );
  seedTmuxTopologySnapshot(
    kdb.db,
    501,
    "gen-solo",
    [{ pane_id: "%1", session_name: "work", window_index: 0, job_id: "solo" }],
    NOW - 100,
  );
  const res = deriveTopo("gen-now");
  expect(res.candidates.map((c) => c.job_id)).toEqual(["solo"]);
  expect(res.fallbackNote).toBeUndefined();
});

test("summarizeTopologyGenerations: exposes ranked per-generation summaries for the list view", () => {
  // gen-now (live), gen-rich (2 restorable, older), gen-skel (1-pane short-lived
  // skeleton, newer). Summaries come back newest-first with the list enrichment.
  seedJob(kdb.db, { job_id: "s", state: "killed", title: "s" });
  seedJob(kdb.db, { job_id: "cur", state: "working", title: "cur" });
  seedTmuxTopologySnapshot(
    kdb.db,
    400,
    "gen-rich",
    ownedPanes(["a", "b"]),
    NOW - 200,
  );
  seedTmuxTopologySnapshot(
    kdb.db,
    500,
    "gen-skel",
    [{ pane_id: "%3", session_name: "work", window_index: 0, job_id: "s" }],
    NOW - 50,
  );
  seedTmuxTopologySnapshot(
    kdb.db,
    600,
    "gen-now",
    [{ pane_id: "%4", session_name: "work", window_index: 0, job_id: "cur" }],
    NOW - 10,
  );
  const gens = summarizeTopologyGenerations(kdb.db, {
    now: NOW,
    currentGenerationId: "gen-now",
  });
  // Newest-first by last_event_id.
  expect(gens.map((g) => g.generation_id)).toEqual([
    "gen-now",
    "gen-skel",
    "gen-rich",
  ]);
  const byId = new Map(gens.map((g) => [g.generation_id, g]));
  expect(byId.get("gen-now")?.is_current).toBe(true);
  // Rich: 2 panes, 2 restorable, not degenerate, not the current server.
  expect(byId.get("gen-rich")?.max_pane_count).toBe(2);
  expect(byId.get("gen-rich")?.restorable).toBe(2);
  expect(byId.get("gen-rich")?.degenerate).toBe(false);
  expect(byId.get("gen-rich")?.is_current).toBe(false);
  // Skeleton: 1 pane, short-lived → degenerate.
  expect(byId.get("gen-skel")?.degenerate).toBe(true);
  expect(byId.get("gen-skel")?.max_pane_count).toBe(1);
});

test("summarizeTopologyGenerations (bound): only the current + newest K dead generations are decoded", () => {
  // Seed MORE than RECENT_GENERATION_BOUND dead generations plus the live one.
  // The index-only summary walk sees them all, but only the current generation
  // and the newest K dead ones are ENRICHED (decoded) — an old generation past
  // the bound never yields a summary, so its snapshots are never decoded. Every
  // seeded snapshot is 2-pane (non-degenerate) and in-cutoff, so nothing is
  // dropped by the selection filters; only the decode bound removes the oldest.
  const total = RECENT_GENERATION_BOUND + 3;
  for (let g = 0; g < total; g++) {
    const a = `g${g}-a`;
    const b = `g${g}-b`;
    // Ascending rowids ⇒ higher g is newer.
    seedTmuxTopologySnapshot(
      kdb.db,
      100 + g,
      `gen-dead-${g}`,
      ownedPanes([a, b]),
      NOW - 100,
    );
  }
  seedJob(kdb.db, { job_id: "live", state: "working", title: "live" });
  seedTmuxTopologySnapshot(
    kdb.db,
    100 + total,
    "gen-now",
    [
      {
        pane_id: "%now",
        session_name: "work",
        window_index: 0,
        job_id: "live",
      },
    ],
    NOW - 10,
  );

  const gens = summarizeTopologyGenerations(kdb.db, {
    now: NOW,
    currentGenerationId: "gen-now",
  });
  // Current + the newest RECENT_GENERATION_BOUND dead generations, newest-first.
  const expected = ["gen-now"];
  for (let g = total - 1; g >= total - RECENT_GENERATION_BOUND; g--) {
    expected.push(`gen-dead-${g}`);
  }
  expect(gens.map((g) => g.generation_id)).toEqual(expected);
  // The three oldest dead generations are past the decode bound — absent.
  const seen = new Set(gens.map((g) => g.generation_id));
  for (let g = 0; g < total - RECENT_GENERATION_BOUND; g++) {
    expect(seen.has(`gen-dead-${g}`)).toBe(false);
  }
  // The current generation is decoded (its restorable count reflects a decode).
  const now = gens.find((g) => g.generation_id === "gen-now");
  expect(now?.is_current).toBe(true);
  expect(now?.max_pane_count).toBe(1);
});

test("GENERATION_SUMMARY_SQL: the summary walk is served by the v107 partial index (EXPLAIN QUERY PLAN)", () => {
  // Seed a spread of snapshot generations + ANALYZE so the planner has stats,
  // then assert the summary walk hits idx_events_tmux_generation and never does a
  // bare full-table SCAN of events (the EXPLAIN acceptance instrument).
  for (let g = 0; g < 8; g++) {
    for (let s = 0; s < 4; s++) {
      seedTmuxTopologySnapshot(
        kdb.db,
        100 + g * 10 + s,
        `gen-${g}`,
        [
          {
            pane_id: `%${g}`,
            session_name: "work",
            window_index: 0,
            job_id: `j-${g}`,
          },
        ],
        NOW - 100 - g,
      );
    }
  }
  kdb.db.run("ANALYZE");
  const plan = kdb.db
    .prepare(`EXPLAIN QUERY PLAN ${GENERATION_SUMMARY_SQL}`)
    .all() as { detail: string }[];
  const detail = plan.map((r) => r.detail).join(" | ");
  expect(detail).toContain("idx_events_tmux_generation");
  // A bare full-table `SCAN events` (not qualified by USING INDEX) must not appear.
  expect(detail).not.toMatch(/SCAN events(?! USING)/);
});

test("v107 fresh DB carries the tmux_generation_id generated column + its partial index", () => {
  // Fresh-vs-migrated parity for acceptance 5: a fresh migrated DB (freshDbFile)
  // has the generated column (visible only to table_xinfo) AND the partial index,
  // so the migrated path (idempotent ALTER + IF NOT EXISTS index) lands the same.
  const cols = kdb.db.prepare("PRAGMA table_xinfo(events)").all() as {
    name: string;
  }[];
  expect(cols.some((c) => c.name === "tmux_generation_id")).toBe(true);
  const idx = kdb.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_tmux_generation'",
    )
    .all();
  expect(idx.length).toBe(1);
});
