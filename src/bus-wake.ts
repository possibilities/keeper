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
 * edges — the keeper.db read, the bus.db read, the tmux launch, the lock, the
 * cooldown file — are injected as deps by {@link runWake}, so the resolve →
 * liveness-recheck → single-flight → cooldown → launch → marker pipeline unit-tests
 * with an injected `spawn`/`now`/`fs` and no real tmux/daemon/process.
 *
 * Security: the resume TARGET is trusted plan data — the epic's `job_links`
 * creator edge from keeper.db — never a sender's claim. The resolved `job_id` is
 * the session keeper will `claude --resume`, validated to a real `jobs` row before
 * launch. A failed launch is fail-open: the queued message stays and `/work` Phase
 * 2c has already fallen back.
 */

import {
  AGENTBUS_EXEC_SESSION,
  buildTmuxSetWindowOptionArgs,
  type LaunchResult,
  restoreReplayLaunch,
  type SpawnFn,
} from "./exec-backend";
import { buildResumeCommand, resumeTarget } from "./resume-descriptor";

/**
 * The minimal `jobs`-row slice a wake reads — decoupled from the full {@link
 * import("./types").Job} so the resolve/liveness/launch pipeline unit-tests with a
 * tiny synthetic row. `title`/`job_id` feed {@link resumeTarget}; `cwd` is the
 * resume `cd`; `state` is the running-liveness signal; `updated_at` is the
 * newest-creator tiebreaker. Field names + types match `Job` so a real `jobs` row
 * is assignable directly.
 */
export interface WakeCreator {
  job_id: string;
  cwd: string | null;
  title: string | null;
  state: string;
  updated_at: number;
}

/**
 * The cleanup system's managed-window marker. Each `agentbus` spawn stamps this
 * tmux WINDOW user-option so the external cleanup reaper can identify + reap the
 * windows keeper woke (and never touch a human's hand-opened window in the
 * session). keeper only SETS it here; reaping/autoclose is owned by the orthogonal
 * cleanup system, NOT this verb. Name/value match the value the cleanup agent
 * communicated over the bus; both are single constants so a later confirmed value
 * is a one-line change.
 */
export const MANAGED_WINDOW_OPTION = "@keeper_managed" as const;
export const MANAGED_WINDOW_VALUE = "agentbus" as const;

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
 *  - `launch_failed`   — the tmux launch returned `{ ok: false }` (fail-open).
 */
export type WakeOutcome =
  | "launched"
  | "already_live"
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
 * hazardous) double-attach to a session already running? Two independent signals,
 * EITHER positive means skip: (1) a live bus channel keyed on the creator's stable
 * `session_id` (the creator returned and re-armed `keeper bus watch`), or (2) the
 * `jobs.state` reads as a running state. On doubt, treat as live and SKIP — a
 * double `claude --resume` of a live id is the hazard the recheck guards against.
 * Pure over `(job, liveSessionIds)`.
 */
export function creatorIsLive(
  job: WakeCreator,
  liveSessionIds: ReadonlySet<string>,
): boolean {
  if (liveSessionIds.has(job.job_id)) {
    return true;
  }
  return isRunningState(job.state);
}

/** The `jobs.state` values that mean "this session is currently alive". A wake
 *  targets a session that has stopped/ended/been killed — never a working one. */
