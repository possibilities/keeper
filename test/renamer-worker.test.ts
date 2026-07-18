/**
 * tmux window-renamer worker tests (epic fn-801 task .2).
 *
 * Exercise the pure decision symbols — `renameCandidates`, `hashCandidates`,
 * `computeRenames` — and the `renamerPulse` orchestration against a fresh
 * in-memory writer DB seeded by direct `INSERT INTO jobs`, with INJECTED fake
 * pane ops (`listPanes`/`renameWindow`; no real tmux, no Worker spawn). The worker's lifecycle
 * (Worker thread, watchLoop, parentPort) is NOT spawned — the `isMainThread`
 * guard keeps the plain `import` inert, the same shape every other worker test
 * uses. Worker lifecycle is covered by the daemon ALL_WORKERS pin + test:full.
 *
 * Coverage:
 *  - winner selection: latest `created_at` wins; `job_id` breaks the tie.
 *  - mismatch filter: a window already named its winning title is NOT renamed.
 *  - exclusion: NULL pane, empty title, non-tmux backend, dead state drop.
 *  - dedup hash: an unchanged candidate picture skips the tmux sweep entirely.
 *  - empty-candidate quiescence: zero candidates never sweeps tmux.
 *  - degraded tmux: a `null` sweep skips the cycle WITHOUT advancing the gate.
 *  - TOCTOU: a `renameWindow` failure is a non-fatal skip; the pulse resolves.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import type { LaunchResult, PaneInfo, TmuxPaneOps } from "../src/exec-backend";
import {
  computeRenames,
  hashCandidates,
  type RenameCandidate,
  renameCandidates,
  renamerPulse,
} from "../src/renamer-worker";
import type { Job } from "../src/types";
import { freshMemDb } from "./helpers/template-db";

let db: Database;

beforeEach(() => {
  // fn-769 mem variant: a single in-process connection (no second opener, no
  // spawned Worker), so an in-memory clone of the migrated template is correct.
  db = freshMemDb().db;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert one `jobs` row with only the columns the rename decision reads.
 * Defaults match a freshly-spawned live tmux session with a pane + title.
 */
function insertJob(opts: {
  job_id: string;
  state?: string;
  created_at?: number;
  title?: string | null;
  backend_exec_type?: string | null;
  backend_exec_pane_id?: string | null;
}): void {
  db.run(
    `INSERT INTO jobs (
       job_id, created_at, state, last_event_id, updated_at,
       title, backend_exec_type, backend_exec_pane_id
     ) VALUES (?, ?, ?, 0, 1000, ?, ?, ?)`,
    [
      opts.job_id,
      opts.created_at ?? 1000,
      opts.state ?? "working",
      opts.title ?? null,
      opts.backend_exec_type ?? "tmux",
      opts.backend_exec_pane_id ?? null,
    ],
  );
}

/** Build a `RenameCandidate` with sensible defaults for the pure decision fns. */
function candidate(
  opts: Partial<RenameCandidate> & { pane_id: string },
): RenameCandidate {
  return {
    job_id: opts.job_id ?? "job",
    pane_id: opts.pane_id,
    title: opts.title ?? "title",
    created_at: opts.created_at ?? 1000,
  };
}

/**
 * Fake pane ops recording `renameWindow` calls. Shrunk to the kept subset
 * `renamerPulse` consumes — `Pick<TmuxPaneOps, "listPanes" | "renameWindow">`;
 * a broad ExecBackend-shaped fake would structurally mask a real gap.
 */
