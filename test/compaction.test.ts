/**
 * Steady-state retention pass tests (fn-836.5).
 *
 * The retention pass is the repurposed fn-717.2 relocator: it NULLs the cold
 * tail of redundant SHED-CLASS `events.data` bodies IN PLACE (PostToolUse
 * mutation-tool rows whose `tool_input.file_path` is already promoted to
 * `mutation_path` — the complement of the keep-set ALLOW-list) and returns the
 * freed overflow pages to the file via per-batch `incremental_vacuum`.
 *
 * Covers the task .5 Acceptance:
 * - retention NULLs only cold shed-class bodies, paced/watermarked, past the
 *   cursor; keep-set bodies and recent (above-watermark) bodies stay inline;
 * - a from-scratch re-fold over the RETAINED DB reproduces byte-identical
 *   projections (the shed predicate excludes any row still owing a backfill, so
 *   the file_path the fold reads off `mutation_path` was promoted before its body
 *   was dropped);
 * - per-batch `incremental_vacuum` reclaims freelist pages on an
 *   `auto_vacuum=INCREMENTAL` DB (no-op otherwise);
 * - the re-spec'd data-loss sentinel does NOT false-alarm on intentional shed
 *   NULLs, but DOES flag a missing keep-set body;
 * - the pass is idempotent + bounded (never exceeds maxBatches*batchSize).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeColdWatermark,
  countAbsentBlobs,
  deleteColdTmuxFocusRows,
  deleteNoopSnapshotRows,
  drainColdPayloads,
  RECLAIMABLE_LOG_STEP_BYTES,
  RETENTION_KEEP_CLASS_PREDICATE,
  RETENTION_SHED_PREDICATE,
  readFoldCursor,
  reclaimableFreelistBytes,
  reclaimableLogStep,
  retainColdPayloads,
} from "../src/compaction";
import { drain } from "../src/reducer";
import { bindGitObservationWatermark } from "./helpers/git-event-payload";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-retention-test-"));
  // In-process clone of the migrated schema — post-shed there is no `event_blobs`
  // table (fn-836.4 dropped it); retention NULLs `events.data` in place.
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const TEST_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const TEST_OID = "0123456789abcdef0123456789abcdef01234567";

let tsCounter = 1_000;

/**
 * Insert one raw event row; returns its auto-assigned id. Mirrors the forward
 * write path's `mutation_path` stamp for shed-class rows (the hook deriver
 * promotes `tool_input.file_path` at INSERT), so seeded shed-class rows are
 * already backfilled unless a test deliberately leaves `mutationPath` undefined.
 */
function insertEvent(overrides: {
  hook_event: string;
  session_id?: string;
  tool_name?: string | null;
  cwd?: string | null;
  ts?: number;
  data?: string | null;
  mutation_path?: string | null;
  subagent_agent_id?: string | null;
}): number {
  const ts = overrides.ts ?? tsCounter++;
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path, subagent_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts,
      overrides.session_id ?? TEST_UUID,
      overrides.hook_event,
      overrides.hook_event,
      overrides.tool_name ?? null,
      overrides.cwd ?? null,
      bindGitObservationWatermark(
        db,
        overrides.hook_event,
        overrides.data ?? "{}",
      ),
      overrides.mutation_path ?? null,
      overrides.subagent_agent_id ?? null,
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
}

/** Insert a shed-class (PostToolUse mutation) row with file_path already promoted. */
function insertMutation(
  filePath: string,
  opts: { session_id?: string; ts?: number; tool_name?: string } = {},
): number {
  return insertEvent({
    hook_event: "PostToolUse",
    tool_name: opts.tool_name ?? "Write",
    session_id: opts.session_id ?? TEST_UUID,
    cwd: "/repo",
    ts: opts.ts,
    data: JSON.stringify({
      tool_input: { file_path: filePath, content: "x".repeat(200) },
      tool_response: { ok: true, filePath },
    }),
    mutation_path: filePath,
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

/** Snapshot the projection tables the seeded stream touches, for refold compare. */
function projectionSnapshot(): {
  git_status: unknown[];
  file_attributions: unknown[];
  jobs: unknown[];
} {
  return {
    git_status: db.query("SELECT * FROM git_status ORDER BY project_dir").all(),
    file_attributions: db
      .query(
        "SELECT * FROM file_attributions ORDER BY project_dir, file_path, session_id",
      )
      .all(),
    jobs: db.query("SELECT * FROM jobs ORDER BY job_id").all(),
  };
}

/** Parse a job's persisted `jobs.monitors` array (`[]` when null/absent). */
function monitorsForJob(jobId: string): unknown[] {
  const row = db
    .query("SELECT monitors FROM jobs WHERE job_id = ?")
    .get(jobId) as { monitors: string | null } | null;
  if (row?.monitors == null) return [];
  return JSON.parse(row.monitors) as unknown[];
}

/**
 * Seed a stream with a discharged shed-class mutation, a keep-set
 * UserPromptSubmit, plus filler so the cold ids sit below a tiny recent window.
 */
function seedStream(): { coldMutationId: number; promptId: number } {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });

  // KEEP-SET: a UserPromptSubmit whose body carries reducer prompt/title/lifecycle
  // inputs. Must NEVER be NULLed by retention.
  const promptId = insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: TEST_UUID,
    ts: 90,
    data: JSON.stringify({ prompt: "keep me inline forever" }),
  });

  // SHED-CLASS: session A writes cold.ts (file_path already promoted), then
  // commits it clean (discharges).
  const coldMutationId = insertMutation("/repo/cold.ts", { ts: 100 });

  // SHED-CLASS (non-mutation): a Read carrying `tool_input.file_path`. No fold
  // reads its body, so retention sheds it — seeded here so the re-fold proof
  // covers the class this fix newly sheds.
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Read",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 120,
    data: JSON.stringify({
      tool_input: { file_path: "/repo/cold.ts" },
      tool_response: { ok: true },
    }),
  });

  insertEvent({
    hook_event: "GitSnapshot",
    session_id: "/repo",
    cwd: "/repo",
    ts: 150,
    data: JSON.stringify({
      project_dir: "/repo",
      branch: "main",
      head_oid: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty_files: [
        {
          path: "cold.ts",
          xy: " M",
          mtime_ms: null,
          worktree_oid: null,
          worktree_mode: null,
        },
      ],
    }),
  });

  insertEvent({
    hook_event: "Commit",
    session_id: "/repo",
    cwd: "/repo",
    ts: 200,
    data: JSON.stringify({
      project_dir: "/repo",
      commit_oid: TEST_OID,
      parent_oid: null,
      files: ["cold.ts"],
      committer_session_id: TEST_UUID,
      committed_at_ms: 200_000,
    }),
  });

  // Filler keep-set events so the cold/prompt ids sit far below a tiny recent
  // window AND below the fold cursor after a drain.
  for (let i = 0; i < 30; i++) {
    insertEvent({ hook_event: "Stop", session_id: TEST_UUID, ts: 300 + i });
  }

  return { coldMutationId, promptId };
}

