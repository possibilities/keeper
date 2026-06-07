/**
 * Unit tests for `keeper-watch` — the read-only babysitter scanner (epic
 * fn-729 task .1).
 *
 * Two layers:
 *  1. The PURE detectors (`detectDupApprove`, `detectDupDispatch`, …) — fed
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
 * The fn-728 dup-approve fixture (one `planctl_target` approved by 3 distinct
 * sessions within ~2 min) is a named test — the epic's early proof point.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHeldGate,
  COOLDOWN_SECS,
  countDeadLetters,
  detectApprovalReview,
  detectAutopilotStall,
  detectDaemonDown,
  detectDeadLetterGrowth,
  detectDispatchFailures,
  detectDupApprove,
  detectDupDispatch,
  detectReducerWedge,
  detectStuckJobs,
  type EventRow,
  emptySeenState,
  type Finding,
  fingerprint,
  foldSeenState,
  HELD_TICKS_THRESHOLD,
  loadSeenState,
  MAX_SPAWN_RETRIES,
  resolveSeenStatePath,
  type ScanDeps,
  type SeenState,
  type SpawnAgentFn,
  type SpawnResult,
  saveSeenState,
  scan,
  selectToNotify,
  sortFindings,
  type TickDeps,
  tick,
} from "../cli/keeper-watch";
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

// The seen-state dir is the watcher's OWN dir (NOT a KEEPER_* path); its
// override is sandboxed alongside the five so no test touches the real
// ~/.local/state/keeper-watch.
const SANDBOXED_ENV = [...FIVE_PATHS, "KEEPER_WATCH_STATE_DIR"] as const;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-watch-"));
  dbPath = join(tmpDir, "keeper.db");
  seenStateDir = join(tmpDir, "watch-state");
  savedEnv = {};
  for (const k of SANDBOXED_ENV) savedEnv[k] = process.env[k];
  process.env.KEEPER_DB = dbPath;
  process.env.KEEPER_DEAD_LETTER_DIR = join(tmpDir, "dead-letters");
  process.env.KEEPER_DROP_LOG = join(tmpDir, "hook-drops.ndjson");
  process.env.KEEPER_RESTORE_FILE = join(tmpDir, "restore.json");
  process.env.KEEPER_BACKSTOP_LOG = join(tmpDir, "backstop.ndjson");
  process.env.KEEPER_WATCH_STATE_DIR = seenStateDir;
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
    const a = fingerprint("dup-approve", "fn-1-foo.2");
    const b = fingerprint("dup-approve", "fn-1-foo.2");
    expect(a).toBe(b);
    // A different resource id (or category) yields a different fingerprint.
    expect(fingerprint("dup-approve", "fn-1-foo.3")).not.toBe(a);
    expect(fingerprint("dup-dispatch", "fn-1-foo.2")).not.toBe(a);
  });
});

describe("detectDupApprove", () => {
  test("fn-728 fixture: 3 sessions / one target / ~2 min is detected", () => {
    const target = "fn-728-exempt-approve-launches-from.2";
    const base = 1_000_000;
    const events = [
      ev({
        id: 1,
        ts: base,
        session_id: "sess-a",
        planctl_op: "approve",
        planctl_target: target,
      }),
      ev({
        id: 2,
        ts: base + 60,
        session_id: "sess-b",
        planctl_op: "approve",
        planctl_target: target,
      }),
      ev({
        id: 3,
        ts: base + 120,
        session_id: "sess-c",
        planctl_op: "approve",
        planctl_target: target,
      }),
    ];
    const findings = detectDupApprove(events);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.category).toBe("dup-approve");
    expect(f.key).toBe(`dup-approve:${target}`);
    expect(f.fingerprint).toBe(fingerprint("dup-approve", target));
    expect(f.severity).toBe("warning");
    expect(f.evidence.sessionCount).toBe(3);
    expect(f.evidence.sessions).toEqual(["sess-a", "sess-b", "sess-c"]);
  });

  test("does not fire on a single re-approval by the same session", () => {
    const target = "fn-9-foo.1";
    const base = 2_000_000;
    const events = [
      ev({
        id: 1,
        ts: base,
        session_id: "sess-a",
        planctl_op: "approve",
        planctl_target: target,
      }),
      ev({
        id: 2,
        ts: base + 30,
        session_id: "sess-a",
        planctl_op: "approve",
        planctl_target: target,
      }),
    ];
    expect(detectDupApprove(events)).toHaveLength(0);
  });

  test("does not fire when two sessions approve outside the window", () => {
    const target = "fn-9-foo.1";
    const base = 3_000_000;
    const events = [
      ev({
        id: 1,
        ts: base,
        session_id: "sess-a",
        planctl_op: "approve",
        planctl_target: target,
      }),
      // 20 min later — beyond the 15-min dup-approve window.
      ev({
        id: 2,
        ts: base + 20 * 60,
        session_id: "sess-b",
        planctl_op: "approve",
        planctl_target: target,
      }),
    ];
    expect(detectDupApprove(events)).toHaveLength(0);
  });

  test("ignores non-approve ops and null targets", () => {
    const base = 4_000_000;
    const events = [
      ev({
        id: 1,
        ts: base,
        session_id: "a",
        planctl_op: "claim",
        planctl_target: "fn-9-foo.1",
      }),
      ev({
        id: 2,
        ts: base + 10,
        session_id: "b",
        planctl_op: "approve",
        planctl_target: null,
      }),
    ];
    expect(detectDupApprove(events)).toHaveLength(0);
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
  test("fires only when unpaused + ready work + no recent dispatch", () => {
    expect(
      detectAutopilotStall({
        paused: false,
        readyWorkExists: true,
        recentDispatch: false,
      }),
    ).toHaveLength(1);
  });

  test("does not fire when paused (boots paused by design)", () => {
    expect(
      detectAutopilotStall({
        paused: true,
        readyWorkExists: true,
        recentDispatch: false,
      }),
    ).toHaveLength(0);
  });

  test("does not fire when no ready work or recent dispatch happened", () => {
    expect(
      detectAutopilotStall({
        paused: false,
        readyWorkExists: false,
        recentDispatch: false,
      }),
    ).toHaveLength(0);
    expect(
      detectAutopilotStall({
        paused: false,
        readyWorkExists: true,
        recentDispatch: true,
      }),
    ).toHaveLength(0);
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

describe("detectApprovalReview", () => {
  test("one info item per target::session", () => {
    const base = 11_000_000;
    const findings = detectApprovalReview([
      ev({
        id: 1,
        ts: base,
        session_id: "a",
        planctl_op: "approve",
        planctl_target: "fn-3-x.1",
      }),
      // same target+session again → deduped
      ev({
        id: 2,
        ts: base + 5,
        session_id: "a",
        planctl_op: "approve",
        planctl_target: "fn-3-x.1",
      }),
      ev({
        id: 3,
        ts: base + 5,
        session_id: "b",
        planctl_op: "approve",
        planctl_target: "fn-3-x.1",
      }),
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.severity === "info")).toBe(true);
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

  test("detects the fn-728 dup-approve signature end-to-end", async () => {
    const writer = openDb(dbPath);
    const now = Math.floor(Date.now() / 1000);
    const target = "fn-728-exempt-approve-launches-from.2";
    for (const [i, sess] of ["sess-a", "sess-b", "sess-c"].entries()) {
      insertEvent(writer.db, {
        ts: now - 300 + i * 60,
        session_id: sess,
        hook_event: "PreToolUse",
        event_type: "planctl",
        planctl_op: "approve",
        planctl_target: target,
      });
    }
    writer.db.close();

    const findings = await scan(dbPath, 3600, quietDeps(now));
    const dup = findings.find((f) => f.category === "dup-approve");
    expect(dup).toBeDefined();
    expect(dup?.key).toBe(`dup-approve:${target}`);
    expect(dup?.evidence.sessionCount).toBe(3);

    // The same approve ops are ALSO surfaced as approval-review items (3 sessions).
    expect(
      findings.filter((f) => f.category === "approval-review"),
    ).toHaveLength(3);
  });

  test("bounds the event window — old approves outside the window are ignored", async () => {
    const writer = openDb(dbPath);
    const now = Math.floor(Date.now() / 1000);
    const target = "fn-99-old.1";
    // Two sessions, but 2 hours ago — outside the 1h scan window.
    for (const [i, sess] of ["a", "b"].entries()) {
      insertEvent(writer.db, {
        ts: now - 7200 + i * 30,
        session_id: sess,
        hook_event: "PreToolUse",
        planctl_op: "approve",
        planctl_target: target,
      });
    }
    writer.db.close();

    const findings = await scan(dbPath, 3600, quietDeps(now));
    expect(findings.filter((f) => f.category === "dup-approve")).toHaveLength(
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
  test("honors KEEPER_WATCH_STATE_DIR and is its OWN dir (not under KEEPER_DB)", () => {
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
    let res!: Awaited<ReturnType<typeof tick>>;
    await expect(
      (async () => {
        res = await tick(dbPath, 3600, tickDeps(now, spawn), seenPath());
      })(),
    ).resolves.toBeUndefined();
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
