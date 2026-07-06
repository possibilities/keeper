/**
 * Codex rollout ADOPTION (fn-1131) — the knob-gated, pull-side discovery that
 * mints a hand-started (launcher-less) codex session as a tracked, adopted-marked
 * keeper job. Three surfaces under test:
 *
 *  - The pure discovery ({@link findAdoptableCodexRollouts}) — originator
 *    STRICTLY-absent selection, sole-unambiguous-per-cwd refuse, the recency
 *    window (session-start + mtime bounds), and malformed-head tolerance.
 *  - The sweep glue ({@link runCodexAdoptionSweep}) — the knob gate (default
 *    OFF), the per-tick mint cap, the re-read-before-mint dedup guard, and the
 *    end-to-end round-trip through the SessionStart fold onto an adopted `jobs`
 *    row that joins codex live-state tailing ({@link findLiveCodexStateJobs}).
 *  - The cwd canonicalizer ({@link canonicalizeAdoptedCwd}).
 *
 * Each DB test clones the migrated `:memory:` template via `freshMemDb`, seeds
 * raw `events`, and drives the reducer — no daemon, worker, or real codex.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findAdoptableCodexRollouts } from "../src/agent/codex-session-index";
import {
  canonicalizeAdoptedCwd,
  findLiveCodexStateJobs,
  insertAdoptedCodexSessionStart,
  isCodexAdoptionEnabled,
  runCodexAdoptionSweep,
} from "../src/daemon";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

// Independent oracle: build the session-start instant from Y/M/D components via
// `Date.UTC` (never `Date.parse` of the fixture ISO the code under test reads),
// so the expected `created_at` is a hand-computed constant, not a re-derivation.
const SESSION_START_MS = Date.UTC(2026, 6, 6, 12, 0, 0); // 2026-07-06T12:00:00Z
const SESSION_START_SEC = SESSION_START_MS / 1000;
const WINDOW_SEC = 600; // 10 minutes
// The sweep's "now": 5 minutes after the session start, well inside the window.
const NOW_SEC = SESSION_START_SEC + 300;
const NOW_MS = NOW_SEC * 1000;

const UUID_A = "019eec30-d7eb-7142-9363-5c1535537ee6";
const UUID_B = "019eec31-aaaa-7142-9363-5c1535537ee7";
const UUID_C = "019eec32-bbbb-7142-9363-5c1535537ee8";
const CWD_A = "/work/alpha";
const CWD_B = "/work/beta";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
});

function codexHome(): string {
  return mkdtempSync(join(tmpdir(), "keeper-codex-adopt-"));
}

interface RolloutOpts {
  uuid: string;
  cwd: string | null;
  /** SessionMeta `timestamp` — the immutable session-start. */
  sessionStartMs?: number;
  /** Omit entirely (absent), pass `""` (empty), or a tag (present). */
  originator?: string;
  /** File mtime (seconds). Defaults to `sessionStartMs/1000`. */
  mtimeSec?: number;
  /** Force the day-dir instant (defaults to `sessionStartMs`). */
  dirMs?: number;
  /** Write a truncated (unparseable) SessionMeta head instead. */
  malformed?: boolean;
}