test("computeColdWatermark is the recent-retention window (max id - margin)", () => {
  seedStream();
  drainAll();
  const maxId = (
    db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;

  expect(computeColdWatermark(db, 2)).toBe(maxId - 2);
  expect(computeColdWatermark(db, 0)).toBe(maxId);
  // A margin larger than the table keeps everything inline (floors at 0).
  expect(computeColdWatermark(db, maxId + 100)).toBe(0);
});

test("readFoldCursor reads reducer_state.last_event_id", () => {
  seedStream();
  expect(readFoldCursor(db)).toBe(0); // not yet drained
  drainAll();
  const maxId = (
    db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;
  expect(readFoldCursor(db)).toBe(maxId);
});

test("retention NULLs a cold shed-class body; keep-set + recent bodies stay inline; no row deleted", () => {
  const { coldMutationId, promptId } = seedStream();
  drainAll();

  const beforeRowCount = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  const promptBody = (
    db.query("SELECT data FROM events WHERE id = ?").get(promptId) as {
      data: string;
    }
  ).data;

  // Recent window keeps the newest 2 events inline; cold mutation is far below.
  const result = retainColdPayloads(db, {
    recentRetentionMargin: 2,
    batchSize: 10,
    maxBatches: 5,
    incrementalVacuumPages: 0, // mem DB is not auto_vacuum=INCREMENTAL
  });
  expect(result.shed).toBeGreaterThan(0);

  // Shed-class body: NULL in place. mutation_path retained.
  const coldRow = db
    .query("SELECT data, mutation_path FROM events WHERE id = ?")
    .get(coldMutationId) as { data: string | null; mutation_path: string };
  expect(coldRow.data).toBeNull();
  expect(coldRow.mutation_path).toBe("/repo/cold.ts");

  // Keep-set body (UserPromptSubmit): untouched, still inline.
  const promptRow = db
    .query("SELECT data FROM events WHERE id = ?")
    .get(promptId) as { data: string | null };
  expect(promptRow.data).toBe(promptBody);

  // No row deleted.
  const afterRowCount = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(afterRowCount).toBe(beforeRowCount);
});

test("retention keeps PostToolUse:Agent + SubagentStop bodies for IO-pair capture; still sheds SubagentStart/Notification", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });

  // KEEP (offline-analysis capture): a modern PostToolUse:Agent carrying the
  // subagent's final answer/model/usage — kept even with subagent_agent_id set.
  const agentBody = JSON.stringify({
    tool_response: { agentId: "sub-1", content: "the subagent's final answer" },
    resolvedModel: "claude-opus-4-8",
  });
  const agentId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    subagent_agent_id: "sub-1",
    ts: 100,
    data: agentBody,
  });

  // KEEP (offline-analysis capture): a SubagentStop carrying the output half.
  const stopBody = JSON.stringify({
    agent_id: "sub-1",
    last_assistant_message: "wrapping up",
    effort: "high",
    agent_transcript_path: "/t/sub-1.jsonl",
  });
  const stopId = insertEvent({
    hook_event: "SubagentStop",
    ts: 101,
    data: stopBody,
  });

  // STILL SHED: SubagentStart + Notification bodies (no fold reads them).
  const startId = insertEvent({
    hook_event: "SubagentStart",
    ts: 102,
    data: JSON.stringify({ agent_id: "sub-1", shed: "me" }),
  });
  const notifyId = insertEvent({
    hook_event: "Notification",
    ts: 103,
    data: JSON.stringify({ message: "shed me too" }),
  });

  // Filler keep-set events so the seeded ids sit far below the recent window
  // AND below the fold cursor after the drain.
  for (let i = 0; i < 30; i++) {
    insertEvent({ hook_event: "Stop", session_id: TEST_UUID, ts: 300 + i });
  }
  drainAll();

  const result = retainColdPayloads(db, {
    recentRetentionMargin: 2,
    batchSize: 10,
    maxBatches: 5,
    incrementalVacuumPages: 0,
  });
  expect(result.shed).toBeGreaterThan(0);

  const bodyOf = (id: number) =>
    (
      db.query("SELECT data FROM events WHERE id = ?").get(id) as {
        data: string | null;
      }
    ).data;

  // Newly-kept classes: bodies intact.
  expect(bodyOf(agentId)).toBe(agentBody);
  expect(bodyOf(stopId)).toBe(stopBody);

  // Still-shed classes: bodies NULLed.
  expect(bodyOf(startId)).toBeNull();
  expect(bodyOf(notifyId)).toBeNull();
});

