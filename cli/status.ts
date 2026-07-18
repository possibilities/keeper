#!/usr/bin/env bun
/**
 * `keeper status [--json] [--sock <path>] [--connect-timeout <dur>]` — a
 * one-shot, unified JSON read of the whole board: autopilot config + per-row
 * readiness verdicts + aggregate counts + drained/jammed + in-flight +
 * needs-human + the boot header's `{rev, catching_up}`. The agent-facing
 * "orient in one read" surface — no snapshot-mode TUI dance, no reconnect loop.
 *
 * Transport mirrors `keeper await server-up`: a bare `subscribeReadiness`,
 * whose FIRST `onSnapshot` is already a complete composite (the internal
 * all-strict first-paint gate). The subscribe opts into `includeDispatchFailures`
 * (ADR 0011), so the sticky `dispatch_failures` rows for the jammed /
 * needs-human signals ride the SAME snapshot in ONE round-trip — no out-of-band
 * `queryCollection` — AND into `includePinnedEpics` (ADR 0018), so a plan-closed
 * epic with a live close/work failure merges into `board.epics` with a real
 * close verdict instead of dropping off the board. On that first frame we
 * dispose the handle, print the envelope, and exit. UNLIKE `server-up`, the
 * subscribe carries a bounded default ~10s `giveUpPolicy`: a one-shot orient
 * must NOT reconnect forever, so a down daemon fires
 * `onFatal({code:"unreachable"})` → exit 1.
 *
 * Exit taxonomy: exit 0 on ANY board state (a bad board is DATA, not an
 * error). Exit 1 ONLY on transport (`unreachable`/`connect`) or usage. On a
 * transport failure we still emit a `{ok:false, error}` envelope on stdout so
 * an agent always parses the last stdout as JSON; a usage fault prints HELP to
 * stderr.
 *
 * `drained`/`jammed`/`needs-human` are computed INLINE here from the readiness
 * snapshot (verdicts + in-flight + each epic's parked-closer `question`) plus
 * the snapshot's `dispatchFailures` member. The canonical pure predicate is
 * task-4's (`await drained`); when it lands, dedupe this with an import.
 * TODO(fn-1015.4): replace the inline drained/jammed with the shared predicate.
 */

