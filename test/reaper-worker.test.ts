/**
 * tmux window-reaper worker tests (epic fn-802 task .2).
 *
 * Exercise the pure decision symbol `selectReapCandidates` clause-by-clause and
 * the `reaperCycle` orchestration with an INJECTED selector + fake `ExecBackend`
 * (no real tmux, no Worker spawn, no DB). The worker's lifecycle (Worker thread,
 * watchLoop, parentPort, periodic tick) is NOT spawned — the `isMainThread`
 * guard keeps the plain `import` inert, the same shape every other worker test
 * uses. Worker lifecycle + registration is covered by the daemon ALL_WORKERS
 * pin + test:full.
 *
 * Coverage:
 *  - predicate clauses, each individually excluded: wrong session, approve verb,
 *    null plan_ref, working state, under-60s, null pane, null pid, non-completed
 *    verdict, wrong-map (close verdict only in perCloseRow) lookup.
 *  - the happy work + close candidate (perTask / perCloseRow keying).
 *  - cooldown suppression and post-expiry re-admittance.
 *  - reaperCycle: fires killWindow on a passing candidate; aborts on a flipped
 *    verdict at the pre-kill re-check; stamps the cooldown on every attempt; a
 *    killWindow failure is a non-fatal skip.
 */

import { expect, test } from "bun:test";
import type { ExecBackend, LaunchResult } from "../src/exec-backend";
import { MANAGED_EXEC_SESSION } from "../src/exec-backend";
import type { ReadinessSnapshot, Verdict } from "../src/readiness";
import {
  REAP_KILL_COOLDOWN_SEC,
  REAP_STOPPED_AGE_SEC,
  type ReapCandidate,
  reaperCycle,
  selectReapCandidates,
} from "../src/reaper-worker";
import type { Job } from "../src/types";

const NOW = 1_000_000;

/** A managed, stopped-long-ago, completed work job — the canonical reapable
 *  shape. Every exclusion test flips exactly one field off this baseline. */
function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    job_id: "j-1",
    created_at: 0,
    cwd: null,
    pid: 4242,
    state: "stopped",
    last_event_id: 0,
    updated_at: NOW - REAP_STOPPED_AGE_SEC - 1,
    title: null,
    title_source: null,
    transcript_path: null,
    start_time: null,
    plan_verb: "work",
    plan_ref: "fn-1-foo.1",
    epic_links: [],
    last_api_error_at: null,
    last_api_error_kind: null,
    last_input_request_at: null,
    last_input_request_kind: null,
    config_dir: null,
    git_dirty_count: 0,
    git_unattributed_to_live_count: 0,
    git_orphan_count: 0,
    backend_exec_session_id: MANAGED_EXEC_SESSION,
    backend_exec_pane_id: "%7",
    backend_exec_type: "tmux",
    ...overrides,
  } as Job;
}

/** A readiness snapshot with the given per-task / per-close-row verdicts. */
function makeReadiness(opts: {
  perTask?: Record<string, Verdict>;
  perCloseRow?: Record<string, Verdict>;
}): ReadinessSnapshot {
  return {
    perTask: new Map(Object.entries(opts.perTask ?? {})),
    perCloseRow: new Map(Object.entries(opts.perCloseRow ?? {})),
    perEpic: new Map(),
    diagnostics: [],
  };
}

const COMPLETED: Verdict = { tag: "completed" };

function select(
  jobs: Job[],
  readiness: ReadinessSnapshot,
  cooldown: Map<string, number> = new Map(),
  now: number = NOW,
): ReapCandidate[] {
  return selectReapCandidates(jobs, readiness, now, cooldown);
}

// ---------------------------------------------------------------------------
// selectReapCandidates — the happy paths
// ---------------------------------------------------------------------------

test("a completed work job (perTask verdict) is a candidate", () => {
  const out = select(
    [makeJob()],
    makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } }),
  );
  expect(out).toEqual([
    { job_id: "j-1", pane_id: "%7", verb: "work", plan_ref: "fn-1-foo.1" },
  ]);
});

test("a completed close job is keyed by perCloseRow, never perTask", () => {
  const job = makeJob({ plan_verb: "close", plan_ref: "fn-1-foo" });
  // The close verdict lives ONLY in perCloseRow — a perTask entry for the same
  // ref must NOT make it a candidate, and vice versa.
  expect(
    select([job], makeReadiness({ perCloseRow: { "fn-1-foo": COMPLETED } })),
  ).toHaveLength(1);
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo": COMPLETED } })),
  ).toHaveLength(0);
});

test("candidates are returned in ascending job_id order", () => {
  const out = select(
    [
      makeJob({
        job_id: "j-2",
        plan_ref: "fn-1-foo.2",
        backend_exec_pane_id: "%2",
      }),
      makeJob({
        job_id: "j-1",
        plan_ref: "fn-1-foo.1",
        backend_exec_pane_id: "%1",
      }),
    ],
    makeReadiness({
      perTask: { "fn-1-foo.1": COMPLETED, "fn-1-foo.2": COMPLETED },
    }),
  );
  expect(out.map((c) => c.job_id)).toEqual(["j-1", "j-2"]);
});

// ---------------------------------------------------------------------------
// selectReapCandidates — clause-by-clause exclusions
// ---------------------------------------------------------------------------

test("a non-managed session is excluded", () => {
  const job = makeJob({ backend_exec_session_id: "human-session" });
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } })),
  ).toEqual([]);
});

test("a NULL session is excluded", () => {
  const job = makeJob({ backend_exec_session_id: null });
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } })),
  ).toEqual([]);
});