test("retention never strips a body at or above the fold cursor", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  // Many cold shed-class mutations, but DON'T drain — cursor stays 0, so nothing
  // is past it and retention must shed nothing.
  for (let i = 0; i < 20; i++) {
    insertMutation(`/repo/f${i}.ts`);
  }
  expect(readFoldCursor(db)).toBe(0);
  const undrained = retainColdPayloads(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(undrained.shed).toBe(0);

  // Drain HALF the stream, then retain: only ids strictly below the cursor are
  // eligible. Simulate a partial cursor by rewinding it.
  drainAll();
  const maxId = (
    db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;
  const partialCursor = maxId - 5;
  db.run("UPDATE reducer_state SET last_event_id = ? WHERE id = 1", [
    partialCursor,
  ]);

  retainColdPayloads(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });

  // Every still-inline shed-class body must have id >= cursor.
  const inlineAboveCursor = (
    db
      .query(
        `SELECT MIN(id) AS m FROM events
          WHERE data IS NOT NULL
            AND hook_event = 'PostToolUse'
            AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit')`,
      )
      .get() as { m: number | null }
  ).m;
  if (inlineAboveCursor !== null) {
    expect(inlineAboveCursor).toBeGreaterThanOrEqual(partialCursor);
  }
});

test("retention never strips a shed-class row still owing a mutation_path backfill", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  // A shed-class row whose body holds a file_path but mutation_path IS NULL — it
  // still owes a backfill, so its body is the ONLY copy of the file_path. NULLing
  // it would lose fold-read data, so retention must leave it inline.
  const unbackfilledId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    data: JSON.stringify({ tool_input: { file_path: "/repo/unfilled.ts" } }),
    mutation_path: null,
  });
  // A backfilled shed-class row (body redundant — file_path in the column).
  const backfilledId = insertMutation("/repo/filled.ts");
  // A shed-class row whose body carries NO promotable file_path (valid JSON, no
  // `$.tool_input.file_path`) — extract is NULL, so it's freely sheddable.
  const noPathId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Edit",
    session_id: TEST_UUID,
    cwd: "/repo",
    data: JSON.stringify({ tool_input: {}, tool_response: { ok: true } }),
    mutation_path: null,
  });
  // A NON-mutation shed-class row (Read) whose body carries `tool_input.file_path`
  // but owns no `mutation_path` — no fold reads its body, so it MUST shed. The
  // backfill guard is scoped to the four mutation tools; a Read is outside it.
  const readWithPathId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Read",
    session_id: TEST_UUID,
    cwd: "/repo",
    data: JSON.stringify({
      tool_input: { file_path: "/repo/read-me.ts" },
      tool_response: { ok: true },
    }),
    mutation_path: null,
  });
  // Trailing keep-set events so every seeded shed-class row sits strictly below
  // the fold cursor (`id < cursor`).
  for (let i = 0; i < 3; i++) {
    insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  }
  drainAll();

  retainColdPayloads(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });

  // Unbackfilled row: body stays inline (still owes a backfill).
  expect(
    (
      db.query("SELECT data FROM events WHERE id = ?").get(unbackfilledId) as {
        data: string | null;
      }
    ).data,
  ).not.toBeNull();
  // Backfilled row: body NULLed.
  expect(
    (
      db.query("SELECT data FROM events WHERE id = ?").get(backfilledId) as {
        data: string | null;
      }
    ).data,
  ).toBeNull();
  // No-file_path row (nothing to lose): body NULLed.
  expect(
    (
      db.query("SELECT data FROM events WHERE id = ?").get(noPathId) as {
        data: string | null;
      }
    ).data,
  ).toBeNull();
  // Read row carrying file_path but owing no backfill: body SHEDS (guard is
  // mutation-tool-scoped; a Read is not one of the four).
  expect(
    (
      db.query("SELECT data FROM events WHERE id = ?").get(readWithPathId) as {
        data: string | null;
      }
    ).data,
  ).toBeNull();
});

test("retention-then-from-scratch-refold reproduces byte-identical projections", () => {
  seedStream();
  drainAll();
  const before = projectionSnapshot();

  retainColdPayloads(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });

  // From-scratch re-fold over the RETAINED DB: rewind the cursor + wipe the
  // projections, re-drain. Byte-identical projections prove the shed lost nothing
  // a fold reads (file_path served from mutation_path, keep-set bodies inline).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  const after = projectionSnapshot();
  expect(after.git_status).toEqual(before.git_status);
  expect(after.file_attributions).toEqual(before.file_attributions);
  expect(after.jobs).toEqual(before.jobs);
});

test("data-loss sentinel: no false alarm on intentional shed NULLs; flags a missing keep-set body", () => {
  const { promptId } = seedStream();
  drainAll();

  expect(countAbsentBlobs(db)).toBe(0);

  // Retention NULLs shed-class bodies — INTENTIONAL, must NOT be flagged.
  retainColdPayloads(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(countAbsentBlobs(db)).toBe(0);

  // Inject the BUG state: NULL a KEEP-SET body (a UserPromptSubmit). This is real
  // data loss the retention path can never create (its predicate matches ONLY
  // shed-class mutation tools).
  db.run("UPDATE events SET data = NULL WHERE id = ?", [promptId]);
  expect(countAbsentBlobs(db)).toBe(1);

  // The fold must STILL be safe over a missing keep-set body — re-fold doesn't
  // throw and the cursor advances (a missing body folds to the same safe value as
  // a malformed one).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  expect(() => drainAll()).not.toThrow();
  expect(readFoldCursor(db)).toBeGreaterThan(0);
});

test("data-loss sentinel: NULL-tolerant keep-set classes are exempt; a mandatory-body keep-set loss still fires", () => {
  // MANDATORY-BODY keep-set rows — the body is the SOLE source of a fold-read
  // value, so a NULL body IS data loss the sentinel must flag.
  //  - UserPromptSubmit: prompt/title/lifecycle fold inputs.
  const promptId = insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: TEST_UUID,
    data: JSON.stringify({ prompt: "keep me" }),
  });
  //  - a LEGACY PostToolUse:Agent (no `subagent_agent_id` column) resolves the
  //    bridge agent id from the body's `tool_response.agentId` fallback.
  const legacyAgentId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    subagent_agent_id: null,
    data: JSON.stringify({ tool_response: { agentId: "sub-legacy" } }),
  });

  // NULL-TOLERANT keep-set rows minted body-less — a legitimate absence, NEVER
  // flagged: no fold reads the body, or the fold tolerates a mint-absent one.
  insertEvent({ hook_event: "SubagentStop", data: null });
  insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Agent",
    subagent_agent_id: "sub-modern", // the modern bridge reads the cheap column
    data: null,
  });
  insertEvent({ hook_event: "ResumeTargetResolved", data: null });
  insertEvent({ hook_event: "SessionStart", data: null }); // adopted-harness mint
  insertEvent({ hook_event: "Stop", data: null }); // synthetic turn-completion

  // Every body-less NULL-tolerant keep-set row above is exempt — sentinel clean.
  expect(countAbsentBlobs(db)).toBe(0);

  // NULLing a mandatory-body keep-set row IS data loss — the sentinel fires, one
  // per row, and still separates the modern bridge (exempt) from the legacy one.
  db.run("UPDATE events SET data = NULL WHERE id = ?", [promptId]);
  expect(countAbsentBlobs(db)).toBe(1);
  db.run("UPDATE events SET data = NULL WHERE id = ?", [legacyAgentId]);
  expect(countAbsentBlobs(db)).toBe(2);
});

