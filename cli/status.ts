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
 * snapshot (verdicts + in-flight) plus the `dispatch_failures` read. The
 * canonical pure predicate is task-4's (`await drained`); when it lands, dedupe
 * this with an import. TODO(fn-1015.4): replace the inline drained/jammed with
 * the shared predicate.
 */

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
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

/** Envelope schema version for `keeper status`. */
export const STATUS_SCHEMA_VERSION = 1;

/**
 * Default bounded connect deadline (~10s). A one-shot orient must give up
 * rather than reconnect forever when the daemon is down; `--connect-timeout`
 * overrides it.
 */
export const DEFAULT_CONNECT_DEADLINE_MS = 10_000;

/** The `dispatch_failures.reason` that needs an operator to reconcile origin. */
const FINALIZE_NON_FF_REASON = "worktree-finalize-non-fast-forward";

export const HELP = `keeper status — one-shot unified board + autopilot JSON read

Usage:
  keeper status [--json] [--sock <path>] [--connect-timeout <dur>]

Prints ONE {schema_version, ok, error, data} envelope: autopilot config, the
per-epic/-task/-close-row readiness verdicts, aggregate counts, drained/jammed
booleans, in-flight launches, needs-human signals, and {rev, catching_up}.

Flags:
  --json                   Emit JSON (default; accepted for symmetry)
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
}

interface TaskView extends VerdictView {
  task_id: string;
}

interface EpicView extends VerdictView {
  epic_id: string;
  status: string | null;
  tasks: TaskView[];
  close: VerdictView | null;
}

export interface StatusData {
  autopilot: {
    paused: boolean;
    mode: "yolo" | "armed";
    worktree_mode: boolean;
    armed: readonly string[];
    max_concurrent_jobs: number | null;
    max_concurrent_per_root: number;
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
    total: number;
  };
  rev: number | null;
  catching_up: boolean;
}

export interface StatusEnvelope {
  schema_version: number;
  ok: boolean;
  error: string | null;
  data: StatusData | null;
}

/** Render one (possibly absent) verdict to its JSON view. A miss renders the
 *  same inert `[blocked:unknown]` the board uses (visible bug indicator, never
 *  dispatchable). */
function verdictView(v: Verdict | undefined): VerdictView {
  if (v === undefined) {
    return { verdict: "unknown", pill: "[blocked:unknown]" };
  }
  return { verdict: v.tag, pill: formatPill(v) };
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
  const board = {
    epics: snap.epics.map((epic): EpicView => {
      const closeVerdict = snap.readiness.perCloseRow.get(epic.epic_id);
      return {
        epic_id: epic.epic_id,
        status: epic.status,
        ...verdictView(snap.readiness.perEpic.get(epic.epic_id)),
        tasks: epic.tasks.map(
          (task): TaskView => ({
            task_id: task.task_id,
            ...verdictView(snap.readiness.perTask.get(task.task_id)),
          }),
        ),
        close: closeVerdict === undefined ? null : verdictView(closeVerdict),
      };
    }),
  };

  const epicTally = tallyVerdicts(snap.readiness.perEpic);

  const runningJobs = [...snap.jobs.values()].filter(
    (j) => j.state === "working",
  ).length;
  const pendingDispatches = snap.pendingDispatches.length;
  const inFlightTotal = pendingDispatches + runningJobs;

  const stuckDispatches = dispatchFailures.length;
  const finalizeNonFf = dispatchFailures.filter(
    (r) => r.reason === FINALIZE_NON_FF_REASON,
  ).length;
  const deadLetters = snap.deadLetters.length;
  const blockEscalations = snap.blockEscalations.length;
  // `finalize_non_ff` is a SUBSET of `stuck_dispatches` — surfaced separately,
  // never double-counted into the total.
  const needsHumanTotal = deadLetters + blockEscalations + stuckDispatches;

  // At rest: nothing the autopilot could dispatch right now (no ready/running
  // epic header, no in-flight launch). `jammed` vs `drained` splits on whether
  // a human-blocking signal remains.
  const atRest =
    inFlightTotal === 0 && epicTally.ready === 0 && epicTally.running === 0;
  const jammed = atRest && needsHumanTotal > 0;
  const drained = atRest && needsHumanTotal === 0;

  return {
    schema_version: STATUS_SCHEMA_VERSION,
    ok: true,
    error: null,
    data: {
      autopilot: {
        paused: snap.autopilotPaused,
        mode: snap.autopilotMode,
        worktree_mode: snap.worktreeMode,
        armed: snap.autopilotEligibleEpicIds ?? [],
        max_concurrent_jobs: snap.maxConcurrentJobs,
        max_concurrent_per_root: snap.maxConcurrentPerRoot,
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
        dead_letters: deadLetters,
        block_escalations: blockEscalations,
        stuck_dispatches: stuckDispatches,
        finalize_non_ff: finalizeNonFf,
        total: needsHumanTotal,
      },
      rev: boot.rev,
      catching_up: boot.catching_up,
    },
  };
}

/** The transport-failure envelope (exit 1, but still parseable JSON on stdout). */
export function buildStatusErrorEnvelope(error: string): StatusEnvelope {
  return {
    schema_version: STATUS_SCHEMA_VERSION,
    ok: false,
    error,
    data: null,
  };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedStatusArgs {
  sock: string;
  connectTimeoutMs: number;
}

interface ParseFailure {
  ok: false;
  message: string;
}

interface ParseSuccess {
  ok: true;
  args: ParsedStatusArgs;
}

/** Parse a duration like `30s`, `5m`, `2h`, or a bare-ms integer. `null` on a
 *  parse error. */
function parseDurationMs(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (m === null) {
    return null;
  }
  const n = Number.parseInt(m[1] ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  switch (m[2] ?? "ms") {
    case "ms":
      return n;
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return null;
  }
}

export function parseStatusArgs(argv: string[]): ParseFailure | ParseSuccess {
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        sock: { type: "string" },
        "connect-timeout": { type: "string" },
      },
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

  let connectTimeoutMs = DEFAULT_CONNECT_DEADLINE_MS;
  const raw = values["connect-timeout"];
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = parseDurationMs(raw);
    if (parsed === null) {
      return {
        ok: false,
        message: `invalid --connect-timeout '${raw}' (expected e.g. 10s, 5m, or ms integer)`,
      };
    }
    connectTimeoutMs = parsed;
  }

  const sock =
    typeof values.sock === "string"
      ? (values.sock as string)
      : resolveSockPath();

  return { ok: true, args: { sock, connectTimeoutMs } };
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
    deps.writeStdout(`${JSON.stringify(envelope, null, 2)}\n`);
    deps.exit(0);
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
    const envelope = buildStatusErrorEnvelope(`${reason}: ${err.message}`);
    deps.writeStdout(`${JSON.stringify(envelope, null, 2)}\n`);
    deps.exit(1);
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
    process.exit(1);
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