import { parseArgs } from "node:util";
import { parseWrappedProviderTaskId } from "../src/autoclose-worker";
import { isBoardWorkJob } from "../src/await-conditions";
import { resolveSockPath } from "../src/db";
import {
  classifyDispatchFailure,
  resolveFailureTarget,
} from "../src/dispatch-failure-pill";
import { WRAPPED_EXEC_SESSION } from "../src/exec-backend";
import { projectNeedsHuman } from "../src/needs-human";
import type { BootStatus, EventStoreStatus, Row } from "../src/protocol";
import { formatPill, type Verdict } from "../src/readiness";
import {
  type ConnectFactory,
  type FatalError,
  type ReadinessClientHandle,
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import { isOpenTurnRow } from "../src/subagent-invocations";
import type { EmbeddedJob, SubagentInvocation } from "../src/types";
import { type FormatMode, parseOptions } from "./descriptor";
import { parseDuration } from "./duration";
import {
  type Envelope,
  errorEnvelope,
  type ProblemError,
  RECOVERY_DAEMON_DOWN,
  successEnvelope,
} from "./envelope";
import { emitEnvelopeFormatted, resolveFormat } from "./format";

/** Envelope schema version for `keeper status`. v2 adds the additive
 * `dispatch_failure: string[]` field to the per-task + close-row views; v3 adds
 * the additive `autopilot.worktree_multi_repo` durable-config field; v4 adds the
 * additive `board.epics[].question` parked-closer-question field and the
 * `needs_human.parked_questions` count; v5 adds the additive
 * `needs_human.instant_death_wall` count (the instant-death circuit breaker);
 * v7 drops the `needs_human.selection_reviews` count (close-time selection
 * grading retires — grading moves out-of-band); v8 adds the additive
 * `needs_human.finalize_suite_red` count (the merge-suite-gate finalize jam);
 * v9 adds the additive `in_flight.board_work_jobs` count — working Board-work
 * sessions only (autopilot/escalation dispatches), excluding the caller's own
 * session, distinct from `running_jobs` (every working job, supervising
 * session included); v10 adds display-only `needs_human.finalize_pending`; v11
 * adds the display-only legacy Provider-leg drain gauge; v12 adds the
 * display-only `event_store` block — event count, DB bytes, and durations
 * projected from the most recent boot's measured catch-up rate; the current
 * schema revision adds `stale_running` count partitions and `last_evidence_at`
 * on stale board views.
 * `in_flight.running_jobs` remains emitted but is deprecated in favor of
 * `in_flight.board_work_jobs`. */
export const STATUS_SCHEMA_VERSION = 13;

/**
 * Default bounded connect deadline (~10s). A one-shot orient must give up
 * rather than reconnect forever when the daemon is down; `--connect-timeout`
 * overrides it.
 */
export const DEFAULT_CONNECT_DEADLINE_MS = 10_000;

export const HELP = `keeper status — one-shot unified board + autopilot JSON read

Usage:
  keeper status [--format json|yaml] [--sock <path>] [--connect-timeout <dur>]

Prints ONE {schema_version, ok, error, data} envelope: autopilot config, the
per-epic/-task/-close-row readiness verdicts, aggregate counts, drained/jammed
booleans, the display-only legacy Provider-leg drain gauge, in-flight launches,
needs-human signals, and {rev, catching_up}. Each
task + close view also carries dispatch_failure: string[] — the sticky
dispatch_failures block KINDS (multi-repo / merge-conflict / dirty-tree / non-ff)
readiness can't see; [] when clean. Counts split fresh running from
stale-running; stale board views carry last_evidence_at so cached evidence never
presents as a current activity claim.

Flags:
  --format json|yaml       Output format (default json); yaml for a yq consumer
  --json                   Alias of --format json
  --sock <path>            Socket override ($KEEPER_SOCK / default)
  --connect-timeout <dur>  Bounded reach-server deadline (e.g. 10s, 5m).
                           Default ~10s; a down daemon → exit 1 unreachable
  --help                   Show this help

Exit codes:
  0  printed an envelope (ANY board state — bad state is data)
  1  transport (unreachable/connect) or usage

Examples:
  keeper status --json | jq .data.autopilot
  keeper status | jq '.data.drained, .data.jammed'
  keeper status --json | jq '.data.board.epics[].tasks[].dispatch_failure, .data.board.epics[].close.dispatch_failure'
  keeper status --json | jq .data.counts
  keeper status --json | jq .data.in_flight.board_work_jobs  # safe-to-stop the daemon: 0 excludes this session
`;

// ---------------------------------------------------------------------------
// Envelope shape (pure)
// ---------------------------------------------------------------------------

export interface VerdictTally {
  total: number;
  ready: number;
  running: number;
  stale_running: number;
  completed: number;
  blocked: number;
}

export interface StatusBootInfo {
  rev: number | null;
  catching_up: boolean;
  // fn-1311 — the event store's growth measurements (see `EventStoreStatus`).
  // `null` only on the pre-first-frame default (`runStatus`'s initial
  // `latestBoot`); the daemon's `boot` header always carries a real (possibly
  // null-honest-internally) block once a frame lands.
  event_store: EventStoreStatus | null;
}

interface VerdictView {
  verdict: string;
  pill: string;
  last_evidence_at: number | null;
  // Sorted-unique short KIND tokens for any sticky `dispatch_failures` block on
  // this row (multi-repo / merge-conflict / dirty-tree / non-ff / …). Additive
  // (v2), `[]` when clean. Populated on task + close views; the epic-level view
  // stays `[]` (a close-row block lives on `close`, not the epic verdict).
  // NAMED `dispatch_failure` (not `blocked_by`) to avoid a collision with the
  // plan tooling's dependency-id field and the paradox of "blocked" on a
  // `ready`-verdict row — readiness is untouched here.
  dispatch_failure: string[];
}

interface TaskView extends VerdictView {
  task_id: string;
}

interface EpicView extends VerdictView {
  epic_id: string;
  status: string | null;
  tasks: TaskView[];
  close: VerdictView | null;
  // The epic-level parked-closer question (`keeper plan epic-question`), or
  // `null` when none is parked. Additive (v4) — a needs-human board signal
  // orthogonal to the verdict/pill (readiness is untouched here).
  question: string | null;
}

export interface StatusData {
  autopilot: {
    paused: boolean;
    mode: "yolo" | "armed";
    worktree_mode: boolean;
    worktree_multi_repo: boolean;
    armed: readonly string[];
    max_concurrent_jobs: number | null;
    // The EFFECTIVE per-root cap dispatch honors (boot-latched; floored to 1
    // while worktree mode is off). Meaning-stable — the old regime published
    // effective here too (stored always equaled it).
    max_concurrent_per_root: number;
    // ADDITIVE: the durable STORED per-root intent, distinct from effective.
    // `null` when the snapshot carries no autopilot rows — never fabricated
    // from effective.
    max_concurrent_per_root_stored: number | null;
  };
  board: { epics: EpicView[] };
  counts: {
    epics: VerdictTally;
    tasks: VerdictTally;
    close_rows: VerdictTally;
  };
  drained: boolean;
  jammed: boolean;
  drain: {
    // Live wrapped Provider legs without a durable ownership row. Display-only:
    // this cohort never contributes to needs-human, jammed, or drained.
    legacy_wrapped_provider_legs: number;
  };
  in_flight: {
    pending_dispatches: number;
    /** @deprecated Use `board_work_jobs` for the maintenance-window-safe count. */
    running_jobs: number;
    // Working Board-work sessions only (autopilot work/close + escalation
    // unblock/deconflict/resolve/repair), excluding the caller's own session.
    // Additive (v9) — the maintenance-window-safe count `running_jobs` can't
    // give you: that one counts EVERY working job, so an interactive session
    // (including the one asking) holds it open forever. Never rolled into
    // `total`, which stays the pre-existing pending+running sum.
    board_work_jobs: number;
    total: number;
  };
  needs_human: {
    dead_letters: number;
    block_escalations: number;
    stuck_dispatches: number;
    finalize_non_ff: number;
    // Count of per-repo finalize rows parked by the merge-suite gate (the
    // prospective lane→default merge result's fast suite failed). Additive, a
    // SUBSET of `stuck_dispatches` (never double-counted into `total`, like
    // `finalize_non_ff`).
    finalize_suite_red: number;
    // Count of epics carrying a non-null parked-closer question. Additive
    // (v4) — a distinct needs-human signal from the dispatch-failure family
    // (never mints a `dispatch_failures` row), included in `total`.
    parked_questions: number;
    // Distinct `(verb, id)` keys currently holding an instant-death-breaker
    // sticky (bind → sub-minute death × K). Additive (v5), a SUBSET of
    // `stuck_dispatches` (never double-counted into `total`, like
    // `finalize_non_ff`). At or above `INSTANT_DEATH_WALL_KEYS` this is the
    // board-wide SESSION/QUOTA-WALL signal (multiple keys tripping in a window);
    // a single one is the per-key breaker working. Signal only — no auto-pause.
    instant_death_wall: number;
    // Count of homed `work::` surface-and-stop rows whose reason carries the
    // `blocked:` prefix (a non-escalatable blocked category that never
    // dispatches an unblock session and never pages). Additive, a SUBSET of
    // `stuck_dispatches` (never double-counted into `total`, like
    // `finalize_non_ff` / `instant_death_wall`).
    blocked_work: number;
    // Done worktree epics which are not yet landed while the board is paused.
    // Display-only: a deliberate pause is never a jam or total contributor.
    finalize_pending: number;
    total: number;
  };
  rev: number | null;
  catching_up: boolean;
  // fn-1311 — total event count, DB byte size, and durations projected from
  // the most recent boot's measured catch-up rate. `null` only when the
  // daemon hasn't served a boot header yet (never happens on a real snapshot;
  // see `StatusBootInfo`).
  event_store: EventStoreStatus | null;
}

export type StatusEnvelope = Envelope<StatusData>;

export function countLegacyWrappedProviderLegs(
  snap: ReadinessClientSnapshot,
): number {
  const ownedSessions = new Set(
    (snap.providerLegOwnership ?? [])
      .map((row) => row.leg_session_id)
      .filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      ),
  );
  let count = 0;
  for (const [jobId, job] of snap.jobs) {
    if (
      job.backend_exec_birth_session_id === WRAPPED_EXEC_SESSION &&
      parseWrappedProviderTaskId(job.title) != null &&
      !ownedSessions.has(jobId)
    ) {
      count += 1;
    }
  }
  return count;
}

