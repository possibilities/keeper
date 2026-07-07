/**
 * Pure tests for `keeper watch` (fn-1015) — the coarse board projection +
 * diff and the arg parser. No daemon, no subscribe: build two snapshots, project
 * them, diff, and assert the coarse delta lines (a null-diff yields none).
 */

import { expect, test } from "bun:test";
import {
  createDeltaEmitter,
  diffCoarseBoard,
  parseWatchArgs,
  projectCoarseBoard,
  WATCH_DELTA_TYPES,
} from "../cli/watch";
import {
  INSTANT_DEATH_BREAKER_REASON,
  MERGE_ESCALATION_REASON_TOKEN,
  SLOT_OCCUPIED_REASON_PREFIX,
  WORKTREE_FINALIZE_NON_FF_REASON,
} from "../src/dispatch-failure-key";
import type { Verdict } from "../src/readiness";
import { computeReadiness } from "../src/readiness";
import type { ReadinessClientSnapshot } from "../src/readiness-client";
import type { EmbeddedJob, Epic, Job, Task } from "../src/types";

interface SnapOverrides {
  epics?: {
    epic_id: string;
    status: string | null;
    tasks?: { task_id: string; runtime_status: string }[];
    /** A parked closer question (a needs-human `parked-question` signal). */
    question?: string | null;
  }[];
  jobsByState?: Record<string, string>;
  perTask?: Record<string, Verdict>;
  perCloseRow?: Record<string, Verdict>;
  perEpic?: Record<string, Verdict>;
  autopilotMode?: "yolo" | "armed";
  autopilotPaused?: boolean;
  worktreeMode?: boolean;
  maxConcurrentJobs?: number | null;
  maxConcurrentPerRoot?: number;
  maxConcurrentPerRootStored?: number;
  /** Parked dead-letter ids (each an `INSERT OR IGNORE` `dl_id`). */
  deadLetters?: string[];
  /** Open block-escalation task ids (the `(epic_id, task_id)` latch's task id). */
  blockEscalations?: string[];
  /** Sticky `dispatch_failures` rows (the `includeDispatchFailures` fold). A
   *  `last_event_id` bump with unchanged identity is the no-op-churn probe. */
  dispatchFailures?: {
    verb: string;
    id: string;
    reason: string;
    dir?: string;
    last_event_id?: number;
  }[];
}

function makeSnap(o: SnapOverrides = {}): ReadinessClientSnapshot {
  const jobs = new Map<string, { state: string }>();
  for (const [id, state] of Object.entries(o.jobsByState ?? {})) {
    jobs.set(id, { state });
  }
  const toMap = (
    rec: Record<string, Verdict> | undefined,
  ): Map<string, Verdict> => new Map(Object.entries(rec ?? {}));
  return {
    epics: (o.epics ?? []) as unknown as ReadinessClientSnapshot["epics"],
    jobs: jobs as unknown as ReadinessClientSnapshot["jobs"],
    subagentInvocations: [],
    scheduledTasks: [],
    gitStatus: [],
    deadLetters: (o.deadLetters ?? []).map((dl_id) => ({
      dl_id,
    })) as unknown as ReadinessClientSnapshot["deadLetters"],
    pendingDispatches: [],
    blockEscalations: (o.blockEscalations ?? []).map((task_id) => ({
      task_id,
    })) as unknown as ReadinessClientSnapshot["blockEscalations"],
    dispatchFailures: (o.dispatchFailures ?? []).map((r) => ({
      dir: "",
      ...r,
    })) as unknown as ReadinessClientSnapshot["dispatchFailures"],
    autopilotPaused: o.autopilotPaused ?? false,
    autopilotMode: o.autopilotMode ?? "yolo",
    maxConcurrentJobs:
      o.maxConcurrentJobs === undefined ? null : o.maxConcurrentJobs,
    maxConcurrentPerRoot: o.maxConcurrentPerRoot ?? 1,
    ...(o.maxConcurrentPerRootStored === undefined
      ? {}
      : { maxConcurrentPerRootStored: o.maxConcurrentPerRootStored }),
    worktreeMode: o.worktreeMode ?? false,
    readiness: {
      perTask: toMap(o.perTask),
      perCloseRow: toMap(o.perCloseRow),
      perEpic: toMap(o.perEpic),
      diagnostics: [],
    },
  } as unknown as ReadinessClientSnapshot;
}

const READY: Verdict = { tag: "ready" };
const DONE: Verdict = { tag: "completed" };