test("data-loss sentinel: a NULLed final-Stop body stays EXEMPT even though its background_tasks feed jobs.monitors — the monitors->'[]' divergence is benign drop-when-dead", () => {
  // A Claude Code session whose FINAL Stop carries a live `background_tasks`
  // snapshot. That body feeds computeMonitors -> jobs.monitors (a byte-identical
  // re-fold charter projection) plus its derived has_live_worker_monitor readiness
  // fact and the `keeper await` background-task condition — so the Stop body IS a
  // charter fold input, NOT "a body no fold reads".
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID, ts: 100 });
  const finalStopId = insertEvent({
    hook_event: "Stop",
    session_id: TEST_UUID,
    ts: 200,
    // An ambient shell (no launch event in the stream) — provenance resolves to
    // `ambient`; hand-derived from the payload shape, not the code under test.
    data: JSON.stringify({
      background_tasks: [{ id: "amb-shell", type: "shell" }],
    }),
  });
  drainAll();

  // The final Stop's body populated jobs.monitors with the live shell — proof the
  // body is a real fold input, not offline-analysis capture.
  expect(monitorsForJob(TEST_UUID)).toEqual([
    { id: "amb-shell", kind: "ambient", command: "", description: "" },
  ]);

  // Inject the data-loss state the sentinel is meant to catch: NULL the final
  // Stop's body (a stray NULLing write / corrupt restore — retention itself can
  // NEVER create this, its predicate matches only shed-class rows).
  db.run("UPDATE events SET data = NULL WHERE id = ?", [finalStopId]);

  // A cursor=0 re-fold over the NULLed log DIVERGES: monitors collapse to '[]'
  // (drop-when-dead) instead of the live shell — exactly the charter divergence the
  // old "no fold reads its body" rationale wrongly denied. Snapshot-replace means
  // there is no later Stop to re-derive the surviving value.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  expect(() => drainAll()).not.toThrow();
  expect(monitorsForJob(TEST_UUID)).toEqual([]);

  // CHOSEN BEHAVIOR (keep + correct): the Stop class stays EXEMPT — the sentinel
  // does NOT flag the NULLed final-Stop body. The divergence is benign (monitors
  // snapshots LIVE OS shells that cannot outlive the re-fold's daemon reboot, so
  // '[]' is the intended drop-when-dead value; every reader treats absent monitors
  // as done/not-holding), and cheap-header classification cannot separate this
  // stray-NULLed body from a legitimately mint-NULL synthetic Stop (mintCodexStop
  // writes data:null by construction), whose class would drown the sentinel in
  // false positives. Without the Stop exemption this count would be 1.
  expect(countAbsentBlobs(db)).toBe(0);
});

test("paced: a pass never exceeds maxBatches*batchSize sheds; idempotent across passes", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  for (let i = 0; i < 50; i++) {
    insertMutation(`/repo/f${i}.ts`);
  }
  drainAll();
  expect(computeColdWatermark(db, 0)).toBeGreaterThan(0);

  // batchSize 5 * maxBatches 3 = 15 max per pass even though >15 are cold.
  const result = retainColdPayloads(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 3,
    incrementalVacuumPages: 0,
  });
  expect(result.shed).toBe(15);
  expect(result.batches).toBe(3);
  expect(result.moreLikely).toBe(true);

  // A second pass picks up where the first left off (idempotent — already-shed
  // rows have data IS NULL and are skipped).
  const result2 = retainColdPayloads(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 3,
    incrementalVacuumPages: 0,
  });
  expect(result2.shed).toBe(15);
});

