/**
 * Pure-shaping tests for `keeper status` + `keeper query`. The JSON-builder
 * (`buildStatusEnvelope`) and the arg parsers are pure / socket-free, so a
 * fixture snapshot pins the envelope shape, the drained/jammed split, and the
 * count tallies without booting a daemon. The `keeper query` runner is exercised
 * through injected transport deps (no socket).
 */

import { describe, expect, test } from "bun:test";
import {
  flattenTaskRows,
  parseQueryArgs,
  QUERY_SCHEMA_VERSION,
  runQueryCommand,
  runTasksCommand,
  VIRTUAL_QUERY_COLLECTIONS,
} from "../cli/query";
import {
  buildStatusEnvelope,
  buildStatusErrorEnvelope,
  countLegacyWrappedProviderLegs,
  DEFAULT_CONNECT_DEADLINE_MS,
  type ParsedStatusArgs,
  parseStatusArgs,
  type RunStatusDeps,
  runStatus,
  STATUS_SCHEMA_VERSION,
  type StatusBootInfo,
} from "../cli/status";
import { QUERY_READ_ALLOWLIST, REGISTRY } from "../src/collections";
import { recordBootCatchupStats } from "../src/db";
import {
  type BootStatus,
  type EventStoreStatus,
  encodeFrame,
  type FilterValue,
  type Row,
  type ServerFrame,
} from "../src/protocol";
import type { Verdict } from "../src/readiness";
import type {
  ConnectFactory,
  ReadinessClientSnapshot,
  ReadinessSocket,
  SocketHandlers,
} from "../src/readiness-client";
import {
  computeEventStoreStatus,
  readEventStoreStatus,
} from "../src/server-worker";
import { freshMemDb } from "./helpers/template-db";

class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Fixture builders — minimal casts (production likewise casts wire rows).
// ---------------------------------------------------------------------------

interface FixtureTask {
  task_id: string;
  jobs?: unknown[];
}
interface FixtureEpic {
  epic_id: string;
  status: string | null;
  tasks: FixtureTask[];
  jobs?: unknown[];
  question?: string | null;
}

interface FixtureJob {
  state: string;
  jobId?: string;
  dispatchOrigin?: string | null;
  title?: string | null;
  birthSession?: string | null;
}

interface SnapOverrides {
  epics?: FixtureEpic[];
  jobsByState?: string[];
  /** Richer job fixtures carrying `job_id` + `dispatch_origin`, for the
   *  `in_flight.board_work_jobs` distinction — additive to `jobsByState`. */
  jobsDetailed?: FixtureJob[];
  subagentInvocations?: unknown[];
  pendingDispatches?: number;
  deadLetters?: number;
  blockEscalations?: number;
  perEpic?: Record<string, Verdict>;
  perTask?: Record<string, Verdict>;
  perCloseRow?: Record<string, Verdict>;
  autopilotPaused?: boolean;
  autopilotMode?: "yolo" | "armed";
  autopilotEligibleEpicIds?: string[];
  maxConcurrentJobs?: number | null;
  maxConcurrentPerRoot?: number;
  maxConcurrentPerRootStored?: number;
  worktreeMode?: boolean;
  worktreeMultiRepo?: boolean;
  landedEpicIds?: string[];
  providerLegOwnership?: Row[];
}

function makeSnap(o: SnapOverrides = {}): ReadinessClientSnapshot {
  const jobs = new Map<
    string,
    {
      state: string;
      job_id?: string;
      dispatch_origin?: string | null;
      title?: string | null;
      backend_exec_birth_session_id?: string | null;
    }
  >();
  (o.jobsByState ?? []).forEach((state, i) => {
    jobs.set(`job-${i}`, { state });
  });
  (o.jobsDetailed ?? []).forEach((j, i) => {
    const jobId = j.jobId ?? `djob-${i}`;
    jobs.set(jobId, {
      state: j.state,
      job_id: jobId,
      dispatch_origin: j.dispatchOrigin ?? null,
      title: j.title ?? null,
      backend_exec_birth_session_id: j.birthSession ?? null,
    });
  });
  const toMap = (
    rec: Record<string, Verdict> | undefined,
  ): Map<string, Verdict> => new Map(Object.entries(rec ?? {}));
  return {
    epics: (o.epics ?? []) as unknown as ReadinessClientSnapshot["epics"],
    jobs: jobs as unknown as ReadinessClientSnapshot["jobs"],
    subagentInvocations: (o.subagentInvocations ??
      []) as ReadinessClientSnapshot["subagentInvocations"],
    scheduledTasks: [],
    gitStatus: [],
    deadLetters: Array.from(
      { length: o.deadLetters ?? 0 },
      () => ({}),
    ) as unknown as ReadinessClientSnapshot["deadLetters"],
    pendingDispatches: Array.from(
      { length: o.pendingDispatches ?? 0 },
      () => ({}),
    ) as unknown as ReadinessClientSnapshot["pendingDispatches"],
    blockEscalations: Array.from(
      { length: o.blockEscalations ?? 0 },
      () => ({}),
    ) as unknown as ReadinessClientSnapshot["blockEscalations"],
    autopilotPaused: o.autopilotPaused ?? false,
    autopilotMode: o.autopilotMode ?? "yolo",
    ...(o.autopilotEligibleEpicIds === undefined
      ? {}
      : { autopilotEligibleEpicIds: o.autopilotEligibleEpicIds }),
    maxConcurrentJobs:
      o.maxConcurrentJobs === undefined ? null : o.maxConcurrentJobs,
    maxConcurrentPerRoot: o.maxConcurrentPerRoot ?? 1,
    ...(o.maxConcurrentPerRootStored === undefined
      ? {}
      : { maxConcurrentPerRootStored: o.maxConcurrentPerRootStored }),
    worktreeMode: o.worktreeMode ?? false,
    worktreeMultiRepo: o.worktreeMultiRepo ?? false,
    ...(o.landedEpicIds === undefined
      ? {}
      : { landedEpicIds: o.landedEpicIds }),
    ...(o.providerLegOwnership === undefined
      ? {}
      : { providerLegOwnership: o.providerLegOwnership }),
    readiness: {
      perTask: toMap(o.perTask),
      perCloseRow: toMap(o.perCloseRow),
      perEpic: toMap(o.perEpic),
      diagnostics: [],
    },
  } as unknown as ReadinessClientSnapshot;
}

const BOOT: StatusBootInfo = {
  rev: 4242,
  catching_up: false,
  event_store: null,
};

// ---------------------------------------------------------------------------
// computeEventStoreStatus (fn-1311) — pure projection math, injected
// observations. Every expected value below is a hand-computed constant, never
// re-derived by the function under test.
// ---------------------------------------------------------------------------

