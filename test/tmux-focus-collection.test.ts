/**
 * fn-952 task .4 — the `tmux_client_focus` singleton collection + the `keeper
 * jobs` banner focus pill.
 *
 * Two seams, no real tmux:
 *
 *   1. Descriptor/projection round-trip — `TMUX_CLIENT_FOCUS_DESCRIPTOR` is
 *      registered and `runQuery` pages the singleton (`id = 1`). An empty / never-
 *      populated table serves `rows: []` (the no-tmux first-paint guarantee); a
 *      hand-seeded row round-trips every served column. This is the substrate the
 *      readiness client reads as `snap.tmuxFocus = byId.get(order[0])`.
 *   2. Banner composition — `renderTmuxFocusPill` × `renderDeadLetterPill` across
 *      the full focus-present/absent × dead-letter-present/absent matrix, driven
 *      by synthetic projection rows.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pill,
  renderDeadLetterPill,
  renderTmuxFocusPill,
} from "../src/board-render";
import {
  getCollection,
  REGISTRY,
  TMUX_CLIENT_FOCUS_DESCRIPTOR,
} from "../src/collections";
import { openDb } from "../src/db";
import type { ErrorFrame, ResultFrame } from "../src/protocol";
import { runQuery } from "../src/server-worker";
import { freshDbFile } from "./helpers/template-db";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-tmux-focus-test-"));
  dbPath = join(tmpDir, "keeper.db");
  freshDbFile(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Narrow a runQuery return to a ResultFrame, failing the test if it's an error. */
function asResult(frame: ResultFrame | ErrorFrame): ResultFrame {
  if (frame.type !== "result") {
    throw new Error(`expected result, got ${frame.type} (${frame.code})`);
  }
  return frame;
}

// ---------------------------------------------------------------------------
// Descriptor registration + shape
// ---------------------------------------------------------------------------

test("getCollection resolves the tmux_client_focus singleton (fn-952)", () => {
  expect(getCollection("tmux_client_focus")).toBe(TMUX_CLIENT_FOCUS_DESCRIPTOR);
  expect(REGISTRY.has("tmux_client_focus")).toBe(true);
  expect(TMUX_CLIENT_FOCUS_DESCRIPTOR.table).toBe("tmux_client_focus");
  // Singleton (`id = 1`): pk `id`, version `last_event_id` so the diff fires on
  // every fold (mirrors `autopilot_state`).
  expect(TMUX_CLIENT_FOCUS_DESCRIPTOR.pk).toBe("id");
  expect(TMUX_CLIENT_FOCUS_DESCRIPTOR.version).toBe("last_event_id");
  expect(TMUX_CLIENT_FOCUS_DESCRIPTOR.filters.id).toBe("id");
  expect(TMUX_CLIENT_FOCUS_DESCRIPTOR.defaultSort).toEqual({
    column: "id",
    dir: "asc",
  });
  // No JSON-decoded columns — every persisted field is a scalar.
  expect(TMUX_CLIENT_FOCUS_DESCRIPTOR.jsonColumns.size).toBe(0);
  // Columns cover every persisted field byte-for-byte against the CREATE TABLE.
  for (const col of [
    "id",
    "status",
    "generation_id",
    "session_name",
    "window_index",
    "pane_id",
    "last_event_id",
    "updated_at",
  ]) {
    expect(TMUX_CLIENT_FOCUS_DESCRIPTOR.columns).toContain(col);
  }
});

// ---------------------------------------------------------------------------
// runQuery round-trip (the snap.tmuxFocus substrate)
// ---------------------------------------------------------------------------

test("runQuery pages an empty tmux_client_focus singleton as rows:[] (no-tmux first-paint)", () => {
  // The table exists from migration but is never populated until a control
  // worker connects. A no-tmux env (or a worker that never connects) must serve
  // an empty collection without error so the readiness gate clears and `keeper
  // jobs` first-paints.
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  const res = asResult(
    runQuery(db, 0, { type: "query", collection: "tmux_client_focus" }),
  );
  expect(res.total).toBe(0);
  expect(res.rows).toEqual([]);
  db.close();
});

