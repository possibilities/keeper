/**
 * tmux window-reaper worker tests (epic fn-802 task .2).
 *
 * Exercise the pure decision symbol `selectReapCandidates` clause-by-clause and
 * the `reaperCycle` orchestration with an INJECTED selector + a fake pane-ops
 * `killWindow` (no real tmux, no Worker spawn, no DB). The worker's lifecycle (Worker thread,
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
 *  - the managed-session arm (epic fn-920): a stopped+aged pair/panels/agentbus
 *    job IS reaped; a human-session job (birth-session ∉ allow-list) is NOT; a
 *    `disable_autoclose` session is NOT; an autopilot/plan-verb job is untouched
 *    by the new arm; live-session COALESCE onto birth-session; clause-by-clause
 *    exclusions mirroring the autopilot arm.
 *  - reaperCycle: fires killWindow on a passing candidate; aborts on a flipped
 *    verdict at the pre-kill re-check; stamps the cooldown on every attempt; a
 *    killWindow failure is a non-fatal skip; a managed-session candidate fires.
 */

import { expect, test } from "bun:test";
import type { LaunchResult, TmuxPaneOps } from "../src/exec-backend";
import {
  AGENTBUS_EXEC_SESSION,
  MANAGED_EXEC_SESSION,
  PAIR_EXEC_SESSION,
  PANELS_EXEC_SESSION,
} from "../src/exec-backend";
import type { ReadinessSnapshot, Verdict } from "../src/readiness";
import {
  REAP_KILL_COOLDOWN_SEC,
  REAP_MANAGED_SESSION_IDLE_SEC,
  REAP_STOPPED_AGE_SEC,
  type ReapCandidate,
  reaperCycle,
  selectManagedSessionReapCandidates,
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
// selectManagedSessionReapCandidates — the SECOND, verdict-free arm (fn-920)
// ---------------------------------------------------------------------------

/** A managed-session NON-plan partner: stopped+aged past the idle grace, live
 *  session resolved to `pair`. Every exclusion test flips one field off this. */
function makeManagedJob(overrides: Partial<Job> = {}): Job {
  return makeJob({
    plan_verb: null,
    plan_ref: null,
    backend_exec_session_id: PAIR_EXEC_SESSION,
    backend_exec_birth_session_id: PAIR_EXEC_SESSION,
    updated_at: NOW - REAP_MANAGED_SESSION_IDLE_SEC - 1,
    ...overrides,
  });
}

const NO_DISABLE: ReadonlySet<string> = new Set();

function selectManaged(
  jobs: Job[],
  cooldown: Map<string, number> = new Map(),
  disableAutoclose: ReadonlySet<string> = NO_DISABLE,
  now: number = NOW,
): ReapCandidate[] {
  return selectManagedSessionReapCandidates(
    jobs,
    now,
    cooldown,
    disableAutoclose,
  );
}

test("a stopped+aged managed-session partner is a candidate (session, no verb/ref)", () => {
  expect(selectManaged([makeManagedJob()])).toEqual([
    {
      job_id: "j-1",
      pane_id: "%7",
      verb: null,
      plan_ref: null,
      session: PAIR_EXEC_SESSION,
    },
  ]);
});

test("every managed session (pair/panels/agentbus) is in the allow-list", () => {
  for (const s of [
    PAIR_EXEC_SESSION,
    PANELS_EXEC_SESSION,
    AGENTBUS_EXEC_SESSION,
  ]) {
    const out = selectManaged([
      makeManagedJob({
        backend_exec_session_id: s,
        backend_exec_birth_session_id: s,
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.session).toBe(s);
  }
});

test("CATASTROPHE GUARD: a human-session partner (birth-session ∉ allow-list) is NEVER reaped", () => {
  // A human's hand-started claude folds to plan_verb NULL too — the allow-list
  // keyed on the frozen birth-session is the ONLY thing that keeps the arm off
  // it. Both the live AND birth session are a human name.
  const job = makeManagedJob({
    backend_exec_session_id: "mike-hacking",
    backend_exec_birth_session_id: "mike-hacking",
  });
  expect(selectManaged([job])).toEqual([]);
});

test("the autopilot session is excluded from the managed-session arm (no overlap)", () => {
  // MANAGED_EXEC_SESSION is deliberately absent from the allow-list so the two
  // arms never double-handle a job.
  const job = makeManagedJob({
    backend_exec_session_id: MANAGED_EXEC_SESSION,
    backend_exec_birth_session_id: MANAGED_EXEC_SESSION,
  });
  expect(selectManaged([job])).toEqual([]);
});

test("a plan-verb job is excluded from the managed-session arm (autopilot arm's domain)", () => {
  // Even if launched into a managed session, a plan-verb job belongs to the
  // verdict-gated autopilot arm, never this one.
  for (const verb of ["work", "close", "approve", "plan"]) {
    expect(selectManaged([makeManagedJob({ plan_verb: verb })])).toEqual([]);
  }
});

test("the live session COALESCEs onto the frozen birth-session when NULL", () => {
  // A fresh pair job reads a NULL live session until TmuxTopologySnapshot
  // resolves the pane — the birth-session must still admit it.
  const job = makeManagedJob({
    backend_exec_session_id: null,
    backend_exec_birth_session_id: PAIR_EXEC_SESSION,
  });
  const out = selectManaged([job]);
  expect(out).toHaveLength(1);
  expect(out[0]?.session).toBe(PAIR_EXEC_SESSION);
});

test("a job with both live and birth session NULL is excluded", () => {
  const job = makeManagedJob({
    backend_exec_session_id: null,
    backend_exec_birth_session_id: null,
  });
  expect(selectManaged([job])).toEqual([]);
});

test("a session in disable_autoclose is not reaped (the debug opt-out)", () => {
  const job = makeManagedJob();
  expect(selectManaged([job], new Map(), new Set([PAIR_EXEC_SESSION]))).toEqual(
    [],
  );
  // A different session in the disable list does NOT exempt this one.
  expect(
    selectManaged([job], new Map(), new Set([PANELS_EXEC_SESSION])),
  ).toHaveLength(1);
});

test("a working (not stopped) managed-session job is excluded", () => {
  expect(selectManaged([makeManagedJob({ state: "working" })])).toEqual([]);
});

test("a managed-session job under the idle grace is excluded; exactly-grace excluded; over included", () => {
  expect(
    selectManaged([
      makeManagedJob({ updated_at: NOW - REAP_MANAGED_SESSION_IDLE_SEC + 1 }),
    ]),
  ).toEqual([]);
  expect(
    selectManaged([
      makeManagedJob({ updated_at: NOW - REAP_MANAGED_SESSION_IDLE_SEC }),
    ]),
  ).toEqual([]);
  expect(
    selectManaged([
      makeManagedJob({ updated_at: NOW - REAP_MANAGED_SESSION_IDLE_SEC - 1 }),
    ]),
  ).toHaveLength(1);
});

test("a null pane id is excluded from the managed-session arm", () => {
  expect(
    selectManaged([makeManagedJob({ backend_exec_pane_id: null })]),
  ).toEqual([]);
});

test("a null pid is excluded from the managed-session arm", () => {
  expect(selectManaged([makeManagedJob({ pid: null })])).toEqual([]);
});

test("the managed-session arm honors the shared cooldown map", () => {
  const cooldown = new Map<string, number>([
    ["j-1", NOW - REAP_KILL_COOLDOWN_SEC + 1],
  ]);
  expect(selectManaged([makeManagedJob()], cooldown)).toEqual([]);
  const expired = new Map<string, number>([
    ["j-1", NOW - REAP_KILL_COOLDOWN_SEC],
  ]);
  expect(selectManaged([makeManagedJob()], expired)).toHaveLength(1);
});

test("managed-session candidates are returned in ascending job_id order", () => {
  const out = selectManaged([
    makeManagedJob({ job_id: "j-2", backend_exec_pane_id: "%2" }),
    makeManagedJob({ job_id: "j-1", backend_exec_pane_id: "%1" }),
  ]);
  expect(out.map((c) => c.job_id)).toEqual(["j-1", "j-2"]);
});

// ---------------------------------------------------------------------------
// reaperCycle — orchestration with an injected selector + fake backend
// ---------------------------------------------------------------------------

// Shrunk to the kept pane-op subset `reaperCycle` consumes — `Pick<TmuxPaneOps,
// "killWindow">`. A broad ExecBackend-shaped fake would structurally mask a real
// gap, so only the op under test carries behavior.
interface FakeBackend extends Pick<TmuxPaneOps, "killWindow"> {
  kills: string[];
}

function fakeBackend(result: LaunchResult = { ok: true }): FakeBackend {
  const kills: string[] = [];
  return {
    kills,
    killWindow: async (paneId: string): Promise<LaunchResult> => {
      kills.push(paneId);
      return result;
    },
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

test("reaperCycle fires for a managed-session candidate (arm-agnostic orchestration)", async () => {
  // The cycle treats both arms identically — it keys on (job_id, pane_id), not
  // the discriminators. A managed-session candidate (verb/ref NULL, session set)
  // drives the same TOCTOU re-check + cooldown + kill.
  const managedCandidate: ReapCandidate = {
    job_id: "j-9",
    pane_id: "%9",
    verb: null,
    plan_ref: null,
    session: PAIR_EXEC_SESSION,
  };
  const backend = fakeBackend();
  const cooldown = new Map<string, number>();
  await reaperCycle(
    async () => [managedCandidate],
    backend,
    cooldown,
    () => NOW,
  );
  expect(backend.kills).toEqual(["%9"]);
  expect(cooldown.get("j-9")).toBe(NOW);
});