function fakeBackend(opts: {
  panes: PaneInfo[] | null;
  renameResult?: (windowId: string, name: string) => LaunchResult;
}): {
  backend: Pick<TmuxPaneOps, "listPanes" | "renameWindow">;
  listPanesCalls: number;
  renameCalls: { windowId: string; name: string }[];
} {
  const tracker = {
    listPanesCalls: 0,
    renameCalls: [] as { windowId: string; name: string }[],
  };
  const backend: Pick<TmuxPaneOps, "listPanes" | "renameWindow"> = {
    listPanes: async (): Promise<PaneInfo[] | null> => {
      tracker.listPanesCalls += 1;
      return opts.panes;
    },
    renameWindow: async (
      windowId: string,
      name: string,
    ): Promise<LaunchResult> => {
      tracker.renameCalls.push({ windowId, name });
      return opts.renameResult
        ? opts.renameResult(windowId, name)
        : { ok: true };
    },
  };
  return {
    backend,
    get listPanesCalls() {
      return tracker.listPanesCalls;
    },
    renameCalls: tracker.renameCalls,
  };
}

const pane = (
  paneId: string,
  windowId: string,
  windowName: string,
): PaneInfo => ({
  paneId,
  windowId,
  currentCommand: "zsh",
  // The renamer never reads these fields; fixed placeholders keep the sweep
  // shape complete so PaneInfo type-checks.
  tmuxGenerationId: "gen",
  paneDead: "0",
  sessionName: "autopilot",
  windowName,
});

// ---------------------------------------------------------------------------
// renameCandidates — the projection filter
// ---------------------------------------------------------------------------

test("renameCandidates keeps only live tmux jobs with a pane and a title", () => {
  const jobs: Job[] = [
    // kept: working tmux job with pane + title
    {
      state: "working",
      backend_exec_type: "tmux",
      backend_exec_pane_id: "%1",
      title: "alpha",
      job_id: "a",
      created_at: 1,
    } as Job,
    // kept: stopped is live
    {
      state: "stopped",
      backend_exec_type: "tmux",
      backend_exec_pane_id: "%2",
      title: "beta",
      job_id: "b",
      created_at: 2,
    } as Job,
    // dropped: dead state
    {
      state: "ended",
      backend_exec_type: "tmux",
      backend_exec_pane_id: "%3",
      title: "g",
      job_id: "c",
      created_at: 3,
    } as Job,
    {
      state: "killed",
      backend_exec_type: "tmux",
      backend_exec_pane_id: "%4",
      title: "g",
      job_id: "d",
      created_at: 4,
    } as Job,
    // dropped: non-tmux backend
    {
      state: "working",
      backend_exec_type: null,
      backend_exec_pane_id: "%5",
      title: "g",
      job_id: "e",
      created_at: 5,
    } as Job,
    // dropped: NULL pane
    {
      state: "working",
      backend_exec_type: "tmux",
      backend_exec_pane_id: null,
      title: "g",
      job_id: "f",
      created_at: 6,
    } as Job,
    // dropped: empty title
    {
      state: "working",
      backend_exec_type: "tmux",
      backend_exec_pane_id: "%7",
      title: "",
      job_id: "g",
      created_at: 7,
    } as Job,
    // dropped: NULL title
    {
      state: "working",
      backend_exec_type: "tmux",
      backend_exec_pane_id: "%8",
      title: null,
      job_id: "h",
      created_at: 8,
    } as Job,
  ];
  const out = renameCandidates(jobs);
  expect(out.map((c) => c.job_id)).toEqual(["a", "b"]);
  expect(out[0]).toEqual({
    job_id: "a",
    pane_id: "%1",
    title: "alpha",
    created_at: 1,
  });
});

// ---------------------------------------------------------------------------
// hashCandidates — the input-side dedup gate
// ---------------------------------------------------------------------------

test("hashCandidates is order-independent and reacts to title/pane changes", () => {
  const a = candidate({
    pane_id: "%1",
    job_id: "a",
    title: "x",
    created_at: 1,
  });
  const b = candidate({
    pane_id: "%2",
    job_id: "b",
    title: "y",
    created_at: 2,
  });
  // SELECT-order shuffle hashes identically.
  expect(hashCandidates([a, b])).toBe(hashCandidates([b, a]));
  // A title change re-fires the gate.
  expect(hashCandidates([a])).not.toBe(hashCandidates([{ ...a, title: "z" }]));
  // Moving the job to another pane also re-fires the gate.
  expect(hashCandidates([a])).not.toBe(
    hashCandidates([{ ...a, pane_id: "%3" }]),
  );
  // Empty set is stable (the quiescent-board hash).
  expect(hashCandidates([])).toBe(hashCandidates([]));
});