// ---------------------------------------------------------------------------
// diffCoarseBoard
// ---------------------------------------------------------------------------

test("diffCoarseBoard: identical boards → no deltas (null-diff)", () => {
  const snap = makeSnap({
    epics: [{ epic_id: "fn-1-a", status: "open" }],
    perTask: { "fn-1-a.1": READY },
    jobsByState: { "j-1": "working" },
  });
  const a = projectCoarseBoard(snap);
  const b = projectCoarseBoard(
    makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "open" }],
      perTask: { "fn-1-a.1": READY },
      jobsByState: { "j-1": "working" },
    }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([]);
});

test("diffCoarseBoard: an epic appears → epic-added", () => {
  const a = projectCoarseBoard(makeSnap({ epics: [] }));
  const b = projectCoarseBoard(
    makeSnap({ epics: [{ epic_id: "fn-2-b", status: "open" }] }),
  );
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("epic-added");
  expect(deltas[0]?.data).toEqual({ epic_id: "fn-2-b", status: "open" });
});

test("diffCoarseBoard: an epic leaves → epic-removed", () => {
  const a = projectCoarseBoard(
    makeSnap({ epics: [{ epic_id: "fn-1-a", status: "open" }] }),
  );
  const b = projectCoarseBoard(makeSnap({ epics: [] }));
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("epic-removed");
  expect(deltas[0]?.data).toEqual({ epic_id: "fn-1-a" });
});

test("diffCoarseBoard: a verdict transition → verdict-change", () => {
  const a = projectCoarseBoard(makeSnap({ perTask: { "fn-1-a.1": READY } }));
  const b = projectCoarseBoard(makeSnap({ perTask: { "fn-1-a.1": DONE } }));
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("verdict-change");
  expect(deltas[0]?.data).toEqual({
    kind: "task",
    id: "fn-1-a.1",
    from: "ready",
    to: "completed",
  });
});

test("diffCoarseBoard: a job-state move → job-state-change", () => {
  const a = projectCoarseBoard(makeSnap({ jobsByState: { "j-1": "working" } }));
  const b = projectCoarseBoard(makeSnap({ jobsByState: { "j-1": "stopped" } }));
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("job-state-change");
  expect(deltas[0]?.data).toEqual({
    job_id: "j-1",
    from: "working",
    to: "stopped",
  });
});

// ---------------------------------------------------------------------------
// fn-1101 — the raw `blocked` runtime-overlay (keeper plan block/unblock) is a
// coarse signal in its own right. The runtime-blocked readiness predicate
// (rank 10.6) converts ONLY an otherwise-`ready` row, so a block/unblock of a
// task blocked for another reason never moves its verdict — yet the overlay
// flip behind the board's `[rt:blocked]` pill IS a real move `keeper watch`
// must surface. Before the fix the coarse board tracked only verdicts, so the
// flip was dropped.
// ---------------------------------------------------------------------------

const DEP_BLOCKED: Verdict = {
  tag: "blocked",
  reason: { kind: "dep-on-task", upstream: "fn-1-a.1", cross_project: null },
} as unknown as Verdict;

test("diffCoarseBoard: unblock (blocked→todo) on a verdict-STABLE task still emits (runtime-status)", () => {
  // The task's verdict is `dep-on-task` in BOTH boards — only the raw overlay
  // flips. This is the dropped-delta the bug report hit.
  const a = projectCoarseBoard(
    makeSnap({
      epics: [
        {
          epic_id: "fn-1-a",
          status: "open",
          tasks: [{ task_id: "fn-1-a.2", runtime_status: "blocked" }],
        },
      ],
      perTask: { "fn-1-a.2": DEP_BLOCKED },
    }),
  );
  const b = projectCoarseBoard(
    makeSnap({
      epics: [
        {
          epic_id: "fn-1-a",
          status: "open",
          tasks: [{ task_id: "fn-1-a.2", runtime_status: "todo" }],
        },
      ],
      perTask: { "fn-1-a.2": DEP_BLOCKED },
    }),
  );
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("verdict-change");
  expect(deltas[0]?.data).toEqual({
    kind: "runtime-status",
    id: "fn-1-a.2",
    blocked: false,
  });
});

