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
  DEFAULT_CONNECT_DEADLINE_MS,
  type ParsedStatusArgs,
  parseStatusArgs,
  type RunStatusDeps,
  runStatus,
  STATUS_SCHEMA_VERSION,
  type StatusBootInfo,
} from "../cli/status";
import { QUERY_READ_ALLOWLIST, REGISTRY } from "../src/collections";
import {
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
}
interface FixtureEpic {
  epic_id: string;
  status: string | null;
  tasks: FixtureTask[];
  question?: string | null;
  selection_review?: string | null;
}

interface SnapOverrides {
  epics?: FixtureEpic[];
  jobsByState?: string[];
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
  // The narrow unfiltered flagged-epic read (any status) behind the display-only
  // `needs_human.selection_reviews` count. Each entry carries a `selection_review`
  // blob; a cleared entry (null) is filtered out by the count.
  selectionReviewEpics?: FixtureEpic[];
}

function makeSnap(o: SnapOverrides = {}): ReadinessClientSnapshot {
  const jobs = new Map<string, { state: string }>();
  (o.jobsByState ?? []).forEach((state, i) => {
    jobs.set(`job-${i}`, { state });
  });
  const toMap = (
    rec: Record<string, Verdict> | undefined,
  ): Map<string, Verdict> => new Map(Object.entries(rec ?? {}));
  return {
    epics: (o.epics ?? []) as unknown as ReadinessClientSnapshot["epics"],
    ...(o.selectionReviewEpics === undefined
      ? {}
      : {
          selectionReviewEpics:
            o.selectionReviewEpics as unknown as ReadinessClientSnapshot["selectionReviewEpics"],
        }),
    jobs: jobs as unknown as ReadinessClientSnapshot["jobs"],
    subagentInvocations: [],
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
    readiness: {
      perTask: toMap(o.perTask),
      perCloseRow: toMap(o.perCloseRow),
      perEpic: toMap(o.perEpic),
      diagnostics: [],
    },
  } as unknown as ReadinessClientSnapshot;
}

const BOOT: StatusBootInfo = { rev: 4242, catching_up: false };

// ---------------------------------------------------------------------------
// buildStatusEnvelope — envelope shape + field presence
// ---------------------------------------------------------------------------

