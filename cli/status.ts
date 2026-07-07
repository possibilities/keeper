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
 * all-strict first-paint gate). On that first frame we dispose the handle,
 * pull the sticky `dispatch_failures` rows for the jammed / needs-human
 * signals (a best-effort one-shot `queryCollection` — NEVER `sendControlRpc`),
 * print the envelope, and exit. UNLIKE `server-up`, the subscribe carries a
 * bounded default ~10s `giveUpPolicy`: a one-shot orient must NOT reconnect
 * forever, so a down daemon fires `onFatal({code:"unreachable"})` → exit 1.
 *
 * Exit taxonomy: exit 0 on ANY board state (a bad board is DATA, not an
 * error). Exit 1 ONLY on transport (`unreachable`/`connect`) or usage. On a
 * transport failure we still emit a `{ok:false, error}` envelope on stdout so
 * an agent always parses the last stdout as JSON; a usage fault prints HELP to
 * stderr.
 *
 * `drained`/`jammed`/`needs-human` are computed INLINE here from the readiness
 * snapshot (verdicts + in-flight + each epic's parked-closer `question`) plus
 * the `dispatch_failures` read. The canonical pure predicate is task-4's
 * (`await drained`); when it lands, dedupe this with an import.
 * TODO(fn-1015.4): replace the inline drained/jammed with the shared predicate.
 */

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  classifyDispatchFailure,
  resolveFailureTarget,
} from "../src/dispatch-failure-pill";
import { projectNeedsHuman } from "../src/needs-human";
import type { BootStatus, Row } from "../src/protocol";
import { formatPill, type Verdict } from "../src/readiness";
import {
  type ConnectFactory,
  type FatalError,
  type ReadinessClientHandle,
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import { queryCollection } from "./control-rpc";
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
 * `needs_human.instant_death_wall` count (the instant-death circuit breaker). */
export const STATUS_SCHEMA_VERSION = 5;

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
booleans, in-flight launches, needs-human signals, and {rev, catching_up}. Each
task + close view also carries dispatch_failure: string[] — the sticky
dispatch_failures block KINDS (multi-repo / merge-conflict / dirty-tree / non-ff)
readiness can't see; [] when clean.

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
`;

// ---------------------------------------------------------------------------
// Envelope shape (pure)
// ---------------------------------------------------------------------------

export interface VerdictTally {
  total: number;
  ready: number;
  running: number;
  completed: number;
  blocked: number;
}

export interface StatusBootInfo {
  rev: number | null;
  catching_up: boolean;
}

interface VerdictView {
  verdict: string;
  pill: string;
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
  in_flight: {
    pending_dispatches: number;
    running_jobs: number;
    total: number;
  };
  needs_human: {
    dead_letters: number;
    block_escalations: number;
    stuck_dispatches: number;
    finalize_non_ff: number;
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
    total: number;
  };
  rev: number | null;
  catching_up: boolean;
}

export type StatusEnvelope = Envelope<StatusData>;

/** Render one (possibly absent) verdict to its JSON view. A miss renders the
 *  same inert `[blocked:unknown]` the board uses (visible bug indicator, never
 *  dispatchable). */
function verdictView(v: Verdict | undefined): VerdictView {
  if (v === undefined) {
    return {
      verdict: "unknown",
      pill: "[blocked:unknown]",
      dispatch_failure: [],
    };
  }
  return { verdict: v.tag, pill: formatPill(v), dispatch_failure: [] };
}

/** Tally a verdict map by tag. `blocked` absorbs every non-ready/running/done. */
function tallyVerdicts(m: Map<string, Verdict>): VerdictTally {
  const t: VerdictTally = {
    total: 0,
    ready: 0,
    running: 0,
    completed: 0,
    blocked: 0,
  };
  for (const v of m.values()) {
    t.total += 1;
    if (v.tag === "ready") {
      t.ready += 1;
    } else if (v.tag === "running") {
      t.running += 1;
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
 */
export function buildStatusEnvelope(
  snap: ReadinessClientSnapshot,
  boot: StatusBootInfo,
  dispatchFailures: readonly Row[],
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
      const closeVerdict = snap.readiness.perCloseRow.get(epic.epic_id);
      return {
        epic_id: epic.epic_id,
        status: epic.status,
        question: epic.question ?? null,
        ...verdictView(snap.readiness.perEpic.get(epic.epic_id)),
        tasks: epic.tasks.map(
          (task): TaskView => ({
            task_id: task.task_id,
            ...verdictView(snap.readiness.perTask.get(task.task_id)),
            dispatch_failure: sortedKinds(taskFailureKinds, task.task_id),
          }),
        ),
        close:
          closeVerdict === undefined
            ? null
            : {
                ...verdictView(closeVerdict),
                dispatch_failure: sortedKinds(closeFailureKinds, epic.epic_id),
              },
      };
    }),
  };

  const epicTally = tallyVerdicts(snap.readiness.perEpic);

  const runningJobs = [...snap.jobs.values()].filter(
    (j) => j.state === "working",
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
    in_flight: {
      pending_dispatches: pendingDispatches,
      running_jobs: runningJobs,
      total: inFlightTotal,
    },
    needs_human: {
      dead_letters: needsHuman.deadLetters,
      block_escalations: needsHuman.blockEscalations,
      stuck_dispatches: needsHuman.stuckDispatches,
      finalize_non_ff: needsHuman.finalizeNonFf,
      parked_questions: needsHuman.parkedQuestions,
      instant_death_wall: needsHuman.instantDeathWall,
      total: needsHuman.total,
    },
    rev: boot.rev,
    catching_up: boot.catching_up,
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
  /** Best-effort sticky dispatch_failures read (defaults to the real transport). */
  fetchDispatchFailures: (sock: string) => Promise<Row[]>;
  /** Test-injection connect factory forwarded to `subscribeReadiness`. */
  connect?: ConnectFactory;
  /** Test clock forwarded to the give-up deadline. */
  now?: () => number;
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
  let latestBoot: StatusBootInfo = { rev: null, catching_up: false };
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

  const finishSuccess = async (
    snap: ReadinessClientSnapshot,
  ): Promise<void> => {
    let failures: Row[] = [];
    try {
      failures = await deps.fetchDispatchFailures(args.sock);
    } catch {
      // Best-effort: a vanished daemon between snapshot and read degrades the
      // jammed/needs-human signal to empty rather than failing the orient.
      failures = [];
    }
    const envelope = buildStatusEnvelope(snap, latestBoot, failures);
    emitEnvelopeFormatted(envelope, deps, args.format);
  };

  const onSnapshot = (snap: ReadinessClientSnapshot): void => {
    if (done) {
      return;
    }
    done = true;
    disposeHandle();
    void finishSuccess(snap);
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
    giveUpPolicy: { deadlineMs: args.connectTimeoutMs },
    onBootStatus: (boot: BootStatus): void => {
      latestBoot = { rev: boot.rev, catching_up: boot.catching_up };
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
    fetchDispatchFailures: (sock) =>
      queryCollection(sock, "dispatch_failures") as Promise<Row[]>,
  });
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical entry.
