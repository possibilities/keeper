/**
 * Historical `events.mutation_path` backfill tests (fn-836.3, post-shed .4).
 *
 * Covers the task Acceptance:
 * - every historical mutation row whose inline `events.data` body yields a valid
 *   file_path gets `mutation_path` set (the fn-836.4 shed dropped `event_blobs`,
 *   so the backfill reads `events.data` only — relocated bodies no longer exist);
 * - the backfill is paced (bounded batches) and resumable via a crash-safe
 *   `meta` watermark — a second pass continues where the first stopped without
 *   re-scanning the backfilled prefix;
 * - idempotence: re-running a complete backfill is a no-op;
 * - the completion gate distinguishes "not yet backfilled" from a legitimate
 *   NULL (malformed / no file_path), and the backfilled column equals the
 *   guarded `json_extract` over `events.data` byte-for-byte.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKFILL_SELECT_BATCH_SQL,
  BACKFILL_WATERMARK_KEY,
  backfillMutationPath,
  isMutationPathBackfillComplete,
  readBackfillWatermark,
  runYieldingMutationPathBackfill,
} from "../src/backfill-mutation-path";
import {
  createMaintenanceTimeBudget,
  MAIN_MAINTENANCE_TICK_BUDGET_MS,
} from "../src/maintenance-budget";
import { freshMemDb } from "./helpers/template-db";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-backfill-test-"));
  db = freshMemDb().db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const SESS = "01234567-89ab-cdef-0123-456789abcdef";

let tsCounter = 1_000;

/**
 * Insert one raw event row WITHOUT `mutation_path` (column stays NULL) —
 * simulating a pre-deriver historical row the backfill must fill. Returns the
 * auto-assigned id.
 */