test("runQuery round-trips a seeded tmux_client_focus singleton with the served columns", () => {
  // Hand-insert the singleton (no reducer needed — the descriptor + runQuery
  // path is the unit under test). `byId.get(order[0])` in `subscribeReadiness`
  // reads exactly this wire row into `snap.tmuxFocus`.
  const { db } = openDb(dbPath, { readonly: false, migrate: false });
  db.query(
    `INSERT INTO tmux_client_focus (
       id, status, generation_id, session_name, window_index, pane_id,
       last_event_id, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("focused", "gen-7", "main", 3, "%9", 42, 1234.5);
  const res = asResult(
    runQuery(db, 42, { type: "query", collection: "tmux_client_focus" }),
  );
  expect(res.total).toBe(1);
  const row = res.rows[0];
  if (row == null) throw new Error("expected one tmux_client_focus row");
  expect(row.id).toBe(1);
  expect(row.status).toBe("focused");
  expect(row.generation_id).toBe("gen-7");
  expect(row.session_name).toBe("main");
  expect(row.window_index).toBe(3);
  expect(row.pane_id).toBe("%9");
  expect(row.last_event_id).toBe(42);
  // Served columns match the descriptor's column list exactly.
  expect(Object.keys(row).sort()).toEqual(
    [...TMUX_CLIENT_FOCUS_DESCRIPTOR.columns].sort(),
  );
  db.close();
});

// ---------------------------------------------------------------------------
// renderTmuxFocusPill — focus pill shape
// ---------------------------------------------------------------------------

test("renderTmuxFocusPill: a focused row renders `[focus <session>:<win> <pane_id>]`", () => {
  // `pane_id` already carries tmux's `%` prefix, so it renders verbatim.
  expect(
    renderTmuxFocusPill({
      status: "focused",
      session_name: "main",
      window_index: 3,
      pane_id: "%9",
    }),
  ).toBe("[focus main:3 %9]");
});

test("renderTmuxFocusPill: status 'none' / undefined / null all render `[focus: none]`", () => {
  expect(renderTmuxFocusPill({ status: "none" })).toBe("[focus: none]");
  expect(renderTmuxFocusPill(undefined)).toBe("[focus: none]");
  expect(renderTmuxFocusPill(null)).toBe("[focus: none]");
});

test("renderTmuxFocusPill: a focused row with missing location fields falls back to `[focus: none]`", () => {
  // Defensive against a malformed snapshot — a `focused` status with no
  // session/pane is not renderable.
  expect(renderTmuxFocusPill({ status: "focused", session_name: "main" })).toBe(
    "[focus: none]",
  );
  expect(renderTmuxFocusPill({ status: "focused", pane_id: "%9" })).toBe(
    "[focus: none]",
  );
});

test("renderTmuxFocusPill: a null window_index collapses the `:<win>` segment", () => {
  expect(
    renderTmuxFocusPill({
      status: "focused",
      session_name: "work",
      window_index: null,
      pane_id: "%2",
    }),
  ).toBe("[focus work %2]");
});

// ---------------------------------------------------------------------------
// Banner composition — focus × dead-letter (the 2×2 matrix)
// ---------------------------------------------------------------------------

/**
 * The composition `cli/jobs.ts:persistentBannerPill` performs: the focus pill is
 * ALWAYS present (`[focus: none]` floor); the dead-letter warn pill drops to "" on
 * an empty backlog. Mirrors the production join (focus first, dead-letter when
 * non-empty) so this asserts the same string the banner stamps.
 */
function composeBanner(
  focus: Parameters<typeof renderTmuxFocusPill>[0],
  deadLetterCount: number,
): string {
  const focusRaw = renderTmuxFocusPill(focus);
  const deadLetterRaw = renderDeadLetterPill(deadLetterCount);
  return deadLetterRaw === "" ? focusRaw : `${focusRaw} ${deadLetterRaw}`;
}

const FOCUSED = {
  status: "focused",
  session_name: "main",
  window_index: 3,
  pane_id: "%9",
} as const;

test("banner composition: focus present + dead-letter present → both pills, space-joined", () => {
  expect(composeBanner(FOCUSED, 2)).toBe(
    `[focus main:3 %9] ${pill("dead-letter:2")}`,
  );
});

test("banner composition: focus present + dead-letter absent → focus pill alone", () => {
  expect(composeBanner(FOCUSED, 0)).toBe("[focus main:3 %9]");
});

test("banner composition: focus absent + dead-letter present → `[focus: none]` + warn pill", () => {
  expect(composeBanner(undefined, 3)).toBe(
    `[focus: none] ${pill("dead-letter:3")}`,
  );
});

test("banner composition: focus absent + dead-letter absent → `[focus: none]` alone", () => {
  expect(composeBanner(undefined, 0)).toBe("[focus: none]");
});
