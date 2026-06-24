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
  actuateOrphanKill,
  buildKeeperLivePids,
  ORPHAN_MIN_AGE_SEC,
  ORPHAN_TERM_GRACE_SEC,
  type OrphanTermState,
  orphanReapCycle,
  type ProcCensusEntry,
  parsePsCensusLine,
  REAP_KILL_COOLDOWN_SEC,
  REAP_MANAGED_SESSION_IDLE_SEC,
  REAP_STOPPED_AGE_SEC,
  type ReapCandidate,
  reaperCycle,
  selectManagedSessionReapCandidates,
  selectOrphanedProcessCandidates,
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

// ---------------------------------------------------------------------------
// selectOrphanedProcessCandidates — the orphan-process arm (epic fn-934)
// ---------------------------------------------------------------------------

const SELF_UID = 501;
const SELF_PID = 99_999;

/** The canonical orphaned-runaway census shape: this user's process, reparented
 *  to init (ppid==1), exe matches the allow-list, aged past the min, with a
 *  resolvable start_time. Every exclusion test flips exactly one field. */
function makeProc(overrides: Partial<ProcCensusEntry> = {}): ProcCensusEntry {
  return {
    pid: 12_345,
    startTime: "darwin:Wed Jun 24 10:00:00 2026",
    ppid: 1,
    uid: SELF_UID,
    exe: "/usr/local/bin/bun test --test-worker test/foo.test.ts",
    ageSec: ORPHAN_MIN_AGE_SEC + 1,
    ...overrides,
  };
}

function selectOrphans(
  census: ProcCensusEntry[],
  opts: Partial<{
    now: number;
    selfUid: number;
    keeperLivePids: ReadonlySet<number>;
    exempt: ReadonlySet<string>;
    termState: Map<number, OrphanTermState>;
  }> = {},
) {
  return selectOrphanedProcessCandidates(census, {
    now: opts.now ?? NOW,
    selfUid: opts.selfUid ?? SELF_UID,
    keeperLivePids: opts.keeperLivePids ?? new Set<number>([SELF_PID]),
    exempt: opts.exempt ?? new Set<string>(),
    termState: opts.termState ?? new Map<number, OrphanTermState>(),
  });
}

test("an orphaned runaway (ppid==1, allow-listed exe, aged, self-uid) is a TERM candidate", () => {
  const out = selectOrphans([makeProc()]);
  expect(out).toEqual([
    {
      pid: 12_345,
      startTime: "darwin:Wed Jun 24 10:00:00 2026",
      exe: "/usr/local/bin/bun test --test-worker test/foo.test.ts",
      phase: "term",
    },
  ]);
});

test("each allow-listed runaway class is selected", () => {
  const cases: string[] = [
    "/usr/local/bin/bun test test/foo.test.ts",
    "/bin/sh -c while :; do :; done",
    "/bin/bash -c while true; do :; done",
    "/usr/local/bin/bun run test/helpers/flock_peer.ts",
  ];
  for (const exe of cases) {
    expect(selectOrphans([makeProc({ exe })])).toHaveLength(1);
  }
});

test("a live-parented test run (ppid != 1) is NOT selected", () => {
  expect(selectOrphans([makeProc({ ppid: 4242 })])).toEqual([]);
});

test("keeperd's own pid is NOT selected (in keeper's live set)", () => {
  // keeperd's pid is seeded into the live set by buildKeeperLivePids.
  expect(
    selectOrphans([makeProc({ pid: SELF_PID })], {
      keeperLivePids: new Set<number>([SELF_PID]),
    }),
  ).toEqual([]);
});

test("a live plan-worker pid is NOT selected (in keeper's live set)", () => {
  expect(
    selectOrphans([makeProc({ pid: 55_555 })], {
      keeperLivePids: new Set<number>([SELF_PID, 55_555]),
    }),
  ).toEqual([]);
});