function isStaleRunningVerdict(
  verdict: Verdict | undefined,
): verdict is Extract<Verdict, { tag: "running" }> {
  return (
    verdict?.tag === "running" &&
    (verdict.reason.kind === "sub-agent-stale" ||
      verdict.reason.kind === "monitor-stale")
  );
}

function lastEvidenceAt(
  verdict: Verdict | undefined,
  jobs: readonly EmbeddedJob[],
  subagentInvocations: readonly SubagentInvocation[],
): number | null {
  if (!isStaleRunningVerdict(verdict)) {
    return null;
  }
  let latest: number | null = null;
  const consider = (value: number): void => {
    if (Number.isFinite(value) && (latest === null || value > latest)) {
      latest = value;
    }
  };
  if (verdict.reason.kind === "sub-agent-stale") {
    const jobIds = new Set(jobs.map((job) => job.job_id));
    for (const invocation of subagentInvocations) {
      if (jobIds.has(invocation.job_id) && isOpenTurnRow(invocation)) {
        consider(invocation.updated_at);
      }
    }
  } else {
    for (const job of jobs) {
      if (job.has_live_worker_monitor === true) {
        consider(job.updated_at);
      }
    }
  }
  return latest;
}

function verdictView(
  v: Verdict | undefined,
  evidenceJobs: readonly EmbeddedJob[] = [],
  subagentInvocations: readonly SubagentInvocation[] = [],
): VerdictView {
  if (v === undefined) {
    return {
      verdict: "unknown",
      pill: "[blocked:unknown]",
      last_evidence_at: null,
      dispatch_failure: [],
    };
  }
  return {
    verdict: v.tag,
    pill: formatPill(v),
    last_evidence_at: lastEvidenceAt(v, evidenceJobs, subagentInvocations),
    dispatch_failure: [],
  };
}

