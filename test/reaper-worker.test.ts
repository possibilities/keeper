/**
 * tmux window-reaper worker tests.
 *
 * Exercise the single unified pure predicate `selectReapCandidates`
 * clause-by-clause and the `reaperCycle` orchestration with an INJECTED selector
 * + a fake pane-ops `killWindow` (no real tmux, no Worker spawn, no DB). The
 * worker's lifecycle (Worker thread, watchLoop, parentPort, periodic tick) is
 * NOT spawned — the `isMainThread` guard keeps the plain `import` inert, the same
 * shape every other worker test uses. Worker lifecycle + registration is covered
 * by the daemon ALL_WORKERS pin + test:full.
 *
 * ONE rule: a keeper-created (`backend_exec_birth_session_id` non-null), tmux,
 * cleanly-stopped (`stopped`/`ended`, never `killed`) window past the idle grace,
 * with a pane id, not opt-out-matched, not in cooldown. Coverage:
 *  - the happy candidate; `stopped` AND `ended` both reap; the autopilot session
 *    reaps via the same rule.
 *  - clause-by-clause exclusion: NULL birth (human window), wrong backend,
 *    working/killed state, within grace, opt-out match (live OR birth, glob), NULL
 *    pane, cooldown suppression + re-admittance.
 *  - the configurable grace.
 *  - reaperCycle: fires killWindow on a passing candidate; aborts on a flipped
 *    state at the pre-kill re-check; stamps the cooldown on every fired attempt; a
 *    killWindow failure is a non-fatal skip.
 */

import { expect, test } from "bun:test";
import type { LaunchResult, TmuxPaneOps } from "../src/exec-backend";
import { MANAGED_EXEC_SESSION, PAIR_EXEC_SESSION } from "../src/exec-backend";
import { resolveDisableAutoclose } from "../src/pair-command";
import {
  DEFAULT_AUTOCLOSE_GRACE_SEC,
  REAP_KILL_COOLDOWN_SEC,
  type ReapCandidate,
  reaperCycle,
  selectReapCandidates,
} from "../src/reaper-worker";
import type { Job } from "../src/types";

const NOW = 1_000_000;
const GRACE = DEFAULT_AUTOCLOSE_GRACE_SEC;

/** A keeper-created, cleanly-stopped-past-grace, tmux window — the canonical
 *  reapable shape. Every exclusion test flips exactly one field off this. */
function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    job_id: "j-1",
    created_at: 0,
    cwd: null,
    pid: 4242,
    state: "stopped",
    last_event_id: 0,
    updated_at: NOW - GRACE - 1,
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
    backend_exec_birth_session_id: MANAGED_EXEC_SESSION,
    backend_exec_pane_id: "%7",
    backend_exec_type: "tmux",
    ...overrides,
  } as Job;
}

/** A matcher that opts NOTHING out (the default — every keeper session reaps). */
const NEVER: (session: string) => boolean = () => false;

function select(
  jobs: Job[],
  opts: {
    now?: number;
    cooldown?: Map<string, number>;
    disable?: (session: string) => boolean;
    grace?: number;
  } = {},
): ReapCandidate[] {
  return selectReapCandidates(
    jobs,
    opts.now ?? NOW,
    opts.cooldown ?? new Map(),
    opts.disable ?? NEVER,
    opts.grace,
  );
}

// ---------------------------------------------------------------------------
// selectReapCandidates — the happy paths
// ---------------------------------------------------------------------------

test("a cleanly-stopped keeper window is a candidate (job_id, pane, birth session)", () => {
  expect(select([makeJob()])).toEqual([
    { job_id: "j-1", pane_id: "%7", session: MANAGED_EXEC_SESSION },
  ]);
});

test("BOTH stopped and ended reap; killed never does", () => {
  expect(select([makeJob({ state: "stopped" })])).toHaveLength(1);
  expect(select([makeJob({ state: "ended" })])).toHaveLength(1);
  // A crashed window (killed) stays open for forensics.
  expect(select([makeJob({ state: "killed" })])).toEqual([]);
});

test("the autopilot session reaps via the unified rule (no verdict gate)", () => {
  // No readiness verdict is consulted — a cleanly-stopped autopilot worker reaps
  // on the clean-stop + idle grace alone.
  const job = makeJob({
    backend_exec_session_id: MANAGED_EXEC_SESSION,
    backend_exec_birth_session_id: MANAGED_EXEC_SESSION,
  });
  expect(select([job])).toHaveLength(1);
});

test("a non-plan keeper partner (pair) reaps via the same rule", () => {
  const job = makeJob({
    plan_verb: null,
    plan_ref: null,
    backend_exec_session_id: PAIR_EXEC_SESSION,
    backend_exec_birth_session_id: PAIR_EXEC_SESSION,
  });
  expect(select([job])).toEqual([
    { job_id: "j-1", pane_id: "%7", session: PAIR_EXEC_SESSION },
  ]);
});

test("candidates are returned in ascending job_id order", () => {
  const out = select([
    makeJob({ job_id: "j-2", backend_exec_pane_id: "%2" }),
    makeJob({ job_id: "j-1", backend_exec_pane_id: "%1" }),
  ]);
  expect(out.map((c) => c.job_id)).toEqual(["j-1", "j-2"]);
});