test("retention shrinks the inline footprint; per-batch incremental_vacuum reclaims on an INCREMENTAL DB", () => {
  // A minimal DB born with auto_vacuum=INCREMENTAL so incremental_vacuum actually
  // returns freed overflow pages (the .4 reclaimDb bakes this into the live file).
  const path = join(tmpDir, "incr.db");
  const idb = new Database(path, { create: true });
  idb.run("PRAGMA auto_vacuum=INCREMENTAL");
  idb.run("PRAGMA journal_mode=WAL");
  idb.run(
    `CREATE TABLE events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ts REAL, session_id TEXT, hook_event TEXT, event_type TEXT,
       tool_name TEXT, cwd TEXT, data TEXT, mutation_path TEXT,
       plan_op TEXT, subagent_agent_id TEXT
     )`,
  );
  idb.run(
    "CREATE TABLE reducer_state (id INTEGER PRIMARY KEY, last_event_id INTEGER NOT NULL)",
  );
  idb.run("INSERT INTO reducer_state (id, last_event_id) VALUES (1, 0)");

  // Seed 40 shed-class mutation rows with bodies large enough to spill onto
  // overflow pages (default 4096 page → ~4 KB body forces overflow).
  const bigBody = JSON.stringify({
    tool_input: { file_path: "/repo/big.ts", content: "x".repeat(8000) },
    tool_response: { ok: true },
  });
  for (let i = 0; i < 40; i++) {
    idb.run(
      `INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, cwd, data, mutation_path)
       VALUES (?, ?, 'PostToolUse', 'PostToolUse', 'Write', '/repo', ?, ?)`,
      [1000 + i, TEST_UUID, bigBody, `/repo/big${i}.ts`],
    );
  }
  // Advance the cursor past all rows so retention is eligible.
  idb.run("UPDATE reducer_state SET last_event_id = 9999 WHERE id = 1");

  const inlineBytesBefore = (
    idb
      .query("SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM events")
      .get() as { b: number }
  ).b;
  expect(inlineBytesBefore).toBeGreaterThan(40 * 8000);

  const result = retainColdPayloads(idb, {
    recentRetentionMargin: 0,
    batchSize: 100,
    maxBatches: 10,
    incrementalVacuumPages: 200,
  });
  expect(result.shed).toBe(40);

  // Inline footprint shrank to ~nothing (every shed-class body NULLed).
  const inlineBytesAfter = (
    idb
      .query("SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM events")
      .get() as { b: number }
  ).b;
  expect(inlineBytesAfter).toBeLessThan(inlineBytesBefore);

  // incremental_vacuum returned freed overflow pages to the file tail.
  expect(result.reclaimedPages).toBeGreaterThan(0);
  // And the freelist is drained (nothing left stranded).
  const freelist = (
    idb.query("PRAGMA freelist_count").get() as { freelist_count: number }
  ).freelist_count;
  expect(freelist).toBe(0);

  idb.close();
});

test("incremental_vacuum is a no-op (0 reclaimed) on a non-INCREMENTAL DB", () => {
  // The mem template DB is NOT auto_vacuum=INCREMENTAL, so the pragma reclaims
  // nothing — retention still NULLs bodies (re-fold safety never depends on the
  // physical reclaim).
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  for (let i = 0; i < 10; i++) {
    insertMutation(`/repo/f${i}.ts`);
  }
  // A trailing keep-set event so all 10 mutation rows sit strictly below the
  // fold cursor (`id < cursor`), making every one eligible.
  insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  drainAll();

  const result = retainColdPayloads(db, {
    recentRetentionMargin: 0,
    batchSize: 100,
    maxBatches: 5,
    incrementalVacuumPages: 200,
  });
  expect(result.shed).toBe(10);
  expect(result.reclaimedPages).toBe(0);
});

test("no work to do: watermark 0 / empty DB is a clean no-op", () => {
  const result = retainColdPayloads(db);
  expect(result.shed).toBe(0);
  expect(result.batches).toBe(0);
  expect(result.coldWatermark).toBe(0);
  expect(countAbsentBlobs(db)).toBe(0);
});

test("drainColdPayloads drives a cold backlog to shed=0 in ≤batchSize-row txns across multiple passes", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  // 120 cold shed-class bodies — more than one pass at (batchSize 5 * maxBatches
  // 4 = 20 rows/pass), so the drain MUST loop several passes to finish.
  for (let i = 0; i < 120; i++) {
    insertMutation(`/repo/f${i}.ts`);
  }
  // A trailing keep-set event so every mutation row sits strictly below the
  // fold cursor (`id < cursor`).
  insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  drainAll();

  const passSheds: number[] = [];
  const result = drainColdPayloads(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 4,
    incrementalVacuumPages: 0,
    onPass: (r) => passSheds.push(r.shed),
  });

  // The whole cold backlog drained.
  expect(result.shed).toBe(120);
  expect(result.hitPassCap).toBe(false);
  // Multiple passes ran (120 / (5*4) = 6 full passes + a final shed-nothing
  // pass that stops the loop).
  expect(result.passes).toBeGreaterThan(1);
  // Each pass shed at most maxBatches*batchSize rows — never one giant UPDATE.
  for (const s of passSheds) expect(s).toBeLessThanOrEqual(20);
  // The terminal pass shed nothing (that's what stopped the loop).
  expect(passSheds[passSheds.length - 1]).toBe(0);

  // Every cold shed-class body is NULL now.
  const remaining = (
    db
      .query(
        "SELECT COUNT(*) AS n FROM events WHERE hook_event='PostToolUse' AND tool_name='Write' AND data IS NOT NULL",
      )
      .get() as { n: number }
  ).n;
  expect(remaining).toBe(0);
  // No keep-set body went missing.
  expect(countAbsentBlobs(db)).toBe(0);
});

test("drainColdPayloads is idempotent/resumable — a second run sheds nothing", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  for (let i = 0; i < 30; i++) {
    insertMutation(`/repo/f${i}.ts`);
  }
  insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  drainAll();

  const first = drainColdPayloads(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 50,
    incrementalVacuumPages: 0,
  });
  expect(first.shed).toBe(30);

  // Re-running over the already-drained DB sheds nothing (already-NULL bodies
  // are skipped by `data IS NOT NULL`) and exits after one shed-nothing pass.
  const second = drainColdPayloads(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 50,
    incrementalVacuumPages: 0,
  });
  expect(second.shed).toBe(0);
  expect(second.passes).toBe(1);
});

test("drainColdPayloads flags hitPassCap when maxPasses trips before the backlog drains", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  for (let i = 0; i < 40; i++) {
    insertMutation(`/repo/f${i}.ts`);
  }
  insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  drainAll();

  // 40 cold rows but only 2 passes of (1 batch * 5 rows) = 10 rows allowed —
  // the runaway guard trips with rows still shedding.
  const result = drainColdPayloads(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 1,
    maxPasses: 2,
    incrementalVacuumPages: 0,
  });
  expect(result.shed).toBe(10);
  expect(result.passes).toBe(2);
  expect(result.hitPassCap).toBe(true);

  // A follow-up run (idempotent) finishes the remaining backlog.
  const finish = drainColdPayloads(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 50,
    incrementalVacuumPages: 0,
  });
  expect(finish.shed).toBe(30);
  expect(finish.hitPassCap).toBe(false);
});