// ---------------------------------------------------------------------------
// computeRenames — the pure rename decision
// ---------------------------------------------------------------------------

test("computeRenames: latest created_at wins, target is the winner's title", () => {
  const older = candidate({
    pane_id: "%1",
    job_id: "a",
    title: "old",
    created_at: 100,
  });
  const newer = candidate({
    pane_id: "%2",
    job_id: "b",
    title: "new",
    created_at: 200,
  });
  const panes = [pane("%1", "@1", "stale"), pane("%2", "@1", "stale")];
  expect(computeRenames([older, newer], panes)).toEqual([
    { windowId: "@1", name: "new" },
  ]);
});

test("computeRenames: created_at tie breaks on higher job_id", () => {
  const lo = candidate({
    pane_id: "%1",
    job_id: "aaa",
    title: "lo",
    created_at: 100,
  });
  const hi = candidate({
    pane_id: "%2",
    job_id: "bbb",
    title: "hi",
    created_at: 100,
  });
  const panes = [pane("%1", "@1", "stale"), pane("%2", "@1", "stale")];
  expect(computeRenames([lo, hi], panes)).toEqual([
    { windowId: "@1", name: "hi" },
  ]);
});

test("computeRenames: a window already named its winner is NOT re-renamed", () => {
  const c = candidate({
    pane_id: "%1",
    job_id: "a",
    title: "match",
    created_at: 100,
  });
  const panes = [pane("%1", "@1", "match")];
  expect(computeRenames([c], panes)).toEqual([]);
});

test("computeRenames: a spawn-name `::`/`.` title tabs verbatim, and is not re-renamed once worn", () => {
  const c = candidate({
    pane_id: "%1",
    job_id: "a",
    title: "work::fn-1019.2",
    created_at: 100,
  });
  // Fresh window: the title lands verbatim — tmux accepts `:` and `.` in a
  // window name, so no rewriting is needed.
  const target = "work::fn-1019.2";
  expect(computeRenames([c], [pane("%1", "@1", "stale")])).toEqual([
    { windowId: "@1", name: target },
  ]);
  // A window already wearing the name is NOT re-emitted (no churn).
  expect(computeRenames([c], [pane("%1", "@1", target)])).toEqual([]);
});

test("computeRenames: a candidate whose pane is absent from the sweep is skipped", () => {
  const c = candidate({
    pane_id: "%missing",
    job_id: "a",
    title: "x",
    created_at: 100,
  });
  expect(computeRenames([c], [pane("%1", "@1", "stale")])).toEqual([]);
});

test("computeRenames: independent windows each get their own winner, sorted by windowId", () => {
  const c1 = candidate({
    pane_id: "%1",
    job_id: "a",
    title: "one",
    created_at: 100,
  });
  const c2 = candidate({
    pane_id: "%2",
    job_id: "b",
    title: "two",
    created_at: 200,
  });
  const panes = [pane("%2", "@2", "stale"), pane("%1", "@1", "stale")];
  expect(computeRenames([c1, c2], panes)).toEqual([
    { windowId: "@1", name: "one" },
    { windowId: "@2", name: "two" },
  ]);
});

// ---------------------------------------------------------------------------
// renamerPulse — orchestration against a seeded DB + injected backend
// ---------------------------------------------------------------------------