// ---------------------------------------------------------------------------
// selectReapCandidates — clause-by-clause exclusions
// ---------------------------------------------------------------------------

test("CATASTROPHE GUARD: a human window (NULL birth-session) is NEVER reaped", () => {
  // A human's hand-started claude carries a LIVE session name but a NULL birth —
  // the identity test keys on birth precisely so the live name can't mis-reap it.
  const job = makeJob({
    backend_exec_session_id: "mike-hacking",
    backend_exec_birth_session_id: null,
  });
  expect(select([job])).toEqual([]);
});

test("a non-tmux backend is excluded", () => {
  expect(select([makeJob({ backend_exec_type: "local" })])).toEqual([]);
  expect(select([makeJob({ backend_exec_type: null })])).toEqual([]);
});

test("a working (not stopped/ended) job is excluded", () => {
  expect(select([makeJob({ state: "working" })])).toEqual([]);
});

test("a job within the grace is excluded; exactly-grace excluded; over-grace included", () => {
  expect(select([makeJob({ updated_at: NOW - GRACE + 1 })])).toEqual([]);
  expect(select([makeJob({ updated_at: NOW - GRACE })])).toEqual([]);
  expect(select([makeJob({ updated_at: NOW - GRACE - 1 })])).toHaveLength(1);
});

test("a null pane id is excluded (no kill target)", () => {
  expect(select([makeJob({ backend_exec_pane_id: null })])).toEqual([]);
  expect(select([makeJob({ backend_exec_pane_id: "" })])).toEqual([]);
});

// ---------------------------------------------------------------------------
// selectReapCandidates — the opt-out (tested against BOTH live and birth)
// ---------------------------------------------------------------------------

test("a session in disable_autoclose is left open (matched on birth)", () => {
  const isDisabled = resolveDisableAutoclose([MANAGED_EXEC_SESSION]);
  expect(select([makeJob()], { disable: isDisabled })).toEqual([]);
  // A different session in the disable list does NOT exempt this one.
  expect(
    select([makeJob()], {
      disable: resolveDisableAutoclose([PAIR_EXEC_SESSION]),
    }),
  ).toHaveLength(1);
});

test("the opt-out matches the LIVE session even when the birth differs", () => {
  // The live session is what a human is attached to; opt-out tests both so a
  // pane that MOVED into a debugged session is still left open.
  const job = makeJob({
    backend_exec_birth_session_id: "autopilot",
    backend_exec_session_id: PAIR_EXEC_SESSION,
  });
  expect(
    select([job], { disable: resolveDisableAutoclose([PAIR_EXEC_SESSION]) }),
  ).toEqual([]);
});

test("a glob opt-out (panels:*) leaves matching sessions open", () => {
  const isDisabled = resolveDisableAutoclose(["panels:*"]);
  const job = makeJob({
    backend_exec_birth_session_id: "panels:fn-1",
    backend_exec_session_id: "panels:fn-1",
  });
  expect(select([job], { disable: isDisabled })).toEqual([]);
  // A non-matching session still reaps.
  expect(select([makeJob()], { disable: isDisabled })).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// selectReapCandidates — cooldown + configurable grace
// ---------------------------------------------------------------------------

test("a job inside its cooldown window is suppressed; past it, re-admitted", () => {
  const cooldown = new Map<string, number>([
    ["j-1", NOW - REAP_KILL_COOLDOWN_SEC + 1],
  ]);
  expect(select([makeJob()], { cooldown })).toEqual([]);
  const expired = new Map<string, number>([
    ["j-1", NOW - REAP_KILL_COOLDOWN_SEC],
  ]);
  expect(select([makeJob()], { cooldown: expired })).toHaveLength(1);
});

test("the grace is configurable (a larger grace excludes a just-stopped window)", () => {
  // Stopped GRACE+5 ago: reapable at the default grace, NOT at a grace of GRACE+10.
  const job = makeJob({ updated_at: NOW - GRACE - 5 });
  expect(select([job])).toHaveLength(1);
  expect(select([job], { grace: GRACE + 10 })).toEqual([]);
  // A grace of 0 reaps any window stopped at least one second ago.
  expect(select([makeJob({ updated_at: NOW - 1 })], { grace: 0 })).toHaveLength(
    1,
  );
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
  session: MANAGED_EXEC_SESSION,
};

test("reaperCycle fires killWindow and stamps the cooldown for a passing candidate", async () => {
  const backend = fakeBackend();
  const cooldown = new Map<string, number>();
  // Selector returns the same candidate on both the initial select and the
  // pre-kill re-check.
  await reaperCycle(
    () => [candidate],
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
  // empty — a resume flipped the state between selection and the kill.
  const select = (): ReapCandidate[] => {
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
    () => [candidate],
    backend,
    cooldown,
    () => NOW,
  );
  // The kill was attempted (so the cooldown is stamped) and the failure did not
  // throw — the cycle resolves cleanly.
  expect(backend.kills).toEqual(["%7"]);
  expect(cooldown.get("j-1")).toBe(NOW);
});