function insertEvent(overrides: {
  hook_event: string;
  session_id?: string;
  tool_name?: string | null;
  ts?: number;
  data?: string | null;
}): number {
  const ts = overrides.ts ?? tsCounter++;
  db.run(
    `INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ts,
      overrides.session_id ?? SESS,
      overrides.hook_event,
      overrides.hook_event,
      overrides.tool_name ?? null,
      overrides.data ?? "{}",
    ],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number })
    .id;
}

/** Insert a PostToolUse mutation row carrying `tool_input.file_path`. */
function insertMutation(filePath: string, tool = "Write"): number {
  return insertEvent({
    hook_event: "PostToolUse",
    tool_name: tool,
    data: JSON.stringify({ tool_input: { file_path: filePath } }),
  });
}

function mutationPathOf(id: number): string | null {
  return (
    db.query("SELECT mutation_path FROM events WHERE id = ?").get(id) as {
      mutation_path: string | null;
    }
  ).mutation_path;
}

test("readBackfillWatermark is 0 before any pass; advances after a pass", () => {
  insertMutation("/repo/a.ts");
  expect(readBackfillWatermark(db)).toBe(0);

  backfillMutationPath(db);
  const maxId = (
    db.query("SELECT MAX(id) AS m FROM events").get() as { m: number }
  ).m;
  expect(readBackfillWatermark(db)).toBe(maxId);
});

test("backfill batch selection seeks the primary key without sorting cold history", () => {
  const plan = db
    .query(`EXPLAIN QUERY PLAN ${BACKFILL_SELECT_BATCH_SQL}`)
    .all(0, 500) as Array<{ detail: string }>;
  const details = plan.map((row) => row.detail).join("\n");

  expect(details).toContain("USING INTEGER PRIMARY KEY");
  expect(details).not.toContain("TEMP B-TREE");
});

test("backfill fills mutation_path from inline events.data; non-mutation rows untouched", () => {
  const a = insertMutation("/repo/a.ts");
  const b = insertMutation("/repo/b.ts", "Edit");
  // A non-mutation row (Bash) and a non-PostToolUse row — both must stay NULL.
  const bash = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Bash",
    data: JSON.stringify({ tool_input: { command: "ls" } }),
  });
  const pre = insertEvent({
    hook_event: "PreToolUse",
    tool_name: "Write",
    data: JSON.stringify({ tool_input: { file_path: "/repo/pre.ts" } }),
  });

  const result = backfillMutationPath(db);
  expect(result.scanned).toBe(2); // only the two mutation rows are candidates

  expect(mutationPathOf(a)).toBe("/repo/a.ts");
  expect(mutationPathOf(b)).toBe("/repo/b.ts");
  expect(mutationPathOf(bash)).toBeNull();
  expect(mutationPathOf(pre)).toBeNull();
});

test("backfill is idempotent — a second complete pass is a no-op", () => {
  const a = insertMutation("/repo/a.ts");
  const b = insertMutation("/repo/b.ts");

  backfillMutationPath(db);
  expect(isMutationPathBackfillComplete(db)).toBe(true);

  // A second pass scans nothing new (every candidate already has a non-NULL
  // column AND sits below the watermark) and leaves the values intact.
  const second = backfillMutationPath(db);
  expect(second.scanned).toBe(0);
  expect(second.batches).toBe(0);
  expect(mutationPathOf(a)).toBe("/repo/a.ts");
  expect(mutationPathOf(b)).toBe("/repo/b.ts");
});

test("backfill is paced + resumable: a bounded pass stops, a watermark resumes the rest", () => {
  // 7 mutation rows; a pass capped at batchSize=2, maxBatches=2 processes 4 and
  // stops with `moreLikely`. The watermark persists across the (simulated)
  // restart, and a fresh pass finishes the remaining 3 — never re-touching the
  // first 4.
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) ids.push(insertMutation(`/repo/f${i}.ts`));

  const pass1 = backfillMutationPath(db, { batchSize: 2, maxBatches: 2 });
  expect(pass1.scanned).toBe(4);
  expect(pass1.batches).toBe(2);
  expect(pass1.moreLikely).toBe(true);
  expect(readBackfillWatermark(db)).toBe(ids[3]);
  // First 4 filled, last 3 still NULL.
  for (let i = 0; i < 4; i++)
    expect(mutationPathOf(ids[i] as number)).toBe(`/repo/f${i}.ts`);
  for (let i = 4; i < 7; i++)
    expect(mutationPathOf(ids[i] as number)).toBeNull();
  expect(isMutationPathBackfillComplete(db)).toBe(false);

  // Resume from the persisted watermark (a fresh module-level call mirrors a
  // daemon restart — it reads the watermark off `meta`, no in-memory state).
  const pass2 = backfillMutationPath(db, { batchSize: 2, maxBatches: 2 });
  expect(pass2.scanned).toBe(3);
  expect(readBackfillWatermark(db)).toBe(ids[6]);
  for (let i = 0; i < 7; i++)
    expect(mutationPathOf(ids[i] as number)).toBe(`/repo/f${i}.ts`);
  expect(isMutationPathBackfillComplete(db)).toBe(true);
});

test("wall-clock budget yields mutation-path backfill and the next tick resumes without repeats", async () => {
  const ids = Array.from({ length: 5 }, (_, i) =>
    insertMutation(`/repo/budget-${i}.ts`),
  );
  let now = 0;

  const firstTick = await runYieldingMutationPathBackfill(db, {
    batchSize: 2,
    maxBatches: 20,
    budget: createMaintenanceTimeBudget({ now: () => now }),
    yieldTurn: async () => {
      now += MAIN_MAINTENANCE_TICK_BUDGET_MS + 1;
    },
  });

  expect(firstTick?.scanned).toBe(2);
  expect(firstTick?.batches).toBe(1);
  expect(firstTick?.budgetExhausted).toBe(true);
  expect(readBackfillWatermark(db)).toBe(ids[1]);
  expect(ids.map(mutationPathOf)).toEqual([
    "/repo/budget-0.ts",
    "/repo/budget-1.ts",
    null,
    null,
    null,
  ]);

  now = 1_000;
  const secondTick = await runYieldingMutationPathBackfill(db, {
    batchSize: 2,
    maxBatches: 20,
    budget: createMaintenanceTimeBudget({ now: () => now }),
    yieldTurn: async () => {},
  });

  expect(secondTick?.scanned).toBe(3);
  expect(secondTick?.batches).toBe(2);
  expect(secondTick?.budgetExhausted).toBe(false);
  expect(readBackfillWatermark(db)).toBe(ids[4]);
  expect(ids.map(mutationPathOf)).toEqual(
    ids.map((_, i) => `/repo/budget-${i}.ts`),
  );
});

test("crash-safe watermark: a pre-set watermark skips the backfilled prefix", () => {
  // Simulate a crash that committed batch 1 (rows below the watermark) but lost
  // the in-memory result: pre-seed the watermark to id of the 2nd row, then run.
  // The first two rows are NOT re-scanned (their column stays whatever it was);
  // only rows above the watermark are processed.
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) ids.push(insertMutation(`/repo/g${i}.ts`));
  db.run(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [BACKFILL_WATERMARK_KEY, String(ids[1])],
  );

  const result = backfillMutationPath(db);
  // Only rows g2, g3 (above the watermark) were scanned.
  expect(result.scanned).toBe(2);
  expect(mutationPathOf(ids[0] as number)).toBeNull(); // skipped by watermark
  expect(mutationPathOf(ids[1] as number)).toBeNull(); // skipped by watermark
  expect(mutationPathOf(ids[2] as number)).toBe("/repo/g2.ts");
  expect(mutationPathOf(ids[3] as number)).toBe("/repo/g3.ts");
});

test("completion gate distinguishes legit-NULL (malformed / no file_path) from not-yet-backfilled", () => {
  // A mutation row whose body carries NO file_path: the column legitimately
  // stays NULL after backfill, and the gate must NOT count it as outstanding.
  const noPath = insertEvent({
    hook_event: "PostToolUse",
    tool_name: "Write",
    data: JSON.stringify({ tool_input: { content: "x" } }),
  });
  const withPath = insertMutation("/repo/h.ts");

  // Before any backfill the gate is FALSE — `withPath` owes a backfill (its
  // body yields a valid file_path the NULL column doesn't hold yet).
  expect(isMutationPathBackfillComplete(db)).toBe(false);

  backfillMutationPath(db);
  // After: `withPath` set, `noPath` correctly NULL — and the gate is TRUE
  // (the legit-NULL row does NOT keep it false).
  expect(mutationPathOf(withPath)).toBe("/repo/h.ts");
  expect(mutationPathOf(noPath)).toBeNull();
  expect(isMutationPathBackfillComplete(db)).toBe(true);
});

test("backfilled column equals the guarded json_extract over events.data byte-for-byte", () => {
  const id1 = insertMutation("/repo/one.ts", "MultiEdit");
  const id2 = insertMutation("/repo/two.ts", "NotebookEdit");

  backfillMutationPath(db);

  // Post-shed (fn-836.4) the column value must equal the guarded extract over the
  // INLINE `events.data` body — the exact predicate the post-flip scan reads (no
  // event_blobs side table to COALESCE).
  const rows = db
    .query(
      `SELECT e.id,
              e.mutation_path AS col,
              CASE WHEN json_valid(e.data)
                   THEN json_extract(e.data, '$.tool_input.file_path')
              END AS extracted
         FROM events e
        WHERE e.id IN (?, ?)`,
    )
    .all(id1, id2) as Array<{
    id: number;
    col: string | null;
    extracted: string | null;
  }>;
  expect(rows.length).toBe(2);
  for (const r of rows) {
    expect(r.col).toBe(r.extracted);
  }
});
