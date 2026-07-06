#!/usr/bin/env bun
/**
 * `keeper watch [--json] [--filter <type>]... [--sock <path>]` — a NON-EXITING
 * NDJSON tail of coarse board deltas over `subscribeReadiness` (fn-1015). The
 * agent-facing "show me what's moving" stream that pairs with the one-shot
 * `keeper status` orient: subscribe, emit a baseline full-snapshot line, then
 * one coarse delta line per real change (epic added/removed, verdict change,
 * runtime block/unblock overlay flip, job-state change, autopilot
 * mode/pause/worktree/caps change). Reconnects
 * FOREVER (intentional — a daemon bounce must not end the tail).
 *
 * Each line is one `{schema_version, sequence, type, data}` JSON object;
 * `sequence` is a per-process counter so a consumer can detect a gap.
 *
 * Coarse, NOT a firehose: raw events would blow an LLM's context budget, so the
 * tail emits semantic deltas only. Successive snapshots are projected to a
 * coarse board and diffed client-side; an empty diff (a reconnect re-paint is
 * byte-identical → no delta) emits NOTHING. Frames are coalesced over a short
 * window so a fold burst collapses into one diff, then held over a trailing
 * flap-settle window so a completion-window round-trip (a `worker_phase="done"`
 * task momentarily re-asserting `running:*` as its session winds down, and the
 * `running↔blocked` close-row flap downstream of it) collapses to no delta while
 * a settled change or genuine rescind still emits (see {@link FLAP_SETTLE_MS}).
 * An idle keepalive line fires periodically carrying the current `sequence` so a
 * consumer knows the stream is alive.
 *
 * `--filter <type>` is a NAMED-TYPE allowlist (no free-form eval = no injection
 * surface): pass one or more of the delta type names to emit only those. The
 * `baseline` line is always emitted (a consumer needs the ground state);
 * `keepalive` is suppressed only by `--filter` naming neither it nor leaving
 * the filter empty. An off-allowlist `--filter` value is a usage error (exit 1)
 * caught at parse time, before any socket opens.
 */

