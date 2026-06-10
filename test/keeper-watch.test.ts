/**
 * Unit tests for `keeper-watch` — the read-only babysitter scanner (epic
 * fn-729 task .1).
 *
 * Two layers:
 *  1. The PURE detectors (`detectDupDispatch`, `detectAutopilotStall`, …) — fed
 *     hand-built row arrays, asserted against the expected `Finding[]`. No DB.
 *  2. The DB layer (`scan`) — seeds a sandbox `keeper.db` in a tmpdir
 *     (`mkdtempSync` + `openDb` writer + raw INSERTs), points `KEEPER_DB` at it,
 *     and asserts the wired-up `Finding[]` with injected probes (so daemon-down
 *     / liveness never depends on a live daemon).
 *
 * Per the CLAUDE.md isolation rule every spawn/probe path that could touch real
 * state sandboxes ALL FIVE `KEEPER_*` paths under the per-test tmpdir — never
 * spreads `process.env` (which would strand the others at production defaults
 * and pollute the real feed).
 *
 * fn-766 retired the approval-era checks (`detectDupApprove` /
 * `detectApprovalReview`) along with keeper's approval mechanism (fn-756), so
 * the dup-dispatch end-to-end test is the epic's standing dispatch-class proof.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHeldGate,
  BACKSTOP_BASELINE_VERSION,
  type BackstopBaseline,
  COOLDOWN_SECS,
  countDeadLetters,
  detectAutopilotStall,
  detectBackstopTelemetry,
  detectDaemonDown,
  detectDeadLetterGrowth,
  detectDispatchFailures,
  detectDupDispatch,
  detectFoldLatency,
  detectReducerWedge,
  detectStuckJobs,
  type EventRow,
  emptyBackstopBaseline,
  emptySeenState,
  type Finding,
  FOLD_LATENCY_SANITY_CAP,
  fingerprint,
  foldSeenState,
  HELD_TICKS_THRESHOLD,
  loadBackstopBaseline,
  loadSeenState,
  MAX_SPAWN_RETRIES,
  resolveBackstopBaselinePath,
  resolveHeartbeatPath,
  resolveSeenStatePath,
  type ScanDeps,
  type SeenState,
  type SpawnAgentFn,
  type SpawnResult,
  saveBackstopBaseline,
  saveSeenState,
  scan,
  selectToNotify,
  sortFindings,
  type TickDeps,
  tick,
  writeHeartbeat,
} from "../babysitters/performance/watch";
import { openDb } from "../src/db";

// ---------------------------------------------------------------------------
// Sandbox: tmpdir DB + ALL FIVE KEEPER_* paths overridden.
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;
let seenStateDir: string;
let savedEnv: Record<string, string | undefined>;

const FIVE_PATHS = [
  "KEEPER_DB",
  "KEEPER_DEAD_LETTER_DIR",
  "KEEPER_DROP_LOG",
  "KEEPER_RESTORE_FILE",
  "KEEPER_BACKSTOP_LOG",
] as const;

// The sitter's state dir is its OWN tree (NOT a KEEPER_* path); the
// BABYSITTER_STATE_DIR root override is sandboxed alongside the five so no test
// touches the real ~/.local/state/babysitters/performance. The sitter joins its
// "performance" slug onto the root, so seenStateDir = <root>/performance.
const SANDBOXED_ENV = [...FIVE_PATHS, "BABYSITTER_STATE_DIR"] as const;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-watch-"));
  dbPath = join(tmpDir, "keeper.db");
  const bbRoot = join(tmpDir, "bb-state");
  seenStateDir = join(bbRoot, "performance");
  savedEnv = {};
  for (const k of SANDBOXED_ENV) savedEnv[k] = process.env[k];
  process.env.KEEPER_DB = dbPath;
  process.env.KEEPER_DEAD_LETTER_DIR = join(tmpDir, "dead-letters");
  process.env.KEEPER_DROP_LOG = join(tmpDir, "hook-drops.ndjson");
  process.env.KEEPER_RESTORE_FILE = join(tmpDir, "restore.json");
  process.env.KEEPER_BACKSTOP_LOG = join(tmpDir, "backstop.ndjson");
  process.env.BABYSITTER_STATE_DIR = bbRoot;
});

afterEach(() => {
  for (const k of SANDBOXED_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an EventRow with sane defaults; override per-row. */
function ev(over: Partial<EventRow> & { id: number; ts: number }): EventRow {
  return {
    session_id: "s",
    hook_event: "PostToolUse",
    event_type: "lifecycle",
    planctl_op: null,
    planctl_target: null,
    data: null,
    ...over,
  };
}

