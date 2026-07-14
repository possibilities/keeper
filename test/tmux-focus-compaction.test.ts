/**
 * Physical-DELETE re-fold gate for the epic fn-952 `TmuxClientFocusSnapshot`
 * cold tail (`deleteColdTmuxFocusRows` / `TMUX_FOCUS_DELETE_PREDICATE`).
 *
 * The producer (the persistent `tmux -C` control worker) holds idle volume at
 * zero, but active window/session navigation logs a slow trickle of focus
 * snapshots. `deleteColdTmuxFocusRows` bounds that ROW growth by physically
 * DELETING old focus rows — a SEPARATELY-NAMED predicate, deliberately NOT folded
 * into `NOOP_SNAPSHOT_DELETE_PREDICATE` (whose pinning test in
 * test/refold-equivalence.test.ts allows EXACTLY the three retired no-op-arm
 * classes and would fail on a fourth member).
 *
 * The focus fold writes ONLY the `tmux_client_focus` LIVE-ONLY singleton (in
 * `LIVE_ONLY_PROJECTIONS`, outside the byte-identical re-fold charter — the worker
 * re-bootstraps it from a framed re-read on every connect), and the rows carry
 * NONE of the producer-scanned cheap columns. So deleting a cold focus row leaves
 * every DETERMINISTIC projection byte-identical on a from-scratch re-fold.
 *
 * Two proofs, mirroring the no-op-snapshot gate:
 *   - SAFE: over a corpus carrying every deterministic-projection-touching class
 *     INTERLEAVED with focus rows, run the PRODUCTION delete then two from-scratch
 *     re-folds — both byte-identical to the pre-delete projection.
 *   - NECESSARY: the focus rows are a genuine, deletable cold tail (the production
 *     delete removes exactly them), and the negative control — deleting the BROAD
 *     `RETENTION_SHED_CLASS_PREDICATE` set instead — DIVERGES the re-fold, proving
 *     the predicate's narrowness is required, not arbitrary.
 *
 * No real tmux: a `TmuxClientFocusSnapshot` is a synthetic `events` row the
 * reducer folds — these tests drive the real fold + the real delete SQL over a
 * seeded in-memory log, never an attach. (The live `tmux -C` attach lives in the
 * worker command seam.)
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  countAbsentBlobs,
  deleteColdTmuxFocusRows,
  NOOP_SNAPSHOT_DELETE_PREDICATE,
  RETENTION_SHED_CLASS_PREDICATE,
  TMUX_FOCUS_DELETE_PREDICATE,
} from "../src/compaction";
import { extractMutationPath } from "../src/derivers";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let db: Database;
let tsCounter = 5_000;

beforeEach(() => {
  db = freshMemDb().db;
  tsCounter = 5_000;
});

afterEach(() => {
  db.close();
});

const REPO = "/repo";
const SESS_A = "01234567-89ab-cdef-0123-456789abcdef";
const SESS_B = "fedcba98-7654-3210-fedc-ba9876543210";

/** Insert one raw event row carrying the columns the seeded folds read. */
function insertEvent(overrides: {
  hook_event: string;
  session_id?: string;
  event_type?: string | null;
  tool_name?: string | null;
  cwd?: string | null;
  ts?: number;
  data?: string | null;
  subagent_agent_id?: string | null;
  agent_id?: string | null;
  agent_type?: string | null;
  plan_op?: string | null;
  plan_target?: string | null;
}): number {
  const ts = overrides.ts ?? tsCounter++;
  const data = overrides.data ?? "{}";
  // Derive `mutation_path` the SAME way the live hook does, so a seeded mutation
  // row carries the column the git-attribution scan reads (a no-file_path body
  // folds to NULL, matching the forward deriver).
  let mutationPath: string | null = null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      mutationPath = extractMutationPath(
        overrides.hook_event,
        overrides.tool_name ?? null,
        parsed as Record<string, unknown>,
      );
    }
  } catch {
    mutationPath = null;
  }
  db.run(
    `INSERT INTO events (
       ts, session_id, pid, hook_event, event_type, tool_name, cwd, data,
       subagent_agent_id, agent_id, agent_type, plan_op, plan_target,
       mutation_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts,
      overrides.session_id ?? SESS_A,
      4242,
      overrides.hook_event,
      overrides.event_type ?? overrides.hook_event,
      overrides.tool_name ?? null,
      overrides.cwd ?? REPO,
      data,
      overrides.subagent_agent_id ?? null,
      overrides.agent_id ?? null,
      overrides.agent_type ?? null,
      overrides.plan_op ?? null,
      overrides.plan_target ?? null,
      mutationPath,
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
}

/** Insert ONE `TmuxClientFocusSnapshot` event — the focus fold's input shape. */
function insertFocusSnapshot(overrides: {
  status?: string;
  generation_id?: string;
  session_name?: string;
  window_index?: number;
  pane_id?: string;
}): number {
  return insertEvent({
    hook_event: "TmuxClientFocusSnapshot",
    // The focus fold keys on the singleton id=1, never `event.session_id`; a
    // dedicated session keeps these out of every seeded job's fold path.
    session_id: "focus-producer",
    data: JSON.stringify({
      status: overrides.status ?? "connected",
      generation_id: overrides.generation_id ?? "98765",
      session_name: overrides.session_name ?? "main",
      window_index: overrides.window_index ?? 2,
      pane_id: overrides.pane_id ?? "%7",
    }),
  });
}

function drainAll(): number {
  let total = 0;
  let n: number;
  do {
    n = drain(db);
    total += n;
  } while (n > 0);
  return total;
}

/**
 * Snapshot the DETERMINISTIC-replayed projections a delete must NOT perturb. The
 * `tmux_client_focus` singleton is LIVE-ONLY (re-bootstrapped on connect) and is
 * DELIBERATELY EXCLUDED here — deleting focus rows changing IT is expected; the
 * charter is the deterministic surface.
 */
function snapshotDeterministicProjections() {
  return {
    jobs: db.query("SELECT * FROM jobs ORDER BY job_id").all(),
    subagent_invocations: db
      .query(
        "SELECT * FROM subagent_invocations ORDER BY job_id, agent_id, turn_seq",
      )
      .all(),
    file_attributions: db
      .query(
        "SELECT * FROM file_attributions ORDER BY project_dir, session_id, file_path",
      )
      .all(),
  };
}

/** Rewind the cursor + wipe the deterministic projections for a from-scratch re-fold. */
function rewindAndWipe(): void {
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM subagent_invocations");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM tmux_client_focus");
  // These charter tests deliberately REPLAY the historical git folds (the
  // production live-only surface is boot-seeded, but here we replay to keep the
  // attribution rows observable), so reopen the skip-floor alongside the rewind.
  db.run("UPDATE git_projection_state SET floor = 0 WHERE id = 1");
}

/**
 * Seed a corpus exercising the ORDER-DEPENDENT deterministic projections a row
 * delete could wreck — a subagent turn (subagent_invocations), a mutation +
 * GitSnapshot (file_attributions), jobs lifecycle stamps — and INTERLEAVE focus
 * rows among them so their removal is proven not to perturb the folds around them.
 */
function seedCorpusWithInterleavedFocus(): void {
  insertEvent({ hook_event: "SessionStart", session_id: SESS_A });
  insertFocusSnapshot({ session_name: "main", window_index: 0, pane_id: "%1" });

  insertEvent({ hook_event: "SessionStart", session_id: SESS_B });
  // A second early focus row (the producer's slow navigation trickle).
  insertFocusSnapshot({ session_name: "main", window_index: 0, pane_id: "%3" });

  // A subagent turn (order-dependent subagent_invocations fold).
  insertEvent({
    hook_event: "SubagentStart",
    session_id: SESS_A,
    agent_id: "agent-1",
    agent_type: "worker",
  });
  insertFocusSnapshot({ session_name: "main", window_index: 1, pane_id: "%2" });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    session_id: SESS_A,
    subagent_agent_id: "agent-1",
    data: JSON.stringify({ tool_response: { ok: true } }),
  });
  insertEvent({
    hook_event: "SubagentStop",
    session_id: SESS_A,
    agent_id: "agent-1",
  });

  // A mutation + GitSnapshot (file_attributions fold).
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: SESS_B,
    cwd: REPO,
    data: JSON.stringify({
      tool_input: { file_path: `${REPO}/live.ts`, content: "w".repeat(64) },
    }),
  });
  insertFocusSnapshot({ session_name: "side", window_index: 3, pane_id: "%9" });
  insertEvent({
    hook_event: "GitSnapshot",
    session_id: REPO,
    cwd: REPO,
    data: JSON.stringify({
      project_dir: REPO,
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "live.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: null,
          worktree_mode: null,
        },
      ],
    }),
  });

  // A Notification stamping a jobs column from the event_type (order-dependent).
  insertEvent({
    hook_event: "Notification",
    event_type: "permission_prompt",
    session_id: SESS_B,
    data: JSON.stringify({ message: "ignored" }),
  });
  insertFocusSnapshot({ session_name: "side", window_index: 4, pane_id: "%9" });

  // Trailing keep-set filler in a DEDICATED session so every seeded focus row
  // sits STRICTLY below the fold cursor after a full drain (delete-eligible), and
  // a Stop never clears another session's permission-prompt stamp.
  const FILLER = "ffffffff-0000-1111-2222-333333333333";
  insertEvent({ hook_event: "SessionStart", session_id: FILLER });
  for (let i = 0; i < 4; i++) {
    insertEvent({ hook_event: "Stop", session_id: FILLER });
  }
}

/** Count rows still matching the focus delete predicate. */
function focusRowCount(): number {
  return (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events WHERE ${TMUX_FOCUS_DELETE_PREDICATE}`,
      )
      .get() as { n: number }
  ).n;
}