import { parseArgs } from "node:util";
import { verdictKey } from "../src/await-conditions";
import { resolveSockPath } from "../src/db";
import {
  type ConnectFactory,
  type ReadinessClientHandle,
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";

/** Envelope schema version for `keeper watch` lines. */
export const WATCH_SCHEMA_VERSION = 1;

/** Default coalesce window (ms) — collapses a fold burst into one diff. */
export const COALESCE_MS = 75;

/** Default idle keepalive cadence (ms). */
export const KEEPALIVE_MS = 30_000;

/**
 * Trailing flap-settle window (ms). A verdict / job / close-row key that
 * round-trips back to its last-EMITTED value within this window is
 * completion-window noise, not a real move: a `worker_phase="done"` stamp races
 * ahead of the worker session going idle, so the readiness pipeline correctly
 * re-asserts `running:*` on each post-done liveness blip (a spawned sub-agent, a
 * final working turn, a backgrounded monitor) then clears back to `completed`;
 * the close row's synth-close dep flaps `running↔blocked` downstream. Because the
 * reducer commits per event, a subscriber observes that oscillation, and the raw
 * diff would emit `A→B` then `B→A`. We instead hold each change this long and
 * emit only the NET change vs. the last-emitted board: an `A→B→A` round-trip
 * collapses to nothing, while a settled change or a genuine rescind (a `B` that
 * persists past the window) still emits. Sized above the readiness-client poll
 * cadence (`POLL_MS` = 500) so a blip straddling one poll interval still nets
 * out; a state that outlives the window is real and surfaces.
 */
export const FLAP_SETTLE_MS = 750;

/** The coarse delta type names — the `--filter` allowlist (minus baseline,
 *  which is always emitted, and keepalive). */
export const WATCH_DELTA_TYPES = [
  "epic-added",
  "epic-removed",
  "verdict-change",
  "job-state-change",
  "autopilot-change",
] as const;
export type WatchDeltaType = (typeof WATCH_DELTA_TYPES)[number];

/** Every emittable line `type`, including the always-on `baseline` + the
 *  idle `keepalive`. `--filter` accepts the coarse delta names AND `keepalive`. */
const FILTERABLE_TYPES: ReadonlySet<string> = new Set([
  ...WATCH_DELTA_TYPES,
  "keepalive",
]);

export const HELP = `keeper watch — NDJSON tail of coarse board deltas (never exits)

Usage:
  keeper watch [--json] [--filter <type>]... [--sock <path>]

Subscribes to the board and streams one JSON line per change:
  {schema_version, sequence, type, data}

A baseline full-snapshot line is emitted first, then one coarse delta line per
real change. Reconnects forever; suppresses null-diffs; coalesces bursts; emits
an idle keepalive carrying the current sequence.

Delta types (also the --filter allowlist):
  epic-added        an epic appeared on the board
  epic-removed      an epic left the board (done or deleted)
  verdict-change    a task / close-row readiness verdict changed, OR a manual
                    keeper plan block/unblock flipped a task's runtime overlay
  job-state-change  a job's state changed (added / removed / transitioned)
  autopilot-change  autopilot mode / pause / worktree / caps changed
  keepalive         idle liveness line (filterable)

Flags:
  --filter <type>  Emit only the named delta type(s) (repeatable; allowlist
                   above). The 'baseline' line is always emitted
  --json           Emit JSON (default; accepted for symmetry)
  --sock <path>    Socket override ($KEEPER_SOCK / default)
  --help           Show this help

Never exits (Ctrl-C / SIGTERM to stop). Pair with 'keeper status' for a
one-shot orient.

Examples:
  keeper watch --json
  keeper watch --filter verdict-change --filter epic-removed
`;

// ---------------------------------------------------------------------------
// Coarse board projection + pure diff (the tested core)
// ---------------------------------------------------------------------------

export interface CoarseBoard {
  /** epic_id → status. */
  epics: Record<string, string | null>;
  /** task_id → verdict key. */
  taskVerdicts: Record<string, string>;
  /** epic_id → close-row verdict key. */
  closeVerdicts: Record<string, string>;
  /** job_id → state. */
  jobStates: Record<string, string>;
  /**
   * task_id → `true` for a task whose plan `runtime_status` is `blocked` — the
   * manual `keeper plan block` overlay behind the board's `[rt:blocked]` pill.
   * Absent ⇒ not blocked. Tracked APART from {@link taskVerdicts} because the
   * runtime-blocked readiness predicate (rank 10.6) converts ONLY an otherwise-
   * `ready` row: a block/unblock of a task blocked for another reason (a dep, a
   * live worker) never moves its verdict, yet the overlay flip IS a real board
   * move `keeper watch` must surface. Only the `blocked` value is tracked — the
   * other `runtime_status` values (`todo`/`in_progress`/`done`) already ride the
   * verdict + job-state families, so tracking them here would double-emit.
   */
  taskBlocked: Record<string, true>;
  autopilot: {
    mode: string;
    paused: boolean;
    worktree_mode: boolean;
    max_concurrent_jobs: number | null;
    // The EFFECTIVE per-root cap; `_stored` is the durable intent (ABSENT when
    // the snapshot carries no autopilot rows — never fabricated). Both ride the
    // coarse `autopilot-change` diff, so setting intent while worktree is off is
    // a visible board move even though effective stays 1.
    max_concurrent_per_root: number;
    max_concurrent_per_root_stored?: number;
  };
}

/** One coarse delta line's payload. */
export interface WatchDelta {
  type: WatchDeltaType;
  data: Record<string, unknown>;
}

/**
 * Project a readiness snapshot into the coarse board the tail diffs over.
 * Deliberately drops git_status / subagent / dead-letter churn — those are
 * heartbeat noise an orienting agent does not want one line per.
 */
export function projectCoarseBoard(snap: ReadinessClientSnapshot): CoarseBoard {
  const epics: Record<string, string | null> = {};
  for (const e of snap.epics) {
    epics[e.epic_id] = e.status ?? null;
  }
  const taskVerdicts: Record<string, string> = {};
  for (const [taskId, v] of snap.readiness.perTask) {
    taskVerdicts[taskId] = verdictKey(v);
  }
  const closeVerdicts: Record<string, string> = {};
  for (const [epicId, v] of snap.readiness.perCloseRow) {
    closeVerdicts[epicId] = verdictKey(v);
  }
  const jobStates: Record<string, string> = {};
  for (const [jobId, job] of snap.jobs) {
    jobStates[jobId] = job.state;
  }
  // The raw `blocked` runtime-overlay, read off each epic's embedded tasks —
  // the honest source for the `[rt:blocked]` pill, independent of the verdict.
  const taskBlocked: Record<string, true> = {};
  for (const e of snap.epics) {
    for (const t of e.tasks ?? []) {
      if (t.runtime_status === "blocked") {
        taskBlocked[t.task_id] = true;
      }
    }
  }
  return {
    epics,
    taskVerdicts,
    closeVerdicts,
    jobStates,
    taskBlocked,
    autopilot: {
      mode: snap.autopilotMode,
      paused: snap.autopilotPaused,
      worktree_mode: snap.worktreeMode,
      max_concurrent_jobs: snap.maxConcurrentJobs,
      max_concurrent_per_root: snap.maxConcurrentPerRoot,
      ...(snap.maxConcurrentPerRootStored === undefined
        ? {}
        : { max_concurrent_per_root_stored: snap.maxConcurrentPerRootStored }),
    },
  };
}

/** Diff two `Record<string,V>` maps into added / removed / changed entries. */
function diffRecords<V>(
  prev: Record<string, V>,
  next: Record<string, V>,
): {
  added: [string, V][];
  removed: [string, V][];
  changed: [string, V, V][];
} {
  const added: [string, V][] = [];
  const removed: [string, V][] = [];
  const changed: [string, V, V][] = [];
  for (const k of Object.keys(next).sort()) {
    if (!(k in prev)) {
      added.push([k, next[k] as V]);
    } else if (prev[k] !== next[k]) {
      changed.push([k, prev[k] as V, next[k] as V]);
    }
  }
  for (const k of Object.keys(prev).sort()) {
    if (!(k in next)) {
      removed.push([k, prev[k] as V]);
    }
  }
  return { added, removed, changed };
}

/**
 * Pure coarse diff. Returns one {@link WatchDelta} per real change between
 * `prev` and `next`; an empty array means a null-diff (the caller emits
 * NOTHING). Deterministic ordering: epics, then verdicts, then jobs, then
 * autopilot — keys sorted within each family so a reconnect re-paint of an
 * unchanged board produces the same (empty) result.
 */
export function diffCoarseBoard(
  prev: CoarseBoard,
  next: CoarseBoard,
): WatchDelta[] {
  const out: WatchDelta[] = [];

  const epicDiff = diffRecords(prev.epics, next.epics);
  for (const [epic_id, status] of epicDiff.added) {
    out.push({ type: "epic-added", data: { epic_id, status } });
  }
  for (const [epic_id] of epicDiff.removed) {
    out.push({ type: "epic-removed", data: { epic_id } });
  }
  // A status change on a still-present epic is a verdict-adjacent move; surface
  // it as an epic-added re-statement would be misleading, so route through the
  // verdict-change family with an explicit `kind: "epic-status"`.
  for (const [epic_id, from, to] of epicDiff.changed) {
    out.push({
      type: "verdict-change",
      data: { kind: "epic-status", id: epic_id, from, to },
    });
  }

  const taskDiff = diffRecords(prev.taskVerdicts, next.taskVerdicts);
  for (const [id, to] of taskDiff.added) {
    out.push({
      type: "verdict-change",
      data: { kind: "task", id, from: null, to },
    });
  }
  for (const [id, from] of taskDiff.removed) {
    out.push({
      type: "verdict-change",
      data: { kind: "task", id, from, to: null },
    });
  }
  for (const [id, from, to] of taskDiff.changed) {
    out.push({ type: "verdict-change", data: { kind: "task", id, from, to } });
  }

  const closeDiff = diffRecords(prev.closeVerdicts, next.closeVerdicts);
  for (const [id, to] of closeDiff.added) {
    out.push({
      type: "verdict-change",
      data: { kind: "close", id, from: null, to },
    });
  }
  for (const [id, from] of closeDiff.removed) {
    out.push({
      type: "verdict-change",
      data: { kind: "close", id, from, to: null },
    });
  }
  for (const [id, from, to] of closeDiff.changed) {
    out.push({ type: "verdict-change", data: { kind: "close", id, from, to } });
  }

  // Raw `blocked` runtime-overlay transitions — a manual `keeper plan block`
  // (added) / `unblock` (removed). Routed through the `verdict-change` family
  // with an explicit `kind: "runtime-status"`, mirroring the `epic-status`
  // routing above, so the `--filter` allowlist needs no new type. The value is
  // always `true`, so only `added` (block) / `removed` (unblock) occur.
  const blockedDiff = diffRecords(prev.taskBlocked, next.taskBlocked);
  for (const [id] of blockedDiff.added) {
    out.push({
      type: "verdict-change",
      data: { kind: "runtime-status", id, blocked: true },
    });
  }
  for (const [id] of blockedDiff.removed) {
    out.push({
      type: "verdict-change",
      data: { kind: "runtime-status", id, blocked: false },
    });
  }

  const jobDiff = diffRecords(prev.jobStates, next.jobStates);
  for (const [job_id, to] of jobDiff.added) {
    out.push({
      type: "job-state-change",
      data: { job_id, from: null, to },
    });
  }
  for (const [job_id, from] of jobDiff.removed) {
    out.push({
      type: "job-state-change",
      data: { job_id, from, to: null },
    });
  }
  for (const [job_id, from, to] of jobDiff.changed) {
    out.push({ type: "job-state-change", data: { job_id, from, to } });
  }

  if (JSON.stringify(prev.autopilot) !== JSON.stringify(next.autopilot)) {
    out.push({
      type: "autopilot-change",
      data: { from: prev.autopilot, to: next.autopilot },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface ParsedWatchArgs {
  sock: string;
  /** Allowlisted delta types to emit; empty ⇒ emit every type. */
  filter: Set<string>;
}

interface ParseFailure {
  ok: false;
  message: string;
}

interface ParseSuccess {
  ok: true;
  args: ParsedWatchArgs;
}

export function parseWatchArgs(argv: string[]): ParseFailure | ParseSuccess {
  let values: Record<string, unknown>;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        help: { type: "boolean", short: "h" },
        json: { type: "boolean" },
        sock: { type: "string" },
        filter: { type: "string", multiple: true },
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

  const filter = new Set<string>();
  const rawFilters = Array.isArray(values.filter)
    ? (values.filter as string[])
    : [];
  for (const f of rawFilters) {
    if (!FILTERABLE_TYPES.has(f)) {
      return {
        ok: false,
        message: `unknown --filter type '${f}' (allowed: ${[...FILTERABLE_TYPES].sort().join(", ")})`,
      };
    }
    filter.add(f);
  }

  const sock =
    typeof values.sock === "string"
      ? (values.sock as string)
      : resolveSockPath();

  return { ok: true, args: { sock, filter } };
}

// ---------------------------------------------------------------------------
// Runner (dependency-injected so tests drive without process / wall-clock)
// ---------------------------------------------------------------------------

/** Timer shims (default real `setInterval`/`setTimeout`); tests inject a fake
 *  clock so the coalesce + flap-settle windows are driven deterministically. */
export interface TimerDeps {
  setInterval: (cb: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

export interface DeltaEmitterDeps extends TimerDeps {
  writeStdout: (s: string) => void;
  /** `--filter` predicate: a delta type not wanted is dropped. `baseline` is
   *  emitted unconditionally (a consumer needs the ground state). */
  wants: (type: string) => boolean;
  /** Window overrides (tests pass small values alongside a fake clock). */
  coalesceMs?: number;
  settleMs?: number;
  keepaliveMs?: number;
}

export interface DeltaEmitter {
  /** Feed one readiness snapshot (production: from `subscribeReadiness`). */
  onSnapshot(snap: ReadinessClientSnapshot): void;
  dispose(): void;
}

/**
 * The stateful NDJSON emit pipeline, factored out of {@link runWatch} so it is
 * testable with a fake clock and hand-fed snapshots (no socket). Three stages:
 *   1. Coalesce a fold burst into one board (last-wins over `coalesceMs`).
 *   2. Trailing flap-settle: hold the change for `settleMs`, emitting only the
 *      NET diff vs. the last-EMITTED board — an `A→B→A` completion-window
 *      round-trip nets to nothing, a settled change / genuine rescind emits (see
 *      {@link FLAP_SETTLE_MS}).
 *   3. Idle keepalive when no line landed in the window.
 * The baseline first paint bypasses the settle (emitted at once).
 */
export function createDeltaEmitter(deps: DeltaEmitterDeps): DeltaEmitter {
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS;
  const settleMs = deps.settleMs ?? FLAP_SETTLE_MS;
  const keepaliveMs = deps.keepaliveMs ?? KEEPALIVE_MS;

  let sequence = 0;
  // The board as last reflected in EMITTED output — the diff baseline. Advances
  // only when the settle fires, so a transient that reverts to it nets to zero.
  let lastEmittedBoard: CoarseBoard | null = null;
  // The most recent coalesced board awaiting the settle window.
  let latestBoard: CoarseBoard | null = null;
  let pendingSnap: ReadinessClientSnapshot | null = null;
  let coalesceHandle: unknown = null;
  let settleHandle: unknown = null;
  let emittedSinceKeepalive = false;

  const emit = (type: string, data: unknown): void => {
    deps.writeStdout(
      `${JSON.stringify({
        schema_version: WATCH_SCHEMA_VERSION,
        sequence: sequence++,
        type,
        data,
      })}\n`,
    );
    emittedSinceKeepalive = true;
  };

  // Trailing flap-settle: emit the NET change since the last emission, then
  // advance the baseline. A key that round-tripped A→B→A within the window nets
  // to no change and is dropped; a settled change / genuine rescind emits.
  const settle = (): void => {
    settleHandle = null;
    if (lastEmittedBoard === null || latestBoard === null) {
      return;
    }
    const deltas = diffCoarseBoard(lastEmittedBoard, latestBoard);
    lastEmittedBoard = latestBoard;
    latestBoard = null;
    for (const d of deltas) {
      if (deps.wants(d.type)) {
        emit(d.type, d.data);
      }
    }
  };

  const flush = (): void => {
    coalesceHandle = null;
    const snap = pendingSnap;
    pendingSnap = null;
    if (snap === null) {
      return;
    }
    const board = projectCoarseBoard(snap);
    if (lastEmittedBoard === null) {
      // First paint → the baseline full-snapshot line, emitted immediately (a
      // consumer needs ground state at once, not after a settle delay).
      lastEmittedBoard = board;
      emit("baseline", board);
      return;
    }
    // Hold the change for the trailing flap-settle window; the newest board wins
    // if more arrive before it fires. Arm once per settle cycle (trailing from
    // the first change), so a whole A→B→A burst lands in one window.
    latestBoard = board;
    if (settleHandle === null) {
      settleHandle = deps.setTimeout(settle, settleMs);
    }
  };

  const onSnapshot = (snap: ReadinessClientSnapshot): void => {
    pendingSnap = snap;
    if (coalesceHandle === null) {
      coalesceHandle = deps.setTimeout(flush, coalesceMs);
    }
  };

  // Idle keepalive: a liveness line only when no other line landed in the
  // window. Suppressed by `--filter` not naming it.
  const keepaliveTimer = deps.setInterval(() => {
    if (!emittedSinceKeepalive && deps.wants("keepalive")) {
      emit("keepalive", { sequence });
    }
    emittedSinceKeepalive = false;
  }, keepaliveMs);

  return {
    onSnapshot,
    dispose(): void {
      deps.clearInterval(keepaliveTimer);
      if (coalesceHandle !== null) {
        deps.clearTimeout(coalesceHandle);
        coalesceHandle = null;
      }
      if (settleHandle !== null) {
        deps.clearTimeout(settleHandle);
        settleHandle = null;
      }
    },
  };
}

export interface RunWatchDeps {
  writeStdout: (s: string) => void;
  /** Test-injection connect factory forwarded to `subscribeReadiness`. */
  connect?: ConnectFactory;
  /** Timer shims (default real `setInterval`/`setTimeout`). */
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (h: unknown) => void;
}

/**
 * Drive the NDJSON tail. Never resolves in production (the subscribe handle
 * reconnects forever); tests dispose via the returned handle. Returns the
 * `ReadinessClientHandle` so a caller (test) can tear down.
 */
export function runWatch(
  args: ParsedWatchArgs,
  deps: RunWatchDeps,
): ReadinessClientHandle {
  const setIntervalFn = deps.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIntervalFn =
    deps.clearInterval ??
    ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const setTimeoutFn = deps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn =
    deps.clearTimeout ??
    ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const wants = (type: string): boolean =>
    args.filter.size === 0 || args.filter.has(type);

  const emitter = createDeltaEmitter({
    writeStdout: deps.writeStdout,
    wants,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
  });

  const handle = subscribeReadiness({
    sockPath: args.sock,
    idPrefix: `watch-${process.pid}`,
    onSnapshot: emitter.onSnapshot,
    // Reconnect-forever: NO give-up policy. A daemon bounce must not end the
    // tail, so we never pass `giveUpPolicy` — the default subscribe behavior.
    ...(deps.connect === undefined ? {} : { connect: deps.connect }),
  });

  // Wrap dispose to also clear the emitter's own timers.
  return {
    dispose(): void {
      emitter.dispose();
      handle.dispose();
    },
  };
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseWatchArgs(argv);
  if (!parsed.ok) {
    if (parsed.message === "__help__") {
      process.stdout.write(HELP);
      process.exit(0);
    }
    process.stderr.write(`keeper watch: ${parsed.message}\n\n`);
    process.stderr.write(HELP);
    process.exit(1);
  }

  runWatch(parsed.args, {
    writeStdout: (s) => process.stdout.write(s),
  });

  // Never resolve: the tail reconnects forever. Park on a promise that only
  // settles via SIGINT/SIGTERM (the default process behavior tears it down).
  await new Promise<void>(() => {});
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical entry.
