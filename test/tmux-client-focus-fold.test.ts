/**
 * fn-952 — the `tmux_client_focus` LIVE-ONLY singleton fold. keeperd's persistent
 * `tmux -C` control worker (task .3) observes the current real tmux client's
 * focused session/window/pane and posts a `TmuxClientFocusSnapshot` event; the
 * reducer folds it last-write-wins into the `tmux_client_focus` singleton (id=1).
 *
 * This is the data-contract layer's fold test — it lands independently of the
 * producer (the table + fold exist with no real events). Pure in-process unit
 * tests over the migrated `:memory:` template (`freshMemDb`), seeding raw
 * `events` rows + driving the reducer's `drain`, mirroring the
 * `git-live-projection.test.ts` shard helpers.
 *
 * Coverage: zero-event default (empty singleton / `[focus: none]` semantics),
 * UPSERT idempotency + last-write-wins, and a malformed-payload no-op with the
 * cursor still advancing (the fold never throws).
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

let tsCounter = 7_000;

/** Minimal raw-event insert — the focus fold reads only `hook_event` + `data`. */
function insertEvent(hookEvent: string, data: string): number {
  const ts = tsCounter++;
  db.run(
    `INSERT INTO events (ts, session_id, pid, hook_event, event_type, cwd, data)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ts, "/repo", null, hookEvent, hookEvent, "/repo", data],
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

interface FocusRow {
  id: number;
  status: string | null;
  generation_id: string | null;
  session_name: string | null;
  window_index: number | null;
  pane_id: string | null;
  last_event_id: number | null;
  updated_at: number | null;
}

function focusRow(): FocusRow | null {
  return db
    .query("SELECT * FROM tmux_client_focus WHERE id = 1")
    .get() as FocusRow | null;
}

function cursor(): number {
  return (
    db.query("SELECT last_event_id FROM reducer_state WHERE id = 1").get() as {
      last_event_id: number;
    }
  ).last_event_id;
}

function focusData(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// Registry / DDL
// ---------------------------------------------------------------------------

test("tmux_client_focus is a registered LIVE_ONLY projection with the singleton CHECK(id=1) shape", () => {
  expect([...LIVE_ONLY_PROJECTIONS]).toContain("tmux_client_focus");

  const cols = (
    db.query("PRAGMA table_info(tmux_client_focus)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  expect(cols).toEqual([
    "id",
    "status",
    "generation_id",
    "session_name",
    "window_index",
    "pane_id",
    "last_event_id",
    "updated_at",
  ]);
});

test("zero-event default: a fresh DB has NO focus row (no floor/seed singleton) — the collection emits [focus: none]", () => {
  expect(focusRow()).toBeNull();
});

// ---------------------------------------------------------------------------
// Fold: UPSERT last-write-wins
// ---------------------------------------------------------------------------

test("a TmuxClientFocusSnapshot UPSERTs the id=1 singleton with the payload + event id/ts", () => {
  const eventId = insertEvent(
    "TmuxClientFocusSnapshot",
    focusData({
      status: "connected",
      generation_id: "98765",
      session_name: "work",
      window_index: 3,
      pane_id: "%12",
    }),
  );
  drainAll();

  const row = focusRow();
  expect(row).not.toBeNull();
  expect(row?.id).toBe(1);
  expect(row?.status).toBe("connected");
  expect(row?.generation_id).toBe("98765");
  expect(row?.session_name).toBe("work");
  expect(row?.window_index).toBe(3);
  expect(row?.pane_id).toBe("%12");
  expect(row?.last_event_id).toBe(eventId);
  // `updated_at` is the event ts (never wall-clock), so it equals the row's ts.
  const evTs = (
    db.query("SELECT ts FROM events WHERE id = ?").get(eventId) as {
      ts: number;
    }
  ).ts;
  expect(row?.updated_at).toBe(evTs);
});

test("last-write-wins: a later snapshot overwrites the singleton (never fill-only, never a second row)", () => {
  insertEvent(
    "TmuxClientFocusSnapshot",
    focusData({
      status: "connected",
      generation_id: "111",
      session_name: "alpha",
      window_index: 0,
      pane_id: "%1",
    }),
  );
  const secondId = insertEvent(
    "TmuxClientFocusSnapshot",
    focusData({
      status: "connected",
      generation_id: "222",
      session_name: "beta",
      window_index: 5,
      pane_id: "%9",
    }),
  );
  drainAll();

  const rows = db
    .query("SELECT * FROM tmux_client_focus ORDER BY id")
    .all() as FocusRow[];
  expect(rows.length).toBe(1);
  expect(rows[0].generation_id).toBe("222");
  expect(rows[0].session_name).toBe("beta");
  expect(rows[0].window_index).toBe(5);
  expect(rows[0].pane_id).toBe("%9");
  expect(rows[0].last_event_id).toBe(secondId);
});

test("a later snapshot OVERWRITES the location fields to NULL (a disconnected/no-focus snapshot is last-write-wins, not fill-only)", () => {
  insertEvent(
    "TmuxClientFocusSnapshot",
    focusData({
      status: "connected",
      generation_id: "333",
      session_name: "gamma",
      window_index: 2,
      pane_id: "%7",
    }),
  );
  // A disconnect: status carried, location fields cleared. The singleton must
  // reflect the NULLs (NOT preserve the prior focused pane).
  insertEvent(
    "TmuxClientFocusSnapshot",
    focusData({
      status: "disconnected",
      generation_id: null,
      session_name: null,
      window_index: null,
      pane_id: null,
    }),
  );
  drainAll();

  const row = focusRow();
  expect(row?.status).toBe("disconnected");
  expect(row?.generation_id).toBeNull();
  expect(row?.session_name).toBeNull();
  expect(row?.window_index).toBeNull();
  expect(row?.pane_id).toBeNull();
});

test("empty-string fields normalize to NULL (only a non-empty string is kept)", () => {
  insertEvent(
    "TmuxClientFocusSnapshot",
    focusData({
      status: "none",
      generation_id: "",
      session_name: "",
      window_index: 4,
      pane_id: "",
    }),
  );
  drainAll();

  const row = focusRow();
  expect(row?.status).toBe("none");
  expect(row?.generation_id).toBeNull();
  expect(row?.session_name).toBeNull();
  expect(row?.window_index).toBe(4);
  expect(row?.pane_id).toBeNull();
});

test("a non-integer window_index normalizes to NULL (never coerced)", () => {
  insertEvent(
    "TmuxClientFocusSnapshot",
    focusData({
      status: "connected",
      generation_id: "444",
      session_name: "delta",
      window_index: 2.5,
      pane_id: "%3",
    }),
  );
  drainAll();

  expect(focusRow()?.window_index).toBeNull();
});

// ---------------------------------------------------------------------------
// Fold: malformed payload no-ops, cursor still advances (never throws)
// ---------------------------------------------------------------------------

test("a malformed (non-JSON) payload no-ops the fold AND advances the cursor", () => {
  const eventId = insertEvent("TmuxClientFocusSnapshot", "not json {");
  const drained = drainAll();

  expect(drained).toBeGreaterThan(0);
  // No row written...
  expect(focusRow()).toBeNull();
  // ...but the cursor advanced past the malformed event.
  expect(cursor()).toBe(eventId);
});

test("an empty data blob no-ops the fold AND advances the cursor", () => {
  const eventId = insertEvent("TmuxClientFocusSnapshot", "");
  drainAll();

  expect(focusRow()).toBeNull();
  expect(cursor()).toBe(eventId);
});

test("a malformed snapshot AFTER a valid one leaves the prior singleton intact and advances the cursor", () => {
  insertEvent(
    "TmuxClientFocusSnapshot",
    focusData({
      status: "connected",
      generation_id: "555",
      session_name: "epsilon",
      window_index: 1,
      pane_id: "%5",
    }),
  );
  const badId = insertEvent("TmuxClientFocusSnapshot", "{ broken");
  drainAll();

  const row = focusRow();
  // The valid singleton survives — the malformed event did not wipe it.
  expect(row?.session_name).toBe("epsilon");
  expect(row?.pane_id).toBe("%5");
  // The cursor still advanced past the malformed event.
  expect(cursor()).toBe(badId);
});