test("renamerPulse renames the winning window and fires only on mismatch", async () => {
  insertJob({
    job_id: "a",
    created_at: 100,
    title: "winner",
    backend_exec_pane_id: "%1",
  });
  const fb = fakeBackend({ panes: [pane("%1", "@1", "stale")] });
  const state = { lastHash: null };
  await renamerPulse(db, fb.backend, state);
  expect(fb.renameCalls).toEqual([{ windowId: "@1", name: "winner" }]);
});

test("renamerPulse uses the job title unchanged for a Pi job", async () => {
  insertJob({
    job_id: "a",
    created_at: 100,
    title: "winner",
    backend_exec_pane_id: "%1",
  });
  db.run("UPDATE jobs SET harness = 'pi' WHERE job_id = 'a'");
  const fb = fakeBackend({ panes: [pane("%1", "@1", "stale")] });
  await renamerPulse(db, fb.backend, { lastHash: null });
  expect(fb.renameCalls).toEqual([{ windowId: "@1", name: "winner" }]);
});

test("renamerPulse does not re-fire when only job state changes", async () => {
  insertJob({
    job_id: "a",
    created_at: 100,
    title: "winner",
    backend_exec_pane_id: "%1",
  });
  const fb = fakeBackend({ panes: [pane("%1", "@1", "stale")] });
  const state = { lastHash: null };
  await renamerPulse(db, fb.backend, state);
  db.run("UPDATE jobs SET state = 'stopped' WHERE job_id = 'a'");
  await renamerPulse(db, fb.backend, state);
  expect(fb.listPanesCalls).toBe(1);
  expect(fb.renameCalls).toEqual([{ windowId: "@1", name: "winner" }]);
});

test("renamerPulse skips the tmux sweep when the candidate picture is unchanged", async () => {
  insertJob({
    job_id: "a",
    created_at: 100,
    title: "winner",
    backend_exec_pane_id: "%1",
  });
  const fb = fakeBackend({ panes: [pane("%1", "@1", "stale")] });
  const state = { lastHash: null };
  await renamerPulse(db, fb.backend, state);
  expect(fb.listPanesCalls).toBe(1);
  // Second pulse, same candidate set → the dedup gate short-circuits.
  await renamerPulse(db, fb.backend, state);
  expect(fb.listPanesCalls).toBe(1);
});

test("renamerPulse with zero candidates never spawns tmux (quiescent)", async () => {
  const fb = fakeBackend({ panes: [pane("%1", "@1", "stale")] });
  const state = { lastHash: null };
  await renamerPulse(db, fb.backend, state);
  expect(fb.listPanesCalls).toBe(0);
  expect(fb.renameCalls).toEqual([]);
});

test("renamerPulse on a degraded (null) sweep skips the cycle without advancing the gate", async () => {
  insertJob({
    job_id: "a",
    created_at: 100,
    title: "winner",
    backend_exec_pane_id: "%1",
  });
  const degraded = fakeBackend({ panes: null });
  const state = { lastHash: null };
  await renamerPulse(db, degraded.backend, state);
  expect(degraded.renameCalls).toEqual([]);
  // Gate NOT advanced: a healthy backend on the same candidate set still sweeps.
  const healthy = fakeBackend({ panes: [pane("%1", "@1", "stale")] });
  await renamerPulse(db, healthy.backend, state);
  expect(healthy.renameCalls).toEqual([{ windowId: "@1", name: "winner" }]);
});

test("renamerPulse swallows a TOCTOU rename failure as a non-fatal skip", async () => {
  insertJob({
    job_id: "a",
    created_at: 100,
    title: "winner",
    backend_exec_pane_id: "%1",
  });
  const fb = fakeBackend({
    panes: [pane("%1", "@1", "stale")],
    renameResult: () => ({ ok: false, error: "can't find window" }),
  });
  const state = { lastHash: null };
  // The failure is logged, not thrown — the pulse resolves and the gate advances.
  await renamerPulse(db, fb.backend, state);
  expect(fb.renameCalls).toEqual([{ windowId: "@1", name: "winner" }]);
});
