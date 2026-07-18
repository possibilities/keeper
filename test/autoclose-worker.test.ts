/**
 * autoclose worker (fn-1107.3) — the pure decision-core in/out matrix plus a
 * seeded-DB pulse smoke test. NO real tmux / daemon / Worker: the core takes
 * plain injected values, and the pulse test drives a fresh in-memory DB with a
 * fake pane backend (per the test-isolation rules).
 */

import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { buildAgentLaunchArgv } from "../src/agent/launch-config";
import {
  AUTOCLOSE_IDLE_MS,
  AUTOCLOSE_MAX_KILLS_PER_PULSE,
  type AutocloseJob,
  type AutoclosePulseState,
  type AutocloseWorkerMessage,
  autoclosePulse,
  type ComputeAutocloseReapsArgs,
  computeAutocloseReaps,
  parseWrappedProviderTaskId,
  readLegOwnedAttemptIds,
} from "../src/autoclose-worker";
import {
  type LaunchResult,
  type PaneInfo,
  WRAPPED_EXEC_SESSION,
} from "../src/exec-backend";
import type { ReadinessSnapshot, Verdict } from "../src/readiness";
import type { ReadinessQuery } from "../src/readiness-inputs";
import { runQuery } from "../src/server-worker";
import { freshMemDb } from "./helpers/template-db";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A stopped, autopilot-dispatched WORK worker that passes every rail. Override
 *  any field to drive an exclusion / rail case. */
const autopilotWork = (over: Partial<AutocloseJob> = {}): AutocloseJob => ({
  job_id: "j-work",
  state: "stopped",
  pid: 111,
  start_time: "100",
  plan_verb: "work",
  plan_ref: "fn-1-x.2",
  title: "work::fn-1-x.2",
  dispatch_origin: "autopilot",
  backend_exec_type: "tmux",
  backend_exec_pane_id: "%1",
  backend_exec_birth_session_id: "autopilot",
  backend_exec_generation_id: "101:1001",
  provider_leg_owned: 0,
  last_input_request_at: null,
  last_permission_prompt_at: null,
  escalation_instance: null,
  ...over,
});

/** A stopped, autopilot-dispatched CLOSE worker (plan_ref = epic id). */
const autopilotClose = (over: Partial<AutocloseJob> = {}): AutocloseJob =>
  autopilotWork({
    job_id: "j-close",
    plan_verb: "close",
    plan_ref: "fn-1-x",
    title: "close::fn-1-x",
    backend_exec_pane_id: "%2",
    ...over,
  });

/** A stopped claude panel leg that passes every rail. */
const panelLeg = (over: Partial<AutocloseJob> = {}): AutocloseJob => ({
  job_id: "j-panel",
  state: "stopped",
  pid: 222,
  start_time: "200",
  plan_verb: null,
  plan_ref: null,
  title: "panel::claude::q1",
  dispatch_origin: null,
  backend_exec_type: "tmux",
  backend_exec_pane_id: "%3",
  backend_exec_birth_session_id: "panels",
  backend_exec_generation_id: "103:1003",
  provider_leg_owned: 0,
  last_input_request_at: null,
  last_permission_prompt_at: null,
  escalation_instance: null,
  ...over,
});

/** A stopped wrapped provider leg with a canonical bare task-id title. It owns
 *  no Plan readiness row; positive stopped state is its done signal. */
const wrappedLeg = (over: Partial<AutocloseJob> = {}): AutocloseJob => ({
  job_id: "j-wrapped",
  state: "stopped",
  pid: 444,
  start_time: "400",
  plan_verb: null,
  plan_ref: null,
  title: "fn-1277-autoclose-wrapped-provider-legs.1",
  dispatch_origin: null,
  backend_exec_type: "tmux",
  backend_exec_pane_id: "%5",
  backend_exec_birth_session_id: WRAPPED_EXEC_SESSION,
  backend_exec_generation_id: "105:1005",
  provider_leg_owned: 0,
  last_input_request_at: null,
  last_permission_prompt_at: null,
  escalation_instance: null,
  ...over,
});

/** A swept pane matching the wrapped provider-leg fixture's exact identity. */
const wrappedPane = (over: Partial<PaneInfo> = {}): PaneInfo =>
  pane({
    tmuxGenerationId: "105:1005",
    paneId: "%5",
    windowId: "@5",
    sessionName: WRAPPED_EXEC_SESSION,
    windowName: "fn-1277-autoclose-wrapped-provider-legs.1",
    ...over,
  });

/** A stopped, escalation-dispatched session that passes every rail. Defaults to
 *  `unblock`; override `plan_verb`/`plan_ref`/`title` for the other two verbs.
 *  Escalation sessions launch into MANAGED_EXEC_SESSION ("autopilot"), so the
 *  pane fixture reuses the autopilot session name. Its instance is reaped only
 *  when its `job_id` is in the `escalationDone` set (the done-signal). */
const escalationSession = (over: Partial<AutocloseJob> = {}): AutocloseJob => ({
  job_id: "j-escal",
  state: "stopped",
  pid: 333,
  start_time: "300",
  plan_verb: "unblock",
  plan_ref: "fn-1-x.2",
  title: "unblock::fn-1-x.2",
  dispatch_origin: "escalation",
  backend_exec_type: "tmux",
  backend_exec_pane_id: "%4",
  backend_exec_birth_session_id: "autopilot",
  backend_exec_generation_id: "104:1004",
  provider_leg_owned: 0,
  last_input_request_at: null,
  last_permission_prompt_at: null,
  escalation_instance: 500,
  ...over,
});

/** A swept pane matching the escalation fixture's pane id + generation, in the
 *  managed ("autopilot") session. */
const escalationPane = (over: Partial<PaneInfo> = {}): PaneInfo =>
  pane({
    tmuxGenerationId: "104:1004",
    paneId: "%4",
    windowId: "@4",
    windowName: "unblock::fn-1-x.2",
    ...over,
  });

/** A swept pane matching a job's pane id and tmux generation. */
const pane = (over: Partial<PaneInfo> = {}): PaneInfo => ({
  tmuxGenerationId: "101:1001",
  paneId: "%1",
  windowId: "@1",
  currentCommand: "claude",
  paneDead: "0",
  sessionName: "autopilot",
  windowName: "work::fn-1-x.2",
  ...over,
});

const completed: Verdict = { tag: "completed" };

const readiness = (
  over: Partial<Pick<ReadinessSnapshot, "perTask" | "perCloseRow">> = {},
): Pick<ReadinessSnapshot, "perTask" | "perCloseRow"> => ({
  perTask: new Map<string, Verdict>([["fn-1-x.2", completed]]),
  perCloseRow: new Map<string, Verdict>([["fn-1-x", completed]]),
  ...over,
});

const CONFIG = { autocloseEnabled: true, autocloseGraceSeconds: 30 };
const NOW = 1_000_000;
/** A grace map whose entry is already past the 30s grace at {@link NOW}. */
const elapsed = (jobId: string): Map<string, number> =>
  new Map([[jobId, NOW - 31]]);

