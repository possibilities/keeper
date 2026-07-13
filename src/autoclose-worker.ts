/**
 * autoclose worker. A daemon Bun Worker thread that force-closes
 * the tmux window of a done-and-idle agent keeper itself dispatched — an
 * autopilot `work::`/`close::` worker whose plan row reached a `completed`
 * verdict, a finished claude `/plan:panel` leg, a stopped wrapped provider leg,
 * or an `unblock::`/`deconflict::`/`resolve::` escalation session whose
 * block/conflict INSTANCE is provably resolved — ~grace after it is provably
 * done. Every other
 * window (a manual session, a hand-run `keeper dispatch`, a handoff, a pair
 * partner, a bus-woken planner) keeps its stay-open-until-hand-closed behavior.
 * Off-switch: `autoclose_enabled: false` in the config, re-read every pulse (a
 * flip lands with no restart).
 *
 * A PURE EXTERNAL ACTUATOR, cloned from the renamer worker's shape: it opens its
 * own read-only connection, watches the projection (level-triggered on `PRAGMA
 * data_version` via {@link watchLoop}, WITH a non-zero idle wake so a grace that
 * elapses on a quiet board — no DB write to bump data_version — still gets
 * re-examined), and writes ONLY to tmux (`kill-window`). It NEVER writes
 * keeper.db: the exit-watcher remains the sole `Killed` producer. Before an
 * autopilot reap it asks main to mint an exact `DispatchClaimReleased`; after
 * that release folds it sends the pre-kill intent hint
 * ({@link AutocloseIntentMessage}) so main owns `kill_reason: 'autoclosed'`.
 *
 * Ownership is proven by POSITIVE provenance, never a tmux/name heuristic: the
 * autopilot bucket keys on `jobs.dispatch_origin === 'autopilot'` (stamped only
 * when a SessionStart discharged a real `pending_dispatches` row), the panel
 * bucket on the `panels` birth-session + the `panel::x::y` name shape, the
 * wrapped bucket on the `wrapped` birth-session + a bare or legacy-prefixed Plan
 * task-id title, and the escalation bucket on
 * `jobs.dispatch_origin === 'escalation'` + one of the three escalation verbs +
 * a non-null `escalation_instance` stamp (never the window title). The autopilot
 * bucket's `completed` verdict is read through the SHARED
 * {@link loadReadinessInputs} + {@link computeReadiness} seam so autoclose's
 * notion of "done" can never drift from the reconciler's; the escalation bucket's
 * done-signal is instance-precise, read fail-closed in the pulse (see
 * {@link readEscalationDoneJobIds}).
 *
 * Every tmux/DB probe is a NEGATIVE safety gate that fails CLOSED: a degraded or
 * empty pane sweep skips the whole pulse and mints nothing; a mismatch is a
 * PERMANENT skip, never a retry (a retry against a since-recycled pane id can
 * interrupt a live session). Kills are blast-capped per pulse so a bad
 * projection state cannot cascade.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import is inert.
 *  - Own read-only `openDb` connection (`prepareStmts:false`, `bootRetry:true`).
 *  - Typed messages: `{type:"shutdown"}` main→worker; exact claim-release and
 *    intent hints worker→main. Exit 0 clean / 1 crash.
 *  - The read-only DB connection is closed in the shutdown path before exit.
 */

import type { Database } from "bun:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb, resolveConfig } from "./db";
import {
  classifyProcessIdentity,
  compareCanonicalGeneration,
  createTmuxPaneOps,
  MANAGED_EXEC_SESSION,
  PANELS_EXEC_SESSION,
  type PaneInfo,
  type TmuxPaneOps,
  WRAPPED_EXEC_SESSION,
} from "./exec-backend";
import { computeReadiness, type ReadinessSnapshot } from "./readiness";
import type { DispatchClaim } from "./readiness-inputs";
import { loadReadinessInputs, type ReadinessQuery } from "./readiness-inputs";
import { readOsStartTime } from "./seed-sweep";
import { isPidAlive } from "./server-worker";
import type { HarnessActivity } from "./session-activity";
import { watchLoop } from "./wake-worker";