describe("computeEventStoreStatus", () => {
  test("no recorded boot measurement → null-honest: both projections null, last_boot_catchup null", () => {
    const out = computeEventStoreStatus(null, 1000, 65536, 1000);
    expect(out).toEqual({
      event_count: 1000,
      db_bytes: 65536,
      last_boot_catchup: null,
      projected_catchup_duration_ms: null,
      projected_full_replay_duration_ms: null,
    });
  });

  test("catch-up projects from the wall-clock rate, full-replay from the pace-free work rate (the two rates differ)", () => {
    // Wall-clock: 1000 events folded in 20_000ms → 20ms/event (catch-up rate).
    // Fold-work: 10_000ms over the SAME 1000 events → 10ms/event (replay rate),
    // half the wall-clock rate with the pacing sleep excluded. 100 events have
    // accumulated since that boot's end cursor (head 1100 vs end 1000), and the
    // current total is 2000 events.
    const stats = {
      startedAtMs: 0,
      completedAtMs: 20_000,
      startEventId: 0,
      endEventId: 1000,
      workMs: 10_000,
    };
    const out = computeEventStoreStatus(stats, 2000, 999_999, 1100);
    expect(out.last_boot_catchup).toEqual({
      duration_ms: 20_000,
      events_folded: 1000,
    });
    // 20ms/event (wall-clock) * 100 pending events
    expect(out.projected_catchup_duration_ms).toBe(2000);
    // 10ms/event (pace-free work) * 2000 current total events
    expect(out.projected_full_replay_duration_ms).toBe(20_000);
  });

  test("below the 1000-event full-replay floor leaves replay null while catch-up still projects", () => {
    const stats = {
      startedAtMs: 0,
      completedAtMs: 9990,
      startEventId: 0,
      endEventId: 999,
      workMs: 1998,
    };
    const out = computeEventStoreStatus(stats, 1998, 4096, 1099);
    // 10ms/event wall-clock * 100 pending events
    expect(out.projected_catchup_duration_ms).toBe(1000);
    expect(out.projected_full_replay_duration_ms).toBeNull();
  });

  test("zero events folded (a boot that caught up nothing) leaves both rates undefined — projections null, observation still surfaced", () => {
    const stats = {
      startedAtMs: 0,
      completedAtMs: 5000,
      startEventId: 42,
      endEventId: 42,
      workMs: 1000,
    };
    const out = computeEventStoreStatus(stats, 42, 4096, 42);
    expect(out.last_boot_catchup).toEqual({
      duration_ms: 5000,
      events_folded: 0,
    });
    expect(out.projected_catchup_duration_ms).toBeNull();
    expect(out.projected_full_replay_duration_ms).toBeNull();
  });

  test("no events have accumulated since the recorded boot → catch-up projection is 0, not null", () => {
    const stats = {
      startedAtMs: 0,
      completedAtMs: 10_000,
      startEventId: 0,
      endEventId: 1000,
      workMs: 2000,
    };
    // head == the recorded end cursor: nothing pending right now.
    const out = computeEventStoreStatus(stats, 1000, 8192, 1000);
    expect(out.projected_catchup_duration_ms).toBe(0);
    // 2ms/event (pace-free work 2000/1000) * 1000 current total events
    expect(out.projected_full_replay_duration_ms).toBe(2000);
  });

  test("null work measurement → full-replay null-honest while catch-up still projects from wall-clock", () => {
    const stats = {
      startedAtMs: 0,
      completedAtMs: 10_000,
      startEventId: 0,
      endEventId: 1000,
      workMs: null,
    };
    const out = computeEventStoreStatus(stats, 5000, 4096, 1500);
    // 10ms/event wall-clock (10_000/1000) * 500 pending (head 1500 − end 1000)
    expect(out.projected_catchup_duration_ms).toBe(5000);
    // work unmeasured → null, never 0, never the wall-clock extrapolation
    expect(out.projected_full_replay_duration_ms).toBeNull();
  });

  test("zero work measurement reads as not-measured → full-replay null, never an instant-rebuild 0", () => {
    const stats = {
      startedAtMs: 0,
      completedAtMs: 8000,
      startEventId: 0,
      endEventId: 800,
      workMs: 0,
    };
    const out = computeEventStoreStatus(stats, 800, 4096, 800);
    expect(out.projected_full_replay_duration_ms).toBeNull();
    // catch-up leg unaffected: 10ms/event (8000/800) * 0 pending = 0
    expect(out.projected_catchup_duration_ms).toBe(0);
  });

  test("negative work measurement (a torn/malformed delta) → full-replay null; catch-up still projects", () => {
    const stats = {
      startedAtMs: 0,
      completedAtMs: 8000,
      startEventId: 0,
      endEventId: 800,
      workMs: -50,
    };
    const out = computeEventStoreStatus(stats, 800, 4096, 900);
    expect(out.projected_full_replay_duration_ms).toBeNull();
    // catch-up still projects from wall-clock: 10ms/event * 100 pending
    expect(out.projected_catchup_duration_ms).toBe(1000);
  });

  test("a non-positive wall-clock window nulls only the catch-up leg — full-replay still projects from work", () => {
    // Degenerate torn row: completed == started (0ms wall-clock), yet a real
    // positive fold-work measurement survives. The two legs are independent.
    const stats = {
      startedAtMs: 5000,
      completedAtMs: 5000,
      startEventId: 0,
      endEventId: 1000,
      workMs: 2000,
    };
    const out = computeEventStoreStatus(stats, 3000, 4096, 1200);
    expect(out.projected_catchup_duration_ms).toBeNull();
    // 2ms/event (work 2000/1000) * 3000 current events
    expect(out.projected_full_replay_duration_ms).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// readEventStoreStatus — the durable `boot_catchup_stats` row + live counts
// flow through the served `result` frame's `event_store` field end-to-end. The
// block rides the frame beside the boot header, so memoized steady state and
// catch-up object replies deliver the same observability fields.
// ---------------------------------------------------------------------------

describe("readEventStoreStatus wiring", () => {
  test("no boot_catchup_stats row yet → event_store carries live counts with null projections", () => {
    const { db } = freshMemDb();
    const eventStore = readEventStoreStatus(db);
    expect(eventStore).toEqual({
      event_count: 0,
      db_bytes: expect.any(Number),
      last_boot_catchup: null,
      projected_catchup_duration_ms: null,
      projected_full_replay_duration_ms: null,
    });
    expect(eventStore.db_bytes).toBeGreaterThan(0);
  });

  test("a recorded boot measurement surfaces on the block, scaled against live event_count", () => {
    const { db } = freshMemDb();
    for (let i = 0; i < 3; i++) {
      db.run(
        "INSERT INTO events (ts, session_id, hook_event, event_type) VALUES (?, ?, ?, ?)",
        [
          1000 + i,
          "01234567-89ab-cdef-0123-456789abcdef",
          "SessionStart",
          "SessionStart",
        ],
      );
    }
    recordBootCatchupStats(db, {
      startedAtMs: 0,
      completedAtMs: 1000,
      startEventId: 0,
      endEventId: 3,
      workMs: 600,
    });
    const eventStore = readEventStoreStatus(db);
    expect(eventStore.event_count).toBe(3);
    expect(eventStore.last_boot_catchup).toEqual({
      duration_ms: 1000,
      events_folded: 3,
    });
    // The three-event sample is below the 1000-event full-replay floor.
    expect(eventStore.projected_full_replay_duration_ms).toBeNull();
    // Nothing pending beyond the recorded end cursor (head == 3 == end_event_id).
    expect(eventStore.projected_catchup_duration_ms).toBe(0);
  });

  test("a boot measurement recorded with no fold-work → full-replay null-honest end-to-end, catch-up still projects", () => {
    const { db } = freshMemDb();
    for (let i = 0; i < 4; i++) {
      db.run(
        "INSERT INTO events (ts, session_id, hook_event, event_type) VALUES (?, ?, ?, ?)",
        [
          1000 + i,
          "01234567-89ab-cdef-0123-456789abcdef",
          "SessionStart",
          "SessionStart",
        ],
      );
    }
    // No workMs argument → the nullable fold_work_ms column persists NULL, the
    // "recorded before the work column existed" case that must read as
    // not-measured rather than an instant-rebuild 0.
    recordBootCatchupStats(db, {
      startedAtMs: 0,
      completedAtMs: 2000,
      startEventId: 0,
      endEventId: 2,
    });
    const eventStore = readEventStoreStatus(db);
    // full-replay unmeasured → null, never a paced-rate extrapolation.
    expect(eventStore.projected_full_replay_duration_ms).toBeNull();
    // catch-up still projects from wall-clock: 1000ms/event (2000/2) * 2 pending
    // (head 4 − end 2).
    expect(eventStore.projected_catchup_duration_ms).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// buildStatusEnvelope — envelope shape + field presence
// ---------------------------------------------------------------------------

describe("buildStatusEnvelope shape", () => {
  test("status schema version is v13", () => {
    expect(STATUS_SCHEMA_VERSION).toBe(13);
  });

  test("envelope carries every documented field", () => {
    const snap = makeSnap({
      epics: [
        { epic_id: "fn-1-a", status: "open", tasks: [{ task_id: "fn-1-a.1" }] },
      ],
      perEpic: { "fn-1-a": { tag: "ready" } },
      perTask: { "fn-1-a.1": { tag: "ready" } },
      perCloseRow: {
        "fn-1-a": {
          tag: "blocked",
          reason: { kind: "dep-on-task", upstream: "fn-1-a.1" },
        } as unknown as Verdict,
      },
      autopilotMode: "armed",
      autopilotEligibleEpicIds: ["fn-1-a"],
      maxConcurrentJobs: 3,
      maxConcurrentPerRoot: 2,
      maxConcurrentPerRootStored: 2,
      worktreeMode: true,
      worktreeMultiRepo: true,
    });
    const env = buildStatusEnvelope(snap, BOOT, []);
    expect(env.schema_version).toBe(STATUS_SCHEMA_VERSION);
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
    const d = env.data;
    expect(d).not.toBeNull();
    if (d === null) return;
    // autopilot block
    expect(d.autopilot).toEqual({
      paused: false,
      mode: "armed",
      worktree_mode: true,
      worktree_multi_repo: true,
      armed: ["fn-1-a"],
      max_concurrent_jobs: 3,
      max_concurrent_per_root: 2,
      max_concurrent_per_root_stored: 2,
    });
    // board: epic + task + close verdict views
    expect(d.board.epics).toHaveLength(1);
    const epic = d.board.epics[0];
    expect(epic?.epic_id).toBe("fn-1-a");
    expect(epic?.status).toBe("open");
    expect(epic?.question).toBeNull();
    expect(epic?.verdict).toBe("ready");
    expect(epic?.pill).toBe("[ready]");
    expect(epic?.tasks).toEqual([
      {
        task_id: "fn-1-a.1",
        verdict: "ready",
        pill: "[ready]",
        last_evidence_at: null,
        dispatch_failure: [],
      },
    ]);
    expect(epic?.close?.verdict).toBe("blocked");
    expect(epic?.close?.pill).toContain("dep-on-task");
    // boot header passthrough
    expect(d.rev).toBe(4242);
    expect(d.catching_up).toBe(false);
    expect(d.event_store).toBeNull();
    // count + flag + in_flight + needs_human blocks present
    expect(d.counts.epics.total).toBe(1);
    expect(d.counts.tasks.ready).toBe(1);
    expect(typeof d.drained).toBe("boolean");
    expect(typeof d.jammed).toBe("boolean");
    expect(d.drain).toEqual({ legacy_wrapped_provider_legs: 0 });
    expect(d.in_flight).toEqual({
      pending_dispatches: 0,
      running_jobs: 0,
      board_work_jobs: 0,
      total: 0,
    });
    expect(d.needs_human.total).toBe(0);
    expect(d.needs_human.parked_questions).toBe(0);
  });

  test("per-root: worktree off publishes effective 1 with the stored intent distinct", () => {
    // The boot-latched effective floors to 1 while worktree is off; the locally
    // re-projected stored keeps the operator's 3.
    const snap = makeSnap({
      maxConcurrentPerRoot: 1,
      maxConcurrentPerRootStored: 3,
      worktreeMode: false,
    });
    const ap = buildStatusEnvelope(snap, BOOT, []).data?.autopilot;
    expect(ap?.max_concurrent_per_root).toBe(1);
    expect(ap?.max_concurrent_per_root_stored).toBe(3);
  });

  test("per-root: a snapshot lacking a stored value nulls it, never fabricated from effective", () => {
    const snap = makeSnap({ maxConcurrentPerRoot: 1 });
    const ap = buildStatusEnvelope(snap, BOOT, []).data?.autopilot;
    expect(ap?.max_concurrent_per_root).toBe(1);
    expect(ap?.max_concurrent_per_root_stored).toBeNull();
  });

  test("a verdict-map miss renders the inert [blocked:unknown] view", () => {
    const snap = makeSnap({
      epics: [
        { epic_id: "fn-2-b", status: null, tasks: [{ task_id: "fn-2-b.1" }] },
      ],
      // no perEpic/perTask entries at all
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.board.epics[0]?.verdict).toBe("unknown");
    expect(d?.board.epics[0]?.pill).toBe("[blocked:unknown]");
    expect(d?.board.epics[0]?.tasks[0]?.pill).toBe("[blocked:unknown]");
    expect(d?.board.epics[0]?.close).toBeNull();
  });

  test("counts partition fresh and stale running verdicts while stale views expose their last evidence", () => {
    const snap = makeSnap({
      epics: [
        {
          epic_id: "fn-3-c",
          status: "open",
          jobs: [
            {
              job_id: "monitor-worker",
              has_live_worker_monitor: true,
              updated_at: 400,
            },
          ],
          tasks: [
            {
              task_id: "fn-3-c.1",
              jobs: [{ job_id: "sub-worker", updated_at: 300 }],
            },
            { task_id: "fn-3-c.2" },
          ],
        },
      ],
      subagentInvocations: [
        {
          job_id: "sub-worker",
          status: "running",
          duration_ms: null,
          updated_at: 300,
        },
      ],
      perEpic: {
        "fn-3-c": {
          tag: "running",
          reason: { kind: "monitor-stale" },
        } as Verdict,
        "fn-3-extra-live": {
          tag: "running",
          reason: { kind: "job-running" },
        } as Verdict,
        "fn-3-extra-ready": { tag: "ready" },
        "fn-3-extra-done": { tag: "completed" },
        "fn-3-extra-blocked": {
          tag: "blocked",
          reason: { kind: "unknown" },
        } as Verdict,
      },
      perTask: {
        "fn-3-c.1": {
          tag: "running",
          reason: { kind: "sub-agent-stale" },
        } as Verdict,
        "fn-3-c.2": {
          tag: "running",
          reason: { kind: "sub-agent-running" },
        } as Verdict,
        "fn-3-extra-ready": { tag: "ready" },
        "fn-3-extra-done": { tag: "completed" },
        "fn-3-extra-blocked": {
          tag: "blocked",
          reason: { kind: "unknown" },
        } as Verdict,
      },
      perCloseRow: {
        "fn-3-c": {
          tag: "running",
          reason: { kind: "monitor-stale" },
        } as Verdict,
        "fn-3-extra-live": {
          tag: "running",
          reason: { kind: "job-running" },
        } as Verdict,
        "fn-3-extra-ready": { tag: "ready" },
        "fn-3-extra-done": { tag: "completed" },
        "fn-3-extra-blocked": {
          tag: "blocked",
          reason: { kind: "unknown" },
        } as Verdict,
      },
    });

    const data = buildStatusEnvelope(snap, BOOT, []).data;
    expect(data?.counts.epics).toEqual({
      total: 5,
      ready: 1,
      running: 1,
      stale_running: 1,
      completed: 1,
      blocked: 1,
    });
    expect(data?.counts.tasks).toEqual({
      total: 5,
      ready: 1,
      running: 1,
      stale_running: 1,
      completed: 1,
      blocked: 1,
    });
    expect(data?.counts.close_rows).toEqual({
      total: 5,
      ready: 1,
      running: 1,
      stale_running: 1,
      completed: 1,
      blocked: 1,
    });
    expect(data?.board.epics[0]?.last_evidence_at).toBe(400);
    expect(data?.board.epics[0]?.tasks[0]?.last_evidence_at).toBe(300);
    expect(data?.board.epics[0]?.tasks[1]?.last_evidence_at).toBeNull();
    expect(data?.board.epics[0]?.close?.last_evidence_at).toBe(400);
  });

  test("yolo mode reports an empty armed set", () => {
    const d = buildStatusEnvelope(
      makeSnap({ autopilotMode: "yolo" }),
      BOOT,
      [],
    ).data;
    expect(d?.autopilot.mode).toBe("yolo");
    expect(d?.autopilot.armed).toEqual([]);
  });

  test("dispatch_failure surfaces sticky blocks on task + close views (schema v2)", () => {
    const snap = makeSnap({
      epics: [
        {
          epic_id: "fn-9-x",
          status: "open",
          tasks: [{ task_id: "fn-9-x.1" }, { task_id: "fn-9-x.2" }],
        },
      ],
      perEpic: { "fn-9-x": { tag: "ready" } },
      perTask: {
        "fn-9-x.1": { tag: "ready" },
        "fn-9-x.2": { tag: "ready" },
      },
      perCloseRow: { "fn-9-x": { tag: "ready" } },
    });
    const failures: Row[] = [
      // Three per-repo worktree-mode close keys for the SAME epic (Gap A — a
      // bare `.get(epicId)` would miss the hashed keys). Two distinct KINDS,
      // one dup → sorted-unique collection on the close view.
      {
        verb: "close",
        id: "worktree-finalize:fn-9-x-h1",
        reason: "worktree-finalize-conflict",
      },
      {
        verb: "close",
        id: "worktree-finalize:fn-9-x-h2",
        reason: "worktree-finalize-non-fast-forward",
      },
      {
        verb: "close",
        id: "worktree-finalize:fn-9-x-h3",
        reason: "worktree-recover-conflict",
      },
      // A `work::`-blocked ready task (Gap B).
      { verb: "work", id: "fn-9-x.1", reason: "worktree-multi-repo" },
    ];
    const env = buildStatusEnvelope(snap, BOOT, failures);
    expect(env.schema_version).toBe(STATUS_SCHEMA_VERSION);
    const epic = env.data?.board.epics[0];
    // close row resolves all three hashed keys → sorted-unique kinds.
    expect(epic?.close?.dispatch_failure).toEqual(["merge-conflict", "non-ff"]);
    // task .1 carries the work block; task .2 is clean.
    const t1 = epic?.tasks.find((t) => t.task_id === "fn-9-x.1");
    const t2 = epic?.tasks.find((t) => t.task_id === "fn-9-x.2");
    expect(t1?.dispatch_failure).toEqual(["multi-repo"]);
    expect(t2?.dispatch_failure).toEqual([]);
    // the epic-level view stays [] — a close block lives on `close`.
    expect(epic?.dispatch_failure).toEqual([]);
  });

  test("a null-epic / zero-match failure drops silently (no pill, no throw)", () => {
    const snap = makeSnap({
      epics: [
        { epic_id: "fn-9-x", status: "open", tasks: [{ task_id: "fn-9-x.1" }] },
      ],
      perEpic: { "fn-9-x": { tag: "ready" } },
      perTask: { "fn-9-x.1": { tag: "ready" } },
      perCloseRow: { "fn-9-x": { tag: "ready" } },
    });
    const failures: Row[] = [
      // path-keyed recover row → null-epic, dropped.
      {
        verb: "close",
        id: "worktree-recover:/Users/mike/code/other",
        reason: "worktree-recover-dirty-checkout",
      },
      // resolves to no known epic → dropped.
      { verb: "close", id: "fn-404-ghost", reason: "worktree-merge-conflict" },
    ];
    const env = buildStatusEnvelope(snap, BOOT, failures);
    const epic = env.data?.board.epics[0];
    expect(epic?.close?.dispatch_failure).toEqual([]);
    expect(epic?.tasks[0]?.dispatch_failure).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// drained / jammed split + in-flight + needs-human
// ---------------------------------------------------------------------------

describe("buildStatusEnvelope drained/jammed", () => {
  test("at rest with no human-blocking signal → drained, not jammed", () => {
    const snap = makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "done", tasks: [] }],
      perEpic: { "fn-1-a": { tag: "completed" } },
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.drained).toBe(true);
    expect(d?.jammed).toBe(false);
  });

  test("a ready epic is NOT drained (dispatchable work remains)", () => {
    const snap = makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "open", tasks: [] }],
      perEpic: { "fn-1-a": { tag: "ready" } },
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.drained).toBe(false);
    expect(d?.jammed).toBe(false);
  });

  test("at rest with a sticky dispatch_failure → jammed, not drained", () => {
    const snap = makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "open", tasks: [] }],
      perEpic: {
        "fn-1-a": {
          tag: "blocked",
          reason: { kind: "unknown" },
        } as unknown as Verdict,
      },
    });
    const failures: Row[] = [
      { verb: "close", id: "fn-1-a", reason: "worktree-merge-conflict" },
    ];
    const d = buildStatusEnvelope(snap, BOOT, failures).data;
    expect(d?.jammed).toBe(true);
    expect(d?.drained).toBe(false);
    expect(d?.needs_human.stuck_dispatches).toBe(1);
    expect(d?.needs_human.total).toBe(1);
  });

  test("dead_letters / block_escalations feed needs-human and force jammed at rest", () => {
    const snap = makeSnap({ deadLetters: 2, blockEscalations: 1 });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.needs_human.dead_letters).toBe(2);
    expect(d?.needs_human.block_escalations).toBe(1);
    expect(d?.needs_human.total).toBe(3);
    expect(d?.jammed).toBe(true);
  });

  test("a parked epic question feeds needs-human and forces jammed at rest, even with no other signal (fn-1083.2)", () => {
    const snap = makeSnap({
      epics: [
        {
          epic_id: "fn-1-a",
          status: "open",
          tasks: [],
          question: "does the evidence check out?",
        },
      ],
      perEpic: {
        "fn-1-a": { tag: "blocked", reason: { kind: "unknown" } },
      },
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.board.epics[0]?.question).toBe("does the evidence check out?");
    expect(d?.needs_human.parked_questions).toBe(1);
    expect(d?.needs_human.total).toBe(1);
    expect(d?.jammed).toBe(true);
    expect(d?.drained).toBe(false);
  });

  test("an epic with no parked question renders question:null and contributes zero to parked_questions", () => {
    const snap = makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "done", tasks: [] }],
      perEpic: { "fn-1-a": { tag: "completed" } },
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.board.epics[0]?.question).toBeNull();
    expect(d?.needs_human.parked_questions).toBe(0);
    expect(d?.drained).toBe(true);
  });

  test("finalize_non_ff is counted as a subset of stuck_dispatches, not double-added", () => {
    const failures: Row[] = [
      {
        verb: "close",
        id: "fn-1-a",
        reason: "worktree-finalize-non-fast-forward",
      },
      { verb: "close", id: "fn-2-b", reason: "worktree-merge-conflict" },
    ];
    const d = buildStatusEnvelope(makeSnap(), BOOT, failures).data;
    expect(d?.needs_human.stuck_dispatches).toBe(2);
    expect(d?.needs_human.finalize_non_ff).toBe(1);
    expect(d?.needs_human.total).toBe(2);
  });

  test("instant_death_wall counts per-key breaker stickies as a subset of stuck_dispatches, not double-added (fn-1086)", () => {
    // Two distinct keys tripped the instant-death breaker (>= the board-wide
    // quota-wall threshold) plus one unrelated sticky. instant_death_wall counts
    // only the breaker rows; it is a subset of stuck_dispatches (in total once,
    // never double-counted — mirrors finalize_non_ff).
    const failures: Row[] = [
      { verb: "work", id: "fn-1-a.1", reason: "instant-death-breaker" },
      { verb: "work", id: "fn-2-b.3", reason: "instant-death-breaker" },
      { verb: "close", id: "fn-3-c", reason: "worktree-merge-conflict" },
    ];
    const d = buildStatusEnvelope(makeSnap(), BOOT, failures).data;
    expect(d?.needs_human.stuck_dispatches).toBe(3);
    expect(d?.needs_human.instant_death_wall).toBe(2);
    expect(d?.needs_human.total).toBe(3);
  });

  test("a single instant-death sticky surfaces instant_death_wall:1 (per-key breaker, below the wall threshold) (fn-1086)", () => {
    const failures: Row[] = [
      { verb: "work", id: "fn-1-a.1", reason: "instant-death-breaker" },
    ];
    const d = buildStatusEnvelope(makeSnap(), BOOT, failures).data;
    expect(d?.needs_human.instant_death_wall).toBe(1);
    expect(d?.needs_human.stuck_dispatches).toBe(1);
  });

  test("no instant-death stickies → instant_death_wall:0 (fn-1086)", () => {
    const d = buildStatusEnvelope(makeSnap(), BOOT, []).data;
    expect(d?.needs_human.instant_death_wall).toBe(0);
  });

  test("blocked_work counts blocked:-prefix work rows as a subset of stuck_dispatches, not double-added", () => {
    const failures: Row[] = [
      { verb: "work", id: "fn-1-a.1", reason: "blocked: TOOLING_FAILURE" },
      { verb: "close", id: "fn-2-b", reason: "worktree-merge-conflict" },
    ];
    const d = buildStatusEnvelope(makeSnap(), BOOT, failures).data;
    expect(d?.needs_human.stuck_dispatches).toBe(2);
    expect(d?.needs_human.blocked_work).toBe(1);
    expect(d?.needs_human.total).toBe(2);
  });

  test("blocked_work is verb-scoped to work rows; a non-blocked work reason (e.g. worktree-multi-repo) does not count — total unchanged versus the pre-existing fixture", () => {
    const failures: Row[] = [
      { verb: "work", id: "fn-9-x.1", reason: "worktree-multi-repo" },
    ];
    const d = buildStatusEnvelope(makeSnap(), BOOT, failures).data;
    expect(d?.needs_human.blocked_work).toBe(0);
    expect(d?.needs_human.stuck_dispatches).toBe(1);
    expect(d?.needs_human.total).toBe(1);
  });

  test("no blocked:-prefix work stickies → blocked_work:0", () => {
    const d = buildStatusEnvelope(makeSnap(), BOOT, []).data;
    expect(d?.needs_human.blocked_work).toBe(0);
  });

  test("the whole needs_human block is byte-identical off the shared projector (fields + order)", () => {
    // A mixed board: 2 dead letters, 1 block escalation, 1 parked question, and
    // 5 sticky rows — one finalize-non-ff subset + one finalize-suite-red subset + two
    // breaker subsets + one plain merge-conflict. Hand-computed: stuck=5,
    // finalize_non_ff=1, finalize_suite_red=1, instant_death_wall=2, parked=1,
    // total = 2+1+5+1 = 9 (subsets never double-added).
    const snap = makeSnap({
      epics: [
        {
          epic_id: "fn-9-x",
          status: "open",
          tasks: [],
          question: "does the evidence check out?",
        },
      ],
      perEpic: { "fn-9-x": { tag: "blocked", reason: { kind: "unknown" } } },
      deadLetters: 2,
      blockEscalations: 1,
    });
    const failures: Row[] = [
      {
        verb: "close",
        id: "worktree-finalize:fn-9-x-h1",
        reason: "worktree-finalize-non-fast-forward",
      },
      {
        verb: "close",
        id: "worktree-finalize:fn-9-x-h2",
        reason: "worktree-finalize-suite-red",
      },
      { verb: "work", id: "fn-9-x.1", reason: "instant-death-breaker" },
      { verb: "work", id: "fn-9-x.2", reason: "instant-death-breaker" },
      { verb: "close", id: "fn-9-x", reason: "worktree-merge-conflict" },
    ];
    const d = buildStatusEnvelope(snap, BOOT, failures).data;
    expect(Object.keys(d?.needs_human ?? {})).toEqual([
      "dead_letters",
      "block_escalations",
      "stuck_dispatches",
      "finalize_non_ff",
      "finalize_suite_red",
      "parked_questions",
      "instant_death_wall",
      "blocked_work",
      "finalize_pending",
      "total",
    ]);
    expect(d?.needs_human).toEqual({
      dead_letters: 2,
      block_escalations: 1,
      stuck_dispatches: 5,
      finalize_non_ff: 1,
      finalize_suite_red: 1,
      parked_questions: 1,
      instant_death_wall: 2,
      blocked_work: 0,
      finalize_pending: 0,
      total: 9,
    });
  });

  test("finalize_pending is paused, unlanded worktree done epics only and never jams", () => {
    const snap = makeSnap({
      epics: [{ epic_id: "fn-42-lane", status: "done", tasks: [] }],
      worktreeMode: true,
      autopilotPaused: true,
      landedEpicIds: [],
      perEpic: { "fn-42-lane": { tag: "completed" } },
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.needs_human.finalize_pending).toBe(1);
    expect(d?.needs_human.total).toBe(0);
    expect(d?.jammed).toBe(false);
    expect(d?.drained).toBe(true);
    expect(
      buildStatusEnvelope(
        makeSnap({
          epics: [{ epic_id: "fn-42-lane", status: "done", tasks: [] }],
          worktreeMode: true,
          autopilotPaused: true,
          landedEpicIds: ["fn-42-lane"],
        }),
        BOOT,
        [],
      ).data?.needs_human.finalize_pending,
    ).toBe(0);
  });

  test("legacy wrapped Provider-leg gauge excludes durable ownership and never jams", () => {
    const snap = makeSnap({
      jobsDetailed: [
        {
          state: "stopped",
          jobId: "legacy-leg",
          title: "fn-1300-cascade.4",
          birthSession: "wrapped",
        },
        {
          state: "stopped",
          jobId: "owned-leg",
          title: "fn-1300-cascade.4",
          birthSession: "wrapped",
        },
      ],
      providerLegOwnership: [
        { leg_launch_id: "launch-owned", leg_session_id: "owned-leg" },
      ],
    });
    expect(countLegacyWrappedProviderLegs(snap)).toBe(1);
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.drain.legacy_wrapped_provider_legs).toBe(1);
    expect(d?.needs_human.total).toBe(0);
    expect(d?.jammed).toBe(false);
    expect(d?.drained).toBe(true);
  });

  test("in-flight counts pending dispatches + working jobs", () => {
    const snap = makeSnap({
      pendingDispatches: 2,
      jobsByState: ["working", "stopped", "working"],
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.in_flight.pending_dispatches).toBe(2);
    expect(d?.in_flight.running_jobs).toBe(2);
    // Neither working job carries a dispatch_origin — plain working sessions,
    // not Board-work ones.
    expect(d?.in_flight.board_work_jobs).toBe(0);
    expect(d?.in_flight.total).toBe(4);
    // in-flight work → not at rest → neither drained nor jammed
    expect(d?.drained).toBe(false);
    expect(d?.jammed).toBe(false);
  });

  test("in-flight: board_work_jobs counts only autopilot/escalation working sessions, excluding the caller's own", () => {
    const snap = makeSnap({
      jobsDetailed: [
        // An interactive session — including the one asking this very
        // question — is NOT a board-work session (null dispatch_origin).
        { state: "working", jobId: "interactive-1", dispatchOrigin: null },
        // A live autopilot work/close dispatch and an escalation session both
        // count…
        { state: "working", jobId: "w-1", dispatchOrigin: "autopilot" },
        { state: "working", jobId: "e-1", dispatchOrigin: "escalation" },
        // …but not a stopped one, and not the caller's own even when it is
        // itself an autopilot dispatch (the reproduced case: a supervising
        // session can itself be a work:: job).
        { state: "stopped", jobId: "w-2", dispatchOrigin: "autopilot" },
        { state: "working", jobId: "me", dispatchOrigin: "autopilot" },
      ],
    });
    const withoutOwnSession = buildStatusEnvelope(snap, BOOT, []).data;
    expect(withoutOwnSession?.in_flight.running_jobs).toBe(4);
    expect(withoutOwnSession?.in_flight.board_work_jobs).toBe(3);

    const withOwnSession = buildStatusEnvelope(snap, BOOT, [], "me").data;
    expect(withOwnSession?.in_flight.running_jobs).toBe(4);
    expect(withOwnSession?.in_flight.board_work_jobs).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// runStatus snapshot sourcing (ADR 0011) — the sticky `dispatch_failures` rows
// ride the readiness snapshot via `includeDispatchFailures`, so `keeper status`
// reads them in ONE round-trip (no out-of-band `queryCollection`) and the
// envelope's jammed / needs-human math reflects the snapshot-delivered rows.
// ---------------------------------------------------------------------------

interface StatusMockSocket extends ReadinessSocket {
  readonly outbound: string[];
  handlers: SocketHandlers;
  deliver(frames: ServerFrame[]): void;
}

/** Minimal mock connect: `open` fires synchronously so the subscribe's queries
 *  are on `outbound` before `runStatus` returns; `deliver` feeds inbound frames
 *  routed by collection (the driver's `byCollection` fallback). */
function makeStatusMockConnect(): {
  factory: ConnectFactory;
  sockets: StatusMockSocket[];
} {
  const sockets: StatusMockSocket[] = [];
  const factory: ConnectFactory = async (_path, handlers) => {
    let resolveDone: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const sock: StatusMockSocket = {
      outbound: [],
      handlers,
      write(data: string): void {
        sock.outbound.push(data);
      },
      end(): void {
        resolveDone?.();
        resolveDone = null;
      },
      terminate(): void {
        resolveDone?.();
        resolveDone = null;
      },
      deliver(frames: ServerFrame[]): void {
        sock.handlers.data(
          sock,
          Buffer.from(frames.map(encodeFrame).join(""), "utf8"),
        );
      },
    };
    sockets.push(sock);
    handlers.open(sock);
    await done;
    return sock;
  };
  return { factory, sockets };
}

/** The eleven base readiness collections + `epics_recent_done`/`lane_merged`
 *  landed-set opt-in + status's failure, ownership, and pin opt-ins, as one
 *  result batch. Routed by collection, so no idPrefix bookkeeping. */
function statusReadinessFrames(
  dispatchFailures: Record<string, unknown>[],
  epics: Record<string, unknown>[] = [],
  pinnedEpics: Record<string, unknown>[] = [],
): ServerFrame[] {
  const empty = (collection: string): ServerFrame => ({
    type: "result",
    id: collection,
    collection,
    rev: 1,
    total: 0,
    rows: [],
  });
  return [
    {
      type: "result",
      id: "epics",
      collection: "epics",
      rev: 1,
      total: epics.length,
      rows: epics,
    },
    empty("jobs"),
    empty("subagent_invocations"),
    empty("git"),
    empty("dead_letters"),
    empty("pending_dispatches"),
    empty("autopilot_state"),
    empty("armed_epics"),
    empty("scheduled_tasks"),
    empty("block_escalations"),
    empty("tmux_client_focus"),
    empty("epics_recent_done"),
    empty("lane_merged"),
    {
      type: "result",
      id: "dispatch_failures",
      collection: "dispatch_failures",
      rev: 1,
      total: dispatchFailures.length,
      rows: dispatchFailures,
    },
    empty("provider_leg_ownership"),
    {
      type: "result",
      id: "epics_pinned",
      collection: "epics_pinned",
      rev: 1,
      total: pinnedEpics.length,
      rows: pinnedEpics,
    },
  ];
}

function statusArgs(): ParsedStatusArgs {
  return {
    sock: "/tmp/keeper-mock.sock",
    connectTimeoutMs: DEFAULT_CONNECT_DEADLINE_MS,
    format: "json",
  };
}

/** Captures stdout + exit code on an object (property access dodges the closure
 *  narrowing that would pin a `let` to its `null` initializer). */
function makeStatusDeps(factory: ConnectFactory): {
  deps: RunStatusDeps;
  cap: { stdout: string[]; exitCode: number | null };
} {
  const cap: { stdout: string[]; exitCode: number | null } = {
    stdout: [],
    exitCode: null,
  };
  const deps: RunStatusDeps = {
    writeStdout: (s) => cap.stdout.push(s),
    writeStderr: () => {},
    exit: ((code: number) => {
      cap.exitCode = code;
      return undefined as never;
    }) as (code: number) => never,
    connect: factory,
  };
  return { deps, cap };
}

describe("runStatus dispatch_failures snapshot sourcing (ADR 0011)", () => {
  test("opts into includeDispatchFailures — dispatch_failures rides the readiness subscribe, no separate round-trip", async () => {
    const { factory, sockets } = makeStatusMockConnect();
    const { deps, cap } = makeStatusDeps(factory);

    await runStatus(statusArgs(), deps);
    // Exactly ONE connection opened (the readiness subscribe) — no bespoke
    // dispatch_failures socket.
    expect(sockets).toHaveLength(1);
    const sock = sockets[0];
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    const collections = sock.outbound.map((line) => {
      const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
      return (JSON.parse(trimmed) as { collection: string }).collection;
    });
    // The one subscribe carries dispatch_failures — the rows arrive on the SAME
    // snapshot, so there is no out-of-band queryCollection.
    expect(collections).toContain("dispatch_failures");
    expect(collections).toContain("provider_leg_ownership");

    // A jam sticky delivered on the snapshot flows into the envelope's
    // needs-human / jammed math (board otherwise at rest).
    sock.deliver(
      statusReadinessFrames([
        { verb: "close", id: "fn-1-a", reason: "worktree-merge-conflict" },
      ]),
    );
    expect(cap.exitCode).toBe(0);
    expect(cap.stdout).toHaveLength(1);
    const env = JSON.parse(cap.stdout[0] ?? "{}") as {
      ok: boolean;
      data: {
        jammed: boolean;
        drained: boolean;
        needs_human: { stuck_dispatches: number; total: number };
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.needs_human.stuck_dispatches).toBe(1);
    expect(env.data.needs_human.total).toBe(1);
    expect(env.data.jammed).toBe(true);
    expect(env.data.drained).toBe(false);
  });

  test("an empty dispatch_failures collection → drained, no jam (rows sourced from the snapshot)", async () => {
    const { factory, sockets } = makeStatusMockConnect();
    const { deps, cap } = makeStatusDeps(factory);

    await runStatus(statusArgs(), deps);
    const sock = sockets[0];
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    sock.deliver(statusReadinessFrames([]));
    expect(cap.exitCode).toBe(0);
    const env = JSON.parse(cap.stdout[0] ?? "{}") as {
      data: { jammed: boolean; drained: boolean };
    };
    expect(env.data.jammed).toBe(false);
    expect(env.data.drained).toBe(true);
  });
});

describe("runStatus pinned-epics snapshot sourcing (ADR 0018, fn-1175.2)", () => {
  test("opts into includePinnedEpics — a plan-closed epic with a live close failure lands in board.epics with its dispatch_failure kinds, needs_human total unaffected by the pin", async () => {
    const { factory, sockets } = makeStatusMockConnect();
    const { deps, cap } = makeStatusDeps(factory);

    await runStatus(statusArgs(), deps);
    // Still exactly ONE connection — the pin window rides the same readiness
    // subscribe, no bespoke round-trip.
    expect(sockets).toHaveLength(1);
    const sock = sockets[0];
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    const collections = sock.outbound.map((line) => {
      const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
      return (JSON.parse(trimmed) as { collection: string }).collection;
    });
    expect(collections).toContain("epics_pinned");

    // fn-9-x is plan-closed (status: "done") and off the OPEN `epics` result
    // ([]), but carries a live close dispatch failure and rides the
    // `epics_pinned` window — the merge (ADR 0018, task .1) folds it into
    // `epics` open-wins so it gets a real `completeReadiness` verdict.
    sock.deliver(
      statusReadinessFrames(
        [{ verb: "close", id: "fn-9-x", reason: "worktree-merge-conflict" }],
        [],
        [{ epic_id: "fn-9-x", epic_number: 9, status: "done", tasks: [] }],
      ),
    );
    expect(cap.exitCode).toBe(0);
    const env = JSON.parse(cap.stdout[0] ?? "{}") as {
      data: {
        board: {
          epics: Array<{
            epic_id: string;
            status: string | null;
            question: string | null;
            verdict: string;
            pill: string;
            last_evidence_at: number | null;
            dispatch_failure: string[];
            tasks: unknown[];
            close: {
              verdict: string;
              pill: string;
              last_evidence_at: number | null;
              dispatch_failure: string[];
            } | null;
          }>;
        };
        needs_human: { stuck_dispatches: number; total: number };
      };
    };
    // Hand-computed: one pinned epic, real "completed" verdicts (status
    // "done", zero tasks, no embedded jobs), its close row carries the
    // classified "merge-conflict" kind.
    expect(env.data.board.epics).toEqual([
      {
        epic_id: "fn-9-x",
        status: "done",
        question: null,
        verdict: "completed",
        pill: "[completed]",
        last_evidence_at: null,
        dispatch_failure: [],
        tasks: [],
        close: {
          verdict: "completed",
          pill: "[completed]",
          last_evidence_at: null,
          dispatch_failure: ["merge-conflict"],
        },
      },
    ]);
    // The umbrella count is a straight tally of every sticky row regardless of
    // homing (`stuckDispatches = rows.length`) — pinning changes WHICH board
    // row the kinds attach to, never the total.
    expect(env.data.needs_human.stuck_dispatches).toBe(1);
    expect(env.data.needs_human.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runStatus event-store delivery (fn-1312) — the block reaches the envelope
// through BOTH live `result` frame shapes. Memoized steady state and catch-up
// object frames carry the same durable identity and current Drain header. Each
// expected block below is a hand-authored constant, never re-derived from the daemon.
// ---------------------------------------------------------------------------

/** A fixed event-store block for the delivery fixtures. */
const FIXTURE_EVENT_STORE: EventStoreStatus = {
  event_count: 4242,
  db_bytes: 1_048_576,
  last_boot_catchup: { duration_ms: 3000, events_folded: 600 },
  projected_catchup_duration_ms: 0,
  projected_full_replay_duration_ms: 21_210,
};

/** Stamp `event_store` top-level on every `result` frame (mirroring the live
 *  serve, which carries it on the memo line + the object frame), plus an
 *  optional `boot` header — so the fixtures reproduce both real frame shapes. */
function withEventStore(
  frames: ServerFrame[],
  eventStore: EventStoreStatus,
  boot?: BootStatus,
): ServerFrame[] {
  return frames.map((f) =>
    f.type === "result"
      ? {
          ...f,
          event_store: eventStore,
          ...(boot === undefined ? {} : { boot }),
        }
      : f,
  );
}

describe("runStatus event-store delivery (fn-1312)", () => {
  test("steady-state shape: memoized results carry the block plus durable identity and completed Drain", async () => {
    const { factory, sockets } = makeStatusMockConnect();
    const { deps, cap } = makeStatusDeps(factory);

    await runStatus(statusArgs(), deps);
    const sock = sockets[0];
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    const boot: BootStatus = {
      boot_id: "boot-steady",
      pid: 4242,
      start_time: "linux:123456",
      rev: 1,
      head_event_id: 1,
      catching_up: false,
      git_seed_required: false,
    };
    sock.deliver(
      withEventStore(statusReadinessFrames([]), FIXTURE_EVENT_STORE, boot),
    );

    expect(cap.exitCode).toBe(0);
    const env = JSON.parse(cap.stdout[0] ?? "{}") as {
      data: { event_store: EventStoreStatus | null; catching_up: boolean };
    };
    expect(boot).toMatchObject({
      boot_id: "boot-steady",
      pid: 4242,
      start_time: "linux:123456",
      catching_up: false,
    });
    expect(env.data.event_store).toEqual(FIXTURE_EVENT_STORE);
    expect(env.data.catching_up).toBe(false);
  });

  test("catch-up shape: the block rides the frame ALONGSIDE the boot header, and both flow through", async () => {
    const { factory, sockets } = makeStatusMockConnect();
    const { deps, cap } = makeStatusDeps(factory);

    await runStatus(statusArgs(), deps);
    const sock = sockets[0];
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    const boot: BootStatus = {
      boot_id: "boot-catching-up",
      pid: 4343,
      start_time: "linux:654321",
      rev: 7,
      head_event_id: 9,
      catching_up: true,
      git_seed_required: false,
    };
    // A booting daemon's object frame stamps BOTH the block and the header.
    sock.deliver(
      withEventStore(statusReadinessFrames([]), FIXTURE_EVENT_STORE, boot),
    );

    expect(cap.exitCode).toBe(0);
    const env = JSON.parse(cap.stdout[0] ?? "{}") as {
      data: {
        event_store: EventStoreStatus | null;
        catching_up: boolean;
        rev: number | null;
      };
    };
    // The block still lands via onEventStore, and the header still drives
    // rev/catching_up via onBootStatus — the two callbacks are independent.
    expect(env.data.event_store).toEqual(FIXTURE_EVENT_STORE);
    expect(env.data.catching_up).toBe(true);
    expect(env.data.rev).toBe(7);
  });
});

describe("buildStatusErrorEnvelope", () => {
  test("transport failure envelope carries the error object with ok:false", () => {
    const env = buildStatusErrorEnvelope({
      code: "unreachable",
      message: "unreachable: down",
      recovery: "restart the daemon",
    });
    expect(env).toEqual({
      schema_version: STATUS_SCHEMA_VERSION,
      ok: false,
      error: {
        code: "unreachable",
        message: "unreachable: down",
        recovery: "restart the daemon",
      },
      data: null,
    });
    // message preserves the old bare string so a stringifying consumer degrades.
    expect(env.error?.message).toBe("unreachable: down");
  });
});

// ---------------------------------------------------------------------------
// parseStatusArgs
// ---------------------------------------------------------------------------

describe("parseStatusArgs", () => {
  test("defaults the connect deadline to ~10s", () => {
    const r = parseStatusArgs([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.connectTimeoutMs).toBe(DEFAULT_CONNECT_DEADLINE_MS);
  });

  test("--connect-timeout parses a duration", () => {
    const r = parseStatusArgs(["--connect-timeout", "5s"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.connectTimeoutMs).toBe(5000);
  });

  test("a bad --connect-timeout is a usage error", () => {
    const r = parseStatusArgs(["--connect-timeout", "soon"]);
    expect(r.ok).toBe(false);
  });

  test("a unitless --connect-timeout is rejected (exit 2) with a self-healing hint", () => {
    const r = parseStatusArgs(["--connect-timeout", "5"]);
    if (r.ok) throw new Error("expected a usage error for a unitless duration");
    expect(r.exitCode).toBe(2);
    expect(r.message).toContain("--connect-timeout");
    expect(r.message).toContain("5s");
  });

  test("--help is surfaced as the __help__ sentinel", () => {
    const r = parseStatusArgs(["--help"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe("__help__");
  });

  test("an unknown flag is a usage error", () => {
    const r = parseStatusArgs(["--bogus"]);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// keeper query — allowlist gate, filter parsing, transport
// ---------------------------------------------------------------------------

describe("QUERY_READ_ALLOWLIST", () => {
  test("every allowlisted name is a real registry collection", () => {
    for (const name of QUERY_READ_ALLOWLIST) {
      expect(REGISTRY.has(name)).toBe(true);
    }
  });
});

describe("parseQueryArgs", () => {
  test("an allowlisted collection parses", () => {
    const r = parseQueryArgs(["epics"]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.args.collection).toBe("epics");
      expect(r.args.filter).toEqual({});
    }
  });

  test("an off-allowlist collection is rejected at parse time", () => {
    const r = parseQueryArgs(["secrets"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("not readable");
  });

  test("a missing collection is a usage error", () => {
    const r = parseQueryArgs([]);
    expect(r.ok).toBe(false);
  });

  test("--filter k=v builds the exact-match filter map", () => {
    const r = parseQueryArgs(["jobs", "--filter", "state=working"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.filter).toEqual({ state: "working" });
  });

  test("a malformed --filter (no =) is a usage error", () => {
    const r = parseQueryArgs(["jobs", "--filter", "state"]);
    expect(r.ok).toBe(false);
  });
});

describe("runQueryCommand", () => {
  type QueryFn = (
    sock: string,
    collection: string,
    filter?: Record<string, FilterValue>,
  ) => Promise<Record<string, unknown>[]>;

  function harness(query: QueryFn) {
    const out: string[] = [];
    const err: string[] = [];
    let code: number | null = null;
    return {
      out,
      err,
      get code() {
        return code;
      },
      deps: {
        query,
        writeStdout: (s: string) => out.push(s),
        writeStderr: (s: string) => err.push(s),
        exit: (c: number): never => {
          code = c;
          throw new ExitError(c);
        },
      },
    };
  }

  async function run(h: ReturnType<typeof harness>): Promise<void> {
    try {
      await runQueryCommand(
        { collection: "epics", filter: {}, sock: "/tmp/s", format: "json" },
        h.deps,
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }
  }

  test("success prints a JSON envelope with the rows and exits 0", async () => {
    const rows = [{ epic_id: "fn-1-a" }, { epic_id: "fn-2-b" }];
    const h = harness(() => Promise.resolve(rows));
    await run(h);
    expect(h.code).toBe(0);
    const env = JSON.parse(h.out.join(""));
    expect(env.schema_version).toBe(QUERY_SCHEMA_VERSION);
    expect(env.ok).toBe(true);
    expect(env.data).toEqual(rows);
    expect(h.err).toEqual([]);
  });

  test("a transport throw lands an ok:false envelope on stdout, exit 1, empty stderr", async () => {
    const h = harness(() =>
      Promise.reject(
        new Error("daemon error querying 'epics': bad_frame: nope"),
      ),
    );
    await run(h);
    expect(h.code).toBe(1);
    // The failure rides stdout as an envelope — never empty stdout + stderr prose.
    expect(h.err).toEqual([]);
    const env = JSON.parse(h.out.join(""));
    expect(env.schema_version).toBe(QUERY_SCHEMA_VERSION);
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.error.code).toBe("query_failed");
    expect(env.error.message).toContain("bad_frame");
    expect(typeof env.error.recovery).toBe("string");
    expect(env.error.recovery.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// keeper query tasks — derived flat-task view + readiness verdict
// ---------------------------------------------------------------------------

/** A readiness snapshot with two tasks under one epic + their per-task verdicts
 *  (the shape `flattenTaskRows` reads). Minimal cast, as elsewhere. */
function taskSnap(): ReadinessClientSnapshot {
  const epics = [
    {
      epic_id: "fn-1-a",
      tasks: [
        {
          task_id: "fn-1-a.1",
          epic_id: "fn-1-a",
          title: "Do X",
          tier: "high",
          model: "opus",
          depends_on: [],
          runtime_status: "todo",
        },
        {
          task_id: "fn-1-a.2",
          epic_id: "fn-1-a",
          title: "Do Y",
          tier: "low",
          model: "sonnet",
          depends_on: ["fn-1-a.1"],
          runtime_status: "blocked",
        },
      ],
    },
  ];
  const perTask = new Map<string, Verdict>([
    ["fn-1-a.1", { tag: "ready" }],
    // fn-1-a.2 deliberately ABSENT → the inert unknown view.
  ]);
  return {
    epics,
    readiness: {
      perTask,
      perCloseRow: new Map(),
      perEpic: new Map(),
      diagnostics: [],
    },
  } as unknown as ReadinessClientSnapshot;
}

describe("flattenTaskRows", () => {
  test("one row per task carries the plan fields + live verdict", () => {
    const rows = flattenTaskRows(taskSnap());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      epic_id: "fn-1-a",
      task_id: "fn-1-a.1",
      title: "Do X",
      tier: "high",
      model: "opus",
      depends_on: [],
      runtime_status: "todo",
      verdict: "ready",
      pill: "[ready]",
    });
    // a perTask miss renders the inert [blocked:unknown] view (matches board).
    expect(rows[1]?.verdict).toBe("unknown");
    expect(rows[1]?.pill).toBe("[blocked:unknown]");
    expect(rows[1]?.depends_on).toEqual(["fn-1-a.1"]);
  });

  test("a scalar --filter exact-matches; unknown/non-scalar keys ignored", () => {
    expect(
      flattenTaskRows(taskSnap(), { runtime_status: "todo" }),
    ).toHaveLength(1);
    expect(flattenTaskRows(taskSnap(), { epic_id: "fn-1-a" })).toHaveLength(2);
    expect(flattenTaskRows(taskSnap(), { verdict: "unknown" })).toHaveLength(1);
    // unknown key → ignored (forward-compat), not a zero-match.
    expect(flattenTaskRows(taskSnap(), { bogus: "x" })).toHaveLength(2);
  });
});

describe("keeper query tasks routing + runner", () => {
  test("'tasks' is a recognized virtual collection that parses", () => {
    expect(VIRTUAL_QUERY_COLLECTIONS.has("tasks")).toBe(true);
    const r = parseQueryArgs(["tasks"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.collection).toBe("tasks");
  });

  test("runTasksCommand success prints the flat rows envelope, exit 0", async () => {
    const out: string[] = [];
    let code: number | null = null;
    await runTasksCommand(
      { collection: "tasks", filter: {}, sock: "/tmp/s", format: "json" },
      {
        fetchSnapshot: () => Promise.resolve(taskSnap()),
        writeStdout: (s) => out.push(s),
        exit: (c: number): never => {
          code = c;
          throw new ExitError(c);
        },
      },
    ).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(code as number | null).toBe(0);
    const env = JSON.parse(out.join(""));
    expect(env.schema_version).toBe(QUERY_SCHEMA_VERSION);
    expect(env.ok).toBe(true);
    expect(env.data).toHaveLength(2);
    expect(env.data[0].task_id).toBe("fn-1-a.1");
  });

  test("a fetchSnapshot throw lands an ok:false envelope on stdout, exit 1", async () => {
    const out: string[] = [];
    let code: number | null = null;
    await runTasksCommand(
      { collection: "tasks", filter: {}, sock: "/tmp/s", format: "json" },
      {
        fetchSnapshot: () => Promise.reject(new Error("unreachable: down")),
        writeStdout: (s) => out.push(s),
        exit: (c: number): never => {
          code = c;
          throw new ExitError(c);
        },
      },
    ).catch((e) => {
      if (!(e instanceof ExitError)) throw e;
    });
    expect(code as number | null).toBe(1);
    const env = JSON.parse(out.join(""));
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.error.code).toBe("query_failed");
    expect(env.error.message).toContain("unreachable");
    expect(env.error.recovery.length).toBeGreaterThan(0);
  });
});
