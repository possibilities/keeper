/**
 * Tab-namer worker tests (epic fn-680, reworked fn-699).
 *
 * Exercise the pure `runTick` + `readLiveJobsForTabNaming` +
 * `sanitizeTabName` symbols against a fresh writer DB seeded by direct
 * `INSERT INTO jobs`, with a stubbed `backend` carrying just the
 * `renameTab` slot so no real `zellij` ever spawns. The worker's
 * lifecycle (Worker thread, kick + `data_version` poll, parentPort
 * messaging) is exercised indirectly through these helpers — the same
 * shape the server-worker test uses.
 *
 * Coverage:
 *  - `sanitizeTabName`: strips control / ANSI bytes (incl. embedded ESC
 *    sequences), collapses whitespace, trims, strips a leading `-`,
 *    no length cap.
 *  - `readLiveJobsForTabNaming`: only jobs with session+tab_id+title set
 *    AND non-resting state surface; null fields and ended/killed jobs
 *    are filtered out; `backend_exec_pane_id` is selected.
 *  - `runTick`: renames UNCONDITIONALLY when the sanitized title differs
 *    from `backend_exec_tab_name`; the `SESSION::PANE_ID` memo suppresses
 *    a re-issue only in the post-write observe window; a `{ok:false}`
 *    return is NOT recorded in the memo (retried next tick).
 *  - `runTick`: a drift back to the zellij default after convergence
 *    re-fires the rename (the headline fn-699 fix), because the memo is
 *    cleared on observed convergence.
 *  - `runTick`: dedups by `(session, tab_id)` deterministically (lowest
 *    job_id wins) — invariant-violation cases degrade to stable-
 *    arbitrary, not oscillation.
 *  - `runTick`: empty sanitized title → no rename (never sends blank).
 *  - `runTick`: `isShuttingDown=true` between the read and the rename
 *    suppresses the call.
 *  - `runTick`: the memo prunes pane keys that left the live set
 *    (memory-bound).
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import type { ExecBackend, LaunchResult } from "../src/exec-backend";
import {
  readLiveJobsForTabNaming,
  runTick,
  sanitizeTabName,
} from "../src/tab-namer-worker";

let tmpDir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-tab-namer-worker-test-"));
  dbPath = join(tmpDir, "keeper.db");
  db = openDb(dbPath).db;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert one row into `jobs` with the per-test backend coords, title,
 * and lifecycle state. Defaults match a freshly-spawned working session
 * with a resolved tab. Keeps the per-row DEFAULTs the schema provides
 * for everything else; only the columns the tests touch are passed
 * explicitly.
 */
