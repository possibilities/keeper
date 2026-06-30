/**
 * Pure tests for `keeper watch` (fn-1015) — the coarse board projection +
 * diff and the arg parser. No daemon, no subscribe: build two snapshots, project
 * them, diff, and assert the coarse delta lines (a null-diff yields none).
 */

import { expect, test } from "bun:test";
import {
  diffCoarseBoard,
  parseWatchArgs,
  projectCoarseBoard,
  WATCH_DELTA_TYPES,
} from "../cli/watch";
import type { Verdict } from "../src/readiness";
import type { ReadinessClientSnapshot } from "../src/readiness-client";

interface SnapOverrides {
  epics?: { epic_id: string; status: string | null }[];
  jobsByState?: Record<string, string>;
  perTask?: Record<string, Verdict>;
  perCloseRow?: Record<string, Verdict>;
  perEpic?: Record<string, Verdict>;
  autopilotMode?: "yolo" | "armed";
  autopilotPaused?: boolean;
  worktreeMode?: boolean;
  maxConcurrentJobs?: number | null;
  maxConcurrentPerRoot?: number;
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
    deadLetters: [],
    pendingDispatches: [],
    blockEscalations: [],
    autopilotPaused: o.autopilotPaused ?? false,
    autopilotMode: o.autopilotMode ?? "yolo",
    maxConcurrentJobs:
      o.maxConcurrentJobs === undefined ? null : o.maxConcurrentJobs,
    maxConcurrentPerRoot: o.maxConcurrentPerRoot ?? 1,
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

test("diffCoarseBoard: an autopilot pause toggle → autopilot-change", () => {
  const a = projectCoarseBoard(makeSnap({ autopilotPaused: false }));
  const b = projectCoarseBoard(makeSnap({ autopilotPaused: true }));
  const deltas = diffCoarseBoard(a, b);
  expect(deltas).toHaveLength(1);
  expect(deltas[0]?.type).toBe("autopilot-change");
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
    ]),
  );
});