test("diffCoarseBoard: block (todo→blocked) on a verdict-stable task emits runtime-status blocked:true", () => {
  const a = projectCoarseBoard(
    makeSnap({
      epics: [
        {
          epic_id: "fn-1-a",
          status: "open",
          tasks: [{ task_id: "fn-1-a.2", runtime_status: "todo" }],
        },
      ],
      perTask: { "fn-1-a.2": DEP_BLOCKED },
    }),
  );
  const b = projectCoarseBoard(
    makeSnap({
      epics: [
        {
          epic_id: "fn-1-a",
          status: "open",
          tasks: [{ task_id: "fn-1-a.2", runtime_status: "blocked" }],
        },
      ],
      perTask: { "fn-1-a.2": DEP_BLOCKED },
    }),
  );
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.data).toEqual({
    kind: "runtime-status",
    id: "fn-1-a.2",
    blocked: true,
  });
});

test("diffCoarseBoard: routine runtime_status churn (todo→in_progress→done) emits no runtime-status delta", () => {
  // Only the `blocked` overlay is tracked — the other values already ride the
  // verdict + job-state families, so tracking them here would double-emit.
  const board = (rt: string) =>
    projectCoarseBoard(
      makeSnap({
        epics: [
          {
            epic_id: "fn-1-a",
            status: "open",
            tasks: [{ task_id: "fn-1-a.2", runtime_status: rt }],
          },
        ],
      }),
    );
  expect(diffCoarseBoard(board("todo"), board("in_progress"))).toEqual([]);
  expect(diffCoarseBoard(board("in_progress"), board("done"))).toEqual([]);
});

test("createDeltaEmitter: a settled unblock is emitted as signal, not swallowed by the flap-settle", () => {
  // fn-1101 Risk: the trailing flap-settle must treat a runtime-overlay flip as
  // a real (settled) change. A single blocked→todo transition that persists
  // past the window emits; only an A→B→A round-trip nets to nothing.
  const { clock, emitter, verdictChanges } = driveEmitter();
  const withRt = (rt: string) =>
    makeSnap({
      epics: [
        {
          epic_id: "fn-1-a",
          status: "open",
          tasks: [{ task_id: "fn-1-a.2", runtime_status: rt }],
        },
      ],
      perTask: { "fn-1-a.2": DEP_BLOCKED },
    });
  emitter.onSnapshot(withRt("blocked"));
  clock.advance(10); // baseline
  emitter.onSnapshot(withRt("todo")); // the unblock, persists past the window
  clock.advance(200);
  emitter.dispose();
  const vc = verdictChanges();
  expect(vc).toHaveLength(1);
  expect(vc[0]?.data).toEqual({
    kind: "runtime-status",
    id: "fn-1-a.2",
    blocked: false,
  });
});

test("diffCoarseBoard: an autopilot pause toggle → autopilot-change", () => {
  const a = projectCoarseBoard(makeSnap({ autopilotPaused: false }));
  const b = projectCoarseBoard(makeSnap({ autopilotPaused: true }));
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("autopilot-change");
});

test("diffCoarseBoard: setting the STORED per-root cap while worktree is off → autopilot-change (effective unchanged at 1)", () => {
  // Worktree off ⇒ effective stays 1, but the stored intent moving 1→3 is a real
  // board move that must surface. Both snaps carry effective 1.
  const a = projectCoarseBoard(
    makeSnap({
      worktreeMode: false,
      maxConcurrentPerRoot: 1,
      maxConcurrentPerRootStored: 1,
    }),
  );
  const b = projectCoarseBoard(
    makeSnap({
      worktreeMode: false,
      maxConcurrentPerRoot: 1,
      maxConcurrentPerRootStored: 3,
    }),
  );
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("autopilot-change");
});

test("diffCoarseBoard: an absent stored value nulls the field, never fabricated from effective", () => {
  const board = projectCoarseBoard(makeSnap({ maxConcurrentPerRoot: 1 }));
  expect(board.autopilot.max_concurrent_per_root).toBe(1);
  expect(board.autopilot.max_concurrent_per_root_stored).toBeUndefined();
});