function insertJob(opts: {
  job_id: string;
  state?: string;
  backend_exec_session_id?: string | null;
  backend_exec_tab_id?: string | null;
  backend_exec_pane_id?: string | null;
  title?: string | null;
  backend_exec_tab_name?: string | null;
}): void {
  const state = opts.state ?? "working";
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at,
       backend_exec_session_id, backend_exec_tab_id, backend_exec_pane_id,
       title, backend_exec_tab_name
     ) VALUES (?, 1000, ?, 0, 1000, ?, ?, ?, ?, ?)`,
    [
      opts.job_id,
      state,
      opts.backend_exec_session_id ?? null,
      opts.backend_exec_tab_id ?? null,
      opts.backend_exec_pane_id ?? null,
      opts.title ?? null,
      opts.backend_exec_tab_name ?? null,
    ],
  );
}

interface RenameCall {
  session: string;
  tabId: string;
  name: string;
}

/**
 * Build an `ExecBackend`-shaped backend stub (only the slot `runTick`
 * actually reads — `renameTab`) that records each (session, tabId,
 * name) invocation into `calls` and returns the given default
 * `LaunchResult` (defaults to `{ ok: true }`).
 *
 * For tests that need per-call control, pass a `resolver` callback that
 * returns a `LaunchResult` per call.
 */
function makeBackendStub(
  calls: RenameCall[],
  resolver?: (call: RenameCall) => LaunchResult,
): Pick<ExecBackend, "renameTab"> {
  return {
    async renameTab(session, tabId, name) {
      const call = { session, tabId, name };
      calls.push(call);
      return resolver ? resolver(call) : ({ ok: true } as LaunchResult);
    },
  };
}

// ---------------------------------------------------------------------------
// sanitizeTabName
// ---------------------------------------------------------------------------

test("sanitizeTabName: passes a normal title through unchanged", () => {
  expect(sanitizeTabName("plan: add tab namer")).toBe("plan: add tab namer");
});

test("sanitizeTabName: strips C0 control bytes (newline, tab, ESC)", () => {
  const esc = String.fromCharCode(0x1b);
  const input = `hello\nworld\there${esc}[31mred${esc}[0m`;
  // C0 bytes become spaces, then whitespace-collapsed → single spaces.
  expect(sanitizeTabName(input)).toBe("hello world here [31mred [0m");
});

test("sanitizeTabName: strips DEL (0x7f)", () => {
  const del = String.fromCharCode(0x7f);
  expect(sanitizeTabName(`a${del}b`)).toBe("a b");
});

test("sanitizeTabName: collapses runs of whitespace", () => {
  expect(sanitizeTabName("  multiple   spaces\t\there  ")).toBe(
    "multiple spaces here",
  );
});

test("sanitizeTabName: strips leading `-` (clap-flag mitigation)", () => {
  expect(sanitizeTabName("-foo")).toBe("foo");
  expect(sanitizeTabName("--name=bar")).toBe("name=bar");
  expect(sanitizeTabName("   --weird")).toBe("weird");
});

test("sanitizeTabName: does NOT cap length — passes a long name through whole", () => {
  // zellij stores tab names of arbitrary length verbatim (verified
  // 0.44.3: a 112-char `rename-tab-by-id` round-trips byte-identical),
  // so keeper imposes NO length cap. A long title passes through with
  // only control/whitespace/leading-dash sanitization applied.
  const long = "x".repeat(120);
  expect(sanitizeTabName(long)).toBe(long);
});

test("sanitizeTabName: preserves the trailing task number on a long launch label (fn-635)", () => {
  // Regression for the fn-635 tab-name bug. The launch label
  // `work::fn-635-extract-planctl-into-standalone-repo.5` is 51 code
  // points — one over the OLD 50 cap, which dropped the final `5`, the
  // single character distinguishing one sibling task's tab from another's.
  // With the cap gone the full label, `.5` and all, passes through intact.
  const label = "work::fn-635-extract-planctl-into-standalone-repo.5";
  expect(sanitizeTabName(label)).toBe(label);
});

test("sanitizeTabName: passes a long emoji name through without splitting a surrogate pair", () => {
  // No cap means no slice, so there's no boundary to split — the full
  // run of emoji passes through unchanged (no lone surrogate / U+FFFD).
  const emojis = "🚀".repeat(60);
  const result = sanitizeTabName(emojis);
  expect(result).toBe(emojis);
  expect(result).not.toContain("�"); // no replacement char
});

test("sanitizeTabName: all-control input collapses to empty string", () => {
  const input = `${String.fromCharCode(0)}${String.fromCharCode(0x1b)}${String.fromCharCode(0x7f)}`;
  expect(sanitizeTabName(input)).toBe("");
});

test("sanitizeTabName: whitespace-only input collapses to empty string", () => {
  expect(sanitizeTabName("   \t\n  ")).toBe("");
});

// ---------------------------------------------------------------------------
// readLiveJobsForTabNaming
// ---------------------------------------------------------------------------

test("readLiveJobsForTabNaming: surfaces only jobs with session+tab_id+title set", () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "autopilot",
    backend_exec_tab_id: "3",
    backend_exec_pane_id: "p-a",
    title: "the title",
  });
  insertJob({
    job_id: "b",
    backend_exec_session_id: "autopilot",
    backend_exec_tab_id: "4",
    title: null, // missing title → filtered
  });
  insertJob({
    job_id: "c",
    backend_exec_session_id: "autopilot",
    backend_exec_tab_id: null, // missing tab_id → filtered (pane can resolve
    // before the tab, but rename targets the tab id)
    backend_exec_pane_id: "p-c",
    title: "x",
  });
  insertJob({
    job_id: "d",
    backend_exec_session_id: null, // missing session → filtered
    backend_exec_tab_id: "5",
    title: "x",
  });

  const rows = readLiveJobsForTabNaming(db);
  expect(rows.map((r) => r.job_id).sort()).toEqual(["a"]);
  // The pane id is selected for the convergence memo key.
  expect(rows[0]?.backend_exec_pane_id).toBe("p-a");
});

test("readLiveJobsForTabNaming: filters out ended / killed jobs", () => {
  for (const [state, jobId] of [
    ["working", "live"],
    ["stopped", "stopped"],
    ["ended", "ended"],
    ["killed", "killed"],
  ] as const) {
    insertJob({
      job_id: jobId,
      state,
      backend_exec_session_id: "autopilot",
      backend_exec_tab_id: "1",
      title: "x",
    });
  }
  const rows = readLiveJobsForTabNaming(db);
  expect(rows.map((r) => r.job_id).sort()).toEqual(["live", "stopped"]);
});

// ---------------------------------------------------------------------------
// runTick — rename, dedup, memo, drift, skip behavior
// ---------------------------------------------------------------------------

/** Memo key the worker uses for a row: `SESSION::PANE_ID`. */
function key(session: string, paneId: string): string {
  return `${session}::${paneId}`;
}

test("runTick: renames only when sanitized title differs from backend_exec_tab_name", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    title: "new title",
    backend_exec_tab_name: "old name",
  });
  // Already matches → skip.
  insertJob({
    job_id: "b",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "2",
    backend_exec_pane_id: "p2",
    title: "stable",
    backend_exec_tab_name: "stable",
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>();
  await runTick({
    db,
    backend,
    memo,
    isShuttingDown: () => false,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ session: "s", tabId: "1", name: "new title" });
  // The memo records the sent name keyed on SESSION::PANE_ID.
  expect(memo.get(key("s", "p1"))).toBe("new title");
  expect(memo.has(key("s", "p2"))).toBe(false);
});

test("runTick: memo suppresses a redundant re-issue in the post-write observe window", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    // tab_name still shows the old value (the feed hasn't observed the new
    // name back yet) → only the memo protects us from a re-issue.
    title: "new title",
    backend_exec_tab_name: "old name",
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>();

  // Tick 1: renames and records the memo.
  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(1);
  expect(memo.get(key("s", "p1"))).toBe("new title");

  // Tick 2: backend_exec_tab_name STILL shows "old name" (post-write observe
  // window — the feed hasn't reported the rename back yet) but the memo shows
  // we already issued "new title" → suppress.
  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(1); // unchanged
});

test("runTick: clears the memo on observed convergence (tab_name === sanitized)", async () => {
  // Pre-seed the memo as if we sent "title" on a prior tick; now the feed has
  // reported it back so tab_name matches. The tick must DELETE the memo entry
  // (so a later drift can re-fire) and issue no rename.
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    title: "title",
    backend_exec_tab_name: "title", // converged
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>([[key("s", "p1"), "title"]]);

  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toEqual([]);
  // Memo entry cleared on observed convergence.
  expect(memo.has(key("s", "p1"))).toBe(false);
});

test("runTick: a drift back to the zellij default after convergence re-fires the rename (fn-699)", async () => {
  // The headline fix. Converge, then simulate the tab drifting back to the
  // zellij default (`Tab #5`) after a resume; the renamer must re-assert.
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    title: "my session",
    backend_exec_tab_name: "old", // initial: needs a rename
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>();

  // Tick 1: rename to "my session", memo set.
  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("my session");
  expect(memo.get(key("s", "p1"))).toBe("my session");

  // Feed observes the rename back → convergence. A tick now clears the memo.
  db.run(
    "UPDATE jobs SET backend_exec_tab_name = 'my session' WHERE job_id = 'a'",
  );
  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(1); // no new rename
  expect(memo.has(key("s", "p1"))).toBe(false); // cleared on convergence

  // DRIFT: zellij resets the tab to its default on resume. The renamer must
  // re-converge — the old job-id `lastSet` model permanently suppressed this.
  db.run("UPDATE jobs SET backend_exec_tab_name = 'Tab #5' WHERE job_id = 'a'");
  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(2); // re-asserted
  expect(calls[1]?.name).toBe("my session");
  expect(memo.get(key("s", "p1"))).toBe("my session");
});

