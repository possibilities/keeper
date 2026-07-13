import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auditSessionActivity,
  parseSessionActivityAuditArgs,
  SESSION_ACTIVITY_AUDIT_MAX_LIMIT,
} from "../scripts/audit-session-activity";
import {
  type DeriveHarnessActivityInput,
  deriveHarnessActivity,
  type HarnessActivity,
  harnessActivityHoldsCapacity,
} from "../src/session-activity";
import { freshDbFile } from "./helpers/template-db";

const NOW = 10_000;
const AMBIENT_BUS = JSON.stringify([{ id: "keeper-bus", kind: "ambient" }]);

let tmp = "";

afterEach(() => {
  if (tmp !== "") rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function freshPath(): { db: Database; path: string } {
  tmp = mkdtempSync(join(tmpdir(), "keeper-session-activity-audit-"));
  const path = join(tmp, "snapshot.db");
  return { db: freshDbFile(path).db, path };
}

function seedJob(
  db: Database,
  row: {
    id: string;
    harness: string | null;
    state: string;
    updatedAt: number;
    monitors?: string;
    paneId?: string | null;
    title?: string;
  },
): void {
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at, harness,
       monitors, backend_exec_pane_id, active_since, title
     ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, NULL, ?)`,
    [
      row.id,
      row.updatedAt - 100,
      row.state,
      row.updatedAt,
      row.harness,
      row.monitors ?? "[]",
      row.paneId ?? null,
      row.title ?? null,
    ],
  );
}

function seedChild(
  db: Database,
  row: {
    jobId: string;
    agentId: string;
    turnSeq?: number;
    status?: string;
    durationMs?: number | null;
    updatedAt: number;
  },
): void {
  db.run(
    `INSERT INTO subagent_invocations (
       job_id, agent_id, turn_seq, ts, subagent_type, status, duration_ms,
       last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, 'Explore', ?, ?, 0, ?)`,
    [
      row.jobId,
      row.agentId,
      row.turnSeq ?? 0,
      row.updatedAt - 1,
      row.status ?? "running",
      row.durationMs ?? null,
      row.updatedAt,
    ],
  );
}

function seedClaim(
  db: Database,
  row: {
    verb: string;
    id: string;
    attemptId: number | null;
    state: string;
    sessionId: string;
    legacy?: boolean;
    updatedAt: number;
  },
): void {
  db.run(
    `INSERT INTO dispatch_claims (
       verb, id, attempt_id, state, session_id, dir, legacy_unfenced,
       acquired_at, bound_at, resume_acknowledged_at, released_at,
       last_event_id, updated_at
     ) VALUES (?, ?, ?, ?, ?, '/repo', ?, ?, NULL, NULL, NULL, 0, ?)`,
    [
      row.verb,
      row.id,
      row.attemptId,
      row.state,
      row.sessionId,
      row.legacy === true ? 1 : 0,
      row.updatedAt - 1,
      row.updatedAt,
    ],
  );
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("cross-consumer lifecycle scenario matrix", () => {
  const openChild = {
    job_id: "session",
    agent_id: "child",
    turn_seq: 0,
    status: "running",
    duration_ms: null,
    updated_at: NOW - 1,
    subagent_type: "Explore",
  };
  const scenarios: Array<{
    name: string;
    input: DeriveHarnessActivityInput;
    expected: HarnessActivity;
    holdsCapacity: boolean;
  }> = [
    {
      name: "active main turn",
      input: { parent: { job_id: "session", state: "working" }, now: NOW },
      expected: { status: "active", reason: "main-turn", reservation: null },
      holdsCapacity: true,
    },
    {
      name: "quiescent bus-only pane",
      input: {
        parent: {
          job_id: "session",
          state: "stopped",
          updated_at: NOW,
          monitors: AMBIENT_BUS,
        },
        now: NOW,
      },
      expected: {
        status: "quiescent",
        reason: "ambient-resource",
        reservation: null,
      },
      holdsCapacity: false,
    },
    {
      name: "unknown stale child evidence",
      input: {
        parent: { job_id: "session", state: "stopped" },
        children: [{ ...openChild, updated_at: NOW - 121 }],
        now: NOW,
      },
      expected: {
        status: "unknown",
        reason: "child-evidence-stale",
        reservation: null,
      },
      holdsCapacity: true,
    },
    {
      name: "parked Dispatch owner",
      input: {
        parent: { job_id: "session", state: "stopped" },
        reservation: "bound",
        now: NOW,
      },
      expected: {
        status: "quiescent",
        reason: "parent-quiescent",
        reservation: "bound",
      },
      holdsCapacity: true,
    },
    {
      name: "stale Dispatch attempt without a parent",
      input: { parent: null, reservation: "launch", now: NOW },
      expected: {
        status: "unknown",
        reason: "parent-missing",
        reservation: "launch",
      },
      holdsCapacity: true,
    },
    {
      name: "transcript remains active before settlement",
      input: {
        parent: { job_id: "session", state: "working" },
        children: [openChild],
        now: NOW,
      },
      expected: { status: "active", reason: "main-turn", reservation: null },
      holdsCapacity: true,
    },
    {
      name: "autoclose candidate after settlement",
      input: {
        parent: { job_id: "session", state: "stopped" },
        children: [{ ...openChild, duration_ms: 50, status: "ok" }],
        now: NOW,
      },
      expected: {
        status: "quiescent",
        reason: "parent-quiescent",
        reservation: null,
      },
      holdsCapacity: false,
    },
    {
      name: "finalize can observe terminal parent",
      input: {
        parent: { job_id: "session", state: "ended" },
        children: [openChild],
        now: NOW,
      },
      expected: {
        status: "quiescent",
        reason: "parent-terminal",
        reservation: null,
      },
      holdsCapacity: false,
    },
    {
      name: "restore sees terminal Harness activity",
      input: { parent: { job_id: "session", state: "killed" }, now: NOW },
      expected: {
        status: "quiescent",
        reason: "parent-terminal",
        reservation: null,
      },
      holdsCapacity: false,
    },
    {
      name: "stale cleanup evidence fails closed",
      input: {
        parent: {
          job_id: "session",
          state: "stopped",
          updated_at: NOW - 601,
          monitors: JSON.stringify([{ id: "build", kind: "monitor" }]),
        },
        now: NOW,
      },
      expected: {
        status: "unknown",
        reason: "resource-evidence-stale",
        reservation: null,
      },
      holdsCapacity: true,
    },
  ];

  for (const harness of ["claude", "pi"] as const) {
    for (const scenario of scenarios) {
      test(`${harness}: ${scenario.name}`, () => {
        const actual = deriveHarnessActivity(scenario.input);
        expect(actual).toEqual(scenario.expected);
        expect(harnessActivityHoldsCapacity(actual)).toBe(
          scenario.holdsCapacity,
        );
      });
    }
  }
});

test("audit classifies sanitized Claude/Pi regressions and reports aggregate reasons", () => {
  const { db, path } = freshPath();
  seedJob(db, {
    id: "claude-bus-only",
    harness: "claude",
    state: "stopped",
    updatedAt: 9_999,
    monitors: AMBIENT_BUS,
    paneId: "%1",
    title: "SECRET prompt and shell output",
  });
  seedJob(db, {
    id: "pi-bus-only",
    harness: "pi",
    state: "stopped",
    updatedAt: 9_998,
    monitors: AMBIENT_BUS,
    paneId: "%2",
  });
  seedJob(db, {
    id: "claude-child",
    harness: "claude",
    state: "stopped",
    updatedAt: 9_997,
  });
  seedChild(db, {
    jobId: "claude-child",
    agentId: "genuine-child",
    updatedAt: 9_997,
  });
  seedJob(db, {
    id: "pi-child",
    harness: "pi",
    state: "stopped",
    updatedAt: 9_996,
  });
  seedChild(db, {
    jobId: "pi-child",
    agentId: "genuine-child",
    updatedAt: 9_996,
  });
  seedJob(db, {
    id: "claude-terminal-orphan",
    harness: "claude",
    state: "ended",
    updatedAt: 9_995,
  });
  seedChild(db, {
    jobId: "claude-terminal-orphan",
    agentId: "orphan-open-child",
    updatedAt: 9_995,
  });
  seedJob(db, {
    id: "pi-stale-child",
    harness: "pi",
    state: "stopped",
    updatedAt: 9_994,
  });
  seedChild(db, {
    jobId: "pi-stale-child",
    agentId: "stale-child",
    updatedAt: 9_000,
  });
  seedJob(db, {
    id: "legacy-claude",
    harness: null,
    state: "stopped",
    updatedAt: 9_993,
  });
  seedClaim(db, {
    verb: "work",
    id: "fn-audit.1",
    attemptId: 41,
    state: "bound",
    sessionId: "claude-bus-only",
    updatedAt: 9_999,
  });
  seedClaim(db, {
    verb: "close",
    id: "fn-audit",
    attemptId: null,
    state: "released",
    sessionId: "claude-terminal-orphan",
    legacy: true,
    updatedAt: 9_995,
  });
  db.run(
    `INSERT INTO pending_dispatches
       (verb, id, dir, dispatched_at, last_event_id, attempt_id)
     VALUES ('work', 'fn-stale.1', '/repo', 9000, 0, 50),
            ('close', 'fn-fresh', '/repo', 9900, 0, 51)`,
  );
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const before = hash(path);
  chmodSync(path, 0o444);
  const report = auditSessionActivity({ dbPath: path, limit: 20, now: NOW });
  const serialized = JSON.stringify(report);

  expect(report.selected_count).toBe(7);
  expect(report.selected_truncated).toBe(false);
  expect(report.aggregate).toEqual({
    harness: { claude: 4, pi: 3 },
    activity: { quiescent: 4, active: 2, unknown: 1 },
    reasons: {
      "ambient-resource": 2,
      "open-child": 2,
      "parent-terminal": 1,
      "child-evidence-stale": 1,
      "parent-quiescent": 1,
    },
    reservations: { bound: 1, none: 6 },
    claim_states: { bound: 1, released: 1 },
    attempt_evidence: {
      exact: 1,
      "legacy-unfenced": 1,
      "stale-pending": 1,
      pending: 1,
    },
    legacy_deltas: {
      "active->quiescent": 2,
      "quiescent->active": 2,
      "quiescent->quiescent": 2,
      "quiescent->unknown": 1,
    },
  });
  expect(
    report.sessions.find((row) => row.job_id === "claude-bus-only"),
  ).toMatchObject({
    harness: "claude",
    activity: "quiescent",
    reason: "ambient-resource",
    reservation: "bound",
    claim_targets: ["work::fn-audit.1"],
    legacy_activity: "active",
  });
  expect(
    report.sessions.find((row) => row.job_id === "legacy-claude"),
  ).toMatchObject({ harness: "claude", activity: "quiescent" });
  expect(report.stale_attempts).toEqual([
    { target: "work::fn-stale.1", attempt_id: 50, age_seconds: 1_000 },
  ]);
  expect(serialized).not.toContain("SECRET");
  expect(serialized).not.toContain("prompt and shell output");
  expect(hash(path)).toBe(before);
});

test("audit bounds sessions, child evidence, claim identifiers, and empty snapshots", () => {
  const { db, path } = freshPath();
  expect(
    auditSessionActivity({ dbPath: path, limit: 1, now: NOW }),
  ).toMatchObject({
    selected_count: 0,
    selected_truncated: false,
    sessions: [],
  });

  for (let job = 0; job < 3; job++) {
    seedJob(db, {
      id: `job-${job}`,
      harness: job % 2 === 0 ? "claude" : "pi",
      state: "stopped",
      updatedAt: NOW - job,
    });
  }
  for (let child = 0; child < 40; child++) {
    seedChild(db, {
      jobId: "job-0",
      agentId: `child-${child}`,
      updatedAt: NOW,
    });
  }
  for (let claim = 0; claim < 12; claim++) {
    seedClaim(db, {
      verb: "work",
      id: `fn-bound.${claim}`,
      attemptId: 100 + claim,
      state: "released",
      sessionId: "job-0",
      updatedAt: NOW + claim,
    });
  }
  db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const report = auditSessionActivity({ dbPath: path, limit: 2, now: NOW });
  expect(report.selected_count).toBe(2);
  expect(report.selected_truncated).toBe(true);
  expect(report.child_rows_truncated_for).toEqual(["job-0"]);
  expect(report.claim_rows_truncated_for).toEqual(["job-0"]);
  expect(report.sessions[0]?.claim_targets).toHaveLength(8);
  expect(report.sessions[0]?.claim_targets_truncated).toBe(true);
});

test("audit CLI requires an explicit path and validates numeric bounds", () => {
  expect(() => parseSessionActivityAuditArgs([])).toThrow(
    "--db <snapshot-path> is required",
  );
  expect(() =>
    parseSessionActivityAuditArgs(["--db", "/tmp/snapshot.db", "--readonly"]),
  ).not.toThrow();
  expect(() =>
    parseSessionActivityAuditArgs(["--db", "/tmp/snapshot.db", "--limit", "0"]),
  ).not.toThrow();
  expect(() =>
    auditSessionActivity({ dbPath: "", limit: 1, now: NOW }),
  ).toThrow("an explicit database path is required");
  for (const limit of [0, SESSION_ACTIVITY_AUDIT_MAX_LIMIT + 1]) {
    expect(() =>
      auditSessionActivity({
        dbPath: "/does/not/matter",
        limit,
        now: NOW,
      }),
    ).toThrow(
      `limit must be an integer from 1 through ${SESSION_ACTIVITY_AUDIT_MAX_LIMIT}`,
    );
  }
});