test("diffCoarseBoard: git/subagent churn alone (no coarse field) → no deltas", () => {
  // Two snapshots differing only in dropped surfaces (gitStatus/subagent) hash
  // to the same coarse board → null-diff.
  const a = projectCoarseBoard(
    makeSnap({ epics: [{ epic_id: "fn-1-a", status: "open" }] }),
  );
  const b = projectCoarseBoard(
    makeSnap({ epics: [{ epic_id: "fn-1-a", status: "open" }] }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([]);
});

// ---------------------------------------------------------------------------
// parseWatchArgs
// ---------------------------------------------------------------------------

test("parseWatchArgs: bare → ok, empty filter (emit all)", () => {
  const r = parseWatchArgs([]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.filter.size).toBe(0);
});

test("parseWatchArgs: allowlisted --filter accepted", () => {
  const r = parseWatchArgs([
    "--filter",
    "verdict-change",
    "--filter",
    "epic-removed",
  ]);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  expect(r.args.filter.has("verdict-change")).toBe(true);
  expect(r.args.filter.has("epic-removed")).toBe(true);
});

test("parseWatchArgs: off-allowlist --filter → usage error (no socket)", () => {
  const r = parseWatchArgs(["--filter", "bogus"]);
  expect(r.ok).toBe(false);
});

test("parseWatchArgs: the six needs-human --filter type names are accepted", () => {
  const names = [
    "dead-letter",
    "block-escalation",
    "parked-question",
    "stuck-dispatch",
    "finalize-non-ff",
    "instant-death-wall",
  ];
  const argv = names.flatMap((n) => ["--filter", n]);
  const r = parseWatchArgs(argv);
  if (!r.ok) {
    throw new Error(`expected ok, got ${r.message}`);
  }
  for (const n of names) {
    expect(r.args.filter.has(n)).toBe(true);
  }
});

test("parseWatchArgs: --help → __help__ sentinel", () => {
  const r = parseWatchArgs(["--help"]);
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.message).toBe("__help__");
  }
});

test("WATCH_DELTA_TYPES carries the coarse delta vocabulary", () => {
  expect(new Set(WATCH_DELTA_TYPES)).toEqual(
    new Set([
      "epic-added",
      "epic-removed",
      "verdict-change",
      "job-state-change",
      "autopilot-change",
      "dead-letter",
      "block-escalation",
      "parked-question",
      "stuck-dispatch",
      "finalize-non-ff",
      "instant-death-wall",
    ]),
  );
});

// ---------------------------------------------------------------------------
// fn-1150.3 — the six needs-human families as additive top-level deltas. Each
// family emits a crisp appear/clear delta; the stream schema version is
// unchanged (WATCH_SCHEMA_VERSION stays 1) and unknown-type consumers no-op. The
// classification comes from the ONE shared projector (src/needs-human.ts) so
// watch never drifts from status/await on "stuck"/"jammed" (ADR 0011).
// ---------------------------------------------------------------------------

test("dead-letter: a parked dead letter appears → dead-letter appeared", () => {
  const a = projectCoarseBoard(makeSnap({ deadLetters: [] }));
  const b = projectCoarseBoard(makeSnap({ deadLetters: ["dl-1"] }));
  expect(diffCoarseBoard(a, b)).toEqual([
    { type: "dead-letter", data: { id: "dl-1", op: "appeared" } },
  ]);
});

test("dead-letter: a replayed dead letter clears → dead-letter cleared", () => {
  const a = projectCoarseBoard(makeSnap({ deadLetters: ["dl-1"] }));
  const b = projectCoarseBoard(makeSnap({ deadLetters: [] }));
  expect(diffCoarseBoard(a, b)).toEqual([
    { type: "dead-letter", data: { id: "dl-1", op: "cleared" } },
  ]);
});

test("dead-letter: the same parked set (no-op churn) → zero deltas", () => {
  const a = projectCoarseBoard(makeSnap({ deadLetters: ["dl-1", "dl-2"] }));
  const b = projectCoarseBoard(makeSnap({ deadLetters: ["dl-1", "dl-2"] }));
  expect(diffCoarseBoard(a, b)).toEqual([]);
});

test("block-escalation: a latched block appears → block-escalation appeared", () => {
  const a = projectCoarseBoard(makeSnap({ blockEscalations: [] }));
  const b = projectCoarseBoard(makeSnap({ blockEscalations: ["fn-1-a.2"] }));
  expect(diffCoarseBoard(a, b)).toEqual([
    { type: "block-escalation", data: { id: "fn-1-a.2", op: "appeared" } },
  ]);
});

test("block-escalation: a resolved block clears → block-escalation cleared", () => {
  const a = projectCoarseBoard(makeSnap({ blockEscalations: ["fn-1-a.2"] }));
  const b = projectCoarseBoard(makeSnap({ blockEscalations: [] }));
  expect(diffCoarseBoard(a, b)).toEqual([
    { type: "block-escalation", data: { id: "fn-1-a.2", op: "cleared" } },
  ]);
});

test("parked-question: an epic parks a closer question → parked-question appeared", () => {
  const a = projectCoarseBoard(
    makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "open", question: null }],
    }),
  );
  const b = projectCoarseBoard(
    makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "open", question: "which auth?" }],
    }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([
    { type: "parked-question", data: { epic_id: "fn-1-a", op: "appeared" } },
  ]);
});