const run = (
  over: Partial<ComputeAutocloseReapsArgs>,
): ReturnType<typeof computeAutocloseReaps> =>
  computeAutocloseReaps({
    jobs: [],
    readiness: readiness(),
    escalationDone: new Set(),
    panes: [],
    graceMap: new Map(),
    config: CONFIG,
    autopilotPaused: false,
    now: NOW,
    ...over,
  });

// ---------------------------------------------------------------------------
// IN — the closeable classes
// ---------------------------------------------------------------------------

test("IN: autopilot work, completed + stopped, past grace → reaped", () => {
  const { reaps } = run({
    jobs: [autopilotWork()],
    panes: [pane()],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({
    jobId: "j-work",
    pid: 111,
    startTime: "100",
    paneId: "%1",
    bucket: "autopilot",
    ref: "fn-1-x.2",
  });
});

test("IN: autopilot close, completed via perCloseRow (epic id), past grace → reaped", () => {
  const { reaps } = run({
    jobs: [autopilotClose()],
    panes: [
      pane({ paneId: "%2", windowId: "@2", windowName: "close::fn-1-x" }),
    ],
    graceMap: elapsed("j-close"),
  });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({ bucket: "autopilot", ref: "fn-1-x" });
});

test("autopilot cleanup releases the exact bound claim before starting grace", () => {
  const job = autopilotWork();
  const claim = {
    verb: "work",
    id: "fn-1-x.2",
    attempt_id: 41,
    state: "bound",
    session_id: "j-work",
    dir: "/repo",
    legacy_unfenced: 0,
    acquired_at: 1,
    bound_at: 2,
    resume_acknowledged_at: null,
    released_at: null,
    last_event_id: 2,
    updated_at: 2,
  };
  const result = run({
    jobs: [job],
    panes: [pane()],
    graceMap: elapsed("j-work"),
    activityByJobId: new Map([
      [
        "j-work",
        {
          status: "quiescent" as const,
          reason: "parent-quiescent" as const,
          reservation: null,
        },
      ],
    ]),
    processIdentityByJobId: new Map([["j-work", "alive"]]),
    dispatchClaims: [claim],
  });
  expect(result.reaps).toEqual([]);
  expect(result.graceMap.has("j-work")).toBe(false);
  expect(result.claimReleases).toEqual([
    {
      kind: "autoclose-claim-release",
      verb: "work",
      id: "fn-1-x.2",
      expectedAttemptId: 41,
      sessionId: "j-work",
    },
  ]);

  const released = run({
    jobs: [job],
    panes: [pane()],
    graceMap: elapsed("j-work"),
    activityByJobId: new Map([
      [
        "j-work",
        {
          status: "quiescent" as const,
          reason: "parent-quiescent" as const,
          reservation: null,
        },
      ],
    ]),
    processIdentityByJobId: new Map([["j-work", "alive"]]),
    dispatchClaims: [{ ...claim, state: "released", released_at: NOW - 40 }],
  });
  expect(released.claimReleases).toEqual([]);
  expect(released.reaps.map((decision) => decision.jobId)).toEqual(["j-work"]);
});

test("a bound claim owning Provider legs is retained through grace/reap with zero release requests", () => {
  const job = autopilotWork();
  const claim = {
    verb: "work",
    id: "fn-1-x.2",
    attempt_id: 41,
    state: "bound",
    session_id: "j-work",
    dir: "/repo",
    legacy_unfenced: 0,
    acquired_at: 1,
    bound_at: 2,
    resume_acknowledged_at: null,
    released_at: null,
    last_event_id: 2,
    updated_at: 2,
  };
  const quiescent = new Map([
    [
      "j-work",
      {
        status: "quiescent" as const,
        reason: "parent-quiescent" as const,
        reservation: null,
      },
    ],
  ]);
  const over = {
    jobs: [job],
    panes: [pane()],
    activityByJobId: quiescent,
    processIdentityByJobId: new Map([["j-work", "alive" as const]]),
    dispatchClaims: [claim],
    legOwnedAttemptIds: new Set([41]),
  };

  // First observation: enters grace, emits NO release request, reaps nothing.
  const first = run({ ...over, graceMap: new Map() });
  expect(first.claimReleases).toEqual([]);
  expect(first.reaps).toEqual([]);
  expect(first.graceMap.has("j-work")).toBe(true);

  // Many wakes before terminality: still zero release requests — repeated
  // pulses must not grow the event stream.
  let graceMap: ReadonlyMap<string, number> = first.graceMap;
  for (let wake = 1; wake <= 25; wake++) {
    const pulse = run({ ...over, graceMap, now: NOW + wake });
    expect(pulse.claimReleases).toEqual([]);
    expect(pulse.reaps).toEqual([]);
    graceMap = pulse.graceMap;
  }

  // Past grace: the reap fires with the claim still bound and still unreleased.
  const due = run({ ...over, graceMap: elapsed("j-work") });
  expect(due.claimReleases).toEqual([]);
  expect(due.reaps.map((decision) => decision.jobId)).toEqual(["j-work"]);
});

test("an omitted legOwnedAttemptIds treats every attempt as ownerless (release-first preserved)", () => {
  const job = autopilotWork();
  const claim = {
    verb: "work",
    id: "fn-1-x.2",
    attempt_id: 41,
    state: "bound",
    session_id: "j-work",
    dir: "/repo",
    legacy_unfenced: 0,
    acquired_at: 1,
    bound_at: 2,
    resume_acknowledged_at: null,
    released_at: null,
    last_event_id: 2,
    updated_at: 2,
  };
  const result = run({
    jobs: [job],
    panes: [pane()],
    graceMap: elapsed("j-work"),
    activityByJobId: new Map([
      [
        "j-work",
        {
          status: "quiescent" as const,
          reason: "parent-quiescent" as const,
          reservation: null,
        },
      ],
    ]),
    processIdentityByJobId: new Map([["j-work", "alive"]]),
    dispatchClaims: [claim],
    legOwnedAttemptIds: new Set([999]),
  });
  expect(result.reaps).toEqual([]);
  expect(result.claimReleases).toHaveLength(1);
});

test("renewed activity, unknown probes, and recycled pids cancel autoclose", () => {
  const base = {
    jobs: [autopilotWork()],
    panes: [pane()],
    graceMap: elapsed("j-work"),
  };
  for (const activity of [
    {
      status: "active" as const,
      reason: "main-turn" as const,
      reservation: null,
    },
    {
      status: "unknown" as const,
      reason: "child-evidence-stale" as const,
      reservation: null,
    },
  ]) {
    const result = run({
      ...base,
      activityByJobId: new Map([["j-work", activity]]),
    });
    expect(result.reaps).toEqual([]);
    expect(result.graceMap.has("j-work")).toBe(false);
  }
  for (const identity of ["unknown", "recycled"] as const) {
    const result = run({
      ...base,
      activityByJobId: new Map([
        [
          "j-work",
          {
            status: "quiescent" as const,
            reason: "parent-quiescent" as const,
            reservation: null,
          },
        ],
      ]),
      processIdentityByJobId: new Map([["j-work", identity]]),
    });
    expect(result.reaps).toEqual([]);
  }
});

test("IN: panel leg, stopped past grace → reaped (no verdict needed)", () => {
  const { reaps } = run({
    jobs: [panelLeg()],
    // No readiness verdict for the panel — the panel bucket is verdict-free.
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    panes: [
      pane({
        tmuxGenerationId: "103:1003",
        paneId: "%3",
        windowId: "@3",
        sessionName: "panels",
        windowName: "panel::claude::q1",
      }),
    ],
    graceMap: elapsed("j-panel"),
  });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({ bucket: "panel", ref: "panel::claude::q1" });
});

test("IN: Pi panel launch carrier survives birth provenance and is reaped", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: ["/abs/bun", "/abs/cli/keeper.ts", "agent"],
    cli: "pi",
    prompt: "p",
    session: "panels",
  });
  const envIndex = argv.indexOf("--x-tmux-env");
  expect(envIndex).toBeGreaterThanOrEqual(0);
  const carrier = argv[envIndex + 1];
  if (!carrier?.startsWith("KEEPER_TMUX_SESSION=")) {
    throw new Error("Pi panel launch is missing its tmux session carrier");
  }
  const birthSessionId = carrier.slice("KEEPER_TMUX_SESSION=".length);
  expect(birthSessionId).toBe("panels");

  const { reaps } = run({
    jobs: [
      panelLeg({
        title: "panel::pi::q1",
        backend_exec_birth_session_id: birthSessionId,
      }),
    ],
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    panes: [
      pane({
        tmuxGenerationId: "103:1003",
        paneId: "%3",
        windowId: "@3",
        sessionName: "panels",
        windowName: "panel::pi::q1",
      }),
    ],
    graceMap: elapsed("j-panel"),
  });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({ bucket: "panel", ref: "panel::pi::q1" });
});