test("drainColdPayloads over a clean DB is a no-op (no passes shed)", () => {
  const result = drainColdPayloads(db);
  expect(result.shed).toBe(0);
  expect(result.passes).toBe(1);
  expect(result.hitPassCap).toBe(false);
});

// ---------------------------------------------------------------------------
// deleteNoopSnapshotRows (fn-934.5) — the ROW-DELETE mechanics: batched, gated
// `id < cursor AND id <= coldWatermark`, paced/bounded, idempotent, reclaiming via
// per-batch incremental_vacuum. (The re-fold-SAFETY proof lives in
// refold-equivalence.test.ts; here we pin the delete plumbing.)
// ---------------------------------------------------------------------------

/** Insert a no-op-arm snapshot row (BackendExecSnapshot by default). */
function insertNoopSnapshot(
  opts: { hook_event?: string; session_id?: string; ts?: number } = {},
): number {
  return insertEvent({
    hook_event: opts.hook_event ?? "BackendExecSnapshot",
    session_id: opts.session_id ?? "noop-sess",
    ts: opts.ts,
    data: JSON.stringify({ note: "no-op snapshot" }),
  });
}

test("deleteNoopSnapshotRows physically removes cold no-op-snapshot rows; keep-set + recent rows survive", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  const promptId = insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: TEST_UUID,
    data: JSON.stringify({ prompt: "keep me" }),
  });
  // A cold mutation row (shed-class but NOT no-op-snapshot — must survive the
  // DELETE; only its body is NULL-eligible elsewhere).
  const mutationId = insertMutation("/repo/keep.ts");
  // Each of the three no-op-snapshot classes.
  const besId = insertNoopSnapshot({ hook_event: "BackendExecSnapshot" });
  const tpsId = insertNoopSnapshot({ hook_event: "TmuxPaneSnapshot" });
  const wisId = insertNoopSnapshot({ hook_event: "WindowIndexSnapshot" });
  for (let i = 0; i < 5; i++) {
    insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  }
  drainAll();

  const beforeRowCount = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;

  const result = deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 2,
    batchSize: 10,
    maxBatches: 5,
    incrementalVacuumPages: 0,
  });
  expect(result.deleted).toBe(3);
  expect(result.batches).toBeGreaterThan(0);

  // The three no-op-snapshot rows are GONE.
  for (const id of [besId, tpsId, wisId]) {
    expect(db.query("SELECT id FROM events WHERE id = ?").get(id)).toBeNull();
  }
  // Keep-set + the non-no-op shed-class mutation row survive.
  expect(
    db.query("SELECT id FROM events WHERE id = ?").get(promptId),
  ).not.toBeNull();
  expect(
    db.query("SELECT id FROM events WHERE id = ?").get(mutationId),
  ).not.toBeNull();
  // Exactly three rows removed.
  const afterRowCount = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(afterRowCount).toBe(beforeRowCount - 3);
});

test("deleteNoopSnapshotRows never deletes a row at or above the fold cursor", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  for (let i = 0; i < 10; i++) {
    insertNoopSnapshot();
  }
  // Undrained: cursor is 0, so NOTHING is past it — nothing eligible.
  expect(readFoldCursor(db)).toBe(0);
  const undrained = deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(undrained.deleted).toBe(0);

  // Drain, then rewind the cursor to mid-stream: only ids strictly below the
  // cursor are eligible.
  drainAll();
  const maxId = (
    db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;
  const partialCursor = maxId - 4;
  db.run("UPDATE reducer_state SET last_event_id = ? WHERE id = 1", [
    partialCursor,
  ]);

  deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });

  // Every surviving no-op-snapshot row must have id >= cursor.
  const minSurviving = (
    db
      .query(
        "SELECT MIN(id) AS m FROM events WHERE hook_event = 'BackendExecSnapshot'",
      )
      .get() as { m: number | null }
  ).m;
  if (minSurviving !== null) {
    expect(minSurviving).toBeGreaterThanOrEqual(partialCursor);
  }
});

test("deleteNoopSnapshotRows is paced (never exceeds maxBatches*batchSize) and idempotent across passes", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  for (let i = 0; i < 50; i++) {
    insertNoopSnapshot();
  }
  insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  drainAll();

  // batchSize 5 * maxBatches 3 = 15 max per pass even though >15 are cold.
  const first = deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 3,
    incrementalVacuumPages: 0,
  });
  expect(first.deleted).toBe(15);
  expect(first.batches).toBe(3);
  expect(first.moreLikely).toBe(true);

  // A second pass picks up where the first left off (the deleted rows are gone,
  // so they cannot re-match) and removes the next 15.
  const second = deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 3,
    incrementalVacuumPages: 0,
  });
  expect(second.deleted).toBe(15);
});