describe("buildStatusEnvelope shape", () => {
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
        dispatch_failure: [],
      },
    ]);
    expect(epic?.close?.verdict).toBe("blocked");
    expect(epic?.close?.pill).toContain("dep-on-task");
    // boot header passthrough
    expect(d.rev).toBe(4242);
    expect(d.catching_up).toBe(false);
    // count + flag + in_flight + needs_human blocks present
    expect(d.counts.epics.total).toBe(1);
    expect(d.counts.tasks.ready).toBe(1);
    expect(typeof d.drained).toBe("boolean");
    expect(typeof d.jammed).toBe("boolean");
    expect(d.in_flight).toEqual({
      pending_dispatches: 0,
      running_jobs: 0,
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

  test("selection_reviews counts flagged epics of ANY status off the narrow read; a flagged CLOSED epic still counts (ADR 0011)", () => {
    // The narrow read carries an OPEN flagged epic and a CLOSED flagged epic —
    // the closed one is absent from `board.epics` (open-filtered) but must still
    // count. Hand-computed: selection_reviews = 2.
    const flag = '{"counts":{"underpowered":1,"overpowered":2}}';
    const snap = makeSnap({
      epics: [{ epic_id: "fn-1-open", status: "open", tasks: [] }],
      perEpic: { "fn-1-open": { tag: "ready" } },
      selectionReviewEpics: [
        {
          epic_id: "fn-1-open",
          status: "open",
          tasks: [],
          selection_review: flag,
        },
        {
          epic_id: "fn-9-closed",
          status: "done",
          tasks: [],
          selection_review: flag,
        },
      ],
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.needs_human.selection_reviews).toBe(2);
  });

  test("the selection-review flag contributes ZERO to total and never flips jammed, across flagged/cleared variants (ADR 0011)", () => {
    const flag = '{"counts":{"overpowered":1}}';
    // A board fully at rest (one done epic, no other needs-human signal) with a
    // flagged closed epic on the narrow read: drained, NOT jammed, total 0.
    const flagged = makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "done", tasks: [] }],
      perEpic: { "fn-1-a": { tag: "completed" } },
      selectionReviewEpics: [
        {
          epic_id: "fn-9-closed",
          status: "done",
          tasks: [],
          selection_review: flag,
        },
      ],
    });
    const df = buildStatusEnvelope(flagged, BOOT, []).data;
    expect(df?.needs_human.selection_reviews).toBe(1);
    expect(df?.needs_human.total).toBe(0);
    expect(df?.jammed).toBe(false);
    expect(df?.drained).toBe(true);

    // Same board with the review CLEARED (the narrow read drops to a null blob):
    // selection_reviews falls to 0, total/jammed/drained unchanged.
    const cleared = makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "done", tasks: [] }],
      perEpic: { "fn-1-a": { tag: "completed" } },
      selectionReviewEpics: [
        {
          epic_id: "fn-9-closed",
          status: "done",
          tasks: [],
          selection_review: null,
        },
      ],
    });
    const dc = buildStatusEnvelope(cleared, BOOT, []).data;
    expect(dc?.needs_human.selection_reviews).toBe(0);
    expect(dc?.needs_human.total).toBe(0);
    expect(dc?.jammed).toBe(false);
    expect(dc?.drained).toBe(true);
  });

  test("selection_reviews defaults to 0 when the narrow read is absent (opt-in off)", () => {
    const d = buildStatusEnvelope(makeSnap(), BOOT, []).data;
    expect(d?.needs_human.selection_reviews).toBe(0);
  });

  test("the whole needs_human block is byte-identical off the shared projector (fields + order)", () => {
    // A mixed board: 2 dead letters, 1 block escalation, 1 parked question, and
    // 4 sticky rows — one finalize-non-ff subset + two breaker subsets + one
    // plain merge-conflict. Hand-computed: stuck=4, finalize_non_ff=1,
    // instant_death_wall=2, parked=1, total = 2+1+4+1 = 8 (subsets never added).
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
      "parked_questions",
      "instant_death_wall",
      "selection_reviews",
      "total",
    ]);
    expect(d?.needs_human).toEqual({
      dead_letters: 2,
      block_escalations: 1,
      stuck_dispatches: 4,
      finalize_non_ff: 1,
      parked_questions: 1,
      instant_death_wall: 2,
      selection_reviews: 0,
      total: 8,
    });
  });

  test("in-flight counts pending dispatches + working jobs", () => {
    const snap = makeSnap({
      pendingDispatches: 2,
      jobsByState: ["working", "stopped", "working"],
    });
    const d = buildStatusEnvelope(snap, BOOT, []).data;
    expect(d?.in_flight.pending_dispatches).toBe(2);
    expect(d?.in_flight.running_jobs).toBe(2);
    expect(d?.in_flight.total).toBe(4);
    // in-flight work → not at rest → neither drained nor jammed
    expect(d?.drained).toBe(false);
    expect(d?.jammed).toBe(false);
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

/** The eleven base readiness collections + the `dispatch_failures` and
 *  `epics_selection_review` opt-ins, as a single `result` batch. Routed by
 *  collection, so no idPrefix bookkeeping. */
function statusReadinessFrames(
  dispatchFailures: Record<string, unknown>[],
  epics: Record<string, unknown>[] = [],
  selectionReviewEpics: Record<string, unknown>[] = [],
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
    {
      type: "result",
      id: "dispatch_failures",
      collection: "dispatch_failures",
      rev: 1,
      total: dispatchFailures.length,
      rows: dispatchFailures,
    },
    {
      type: "result",
      id: "epics_selection_review",
      collection: "epics_selection_review",
      rev: 1,
      total: selectionReviewEpics.length,
      rows: selectionReviewEpics,
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

  test("opts into includeSelectionReviewEpics — a flagged CLOSED epic (absent from board.epics) counts, adds zero to total/jammed (ADR 0011)", async () => {
    const { factory, sockets } = makeStatusMockConnect();
    const { deps, cap } = makeStatusDeps(factory);

    await runStatus(statusArgs(), deps);
    const sock = sockets[0];
    if (!sock) {
      throw new Error("mock socket never installed");
    }
    const collections = sock.outbound.map((line) => {
      const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
      return (JSON.parse(trimmed) as { collection: string }).collection;
    });
    // The flagged-epic read rides the SAME subscribe — one round-trip.
    expect(collections).toContain("epics_selection_review");
    expect(sockets).toHaveLength(1);

    // Board otherwise at rest (no open epics), one flagged CLOSED epic on the
    // narrow read only. It counts, but stays out of total and never jams.
    sock.deliver(
      statusReadinessFrames(
        [],
        [],
        [
          {
            epic_id: "fn-9-closed",
            status: "done",
            selection_review: '{"counts":{"overpowered":1}}',
          },
        ],
      ),
    );
    expect(cap.exitCode).toBe(0);
    const env = JSON.parse(cap.stdout[0] ?? "{}") as {
      data: {
        jammed: boolean;
        drained: boolean;
        needs_human: { selection_reviews: number; total: number };
      };
    };
    expect(env.data.needs_human.selection_reviews).toBe(1);
    expect(env.data.needs_human.total).toBe(0);
    expect(env.data.jammed).toBe(false);
    expect(env.data.drained).toBe(true);
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