/** Cap on kills per pulse — the blast-radius bound so a bad projection state
 *  cannot cascade into a mass window close. Candidates over the cap stay in the
 *  grace map and reap on a later pulse. */
export const AUTOCLOSE_MAX_KILLS_PER_PULSE = 5;

/** Idle-wake cadence (ms) for {@link watchLoop}. NON-ZERO by necessity: grace
 *  expiry is time-based and a quiet board never bumps `data_version`, so a
 *  data_version-only loop would never re-examine a candidate whose grace
 *  elapsed. ~5s mirrors the restore-worker precedent. */
export const AUTOCLOSE_IDLE_MS = 5000;

/** The `panel::<model>::<slug>` title shape a claude `/plan:panel` leg wears —
 *  exactly two `::` separators, no colon inside a segment. Part of the panel
 *  bucket's positive allowlist alongside the `panels` birth session. */
const PANEL_TITLE_RE = /^panel::[^:]+::[^:]+$/;

/** A wrapped provider leg's display title: the canonical bare Plan task id or
 *  the legacy `wrapped::`-prefixed form accepted during rollout. Mirrors Plan's
 *  `fn-<number>[-slug].<task-number>` grammar; an epic id is not a provider-leg
 *  task title. Exact pane identity, not this display string, remains the kill
 *  target. */
const WRAPPED_PROVIDER_TITLE_RE =
  /^(?:wrapped::)?fn-\d+(?:-[a-z0-9][a-z0-9-]*[a-z0-9]|-[a-z0-9]{1,3})?\.\d+$/;

/** Data the parent passes via `new Worker(url, { workerData })`. Only the DB
 *  path crosses the boundary — the read-only connection is opened on the worker
 *  thread (handles are thread-affine). */