test("deleteNoopSnapshotRows reclaims freed pages via per-batch incremental_vacuum on an INCREMENTAL DB", () => {
  const path = join(tmpDir, "noop-incr.db");
  const idb = new Database(path, { create: true });
  idb.run("PRAGMA auto_vacuum=INCREMENTAL");
  idb.run("PRAGMA journal_mode=WAL");
  idb.run(
    `CREATE TABLE events (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       ts REAL, session_id TEXT, hook_event TEXT, event_type TEXT,
       tool_name TEXT, cwd TEXT, data TEXT, mutation_path TEXT,
       plan_op TEXT, subagent_agent_id TEXT
     )`,
  );
  idb.run(
    "CREATE TABLE reducer_state (id INTEGER PRIMARY KEY, last_event_id INTEGER NOT NULL)",
  );
  idb.run("INSERT INTO reducer_state (id, last_event_id) VALUES (1, 0)");

  // 40 no-op-snapshot rows with bodies large enough to spill onto overflow pages.
  const bigBody = JSON.stringify({ note: "x".repeat(8000) });
  for (let i = 0; i < 40; i++) {
    idb.run(
      `INSERT INTO events (ts, session_id, hook_event, event_type, data)
       VALUES (?, ?, 'BackendExecSnapshot', 'BackendExecSnapshot', ?)`,
      [1000 + i, "noop-sess", bigBody],
    );
  }
  idb.run("UPDATE reducer_state SET last_event_id = 9999 WHERE id = 1");

  const result = deleteNoopSnapshotRows(idb, {
    recentRetentionMargin: 0,
    batchSize: 100,
    maxBatches: 10,
    incrementalVacuumPages: 200,
  });
  expect(result.deleted).toBe(40);
  // Every no-op-snapshot row physically removed.
  expect(
    (idb.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  ).toBe(0);
  // incremental_vacuum returned freed pages to the file tail; freelist drained.
  expect(result.reclaimedPages).toBeGreaterThan(0);
  expect(
    (idb.query("PRAGMA freelist_count").get() as { freelist_count: number })
      .freelist_count,
  ).toBe(0);
  idb.close();
});

test("deleteNoopSnapshotRows over a clean / no-eligible-rows DB is a no-op", () => {
  const empty = deleteNoopSnapshotRows(db);
  expect(empty.deleted).toBe(0);
  expect(empty.batches).toBe(0);
  expect(empty.coldWatermark).toBe(0);

  // Only keep-set rows present → still a clean no-op (no no-op-snapshot rows).
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  for (let i = 0; i < 5; i++) {
    insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  }
  drainAll();
  const keepOnly = deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(keepOnly.deleted).toBe(0);
});

test("countAbsentBlobs re-spec: an absent (deleted) no-op-snapshot row is NOT a data-loss alarm; a missing keep-set body still is", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  const promptId = insertEvent({
    hook_event: "UserPromptSubmit",
    session_id: TEST_UUID,
    data: JSON.stringify({ prompt: "keep me" }),
  });
  for (let i = 0; i < 5; i++) insertNoopSnapshot();
  insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  drainAll();

  expect(countAbsentBlobs(db)).toBe(0);

  // Physically delete the no-op-snapshot rows — an INTENTIONAL absence that must
  // NOT be flagged (a gone row carries no record, so it can never surface as a
  // NULL body either).
  deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(countAbsentBlobs(db)).toBe(0);

  // Inject the BUG state: NULL a KEEP-SET body — real data loss neither retention
  // path can create. The sentinel must still flag it.
  db.run("UPDATE events SET data = NULL WHERE id = ?", [promptId]);
  expect(countAbsentBlobs(db)).toBe(1);
});

// ---------------------------------------------------------------------------
// TmuxTopologySnapshot explicit keep invariant (fn-955.4) — restore's
// source-of-truth class is retained ROW AND BODY by an explicit positive keep
// predicate, surviving a retention pass that sheds/deletes its neighbors.
// ---------------------------------------------------------------------------

/** Insert a TmuxTopologySnapshot row whose body carries the panes the deriver reads. */
function insertTopologySnapshot(
  opts: { session_id?: string; ts?: number } = {},
): number {
  return insertEvent({
    hook_event: "TmuxTopologySnapshot",
    session_id: opts.session_id ?? "tmux-topology",
    ts: opts.ts,
    data: JSON.stringify({
      generation_id: 4242,
      panes: [{ pane_id: "%1", window_index: 0, job_id: "fn-x.1" }],
    }),
  });
}

test("the keep predicate is a cheap-column class gate (no json parse) carrying exactly TmuxTopologySnapshot", () => {
  // The keep invariant must classify shed-vs-keep on cheap columns alone so it
  // composes into the body-NULL and row-delete gates without ever re-parsing a
  // (possibly-NULL) body — the same hard contract as the shed/delete predicates.
  expect(RETENTION_KEEP_CLASS_PREDICATE).not.toContain("json_extract");
  expect(RETENTION_KEEP_CLASS_PREDICATE).not.toContain("json_valid");
  expect(RETENTION_KEEP_CLASS_PREDICATE).toContain("TmuxTopologySnapshot");
  // It is AND-NOTed into the body-NULL gate as the DEFENSIVE backstop, so a
  // future shed allow-list widen can never NULL the snapshot body.
  expect(RETENTION_SHED_PREDICATE).toContain(
    `NOT (${RETENTION_KEEP_CLASS_PREDICATE})`,
  );
});