/** Insert one events row into a writer DB with the columns the detectors read. */
function insertEvent(
  db: Database,
  row: {
    ts: number;
    session_id: string;
    hook_event: string;
    event_type?: string;
    planctl_op?: string | null;
    planctl_target?: string | null;
    data?: string | null;
  },
): void {
  db.query(
    `INSERT INTO events
       (ts, session_id, hook_event, event_type, planctl_op, planctl_target, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.ts,
    row.session_id,
    row.hook_event,
    row.event_type ?? "lifecycle",
    row.planctl_op ?? null,
    row.planctl_target ?? null,
    row.data ?? null,
  );
}

/** Default injected probes for `scan` — a healthy, quiet system. */
function quietDeps(nowSecs: number): ScanDeps {
  return {
    isAlive: () => true,
    socketReachable: async () => true,
    keeperdAlive: () => true,
    deadLetterCount: () => ({ count: 0, dir: "dead-letters" }),
    nowSecs: () => nowSecs,
  };
}

// ===========================================================================
// Pure detector tests
// ===========================================================================

describe("fingerprint", () => {
  test("is stable for the same (category, resourceId) and excludes free-text", () => {
    const a = fingerprint("dup-dispatch", "fn-1-foo.2");
    const b = fingerprint("dup-dispatch", "fn-1-foo.2");
    expect(a).toBe(b);
    // A different resource id (or category) yields a different fingerprint.
    expect(fingerprint("dup-dispatch", "fn-1-foo.3")).not.toBe(a);
    expect(fingerprint("stuck-job", "fn-1-foo.2")).not.toBe(a);
  });
});

describe("detectDupDispatch", () => {
  test("fires when same verb::id is dispatched 2x in window", () => {
    const base = 5_000_000;
    const data = JSON.stringify({ verb: "work", id: "fn-3-bar.1", dir: "/x" });
    const events = [
      ev({ id: 1, ts: base, hook_event: "Dispatched", data }),
      ev({ id: 2, ts: base + 30, hook_event: "Dispatched", data }),
    ];
    const findings = detectDupDispatch(events);
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("dup-dispatch:work::fn-3-bar.1");
    expect(findings[0].evidence.count).toBe(2);
  });

  test("does not fire on a single dispatch", () => {
    const base = 6_000_000;
    const data = JSON.stringify({ verb: "work", id: "fn-3-bar.1" });
    expect(
      detectDupDispatch([
        ev({ id: 1, ts: base, hook_event: "Dispatched", data }),
      ]),
    ).toHaveLength(0);
  });

  test("ignores malformed data without throwing", () => {
    const base = 7_000_000;
    const events = [
      ev({ id: 1, ts: base, hook_event: "Dispatched", data: "{not json" }),
      ev({
        id: 2,
        ts: base + 1,
        hook_event: "Dispatched",
        data: JSON.stringify({ verb: "work" }),
      }),
    ];
    expect(detectDupDispatch(events)).toHaveLength(0);
  });
});

describe("detectDispatchFailures", () => {
  test("one finding per (verb,id), reason in evidence not fingerprint", () => {
    const findings = detectDispatchFailures([
      {
        verb: "work",
        id: "fn-3-bar.1",
        reason: "dirty repo",
        dir: "/x",
        ts: 1,
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].fingerprint).toBe(
      fingerprint("dispatch-failure", "work::fn-3-bar.1"),
    );
    expect(findings[0].evidence.reason).toBe("dirty repo");
  });
});

describe("detectDaemonDown", () => {
  test("fires only when socket unreachable AND keeperd absent", () => {
    expect(
      detectDaemonDown({ socketReachable: false, keeperdAlive: false }),
    ).toHaveLength(1);
    expect(
      detectDaemonDown({ socketReachable: true, keeperdAlive: false }),
    ).toHaveLength(0);
    expect(
      detectDaemonDown({ socketReachable: false, keeperdAlive: true }),
    ).toHaveLength(0);
  });
});

describe("detectReducerWedge", () => {
  test("fires when lag over threshold, magnitude in evidence", () => {
    const findings = detectReducerWedge({ maxEventId: 1000, lastEventId: 900 });
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.lag).toBe(100);
    expect(findings[0].severity).toBe("critical");
  });

  test("does not fire when lag under threshold", () => {
    expect(
      detectReducerWedge({ maxEventId: 1000, lastEventId: 999 }),
    ).toHaveLength(0);
  });
});

describe("detectDeadLetterGrowth", () => {
  test("fires on a non-zero count, count is evidence", () => {
    const findings = detectDeadLetterGrowth({ count: 3, dir: "/dl" });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].evidence.count).toBe(3);
  });

  test("silent on zero count", () => {
    expect(detectDeadLetterGrowth({ count: 0, dir: "/dl" })).toHaveLength(0);
  });
});

describe("detectAutopilotStall", () => {
  test("fires only when unpaused + ready work + no recent dispatch (yolo mode)", () => {
    expect(
      detectAutopilotStall({
        paused: false,
        readyWorkExists: true,
        recentDispatch: false,
        mode: "yolo",
        armedCount: 0,
      }),
    ).toHaveLength(1);
  });

  test("does not fire when paused (boots paused by design)", () => {
    expect(
      detectAutopilotStall({
        paused: true,
        readyWorkExists: true,
        recentDispatch: false,
        mode: "yolo",
        armedCount: 0,
      }),
    ).toHaveLength(0);
  });

  test("does not fire when no ready work or recent dispatch happened", () => {
    expect(
      detectAutopilotStall({
        paused: false,
        readyWorkExists: false,
        recentDispatch: false,
        mode: "yolo",
        armedCount: 0,
      }),
    ).toHaveLength(0);
    expect(
      detectAutopilotStall({
        paused: false,
        readyWorkExists: true,
        recentDispatch: true,
        mode: "yolo",
        armedCount: 0,
      }),
    ).toHaveLength(0);
  });

  test("armed mode with NOTHING armed is legitimately idle — does NOT fire (fn-766)", () => {
    // The fn-766 false-page fix: unpaused + ready epics + no dispatch but mode
    // 'armed' with zero armed epics is the autopilot correctly idling (nothing
    // is in its allowed set), not a stall.
    expect(
      detectAutopilotStall({
        paused: false,
        readyWorkExists: true,
        recentDispatch: false,
        mode: "armed",
        armedCount: 0,
      }),
    ).toHaveLength(0);
  });

  test("armed mode WITH armed epics still fires (conservative; can't compute dep-closure)", () => {
    // The sitter can't cheaply compute the transitive dep-closure that decides
    // true readiness, so a non-empty armed set in armed mode is NOT suppressed —
    // it stays a held-across-ticks warning for the human to triage.
    const findings = detectAutopilotStall({
      paused: false,
      readyWorkExists: true,
      recentDispatch: false,
      mode: "armed",
      armedCount: 2,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.mode).toBe("armed");
    expect(findings[0].evidence.armedCount).toBe(2);
  });
});

describe("detectStuckJobs", () => {
  const now = 10_000_000;
  test("fires on a non-terminal, old, dead-pid job", () => {
    const findings = detectStuckJobs({
      jobs: [
        {
          job_id: "j1",
          state: "working",
          pid: 4242,
          created_at: now - 600,
          title: "t",
        },
      ],
      nowSecs: now,
      isAlive: () => false,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].key).toBe("stuck-job:j1");
  });

  test("does not fire when the pid is alive", () => {
    expect(
      detectStuckJobs({
        jobs: [
          {
            job_id: "j1",
            state: "working",
            pid: 4242,
            created_at: now - 600,
            title: null,
          },
        ],
        nowSecs: now,
        isAlive: () => true,
      }),
    ).toHaveLength(0);
  });

  test("does not fire on a young job (launch race guard)", () => {
    expect(
      detectStuckJobs({
        jobs: [
          {
            job_id: "j1",
            state: "working",
            pid: 4242,
            created_at: now - 10,
            title: null,
          },
        ],
        nowSecs: now,
        isAlive: () => false,
      }),
    ).toHaveLength(0);
  });

  test("ignores terminal job states", () => {
    expect(
      detectStuckJobs({
        jobs: [
          {
            job_id: "j1",
            state: "ended",
            pid: 4242,
            created_at: now - 600,
            title: null,
          },
        ],
        nowSecs: now,
        isAlive: () => false,
      }),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// fold-latency (fn-733) — op→first-matching-snapshot pairing over the bar.
// ---------------------------------------------------------------------------

describe("detectFoldLatency", () => {
  /** Build a planctl_op event row. */
  function opEv(id: number, ts: number, op: string, target: string): EventRow {
    return ev({
      id,
      ts,
      session_id: "agent-sess",
      hook_event: "PostToolUse",
      event_type: "planctl",
      planctl_op: op,
      planctl_target: target,
    });
  }

  /** Build a plan_snapshot event row (the entity pk rides in session_id). */
  function snapEv(
    id: number,
    ts: number,
    entityId: string,
    hookEvent: "EpicSnapshot" | "TaskSnapshot",
  ): EventRow {
    return ev({
      id,
      ts,
      session_id: entityId,
      hook_event: hookEvent,
      event_type: "plan_snapshot",
    });
  }

  test("fn-732 fixture: scaffold op→EpicSnapshot ~10s pairs and fires", () => {
    const epic = "fn-732-move-approval-to-runtime-sidecar";
    const opTs = 1780868476.689;
    const snapTs = 1780868486.905; // ~10.2s later (the live evidence)
    const events = [
      opEv(1, opTs, "scaffold", epic),
      snapEv(2, snapTs, epic, "EpicSnapshot"),
    ];
    const findings = detectFoldLatency(events);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.category).toBe("fold-latency");
    expect(f.key).toBe(`fold-latency:scaffold:${epic}`);
    expect(f.evidence.latencySecs).toBe(10);
    expect(f.evidence.entityId).toBe(epic);
  });

  test("task op pairs to the TaskSnapshot (task id), not the EpicSnapshot", () => {
    const epic = "fn-9-foo";
    const task = "fn-9-foo.2";
    const events = [
      opEv(1, 1000, "done", task),
      // EpicSnapshot for the parent — must NOT be the pairing target.
      snapEv(2, 1003, epic, "EpicSnapshot"),
      // TaskSnapshot for the task, 30s after the op → fires.
      snapEv(3, 1030, task, "TaskSnapshot"),
    ];
    const findings = detectFoldLatency(events);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.entityId).toBe(task);
    expect(findings[0].evidence.latencySecs).toBe(30);
  });

  test("does not fire when the pair is under the realtime threshold", () => {
    const epic = "fn-1-fast";
    const events = [
      opEv(1, 1000, "scaffold", epic),
      snapEv(2, 1000.05, epic, "EpicSnapshot"), // ~50ms — the happy path
    ];
    expect(detectFoldLatency(events)).toHaveLength(0);
  });

  test("skips an in-flight op with no matching snapshot in the window", () => {
    const epic = "fn-2-inflight";
    // op present, NO snapshot — must NOT produce a false infinite latency.
    const events = [opEv(1, 1000, "scaffold", epic)];
    expect(detectFoldLatency(events)).toHaveLength(0);
  });

  test("re-fold guard: a snapshot ts BEFORE the op (negative latency) is skipped", () => {
    const epic = "fn-3-refold";
    const events = [
      opEv(1, 2000, "scaffold", epic),
      // re-fold minted a snapshot ts earlier than the op ts → artifact.
      snapEv(2, 1000, epic, "EpicSnapshot"),
    ];
    expect(detectFoldLatency(events)).toHaveLength(0);
  });

  test("re-fold guard: an absurd latency past the sanity cap is skipped", () => {
    const epic = "fn-4-absurd";
    const events = [
      opEv(1, 1000, "scaffold", epic),
      // a re-fold mints a fresh ts far in the future → > sanity cap → artifact.
      snapEv(2, 1000 + FOLD_LATENCY_SANITY_CAP + 10, epic, "EpicSnapshot"),
    ];
    expect(detectFoldLatency(events)).toHaveLength(0);
  });

  test("pairs to the FIRST matching snapshot (earliest sighting wins)", () => {
    const epic = "fn-5-first";
    const events = [
      opEv(1, 1000, "scaffold", epic),
      snapEv(2, 1010, epic, "EpicSnapshot"), // FIRST snapshot — 10s
      snapEv(3, 1090, epic, "EpicSnapshot"), // a later re-snapshot — ignored
    ];
    const findings = detectFoldLatency(events);
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence.latencySecs).toBe(10);
  });

  test("ignores non-op events and unparseable targets", () => {
    const events = [
      // a plain PostToolUse with no planctl_op
      ev({ id: 1, ts: 1000, event_type: "lifecycle" }),
      // an op with a malformed target → parsePlanRef returns null → skipped
      opEv(2, 1000, "scaffold", "not-a-ref"),
      ev({
        id: 3,
        ts: 1100,
        session_id: "not-a-ref",
        event_type: "plan_snapshot",
      }),
    ];
    expect(detectFoldLatency(events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// backstop-degraded (fn-733) — ingest keeper's OWN backstop self-telemetry.
// ---------------------------------------------------------------------------

describe("detectBackstopTelemetry", () => {
  function rescueLine(over: {
    backstop: string;
    cls: string;
    staleness_ms: number | null;
    ts?: number;
  }): string {
    return JSON.stringify({
      ts: over.ts ?? 1780868400000,
      kind: "backstop-rescue",
      class: over.cls,
      backstop: over.backstop,
      worker: "main",
      fast_path: over.cls === "timeout" ? null : "data_version_poll",
      rescued: true,
      staleness_ms: over.staleness_ms,
      last_fast_path_at: over.cls === "timeout" ? null : 1780868200000,
    });
  }

  function rollupLine(over: {
    backstop: string;
    cls: string;
    fires_total: number;
    rescues_total: number;
  }): string {
    return JSON.stringify({
      ts: 1780868400500,
      kind: "backstop-rollup",
      backstop: over.backstop,
      class: over.cls,
      fires_total: over.fires_total,
      rescues_total: over.rescues_total,
    });
  }

  const ID = { dev: 1, ino: 100 };

  /**
   * A prior baseline that has ALREADY observed `bucket` with a watermark below
   * the rescue `ts` the fixtures use (1780868400000), so a fresh rescue is
   * genuinely-NEW (`ts > watermark`) and arms the staleness alarm. Mirrors the
   * steady state after the first reseed tick.
   */
  function priorWith(bucket: string, watermark = 0): BackstopBaseline {
    return {
      version: BACKSTOP_BASELINE_VERSION,
      dev: ID.dev,
      ino: ID.ino,
      buckets: { [bucket]: { rescue_watermark_ts: watermark } },
    };
  }

  test("today's incident: pending-dispatch-sweep rescue at staleness=143108 fires", () => {
    const text = `${rescueLine({
      backstop: "pending-dispatch-sweep",
      cls: "timeout",
      staleness_ms: 143108,
    })}\n`;
    const { findings } = detectBackstopTelemetry({
      text,
      prior: priorWith("pending-dispatch-sweep timeout"),
      identity: ID,
    });
    const stale = findings.find((f) => f.key.startsWith("backstop-staleness:"));
    expect(stale).toBeDefined();
    expect(stale?.category).toBe("backstop-degraded");
    expect(stale?.severity).toBe("critical");
    expect(stale?.evidence.stalenessMs).toBe(143108);
    // timeout-class renders elapsed-timeout wording — NOT dropped-fast-path.
    expect(stale?.detail).toContain("timeout");
    expect(stale?.detail).not.toContain("fast path");
  });

  test("missed-wake-class staleness renders dropped-fast-path wording", () => {
    const text = `${rescueLine({
      backstop: "plan-heartbeat",
      cls: "missed-wake",
      staleness_ms: 143108,
    })}\n`;
    const { findings } = detectBackstopTelemetry({
      text,
      prior: priorWith("plan-heartbeat missed-wake"),
      identity: ID,
    });
    const stale = findings.find((f) => f.key.startsWith("backstop-staleness:"));
    expect(stale).toBeDefined();
    expect(stale?.detail).toContain("fast path dropped a wake-up");
  });

  test("skips a null-staleness rescue (cold boot) — no finding", () => {
    const text = `${rescueLine({
      backstop: "plan-heartbeat",
      cls: "missed-wake",
      staleness_ms: null,
    })}\n`;
    const { findings } = detectBackstopTelemetry({
      text,
      prior: priorWith("plan-heartbeat missed-wake"),
      identity: ID,
    });
    expect(
      findings.filter((f) => f.key.startsWith("backstop-staleness:")),
    ).toHaveLength(0);
  });

  test("absent/empty text reads as healthy (no finding)", () => {
    expect(
      detectBackstopTelemetry({
        text: "",
        prior: emptyBackstopBaseline(),
        identity: null,
      }).findings,
    ).toHaveLength(0);
  });

  test("missed-wake DELTA: seeds silently, then fires when rescues_total rises past the threshold", () => {
    const bucket = { backstop: "git-heartbeat", cls: "missed-wake" };
    // Tick 1: first observation seeds the baseline silently (no delta fire).
    const t1 = `${rollupLine({ ...bucket, fires_total: 10, rescues_total: 4 })}\n`;
    const seed = detectBackstopTelemetry({
      text: t1,
      prior: emptyBackstopBaseline(),
      identity: ID,
    });
    expect(
      seed.findings.filter((f) => f.key.startsWith("backstop-missed-wake:")),
    ).toHaveLength(0);
    expect(seed.next.buckets["git-heartbeat missed-wake"].rescues_total).toBe(
      4,
    );
    expect(seed.next.dev).toBe(ID.dev);
    expect(seed.next.ino).toBe(ID.ino);

    // Tick 2: rescues_total jumped by 8 (> MISSED_WAKE_DELTA=5) → fires; the
    // delta keys off rescues_total, NOT fires_total.
    const t2 = `${rollupLine({ ...bucket, fires_total: 30, rescues_total: 12 })}\n`;
    const second = detectBackstopTelemetry({
      text: t2,
      prior: seed.next,
      identity: ID,
    });
    const delta = second.findings.find((f) =>
      f.key.startsWith("backstop-missed-wake:"),
    );
    expect(delta).toBeDefined();
    expect(delta?.evidence.delta).toBe(8);
    expect(delta?.evidence.baselineRescues).toBe(4);
    expect(delta?.evidence.currentRescues).toBe(12);
    // fires_total retained in evidence for continuity.
    expect(delta?.evidence.currentFires).toBe(30);
    // rescue-based wording.
    expect(delta?.detail).toContain("rescues_total rose");
    expect(delta?.title).toContain("rescued");
  });

  test("fires_total rising while rescues_total stays flat does NOT fire (keys off rescues)", () => {
    const bucket = { backstop: "git-heartbeat", cls: "missed-wake" };
    const prior: BackstopBaseline = {
      version: BACKSTOP_BASELINE_VERSION,
      dev: ID.dev,
      ino: ID.ino,
      buckets: {
        "git-heartbeat missed-wake": {
          fires_total: 10,
          rescues_total: 4,
          rescue_watermark_ts: 0,
        },
      },
    };
    // fires_total +10 (normal periodic wake-ups), rescues_total flat → quiet.
    const text = `${rollupLine({ ...bucket, fires_total: 20, rescues_total: 4 })}\n`;
    const { findings } = detectBackstopTelemetry({ text, prior, identity: ID });
    expect(
      findings.filter((f) => f.key.startsWith("backstop-missed-wake:")),
    ).toHaveLength(0);
  });

  test("a tiny rescues rise (≤ threshold) does NOT fire", () => {
    const bucket = { backstop: "git-heartbeat", cls: "missed-wake" };
    const prior: BackstopBaseline = {
      version: BACKSTOP_BASELINE_VERSION,
      dev: ID.dev,
      ino: ID.ino,
      buckets: {
        "git-heartbeat missed-wake": {
          fires_total: 10,
          rescues_total: 4,
          rescue_watermark_ts: 0,
        },
      },
    };
    // rescues_total +1 → ≤ MISSED_WAKE_DELTA(5) → quiet.
    const text = `${rollupLine({ ...bucket, fires_total: 13, rescues_total: 5 })}\n`;
    const { findings } = detectBackstopTelemetry({ text, prior, identity: ID });
    expect(
      findings.filter((f) => f.key.startsWith("backstop-missed-wake:")),
    ).toHaveLength(0);
  });

  test("counter RESET (current rescues < baseline) reads as a reset, NOT a regression", () => {
    const bucket = { backstop: "git-heartbeat", cls: "missed-wake" };
    // Baseline rescues at 40; daemon restarted → current rescues is 7 (< base).
    const prior: BackstopBaseline = {
      version: BACKSTOP_BASELINE_VERSION,
      dev: ID.dev,
      ino: ID.ino,
      buckets: {
        "git-heartbeat missed-wake": {
          fires_total: 100,
          rescues_total: 40,
          rescue_watermark_ts: 0,
        },
      },
    };
    // 7 < 40 → reset → delta = 7, but a reset NEVER fires even though
    // 7 > MISSED_WAKE_DELTA(5).
    const text = `${rollupLine({ ...bucket, fires_total: 9, rescues_total: 7 })}\n`;
    const { findings, next } = detectBackstopTelemetry({
      text,
      prior,
      identity: ID,
    });
    expect(
      findings.filter((f) => f.key.startsWith("backstop-missed-wake:")),
    ).toHaveLength(0);
    // The baseline re-seeds to the post-reset value for the next tick.
    expect(next.buckets["git-heartbeat missed-wake"].rescues_total).toBe(7);
  });

  test("file-identity change (dev,ino) invalidates the whole baseline — no delta fire, watermark reseeds silently", () => {
    const bucket = { backstop: "git-heartbeat", cls: "missed-wake" };
    const prior: BackstopBaseline = {
      version: BACKSTOP_BASELINE_VERSION,
      dev: 1,
      ino: 100,
      buckets: {
        "git-heartbeat missed-wake": {
          fires_total: 10,
          rescues_total: 4,
          rescue_watermark_ts: 0,
        },
      },
    };
    // The log rotated → new inode. A big jump (rescues AND a high-staleness
    // rescue) would normally fire, but the identity changed → invalidate →
    // re-seed silently this tick (no delta fire, no staleness fire).
    const text =
      `${rollupLine({ ...bucket, fires_total: 99, rescues_total: 40 })}\n` +
      `${rescueLine({ ...bucket, staleness_ms: 143108, ts: 1780868900000 })}\n`;
    const { findings, next } = detectBackstopTelemetry({
      text,
      prior,
      identity: { dev: 1, ino: 999 },
    });
    expect(
      findings.filter((f) => f.category === "backstop-degraded"),
    ).toHaveLength(0);
    expect(next.dev).toBe(1);
    expect(next.ino).toBe(999);
    expect(next.buckets["git-heartbeat missed-wake"].rescues_total).toBe(40);
    // Watermark seeded to the rescue ts seen this tick (no fire).
    expect(next.buckets["git-heartbeat missed-wake"].rescue_watermark_ts).toBe(
      1780868900000,
    );
  });

  test("version 1→2 / empty baseline: first tick fires nothing and seeds the watermark", () => {
    const bucket = { backstop: "pending-dispatch-sweep", cls: "timeout" };
    // A high-staleness rescue against a fresh (reseeded) baseline must fire
    // NOTHING — the first post-1→2 tick re-paging all history is the regression
    // this whole epic prevents. Instead the watermark seeds to max(ts).
    const text = `${rescueLine({ ...bucket, staleness_ms: 143108, ts: 1780868700000 })}\n`;
    const { findings, next } = detectBackstopTelemetry({
      text,
      prior: emptyBackstopBaseline(),
      identity: ID,
    });
    expect(
      findings.filter((f) => f.key.startsWith("backstop-staleness:")),
    ).toHaveLength(0);
    expect(
      next.buckets["pending-dispatch-sweep timeout"].rescue_watermark_ts,
    ).toBe(1780868700000);
  });

  test("old stale rescue (ts ≤ watermark) does NOT fire across two ticks", () => {
    const bucket = { backstop: "pending-dispatch-sweep", cls: "timeout" };
    // Tick 1: a high-staleness rescue arrives against a fresh baseline → seeds
    // the watermark, fires nothing.
    const t1 = `${rescueLine({ ...bucket, staleness_ms: 143108, ts: 1780868700000 })}\n`;
    const first = detectBackstopTelemetry({
      text: t1,
      prior: emptyBackstopBaseline(),
      identity: ID,
    });
    expect(
      first.findings.filter((f) => f.key.startsWith("backstop-staleness:")),
    ).toHaveLength(0);

    // Tick 2: the SAME old rescue is still in the file (ts ≤ watermark) plus a
    // clean rollup → still no staleness finding (the exclusive cursor windows
    // it out).
    const t2 =
      `${rescueLine({ ...bucket, staleness_ms: 143108, ts: 1780868700000 })}\n` +
      `${rollupLine({ ...bucket, fires_total: 5, rescues_total: 1 })}\n`;
    const second = detectBackstopTelemetry({
      text: t2,
      prior: first.next,
      identity: ID,
    });
    expect(
      second.findings.filter((f) => f.key.startsWith("backstop-staleness:")),
    ).toHaveLength(0);
  });

  test("a genuinely-new rescue (ts > watermark) over threshold fires the WINDOWED staleness", () => {
    const bucket = { backstop: "pending-dispatch-sweep", cls: "timeout" };
    // Prior watermark already past an OLD low-staleness rescue; a NEW rescue
    // (ts > watermark) with high staleness must fire with the windowed (new)
    // staleness in evidence — NOT an all-history max.
    const prior: BackstopBaseline = {
      version: BACKSTOP_BASELINE_VERSION,
      dev: ID.dev,
      ino: ID.ino,
      buckets: {
        "pending-dispatch-sweep timeout": {
          rescue_watermark_ts: 1780868500000,
        },
      },
    };
    const text =
      // old, below-threshold rescue at/under the watermark → ignored.
      `${rescueLine({ ...bucket, staleness_ms: 200000, ts: 1780868500000 })}\n` +
      // new rescue over threshold → fires with THIS staleness.
      `${rescueLine({ ...bucket, staleness_ms: 143108, ts: 1780868600000 })}\n`;
    const { findings, next } = detectBackstopTelemetry({
      text,
      prior,
      identity: ID,
    });
    const stale = findings.find((f) => f.key.startsWith("backstop-staleness:"));
    expect(stale).toBeDefined();
    // Windowed staleness = the new rescue's 143108 — NOT the old 200000.
    expect(stale?.evidence.stalenessMs).toBe(143108);
    // Watermark advances to the newest ts seen.
    expect(
      next.buckets["pending-dispatch-sweep timeout"].rescue_watermark_ts,
    ).toBe(1780868600000);
  });

  test("a null-staleness rescue advances the watermark but does not arm the alarm", () => {
    const bucket = { backstop: "plan-heartbeat", cls: "missed-wake" };
    const prior: BackstopBaseline = {
      version: BACKSTOP_BASELINE_VERSION,
      dev: ID.dev,
      ino: ID.ino,
      buckets: {
        "plan-heartbeat missed-wake": { rescue_watermark_ts: 1780868500000 },
      },
    };
    // A NEW (ts > watermark) rescue but with null staleness (cold boot) → no
    // fire, yet the watermark advances to its ts.
    const text = `${rescueLine({ ...bucket, staleness_ms: null, ts: 1780868600000 })}\n`;
    const { findings, next } = detectBackstopTelemetry({
      text,
      prior,
      identity: ID,
    });
    expect(
      findings.filter((f) => f.key.startsWith("backstop-staleness:")),
    ).toHaveLength(0);
    expect(next.buckets["plan-heartbeat missed-wake"].rescue_watermark_ts).toBe(
      1780868600000,
    );
  });

  test("rescue-only bucket persists a watermark (writeback lifted out of the rollup guard)", () => {
    const bucket = { backstop: "plan-heartbeat", cls: "missed-wake" };
    // No rollup line — only a rescue. The bucket must STILL persist an entry
    // carrying its watermark (and leave the counters undefined so a later
    // rollup seeds silently, not against a phantom 0).
    const text = `${rescueLine({ ...bucket, staleness_ms: 1000, ts: 1780868600000 })}\n`;
    const { next } = detectBackstopTelemetry({
      text,
      prior: emptyBackstopBaseline(),
      identity: ID,
    });
    const entry = next.buckets["plan-heartbeat missed-wake"];
    expect(entry).toBeDefined();
    expect(entry.rescue_watermark_ts).toBe(1780868600000);
    expect(entry.fires_total).toBeUndefined();
    expect(entry.rescues_total).toBeUndefined();
  });

  test("rescue-only bucket then a rollup seeds the counter silently (no phantom delta)", () => {
    const bucket = { backstop: "plan-heartbeat", cls: "missed-wake" };
    // Tick 1: rescue-only → watermark persists, counters undefined.
    const t1 = `${rescueLine({ ...bucket, staleness_ms: 1000, ts: 1780868600000 })}\n`;
    const first = detectBackstopTelemetry({
      text: t1,
      prior: emptyBackstopBaseline(),
      identity: ID,
    });
    // Tick 2: a rollup with a high rescues_total arrives. Because the prior
    // entry had NO rescues_total, this seeds silently — NOT a phantom delta vs 0.
    const t2 = `${rollupLine({ ...bucket, fires_total: 50, rescues_total: 30 })}\n`;
    const second = detectBackstopTelemetry({
      text: t2,
      prior: first.next,
      identity: ID,
    });
    expect(
      second.findings.filter((f) => f.key.startsWith("backstop-missed-wake:")),
    ).toHaveLength(0);
    expect(
      second.next.buckets["plan-heartbeat missed-wake"].rescues_total,
    ).toBe(30);
  });

  test("fingerprint is stable across ticks for the same bucket+signal", () => {
    const prior = priorWith("pending-dispatch-sweep timeout");
    const text = `${rescueLine({
      backstop: "pending-dispatch-sweep",
      cls: "timeout",
      staleness_ms: 143108,
    })}\n`;
    const a = detectBackstopTelemetry({
      text,
      prior,
      identity: ID,
    }).findings.find((f) => f.key.startsWith("backstop-staleness:"));
    const b = detectBackstopTelemetry({
      text,
      prior,
      identity: ID,
    }).findings.find((f) => f.key.startsWith("backstop-staleness:"));
    expect(a?.fingerprint).toBe(b?.fingerprint);
  });
});

// ---------------------------------------------------------------------------
// backstop-baseline sidecar (fn-733) — load/save round-trip + corrupt fallback.
// ---------------------------------------------------------------------------

describe("backstop-baseline sidecar", () => {
  test("resolveBackstopBaselinePath honors BABYSITTER_STATE_DIR (its OWN dir)", () => {
    const p = resolveBackstopBaselinePath();
    expect(p).toBe(join(seenStateDir, "backstop-baseline.json"));
    // NOT under the keeper DB's dir — segregated from keeper.db.
    expect(p.startsWith(seenStateDir)).toBe(true);
  });

  test("save then load round-trips the baseline", () => {
    const p = resolveBackstopBaselinePath();
    const baseline: BackstopBaseline = {
      version: BACKSTOP_BASELINE_VERSION,
      dev: 5,
      ino: 55,
      buckets: {
        "git-heartbeat missed-wake": {
          fires_total: 7,
          rescues_total: 3,
          rescue_watermark_ts: 1780868600000,
        },
      },
    };
    saveBackstopBaseline(p, baseline);
    const loaded = loadBackstopBaseline(p);
    expect(loaded).toEqual(baseline);
  });

  test("absent file loads as an empty baseline", () => {
    expect(loadBackstopBaseline(resolveBackstopBaselinePath())).toEqual(
      emptyBackstopBaseline(),
    );
  });

  test("corrupt file degrades to an empty baseline (never throws)", () => {
    const p = resolveBackstopBaselinePath();
    require("node:fs").mkdirSync(seenStateDir, { recursive: true });
    writeFileSync(p, "{ this is not json");
    expect(loadBackstopBaseline(p)).toEqual(emptyBackstopBaseline());
  });
});

describe("sortFindings", () => {
  test("critical before warning before info, then by key", () => {
    const all = [
      ...detectDeadLetterGrowth({ count: 1, dir: "/dl" }), // info
      ...detectDaemonDown({ socketReachable: false, keeperdAlive: false }), // critical
      ...detectDispatchFailures([
        { verb: "w", id: "fn-1-a.1", reason: "r", dir: null, ts: 1 },
      ]), // warning
    ];
    const sorted = sortFindings(all);
    expect(sorted.map((f) => f.severity)).toEqual([
      "critical",
      "warning",
      "info",
    ]);
  });
});

// ===========================================================================
// DB-layer integration: scan over a seeded sandbox DB.
// ===========================================================================

describe("scan (DB layer)", () => {
  test("opens readonly:prepareStmts:false and a write fails at the SQLite layer", () => {
    openDb(dbPath).db.close();
    const { db } = openDb(dbPath, { readonly: true, prepareStmts: false });
    try {
      expect(() =>
        db.query("INSERT INTO meta (key, value) VALUES ('x', 'y')").run(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test("detects a dup-dispatch signature end-to-end", async () => {
    const writer = openDb(dbPath);
    const now = Math.floor(Date.now() / 1000);
    const dispatchKey = "work::fn-700-x.2";
    // The same verb::id dispatched twice within the window.
    for (const i of [0, 1]) {
      insertEvent(writer.db, {
        ts: now - 300 + i * 60,
        session_id: "main",
        hook_event: "Dispatched",
        event_type: "lifecycle",
        data: JSON.stringify({ verb: "work", id: "fn-700-x.2", dir: "/r" }),
      });
    }
    writer.db.close();

    const findings = await scan(dbPath, 3600, quietDeps(now));
    const dup = findings.find((f) => f.category === "dup-dispatch");
    expect(dup).toBeDefined();
    expect(dup?.key).toBe(`dup-dispatch:${dispatchKey}`);
    expect(dup?.evidence.count).toBe(2);
  });

  test("bounds the event window — old dispatches outside the window are ignored", async () => {
    const writer = openDb(dbPath);
    const now = Math.floor(Date.now() / 1000);
    // Two dispatches of one verb::id, but 2 hours ago — outside the 1h window.
    for (const i of [0, 1]) {
      insertEvent(writer.db, {
        ts: now - 7200 + i * 30,
        session_id: "main",
        hook_event: "Dispatched",
        event_type: "lifecycle",
        data: JSON.stringify({ verb: "work", id: "fn-99-old.1", dir: "/r" }),
      });
    }
    writer.db.close();

    const findings = await scan(dbPath, 3600, quietDeps(now));
    expect(findings.filter((f) => f.category === "dup-dispatch")).toHaveLength(
      0,
    );
  });

  test("surfaces daemon-down via injected probes without a live daemon", async () => {
    openDb(dbPath).db.close();
    const now = Math.floor(Date.now() / 1000);
    const deps: ScanDeps = {
      ...quietDeps(now),
      socketReachable: async () => false,
      keeperdAlive: () => false,
    };
    const findings = await scan(dbPath, 3600, deps);
    expect(findings.filter((f) => f.category === "daemon-down")).toHaveLength(
      1,
    );
  });

  test("emits no findings on a healthy, quiet empty DB", async () => {
    openDb(dbPath).db.close();
    const now = Math.floor(Date.now() / 1000);
    const findings = await scan(dbPath, 3600, quietDeps(now));
    expect(findings).toHaveLength(0);
  });

  test("fold-latency: a scaffold op + later EpicSnapshot pairs end-to-end", async () => {
    const writer = openDb(dbPath);
    const now = Math.floor(Date.now() / 1000);
    const epic = "fn-732-move-approval-to-runtime-sidecar";
    // op 20s ago; matching EpicSnapshot 10s ago → ~10s latency, over the bar.
    insertEvent(writer.db, {
      ts: now - 20,
      session_id: "agent-sess",
      hook_event: "PostToolUse",
      event_type: "planctl",
      planctl_op: "scaffold",
      planctl_target: epic,
    });
    insertEvent(writer.db, {
      ts: now - 10,
      session_id: epic,
      hook_event: "EpicSnapshot",
      event_type: "plan_snapshot",
    });
    writer.db.close();

    const findings = await scan(dbPath, 3600, quietDeps(now));
    const fl = findings.find((f) => f.category === "fold-latency");
    expect(fl).toBeDefined();
    expect(fl?.evidence.entityId).toBe(epic);
    expect(fl?.evidence.latencySecs).toBe(10);
  });

  test("backstop ingest: a NEW high-staleness rescue surfaces through scan via injected deps", async () => {
    openDb(dbPath).db.close();
    const now = Math.floor(Date.now() / 1000);
    const baselinePath = resolveBackstopBaselinePath();
    // Pre-seed a baseline that has already observed this bucket with a watermark
    // below the rescue ts, so the rescue is genuinely-NEW and arms the alarm
    // (a fresh baseline would fire nothing — the R5 reseed rule).
    saveBackstopBaseline(baselinePath, {
      version: BACKSTOP_BASELINE_VERSION,
      dev: 1,
      ino: 100,
      buckets: {
        "pending-dispatch-sweep timeout": { rescue_watermark_ts: 0 },
      },
    });
    const deps: ScanDeps = {
      ...quietDeps(now),
      readBackstop: () => ({
        text: `${JSON.stringify({
          ts: 1780868400000,
          kind: "backstop-rescue",
          class: "timeout",
          backstop: "pending-dispatch-sweep",
          worker: "main",
          fast_path: null,
          rescued: true,
          staleness_ms: 143108,
          last_fast_path_at: null,
        })}\n`,
        identity: { dev: 1, ino: 100 },
      }),
      backstopBaseline: {
        load: () => loadBackstopBaseline(baselinePath),
        save: (next) => saveBackstopBaseline(baselinePath, next),
      },
    };
    const findings = await scan(dbPath, 3600, deps);
    const bs = findings.find((f) => f.category === "backstop-degraded");
    expect(bs).toBeDefined();
    expect(bs?.evidence.stalenessMs).toBe(143108);
  });

  test("backstop ingest is OFF when readBackstop is absent (older caller)", async () => {
    openDb(dbPath).db.close();
    const now = Math.floor(Date.now() / 1000);
    // quietDeps has no readBackstop → no backstop-degraded findings.
    const findings = await scan(dbPath, 3600, quietDeps(now));
    expect(
      findings.filter((f) => f.category === "backstop-degraded"),
    ).toHaveLength(0);
  });
});

describe("countDeadLetters", () => {
  test("absent dir is count 0", () => {
    expect(countDeadLetters(join(tmpDir, "nope")).count).toBe(0);
  });

  test("counts files present", () => {
    const dir = join(tmpDir, "dl");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.ndjson"), "x");
    writeFileSync(join(dir, "2.ndjson"), "y");
    expect(countDeadLetters(dir).count).toBe(2);
  });
});

// ===========================================================================
// Task .2: seen-state + the `--tick` escalation flow.
// ===========================================================================

/** A minimal Finding builder for the .2 tick/seen-state tests. */
function mkFinding(over: Partial<Finding> & { key: string }): Finding {
  return {
    fingerprint: fingerprint("dispatch-failure", over.key),
    severity: "warning",
    category: "dispatch-failure",
    title: "t",
    detail: "d",
    evidence: {},
    ...over,
  };
}

describe("resolveSeenStatePath", () => {
  test("honors BABYSITTER_STATE_DIR and is its OWN dir (not under KEEPER_DB)", () => {
    const p = resolveSeenStatePath();
    expect(p).toBe(join(seenStateDir, "seen.json"));
    // NOT under the keeper DB's dir — the monitor's bookkeeping is segregated.
    expect(p.startsWith(join(tmpDir, "keeper"))).toBe(false);
  });
});

describe("loadSeenState / saveSeenState", () => {
  test("missing file loads as an empty baseline", () => {
    const path = join(seenStateDir, "seen.json");
    expect(loadSeenState(path)).toEqual(emptySeenState());
  });

  test("corrupt JSON falls back to empty (never throws)", () => {
    const path = join(seenStateDir, "seen.json");
    require("node:fs").mkdirSync(seenStateDir, { recursive: true });
    writeFileSync(path, "{not json at all");
    expect(loadSeenState(path)).toEqual(emptySeenState());
  });

  test("wrong version falls back to empty", () => {
    const path = join(seenStateDir, "seen.json");
    require("node:fs").mkdirSync(seenStateDir, { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 999, fingerprints: {} }));
    expect(loadSeenState(path)).toEqual(emptySeenState());
  });

  test("round-trips a valid state and creates the parent dir", () => {
    const path = join(seenStateDir, "seen.json");
    const state: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        fpA: {
          first_seen: 100,
          last_seen: 200,
          notification_count: 1,
          last_notified_at: 200,
          held_ticks: 0,
          spawn_failures: 0,
          count: null,
        },
      },
    };
    saveSeenState(path, state);
    expect(loadSeenState(path)).toEqual(state);
  });

  test("atomic write: a leftover .tmp does not corrupt the target", () => {
    const path = join(seenStateDir, "seen.json");
    const state = emptySeenState();
    state.fingerprints.fpA = {
      first_seen: 1,
      last_seen: 1,
      notification_count: 0,
      last_notified_at: null,
      held_ticks: 0,
      spawn_failures: 0,
      count: null,
    };
    saveSeenState(path, state);
    // Simulate a crash MID a subsequent write: a stray .tmp sibling is left,
    // but the committed target is intact (rename is the atomic commit point).
    writeFileSync(`${path}.tmp.99999.deadbeef`, "garbage partial");
    expect(loadSeenState(path)).toEqual(state);
  });
});

describe("applyHeldGate", () => {
  test("reducer-wedge / autopilot-stall require HELD_TICKS_THRESHOLD ticks", () => {
    const wedge = mkFinding({
      key: "reducer-wedge",
      category: "reducer-wedge",
      fingerprint: fingerprint("reducer-wedge", "reducer"),
    });
    // First sighting → suppressed (held=1 < threshold), accrues a tick.
    const r1 = applyHeldGate([wedge], emptySeenState());
    expect(r1.gated).toHaveLength(0);
    expect(r1.heldTicks.get(wedge.fingerprint)).toBe(1);

    // Prior state with held just below threshold → this tick clears it.
    const prior: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        [wedge.fingerprint]: {
          first_seen: 0,
          last_seen: 0,
          notification_count: 0,
          last_notified_at: null,
          held_ticks: HELD_TICKS_THRESHOLD - 1,
          spawn_failures: 0,
          count: null,
        },
      },
    };
    const r2 = applyHeldGate([wedge], prior);
    expect(r2.gated).toHaveLength(1);
    expect(r2.heldTicks.get(wedge.fingerprint)).toBe(HELD_TICKS_THRESHOLD);
  });

  test("dead-letter-growth fires only on a POSITIVE delta vs baseline", () => {
    const dl = (count: number): Finding =>
      mkFinding({
        key: "dead-letter-growth",
        category: "dead-letter-growth",
        fingerprint: fingerprint("dead-letter-growth", "dead-letters"),
        evidence: { count },
      });
    // Cold (no baseline) → seed, don't escalate.
    expect(applyHeldGate([dl(3)], emptySeenState()).gated).toHaveLength(0);

    const baseline2: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        [dl(0).fingerprint]: {
          first_seen: 0,
          last_seen: 0,
          notification_count: 0,
          last_notified_at: null,
          held_ticks: 0,
          spawn_failures: 0,
          count: 2,
        },
      },
    };
    // Same count as baseline → no delta → suppressed.
    expect(applyHeldGate([dl(2)], baseline2).gated).toHaveLength(0);
    // Higher count → positive delta → escalates.
    expect(applyHeldGate([dl(5)], baseline2).gated).toHaveLength(1);
  });

  test("non-held categories pass through unchanged", () => {
    const f = mkFinding({ key: "dispatch-failure:x" });
    expect(applyHeldGate([f], emptySeenState()).gated).toHaveLength(1);
  });
});

describe("selectToNotify", () => {
  const now = 1_000_000;
  test("a genuinely new fingerprint is selected as 'new'", () => {
    const f = mkFinding({ key: "x" });
    const sel = selectToNotify([f], emptySeenState(), now);
    expect(sel).toHaveLength(1);
    expect(sel[0].reason).toBe("new");
  });

  test("cooldown suppresses a still-present finding within the window", () => {
    const f = mkFinding({ key: "x" });
    const prior: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        [f.fingerprint]: {
          first_seen: now - 100,
          last_seen: now - 100,
          notification_count: 1,
          last_notified_at: now - 60, // 60s ago, well within the 1h cooldown
          held_ticks: 0,
          spawn_failures: 0,
          count: null,
        },
      },
    };
    expect(selectToNotify([f], prior, now)).toHaveLength(0);
  });

  test("re-notify once the cooldown has elapsed", () => {
    const f = mkFinding({ key: "x" });
    const prior: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        [f.fingerprint]: {
          first_seen: now - COOLDOWN_SECS * 3,
          last_seen: now,
          notification_count: 1,
          last_notified_at: now - COOLDOWN_SECS - 1, // just past cooldown
          held_ticks: 0,
          spawn_failures: 0,
          count: null,
        },
      },
    };
    const sel = selectToNotify([f], prior, now);
    expect(sel).toHaveLength(1);
    expect(sel[0].reason).toBe("renotify");
  });

  test("retry cap halts selection after MAX_SPAWN_RETRIES failures", () => {
    const f = mkFinding({ key: "x" });
    const prior: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        [f.fingerprint]: {
          first_seen: now - COOLDOWN_SECS * 3,
          last_seen: now,
          notification_count: 0,
          last_notified_at: now - COOLDOWN_SECS - 1,
          held_ticks: 0,
          spawn_failures: MAX_SPAWN_RETRIES,
          count: null,
        },
      },
    };
    expect(selectToNotify([f], prior, now)).toHaveLength(0);
  });
});

describe("foldSeenState", () => {
  const now = 2_000_000;
  test("delivered fingerprints bump notification_count + reset spawn_failures", () => {
    const f = mkFinding({ key: "x" });
    const prior: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        [f.fingerprint]: {
          first_seen: now - 500,
          last_seen: now - 500,
          notification_count: 2,
          last_notified_at: now - 500,
          held_ticks: 0,
          spawn_failures: 3,
          count: null,
        },
      },
    };
    const next = foldSeenState({
      prior,
      present: [f],
      heldTicks: new Map(),
      counts: new Map(),
      delivered: new Set([f.fingerprint]),
      spawnFailed: new Set(),
      nowSecs: now,
    });
    const e = next.fingerprints[f.fingerprint];
    expect(e.notification_count).toBe(3);
    expect(e.last_notified_at).toBe(now);
    expect(e.spawn_failures).toBe(0);
    expect(e.last_seen).toBe(now);
  });

  test("spawnFailed fingerprints increment spawn_failures (retry-cap fuel)", () => {
    const f = mkFinding({ key: "x" });
    const next = foldSeenState({
      prior: emptySeenState(),
      present: [f],
      heldTicks: new Map(),
      counts: new Map(),
      delivered: new Set(),
      spawnFailed: new Set([f.fingerprint]),
      nowSecs: now,
    });
    expect(next.fingerprints[f.fingerprint].spawn_failures).toBe(1);
  });

  test("TTL prune drops a not-present entry older than the TTL", () => {
    const stale: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        old: {
          first_seen: 0,
          last_seen: now - 48 * 60 * 60, // 48h ago, > 24h TTL
          notification_count: 0,
          last_notified_at: null,
          held_ticks: 0,
          spawn_failures: 0,
          count: null,
        },
      },
    };
    const next = foldSeenState({
      prior: stale,
      present: [], // not present this tick
      heldTicks: new Map(),
      counts: new Map(),
      delivered: new Set(),
      spawnFailed: new Set(),
      nowSecs: now,
    });
    expect(next.fingerprints.old).toBeUndefined();
  });

  test("a not-present but fresh entry is carried forward", () => {
    const fresh: SeenState = {
      version: 1,
      baselined: true,
      fingerprints: {
        recent: {
          first_seen: now - 100,
          last_seen: now - 100, // well within TTL
          notification_count: 0,
          last_notified_at: null,
          held_ticks: 0,
          spawn_failures: 0,
          count: null,
        },
      },
    };
    const next = foldSeenState({
      prior: fresh,
      present: [],
      heldTicks: new Map(),
      counts: new Map(),
      delivered: new Set(),
      spawnFailed: new Set(),
      nowSecs: now,
    });
    expect(next.fingerprints.recent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// tick — the full launchd flow, with a STUBBED spawn (no real claude runs).
// ---------------------------------------------------------------------------

describe("tick", () => {
  const seenPath = (): string => join(seenStateDir, "seen.json");

  /** A tick-deps bundle: quiet probes + a capturing spawn stub. */
  function tickDeps(
    nowSecs: number,
    spawnAgent: SpawnAgentFn,
    over: Partial<ScanDeps> = {},
  ): TickDeps {
    return { ...quietDeps(nowSecs), ...over, spawnAgent };
  }

  /** Seed a dispatch_failures row so the scan yields one warning finding. */
  function seedDispatchFailure(): void {
    const writer = openDb(dbPath);
    writer.db
      .query(
        `INSERT INTO dispatch_failures
           (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
         VALUES ('work', 'fn-3-bar.1', 'dirty repo', '/x', 1, 1, 1, 1)`,
      )
      .run();
    writer.db.close();
  }

  test("first boot before keeperd creates keeper.db — no throw, baseline shape, no spawn", async () => {
    const now = Math.floor(Date.now() / 1000);
    let spawnCalls = 0;
    const spawn: SpawnAgentFn = async () => {
      spawnCalls++;
      return { exitCode: 0, ackedFingerprints: [] };
    };
    // Fresh tmpdir: keeper.db does not exist yet. The read-only openDb in scan
    // would let SQLite throw; tick's existsSync guard must short-circuit.
    expect(existsSync(dbPath)).toBe(false);
    const res = await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    expect(res).toEqual({
      baselined: false,
      spawned: false,
      selectedCount: 0,
      deliveredCount: 0,
    });
    expect(spawnCalls).toBe(0);
    // No seen-state was written (we never reached the fold).
    expect(existsSync(seenPath())).toBe(false);
  });

  test("cold start baselines silently — no spawn, seen.json seeded", async () => {
    seedDispatchFailure();
    const now = Math.floor(Date.now() / 1000);
    let spawnCalls = 0;
    const spawn: SpawnAgentFn = async () => {
      spawnCalls++;
      return { exitCode: 0, ackedFingerprints: [] };
    };
    const res = await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    expect(res.baselined).toBe(true);
    expect(res.spawned).toBe(false);
    expect(spawnCalls).toBe(0);
    // The finding was seeded into seen-state (the baseline), not escalated.
    const state = loadSeenState(seenPath());
    expect(Object.keys(state.fingerprints).length).toBeGreaterThan(0);
  });

  test("second tick with the SAME findings is silent (exit 0, no spawn)", async () => {
    seedDispatchFailure();
    const now = Math.floor(Date.now() / 1000);
    let spawnCalls = 0;
    const spawn: SpawnAgentFn = async () => {
      spawnCalls++;
      return { exitCode: 0, ackedFingerprints: [] };
    };
    // Tick 1 baselines.
    await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    // Tick 2: nothing new → silent.
    const res = await tick(dbPath, 3600, tickDeps(now + 1, spawn), seenPath());
    expect(res.baselined).toBe(false);
    expect(res.spawned).toBe(false);
    expect(spawnCalls).toBe(0);
  });

  test("a genuinely-new finding after a baseline spawns the agent", async () => {
    const now = Math.floor(Date.now() / 1000);
    let captured: { findingsFile: string; ackFile: string } | null = null;
    const spawn: SpawnAgentFn = async (input) => {
      captured = { findingsFile: input.findingsFile, ackFile: input.ackFile };
      return { exitCode: 0, ackedFingerprints: null }; // no ack → commit all handed
    };
    // Tick 1: empty DB → baseline with no findings.
    openDb(dbPath).db.close();
    await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    // Now a NEW finding appears.
    seedDispatchFailure();
    const res = await tick(dbPath, 3600, tickDeps(now + 1, spawn), seenPath());
    expect(res.spawned).toBe(true);
    expect(res.selectedCount).toBe(1);
    expect(res.deliveredCount).toBe(1);
    expect(captured).not.toBeNull();
    // The seen-state recorded the delivery (notification_count bumped).
    const state = loadSeenState(seenPath());
    const delivered = Object.values(state.fingerprints).find(
      (e) => e.notification_count > 0,
    );
    expect(delivered).toBeDefined();
  });

  test("agent exit 0 + ack commits ONLY the acked fingerprints", async () => {
    const now = Math.floor(Date.now() / 1000);
    openDb(dbPath).db.close();
    let handedFingerprint = "";
    // Baseline empty, then a new finding; the spawn acks exactly that fp.
    const spawn: SpawnAgentFn = async (input) => {
      const snapshot = JSON.parse(
        require("node:fs").readFileSync(input.findingsFile, "utf8"),
      ) as { findings: Finding[] };
      handedFingerprint = snapshot.findings[0].fingerprint;
      return { exitCode: 0, ackedFingerprints: [handedFingerprint] };
    };
    await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    seedDispatchFailure();
    const res = await tick(dbPath, 3600, tickDeps(now + 1, spawn), seenPath());
    expect(res.deliveredCount).toBe(1);
    const state = loadSeenState(seenPath());
    expect(state.fingerprints[handedFingerprint].notification_count).toBe(1);
  });

  test("non-zero exit commits NOTHING delivered and counts a spawn failure", async () => {
    const now = Math.floor(Date.now() / 1000);
    openDb(dbPath).db.close();
    const spawn: SpawnAgentFn = async () => ({
      exitCode: 1,
      ackedFingerprints: null,
    });
    await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    seedDispatchFailure();
    const res = await tick(dbPath, 3600, tickDeps(now + 1, spawn), seenPath());
    expect(res.spawned).toBe(true);
    expect(res.deliveredCount).toBe(0);
    const state = loadSeenState(seenPath());
    const failed = Object.values(state.fingerprints).find(
      (e) => e.spawn_failures > 0,
    );
    expect(failed?.spawn_failures).toBe(1);
    expect(failed?.notification_count).toBe(0);
  });

  test("timeout (exitCode null) commits nothing delivered", async () => {
    const now = Math.floor(Date.now() / 1000);
    openDb(dbPath).db.close();
    const spawn: SpawnAgentFn = async (): Promise<SpawnResult> => ({
      exitCode: null, // hard-timeout kill path
      ackedFingerprints: null,
    });
    await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    seedDispatchFailure();
    const res = await tick(dbPath, 3600, tickDeps(now + 1, spawn), seenPath());
    expect(res.deliveredCount).toBe(0);
    const state = loadSeenState(seenPath());
    expect(
      Object.values(state.fingerprints).some((e) => e.spawn_failures > 0),
    ).toBe(true);
  });

  test("retry cap: a permanently-failing fingerprint stops re-spawning", async () => {
    const now = Math.floor(Date.now() / 1000);
    openDb(dbPath).db.close();
    let spawnCalls = 0;
    const spawn: SpawnAgentFn = async () => {
      spawnCalls++;
      return { exitCode: 1, ackedFingerprints: null };
    };
    // Baseline empty.
    await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    seedDispatchFailure();
    // Drive ticks until the per-fingerprint cap is hit. The first spawn is the
    // 'new' selection; subsequent ones are cooldown-elapsed re-notifies, so
    // advance the clock past the cooldown each iteration.
    let t = now + 1;
    for (let i = 0; i < MAX_SPAWN_RETRIES + 3; i++) {
      await tick(dbPath, 3600, tickDeps(t, spawn), seenPath());
      t += COOLDOWN_SECS + 1;
    }
    // Capped at MAX_SPAWN_RETRIES spawns (no infinite re-attempt).
    expect(spawnCalls).toBe(MAX_SPAWN_RETRIES);
  });

  test("corrupt seen.json re-baselines silently (no spawn)", async () => {
    seedDispatchFailure();
    const now = Math.floor(Date.now() / 1000);
    require("node:fs").mkdirSync(seenStateDir, { recursive: true });
    writeFileSync(seenPath(), "{corrupt");
    let spawnCalls = 0;
    const spawn: SpawnAgentFn = async () => {
      spawnCalls++;
      return { exitCode: 0, ackedFingerprints: [] };
    };
    const res = await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    expect(res.baselined).toBe(true);
    expect(spawnCalls).toBe(0);
    // The re-baseline overwrote the corrupt file with a valid one.
    expect(loadSeenState(seenPath()).version).toBe(1);
  });
});

// ===========================================================================
// Heartbeat write (fn-733): tick stamps heartbeat.json as the LAST action on
// every COMPLETED path — including the missing-DB early-return.
// ===========================================================================

describe("writeHeartbeat / tick liveness heartbeat", () => {
  const seenPath = (): string => join(seenStateDir, "seen.json");
  // Default heartbeatPath param resolves via BABYSITTER_STATE_DIR (sandboxed
  // to seenStateDir), so the heartbeat lands beside seen.json in the tmpdir.
  const heartbeatPath = (): string => join(seenStateDir, "heartbeat.json");

  function tickDeps(nowSecs: number, spawnAgent: SpawnAgentFn): TickDeps {
    return { ...quietDeps(nowSecs), spawnAgent };
  }

  function seedDispatchFailure(): void {
    const writer = openDb(dbPath);
    writer.db
      .query(
        `INSERT INTO dispatch_failures
           (verb, id, reason, dir, ts, last_event_id, created_at, updated_at)
         VALUES ('work', 'fn-3-bar.1', 'dirty repo', '/x', 1, 1, 1, 1)`,
      )
      .run();
    writer.db.close();
  }

  function readHeartbeatTs(): number {
    const raw = JSON.parse(readFileSync(heartbeatPath(), "utf8")) as {
      ts: number;
    };
    return raw.ts;
  }

  test("resolveHeartbeatPath honors BABYSITTER_STATE_DIR and is heartbeat.json", () => {
    expect(resolveHeartbeatPath()).toBe(join(seenStateDir, "heartbeat.json"));
  });

  test("writeHeartbeat stamps { ts } atomically and creates the dir", () => {
    const path = join(seenStateDir, "nested", "heartbeat.json");
    expect(existsSync(path)).toBe(false);
    writeHeartbeat(path, 12345);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ts: 12345 });
  });

  test("missing-DB early return STILL stamps the heartbeat", async () => {
    const now = 1_700_000_000;
    const spawn: SpawnAgentFn = async () => ({
      exitCode: 0,
      ackedFingerprints: [],
    });
    // Fresh tmpdir: keeper.db does not exist (the missing-DB path).
    expect(existsSync(dbPath)).toBe(false);
    await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    // The heartbeat was stamped even though scan never ran.
    expect(existsSync(heartbeatPath())).toBe(true);
    expect(readHeartbeatTs()).toBe(now);
  });

  test("normal completed tick (cold-start baseline) stamps the heartbeat", async () => {
    seedDispatchFailure();
    const now = 1_700_000_100;
    const spawn: SpawnAgentFn = async () => ({
      exitCode: 0,
      ackedFingerprints: [],
    });
    const res = await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
    expect(res.baselined).toBe(true);
    expect(readHeartbeatTs()).toBe(now);
  });

  test("each completed tick advances the heartbeat ts", async () => {
    seedDispatchFailure();
    const spawn: SpawnAgentFn = async () => ({
      exitCode: 0,
      ackedFingerprints: [],
    });
    await tick(dbPath, 3600, tickDeps(1000, spawn), seenPath());
    expect(readHeartbeatTs()).toBe(1000);
    // A later, no-new-findings silent tick still re-stamps.
    await tick(dbPath, 3600, tickDeps(2000, spawn), seenPath());
    expect(readHeartbeatTs()).toBe(2000);
  });
});