test("wrapped Provider-leg title parser canonicalizes bare and legacy task ids", () => {
  const taskId = "fn-1277-autoclose-wrapped-provider-legs.1";
  expect(parseWrappedProviderTaskId(taskId)).toBe(taskId);
  expect(parseWrappedProviderTaskId(`wrapped::${taskId}`)).toBe(taskId);
  expect(
    parseWrappedProviderTaskId("fn-1277-autoclose-wrapped-provider-legs"),
  ).toBeNull();
  expect(parseWrappedProviderTaskId(null)).toBeNull();
});

test("IN: wrapped provider leg with bare task-id title targets its exact pane identity", () => {
  const { reaps } = run({
    jobs: [wrappedLeg()],
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    // Deliberately unrelated display name: teardown is authorized by the birth
    // session + job title but targets only the resolved pane identity.
    panes: [
      wrappedPane({ windowName: "duplicate-display-title-is-irrelevant" }),
    ],
    graceMap: elapsed("j-wrapped"),
  });
  expect(reaps).toEqual([
    {
      jobId: "j-wrapped",
      pid: 444,
      startTime: "400",
      paneId: "%5",
      bucket: "wrapped",
      ref: "fn-1277-autoclose-wrapped-provider-legs.1",
    },
  ]);
});

test("IN: wrapped provider leg accepts the legacy wrapped:: task-id title", () => {
  const legacyTitle = "wrapped::fn-1277-autoclose-wrapped-provider-legs.1";
  const { reaps } = run({
    jobs: [wrappedLeg({ title: legacyTitle })],
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    panes: [wrappedPane({ windowName: legacyTitle })],
    graceMap: elapsed("j-wrapped"),
  });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({
    paneId: "%5",
    bucket: "wrapped",
    ref: legacyTitle,
  });
});

test("IN: escalation unblock session, resolved instance, past grace → reaped", () => {
  const { reaps } = run({
    jobs: [escalationSession()],
    panes: [escalationPane()],
    graceMap: elapsed("j-escal"),
    escalationDone: new Set(["j-escal"]),
  });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({
    jobId: "j-escal",
    pid: 333,
    startTime: "300",
    paneId: "%4",
    bucket: "escalation",
    ref: "unblock::fn-1-x.2",
  });
});

test("IN: escalation deconflict session, resolved instance, past grace → reaped", () => {
  const { reaps } = run({
    jobs: [
      escalationSession({
        plan_verb: "deconflict",
        plan_ref: "fn-1-x",
        title: "deconflict::fn-1-x",
      }),
    ],
    panes: [escalationPane({ windowName: "deconflict::fn-1-x" })],
    graceMap: elapsed("j-escal"),
    escalationDone: new Set(["j-escal"]),
  });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({
    bucket: "escalation",
    ref: "deconflict::fn-1-x",
  });
});

test("IN: escalation resolve session, resolved instance, past grace → reaped (flips the old resolve OUT rail)", () => {
  const { reaps } = run({
    jobs: [
      escalationSession({
        plan_verb: "resolve",
        plan_ref: "fn-1-x",
        title: "resolve::fn-1-x",
      }),
    ],
    panes: [escalationPane({ windowName: "resolve::fn-1-x" })],
    graceMap: elapsed("j-escal"),
    escalationDone: new Set(["j-escal"]),
  });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({
    bucket: "escalation",
    ref: "resolve::fn-1-x",
  });
});

// ---------------------------------------------------------------------------
// OUT — exclusion classes (never keeper-owned or not done)
// ---------------------------------------------------------------------------

test("OUT: durable ownership excludes a wrapped Provider leg from the legacy bucket", () => {
  const { reaps, graceMap } = run({
    jobs: [wrappedLeg({ provider_leg_owned: 1 })],
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    panes: [wrappedPane()],
    graceMap: elapsed("j-wrapped"),
  });
  expect(reaps).toEqual([]);
  expect(graceMap.has("j-wrapped")).toBe(false);
});

test("OUT: wrapped provider-leg ownership and live-topology rails fail closed", () => {
  const cases: Array<{
    name: string;
    job?: Partial<AutocloseJob>;
    pane?: Partial<PaneInfo>;
  }> = [
    { name: "working", job: { state: "working" } },
    {
      name: "wrong birth session",
      job: { backend_exec_birth_session_id: "autopilot" },
    },
    {
      name: "unresolved generation",
      job: { backend_exec_generation_id: null },
    },
    { name: "moved pane", pane: { sessionName: "manual" } },
    { name: "generation mismatch", pane: { tmuxGenerationId: "gen-other" } },
  ];
  for (const c of cases) {
    const { reaps, graceMap } = run({
      jobs: [wrappedLeg(c.job)],
      readiness: { perTask: new Map(), perCloseRow: new Map() },
      panes: [wrappedPane(c.pane)],
      graceMap: elapsed("j-wrapped"),
    });
    expect(reaps, c.name).toHaveLength(0);
    expect(graceMap.has("j-wrapped"), c.name).toBe(false);
  }
});