test("the human's shell (exe not in allow-list) is NOT selected", () => {
  expect(selectOrphans([makeProc({ exe: "-zsh" })])).toEqual([]);
  expect(
    selectOrphans([makeProc({ exe: "/Applications/MyEditor.app/editor" })]),
  ).toEqual([]);
});

test("an other-uid process is NOT selected", () => {
  expect(selectOrphans([makeProc({ uid: 0 })])).toEqual([]);
  expect(selectOrphans([makeProc({ uid: SELF_UID + 1 })])).toEqual([]);
});

test("a too-young process (age <= minAge) is NOT selected", () => {
  expect(selectOrphans([makeProc({ ageSec: ORPHAN_MIN_AGE_SEC })])).toEqual([]);
  expect(selectOrphans([makeProc({ ageSec: ORPHAN_MIN_AGE_SEC - 1 })])).toEqual(
    [],
  );
  expect(
    selectOrphans([makeProc({ ageSec: ORPHAN_MIN_AGE_SEC + 1 })]),
  ).toHaveLength(1);
});

test("a probe-failed process (null exe or null start_time) is NOT selected", () => {
  // A partial/failed proc_pidinfo read folds to NULL exe / NULL start_time —
  // can't-confirm-don't-kill.
  expect(selectOrphans([makeProc({ exe: null })])).toEqual([]);
  expect(selectOrphans([makeProc({ startTime: null })])).toEqual([]);
});

test("a disableOrphanReap exemption vetoes a matching candidate", () => {
  // An operator exemption substring that matches the candidate's exe vetoes it,
  // even though it also matches the closed allow-list.
  expect(
    selectOrphans(
      [makeProc({ exe: "/usr/local/bin/bun test --test-worker x" })],
      {
        exempt: new Set<string>(["--test-worker"]),
      },
    ),
  ).toEqual([]);
  // A non-matching exemption does not veto.
  expect(
    selectOrphans([makeProc()], { exempt: new Set<string>(["unrelated"]) }),
  ).toHaveLength(1);
});

test("orphan candidates are returned in ascending pid order", () => {
  const out = selectOrphans([
    makeProc({ pid: 300 }),
    makeProc({ pid: 100 }),
    makeProc({ pid: 200 }),
  ]);
  expect(out.map((c) => c.pid)).toEqual([100, 200, 300]);
});

// --- two-phase escalation -------------------------------------------------

test("a previously-TERM'd pid (same start_time) escalates to KILL past the grace", () => {
  const termState = new Map<number, OrphanTermState>([
    [
      12_345,
      {
        startTime: "darwin:Wed Jun 24 10:00:00 2026",
        termAt: NOW - ORPHAN_TERM_GRACE_SEC,
      },
    ],
  ]);
  const out = selectOrphans([makeProc()], { termState, now: NOW });
  expect(out).toHaveLength(1);
  expect(out[0].phase).toBe("kill");
});

test("a previously-TERM'd pid INSIDE the grace is suppressed (no re-TERM)", () => {
  const termState = new Map<number, OrphanTermState>([
    [
      12_345,
      {
        startTime: "darwin:Wed Jun 24 10:00:00 2026",
        termAt: NOW - ORPHAN_TERM_GRACE_SEC + 1,
      },
    ],
  ]);
  expect(selectOrphans([makeProc()], { termState, now: NOW })).toEqual([]);
});

test("a recycled pid (start_time differs from the TERM'd one) restarts as TERM", () => {
  // The stored term state is for a DIFFERENT process (start_time mismatch) — the
  // recycled pid restarts the ladder at TERM, never an immediate KILL.
  const termState = new Map<number, OrphanTermState>([
    [12_345, { startTime: "darwin:OLD", termAt: NOW - 10_000 }],
  ]);
  const out = selectOrphans([makeProc()], { termState, now: NOW });
  expect(out).toHaveLength(1);
  expect(out[0].phase).toBe("term");
});

// ---------------------------------------------------------------------------
// actuateOrphanKill — the raw-pid actuator + TOCTOU re-fingerprint
// ---------------------------------------------------------------------------