/** Tally a verdict map by tag. `blocked` absorbs every non-ready/running/done. */
function tallyVerdicts(m: Map<string, Verdict>): VerdictTally {
  const t: VerdictTally = {
    total: 0,
    ready: 0,
    running: 0,
    stale_running: 0,
    completed: 0,
    blocked: 0,
  };
  for (const v of m.values()) {
    t.total += 1;
    if (v.tag === "ready") {
      t.ready += 1;
    } else if (v.tag === "running") {
      if (isStaleRunningVerdict(v)) {
        t.stale_running += 1;
      } else {
        t.running += 1;
      }
    } else if (v.tag === "completed") {
      t.completed += 1;
    } else {
      t.blocked += 1;
    }
  }
  return t;
}

/**
 * Build the success status envelope from the readiness snapshot, the latched
 * boot header, and the sticky `dispatch_failures` rows. PURE — no socket, no
 * clock — so `test/status.test.ts` pins the shape against a fixture.
 *
 * `ownSessionId` (the caller's own `CLAUDE_CODE_SESSION_ID`, `null` when
 * unset) excludes the caller's own row from `in_flight.board_work_jobs` —
 * defaults to `null` so existing callers/fixtures are unaffected.
 */
export function buildStatusEnvelope(
  snap: ReadinessClientSnapshot,
  boot: StatusBootInfo,
  dispatchFailures: readonly Row[],
  ownSessionId: string | null = null,
): StatusEnvelope {
  // Resolve + classify each sticky `dispatch_failures` row to its board target
  // (a `work::` row → its task, a `close::` row — bare or worktree-mode-keyed →
  // its epic close row) via the shared pure module, collecting sorted-unique
  // KIND tokens per target. Render-only + additive; `verdict`/`pill`/`counts`
  // (readiness semantics) stay untouched. A `null` resolution (path-keyed
  // null-epic row / zero-match) drops silently — a missing pill, never a throw.
  const epicIds = snap.epics.map((e) => e.epic_id);
  const taskFailureKinds = new Map<string, Set<string>>();
  const closeFailureKinds = new Map<string, Set<string>>();
  for (const r of dispatchFailures) {
    const target = resolveFailureTarget(
      {
        verb: String(r.verb ?? ""),
        id: String(r.id ?? ""),
        dir: String(r.dir ?? ""),
      },
      epicIds,
    );
    if (target === null) {
      continue;
    }
    const kind = classifyDispatchFailure(String(r.reason ?? ""));
    const bucket =
      target.kind === "task" ? taskFailureKinds : closeFailureKinds;
    const key = target.kind === "task" ? target.taskId : target.epicId;
    let set = bucket.get(key);
    if (set === undefined) {
      set = new Set<string>();
      bucket.set(key, set);
    }
    set.add(kind);
  }
  const sortedKinds = (m: Map<string, Set<string>>, key: string): string[] =>
    [...(m.get(key) ?? [])].sort();

  const board = {
    epics: snap.epics.map((epic): EpicView => {
      const epicVerdict = snap.readiness.perEpic.get(epic.epic_id);
      const closeVerdict = snap.readiness.perCloseRow.get(epic.epic_id);
      const completedTaskJobs = epic.tasks.flatMap((task) =>
        snap.readiness.perTask.get(task.task_id)?.tag === "completed"
          ? (task.jobs ?? [])
          : [],
      );
      const allEpicJobs = [
        ...(epic.jobs ?? []),
        ...epic.tasks.flatMap((task) => task.jobs ?? []),
      ];
      return {
        epic_id: epic.epic_id,
        status: epic.status,
        question: epic.question ?? null,
        ...verdictView(epicVerdict, allEpicJobs, snap.subagentInvocations),
        tasks: epic.tasks.map(
          (task): TaskView => ({
            task_id: task.task_id,
            ...verdictView(
              snap.readiness.perTask.get(task.task_id),
              task.jobs ?? [],
              snap.subagentInvocations,
            ),
            dispatch_failure: sortedKinds(taskFailureKinds, task.task_id),
          }),
        ),
        close:
          closeVerdict === undefined
            ? null
            : {
                ...verdictView(
                  closeVerdict,
                  [...(epic.jobs ?? []), ...completedTaskJobs],
                  snap.subagentInvocations,
                ),
                dispatch_failure: sortedKinds(closeFailureKinds, epic.epic_id),
              },
      };
    }),
  };

  const epicTally = tallyVerdicts(snap.readiness.perEpic);

  const runningJobs = [...snap.jobs.values()].filter(
    (j) => j.state === "working",
  ).length;
  const boardWorkJobs = [...snap.jobs.values()].filter((j) =>
    isBoardWorkJob(j, ownSessionId),
  ).length;
  const pendingDispatches = snap.pendingDispatches.length;
  const inFlightTotal = pendingDispatches + runningJobs;

  // The whole needs-human classification derives from the ONE shared projector
  // (ADR 0011): broad stuck count, the finalize-non-ff / instant-death-wall
  // subsets (surfaced separately, never double-counted), and the umbrella total.
  // Parked-closer questions are a needs-human family that mints no
  // `dispatch_failures` row, so they feed the projector by epic id directly.
  const needsHuman = projectNeedsHuman({
    dispatchFailures,
    deadLetters: snap.deadLetters.length,
    blockEscalations: snap.blockEscalations.length,
    parkedQuestionEpicIds: snap.epics
      .filter((e) => (e.question ?? null) !== null)
      .map((e) => e.epic_id),
    epicIds,
  }).counts;
  const needsHumanTotal = needsHuman.total;
  const landed = new Set(snap.landedEpicIds ?? []);
  const finalizePending =
    snap.autopilotPaused && snap.worktreeMode
      ? snap.epics.filter(
          (epic) => epic.status === "done" && !landed.has(epic.epic_id),
        ).length
      : 0;

  // At rest: nothing the autopilot could dispatch right now (no ready/running
  // epic header, no in-flight launch). `jammed` vs `drained` splits on whether
  // a human-blocking signal remains.
  const atRest =
    inFlightTotal === 0 && epicTally.ready === 0 && epicTally.running === 0;
  const jammed = atRest && needsHumanTotal > 0;
  const drained = atRest && needsHumanTotal === 0;

  return successEnvelope(STATUS_SCHEMA_VERSION, {
    autopilot: {
      paused: snap.autopilotPaused,
      mode: snap.autopilotMode,
      worktree_mode: snap.worktreeMode,
      worktree_multi_repo: snap.worktreeMultiRepo,
      armed: snap.autopilotEligibleEpicIds ?? [],
      max_concurrent_jobs: snap.maxConcurrentJobs,
      max_concurrent_per_root: snap.maxConcurrentPerRoot,
      max_concurrent_per_root_stored: snap.maxConcurrentPerRootStored ?? null,
    },
    board,
    counts: {
      epics: epicTally,
      tasks: tallyVerdicts(snap.readiness.perTask),
      close_rows: tallyVerdicts(snap.readiness.perCloseRow),
    },
    drained,
    jammed,
    drain: {
      legacy_wrapped_provider_legs: countLegacyWrappedProviderLegs(snap),
    },
    in_flight: {
      pending_dispatches: pendingDispatches,
      running_jobs: runningJobs,
      board_work_jobs: boardWorkJobs,
      total: inFlightTotal,
    },
    needs_human: {
      dead_letters: needsHuman.deadLetters,
      block_escalations: needsHuman.blockEscalations,
      stuck_dispatches: needsHuman.stuckDispatches,
      finalize_non_ff: needsHuman.finalizeNonFf,
      finalize_suite_red: needsHuman.finalizeSuiteRed,
      parked_questions: needsHuman.parkedQuestions,
      instant_death_wall: needsHuman.instantDeathWall,
      blocked_work: needsHuman.blockedWork,
      finalize_pending: finalizePending,
      total: needsHuman.total,
    },
    rev: boot.rev,
    catching_up: boot.catching_up,
    event_store: boot.event_store,
  });
}

