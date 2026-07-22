/**
 * fn-1013 — the `worktree_repo_status` LIVE-ONLY operator-surface fold. The
 * autopilot reconciler posts a `WorktreeRepoStatus` event carrying the FULL
 * current worktree-disabled set (one entry per epic whose repo the eligibility
 * heuristic downgraded to `disabled` → serial shared-checkout dispatch); the
 * reducer folds it as a full-set REPLACE into the `worktree_repo_status` table.
 *
 * This is the data-contract layer's fold test — it lands independently of the
 * producer (the table + fold exist with no real events). Pure in-process unit
 * tests over the migrated `:memory:` template (`freshMemDb`), seeding raw
 * `events` rows + driving the reducer's `drain`, mirroring the
 * `tmux-client-focus-fold.test.ts` shard helpers.
 *
 * Coverage: registry membership (LIVE-ONLY, NOT deterministic-replayed),
 * zero-event default (empty table), full-set replace + last-write-wins, an
 * empty-set clear, a malformed-payload no-op (table cleared, cursor still
 * advancing — the fold never throws), and the `rewindLiveProjection`-shaped wipe.
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

interface StatusRow {
  epic_id: string;
  repo_dir: string;
  mode: string;
  reason: string;
  last_event_id: number | null;
  updated_at: number | null;
}

function statusRows(): StatusRow[] {
  return db
    .query("SELECT * FROM worktree_repo_status ORDER BY epic_id")
    .all() as StatusRow[];
}

function cursor(): number {
  return (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
}

function statusData(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ entries });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("worktree_repo_status is a registered LIVE_ONLY projection (NOT deterministic-replayed)", () => {
  expect([...LIVE_ONLY_PROJECTIONS]).toContain("worktree_repo_status");
  // The DDL exists in the migrated schema (registry stays in sync).
  const cols = (
    db.query("PRAGMA table_info(worktree_repo_status)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(cols).toEqual([
    "epic_id",
    "repo_dir",
    "mode",
    "reason",
    "last_event_id",
    "updated_at",
  ]);
});

test("the migrated schema keys worktree_repo_status on the composite (epic_id, repo_dir) PK (fn-28 part 4a)", () => {
  // A CLUSTERED epic may downgrade more than one repo group, so the identity is
  // per-(epic, repo), not per-epic. `pk` (ordinal) 1 = epic_id, 2 = repo_dir.
  const pk = (
    db.query("PRAGMA table_info(worktree_repo_status)").all() as {
      name: string;
      pk: number;
    }[]
  )
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  expect(pk).toEqual(["epic_id", "repo_dir"]);
});

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

test("zero-event default: an empty log leaves worktree_repo_status empty", () => {
  drainAll();
  expect(statusRows()).toEqual([]);
});

test("a WorktreeRepoStatus event folds one row per disabled epic", () => {
  const id = insertEvent(
    "WorktreeRepoStatus",
    statusData([
      {
        epic_id: "fn-2-mono",
        repo_dir: "/code/arthack",
        mode: "serial",
        reason: "worktree-disabled:workspace-marker:pnpm-workspace",
      },
      {
        epic_id: "fn-3-cargo",
        repo_dir: "/code/zellijsub",
        mode: "serial",
        reason: "worktree-disabled:workspace-marker:cargo-workspace",
      },
    ]),
  );
  drainAll();

  const rows = statusRows();
  expect(rows.map((r) => r.epic_id)).toEqual(["fn-2-mono", "fn-3-cargo"]);
  expect(rows[0]?.repo_dir).toBe("/code/arthack");
  expect(rows[0]?.reason).toBe(
    "worktree-disabled:workspace-marker:pnpm-workspace",
  );
  expect(rows[0]?.mode).toBe("serial");
  expect(rows[0]?.last_event_id).toBe(id);
});

test("two SAME-epic / different-repo entries BOTH survive under the composite PK (fn-28 part 4a)", () => {
  // A clustered epic downgrading two of its repo groups posts two entries with the
  // SAME epic_id — the composite `(epic_id, repo_dir)` PK keeps them independent
  // (the old per-epic PK would UPSERT the second over the first, losing a sibling).
  insertEvent(
    "WorktreeRepoStatus",
    statusData([
      {
        epic_id: "fn-1-clust",
        repo_dir: "/repo-a",
        reason: "worktree-disabled:submodules",
      },
      {
        epic_id: "fn-1-clust",
        repo_dir: "/repo-b",
        reason: "worktree-reopen-serial: /repo-b …",
      },
    ]),
  );
  drainAll();
  const rows = db
    .query(
      "SELECT epic_id, repo_dir, reason FROM worktree_repo_status ORDER BY epic_id, repo_dir",
    )
    .all() as { epic_id: string; repo_dir: string; reason: string }[];
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.repo_dir)).toEqual(["/repo-a", "/repo-b"]);
  expect(rows[0]?.reason).toBe("worktree-disabled:submodules");
  expect(rows[1]?.reason).toBe("worktree-reopen-serial: /repo-b …");
});

test("full-set REPLACE: a later event wholly replaces the prior set (stale epics drop)", () => {
  insertEvent(
    "WorktreeRepoStatus",
    statusData([
      { epic_id: "fn-2-mono", repo_dir: "/code/arthack", reason: "r1" },
      { epic_id: "fn-3-cargo", repo_dir: "/code/zellijsub", reason: "r2" },
    ]),
  );
  drainAll();
  expect(statusRows()).toHaveLength(2);

  // A later cycle: fn-3 flipped back to eligible, fn-2 reason refined.
  insertEvent(
    "WorktreeRepoStatus",
    statusData([
      { epic_id: "fn-2-mono", repo_dir: "/code/arthack", reason: "r1b" },
    ]),
  );
  drainAll();

  const rows = statusRows();
  expect(rows.map((r) => r.epic_id)).toEqual(["fn-2-mono"]);
  expect(rows[0]?.reason).toBe("r1b");
});

test("an empty-set event clears the table (worktree mode OFF / no disabled epics)", () => {
  insertEvent(
    "WorktreeRepoStatus",
    statusData([{ epic_id: "fn-2-mono", repo_dir: "/r", reason: "r" }]),
  );
  drainAll();
  expect(statusRows()).toHaveLength(1);

  insertEvent("WorktreeRepoStatus", statusData([]));
  drainAll();
  expect(statusRows()).toEqual([]);
});

test("malformed payload folds to a table-clearing no-op; the cursor still advances (never throws)", () => {
  insertEvent(
    "WorktreeRepoStatus",
    statusData([{ epic_id: "fn-2-mono", repo_dir: "/r", reason: "r" }]),
  );
  drainAll();
  expect(statusRows()).toHaveLength(1);

  // Garbage blob — extractor returns [], fold clears the table.
  const badId = insertEvent("WorktreeRepoStatus", "{not json");
  drainAll();
  expect(statusRows()).toEqual([]);
  expect(cursor()).toBe(badId);
});

test("an entry missing epic_id is dropped (the PK must be present)", () => {
  insertEvent(
    "WorktreeRepoStatus",
    statusData([
      { repo_dir: "/r", reason: "no-pk" },
      { epic_id: "fn-2-mono", repo_dir: "/r2", reason: "ok" },
    ]),
  );
  drainAll();
  expect(statusRows().map((r) => r.epic_id)).toEqual(["fn-2-mono"]);
});

// ---------------------------------------------------------------------------
// Live-only rewind
// ---------------------------------------------------------------------------

test("rewindLiveProjection-shaped wipe clears worktree_repo_status (it is in LIVE_ONLY_PROJECTIONS)", () => {
  insertEvent(
    "WorktreeRepoStatus",
    statusData([{ epic_id: "fn-2-mono", repo_dir: "/r", reason: "r" }]),
  );
  drainAll();
  expect(statusRows()).toHaveLength(1);

  // The production rewind loops over LIVE_ONLY_PROJECTIONS DELETEing each table.
  for (const table of LIVE_ONLY_PROJECTIONS) db.run(`DELETE FROM ${table}`);
  expect(statusRows()).toEqual([]);
});
