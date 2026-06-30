/**
 * fn-1016 — the `lane_merged` LIVE-ONLY merge-landed-observable fold. The autopilot
 * reconciler posts a `LaneMerged` event carrying the FULL current merged-lane set
 * (one entry per `ok` epic whose lane `keeper/epic/<id>` is merged into LOCAL
 * default); the reducer folds it as a full-set REPLACE into the `lane_merged` table.
 *
 * This is the data-contract layer's fold test — it lands independently of the
 * producer (the table + fold exist with no real events). Pure in-process unit tests
 * over the migrated `:memory:` template (`freshMemDb`), seeding raw `events` rows +
 * driving the reducer's `drain`, mirroring `worktree-repo-status-fold.test.ts`.
 *
 * Coverage: registry membership (LIVE-ONLY, NOT deterministic-replayed), zero-event
 * default (empty table), full-set replace + last-write-wins, an empty-set clear, a
 * malformed-payload no-op (table cleared, cursor still advancing — the fold never
 * throws), a missing-pk drop, and the `rewindLiveProjection`-shaped wipe.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LIVE_ONLY_PROJECTIONS } from "../src/db";
import { drain } from "../src/reducer";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
});

let tsCounter = 9_000;

/** Minimal raw-event insert — the fold reads only `hook_event` + `data`. */
function insertEvent(hookEvent: string, data: string): number {
  const ts = tsCounter++;
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ts, "reconciler", null, hookEvent, hookEvent, null, data],
  );
  return Number(
    (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
  );
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

interface MergedRow {
  epic_id: string;
  repo_dir: string;
  last_event_id: number | null;
  updated_at: number | null;
}

function mergedRows(): MergedRow[] {
  return db
    .query("SELECT * FROM lane_merged ORDER BY epic_id")
    .all() as MergedRow[];
}

function cursor(): number {
  return (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
}

function mergedData(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ entries });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("lane_merged is a registered LIVE_ONLY projection (NOT deterministic-replayed)", () => {
  expect([...LIVE_ONLY_PROJECTIONS]).toContain("lane_merged");
  // The DDL exists in the migrated schema (registry stays in sync).
  const cols = (
    db.query("PRAGMA table_info(lane_merged)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(cols).toEqual(["epic_id", "repo_dir", "last_event_id", "updated_at"]);
});

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

test("zero-event default: an empty log leaves lane_merged empty", () => {
  drainAll();
  expect(mergedRows()).toEqual([]);
});

test("a LaneMerged event folds one row per merged-lane epic", () => {
  const id = insertEvent(
    "LaneMerged",
    mergedData([
      { epic_id: "fn-1-a", repo_dir: "/code/keeper" },
      { epic_id: "fn-2-b", repo_dir: "/code/keeper" },
    ]),
  );
  drainAll();

  const rows = mergedRows();
  expect(rows.map((r) => r.epic_id)).toEqual(["fn-1-a", "fn-2-b"]);
  expect(rows[0]?.repo_dir).toBe("/code/keeper");
  expect(rows[0]?.last_event_id).toBe(id);
});

test("full-set REPLACE: a later event wholly replaces the prior set (stale epics drop)", () => {
  insertEvent(
    "LaneMerged",
    mergedData([
      { epic_id: "fn-1-a", repo_dir: "/r" },
      { epic_id: "fn-2-b", repo_dir: "/r" },
    ]),
  );
  drainAll();
  expect(mergedRows()).toHaveLength(2);

  // A later cycle: fn-2-b's lane is now the only one tracked (fn-1-a torn down +
  // reaped from the board, so it drops out of the emitted set).
  insertEvent(
    "LaneMerged",
    mergedData([{ epic_id: "fn-2-b", repo_dir: "/r" }]),
  );
  drainAll();

  const rows = mergedRows();
  expect(rows.map((r) => r.epic_id)).toEqual(["fn-2-b"]);
});

test("an empty-set event clears the table (worktree mode OFF / no merged lanes)", () => {
  insertEvent(
    "LaneMerged",
    mergedData([{ epic_id: "fn-1-a", repo_dir: "/r" }]),
  );
  drainAll();
  expect(mergedRows()).toHaveLength(1);

  insertEvent("LaneMerged", mergedData([]));
  drainAll();
  expect(mergedRows()).toEqual([]);
});

test("malformed payload folds to a table-clearing no-op; the cursor still advances (never throws)", () => {
  insertEvent(
    "LaneMerged",
    mergedData([{ epic_id: "fn-1-a", repo_dir: "/r" }]),
  );
  drainAll();
  expect(mergedRows()).toHaveLength(1);

  // Garbage blob — extractor returns [], fold clears the table.
  const badId = insertEvent("LaneMerged", "{not json");
  drainAll();
  expect(mergedRows()).toEqual([]);
  expect(cursor()).toBe(badId);
});

test("an entry missing epic_id is dropped (the PK must be present)", () => {
  insertEvent(
    "LaneMerged",
    mergedData([{ repo_dir: "/r" }, { epic_id: "fn-1-a", repo_dir: "/r2" }]),
  );
  drainAll();
  expect(mergedRows().map((r) => r.epic_id)).toEqual(["fn-1-a"]);
});

// ---------------------------------------------------------------------------
// Live-only rewind
// ---------------------------------------------------------------------------

test("rewindLiveProjection-shaped wipe clears lane_merged (it is in LIVE_ONLY_PROJECTIONS)", () => {
  insertEvent(
    "LaneMerged",
    mergedData([{ epic_id: "fn-1-a", repo_dir: "/r" }]),
  );
  drainAll();
  expect(mergedRows()).toHaveLength(1);

  // The production rewind loops over LIVE_ONLY_PROJECTIONS DELETEing each table.
  for (const table of LIVE_ONLY_PROJECTIONS) db.run(`DELETE FROM ${table}`);
  expect(mergedRows()).toEqual([]);
});