/** The transport-failure envelope (exit 1, but still parseable JSON on stdout).
 *  `error.message` carries the human string; `error.code` is stable and
 *  machine-matchable; `error.recovery` is the actionable next step. */
export function buildStatusErrorEnvelope(error: ProblemError): StatusEnvelope {
  return errorEnvelope(STATUS_SCHEMA_VERSION, error);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedStatusArgs {
  sock: string;
  connectTimeoutMs: number;
  /** Resolved output format (`--format` / `--json` alias; json | yaml). */
  format: FormatMode;
}

/** Exit code for a usage/grammar fault (a bad flag value). */
const EXIT_USAGE = 2;

interface ParseFailure {
  ok: false;
  message: string;
  /** Process exit code for `main` (default 1); a bad duration is a usage
   *  fault → exit 2 under the shared grammar. */
  exitCode?: number;
}

interface ParseSuccess {
  ok: true;
  args: ParsedStatusArgs;
}

export function parseStatusArgs(argv: string[]): ParseFailure | ParseSuccess {
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: argv,
      // Derived from the pure-data descriptor (ADR 0008).
      options: parseOptions("status"),
      allowPositionals: false,
      strict: true,
    });
    values = parsed.values as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (values.help === true) {
    return { ok: false, message: "__help__" };
  }

  const fmt = resolveFormat("status", values);
  if (!fmt.ok) {
    return { ok: false, message: fmt.message, exitCode: EXIT_USAGE };
  }

  let connectTimeoutMs = DEFAULT_CONNECT_DEADLINE_MS;
  const raw = values["connect-timeout"];
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = parseDuration(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        message: `--connect-timeout ${parsed.message}`,
        exitCode: EXIT_USAGE,
      };
    }
    connectTimeoutMs = parsed.ms;
  }

  const sock =
    typeof values.sock === "string"
      ? (values.sock as string)
      : resolveSockPath();

  return { ok: true, args: { sock, connectTimeoutMs, format: fmt.format } };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunStatusDeps {
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
  exit: (code: number) => never;
  /** Test-injection connect factory forwarded to `subscribeReadiness`. */
  connect?: ConnectFactory;
  /** Test clock forwarded to the give-up deadline. */
  now?: () => number;
  /** The caller's own `CLAUDE_CODE_SESSION_ID` (`null` when unset), excluded
   *  from `in_flight.board_work_jobs`. Defaults to `null`. */
  ownSessionId?: string | null;
}