export function isRunningState(state: string | null | undefined): boolean {
  return state === "working";
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
 * Build the `claude --resume` launch argv for a creator session, wrapped for a
 * login shell so the spawned `agentbus` window survives the resumed claude exiting
 * (the trailing `exec bash -l -i` holds the pane, mirroring the crash-restore
 * replay shape in `scripts/restore-agents.ts`). `buildResumeCommand` returns a
 * SHELL STRING; this bridges it to the `argv:string[]` `restoreReplayLaunch`
 * takes. Pure over `(cwd, target)`.
 */
export function buildWakeResumeArgv(cwd: string, target: string): string[] {
  const resumeCmd = buildResumeCommand(cwd, target, null);
  const body = `${resumeCmd} ; exec bash -l -i`;
  return ["bash", "-l", "-i", "-c", body];
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
  /** Resolve the creator `jobs` rows for `(role=creator, epic)`. Returns the rows
   *  (already decoded), or `[]` on a miss. */
  readonly resolveCreatorJobs: (epic: string) => WakeCreator[];
  /** The set of session_ids currently connected to the bus (liveness signal). */
  readonly liveSessionIds: () => ReadonlySet<string>;
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
  /** The tmux launch transport. Defaults to {@link restoreReplayLaunch}. */
  readonly launch?: (
    session: string,
    argv: string[],
    cwd: string,
  ) => Promise<LaunchResult>;
  /** Spawn for the post-launch marker `set-option`. */
  readonly spawn: SpawnFn;
  /** Clock (epoch-ms). */
  readonly now: () => number;
  /** Warn sink for non-fatal launch/marker diagnostics. */
  readonly noteLine?: (line: string) => void;
}

/**
 * Run a wake of the epic's offline creator. The full client-side pipeline:
 *
 *  1. Resolve the creator `jobs` row from the epic's `job_links` creator edge(s)
 *     ({@link pickCreatorJob}). No row → `unknown_creator`.
 *  2. Liveness recheck ({@link creatorIsLive}): the creator is on the bus or
 *     running → `already_live`, SKIP (a double `claude --resume` of a live id is
 *     the hazard).
 *  3. Single-flight: acquire the per-session NON-BLOCKING lock. Held by another
 *     concurrent wake → `in_flight`, SKIP (TOCTOU double-spawn guard — `has-session`
 *     alone is racy).
 *  4. Cooldown ({@link inCooldown}): a recent failed wake still inside the window →
 *     `cooldown`, SKIP.
 *  5. Launch the `bash -l -c`-wrapped `claude --resume` into `agentbus`
 *     ({@link buildWakeResumeArgv}); fail-open on `{ ok: false }` → `launch_failed`,
 *     bump the cooldown record. On success, clear the cooldown record and stamp the
 *     managed-window marker (best-effort; a marker failure does NOT fail the wake).
 *
 * NEVER throws — every edge degrades to a verdict. The lock is always released.
 */
export async function runWake(
  epic: string,
  deps: WakeDeps,
): Promise<WakeResult> {
  const note = deps.noteLine ?? (() => {});
  const launch = deps.launch ?? defaultWakeLaunch(note);

  const job = pickCreatorJob(deps.resolveCreatorJobs(epic));
  if (job === null) {
    return {
      outcome: "unknown_creator",
      sessionId: null,
      detail: `no creator session resolved for planner@${epic}`,
    };
  }
  const sessionId = job.job_id;

  if (creatorIsLive(job, deps.liveSessionIds())) {
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

    const cwd = job.cwd ?? "";
    const argv = buildWakeResumeArgv(cwd, resumeTarget(job));
    const result = await launch(AGENTBUS_EXEC_SESSION, argv, cwd);
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

    // Success — clear any prior cooldown so a recovered creator isn't gated, then
    // stamp the cleanup system's managed-window marker (best-effort).
    deps.writeCooldown(sessionId, null);
    await stampManagedWindowMarker(deps.spawn, note);
    return {
      outcome: "launched",
      sessionId,
      detail: `resumed ${sessionId} into the ${AGENTBUS_EXEC_SESSION} session`,
    };
  } finally {
    lock.release();
  }
}

/** The default tmux launch transport for {@link runWake} — the surviving direct
 *  tmux replay seam, get-or-creating `agentbus` then `new-window`. */
function defaultWakeLaunch(
  noteLine: (line: string) => void,
): (session: string, argv: string[], cwd: string) => Promise<LaunchResult> {
  return (session, argv, cwd) =>
    restoreReplayLaunch(session, argv, cwd, { noteLine });
}

/**
 * Stamp the cleanup system's managed-window marker on the just-spawned `agentbus`
 * window. Targets `=agentbus:` (exact session, CURRENT window — the non-detached
 * `new-window` left it current) per the `setup-tmux.ts` precedent, so no pane id
 * round-trip is needed. Best-effort: a marker failure is logged and swallowed — the
 * wake already succeeded, and a missing marker only means this window won't be
 * auto-reaped (acceptable; reaping is owned elsewhere). NEVER throws.
 */
async function stampManagedWindowMarker(
  spawn: SpawnFn,
  noteLine: (line: string) => void,
): Promise<void> {
  const args = buildTmuxSetWindowOptionArgs(
    `=${AGENTBUS_EXEC_SESSION}:`,
    MANAGED_WINDOW_OPTION,
    MANAGED_WINDOW_VALUE,
  );
  try {
    const proc = spawn(args, {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    await proc.exited;
  } catch {
    noteLine(
      `# warn: failed to stamp ${MANAGED_WINDOW_OPTION} marker on ${AGENTBUS_EXEC_SESSION} (window won't auto-reap)`,
    );
  }
}