test("OUT: malformed wrapped provider-leg titles never authorize teardown", () => {
  const malformedTitles: Array<string | null> = [
    null,
    "",
    "fn-1277-autoclose-wrapped-provider-legs",
    "wrapped::fn-1277-autoclose-wrapped-provider-legs",
    "work::fn-1277-autoclose-wrapped-provider-legs.1",
    "wrapped::wrapped::fn-1277-autoclose-wrapped-provider-legs.1",
    "fn-no-number.1",
    "fn-1277-UPPER.1",
  ];
  for (const title of malformedTitles) {
    const { reaps } = run({
      jobs: [wrappedLeg({ title })],
      readiness: { perTask: new Map(), perCloseRow: new Map() },
      panes: [wrappedPane()],
      graceMap: elapsed("j-wrapped"),
    });
    expect(reaps, String(title)).toHaveLength(0);
  }
});

test("OUT: prompt-active wrapped provider legs remain resident", () => {
  for (const prompt of [
    { last_input_request_at: NOW - 5 },
    { last_permission_prompt_at: NOW - 5 },
  ]) {
    const { reaps } = run({
      jobs: [wrappedLeg(prompt)],
      readiness: { perTask: new Map(), perCloseRow: new Map() },
      panes: [wrappedPane()],
      graceMap: elapsed("j-wrapped"),
    });
    expect(reaps).toHaveLength(0);
  }
});