test("runTick: { ok: false } from the backend is NOT recorded in the memo (retried next tick)", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    title: "new title",
    backend_exec_tab_name: "old name",
  });

  const calls: RenameCall[] = [];
  let attempt = 0;
  const backend = makeBackendStub(calls, () => {
    attempt += 1;
    if (attempt === 1) {
      return { ok: false, error: "transient" };
    }
    return { ok: true };
  });
  const memo = new Map<string, string>();

  // Tick 1: backend returns failure → no memo write.
  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(1);
  expect(memo.has(key("s", "p1"))).toBe(false);

  // Tick 2: memo still empty → retry; this time success.
  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(2);
  expect(memo.get(key("s", "p1"))).toBe("new title");
});

test("runTick: skips a job whose sanitized title is empty", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    title: "   \n\t  ", // sanitizes to ""
    backend_exec_tab_name: "old name",
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>();

  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toEqual([]);
  expect(memo.has(key("s", "p1"))).toBe(false);
});

test("runTick: dedup by (session, tab_id) keeps the lowest job_id", async () => {
  // Two jobs sharing the same tab — invariant violation. Lowest
  // job_id wins so the cell degrades to stable-arbitrary.
  insertJob({
    job_id: "z-job",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "pz",
    title: "loser",
    backend_exec_tab_name: "old",
  });
  insertJob({
    job_id: "a-job",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "pa",
    title: "winner",
    backend_exec_tab_name: "old",
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>();

  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("winner");
  // memo is keyed SESSION::PANE_ID; only the winner's pane is recorded.
  expect(memo.get(key("s", "pa"))).toBe("winner");
  expect(memo.has(key("s", "pz"))).toBe(false);
});

test("runTick: distinct (session, tab) pairs each get one rename", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s1",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    title: "A",
    backend_exec_tab_name: "old",
  });
  insertJob({
    job_id: "b",
    backend_exec_session_id: "s1",
    backend_exec_tab_id: "2",
    backend_exec_pane_id: "p2",
    title: "B",
    backend_exec_tab_name: "old",
  });
  insertJob({
    job_id: "c",
    backend_exec_session_id: "s2",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p3",
    title: "C",
    backend_exec_tab_name: "old",
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>();

  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toHaveLength(3);
  expect(calls.map((c) => `${c.session}/${c.tabId}=${c.name}`).sort()).toEqual([
    "s1/1=A",
    "s1/2=B",
    "s2/1=C",
  ]);
});

test("runTick: isShuttingDown=true between read and rename suppresses the call", async () => {
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    title: "new title",
    backend_exec_tab_name: "old",
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>();

  await runTick({
    db,
    backend,
    memo,
    isShuttingDown: () => true, // already shut down
  });

  expect(calls).toEqual([]);
  expect(memo.has(key("s", "p1"))).toBe(false);
});

test("runTick: prunes the memo of pane keys that left the live set", async () => {
  insertJob({
    job_id: "still-live",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p-live",
    title: "T",
    backend_exec_tab_name: "old",
  });
  // The "p-dead" pane is NOT in the live set this tick (e.g. it ended
  // between ticks). Pre-seed the memo with it.
  const memo = new Map<string, string>([
    [key("s", "p-live"), "stale"],
    [key("s", "p-dead"), "old"],
  ]);

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);

  await runTick({ db, backend, memo, isShuttingDown: () => false });
  // "p-dead" pruned; "p-live" gets an updated memo entry.
  expect(memo.has(key("s", "p-dead"))).toBe(false);
  expect(memo.get(key("s", "p-live"))).toBe("T");
});

test("runTick: skips a job whose title only differs from tab_name AFTER sanitization", async () => {
  // The raw title has trailing whitespace; sanitized form matches
  // tab_name exactly → no rename.
  insertJob({
    job_id: "a",
    backend_exec_session_id: "s",
    backend_exec_tab_id: "1",
    backend_exec_pane_id: "p1",
    title: "  stable\t",
    backend_exec_tab_name: "stable",
  });

  const calls: RenameCall[] = [];
  const backend = makeBackendStub(calls);
  const memo = new Map<string, string>();

  await runTick({ db, backend, memo, isShuttingDown: () => false });
  expect(calls).toEqual([]);
});
