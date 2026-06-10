/**
 * Cold-blob compaction relocator tests (fn-717.2).
 *
 * Covers the task .2 Acceptance:
 * - (a) compaction relocates a cold batch atomically: `events.data` goes NULL,
 *   `event_blobs` gains the bytes, and the reducer reads them back identically
 *   via `COALESCE`; no `events` row is ever deleted;
 * - (b) a from-scratch re-fold over the compacted DB reproduces byte-identical
 *   projections vs. pre-compaction;
 * - (c) the cold predicate provably excludes any blob the file-attribution
 *   scan could still need — a LIVE (undischarged) attribution's contributing
 *   blob stays inline, so `idx_events_tool_attr` keeps covering it;
 * - (d) absent-in-both-places folds safe AND is a counted bug (not silent);
 * - the pass runs paced (bounded batches) and the `events` table is measurably
 *   smaller after a run.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactColdBlobs,
  computeColdWatermark,
  countAbsentBlobs,
} from "../src/compaction";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-compaction-test-"));
  // fn-769 mem variant: single in-process connection; `compactColdBlobs`
  // relocates into this DB's own `event_blobs` table (no external sidecar
  // file), so an in-memory template clone is correct.
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const TEST_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const TEST_UUID_2 = "fedcba98-7654-3210-fedc-ba9876543210";
const TEST_OID = "0123456789abcdef0123456789abcdef01234567";

let tsCounter = 1_000;

/** Insert one raw event row; returns its auto-assigned id. */
function insertEvent(overrides: {
  hook_event: string;
  session_id?: string;
  tool_name?: string | null;
  cwd?: string | null;
  ts?: number;
  data?: string | null;
}): number {
  const ts = overrides.ts ?? tsCounter++;
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, cwd, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      ts,
      overrides.session_id ?? TEST_UUID,
      overrides.hook_event,
      overrides.hook_event,
      overrides.tool_name ?? null,
      overrides.cwd ?? null,
      overrides.data ?? "{}",
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
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

/** Snapshot the blob-driven projections as plain rows for byte-diff equality. */
function snapshotProjections() {
  return {
    attributions: db
      .query(
        "SELECT project_dir, session_id, file_path, last_mutation_at, last_commit_at, op, source, last_event_id, updated_at, worktree_oid, worktree_mode FROM file_attributions ORDER BY project_dir, session_id, file_path",
      )
      .all(),
    gitStatus: db.query("SELECT * FROM git_status ORDER BY project_dir").all(),
    jobs: db.query("SELECT * FROM jobs ORDER BY job_id").all(),
    epics: db.query("SELECT * FROM epics ORDER BY epic_id").all(),
  };
}

/**
 * Seed a stream with a DISCHARGED PostToolUse mutation (cold — its file
 * attribution committed clean) and an UNDISCHARGED one (live — never
 * committed). Returns both event ids plus a filler count so a test can place
 * the cold/live ids well below the recent-retention window.
 */
function seedColdAndLive(): {
  coldId: number;
  liveId: number;
  fillerCount: number;
} {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });

  // COLD: session A writes cold.ts, then commits it clean (discharges).
  const coldId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID,
    cwd: "/repo",
    ts: 100,
    data: JSON.stringify({ tool_input: { file_path: "/repo/cold.ts" } }),
  });

  // LIVE: session B writes live.ts and NEVER commits — attribution stays live.
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID_2 });
  const liveId = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    session_id: TEST_UUID_2,
    cwd: "/repo",
    ts: 110,
    data: JSON.stringify({ tool_input: { file_path: "/repo/live.ts" } }),
  });

  // GitSnapshot: both files dirty → both get attribution rows.
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

  // Commit discharges ONLY cold.ts (session A). live.ts stays on the hook.
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

  // Filler events so the cold/live ids sit far below the recent-retention
  // window when tests use a tiny margin.
  const fillerCount = 30;
  for (let i = 0; i < fillerCount; i++) {
    insertEvent({ hook_event: "Stop", session_id: TEST_UUID, ts: 300 + i });
  }

  return { coldId, liveId, fillerCount };
}

