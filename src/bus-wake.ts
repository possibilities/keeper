/**
 * `keeper bus wake planner@<epic>` — resume an offline epic-creator session into
 * the dedicated `agentbus` tmux session so a queued `planner@<epic>` escalation
 * (durably persisted by fn-918 task .1) is redelivered and acted on.
 *
 * Client-side ONLY — this runs in the `keeper bus wake` CLI process. The wake is
 * NEVER the bus socket, NEVER a daemon RPC, and NEVER `src/wake-worker.ts` (that
 * is the unrelated `data_version` re-drain pump — a name-collision hazard). The
 * bus relay does not spawn anything; resume is entirely the CLI verb's job.
 *
 * Layering: every decision function here is PURE over its inputs (the resolved
 * creator job row, the live-channel set, a clock, the cooldown record). The impure
 * edges — the keeper.db read, the bus.db read, the resume launch, the lock, the
 * cooldown file — are injected as deps by {@link runWake}, so the resolve →
 * liveness-recheck → single-flight → cooldown → launch pipeline unit-tests with an
 * injected `launch`/`now`/`fs` and no real tmux/daemon/process. The launch is
 * keeper's sole transport — {@link keeperAgentLaunch} in resume mode — so the woken
 * window is keeper-agent-owned and managed-reaped like every other keeper launch.
 *
 * Security: the resume TARGET is trusted plan data — the epic's `job_links`
 * creator edge from keeper.db — never a sender's claim. The resolved `job_id` is
 * the session keeper will `claude --resume`, validated to a real `jobs` row before
 * launch. A failed launch is fail-open: the queued message stays and `/work` Phase
 * 2c has already fallen back.
 */

import { harnessOrClaude } from "./agent/harness";
import {
  AGENTBUS_EXEC_SESSION,
  keeperAgentLaunch,
  type LaunchResult,
} from "./exec-backend";
import { resumeTarget } from "./resume-descriptor";
import { deriveHarnessActivity } from "./session-activity";

/**
 * The minimal `jobs`-row slice a wake reads — decoupled from the full {@link
 * import("./types").Job} so the resolve/liveness/launch pipeline unit-tests with a
 * tiny synthetic row. `job_id` feeds {@link resumeTarget} (the exact session-UUID
 * `--resume` key); `title` mirrors the `jobs` projection row so a real row stays
 * assignable directly. `cwd` is the
 * directory the resumed window opens in (set on the `keeperAgentLaunch` spawn —
 * keeper agent reads its own `process.cwd()`, not interpolated into the launch body);
 * `state` is the running-liveness signal; `backend_exec_pane_id` is
 * the live-pane liveness signal (a `stopped` row whose pane is still listed is
 * live); `updated_at` is the newest-creator tiebreaker. Field names + types match
 * `Job` so a real `jobs` row is assignable directly.
 */
export interface WakeCreator {
  job_id: string;
  cwd: string | null;
  title: string | null;
  state: string;
  backend_exec_pane_id: string | null;
  updated_at: number;
  /** Launching harness (`jobs.harness`); NULL reads as claude. Creators are claude
   *  today, but the resume routes through the harness descriptor path, so the wake
   *  stops ASSUMING claude — a non-claude creator resumes via its own verb. */
  harness?: string | null;
  /** Harness-native resume target (`jobs.resume_target`) — the token
   *  {@link resumeTarget} returns for a non-claude creator (claude uses `job_id`). */
  resume_target?: string | null;
  monitors?: unknown;
  has_live_worker_monitor?: unknown;
  dispatchClaim?: WakeDispatchClaim | null;
}

export interface WakeDispatchClaim {
  verb: string;
  id: string;
  attempt_id: number | null;
  state: string;
  session_id: string | null;
  legacy_unfenced: number;
}

/**
 * Cooldown window (ms) after a failed wake of one session before another wake of
 * the SAME session is attempted — a circuit-breaker against thrash when a creator
 * keeps failing to come back. A SUCCESSFUL launch clears the record, so a healthy
 * wake never sits in cooldown. Unit: MILLISECONDS.
 */
export const WAKE_COOLDOWN_MS = 60_000;

/** A persisted per-session cooldown record. `failures` is the consecutive failed
 *  wake count; `last_failure_ms` is the epoch-ms of the most recent failure. */
export interface WakeCooldownRecord {
  failures: number;
  last_failure_ms: number;
}

/**
 * The terminal outcome of a wake attempt. Every value is a deliberate, non-throwing
 * verdict the CLI maps to a one-line message + exit code:
 *  - `launched`        — a `claude --resume` was spawned into `agentbus`.
 *  - `already_live`    — the creator is on the bus / running; no resume needed.
 *  - `in_flight`       — another wake of this session holds the single-flight lock.
 *  - `cooldown`        — a recent failed wake is still inside {@link WAKE_COOLDOWN_MS}.
 *  - `unknown_creator` — the role address resolved to no usable `jobs` row.
 *  - `launch_failed`   — `keeperAgentLaunch` returned `{ ok: false }` (fail-open).
 */