test("parked-question: an answered question clears → parked-question cleared", () => {
  const a = projectCoarseBoard(
    makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "open", question: "which auth?" }],
    }),
  );
  const b = projectCoarseBoard(
    makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "open", question: null }],
    }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([
    { type: "parked-question", data: { epic_id: "fn-1-a", op: "cleared" } },
  ]);
});

const MERGE_CONFLICT_REASON = `${MERGE_ESCALATION_REASON_TOKEN}: merging src into base`;

test("stuck-dispatch: an operator-jam merge-conflict row appears → stuck-dispatch appeared", () => {
  const a = projectCoarseBoard(makeSnap({ dispatchFailures: [] }));
  const b = projectCoarseBoard(
    makeSnap({
      dispatchFailures: [
        { verb: "close", id: "fn-1-a", reason: MERGE_CONFLICT_REASON },
      ],
    }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([
    {
      type: "stuck-dispatch",
      data: {
        verb: "close",
        id: "fn-1-a",
        op: "appeared",
        reason: MERGE_CONFLICT_REASON,
      },
    },
  ]);
});

test("stuck-dispatch: a retried jam row clears → stuck-dispatch cleared", () => {
  const a = projectCoarseBoard(
    makeSnap({
      dispatchFailures: [
        { verb: "close", id: "fn-1-a", reason: MERGE_CONFLICT_REASON },
      ],
    }),
  );
  const b = projectCoarseBoard(makeSnap({ dispatchFailures: [] }));
  expect(diffCoarseBoard(a, b)).toEqual([
    {
      type: "stuck-dispatch",
      data: {
        verb: "close",
        id: "fn-1-a",
        op: "cleared",
        reason: MERGE_CONFLICT_REASON,
      },
    },
  ]);
});

test("stuck-dispatch: a self-clearing occupancy row (not a jam) emits nothing", () => {
  // A `slot-occupied` sticky is NOT an operator jam — it self-clears once the
  // occupant is gone, so it must never project and never emit.
  const a = projectCoarseBoard(makeSnap({ dispatchFailures: [] }));
  const b = projectCoarseBoard(
    makeSnap({
      dispatchFailures: [
        {
          verb: "work",
          id: "fn-1-a.1",
          reason: `${SLOT_OCCUPIED_REASON_PREFIX}: pane still claude`,
        },
      ],
    }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([]);
});

test("finalize-non-ff: a non-ff finalize jam emits ONLY its own most-specific type", () => {
  // Most-specific classification: a `worktree-finalize-non-fast-forward` jam
  // routes to `finalize-non-ff`, never the broader `stuck-dispatch`.
  const a = projectCoarseBoard(makeSnap({ dispatchFailures: [] }));
  const b = projectCoarseBoard(
    makeSnap({
      dispatchFailures: [
        {
          verb: "close",
          id: "worktree-finalize:fn-1-a-abc123",
          reason: WORKTREE_FINALIZE_NON_FF_REASON,
        },
      ],
    }),
  );
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toEqual([
    {
      type: "finalize-non-ff",
      data: {
        verb: "close",
        id: "worktree-finalize:fn-1-a-abc123",
        op: "appeared",
        reason: WORKTREE_FINALIZE_NON_FF_REASON,
      },
    },
  ]);
  // Guard the "only its own type" clause: no stuck-dispatch line rides along.
  expect(deltas.some((d) => d.type === "stuck-dispatch")).toBe(false);
});

test("dispatch jam: a reducer re-write bumping last_event_id (no net change) → zero deltas", () => {
  // The churn source the projection drops: two snapshots whose jam row differs
  // ONLY in `last_event_id` project to the same coarse board → null-diff.
  const a = projectCoarseBoard(
    makeSnap({
      dispatchFailures: [
        {
          verb: "close",
          id: "fn-1-a",
          reason: MERGE_CONFLICT_REASON,
          last_event_id: 41,
        },
      ],
    }),
  );
  const b = projectCoarseBoard(
    makeSnap({
      dispatchFailures: [
        {
          verb: "close",
          id: "fn-1-a",
          reason: MERGE_CONFLICT_REASON,
          last_event_id: 42,
        },
      ],
    }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([]);
});

const breaker = (id: string) => ({
  verb: "work",
  id,
  reason: INSTANT_DEATH_BREAKER_REASON,
});

test("instant-death-wall: crossing the threshold (1→2 breaker keys) → wall appeared", () => {
  // Below the threshold a lone breaker is one breaker doing its job — no wall.
  // A second distinct key crosses INSTANT_DEATH_WALL_KEYS and trips the wall.
  const a = projectCoarseBoard(
    makeSnap({ dispatchFailures: [breaker("fn-1-a.1")] }),
  );
  const b = projectCoarseBoard(
    makeSnap({ dispatchFailures: [breaker("fn-1-a.1"), breaker("fn-1-b.1")] }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([
    { type: "instant-death-wall", data: { op: "appeared", tripped: true } },
  ]);
});

test("instant-death-wall: dropping back under the threshold (2→1) → wall cleared", () => {
  const a = projectCoarseBoard(
    makeSnap({ dispatchFailures: [breaker("fn-1-a.1"), breaker("fn-1-b.1")] }),
  );
  const b = projectCoarseBoard(
    makeSnap({ dispatchFailures: [breaker("fn-1-a.1")] }),
  );
  expect(diffCoarseBoard(a, b)).toEqual([
    { type: "instant-death-wall", data: { op: "cleared", tripped: false } },
  ]);
});

test("instant-death-wall: flips on threshold crossing, not per breaker row", () => {
  // A breaker row is NOT a jam, so it never projects as a stuck-dispatch — the
  // wall is the ONLY surface it touches, and only when the threshold flips.
  const one = projectCoarseBoard(
    makeSnap({ dispatchFailures: [breaker("fn-1-a.1")] }),
  );
  const two = projectCoarseBoard(
    makeSnap({ dispatchFailures: [breaker("fn-1-a.1"), breaker("fn-1-b.1")] }),
  );
  const three = projectCoarseBoard(
    makeSnap({
      dispatchFailures: [
        breaker("fn-1-a.1"),
        breaker("fn-1-b.1"),
        breaker("fn-1-c.1"),
      ],
    }),
  );
  // Adding a third breaker while already tripped moves no delta (bool unchanged).
  expect(diffCoarseBoard(two, three)).toEqual([]);
  // No breaker ever emits a stuck-dispatch line.
  expect(
    diffCoarseBoard(one, three).every((d) => d.type !== "stuck-dispatch"),
  ).toBe(true);
});

test("instant-death-wall: a same-cycle 1→2→1 recross nets to zero via the settle", () => {
  const { clock, lines, emitter } = driveEmitter();
  emitter.onSnapshot(makeSnap({ dispatchFailures: [breaker("fn-1-a.1")] }));
  clock.advance(10); // baseline (wall false)
  // Crosses to tripped, then recrosses back within the settle window.
  emitter.onSnapshot(
    makeSnap({ dispatchFailures: [breaker("fn-1-a.1"), breaker("fn-1-b.1")] }),
  );
  clock.advance(30);
  emitter.onSnapshot(makeSnap({ dispatchFailures: [breaker("fn-1-a.1")] }));
  clock.advance(200); // drain the settle
  emitter.dispose();
  // Net wall state over the window is unchanged → only the baseline emitted.
  expect(lines.map((l) => l.type)).toEqual(["baseline"]);
});

test("projectCoarseBoard: the baseline carries the needs-human members", () => {
  const board = projectCoarseBoard(
    makeSnap({
      epics: [{ epic_id: "fn-1-a", status: "open", question: "which auth?" }],
      deadLetters: ["dl-1"],
      blockEscalations: ["fn-1-a.2"],
      dispatchFailures: [
        { verb: "close", id: "fn-1-a", reason: MERGE_CONFLICT_REASON },
        breaker("fn-1-a.1"),
        breaker("fn-1-b.1"),
      ],
    }),
  );
  expect(board.deadLetters).toEqual({ "dl-1": true });
  expect(board.blockEscalations).toEqual({ "fn-1-a.2": true });
  expect(board.parkedQuestions).toEqual({ "fn-1-a": true });
  // Jam rows only: the merge-conflict close jams; the two breakers do NOT (they
  // ride the wall bool), so exactly one jam key is present.
  expect(Object.values(board.dispatchJams)).toEqual([MERGE_CONFLICT_REASON]);
  expect(board.instantDeathWall).toBe(true);
});

// ---------------------------------------------------------------------------
// createDeltaEmitter — trailing flap-settle debounce (fn-1086.2)
//
// The completion-window flap: `worker_phase="done"` races ahead of the worker
// session going idle, so the readiness pipeline correctly re-asserts `running:*`
// on each post-done liveness blip (a spawned sub-agent, a final working turn, a
// backgrounded monitor) then clears to `completed`. The reducer commits per
// event, so a watch subscriber observes that `completed→running→completed`
// oscillation; the close-row `running↔blocked` flap is downstream (its synth-
// close dep reads `blocked` whenever a task is momentarily non-completed). The
// debounce holds each change over a settle window and emits only the NET change,
// collapsing the round-trip while a settled change / genuine rescind still emits.
// ---------------------------------------------------------------------------

const RUNNING_JOB: Verdict = {
  tag: "running",
  reason: { kind: "job-running" },
};
const CLOSE_BLOCKED: Verdict = {
  tag: "blocked",
  reason: { kind: "dep-on-task", upstream: "fn-1-a.1" },
};

// Minimal readiness fixtures (mirrors test/readiness.test.ts — helpers are
// duplicated per file by convention, no shared module).
function makeTask(overrides: Partial<Task>): Task {
  return {
    task_id: "fn-1-a.1",
    epic_id: "fn-1-a",
    task_number: 1,
    title: "task",
    target_repo: null,
    tier: null,
    model: null,
    worker_phase: "open",
    runtime_status: "todo",
    depends_on: [],
    jobs: [],
    ...overrides,
  };
}

function makeEpic(overrides: Partial<Epic>): Epic {
  return {
    epic_id: "fn-1-a",
    epic_number: 1,
    title: "epic",
    project_dir: "/repo",
    status: "open",
    last_event_id: 0,
    updated_at: 0,
    depends_on_epics: [],
    tasks: [],
    jobs: [],
    job_links: [],
    resolved_epic_deps: null,
    last_validated_at: "2026-05-24T00:00:00Z",
    question: null,
    selection_review: null,
    ...overrides,
  };
}

function makeEmbeddedJob(overrides: Partial<EmbeddedJob>): EmbeddedJob {
  return {
    job_id: "session-1",
    plan_verb: "work",
    state: "working",
    title: null,
    created_at: 0,
    updated_at: 0,
    last_event_id: 0,
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    last_permission_prompt_at: null,
    last_permission_prompt_kind: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    active_since: 1,
    has_live_worker_monitor: false,
    ...overrides,
  };
}

// A deterministic fake clock: `advance(ms)` fires every timer due within the
// window, in due order, so a callback that schedules a new timer (coalesce → arm
// settle) is picked up in the same drain.
interface FakeTimer {
  id: number;
  cb: () => void;
  due: number;
  interval: number | null;
}
function makeClock() {
  let now = 0;
  let seq = 1;
  const timers = new Map<number, FakeTimer>();
  return {
    setTimeout: (cb: () => void, ms: number): unknown => {
      const id = seq++;
      timers.set(id, { id, cb, due: now + ms, interval: null });
      return id;
    },
    clearTimeout: (h: unknown): void => {
      timers.delete(h as number);
    },
    setInterval: (cb: () => void, ms: number): unknown => {
      const id = seq++;
      timers.set(id, { id, cb, due: now + ms, interval: ms });
      return id;
    },
    clearInterval: (h: unknown): void => {
      timers.delete(h as number);
    },
    advance: (ms: number): void => {
      const target = now + ms;
      let guard = 0;
      while (guard++ < 100_000) {
        let next: FakeTimer | null = null;
        for (const t of timers.values()) {
          if (t.due <= target && (next === null || t.due < next.due)) {
            next = t;
          }
        }
        if (next === null) {
          break;
        }
        now = next.due;
        if (next.interval === null) {
          timers.delete(next.id);
        } else {
          next.due = now + next.interval;
        }
        next.cb();
      }
      now = target;
    },
  };
}

interface EmittedLine {
  type: string;
  data: Record<string, unknown>;
}

function driveEmitter() {
  const clock = makeClock();
  const lines: EmittedLine[] = [];
  const emitter = createDeltaEmitter({
    writeStdout: (s: string) => {
      for (const line of s.split("\n")) {
        if (line.length > 0) {
          lines.push(JSON.parse(line) as EmittedLine);
        }
      }
    },
    wants: () => true,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    coalesceMs: 10,
    settleMs: 100,
    // Park the keepalive far beyond every test's advance window.
    keepaliveMs: 1_000_000,
  });
  const verdictChanges = (): EmittedLine[] =>
    lines.filter((l) => l.type === "verdict-change");
  return { clock, lines, emitter, verdictChanges };
}

test("the completion-window flap is real: a done-stamped worker winding down reads completed then running", () => {
  // Grounds the root cause against the actual readiness pipeline. Predicate 1
  // (terminal-completed) needs `worker_phase="done"` AND the session idle;
  // predicate 5 holds the verdict at `running:*` until it is. So the SAME
  // done-stamped task reads `completed` while its embedded job is stopped and
  // `running:job-running` on a post-done working blip — the oscillation the
  // watch stream must not flap on.
  const verdictOf = (t: Task): Verdict | undefined =>
    computeReadiness(
      [makeEpic({ tasks: [t] })],
      new Map<string, Job>(),
      [],
    ).perTask.get(t.task_id);
  expect(
    verdictOf(
      makeTask({
        worker_phase: "done",
        jobs: [makeEmbeddedJob({ state: "stopped" })],
      }),
    ),
  ).toEqual({ tag: "completed" });
  expect(
    verdictOf(
      makeTask({
        worker_phase: "done",
        jobs: [makeEmbeddedJob({ state: "working" })],
      }),
    ),
  ).toEqual(RUNNING_JOB);
});

test("createDeltaEmitter: the baseline paints immediately (no settle delay)", () => {
  const { clock, lines, emitter } = driveEmitter();
  emitter.onSnapshot(makeSnap({ perTask: { "fn-1-a.1": DONE } }));
  clock.advance(10); // one coalesce window
  emitter.dispose();
  expect(lines.map((l) => l.type)).toEqual(["baseline"]);
});

test("createDeltaEmitter: a completed→running→completed round-trip inside the settle window emits no verdict-change", () => {
  const { clock, lines, emitter, verdictChanges } = driveEmitter();
  emitter.onSnapshot(makeSnap({ perTask: { "fn-1-a.1": DONE } }));
  clock.advance(10); // baseline
  // Post-done liveness blip: the task momentarily reads running.
  emitter.onSnapshot(makeSnap({ perTask: { "fn-1-a.1": RUNNING_JOB } }));
  clock.advance(30); // still inside the 100ms settle window
  // The session goes idle again before the settle fires → back to completed.
  emitter.onSnapshot(makeSnap({ perTask: { "fn-1-a.1": DONE } }));
  clock.advance(200); // drain the settle window
  emitter.dispose();
  // Net change over the window is zero → nothing but the baseline.
  expect(verdictChanges()).toEqual([]);
  expect(lines.map((l) => l.type)).toEqual(["baseline"]);
});

test("createDeltaEmitter: a settled completed→running (genuine rescind) still emits", () => {
  const { clock, emitter, verdictChanges } = driveEmitter();
  emitter.onSnapshot(makeSnap({ perTask: { "fn-1-a.1": DONE } }));
  clock.advance(10); // baseline
  // Reconcile genuinely rescinds the done — and it PERSISTS past the window.
  emitter.onSnapshot(makeSnap({ perTask: { "fn-1-a.1": RUNNING_JOB } }));
  clock.advance(200); // settle fires with no revert
  emitter.dispose();
  const vc = verdictChanges();
  expect(vc).toHaveLength(1);
  expect(vc[0]?.data).toEqual({
    kind: "task",
    id: "fn-1-a.1",
    from: "completed",
    to: "running:job-running",
  });
});

test("createDeltaEmitter: the downstream close-row running↔blocked flap is suppressed", () => {
  const { clock, emitter, verdictChanges } = driveEmitter();
  emitter.onSnapshot(makeSnap({ perCloseRow: { "fn-1-a": RUNNING_JOB } }));
  clock.advance(10); // baseline
  emitter.onSnapshot(makeSnap({ perCloseRow: { "fn-1-a": CLOSE_BLOCKED } }));
  clock.advance(30);
  emitter.onSnapshot(makeSnap({ perCloseRow: { "fn-1-a": RUNNING_JOB } }));
  clock.advance(200);
  emitter.dispose();
  expect(verdictChanges()).toEqual([]);
});

test("createDeltaEmitter: a settled close-row regression (running→blocked, persists) still emits", () => {
  const { clock, emitter, verdictChanges } = driveEmitter();
  emitter.onSnapshot(makeSnap({ perCloseRow: { "fn-1-a": RUNNING_JOB } }));
  clock.advance(10); // baseline
  emitter.onSnapshot(makeSnap({ perCloseRow: { "fn-1-a": CLOSE_BLOCKED } }));
  clock.advance(200); // persists past the settle
  emitter.dispose();
  const vc = verdictChanges();
  expect(vc).toHaveLength(1);
  expect(vc[0]?.data).toEqual({
    kind: "close",
    id: "fn-1-a",
    from: "running:job-running",
    to: "blocked:dep-on-task",
  });
});