export interface AutocloseWorkerData {
  dbPath: string;
  /** Poll cadence (ms) for the underlying `data_version` watch. Optional;
   *  defaults to {@link watchLoop}'s default. */
  pollMs?: number;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * The pre-kill intent hint. Posted IMMEDIATELY
 * before {@link TmuxPaneOps.killWindow} so main can label the resulting `Killed`
 * row `kill_reason: 'autoclosed'`. Carries the recycle-safe identity tuple
 * (`jobId`, `pid`, `startTime`, `paneId`) plus the audit context (`bucket`,
 * `ref`). The worker writes nothing to keeper.db; this hint is the whole
 * worker→main surface.
 */
export interface AutocloseIntentMessage {
  kind: "autoclose-intent";
  jobId: string;
  pid: number | null;
  startTime: string | null;
  paneId: string;
  bucket: AutocloseBucket;
  ref: string | null;
}

/** Exact claim release requested before an autopilot-owned resource is reaped. */
export interface AutocloseClaimReleaseMessage {
  kind: "autoclose-claim-release";
  verb: "work" | "close";
  id: string;
  expectedAttemptId: number;
  sessionId: string;
}

export type AutocloseWorkerMessage =
  | AutocloseIntentMessage
  | AutocloseClaimReleaseMessage;

/** Which ownership bucket a reap belongs to — the four positively-owned window
 *  classes. */
export type AutocloseBucket = "autopilot" | "panel" | "wrapped" | "escalation";

/**
 * The narrow `jobs` row the decision core reads. A PURPOSE-BUILT projection, not
 * the full {@link import("./types").Job}: it carries the airtight
 * autopilot-vs-manual `dispatch_origin` discriminator plus
 * `backend_exec_generation_id` (the live-pane-resolved marker the shared jobs
 * descriptor omits), so the pulse reads it via a direct SELECT rather than the
 * descriptor read path.
 */
export interface AutocloseJob {
  job_id: string;
  state: string;
  pid: number | null;
  start_time: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
  title: string | null;
  dispatch_origin: string | null;
  backend_exec_type: string | null;
  backend_exec_pane_id: string | null;
  backend_exec_birth_session_id: string | null;
  backend_exec_generation_id: string | null;
  last_input_request_at: number | null;
  last_permission_prompt_at: number | null;
  /** The block-instance id an escalation session is bound to (`unblock` →
   *  `block_escalations.blocked_since`; `deconflict`/`resolve` →
   *  `dispatch_failures.instance_event_id`). Non-null only on the escalation
   *  bucket's members; the instance-precise done-signal keys on it. */
  escalation_instance: number | null;
}

/** One window the decision core owes a close. Mirrors the intent hint's identity
 *  + audit fields. */
export interface AutocloseReapDecision {
  jobId: string;
  pid: number | null;
  startTime: string | null;
  paneId: string;
  bucket: AutocloseBucket;
  ref: string | null;
}

/** Injected inputs to the pure decision core — side-effect free, every input a
 *  plain value so the full in/out matrix drives it with no DB / tmux. */
export interface ComputeAutocloseReapsArgs {
  /** Candidate `jobs` rows (the pulse pre-filters to `state = 'stopped'`; the
   *  core re-checks defensively). */
  jobs: readonly AutocloseJob[];
  /** The shared readiness snapshot — `perTask` (work, keyed by task id) and
   *  `perCloseRow` (close, keyed by epic id) carry the `completed` verdict. */
  readiness: Pick<ReadinessSnapshot, "perTask" | "perCloseRow">;
  /** Job ids whose escalation-bucket instance is provably RESOLVED — the
   *  escalation done-signal, read instance-precise + fail-closed on the worker's
   *  read-only connection in the pulse and passed in as a plain set so the core
   *  stays pure. An absent id ⇒ the incident still stands ⇒ never reaped (a
   *  declined session's window persists as intended evidence). */
  escalationDone: ReadonlySet<string>;
  /** One pane sweep. `null` (degraded tmux) OR empty (a suspiciously empty
   *  server) → skip the whole pulse, mint nothing, preserve the grace map. */
  panes: readonly PaneInfo[] | null;
  /** Worker-local first-observed-eligible clock: `job_id → unix-seconds`. */
  graceMap: ReadonlyMap<string, number>;
  config: { autocloseEnabled: boolean; autocloseGraceSeconds: number };
  /** Autopilot `paused` — suspends the autopilot, wrapped, and escalation
   *  buckets; panel cleanup is governed solely by the config key. */
  autopilotPaused: boolean;
  /** Reference instant, unix SECONDS (same clock as the grace map + the config
   *  grace seconds). */
  now: number;
  /** Canonical activity and claims. Omitted only by compatibility callers. */
  activityByJobId?: ReadonlyMap<string, HarnessActivity>;
  dispatchClaims?: readonly DispatchClaim[];
  /** Fresh recycle-safe process verdicts keyed by job id. */
  processIdentityByJobId?: ReadonlyMap<
    string,
    "alive" | "dead" | "recycled" | "unknown"
  >;
}

/** The decision core's output: the (capped, deterministically ordered) reaps and
 *  the NEXT grace map to carry into the following pulse. */
export interface AutocloseReapsResult {
  reaps: AutocloseReapDecision[];
  claimReleases: AutocloseClaimReleaseMessage[];
  graceMap: Map<string, number>;
}

/** The escalation bucket's membership predicate — POSITIVE provenance only
 *  (`dispatch_origin='escalation'` + one of the three escalation verbs + a
 *  non-null instance stamp), NEVER the window title. Shared by the pulse's
 *  done-signal reader (which candidates it reads for) and the pure classifier
 *  (bucket membership) so the two can never drift. */
function isEscalationCandidate(job: AutocloseJob): boolean {
  return (
    job.dispatch_origin === "escalation" &&
    (job.plan_verb === "unblock" ||
      job.plan_verb === "deconflict" ||
      job.plan_verb === "resolve") &&
    job.escalation_instance != null
  );
}

/**
 * Decide, for one bucket-membership + rail check, whether a job is eligible NOW
 * (every gate EXCEPT grace-elapsed). Returns the `{bucket, ref}` on a pass, or
 * `null` on any failing gate — the caller treats `null` as "prune the grace
 * entry" (any ineligible observation resets the clock, the inherent hysteresis).
 * Pure.
 */
function classifyEligible(
  job: AutocloseJob,
  readiness: Pick<ReadinessSnapshot, "perTask" | "perCloseRow">,
  escalationDone: ReadonlySet<string>,
  paneById: ReadonlyMap<string, PaneInfo>,
  paneCountByWindow: ReadonlyMap<string, number>,
  autopilotPaused: boolean,
  activityByJobId?: ReadonlyMap<string, HarnessActivity>,
  processIdentityByJobId?: ReadonlyMap<
    string,
    "alive" | "dead" | "recycled" | "unknown"
  >,
): { bucket: AutocloseBucket; ref: string | null } | null {
  // Precondition rails common to every bucket. A terminal (killed/ended) row
  // has a NULLed pane id — untargetable by design; never touch it.
  if (job.state !== "stopped") {
    return null;
  }
  if (job.backend_exec_type !== "tmux") {
    return null;
  }
  const paneId = job.backend_exec_pane_id;
  if (paneId == null || paneId === "") {
    return null;
  }
  // Generation present = the pane was resolved by the live topology fold; a row
  // whose pane was never live-resolved is not a safe kill target.
  const jobGenerationId = job.backend_exec_generation_id;
  if (jobGenerationId == null || jobGenerationId === "") {
    return null;
  }
  // Prompt-parked rail. `last_input_request_at` flips state to stopped and is
  // NOT cleared on Stop, so a non-null value on a stopped row means "parked
  // awaiting a human answer" — never close it. `last_permission_prompt_at` IS
  // cleared on Stop, so a non-null value is a prompt NEWER than the last stop
  // (re-parked) — also excluded. Both null ⇒ not parked.
  if (job.last_input_request_at != null) {
    return null;
  }
  if (job.last_permission_prompt_at != null) {
    return null;
  }
  const activity = activityByJobId?.get(job.job_id);
  if (activityByJobId !== undefined) {
    if (activity?.status !== "quiescent" || activity.reservation !== null) {
      return null;
    }
  }
  if (
    processIdentityByJobId?.get(job.job_id) === "unknown" ||
    processIdentityByJobId?.get(job.job_id) === "recycled"
  ) {
    return null;
  }

  // Bucket membership — POSITIVE provenance only.
  let bucket: AutocloseBucket;
  let managedSession: string;
  let ref: string | null;
  if (
    job.dispatch_origin === "autopilot" &&
    (job.plan_verb === "work" || job.plan_verb === "close")
  ) {
    // Autopilot bucket: pause suspends it (unlike the panel bucket).
    if (autopilotPaused) {
      return null;
    }
    const planRef = job.plan_ref;
    if (planRef == null || planRef === "") {
      return null;
    }
    // work → perTask keyed by task id; close → perCloseRow keyed by epic id
    // (the plan_ref of a close worker IS the epic id) — the await-conditions
    // consumer pattern.
    const verdict =
      job.plan_verb === "work"
        ? readiness.perTask.get(planRef)
        : readiness.perCloseRow.get(planRef);
    if (verdict?.tag !== "completed") {
      return null;
    }
    bucket = "autopilot";
    managedSession = MANAGED_EXEC_SESSION;
    ref = planRef;
  } else if (
    job.backend_exec_birth_session_id === PANELS_EXEC_SESSION &&
    job.plan_verb == null &&
    job.plan_ref == null &&
    job.title != null &&
    PANEL_TITLE_RE.test(job.title)
  ) {
    bucket = "panel";
    managedSession = PANELS_EXEC_SESSION;
    ref = job.title;
  } else if (
    job.backend_exec_birth_session_id === WRAPPED_EXEC_SESSION &&
    job.title != null &&
    WRAPPED_PROVIDER_TITLE_RE.test(job.title)
  ) {
    // Wrapped provider legs own no Plan readiness row: their positive stopped
    // state (checked above) is the done signal. Pause suspends cleanup just like
    // the autopilot and escalation buckets.
    if (autopilotPaused) {
      return null;
    }
    bucket = "wrapped";
    managedSession = WRAPPED_EXEC_SESSION;
    ref = job.title;
  } else if (isEscalationCandidate(job)) {
    // Escalation bucket: an `unblock::`/`deconflict::`/`resolve::` session
    // (launched into MANAGED_EXEC_SESSION, like the autopilot bucket). Pause
    // suspends it too.
    if (autopilotPaused) {
      return null;
    }
    // Done-signal: the block/conflict INSTANCE this session was bound to must be
    // provably resolved. Computed instance-precise + fail-closed in the pulse and
    // passed in — an absent id means the incident still stands (so a declined
    // session's window persists as intended evidence until its instance clears;
    // its escalation SLOT is already freed by turn-activity). Never key a kill on
    // the board flip alone: the `stopped` rail above plus this signal protect the
    // skill's in-turn final bus-resume message.
    if (!escalationDone.has(job.job_id)) {
      return null;
    }
    bucket = "escalation";
    managedSession = MANAGED_EXEC_SESSION;
    ref = `${job.plan_verb}::${job.plan_ref}`;
  } else {
    // Everything else — manual (origin NULL), handoff, pair/agentbus, a plan/
    // approve verb — is out of scope.
    return null;
  }

  // Live pane rails against the fresh sweep. Each is a fail-closed negative gate.
  const pane = paneById.get(paneId);
  if (pane === undefined) {
    // Pane absent from the sweep — the window is gone (or the kill already
    // landed). Suppresses a double-kill next pulse while the row is still
    // 'stopped' pending the Killed fold.
    return null;
  }
  if (pane.paneDead !== "0") {
    return null;
  }
  // Same tmux generation: `%N` pane ids are scoped to one server lifetime, so a
  // generation mismatch means this live `%N` is not the job's pane.
  if (
    compareCanonicalGeneration(jobGenerationId, pane.tmuxGenerationId) !==
    "match"
  ) {
    return null;
  }
  // Live session membership — a window moved out of the bucket's managed session
  // is the human's now.
  if (pane.sessionName !== managedSession) {
    return null;
  }
  // Exactly one pane: kill-window destroys every pane in the window, so a human
  // split (two panes) makes the window theirs.
  if ((paneCountByWindow.get(pane.windowId) ?? 0) !== 1) {
    return null;
  }

  return { bucket, ref };
}

/**
 * The pure decision core — the whole unit-test surface. Given the candidate
 * jobs, the shared readiness snapshot, ONE pane sweep, the incoming grace map,
 * the config, the paused flag, and `now`, returns the windows to close plus the
 * NEXT grace map. Side-effect free and deterministic in its inputs.
 *
 * Grace: an entry records `now` the first pulse a job is observed eligible;
 * `now - firstObserved >= graceSeconds` makes it due. An ineligible observation
 * (resumed, killed, verdict regressed, prompt-parked, session moved, …) drops
 * the entry — so the clock resets. A brand-new eligible observation is never due
 * (elapsed 0 < the positive grace). Reaps are ordered by `job_id` and capped at
 * {@link AUTOCLOSE_MAX_KILLS_PER_PULSE}; a capped-out candidate STAYS in the
 * grace map and reaps on a later pulse.
 */
export function computeAutocloseReaps(
  args: ComputeAutocloseReapsArgs,
): AutocloseReapsResult {
  const {
    jobs,
    readiness,
    escalationDone,
    panes,
    graceMap,
    config,
    autopilotPaused,
    now,
    activityByJobId,
    dispatchClaims,
    processIdentityByJobId,
  } = args;

  // Config off-switch: disabled ⇒ clear state, mint nothing (a re-enable then
  // restarts every grace clock — a flip only ever DELAYS a close).
  if (!config.autocloseEnabled) {
    return { reaps: [], claimReleases: [], graceMap: new Map() };
  }

  // Degraded (null) OR empty sweep: skip the whole pulse, mint nothing. A
  // non-observation, so the grace map is PRESERVED (neither advanced nor reset).
  if (panes == null || panes.length === 0) {
    return {
      reaps: [],
      claimReleases: [],
      graceMap: new Map(graceMap),
    };
  }

  const paneById = new Map<string, PaneInfo>();
  const paneCountByWindow = new Map<string, number>();
  for (const pane of panes) {
    paneById.set(pane.paneId, pane);
    paneCountByWindow.set(
      pane.windowId,
      (paneCountByWindow.get(pane.windowId) ?? 0) + 1,
    );
  }

  const nextGrace = new Map<string, number>();
  const due: AutocloseReapDecision[] = [];
  const claimReleases: AutocloseClaimReleaseMessage[] = [];
  const claimByTarget = new Map(
    (dispatchClaims ?? []).map((claim) => [
      `${claim.verb}::${claim.id}`,
      claim,
    ]),
  );
  for (const job of jobs) {
    const elig = classifyEligible(
      job,
      readiness,
      escalationDone,
      paneById,
      paneCountByWindow,
      autopilotPaused,
      activityByJobId,
      processIdentityByJobId,
    );
    if (elig === null) {
      // Ineligible ⇒ prune (absent from nextGrace resets the clock).
      continue;
    }
    if (
      dispatchClaims !== undefined &&
      elig.bucket === "autopilot" &&
      (job.plan_verb === "work" || job.plan_verb === "close") &&
      job.plan_ref != null
    ) {
      const claim = claimByTarget.get(`${job.plan_verb}::${job.plan_ref}`);
      if (
        claim == null ||
        claim.legacy_unfenced !== 0 ||
        claim.attempt_id == null
      ) {
        continue;
      }
      if (claim.session_id === job.job_id && claim.state !== "released") {
        if (claim.state === "bound") {
          claimReleases.push({
            kind: "autoclose-claim-release",
            verb: job.plan_verb,
            id: job.plan_ref,
            expectedAttemptId: claim.attempt_id,
            sessionId: job.job_id,
          });
        }
        continue;
      }
      if (claim.session_id == null && claim.state === "acquired") {
        // A newer exact attempt revoked this owner; its old pane remains safe to
        // reap only through the exact resource identity rails above.
      } else if (
        claim.session_id !== job.job_id &&
        claim.state !== "released"
      ) {
        continue;
      }
    }
    const firstObserved = graceMap.get(job.job_id) ?? now;
    nextGrace.set(job.job_id, firstObserved);
    if (now - firstObserved >= config.autocloseGraceSeconds) {
      due.push({
        jobId: job.job_id,
        pid: job.pid,
        startTime: job.start_time,
        // Non-null: classifyEligible passed only past the pane-id gate.
        paneId: job.backend_exec_pane_id as string,
        bucket: elig.bucket,
        ref: elig.ref,
      });
    }
  }

  due.sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
  claimReleases.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return {
    reaps: due.slice(0, AUTOCLOSE_MAX_KILLS_PER_PULSE),
    claimReleases,
    graceMap: nextGrace,
  };
}

/** In-memory pulse state: the worker-local grace map, carried pulse to pulse. A
 *  daemon restart starts it empty — a restart only DELAYS a close, never
 *  accelerates one, so the map is never persisted. */
export interface AutoclosePulseState {
  graceMap: Map<string, number>;
}

/** Injected pulse collaborators — clock, config re-read, the worker-message sink,
 *  and the stderr audit line. All injectable so the pulse drives against a
 *  seeded DB + fake backend with no real Worker / tmux. */
export interface AutoclosePulseDeps {
  resolveConfig: () => {
    autocloseEnabled: boolean;
    autocloseGraceSeconds: number;
  };
  now: () => number;
  postIntent: (msg: AutocloseWorkerMessage) => void;
  noteLine: (line: string) => void;
  readinessQuery?: ReadinessQuery;
  isPidAlive?: (pid: number) => boolean;
  readStartTime?: (pid: number) => string | null;
}

/** Read the autopilot `paused` flag off the singleton `autopilot_state` row.
 *  A missing/malformed value defaults to PAUSED (the safe default — matches the
 *  readiness client). */
function readAutopilotPaused(db: Database): boolean {
  const rows = db
    .prepare("SELECT paused FROM autopilot_state WHERE id = 1")
    .all() as { paused: unknown }[];
  const raw = rows[0]?.paused;
  return typeof raw === "number" ? raw !== 0 : true;
}

/** Read the stopped candidate rows via a direct SELECT — `backend_exec_generation_id`
 *  (the live-pane-resolved marker) is omitted from the shared jobs descriptor, so
 *  the descriptor read path can't surface it. Only `state = 'stopped'` rows are
 *  ever candidates; a resumed row simply vanishes from this set and its grace
 *  entry is pruned by absence. */
function readAutocloseJobs(db: Database): AutocloseJob[] {
  return db
    .prepare(
      `SELECT job_id, state, pid, start_time, plan_verb, plan_ref, title,
              dispatch_origin, backend_exec_type, backend_exec_pane_id,
              backend_exec_birth_session_id, backend_exec_generation_id,
              last_input_request_at, last_permission_prompt_at, escalation_instance
         FROM jobs
        WHERE state = 'stopped'`,
    )
    .all() as AutocloseJob[];
}

/**
 * Read the escalation bucket's instance-precise done-signal on the worker's
 * read-only connection, for every escalation candidate among `jobs`. Returns the
 * set of job_ids whose bound block/conflict INSTANCE is provably resolved.
 *
 * Done per verb (the instance id is `jobs.escalation_instance`, a globally-unique
 * event id):
 *  - `unblock`  — no `block_escalations` row still carries this `blocked_since`
 *    (leaving blocked DELETEs the latch; a re-block re-arms a NEW instance id).
 *  - `deconflict`/`resolve` — no `close::<epic>` `dispatch_failures` row still
 *    carries this `instance_event_id` (a `DispatchCleared` DELETEs the sticky; a
 *    new incident re-mints a fresh instance id).
 *
 * FAIL-CLOSED: a read error THROWS and the pulse catches it, skips, and reaps
 * nothing — the reap decision and the kill ride this ONE fresh read (the TOCTOU
 * guard), never a prior pulse's verdict or the board flip alone.
 */
function readEscalationDoneJobIds(
  db: Database,
  jobs: readonly AutocloseJob[],
): Set<string> {
  const done = new Set<string>();
  const blockInstanceOpen = db.prepare(
    "SELECT 1 FROM block_escalations WHERE blocked_since = ? LIMIT 1",
  );
  const closeInstanceOpen = db.prepare(
    "SELECT 1 FROM dispatch_failures WHERE verb = 'close' AND instance_event_id = ? LIMIT 1",
  );
  for (const job of jobs) {
    if (!isEscalationCandidate(job)) {
      continue;
    }
    const instance = job.escalation_instance as number;
    const stmt =
      job.plan_verb === "unblock" ? blockInstanceOpen : closeInstanceOpen;
    if (stmt.get(instance) == null) {
      done.add(job.job_id);
    }
  }
  return done;
}

/**
 * Drive one autoclose pulse against the worker's read-only connection.
 * Re-reads config (live kill-switch both directions), sweeps tmux ONCE
 * (degraded/empty → skip), loads the shared readiness inputs + verdict, reads
 * the paused flag + candidate rows, runs the pure {@link computeAutocloseReaps},
 * then for each capped decision posts the intent hint and IMMEDIATELY fires
 * `killWindow`. The level-triggered grace entry remains after a failed exact
 * kill, so a still-live eligible pane retries on a later pulse; an absent pane
 * converges through the next topology sweep. NEVER throws for an expected
 * degradation.
 *
 * Exported for unit reach: tests drive it directly against a seeded DB with an
 * injected backend + deps.
 */
export async function autoclosePulse(
  db: Database,
  backend: Pick<TmuxPaneOps, "listPanes" | "killWindow">,
  state: AutoclosePulseState,
  deps: AutoclosePulseDeps,
): Promise<void> {
  const config = deps.resolveConfig();
  if (!config.autocloseEnabled) {
    // Disabled ⇒ clear state, do nothing (a re-enable restarts every clock).
    state.graceMap = new Map();
    return;
  }

  // ONE sweep per pulse. Degraded (null) or empty ⇒ skip the whole pulse and
  // mint nothing, preserving the grace map (a non-observation).
  const panes = await backend.listPanes();
  if (panes === null || panes.length === 0) {
    return;
  }

  const inputs = loadReadinessInputs(db, deps.readinessQuery);
  if (inputs.readinessDegraded) {
    return;
  }
  const now = deps.now();
  const readiness = computeReadiness(
    inputs.epics,
    inputs.jobs,
    inputs.subagentInvocations,
    inputs.gitStatusByProjectDir,
    now,
    inputs.pendingDispatches,
    // Autoclose needs only done-detection, so armed-mode eligibility is N/A.
    undefined,
    inputs.unseededRoots,
    inputs.maxConcurrentPerRoot,
  );
  const autopilotPaused = readAutopilotPaused(db);
  const jobs = readAutocloseJobs(db);

  // The escalation bucket's done-signal — read fail-closed on this ONE pulse's
  // fresh connection. A degraded read skips the WHOLE pulse and reaps nothing;
  // returning before the grace-map write preserves it (a non-observation),
  // matching the degraded-sweep rail.
  let escalationDone: ReadonlySet<string>;
  try {
    escalationDone = readEscalationDoneJobIds(db, jobs);
  } catch (err) {
    deps.noteLine(
      `escalation done-signal read failed — skipping pulse: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const processIdentityByJobId = new Map<
    string,
    "alive" | "dead" | "recycled" | "unknown"
  >();
  const alive = deps.isPidAlive ?? isPidAlive;
  const readStart = deps.readStartTime ?? readOsStartTime;
  for (const job of jobs) {
    processIdentityByJobId.set(
      job.job_id,
      classifyProcessIdentity(job.pid, job.start_time, {
        isPidAlive: alive,
        readStartTime: readStart,
      }),
    );
  }

  const { reaps, claimReleases, graceMap } = computeAutocloseReaps({
    jobs,
    readiness,
    escalationDone,
    panes,
    graceMap: state.graceMap,
    config,
    autopilotPaused,
    now,
    activityByJobId: inputs.harnessActivityByJobId,
    dispatchClaims: inputs.dispatchClaims,
    processIdentityByJobId,
  });
  state.graceMap = graceMap;

  for (const release of claimReleases) {
    deps.postIntent(release);
  }
  for (const decision of reaps) {
    // Post the hint BEFORE the kill so main can label the Killed row; the
    // exit-watcher remains the sole Killed producer.
    deps.postIntent({
      kind: "autoclose-intent",
      jobId: decision.jobId,
      pid: decision.pid,
      startTime: decision.startTime,
      paneId: decision.paneId,
      bucket: decision.bucket,
      ref: decision.ref,
    });
    const killed = await backend.killWindow(decision.paneId);
    deps.noteLine(
      `${killed.ok ? "closed" : "close deferred"} job=${decision.jobId} bucket=${decision.bucket} ref=${
        decision.ref ?? "-"
      } pane=${decision.paneId}`,
    );
  }
}

/**
 * Worker entrypoint. Opens its own read-only connection, wires the shutdown
 * message, runs an initial pulse, then drives the watch loop (with the non-zero
 * idle wake) until told to stop.
 */
function main(): void {
  if (!parentPort) {
    console.error("[autoclose-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as AutocloseWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[autoclose-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const backend = createTmuxPaneOps({
    noteLine: (line: string): void => {
      console.error(`[autoclose-worker] ${line}`);
    },
  });
  const state: AutoclosePulseState = { graceMap: new Map() };
  const deps: AutoclosePulseDeps = {
    resolveConfig: () => {
      const cfg = resolveConfig();
      return {
        autocloseEnabled: cfg.autocloseEnabled,
        autocloseGraceSeconds: cfg.autocloseGraceSeconds,
      };
    },
    now: () => Math.floor(Date.now() / 1000),
    postIntent: (msg: AutocloseWorkerMessage): void => {
      parentPort?.postMessage(msg);
    },
    noteLine: (line: string): void => {
      console.error(`[autoclose-worker] ${line}`);
    },
  };
  let shutdown = false;

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown = true;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  const pulse = (): void => {
    // Per-pulse try/catch: any unexpected error degrades to a logged non-fatal
    // skip rather than escaping the watch loop (which would fatalExit the
    // daemon over a cosmetic side-effect).
    autoclosePulse(db, backend, state, deps).catch((err) => {
      console.error(
        `[autoclose-worker] pulse threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  };

  // Initial pulse before the watch loop's first sleep so a freshly-spawned
  // worker reaps already-due windows immediately.
  pulse();

  watchLoop(db, pulse, () => shutdown, data.pollMs, AUTOCLOSE_IDLE_MS)
    .then(() => {
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error("[autoclose-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure decision core / pulse) is inert.
if (!isMainThread) {
  main();
}