/**
 * Open the bare readiness subscribe, print the envelope off the first composite
 * snapshot, then exit. A single `done` latch guards the snapshot↔fatal race so
 * neither double-fires.
 */
export async function runStatus(
  args: ParsedStatusArgs,
  deps: RunStatusDeps,
): Promise<void> {
  let latestBoot: StatusBootInfo = {
    rev: null,
    catching_up: false,
    event_store: null,
  };
  let done = false;
  let handle: ReadinessClientHandle | null = null;

  const disposeHandle = (): void => {
    if (handle !== null) {
      try {
        handle.dispose();
      } catch {
        // dispose is idempotent
      }
      handle = null;
    }
  };

  const finishSuccess = (snap: ReadinessClientSnapshot): void => {
    // ADR 0011: the sticky `dispatch_failures` rows ride the snapshot under the
    // `includeDispatchFailures` opt-in — ONE round-trip, no out-of-band read.
    // Absent (never null/empty) only if the flag were off; here it is always on,
    // so `?? []` is a belt-and-suspenders default the envelope treats as "no jam".
    const failures = snap.dispatchFailures ?? [];
    const envelope = buildStatusEnvelope(
      snap,
      latestBoot,
      failures,
      deps.ownSessionId ?? null,
    );
    emitEnvelopeFormatted(envelope, deps, args.format);
  };

  const onSnapshot = (snap: ReadinessClientSnapshot): void => {
    if (done) {
      return;
    }
    done = true;
    disposeHandle();
    finishSuccess(snap);
  };

  const onFatal = (err: FatalError): void => {
    if (done) {
      return;
    }
    done = true;
    disposeHandle();
    const reason = err.code === "unreachable" ? "unreachable" : "connect";
    // `message` preserves the old bare-string ("unreachable: <detail>") so a
    // consumer that stringifies `error` degrades readably; `code` is the stable
    // match key; `recovery` is the actionable step.
    const envelope = buildStatusErrorEnvelope({
      code: reason,
      message: `${reason}: ${err.message}`,
      recovery: RECOVERY_DAEMON_DOWN,
    });
    emitEnvelopeFormatted(envelope, deps, args.format);
  };

  handle = subscribeReadiness({
    sockPath: args.sock,
    idPrefix: `status-${process.pid}`,
    onSnapshot,
    onFatal,
    // ADR 0011: carry the sticky `dispatch_failures` rows on the snapshot so the
    // jammed / needs-human signals read from ONE round-trip, not an out-of-band
    // query. The gate holds first paint until the collection paints, so a
    // painted snapshot always carries the real jam rows.
    includeDispatchFailures: true,
    includeProviderLegOwnership: true,
    // ADR 0018: opt into the pinned-epics window too — a plan-closed epic with
    // a live close/work dispatch failure merges open-wins into `epics`, so
    // `board.epics` (built off `snap.epics`) carries its close verdict and
    // `dispatch_failure` kinds. `needs_human.stuck_dispatches` already tallies
    // EVERY sticky row regardless of homing (`rows.length`), so pinning an
    // epic never changes `needs_human.total` — only which board row the row's
    // kinds attach to.
    includePinnedEpics: true,
    // Include recent done epics and their landed set: paused worktree finalizes
    // age off the open board otherwise, making the display-only count invisible.
    includeRecentDoneEpics: true,
    giveUpPolicy: { deadlineMs: args.connectTimeoutMs },
    onBootStatus: (boot: BootStatus): void => {
      latestBoot = {
        rev: boot.rev,
        catching_up: boot.catching_up,
        // fn-1311: the event-store block no longer rides the boot header — it
        // arrives on the `result` frame via `onEventStore` (the steady-state
        // channel the header omits). Preserve whatever that callback last set.
        event_store: latestBoot.event_store,
      };
    },
    // fn-1311: capture the event-store block off the `result` frame. This is the
    // ONLY path that fires against a healthy caught-up daemon, whose memoized
    // reply carries no boot header.
    onEventStore: (eventStore: EventStoreStatus): void => {
      latestBoot.event_store = eventStore;
    },
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.connect === undefined ? {} : { connect: deps.connect }),
  });
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseStatusArgs(argv);
  if (!parsed.ok) {
    if (parsed.message === "__help__") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    process.stderr.write(`keeper status: ${parsed.message}\n\n`);
    process.stderr.write(HELP);
    process.exit(parsed.exitCode ?? 1);
  }

  await runStatus(parsed.args, {
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
    exit: (code) => process.exit(code),
    ownSessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
  });
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical entry.