test("OUT: manual plan-form worker (dispatch_origin NULL) → never reaped", () => {
  const { reaps } = run({
    jobs: [autopilotWork({ dispatch_origin: null })],
    panes: [pane()],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: handoff worker (origin NULL, non-panels birth session) → never reaped", () => {
  const { reaps } = run({
    jobs: [
      autopilotWork({
        dispatch_origin: null,
        backend_exec_birth_session_id: "autopilot",
      }),
    ],
    panes: [pane()],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: pair / agentbus sessions → never reaped", () => {
  for (const birth of ["pair", "agentbus"]) {
    const { reaps } = run({
      // panel-shaped title but the wrong birth session → not the panel bucket.
      jobs: [panelLeg({ backend_exec_birth_session_id: birth })],
      panes: [pane({ paneId: "%3", windowId: "@3", sessionName: birth })],
      graceMap: elapsed("j-panel"),
    });
    expect(reaps).toHaveLength(0);
  }
});

test("OUT: escalation session, instance still OPEN (not in escalationDone) → never reaped (declined-session persistence)", () => {
  const { reaps } = run({
    jobs: [escalationSession()],
    panes: [escalationPane()],
    graceMap: elapsed("j-escal"),
    // Empty done set: the block/conflict instance still stands.
    escalationDone: new Set(),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: escalation session, NULL instance → never reaped (even if job id is in the done set)", () => {
  const { reaps } = run({
    jobs: [escalationSession({ escalation_instance: null })],
    panes: [escalationPane()],
    graceMap: elapsed("j-escal"),
    escalationDone: new Set(["j-escal"]),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: resolve VERB without the escalation origin stamp → never reaped (provenance, not the verb)", () => {
  // A resolve verb alone no longer qualifies: without dispatch_origin='escalation'
  // it is neither the autopilot bucket (wrong verb) nor the escalation bucket
  // (wrong origin) — the flip of the old blanket "resolve → never reaped" rail.
  const { reaps } = run({
    jobs: [
      escalationSession({
        plan_verb: "resolve",
        plan_ref: "fn-1-x",
        dispatch_origin: null,
      }),
    ],
    panes: [escalationPane({ windowName: "resolve::fn-1-x" })],
    graceMap: elapsed("j-escal"),
    escalationDone: new Set(["j-escal"]),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: escalation session, prompt-parked → never reaped", () => {
  for (const over of [
    { last_input_request_at: NOW - 5 },
    { last_permission_prompt_at: NOW - 5 },
  ]) {
    const { reaps } = run({
      jobs: [escalationSession(over)],
      panes: [escalationPane()],
      graceMap: elapsed("j-escal"),
      escalationDone: new Set(["j-escal"]),
    });
    expect(reaps).toHaveLength(0);
  }
});

test("OUT: escalation session, still working (not stopped) → never reaped", () => {
  const { reaps } = run({
    jobs: [escalationSession({ state: "working" })],
    panes: [escalationPane()],
    graceMap: elapsed("j-escal"),
    escalationDone: new Set(["j-escal"]),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: working row (not stopped) → never reaped", () => {
  const { reaps, graceMap } = run({
    jobs: [autopilotWork({ state: "working" })],
    panes: [pane()],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
  // Ineligible observation prunes the grace entry.
  expect(graceMap.has("j-work")).toBe(false);
});

test("OUT: killed row (terminal) → never reaped", () => {
  const { reaps } = run({
    jobs: [autopilotWork({ state: "killed", backend_exec_pane_id: null })],
    panes: [pane()],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: verdict not completed (ready / running / absent) → never reaped", () => {
  const running: Verdict = { tag: "running", reason: { kind: "job-running" } };
  for (const rmap of [
    new Map<string, Verdict>([["fn-1-x.2", { tag: "ready" }]]),
    new Map<string, Verdict>([["fn-1-x.2", running]]),
    new Map<string, Verdict>(), // absent
  ]) {
    const { reaps } = run({
      jobs: [autopilotWork()],
      readiness: { perTask: rmap, perCloseRow: new Map() },
      panes: [pane()],
      graceMap: elapsed("j-work"),
    });
    expect(reaps).toHaveLength(0);
  }
});

test("OUT: prompt-parked (input request OR permission prompt set) → never reaped", () => {
  for (const over of [
    { last_input_request_at: NOW - 5 },
    { last_permission_prompt_at: NOW - 5 },
  ]) {
    const { reaps } = run({
      jobs: [autopilotWork(over)],
      panes: [pane()],
      graceMap: elapsed("j-work"),
    });
    expect(reaps).toHaveLength(0);
  }
});

test("OUT: split window (two panes in the window) → never reaped", () => {
  const { reaps } = run({
    jobs: [autopilotWork()],
    panes: [
      pane(),
      // a human split: a second pane in the SAME window
      pane({ paneId: "%99", windowId: "@1", currentCommand: "zsh" }),
    ],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: dead pane (pane_dead = 1) → never reaped", () => {
  const { reaps } = run({
    jobs: [autopilotWork()],
    panes: [pane({ paneDead: "1" })],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: tmux generation mismatch → never reaped", () => {
  const { reaps } = run({
    jobs: [autopilotWork()],
    panes: [pane({ tmuxGenerationId: "999:9999" })],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: session moved out of the managed session → never reaped", () => {
  const { reaps } = run({
    jobs: [autopilotWork()],
    panes: [pane({ sessionName: "someones-other-session" })],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: generation absent → never reaped", () => {
  for (const gen of [null, ""]) {
    const { reaps } = run({
      jobs: [autopilotWork({ backend_exec_generation_id: gen })],
      panes: [pane()],
      graceMap: elapsed("j-work"),
    });
    expect(reaps).toHaveLength(0);
  }
});

test("OUT: non-tmux backend → never reaped", () => {
  const { reaps } = run({
    jobs: [autopilotWork({ backend_exec_type: null })],
    panes: [pane()],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
});

test("OUT: pane absent from the sweep → never reaped, grace pruned (double-kill suppression)", () => {
  const { reaps, graceMap } = run({
    jobs: [autopilotWork()],
    // sweep is non-empty but does NOT contain the job's pane (killed last pulse)
    panes: [pane({ paneId: "%77", windowId: "@77" })],
    graceMap: elapsed("j-work"),
  });
  expect(reaps).toHaveLength(0);
  expect(graceMap.has("j-work")).toBe(false);
});

// ---------------------------------------------------------------------------
// Pause — autopilot bucket only
// ---------------------------------------------------------------------------

test("paused suspends the autopilot bucket but NOT the panel bucket", () => {
  const both = {
    jobs: [autopilotWork(), panelLeg()],
    panes: [
      pane(),
      pane({
        tmuxGenerationId: "103:1003",
        paneId: "%3",
        windowId: "@3",
        sessionName: "panels",
        windowName: "panel::claude::q1",
      }),
    ],
    graceMap: new Map([
      ["j-work", NOW - 31],
      ["j-panel", NOW - 31],
    ]),
  };
  const { reaps } = run({ ...both, autopilotPaused: true });
  expect(reaps).toHaveLength(1);
  expect(reaps[0]).toMatchObject({ jobId: "j-panel", bucket: "panel" });
});

test("paused suspends the wrapped bucket", () => {
  const { reaps, graceMap } = run({
    jobs: [wrappedLeg()],
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    panes: [wrappedPane()],
    graceMap: elapsed("j-wrapped"),
    autopilotPaused: true,
  });
  expect(reaps).toHaveLength(0);
  expect(graceMap.has("j-wrapped")).toBe(false);
});

test("paused suspends the escalation bucket (like the autopilot bucket)", () => {
  const { reaps } = run({
    jobs: [escalationSession()],
    panes: [escalationPane()],
    graceMap: elapsed("j-escal"),
    escalationDone: new Set(["j-escal"]),
    autopilotPaused: true,
  });
  expect(reaps).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Config off-switch
// ---------------------------------------------------------------------------

test("disabled config → zero decisions and grace state CLEARED", () => {
  const { reaps, graceMap } = run({
    jobs: [autopilotWork()],
    panes: [pane()],
    graceMap: elapsed("j-work"),
    config: { autocloseEnabled: false, autocloseGraceSeconds: 30 },
  });
  expect(reaps).toHaveLength(0);
  expect(graceMap.size).toBe(0);
});

test("disabled config excludes a wrapped provider leg and clears its grace", () => {
  const { reaps, graceMap } = run({
    jobs: [wrappedLeg()],
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    panes: [wrappedPane()],
    graceMap: elapsed("j-wrapped"),
    config: { autocloseEnabled: false, autocloseGraceSeconds: 30 },
  });
  expect(reaps).toHaveLength(0);
  expect(graceMap.size).toBe(0);
});

test("re-enabling after a disable RESTARTS the grace clock (delay, never accelerate)", () => {
  // Disabled pulse clears state.
  const disabled = run({
    jobs: [autopilotWork()],
    panes: [pane()],
    graceMap: elapsed("j-work"),
    config: { autocloseEnabled: false, autocloseGraceSeconds: 30 },
  });
  expect(disabled.graceMap.size).toBe(0);

  // First enabled pulse: the clock restarts at `now` — NOT immediately due.
  const reenabled = run({
    jobs: [autopilotWork()],
    panes: [pane()],
    graceMap: disabled.graceMap,
  });
  expect(reenabled.reaps).toHaveLength(0);
  expect(reenabled.graceMap.get("j-work")).toBe(NOW);
});

// ---------------------------------------------------------------------------
// Grace clock
// ---------------------------------------------------------------------------

test("grace not yet elapsed → not reaped, first observation recorded at now", () => {
  const { reaps, graceMap } = run({
    jobs: [autopilotWork()],
    panes: [pane()],
    graceMap: new Map(), // first observation
  });
  expect(reaps).toHaveLength(0);
  expect(graceMap.get("j-work")).toBe(NOW);
});

test("wrapped provider leg before grace is ineligible for this pulse and records first observation", () => {
  const { reaps, graceMap } = run({
    jobs: [wrappedLeg()],
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    panes: [wrappedPane()],
    graceMap: new Map(),
  });
  expect(reaps).toHaveLength(0);
  expect(graceMap.get("j-wrapped")).toBe(NOW);
});

test("grace resets on an intervening ineligible observation", () => {
  // Pulse 1: eligible at t0 → recorded.
  const t0 = 1000;
  const p1 = computeAutocloseReaps({
    jobs: [autopilotWork()],
    readiness: readiness(),
    escalationDone: new Set(),
    panes: [pane()],
    graceMap: new Map(),
    config: CONFIG,
    autopilotPaused: false,
    now: t0,
  });
  expect(p1.graceMap.get("j-work")).toBe(t0);

  // Pulse 2 at t0+20: resumed (working) → pruned.
  const p2 = computeAutocloseReaps({
    jobs: [autopilotWork({ state: "working" })],
    readiness: readiness(),
    escalationDone: new Set(),
    panes: [pane()],
    graceMap: p1.graceMap,
    config: CONFIG,
    autopilotPaused: false,
    now: t0 + 20,
  });
  expect(p2.graceMap.has("j-work")).toBe(false);

  // Pulse 3 at t0+40: eligible again → clock STARTS OVER at t0+40, not yet due.
  const p3 = computeAutocloseReaps({
    jobs: [autopilotWork()],
    readiness: readiness(),
    escalationDone: new Set(),
    panes: [pane()],
    graceMap: p2.graceMap,
    config: CONFIG,
    autopilotPaused: false,
    now: t0 + 40,
  });
  expect(p3.reaps).toHaveLength(0);
  expect(p3.graceMap.get("j-work")).toBe(t0 + 40);
});

test("a quiet board (no input change) still reaps a due candidate when now advances (idle-wake path)", () => {
  const jobs = [autopilotWork()];
  const panes = [pane()];
  // Pulse 1 records the clock; nothing due yet.
  const p1 = computeAutocloseReaps({
    jobs,
    readiness: readiness(),
    escalationDone: new Set(),
    panes,
    graceMap: new Map(),
    config: CONFIG,
    autopilotPaused: false,
    now: 5000,
  });
  expect(p1.reaps).toHaveLength(0);
  // Pulse 2: identical inputs, only `now` advanced past the grace → reaped.
  const p2 = computeAutocloseReaps({
    jobs,
    readiness: readiness(),
    escalationDone: new Set(),
    panes,
    graceMap: p1.graceMap,
    config: CONFIG,
    autopilotPaused: false,
    now: 5040,
  });
  expect(p2.reaps).toHaveLength(1);
  expect(AUTOCLOSE_IDLE_MS).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Blast cap
// ---------------------------------------------------------------------------

test("blast cap enforced: > MAX due → only MAX reaped, all stay in the grace map", () => {
  const n = AUTOCLOSE_MAX_KILLS_PER_PULSE + 3;
  const jobs: AutocloseJob[] = [];
  const panes: PaneInfo[] = [];
  const graceMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = `j-${String(i).padStart(2, "0")}`;
    const paneId = `%${i}`;
    jobs.push(
      autopilotWork({
        job_id: id,
        plan_ref: "fn-1-x.2",
        backend_exec_pane_id: paneId,
      }),
    );
    panes.push(pane({ paneId, windowId: `@${i}` }));
    graceMap.set(id, NOW - 31);
  }
  const { reaps, graceMap: next } = run({ jobs, panes, graceMap });
  expect(reaps).toHaveLength(AUTOCLOSE_MAX_KILLS_PER_PULSE);
  // Deterministic job_id order → the lowest ids are the ones reaped this pulse.
  expect(reaps.map((r) => r.jobId)).toEqual([
    "j-00",
    "j-01",
    "j-02",
    "j-03",
    "j-04",
  ]);
  // Every eligible candidate — capped-out included — stays in the grace map.
  expect(next.size).toBe(n);
});

// ---------------------------------------------------------------------------
// Degraded / empty sweep
// ---------------------------------------------------------------------------

test("wrapped blast cap is deterministic and retains capped-out candidates", () => {
  const count = AUTOCLOSE_MAX_KILLS_PER_PULSE + 3;
  const jobs: AutocloseJob[] = [];
  const panes: PaneInfo[] = [];
  const graceMap = new Map<string, number>();
  for (let i = count - 1; i >= 0; i--) {
    const suffix = String(i).padStart(2, "0");
    const jobId = `wrapped-${suffix}`;
    const paneId = `%w${suffix}`;
    jobs.push(wrappedLeg({ job_id: jobId, backend_exec_pane_id: paneId }));
    panes.push(wrappedPane({ paneId, windowId: `@w${suffix}` }));
    graceMap.set(jobId, NOW - 31);
  }

  const result = run({
    jobs,
    panes,
    graceMap,
    readiness: { perTask: new Map(), perCloseRow: new Map() },
  });
  expect(result.reaps.map((reap) => reap.jobId)).toEqual([
    "wrapped-00",
    "wrapped-01",
    "wrapped-02",
    "wrapped-03",
    "wrapped-04",
  ]);
  expect(result.reaps.every((reap) => reap.bucket === "wrapped")).toBe(true);
  expect(result.graceMap.size).toBe(count);
});

test("wrapped pane already absent from a live server is converged without a title-derived target", () => {
  const { reaps, graceMap } = run({
    jobs: [wrappedLeg()],
    readiness: { perTask: new Map(), perCloseRow: new Map() },
    panes: [pane({ paneId: "%unrelated", windowId: "@unrelated" })],
    graceMap: elapsed("j-wrapped"),
  });
  expect(reaps).toEqual([]);
  expect(graceMap.has("j-wrapped")).toBe(false);
});

test("degraded sweep (null) → zero decisions, grace PRESERVED", () => {
  const incoming = elapsed("j-work");
  const { reaps, graceMap } = run({
    jobs: [autopilotWork()],
    panes: null,
    graceMap: incoming,
  });
  expect(reaps).toHaveLength(0);
  expect(graceMap.get("j-work")).toBe(NOW - 31);
});

test("empty sweep → zero decisions, grace PRESERVED", () => {
  const incoming = elapsed("j-work");
  const { reaps, graceMap } = run({
    jobs: [autopilotWork()],
    panes: [],
    graceMap: incoming,
  });
  expect(reaps).toHaveLength(0);
  expect(graceMap.get("j-work")).toBe(NOW - 31);
});

// ---------------------------------------------------------------------------
// Pulse smoke test — seeded in-memory DB + fake backend (no real tmux/Worker)
// ---------------------------------------------------------------------------

test("autoclosePulse: a due panel leg posts one intent hint BEFORE the kill", async () => {
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO jobs
       (job_id, created_at, updated_at, state, title, plan_verb, plan_ref,
        dispatch_origin, backend_exec_type, backend_exec_pane_id,
        backend_exec_birth_session_id, backend_exec_generation_id,
        last_input_request_at, last_permission_prompt_at, pid, start_time)
     VALUES
       ('paneljob', 1, 1, 'stopped', 'panel::claude::q1', NULL, NULL,
        NULL, 'tmux', '%9', 'panels', '109:1009', NULL, NULL, 4242, '55')`,
  );

  const killed: string[] = [];
  const intents: AutocloseWorkerMessage[] = [];
  const backend = {
    listPanes: async (): Promise<PaneInfo[] | null> => [
      pane({
        tmuxGenerationId: "109:1009",
        paneId: "%9",
        windowId: "@9",
        sessionName: "panels",
        windowName: "panel::claude::q1",
      }),
    ],
    killWindow: async (paneId: string): Promise<LaunchResult> => {
      // The hint must already be posted by the time the kill fires.
      expect(intents).toHaveLength(1);
      killed.push(paneId);
      return { ok: true };
    },
  };

  let clock = 1000;
  const state: AutoclosePulseState = { graceMap: new Map() };
  const deps = {
    resolveConfig: () => CONFIG,
    now: () => clock,
    postIntent: (m: AutocloseWorkerMessage) => intents.push(m),
    noteLine: () => {},
  };

  // Pulse 1: observes eligibility, records the grace clock, kills nothing.
  await autoclosePulse(db, backend, state, deps);
  expect(killed).toHaveLength(0);
  expect(intents).toHaveLength(0);
  expect(state.graceMap.get("paneljob")).toBe(1000);

  // Pulse 2: grace elapsed → one intent hint then one kill.
  clock = 1040;
  await autoclosePulse(db, backend, state, deps);
  expect(killed).toEqual(["%9"]);
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({
    kind: "autoclose-intent",
    jobId: "paneljob",
    pid: 4242,
    startTime: "55",
    paneId: "%9",
    bucket: "panel",
    ref: "panel::claude::q1",
  });

  db.close();
});

test("autoclosePulse: a durable ownership row excludes the wrapped leg from the legacy bucket", async () => {
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at)
       VALUES (1, 0, 0, 0, 0)`,
  );
  db.run(
    `INSERT INTO jobs
       (job_id, created_at, updated_at, state, title, plan_verb, plan_ref,
        dispatch_origin, backend_exec_type, backend_exec_pane_id,
        backend_exec_birth_session_id, backend_exec_generation_id,
        last_input_request_at, last_permission_prompt_at, pid, start_time)
     VALUES
       ('ownedwrapped', 1, 1, 'stopped', 'fn-1300-cascade.4', NULL, NULL,
        NULL, 'tmux', '%5', 'wrapped', '105:1005', NULL, NULL, 444, '400')`,
  );
  db.run(
    `INSERT INTO provider_leg_ownership
       (leg_launch_id, wrapper_job_id, wrapper_dispatch_attempt_id,
        ownership_epoch_event_id, leg_session_id, pane_id, pane_generation,
        backend_exec_type, backend_exec_session_id, state, last_event_id,
        created_at, updated_at)
     VALUES
       ('launch-owned', 'wrapper', 7, 9, 'ownedwrapped', '%5', '105:1005',
        'tmux', 'wrapped', 'live', 9, 1, 1)`,
  );

  const killed: string[] = [];
  const state: AutoclosePulseState = {
    graceMap: new Map([["ownedwrapped", 1]]),
  };
  await autoclosePulse(
    db,
    {
      listPanes: async () => [wrappedPane()],
      killWindow: async (paneId) => {
        killed.push(paneId);
        return { ok: true };
      },
    },
    state,
    {
      resolveConfig: () => CONFIG,
      now: () => 1_000,
      postIntent: () => {},
      noteLine: () => {},
      isPidAlive: () => false,
    },
  );
  expect(killed).toEqual([]);
  expect(state.graceMap.has("ownedwrapped")).toBe(false);
  db.close();
});

test("readLegOwnedAttemptIds: distinct attempt ids from the ownership projection", () => {
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO provider_leg_ownership
       (leg_launch_id, wrapper_job_id, wrapper_dispatch_attempt_id,
        ownership_epoch_event_id, leg_session_id, pane_id, pane_generation,
        backend_exec_type, backend_exec_session_id, state, last_event_id,
        created_at, updated_at)
     VALUES
       ('launch-a', 'wrapper-1', 7, 9, 'leg-a', '%5', '105:1005',
        'tmux', 'wrapped', 'live', 9, 1, 1),
       ('launch-b', 'wrapper-1', 7, 9, 'leg-b', '%6', '105:1006',
        'tmux', 'wrapped', 'terminal', 9, 1, 1),
       ('launch-c', 'wrapper-2', 12, 9, 'leg-c', '%7', '105:1007',
        'tmux', 'wrapped', 'live', 9, 1, 1)`,
  );
  expect(readLegOwnedAttemptIds(db)).toEqual(new Set([7, 12]));
  db.close();
});

test("autoclosePulse: failed exact wrapped kill preserves eligibility and retries the same pane", async () => {
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at)
       VALUES (1, 0, 0, 0, 0)`,
  );
  db.run(
    `INSERT INTO jobs
       (job_id, created_at, updated_at, state, title, plan_verb, plan_ref,
        dispatch_origin, backend_exec_type, backend_exec_pane_id,
        backend_exec_birth_session_id, backend_exec_generation_id,
        last_input_request_at, last_permission_prompt_at, pid, start_time)
     VALUES
       ('wrappedjob', 1, 1, 'stopped', 'fn-1277-autoclose-wrapped-provider-legs.1', NULL, NULL,
        NULL, 'tmux', '%5', 'wrapped', '105:1005', NULL, NULL, 444, '400')`,
  );

  const killed: string[] = [];
  const intents: AutocloseWorkerMessage[] = [];
  const notes: string[] = [];
  let paneStillLive = true;
  const backend = {
    listPanes: async (): Promise<PaneInfo[] | null> =>
      paneStillLive
        ? [wrappedPane()]
        : [pane({ paneId: "%other", windowId: "@other" })],
    killWindow: async (paneId: string): Promise<LaunchResult> => {
      killed.push(paneId);
      return { ok: false, error: "injected exact kill failure" };
    },
  };
  const state: AutoclosePulseState = {
    graceMap: new Map([["wrappedjob", 1]]),
  };
  const deps = {
    resolveConfig: () => CONFIG,
    now: () => 1000,
    postIntent: (intent: AutocloseWorkerMessage) => intents.push(intent),
    noteLine: (line: string) => notes.push(line),
    isPidAlive: () => false,
  };

  await autoclosePulse(db, backend, state, deps);
  await autoclosePulse(db, backend, state, deps);
  expect(killed).toEqual(["%5", "%5"]);
  expect(
    intents
      .filter((intent) => intent.kind === "autoclose-intent")
      .map((intent) => intent.paneId),
  ).toEqual(["%5", "%5"]);
  expect(state.graceMap.get("wrappedjob")).toBe(1);
  expect(notes.every((line) => line.startsWith("close deferred"))).toBe(true);

  // Once a later live sweep positively shows the exact pane absent, cleanup is
  // converged and the stale grace entry is removed without another kill.
  paneStillLive = false;
  await autoclosePulse(db, backend, state, deps);
  expect(killed).toEqual(["%5", "%5"]);
  expect(state.graceMap.has("wrappedjob")).toBe(false);
  db.close();
});

test("autoclosePulse: disappearance of the last wrapped window is a normal no-op on the next pulse", async () => {
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at)
       VALUES (1, 0, 0, 0, 0)`,
  );
  db.run(
    `INSERT INTO jobs
       (job_id, created_at, updated_at, state, title, plan_verb, plan_ref,
        dispatch_origin, backend_exec_type, backend_exec_pane_id,
        backend_exec_birth_session_id, backend_exec_generation_id,
        last_input_request_at, last_permission_prompt_at, pid, start_time)
     VALUES
       ('lastwrapped', 1, 1, 'stopped', 'fn-1-x.1', NULL, NULL,
        NULL, 'tmux', '%5', 'wrapped', '105:1005', NULL, NULL, 444, '400')`,
  );

  let sessionExists = true;
  const killed: string[] = [];
  const state: AutoclosePulseState = {
    graceMap: new Map([["lastwrapped", 1]]),
  };
  const backend = {
    listPanes: async (): Promise<PaneInfo[] | null> =>
      sessionExists ? [wrappedPane()] : [],
    killWindow: async (paneId: string): Promise<LaunchResult> => {
      killed.push(paneId);
      sessionExists = false;
      return { ok: true };
    },
  };
  const deps = {
    resolveConfig: () => CONFIG,
    now: () => 1000,
    postIntent: () => {},
    noteLine: () => {},
    isPidAlive: () => false,
  };

  await autoclosePulse(db, backend, state, deps);
  await autoclosePulse(db, backend, state, deps);
  expect(killed).toEqual(["%5"]);
  db.close();
});

test("autoclosePulse: disabled config kills nothing and clears grace state", async () => {
  const { db } = freshMemDb();
  const state: AutoclosePulseState = { graceMap: new Map([["stale", 1]]) };
  let listed = false;
  const backend = {
    listPanes: async (): Promise<PaneInfo[] | null> => {
      listed = true;
      return [];
    },
    killWindow: async (): Promise<LaunchResult> => ({ ok: true }),
  };
  await autoclosePulse(db, backend, state, {
    resolveConfig: () => ({
      autocloseEnabled: false,
      autocloseGraceSeconds: 30,
    }),
    now: () => 1000,
    postIntent: () => {},
    noteLine: () => {},
  });
  // Disabled short-circuits BEFORE the sweep and clears state.
  expect(listed).toBe(false);
  expect(state.graceMap.size).toBe(0);
  db.close();
});

// ---------------------------------------------------------------------------
// Pulse smoke test — escalation bucket done-signal against the real tables
// ---------------------------------------------------------------------------

/** Seed an UNPAUSED autopilot + one stopped escalation session (pane %9 / 109:1009,
 *  in the managed "autopilot" session). The escalation bucket is pause-suspended,
 *  so the state row must exist with paused=0. */
const seedEscalationPulse = (
  db: Database,
  opts: { verb: string; ref: string; instance: number },
): void => {
  db.run(
    `INSERT INTO autopilot_state (id, paused, last_event_id, created_at, updated_at)
       VALUES (1, 0, 0, 0, 0)`,
  );
  db.run(
    `INSERT INTO jobs
       (job_id, created_at, updated_at, state, title, plan_verb, plan_ref,
        dispatch_origin, backend_exec_type, backend_exec_pane_id,
        backend_exec_birth_session_id, backend_exec_generation_id,
        last_input_request_at, last_permission_prompt_at, pid, start_time,
        escalation_instance)
     VALUES
       ('escaljob', 1, 1, 'stopped', ?, ?, ?,
        'escalation', 'tmux', '%9', 'autopilot', '109:1009', NULL, NULL, 4242, '55',
        ?)`,
    [`${opts.verb}::${opts.ref}`, opts.verb, opts.ref, opts.instance],
  );
};

const escalationBackend = (killed: string[], windowName: string) => ({
  listPanes: async (): Promise<PaneInfo[] | null> => [
    pane({
      tmuxGenerationId: "109:1009",
      paneId: "%9",
      windowId: "@9",
      sessionName: "autopilot",
      windowName,
    }),
  ],
  killWindow: async (paneId: string): Promise<LaunchResult> => {
    killed.push(paneId);
    return { ok: true };
  },
});

const jobsReadError: ReadinessQuery = (db, worldRev, frame, out, nowSec) => {
  if (frame.collection === "jobs") {
    return {
      type: "error",
      id: frame.id,
      collection: "jobs",
      rev: worldRev,
      code: "read_failed",
      message: "jobs unavailable",
    };
  }
  return runQuery(db, worldRev, frame, out, nowSec);
};

test("autoclosePulse: an errored jobs read defers reaping and preserves grace", async () => {
  const { db } = freshMemDb();
  db.run(
    `INSERT INTO jobs
       (job_id, created_at, updated_at, state, title, plan_verb, plan_ref,
        dispatch_origin, backend_exec_type, backend_exec_pane_id,
        backend_exec_birth_session_id, backend_exec_generation_id,
        last_input_request_at, last_permission_prompt_at, pid, start_time)
     VALUES
       ('paneljob', 1, 1, 'stopped', 'panel::claude::q1', NULL, NULL,
        NULL, 'tmux', '%9', 'panels', '109:1009', NULL, NULL, 4242, '55')`,
  );

  const killed: string[] = [];
  const intents: AutocloseWorkerMessage[] = [];
  const state: AutoclosePulseState = {
    graceMap: new Map([["paneljob", 1]]),
  };
  await autoclosePulse(
    db,
    {
      listPanes: async () => [
        pane({
          tmuxGenerationId: "109:1009",
          paneId: "%9",
          windowId: "@9",
          sessionName: "panels",
          windowName: "panel::claude::q1",
        }),
      ],
      killWindow: async (paneId: string) => {
        killed.push(paneId);
        return { ok: true };
      },
    },
    state,
    {
      resolveConfig: () => CONFIG,
      now: () => 1_000,
      postIntent: (intent) => intents.push(intent),
      noteLine: () => {},
      readinessQuery: jobsReadError,
    },
  );

  expect(killed).toEqual([]);
  expect(intents).toEqual([]);
  expect(state.graceMap.get("paneljob")).toBe(1);
  db.close();
});

test("autoclosePulse: a due unblock session whose block instance is resolved is reaped", async () => {
  const { db } = freshMemDb();
  seedEscalationPulse(db, { verb: "unblock", ref: "fn-x.2", instance: 500 });
  // No block_escalations row carries blocked_since=500 → the instance is resolved.

  const killed: string[] = [];
  const intents: AutocloseWorkerMessage[] = [];
  const backend = escalationBackend(killed, "unblock::fn-x.2");
  let clock = 1000;
  const state: AutoclosePulseState = { graceMap: new Map() };
  const deps = {
    resolveConfig: () => CONFIG,
    now: () => clock,
    postIntent: (m: AutocloseWorkerMessage) => intents.push(m),
    noteLine: () => {},
  };

  // Pulse 1 records the grace clock; nothing due yet.
  await autoclosePulse(db, backend, state, deps);
  expect(killed).toHaveLength(0);
  expect(state.graceMap.get("escaljob")).toBe(1000);

  // Pulse 2: grace elapsed → one kill, tagged the escalation bucket.
  clock = 1040;
  await autoclosePulse(db, backend, state, deps);
  expect(killed).toEqual(["%9"]);
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({
    kind: "autoclose-intent",
    jobId: "escaljob",
    bucket: "escalation",
    ref: "unblock::fn-x.2",
  });
  db.close();
});

test("autoclosePulse: a deconflict session whose close conflict instance is still OPEN is not reaped", async () => {
  const { db } = freshMemDb();
  seedEscalationPulse(db, { verb: "deconflict", ref: "fn-x", instance: 500 });
  // A close::fn-x sticky STILL carries instance_event_id=500 → conflict open.
  db.run(
    `INSERT INTO dispatch_failures
       (verb, id, reason, ts, last_event_id, created_at, updated_at, instance_event_id)
     VALUES ('close', 'fn-x', 'merge conflict', 0, 500, 0, 0, 500)`,
  );

  const killed: string[] = [];
  const backend = escalationBackend(killed, "deconflict::fn-x");
  // Pre-seed the grace clock already elapsed: an eligible job WOULD reap now, so
  // the empty kill list proves the still-open instance gated it (not the clock).
  const state: AutoclosePulseState = { graceMap: new Map([["escaljob", 1]]) };
  await autoclosePulse(db, backend, state, {
    resolveConfig: () => CONFIG,
    now: () => 1000,
    postIntent: () => {},
    noteLine: () => {},
  });
  expect(killed).toHaveLength(0);
  db.close();
});

test("autoclosePulse: a degraded done-signal read skips the pulse and reaps nothing", async () => {
  const { db } = freshMemDb();
  seedEscalationPulse(db, { verb: "unblock", ref: "fn-x.2", instance: 500 });
  // Force the unblock done-signal read to THROW (only readEscalationDoneJobIds
  // reads this table; readiness does not) — a degraded read must fail closed.
  db.run("DROP TABLE block_escalations");

  const killed: string[] = [];
  const notes: string[] = [];
  // Pre-seed the grace clock already past grace: absent the degradation, this
  // pulse WOULD reap. The throw is the only thing standing between it and a kill.
  const state: AutoclosePulseState = { graceMap: new Map([["escaljob", 1]]) };
  const backend = escalationBackend(killed, "unblock::fn-x.2");
  await autoclosePulse(db, backend, state, {
    resolveConfig: () => CONFIG,
    now: () => 1000,
    postIntent: () => {},
    noteLine: (l: string) => notes.push(l),
  });

  expect(killed).toHaveLength(0);
  // Grace PRESERVED — the skip is a non-observation, never a reset.
  expect(state.graceMap.get("escaljob")).toBe(1);
  expect(notes.some((n) => n.includes("done-signal read failed"))).toBe(true);
  db.close();
});