test("TMUX_FOCUS_DELETE_PREDICATE is a DISTINCT symbol matching ONLY TmuxClientFocusSnapshot — never the no-op-snapshot or broad shed set", () => {
  // The new predicate must be its OWN narrow symbol: it matches the one focus
  // class and is NOT (a) folded into the pinned no-op-snapshot set, nor (b) the
  // broad shed class. A future edit collapsing it into either fails here.
  expect(TMUX_FOCUS_DELETE_PREDICATE).not.toBe(NOOP_SNAPSHOT_DELETE_PREDICATE);
  expect(TMUX_FOCUS_DELETE_PREDICATE).not.toBe(RETENTION_SHED_CLASS_PREDICATE);
  // The no-op-snapshot predicate must NOT have been widened to include focus.
  expect(NOOP_SNAPSHOT_DELETE_PREDICATE).not.toContain(
    "TmuxClientFocusSnapshot",
  );
  // No json parse — the cheap `hook_event` column only, same contract as the
  // no-op-snapshot predicate.
  expect(TMUX_FOCUS_DELETE_PREDICATE).not.toContain("json_extract");
  expect(TMUX_FOCUS_DELETE_PREDICATE).not.toContain("json_valid");

  seedCorpusWithInterleavedFocus();
  drainAll();
  // The predicate selects exactly the focus rows — no other class.
  const focusRows = focusRowCount();
  expect(focusRows).toBeGreaterThanOrEqual(5);
  const otherMatches = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM events
           WHERE ${TMUX_FOCUS_DELETE_PREDICATE}
             AND hook_event != 'TmuxClientFocusSnapshot'`,
      )
      .get() as { n: number }
  ).n;
  expect(otherMatches).toBe(0);
});

test("SAFE: DELETE only the focus rows over a corpus with order-dependent projections → two from-scratch re-folds byte-identical (jobs + subagent_invocations + file_attributions)", () => {
  seedCorpusWithInterleavedFocus();

  // P0 — the live projection (every focus row present).
  drainAll();
  const p0 = snapshotDeterministicProjections();

  // Sanity: the corpus genuinely carries the order-dependent surfaces a broad
  // delete would wreck, so the byte-identity below is non-vacuous.
  expect((p0.subagent_invocations as unknown[]).length).toBeGreaterThan(0);
  expect((p0.file_attributions as unknown[]).length).toBeGreaterThan(0);

  const eligibleFocus = focusRowCount();
  expect(eligibleFocus).toBeGreaterThanOrEqual(5);

  // Run the PRODUCTION delete path over the focus tail (real predicate + watermark
  // + cursor gate). `recentRetentionMargin` 0 makes the whole cold-and-past-cursor
  // tail eligible; `incrementalVacuumPages` 0 (the mem template DB is not
  // auto_vacuum=INCREMENTAL).
  const del = deleteColdTmuxFocusRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(del.deleted).toBe(eligibleFocus); // every focus row removed
  // The rows are GONE — not merely NULLed.
  expect(focusRowCount()).toBe(0);
  // An absent focus row is NOT a data-loss alarm.
  expect(countAbsentBlobs(db)).toBe(0);

  // P1 — a from-scratch re-fold over the POST-DELETE row set.
  rewindAndWipe();
  drainAll();
  const p1 = snapshotDeterministicProjections();
  expect(p1).toEqual(p0);

  // P2 — a SECOND from-scratch re-fold reproduces byte-identical rows (re-fold
  // determinism over the surviving rows is sacred).
  rewindAndWipe();
  drainAll();
  const p2 = snapshotDeterministicProjections();
  expect(p2).toEqual(p1);
});

test("NECESSARY: the focus rows are a genuine deletable cold tail, and the broad-shed delete negative control DIVERGES the re-fold (the narrowing is required)", () => {
  // Eligibility half — the focus rows are a real cold tail the production delete
  // removes (so the predicate is NECESSARY, not a no-op): a fresh corpus, drained,
  // leaves >0 focus rows, and the production delete reclaims exactly them.
  seedCorpusWithInterleavedFocus();
  drainAll();
  const beforeFocus = focusRowCount();
  expect(beforeFocus).toBeGreaterThanOrEqual(5);
  const del = deleteColdTmuxFocusRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(del.deleted).toBe(beforeFocus);
  expect(focusRowCount()).toBe(0);

  // Negative control — the mirror of SAFE, but DELETE the BROAD shed class
  // instead. The shed BODIES are fold-unread, but the ROWS' arms
  // (subagent_invocations turns, jobs stamp clears) and cheap columns are
  // load-bearing, so a from-scratch re-fold over the broad-deleted set MUST
  // diverge — proving the focus predicate's narrowness is self-justifying, not
  // arbitrary (widening it to this set would be a re-fold break).
  db.close();
  db = freshMemDb().db;
  seedCorpusWithInterleavedFocus();
  drainAll();
  const p0 = snapshotDeterministicProjections();

  const cursor = (
    db
      .query("SELECT last_event_id AS c FROM reducer_state WHERE id = 1")
      .get() as { c: number }
  ).c;
  const broadDeleted = db.run(
    `DELETE FROM events WHERE id < ? AND ${RETENTION_SHED_CLASS_PREDICATE}`,
    [cursor],
  ).changes;
  expect(broadDeleted).toBeGreaterThan(0);

  rewindAndWipe();
  drainAll();
  const diverged = snapshotDeterministicProjections();
  expect(diverged).not.toEqual(p0);
});