function orphanCandidate(
  overrides: Partial<{
    pid: number;
    startTime: string | null;
    exe: string | null;
    phase: "term" | "kill";
  }> = {},
) {
  return {
    pid: 12_345,
    startTime: "darwin:Wed Jun 24 10:00:00 2026",
    exe: "bun test --test-worker",
    phase: "term" as const,
    ...overrides,
  };
}

test("actuateOrphanKill sends SIGTERM for a term-phase candidate whose fingerprint matches", () => {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const outcome = actuateOrphanKill(orphanCandidate(), {
    isAlive: () => true,
    readStartTime: () => "darwin:Wed Jun 24 10:00:00 2026",
    kill: (pid, signal) => sent.push([pid, signal]),
  });
  expect(outcome).toBe("termed");
  expect(sent).toEqual([[12_345, "SIGTERM"]]);
});

test("actuateOrphanKill sends SIGKILL for a kill-phase candidate", () => {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const outcome = actuateOrphanKill(orphanCandidate({ phase: "kill" }), {
    isAlive: () => true,
    readStartTime: () => "darwin:Wed Jun 24 10:00:00 2026",
    kill: (pid, signal) => sent.push([pid, signal]),
  });
  expect(outcome).toBe("killed");
  expect(sent).toEqual([[12_345, "SIGKILL"]]);
});

test("actuateOrphanKill ABORTS (no signal) when the re-fingerprint shows a recycled pid", () => {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const outcome = actuateOrphanKill(orphanCandidate(), {
    isAlive: () => true,
    // The live pid's start_time differs — the pid was recycled into a DIFFERENT
    // process between census and kill. Must NOT signal.
    readStartTime: () => "darwin:DIFFERENT START",
    kill: (pid, signal) => sent.push([pid, signal]),
  });
  expect(outcome).toBe("skip:recycled");
  expect(sent).toEqual([]);
});

test("actuateOrphanKill skips a vanished pid (isAlive false) without signalling", () => {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const outcome = actuateOrphanKill(orphanCandidate(), {
    isAlive: () => false,
    readStartTime: () => "darwin:Wed Jun 24 10:00:00 2026",
    kill: (pid, signal) => sent.push([pid, signal]),
  });
  expect(outcome).toBe("skip:gone");
  expect(sent).toEqual([]);
});

test("actuateOrphanKill skips when the re-probe start_time read fails", () => {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const outcome = actuateOrphanKill(orphanCandidate(), {
    isAlive: () => true,
    readStartTime: () => null,
    kill: (pid, signal) => sent.push([pid, signal]),
  });
  expect(outcome).toBe("skip:probe-failed");
  expect(sent).toEqual([]);
});

test("actuateOrphanKill never throws on an ESRCH/EPERM kill error", () => {
  const outcome = actuateOrphanKill(orphanCandidate(), {
    isAlive: () => true,
    readStartTime: () => "darwin:Wed Jun 24 10:00:00 2026",
    kill: () => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    },
  });
  expect(outcome).toBe("skip:ESRCH");
});

// ---------------------------------------------------------------------------
// buildKeeperLivePids — keeper's own-tree exclusion set
// ---------------------------------------------------------------------------

test("buildKeeperLivePids includes self pid + every non-terminal pid; excludes terminal", () => {
  const jobs: Job[] = [
    makeJob({ pid: 100, state: "working" }),
    makeJob({ pid: 200, state: "stopped" }),
    makeJob({ pid: 300, state: "killed" }),
    makeJob({ pid: 400, state: "ended" }),
    makeJob({ pid: null }),
  ];
  const live = buildKeeperLivePids(jobs, SELF_PID);
  expect(live.has(SELF_PID)).toBe(true);
  expect(live.has(100)).toBe(true);
  expect(live.has(200)).toBe(true);
  // Terminal rows excluded so a stale recycled pid never shields a true orphan.
  expect(live.has(300)).toBe(false);
  expect(live.has(400)).toBe(false);
});