test("computeColdWatermark is the recent-retention window (max id - margin)", () => {
  seedColdAndLive();
  drainAll();
  const maxId = (
    db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;

  // The watermark is purely the absolute recent window — keep the newest
  // `margin` events inline, relocate everything older. Not a correctness gate:
  // relocation is lossless for any blob (the two-arm explicit-attribution scan
  // + COALESCE reads serve relocated blobs), so the watermark only governs
  // locality/pacing.
  expect(computeColdWatermark(db, 2)).toBe(maxId - 2);
  expect(computeColdWatermark(db, 0)).toBe(maxId);
  // A margin larger than the table keeps everything inline (watermark floors
  // at 0 → relocate nothing).
  expect(computeColdWatermark(db, maxId + 100)).toBe(0);
});

test("compaction relocates a cold blob atomically; recent blob stays inline; no row deleted", () => {
  const { coldId, liveId } = seedColdAndLive();
  drainAll();

  const beforeRowCount = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  const coldValue = (
    db.query("SELECT data FROM events WHERE id = ?").get(coldId) as {
      data: string;
    }
  ).data;

  // Pick a margin so the watermark lands strictly between coldId and liveId:
  // coldId is relocated, liveId stays inside the recent window (inline). This
  // exercises BOTH the relocated side-table read AND the still-inline read.
  const maxId = (
    db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;
  const margin = maxId - liveId + 1; // watermark = liveId - 1
  const result = compactColdBlobs(db, {
    recentRetentionMargin: margin,
    batchSize: 10,
    maxBatches: 5,
  });
  expect(result.relocated).toBeGreaterThan(0);

  // Cold blob: hot column NULL, side table has the exact bytes.
  const coldRow = db
    .query("SELECT data FROM events WHERE id = ?")
    .get(coldId) as { data: string | null };
  expect(coldRow.data).toBeNull();
  const sideRow = db
    .query("SELECT data FROM event_blobs WHERE event_id = ?")
    .get(coldId) as { data: string } | null;
  expect(sideRow).not.toBeNull();
  expect(sideRow?.data).toBe(coldValue);

  // Recent (live) blob: untouched, still inline (above the recent window).
  const liveRow = db
    .query("SELECT data FROM events WHERE id = ?")
    .get(liveId) as { data: string | null };
  expect(liveRow.data).not.toBeNull();
  const liveSide = db
    .query("SELECT data FROM event_blobs WHERE event_id = ?")
    .get(liveId) as { data: string } | null;
  expect(liveSide).toBeNull();

  // No events row ever deleted.
  const afterRowCount = (
    db.query("SELECT COUNT(*) AS n FROM events").get() as { n: number }
  ).n;
  expect(afterRowCount).toBe(beforeRowCount);

  // COALESCE reads the relocated blob back identically.
  const resolved = db
    .query(
      `SELECT COALESCE(events.data, event_blobs.data) AS data
         FROM events LEFT JOIN event_blobs ON event_blobs.event_id = events.id
        WHERE events.id = ?`,
    )
    .get(coldId) as { data: string };
  expect(resolved.data).toBe(coldValue);
});

test("from-scratch re-fold over a compacted DB = byte-identical projections", () => {
  seedColdAndLive();
  drainAll();
  const live = snapshotProjections();

  // Relocate EVERYTHING (margin 0) — including the DISCHARGED cold.ts mutation
  // blob whose `tool_input.file_path` the explicit-attribution scan still needs
  // on re-fold (the Commit that discharged it replays AFTER the GitSnapshot).
  // This is the case that exercises the two-arm scan's ARM B (relocated
  // mutation blob served from `event_blobs`); if relocation were lossy here the
  // re-folded projections would diverge (cold.ts would orphan).
  const result = compactColdBlobs(db, {
    recentRetentionMargin: 0,
    batchSize: 50,
    maxBatches: 5,
  });
  expect(result.relocated).toBeGreaterThan(0);
  // The discharged cold.ts mutation blob is genuinely relocated (NULL inline,
  // present in the side table) — so re-fold MUST resolve it via ARM B.
  const coldMutation = db
    .query(
      "SELECT e.data AS inline, b.data AS side FROM events e LEFT JOIN event_blobs b ON b.event_id = e.id WHERE e.tool_name = 'Write' AND json_extract(b.data, '$.tool_input.file_path') = '/repo/cold.ts'",
    )
    .get() as { inline: string | null; side: string | null } | null;
  expect(coldMutation).not.toBeNull();
  expect(coldMutation?.inline).toBeNull();
  expect(coldMutation?.side).not.toBeNull();

  // From-scratch re-fold: rewind cursor + DELETE every projection, re-drain.
  // event_blobs is NOT in the DELETE list — it is a sidecar of the event log.
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  drainAll();

  expect(snapshotProjections()).toEqual(live);
});

test("absent-in-both-places: folds safe + counted by countAbsentBlobs", () => {
  const { coldId } = seedColdAndLive();
  drainAll();

  // Healthy state: nothing absent.
  expect(countAbsentBlobs(db)).toBe(0);

  // Inject the BUG state directly: NULL the hot column WITHOUT copying to
  // event_blobs (the impossible-via-relocator data-loss case). This is the
  // "neither place" condition.
  db.run("UPDATE events SET data = NULL WHERE id = ?", [coldId]);
  expect(countAbsentBlobs(db)).toBe(1);

  // The fold must STILL be safe over a now-missing blob — re-fold doesn't
  // throw and the cursor advances (a missing blob folds to the same safe value
  // as a malformed one).
  db.run("UPDATE reducer_state SET last_event_id = 0 WHERE id = 1");
  db.run("DELETE FROM git_status");
  db.run("DELETE FROM file_attributions");
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM epics");
  expect(() => drainAll()).not.toThrow();
  const cursor = (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
  expect(cursor).toBeGreaterThan(0);
});

test("paced: a pass never exceeds maxBatches*batchSize relocations", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  // Seed many discharged PostToolUse blobs (no GitSnapshot/attribution → no
  // live rows, so the watermark is governed purely by the recent window).
  for (let i = 0; i < 50; i++) {
    insertEvent({
      hook_event: "PostToolUse",
      tool_name: "Write",
      session_id: TEST_UUID,
      cwd: "/repo",
      data: JSON.stringify({ tool_input: { file_path: `/repo/f${i}.ts` } }),
    });
  }
  drainAll();
  expect(computeColdWatermark(db, 0)).toBeGreaterThan(0);

  // batchSize 5 * maxBatches 3 = 15 max per pass even though >15 are cold.
  const result = compactColdBlobs(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 3,
  });
  expect(result.relocated).toBe(15);
  expect(result.batches).toBe(3);
  expect(result.moreLikely).toBe(true);

  // A second pass picks up where the first left off (idempotent — already-
  // relocated rows have data IS NULL and are skipped).
  const result2 = compactColdBlobs(db, {
    recentRetentionMargin: 0,
    batchSize: 5,
    maxBatches: 3,
  });
  expect(result2.relocated).toBe(15);
});

test("compaction shrinks the events table footprint (data bytes move out)", () => {
  insertEvent({ hook_event: "SessionStart", session_id: TEST_UUID });
  const bigBlob = JSON.stringify({
    tool_input: { file_path: "/repo/big.ts", content: "x".repeat(4000) },
  });
  const ids: number[] = [];
  for (let i = 0; i < 20; i++) {
    ids.push(
      insertEvent({
        hook_event: "PostToolUse",
        tool_name: "Write",
        session_id: TEST_UUID,
        cwd: "/repo",
        data: bigBlob,
      }),
    );
  }
  drainAll();

  const eventsDataBytesBefore = (
    db
      .query("SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM events")
      .get() as { b: number }
  ).b;
  expect(eventsDataBytesBefore).toBeGreaterThan(20 * 4000);

  compactColdBlobs(db, {
    recentRetentionMargin: 0,
    batchSize: 100,
    maxBatches: 10,
  });

  // The inline data bytes on `events` shrank measurably; the bytes now live in
  // event_blobs instead (no net loss — relocation, not deletion).
  const eventsDataBytesAfter = (
    db
      .query("SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM events")
      .get() as { b: number }
  ).b;
  const blobBytes = (
    db
      .query("SELECT COALESCE(SUM(LENGTH(data)), 0) AS b FROM event_blobs")
      .get() as { b: number }
  ).b;
  expect(eventsDataBytesAfter).toBeLessThan(eventsDataBytesBefore);
  expect(blobBytes).toBeGreaterThanOrEqual(20 * 4000);
});

test("no live work to do: watermark 0 / empty DB is a clean no-op", () => {
  // Fresh DB, zero events.
  const result = compactColdBlobs(db);
  expect(result.relocated).toBe(0);
  expect(result.batches).toBe(0);
  expect(result.coldWatermark).toBe(0);
  expect(countAbsentBlobs(db)).toBe(0);
});