export type WakeOutcome =
  | "launched"
  | "already_live"
  | "claim_conflict"
  | "acknowledgement_missed"
  | "in_flight"
  | "cooldown"
  | "unknown_creator"
  | "launch_failed";

/** The structured wake result the CLI renders. `sessionId` is the resolved creator
 *  `job_id` (null when resolution failed); `detail` is a short human reason. */
export interface WakeResult {
  outcome: WakeOutcome;
  sessionId: string | null;
  detail: string;
}

/**
 * Is the creator already live — so a `claude --resume` would be a redundant (and
 * hazardous) double-attach to a session already running? Three independent
 * signals, ANY positive means skip: (1) a live bus channel keyed on the creator's
 * stable `session_id` (the creator returned and re-armed `keeper bus watch`), (2)
 * the `jobs.state` reads as a running state, or (3) the creator is `stopped` but
 * its `backend_exec_pane_id` is still listed in the live-pane set — a stopped
 * session whose tmux pane is alive (held open by the launch wrapper's trailing
 * login shell) that has NOT re-armed `keeper bus watch`, the exact case the bus +
 * state signals miss. This mirrors the autopilot's `isStoppedJobLive`
 * (`src/autopilot-worker.ts`). On doubt, treat as live and SKIP — a double
 * `claude --resume` of a live id is the hazard the recheck guards against: a
 * `null` `livePaneIds` (probe unavailable) is therefore treated as live via
 * signal (3), the conservative on-doubt-SKIP fallback (see `isStoppedPaneLive`
 * and `WakeDeps.livePaneIds`). Pure over `(job, liveSessionIds, livePaneIds)`.
 */
export function creatorIsLive(
  job: WakeCreator,
  liveSessionIds: ReadonlySet<string>,
  livePaneIds: ReadonlySet<string> | null,
): boolean {
  if (job.dispatchClaim == null) {
    return (
      liveSessionIds.has(job.job_id) ||
      isRunningState(job.state) ||
      isStoppedPaneLive(job, livePaneIds)
    );
  }
  return deriveHarnessActivity({ parent: job }).status !== "quiescent";
}

export function claimAuthorizesResume(
  job: WakeCreator,
  claim: WakeDispatchClaim,
): boolean {
  return (
    claim.attempt_id !== null &&
    Number.isSafeInteger(claim.attempt_id) &&
    claim.attempt_id > 0 &&
    claim.legacy_unfenced === 0 &&
    claim.session_id === job.job_id &&
    claim.state !== "released"
  );
}

/** The `jobs.state` values that mean "this session is currently alive". A wake
 *  targets a session that has stopped/ended/been killed — never a working one. */
export function isRunningState(state: string | null | undefined): boolean {
  return state === "working";
}

/**
 * Is a `stopped` creator's backend pane still LIVE — the pane is listed in
 * `livePaneIds` so the session is alive despite not being on the bus? Mirrors the
 * autopilot's `isStoppedJobLive`: a `null` `livePaneIds` (probe unavailable) is
 * treated as live (the conservative "on doubt, SKIP the resume" fallback — never
 * trade a probe failure for a double-attach), and a row with no recorded
 * `backend_exec_pane_id` is not live-provable so reads as not-live here. Only a
 * `stopped` row consults the pane set — a `working` row already short-circuits to
 * live, and any other state is genuinely gone. Pure over `(job, livePaneIds)`.
 */
export function isStoppedPaneLive(
  job: WakeCreator,
  livePaneIds: ReadonlySet<string> | null,
): boolean {
  if (job.state !== "stopped") {
    return false;
  }
  if (livePaneIds === null) {
    return true;
  }
  const paneId = job.backend_exec_pane_id;
  if (paneId == null || paneId === "") {
    return false;
  }
  return livePaneIds.has(paneId);
}

/**
 * Decide whether a wake is currently gated by cooldown. A record with a recent
 * failure inside {@link WAKE_COOLDOWN_MS} of `nowMs` gates the attempt; an absent
 * record, an old failure, or a zero-failure record does not. Pure over `(record,
 * nowMs, cooldownMs)`.
 */
export function inCooldown(
  record: WakeCooldownRecord | null,
  nowMs: number,
  cooldownMs: number = WAKE_COOLDOWN_MS,
): boolean {
  if (record == null || record.failures <= 0) {
    return false;
  }
  return nowMs - record.last_failure_ms < cooldownMs;
}