// ---------------------------------------------------------------------------
// parsePsCensusLine — the ps stride parser
// ---------------------------------------------------------------------------

test("parsePsCensusLine parses a well-formed ps line", () => {
  // `ps -axww -o pid=,ppid=,uid=,lstart=,args=` → fixed-width 24-char lstart.
  const line =
    "12345     1   501 Wed Jun 24 10:00:00 2026 /usr/local/bin/bun test --test-worker x";
  const parsed = parsePsCensusLine(line);
  expect(parsed).not.toBeNull();
  expect(parsed?.pid).toBe(12_345);
  expect(parsed?.ppid).toBe(1);
  expect(parsed?.uid).toBe(501);
  expect(parsed?.startTime).toBe("darwin:Wed Jun 24 10:00:00 2026");
  expect(parsed?.exe).toBe("/usr/local/bin/bun test --test-worker x");
});

test("parsePsCensusLine returns null on a malformed line", () => {
  expect(parsePsCensusLine("")).toBeNull();
  expect(parsePsCensusLine("garbage")).toBeNull();
  expect(parsePsCensusLine("PID PPID UID")).toBeNull();
});

// ---------------------------------------------------------------------------
// orphanReapCycle — census → select → actuate, with stamp/clear of term state
// ---------------------------------------------------------------------------

function orphanCycleSeams(
  overrides: Partial<{
    now: number;
    census: ProcCensusEntry[];
    termState: Map<number, OrphanTermState>;
    isAlive: (pid: number) => boolean;
    readStartTime: (pid: number) => string | null;
  }> = {},
) {
  const sent: Array<[number, NodeJS.Signals]> = [];
  const census = overrides.census ?? [makeProc()];
  const termState = overrides.termState ?? new Map<number, OrphanTermState>();
  return {
    sent,
    termState,
    seams: {
      now: overrides.now ?? NOW,
      selfUid: SELF_UID,
      selfPid: SELF_PID,
      exempt: new Set<string>(),
      termState,
      enumerate: () => census,
      isAlive: overrides.isAlive ?? (() => true),
      readStartTime:
        overrides.readStartTime ?? (() => "darwin:Wed Jun 24 10:00:00 2026"),
      kill: (pid: number, signal: NodeJS.Signals) => sent.push([pid, signal]),
    },
  };
}

test("orphanReapCycle TERMs an orphan and stamps the term state", () => {
  const ctx = orphanCycleSeams();
  orphanReapCycle([], ctx.seams);
  expect(ctx.sent).toEqual([[12_345, "SIGTERM"]]);
  expect(ctx.termState.get(12_345)).toEqual({
    startTime: "darwin:Wed Jun 24 10:00:00 2026",
    termAt: NOW,
  });
});

test("orphanReapCycle KILLs a still-alive previously-TERM'd orphan and clears the term state", () => {
  const termState = new Map<number, OrphanTermState>([
    [
      12_345,
      {
        startTime: "darwin:Wed Jun 24 10:00:00 2026",
        termAt: NOW - ORPHAN_TERM_GRACE_SEC,
      },
    ],
  ]);
  const ctx = orphanCycleSeams({ termState });
  orphanReapCycle([], ctx.seams);
  expect(ctx.sent).toEqual([[12_345, "SIGKILL"]]);
  // Cleared so a recycled pid restarts the ladder rather than re-killing.
  expect(ctx.termState.has(12_345)).toBe(false);
});

test("orphanReapCycle never kills a pid in keeper's live jobs set", () => {
  // A jobs row carrying the orphan's pid as a LIVE worker shields it entirely.
  const ctx = orphanCycleSeams();
  orphanReapCycle([makeJob({ pid: 12_345, state: "working" })], ctx.seams);
  expect(ctx.sent).toEqual([]);
});

test("orphanReapCycle does NOT throw on an empty census", () => {
  const ctx = orphanCycleSeams({ census: [] });
  expect(() => orphanReapCycle([], ctx.seams)).not.toThrow();
  expect(ctx.sent).toEqual([]);
});