test("an approve verb is excluded even with a perTask completed verdict", () => {
  // approve rows DO get perTask verdicts — the verb filter is the only thing
  // that keeps them out of the reap set.
  const job = makeJob({ plan_verb: "approve" });
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } })),
  ).toEqual([]);
});

test("a plan verb is excluded", () => {
  const job = makeJob({ plan_verb: "plan" });
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } })),
  ).toEqual([]);
});

test("a null plan_ref is excluded", () => {
  const job = makeJob({ plan_ref: null });
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } })),
  ).toEqual([]);
});

test("a working (not stopped) job is excluded", () => {
  const job = makeJob({ state: "working" });
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } })),
  ).toEqual([]);
});

test("a job stopped for under 60s is excluded; exactly-60s is excluded; over-60s included", () => {
  const ready = makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } });
  expect(
    select([makeJob({ updated_at: NOW - REAP_STOPPED_AGE_SEC + 1 })], ready),
  ).toEqual([]);
  expect(
    select([makeJob({ updated_at: NOW - REAP_STOPPED_AGE_SEC })], ready),
  ).toEqual([]);
  expect(
    select([makeJob({ updated_at: NOW - REAP_STOPPED_AGE_SEC - 1 })], ready),
  ).toHaveLength(1);
});

test("a null pane id is excluded", () => {
  const job = makeJob({ backend_exec_pane_id: null });
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } })),
  ).toEqual([]);
});

test("a null pid is excluded (degenerate exit-watcher-pidless bookkeeping)", () => {
  const job = makeJob({ pid: null });
  expect(
    select([job], makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } })),
  ).toEqual([]);
});

test("a non-completed verdict is excluded", () => {
  const ready = (v: Verdict): ReadinessSnapshot =>
    makeReadiness({ perTask: { "fn-1-foo.1": v } });
  expect(select([makeJob()], ready({ tag: "ready" }))).toEqual([]);
  expect(
    select(
      [makeJob()],
      ready({ tag: "running", reason: { kind: "job-running" } }),
    ),
  ).toEqual([]);
  // A missing verdict (no map entry at all) is excluded too.
  expect(select([makeJob()], makeReadiness({}))).toEqual([]);
});

// ---------------------------------------------------------------------------
// selectReapCandidates — cooldown
// ---------------------------------------------------------------------------

test("a job inside its cooldown window is suppressed; past it, re-admitted", () => {
  const ready = makeReadiness({ perTask: { "fn-1-foo.1": COMPLETED } });
  const cooldown = new Map<string, number>([
    ["j-1", NOW - REAP_KILL_COOLDOWN_SEC + 1],
  ]);
  expect(select([makeJob()], ready, cooldown)).toEqual([]);
  // One second past the cooldown the job is reapable again.
  const expired = new Map<string, number>([
    ["j-1", NOW - REAP_KILL_COOLDOWN_SEC],
  ]);
  expect(select([makeJob()], ready, expired)).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// reaperCycle — orchestration with an injected selector + fake backend
// ---------------------------------------------------------------------------

interface FakeBackend extends ExecBackend {
  kills: string[];
}

function fakeBackend(result: LaunchResult = { ok: true }): FakeBackend {
  const kills: string[] = [];
  const notImpl = (): never => {
    throw new Error("not implemented in fake");
  };
  return {
    kills,
    killWindow: async (paneId: string): Promise<LaunchResult> => {
      kills.push(paneId);
      return result;
    },
    launch: notImpl,
    focusPane: notImpl,
    ensureLaunched: notImpl,
    listPanes: notImpl,
    renameWindow: notImpl,
  };
}

const candidate: ReapCandidate = {
  job_id: "j-1",
  pane_id: "%7",
  verb: "work",
  plan_ref: "fn-1-foo.1",
};

test("reaperCycle fires killWindow and stamps the cooldown for a passing candidate", async () => {
  const backend = fakeBackend();
  const cooldown = new Map<string, number>();
  // Selector returns the same candidate on both the initial select and the
  // pre-kill re-check.
  await reaperCycle(
    async () => [candidate],
    backend,
    cooldown,
    () => NOW,
  );
  expect(backend.kills).toEqual(["%7"]);
  expect(cooldown.get("j-1")).toBe(NOW);
});

test("reaperCycle aborts the kill when the pre-kill re-check no longer lists the job", async () => {
  const backend = fakeBackend();
  const cooldown = new Map<string, number>();
  let call = 0;
  // First select (candidate list) yields the job; the pre-kill re-check yields
  // empty — a resume flipped the verdict between selection and the kill.
  const select = async (): Promise<ReapCandidate[]> => {
    call += 1;
    return call === 1 ? [candidate] : [];
  };
  await reaperCycle(select, backend, cooldown, () => NOW);
  expect(backend.kills).toEqual([]);
  // No kill attempted → no cooldown stamp (cooldown is stamped only on a fired
  // attempt, after the re-check passes).
  expect(cooldown.has("j-1")).toBe(false);
});

test("reaperCycle stamps the cooldown even when killWindow fails (non-fatal skip)", async () => {
  const backend = fakeBackend({ ok: false, error: "can't find window" });
  const cooldown = new Map<string, number>();
  await reaperCycle(
    async () => [candidate],
    backend,
    cooldown,
    () => NOW,
  );
  // The kill was attempted (so the cooldown is stamped) and the failure did not
  // throw — the cycle resolves cleanly.
  expect(backend.kills).toEqual(["%7"]);
  expect(cooldown.get("j-1")).toBe(NOW);
});