/**
 * Resolve the creator `jobs` row for a `planner@<epic>` wake from a list of
 * candidate creator `job_id`s (the caller derives these via `roleJobIds(db,
 * "creator", epic)`). Picks the single resolvable `jobs` row; with more than one
 * creator edge, prefers a row with a usable resume coordinate, newest by
 * `updated_at`. Returns null when no candidate maps to a `jobs` row. Pure over
 * `(jobRows)`.
 */
export function pickCreatorJob(jobRows: WakeCreator[]): WakeCreator | null {
  if (jobRows.length === 0) {
    return null;
  }
  // Deterministic newest-first: a creator may have more than one edge; the most
  // recently active row is the one to resume.
  const sorted = [...jobRows].sort(
    (a, b) => b.updated_at - a.updated_at || a.job_id.localeCompare(b.job_id),
  );
  return sorted[0];
}

/** Injectable seams for {@link runWake} — every impure edge arrives as a dep so
 *  the orchestration unit-tests with no real tmux/daemon/process/fs. */
export interface WakeDeps {
  /** The absolute `keeper agent` launcher prefix
   *  (`[<bun>, <abs cli/keeper.ts>, "agent"]` from `buildLauncherArgvPrefix`),
   *  resolved by the caller (impure: reads `process.execPath` +
   *  `resolveKeeperAgentPathDepFree`) and INJECTED so {@link runWake} stays pure.
   *  Threaded to {@link keeperAgentLaunch} as the launch-argv prefix. */
  readonly launcherPrefix: string[];
  /** Resolve the creator `jobs` rows for `(role=creator, epic)`. Returns the rows
   *  (already decoded), or `[]` on a miss. */
  readonly resolveCreatorJobs: (epic: string) => WakeCreator[];
  /** The set of session_ids currently connected to the bus (liveness signal). */
  readonly liveSessionIds: () => ReadonlySet<string>;
  /** The set of LIVE tmux pane ids from a read-time `list-panes -a` sweep — the
   *  live-pane liveness signal for a `stopped` creator. `null` means the probe
   *  was UNAVAILABLE (degraded / missing tmux); a stopped row then reads as live
   *  (the conservative "on doubt, SKIP the resume" fallback). */
  readonly livePaneIds: () => ReadonlySet<string> | null;
  /** Read the persisted cooldown record for a session, or null when none. */
  readonly readCooldown: (sessionId: string) => WakeCooldownRecord | null;
  /** Persist (or clear, when `record` is null) the cooldown record for a session. */
  readonly writeCooldown: (
    sessionId: string,
    record: WakeCooldownRecord | null,
  ) => void;
  /** Acquire the per-session single-flight lock NON-BLOCKING. Returns a release
   *  handle, or null when another wake of this session holds it. */
  readonly tryLock: (sessionId: string) => { release: () => void } | null;
  /** The resume launch transport. Carries the RESUME TARGET + harness (not a
   *  pre-wrapped argv) — `keeperAgentLaunch` builds the harness's own resume
   *  invocation and owns the tmux window. Defaults to {@link defaultWakeLaunch}
   *  (the real `keeperAgentLaunch` path); injected by tests. */
  readonly launch?: (
    session: string,
    resumeTarget: string,
    cwd: string,
    harness: string,
    attemptId?: number,
  ) => Promise<LaunchResult>;
  /** Persist an exact-attempt resume request before launch. */
  readonly requestResume?: (claim: WakeDispatchClaim) => boolean;
  /** Confirm that the resumed lifecycle accepted the exact attempt. */
  readonly awaitResumeAccepted?: (claim: WakeDispatchClaim) => Promise<boolean>;
  /** Revoke the old exact attempt after a missed acknowledgement. */
  readonly revokeAttempt?: (claim: WakeDispatchClaim) => boolean;
  /** Clock (epoch-ms). */
  readonly now: () => number;
  /** Warn sink for non-fatal launch diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/**
 * Run a wake of the epic's offline creator. The full client-side pipeline:
 *
 *  1. Resolve the creator `jobs` row from the epic's `job_links` creator edge(s)
 *     ({@link pickCreatorJob}). No row → `unknown_creator`.
 *  2. Liveness recheck ({@link creatorIsLive}): the creator is on the bus,
 *     running, or `stopped` with a live tmux pane → `already_live`, SKIP (a double
 *     `claude --resume` of a live id is the hazard).
 *  3. Single-flight: acquire the per-session NON-BLOCKING lock. Held by another
 *     concurrent wake → `in_flight`, SKIP (TOCTOU double-spawn guard — `has-session`
 *     alone is racy).
 *  4. Cooldown ({@link inCooldown}): a recent failed wake still inside the window →
 *     `cooldown`, SKIP.
 *  5. Launch via {@link keeperAgentLaunch} in resume mode into `agentbus`
 *     (keeper agent mints + owns the window, re-attaches via `--resume <target>`);
 *     fail-open on `{ ok: false }` → `launch_failed`, bump the cooldown record. On
 *     success, clear the cooldown record (no marker stamp — keeper agent owns + reaps
 *     its own window).
 *
 * NEVER throws — every edge degrades to a verdict. The lock is always released.
 */
export async function runWake(
  epic: string,
  deps: WakeDeps,
): Promise<WakeResult> {
  const note = deps.noteLine ?? (() => {});
  const launch = deps.launch ?? defaultWakeLaunch(deps.launcherPrefix, note);

  const job = pickCreatorJob(deps.resolveCreatorJobs(epic));
  if (job === null) {
    return {
      outcome: "unknown_creator",
      sessionId: null,
      detail: `no creator session resolved for planner@${epic}`,
    };
  }
  const sessionId = job.job_id;
  const claim = job.dispatchClaim ?? null;
  if (claim !== null && !claimAuthorizesResume(job, claim)) {
    return {
      outcome: "claim_conflict",
      sessionId,
      detail: `creator ${sessionId} does not own an exact resumable Dispatch claim`,
    };
  }

  if (creatorIsLive(job, deps.liveSessionIds(), deps.livePaneIds())) {
    return {
      outcome: "already_live",
      sessionId,
      detail: `creator ${sessionId} is already live; no resume needed`,
    };
  }

  const lock = deps.tryLock(sessionId);
  if (lock === null) {
    return {
      outcome: "in_flight",
      sessionId,
      detail: `another wake of ${sessionId} is in flight`,
    };
  }

  try {
    // Cooldown is checked UNDER the lock so a burst of concurrent escalations
    // can't all slip past a freshly-written record.
    const cd = deps.readCooldown(sessionId);
    if (inCooldown(cd, deps.now())) {
      return {
        outcome: "cooldown",
        sessionId,
        detail: `wake of ${sessionId} is cooling down after ${cd?.failures ?? 0} failure(s)`,
      };
    }

    if (claim !== null && deps.requestResume !== undefined) {
      if (!deps.requestResume(claim)) {
        return {
          outcome: "claim_conflict",
          sessionId,
          detail: `resume request for Dispatch attempt ${claim.attempt_id} was rejected`,
        };
      }
    }

    const cwd = job.cwd ?? "";
    const result = await launch(
      AGENTBUS_EXEC_SESSION,
      resumeTarget(job),
      cwd,
      harnessOrClaude(job.harness),
      claim?.attempt_id ?? undefined,
    );
    if (!result.ok) {
      const failures = (cd?.failures ?? 0) + 1;
      deps.writeCooldown(sessionId, {
        failures,
        last_failure_ms: deps.now(),
      });
      note(`# warn: wake launch for ${sessionId} failed: ${result.error}`);
      return {
        outcome: "launch_failed",
        sessionId,
        detail: `launch failed: ${result.error}`,
      };
    }

    if (
      claim !== null &&
      deps.awaitResumeAccepted !== undefined &&
      !(await deps.awaitResumeAccepted(claim))
    ) {
      deps.revokeAttempt?.(claim);
      return {
        outcome: "acknowledgement_missed",
        sessionId,
        detail: `Dispatch attempt ${claim.attempt_id} did not acknowledge resume; replacement remains fenced until revocation folds`,
      };
    }

    // Success — clear any prior cooldown so a recovered creator isn't gated.
    // keeper agent owns + reaps the window it minted; no marker stamp.
    deps.writeCooldown(sessionId, null);
    return {
      outcome: "launched",
      sessionId,
      detail: `resumed ${sessionId} into the ${AGENTBUS_EXEC_SESSION} session`,
    };
  } finally {
    lock.release();
  }
}

/**
 * The default wake launch transport for {@link runWake} — keeper's sole launch
 * transport {@link keeperAgentLaunch} in resume mode. keeper agent mints/owns the
 * `agentbus` tmux window and re-attaches the session via `--resume <target>`; its
 * `tmuxShellBody` holds the pane open after claude exits (byte-identical to the
 * old hand-rolled hold-open), and the window is managed-reaped via the
 * `backend_exec_session_id` binding. `launcherPrefix` (the absolute `keeper agent`
 * prefix) is closed over so the seam stays `(session, resumeTarget, cwd)`.
 */
function defaultWakeLaunch(
  launcherPrefix: string[],
  noteLine: (line: string) => void,
): (
  session: string,
  resumeTarget: string,
  cwd: string,
  harness: string,
  attemptId?: number,
) => Promise<LaunchResult> {
  return (session, target, cwd, harness, attemptId) =>
    keeperAgentLaunch({
      noteLine,
      launcherArgvPrefix: launcherPrefix,
      session,
      cwd,
      label: `wake resume ${harness} ${target}`,
      spec: {
        prompt: "",
        resumeTarget: target,
        harness,
        ...(attemptId === undefined ? {} : { dispatchAttemptId: attemptId }),
      },
    });
}
