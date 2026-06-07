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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
  fingerprint,
  type ScanDeps,
  scan,
  sortFindings,
} from "../cli/keeper-watch";
import { openDb } from "../src/db";

// ---------------------------------------------------------------------------
// Sandbox: tmpdir DB + ALL FIVE KEEPER_* paths overridden.
// ---------------------------------------------------------------------------

let tmpDir: string;
let dbPath: string;
let savedEnv: Record<string, string | undefined>;

const FIVE_PATHS = [
  "KEEPER_DB",
  "KEEPER_DEAD_LETTER_DIR",
  "KEEPER_DROP_LOG",
  "KEEPER_RESTORE_FILE",
  "KEEPER_BACKSTOP_LOG",
] as const;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-watch-"));
  dbPath = join(tmpDir, "keeper.db");
  savedEnv = {};
  for (const k of FIVE_PATHS) savedEnv[k] = process.env[k];
  process.env.KEEPER_DB = dbPath;
  process.env.KEEPER_DEAD_LETTER_DIR = join(tmpDir, "dead-letters");
  process.env.KEEPER_DROP_LOG = join(tmpDir, "hook-drops.ndjson");
  process.env.KEEPER_RESTORE_FILE = join(tmpDir, "restore.json");
  process.env.KEEPER_BACKSTOP_LOG = join(tmpDir, "backstop.ndjson");
});

afterEach(() => {
  for (const k of FIVE_PATHS) {
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