function writeRollout(home: string, opts: RolloutOpts): void {
  const startMs = opts.sessionStartMs ?? SESSION_START_MS;
  const dirDate = new Date(opts.dirMs ?? startMs);
  const dir = join(
    home,
    "sessions",
    String(dirDate.getFullYear()),
    String(dirDate.getMonth() + 1).padStart(2, "0"),
    String(dirDate.getDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-07-06T12-00-00-${opts.uuid}.jsonl`);
  if (opts.malformed) {
    // Truncated meta line (codex collects git fields async) — invalid JSON.
    writeFileSync(
      file,
      `{"type":"session_meta","payload":{"id":"${opts.uuid}"`,
    );
  } else {
    const payload: Record<string, unknown> = { id: opts.uuid, cwd: opts.cwd };
    if (opts.originator !== undefined) {
      payload.originator = opts.originator;
    }
    writeFileSync(
      file,
      `${JSON.stringify({
        timestamp: new Date(startMs).toISOString(),
        type: "session_meta",
        payload,
      })}\n` +
        // A conversation turn after the head — the scan must NEVER read past the
        // SessionMeta line, so a secret here is irrelevant.
        `${JSON.stringify({ type: "message", payload: { text: "SECRET" } })}\n`,
    );
  }
  const mt = opts.mtimeSec ?? startMs / 1000;
  utimesSync(file, mt, mt);
}

function drainAll(): void {
  while (drain(db) > 0) {
    /* fold to quiescence */
  }
}

/** Enable the codex-adoption knob via the real AutopilotConfigSet fold path. */
function enableAdoptionKnob(): void {
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, data)
       VALUES (?, 'autopilot', NULL, 'AutopilotConfigSet', 'autopilot_state', ?)`,
    [NOW_SEC, JSON.stringify({ codex_adoption: true })],
  );
  drainAll();
}

/** Seed + fold a tracked codex SessionStart so a `jobs` row exists. */
function seedCodexJob(opts: {
  jobId: string;
  cwd: string;
  resumeTarget?: string | null;
  adopted?: number | null;
}): void {
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd,
       harness, resume_target, adopted)
       VALUES (?, ?, NULL, 'SessionStart', 'session_start', ?, 'codex', ?, ?)`,
    [
      NOW_SEC,
      opts.jobId,
      opts.cwd,
      opts.resumeTarget ?? null,
      opts.adopted ?? null,
    ],
  );
  drainAll();
}

interface JobRow {
  cwd: string | null;
  harness: string | null;
  resume_target: string | null;
  adopted: number | null;
  created_at: number;
  state: string;
}

function jobRow(jobId: string): JobRow | null {
  return db
    .query(
      "SELECT cwd, harness, resume_target, adopted, created_at, state FROM jobs WHERE job_id = ?",
    )
    .get(jobId) as JobRow | null;
}

// ---------------------------------------------------------------------------
// findAdoptableCodexRollouts — pure discovery
// ---------------------------------------------------------------------------

test("a sole originator-absent rollout in a cwd is adoptable", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A }); // originator omitted → absent
  expect(findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC)).toEqual([
    { uuid: UUID_A, cwd: CWD_A, sessionStartMs: SESSION_START_MS },
  ]);
});

test("an empty-string originator counts as absent (adoptable)", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A, originator: "" });
  expect(
    findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC).map((c) => c.uuid),
  ).toEqual([UUID_A]);
});

test("two originator-absent rollouts in ONE cwd → neither is adopted", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A });
  writeRollout(home, { uuid: UUID_B, cwd: CWD_A });
  expect(findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC)).toEqual([]);
});

test("distinct-cwd originator-absent rollouts are each adoptable", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A });
  writeRollout(home, { uuid: UUID_B, cwd: CWD_B });
  expect(
    findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC)
      .map((c) => c.uuid)
      .sort(),
  ).toEqual([UUID_A, UUID_B].sort());
});

test("a keeper-originator (present) rollout is never adopted", () => {
  const home = codexHome();
  writeRollout(home, {
    uuid: UUID_A,
    cwd: CWD_A,
    originator: "job-1111-2222-3333-4444-555566667777",
  });
  expect(findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC)).toEqual([]);
});

test("a present-but-unmatched (stale) originator is never adopted", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A, originator: "codex-tui" });
  expect(findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC)).toEqual([]);
});

test("a present originator does NOT block a distinct absent rollout's adoption", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A }); // absent → adoptable
  writeRollout(home, { uuid: UUID_B, cwd: CWD_B, originator: "codex-tui" });
  expect(
    findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC).map((c) => c.uuid),
  ).toEqual([UUID_A]);
});

test("a null-cwd rollout cannot be sole-for-its-cwd (skipped)", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: null });
  expect(findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC)).toEqual([]);
});

test("a session started BEFORE the window floor is not adopted (createdAt gate)", () => {
  const home = codexHome();
  // In today's SCANNED dir, but its session-start predates the floor; mtime is
  // recent so it passes the mtime pre-filter and reaches the createdAt gate.
  writeRollout(home, {
    uuid: UUID_A,
    cwd: CWD_A,
    sessionStartMs: NOW_MS - (WINDOW_SEC + 60) * 1000,
    dirMs: NOW_MS,
    mtimeSec: NOW_SEC,
  });
  expect(findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC)).toEqual([]);
});

test("a file whose mtime predates the floor is skipped without a head read (scan bound)", () => {
  const home = codexHome();
  // Recent session-start (would pass the createdAt gate) but an old mtime — the
  // mtime pre-filter short-circuits it, proving the scan is bounded by the window.
  writeRollout(home, {
    uuid: UUID_A,
    cwd: CWD_A,
    sessionStartMs: SESSION_START_MS,
    dirMs: NOW_MS,
    mtimeSec: NOW_SEC - (WINDOW_SEC + 60),
  });
  expect(findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC)).toEqual([]);
});

test("a malformed SessionMeta head is skipped, never adopted or thrown", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A, malformed: true });
  // A well-formed sibling in a DIFFERENT cwd still resolves alongside it.
  writeRollout(home, { uuid: UUID_B, cwd: CWD_B });
  expect(
    findAdoptableCodexRollouts(home, NOW_SEC, WINDOW_SEC).map((c) => c.uuid),
  ).toEqual([UUID_B]);
});

test("an absent codex home yields no candidates (no throw)", () => {
  expect(
    findAdoptableCodexRollouts("/no/such/codex/home", NOW_SEC, WINDOW_SEC),
  ).toEqual([]);
});

// ---------------------------------------------------------------------------
// isCodexAdoptionEnabled + the knob gate
// ---------------------------------------------------------------------------

test("the knob defaults OFF (no autopilot_state row)", () => {
  expect(isCodexAdoptionEnabled(db)).toBe(false);
});

test("folding the knob ON flips isCodexAdoptionEnabled", () => {
  enableAdoptionKnob();
  expect(isCodexAdoptionEnabled(db)).toBe(true);
});

// ---------------------------------------------------------------------------
// runCodexAdoptionSweep — knob gate, mint, round-trip, dedup, cap
// ---------------------------------------------------------------------------

test("knob OFF: the sweep mints nothing even with an eligible rollout", () => {
  const home = codexHome();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A });
  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 8)).toBe(0);
  drainAll();
  expect(jobRow(UUID_A)).toBeNull();
});

test("knob ON: a sole rollout becomes a coordless adopted job that joins tailing", () => {
  const home = codexHome();
  enableAdoptionKnob();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A });

  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 8)).toBe(1);
  drainAll();

  const row = jobRow(UUID_A);
  expect(row).not.toBeNull();
  expect(row?.harness).toBe("codex");
  expect(row?.resume_target).toBe(UUID_A); // resume target == the rollout uuid
  expect(row?.adopted).toBe(1); // the non-launcher adoption marker
  expect(row?.cwd).toBe(CWD_A); // canonical of an absolute path is itself
  // Event time is the rollout's OWN session-start — never `now`, never mtime.
  expect(row?.created_at).toBe(SESSION_START_SEC);
  expect(row?.created_at).not.toBe(NOW_SEC);

  // It is now a live-state tailing target (harness codex, resume_target set,
  // non-terminal), keyed on its own uuid.
  const live = findLiveCodexStateJobs(db);
  expect(live.map((j) => j.jobId)).toContain(UUID_A);
  expect(live.find((j) => j.jobId === UUID_A)?.resumeTarget).toBe(UUID_A);
});

test("a second sweep does not re-mint an already-adopted rollout (idempotent)", () => {
  const home = codexHome();
  enableAdoptionKnob();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A });

  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 8)).toBe(1);
  drainAll();
  // Same rollout still on disk (originator still absent) — the re-read guard skips.
  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 8)).toBe(0);
  drainAll();

  const count = db
    .query("SELECT COUNT(*) AS n FROM jobs WHERE job_id = ?")
    .get(UUID_A) as { n: number };
  expect(count.n).toBe(1);
});

test("a rollout a launcher-owned job already claims (resume_target) is never adopted", () => {
  const home = codexHome();
  enableAdoptionKnob();
  // A launched codex job whose resume_target the resume back-fill set to UUID_A.
  seedCodexJob({
    jobId: "launched-1111-2222-3333-4444",
    cwd: CWD_A,
    resumeTarget: UUID_A,
  });
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A }); // originator got stripped

  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 8)).toBe(0);
  drainAll();
  // No new adopted row minted under the uuid — the launcher-owned job keeps it.
  expect(jobRow(UUID_A)).toBeNull();
});

test("the per-tick cap bounds mints; the backlog drains across ticks", () => {
  const home = codexHome();
  enableAdoptionKnob();
  // Three eligible rollouts, each sole in its own cwd, all within the window.
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A });
  writeRollout(home, { uuid: UUID_B, cwd: CWD_B });
  writeRollout(home, { uuid: UUID_C, cwd: "/work/gamma" });

  // Cap 2 → two mints this tick.
  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 2)).toBe(2);
  drainAll();
  const afterFirst = db
    .query("SELECT COUNT(*) AS n FROM jobs WHERE adopted = 1")
    .get() as { n: number };
  expect(afterFirst.n).toBe(2);

  // Next tick drains the remaining one (already-adopted pair is skipped, not
  // counted against the cap).
  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 2)).toBe(1);
  drainAll();
  const afterSecond = db
    .query("SELECT COUNT(*) AS n FROM jobs WHERE adopted = 1")
    .get() as { n: number };
  expect(afterSecond.n).toBe(3);

  // Everything claimed → a further tick is a no-op.
  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 2)).toBe(0);
});

test("a malformed rollout never crashes the sweep and mints nothing for it", () => {
  const home = codexHome();
  enableAdoptionKnob();
  writeRollout(home, { uuid: UUID_A, cwd: CWD_A, malformed: true });
  writeRollout(home, { uuid: UUID_B, cwd: CWD_B }); // clean sibling

  expect(runCodexAdoptionSweep(db, home, NOW_SEC, WINDOW_SEC, 8)).toBe(1);
  drainAll();
  expect(jobRow(UUID_A)).toBeNull();
  expect(jobRow(UUID_B)?.adopted).toBe(1);
});

// ---------------------------------------------------------------------------
// insertAdoptedCodexSessionStart — the raw mint (coordless)
// ---------------------------------------------------------------------------

test("the adopted mint is coordless: no pid, no backend_exec coords, no worktree", () => {
  insertAdoptedCodexSessionStart(db, UUID_A, CWD_A, SESSION_START_SEC);
  const ev = db
    .query(
      `SELECT pid, backend_exec_type, backend_exec_session_id, backend_exec_pane_id,
         worktree, harness, resume_target, adopted, cwd, ts
         FROM events WHERE session_id = ? AND hook_event = 'SessionStart'`,
    )
    .get(UUID_A) as {
    pid: number | null;
    backend_exec_type: string | null;
    backend_exec_session_id: string | null;
    backend_exec_pane_id: string | null;
    worktree: string | null;
    harness: string | null;
    resume_target: string | null;
    adopted: number | null;
    cwd: string | null;
    ts: number;
  };
  expect(ev.pid).toBeNull();
  expect(ev.backend_exec_type).toBeNull();
  expect(ev.backend_exec_session_id).toBeNull();
  expect(ev.backend_exec_pane_id).toBeNull();
  expect(ev.worktree).toBeNull();
  expect(ev.harness).toBe("codex");
  expect(ev.resume_target).toBe(UUID_A);
  expect(ev.adopted).toBe(1);
  expect(ev.cwd).toBe(CWD_A);
  expect(ev.ts).toBe(SESSION_START_SEC);
});

// ---------------------------------------------------------------------------
// canonicalizeAdoptedCwd
// ---------------------------------------------------------------------------

test("canonicalizeAdoptedCwd lexically resolves a non-existent traversal path", () => {
  // The target does not exist → realpath throws → lexical resolve collapses `..`.
  expect(canonicalizeAdoptedCwd("/work/alpha/../beta")).toBe("/work/beta");
});

test("canonicalizeAdoptedCwd realpaths an existing directory", () => {
  const dir = codexHome();
  // An existing dir resolves to its realpath (independent oracle: node fs).
  expect(canonicalizeAdoptedCwd(dir)).toBe(realpathSync(dir));
});