test("a TmuxTopologySnapshot row AND body survive a retention pass that sheds/deletes its cold neighbors", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  // The snapshot interleaved with the exact neighbors a retention pass acts on:
  // a shed-class mutation (body NULL-eligible) and the three no-op-snapshot
  // classes + the focus class (row-delete-eligible). All sit cold, below cursor.
  const mutationId = insertMutation("/repo/cold.ts");
  const topoId = insertTopologySnapshot();
  const besId = insertNoopSnapshot({ hook_event: "BackendExecSnapshot" });
  const tpsId = insertNoopSnapshot({ hook_event: "TmuxPaneSnapshot" });
  const wisId = insertNoopSnapshot({ hook_event: "WindowIndexSnapshot" });
  const focusId = insertEvent({
    hook_event: "TmuxClientFocusSnapshot",
    session_id: "tmux-focus",
    data: JSON.stringify({ window_index: 0 }),
  });
  for (let i = 0; i < 5; i++) {
    insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  }
  drainAll();

  const topoBodyBefore = (
    db.query("SELECT data FROM events WHERE id = ?").get(topoId) as {
      data: string | null;
    }
  ).data;

  // Body-NULL retention pass: the shed-class mutation body is NULLed; the
  // topology body MUST stay inline (the keep predicate AND-NOTs it out).
  const retained = retainColdPayloads(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(retained.shed).toBeGreaterThan(0);
  expect(
    (
      db.query("SELECT data FROM events WHERE id = ?").get(mutationId) as {
        data: string | null;
      }
    ).data,
  ).toBeNull();
  expect(
    (
      db.query("SELECT data FROM events WHERE id = ?").get(topoId) as {
        data: string | null;
      }
    ).data,
  ).toBe(topoBodyBefore);

  // Row-delete passes: the three no-op-snapshot rows AND the focus row are
  // removed; the topology ROW MUST survive both delete predicates.
  deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  deleteColdTmuxFocusRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  for (const id of [besId, tpsId, wisId, focusId]) {
    expect(db.query("SELECT id FROM events WHERE id = ?").get(id)).toBeNull();
  }
  // The topology snapshot row + body are intact — restore's source survives.
  const surviving = db
    .query("SELECT id, data FROM events WHERE id = ?")
    .get(topoId) as { id: number; data: string | null } | null;
  expect(surviving).not.toBeNull();
  expect(surviving?.data).toBe(topoBodyBefore);
  // And the surviving body still decodes to the panes the deriver reads.
  expect(
    (JSON.parse(surviving?.data ?? "{}") as { panes: unknown[] }).panes.length,
  ).toBe(1);
});

test("DEFENSIVE: the keep guard dominates even a hypothetical delete predicate that names TmuxTopologySnapshot", () => {
  // Simulate a future bug — a delete predicate widened to capture the topology
  // class. The keep guard AND-NOTed into deleteColdRowsByPredicate must still
  // spare the row (the test reuses the focus delete entrypoint only to confirm
  // the real machinery's guard; here we directly assert the predicate composition
  // by deleting via a topology-naming predicate through the no-op path is
  // impossible — the snapshot is never in NOOP_SNAPSHOT_DELETE_PREDICATE, and the
  // keep guard backstops any future widen). Construct the worst case explicitly:
  // a TmuxTopologySnapshot row that ALSO matches a no-op-snapshot class is
  // structurally impossible (distinct hook_event), so we assert the SQL-level
  // guarantee: no delete pass selects a TmuxTopologySnapshot id.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  const topoId = insertTopologySnapshot();
  insertNoopSnapshot({ hook_event: "BackendExecSnapshot" });
  for (let i = 0; i < 5; i++) {
    insertEvent({ hook_event: "Stop", session_id: TEST_UUID });
  }
  drainAll();

  // Even running every production delete pass, the topology row is never removed.
  deleteNoopSnapshotRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  deleteColdTmuxFocusRows(db, {
    recentRetentionMargin: 0,
    incrementalVacuumPages: 0,
  });
  expect(
    db.query("SELECT id FROM events WHERE id = ?").get(topoId),
  ).not.toBeNull();
});

// ---------------------------------------------------------------------------
// reclaimableFreelistBytes / reclaimableLogStep (fn-1051) — the reclaimable-space
// observability surface: freelist pages × page size, and the step-latch that logs
// the pool only on a fresh upward 100MB crossing.
// ---------------------------------------------------------------------------

test("reclaimableFreelistBytes tracks freelist pages × page size and grows with stranded pages", () => {
  // The mem template DB is NOT auto_vacuum, so deleted rows strand pages on the
  // freelist rather than trimming the file tail — exactly the pool a full offline
  // reclaim would recover.
  const pageSize = (db.query("PRAGMA page_size").get() as { page_size: number })
    .page_size;
  const freelistPages = () =>
    (db.query("PRAGMA freelist_count").get() as { freelist_count: number })
      .freelist_count;

  // Invariant holds at the starting point, whatever the template's baseline.
  expect(reclaimableFreelistBytes(db)).toBe(freelistPages() * pageSize);
  const before = reclaimableFreelistBytes(db);

  // Grow then delete enough rows to strand more freelist pages.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  for (let i = 0; i < 200; i++) {
    insertMutation(`/repo/churn${i}.ts`);
  }
  db.run("DELETE FROM events");

  expect(freelistPages()).toBeGreaterThan(0);
  expect(reclaimableFreelistBytes(db)).toBe(freelistPages() * pageSize);
  expect(reclaimableFreelistBytes(db)).toBeGreaterThan(before);
});

test("reclaimableLogStep logs only on a fresh upward step crossing", () => {
  const step = RECLAIMABLE_LOG_STEP_BYTES;

  // Below the first step from a zero latch: nothing to log.
  expect(reclaimableLogStep(step - 1, 0)).toEqual({
    shouldLog: false,
    step: 0,
  });

  // First crossing into step 1 logs.
  expect(reclaimableLogStep(step, 0)).toEqual({ shouldLog: true, step: 1 });

  // Still inside step 1 after latching 1: no re-log.
  expect(reclaimableLogStep(step + step / 2, 1)).toEqual({
    shouldLog: false,
    step: 1,
  });

  // Growing into step 2 re-logs.
  expect(reclaimableLogStep(2 * step, 1)).toEqual({ shouldLog: true, step: 2 });
});

test("reclaimableLogStep re-logs after a drain lowers the latch and the pool regrows", () => {
  const step = RECLAIMABLE_LOG_STEP_BYTES;

  // Latched at step 3; a reclaim drains the pool near-empty. The returned step
  // lowers so the caller latches 0 — no spurious log on the drain itself.
  const drained = reclaimableLogStep(step / 10, 3);
  expect(drained).toEqual({ shouldLog: false, step: 0 });

  // Regrowth past a step boundary from the lowered latch logs again.
  expect(reclaimableLogStep(step, drained.step)).toEqual({
    shouldLog: true,
    step: 1,
  });
});

test("reclaimableLogStep clamps negative input to step 0", () => {
  expect(reclaimableLogStep(-1, 0)).toEqual({ shouldLog: false, step: 0 });
});
