/**
 * Codex live-state producer (fn-1103) — the pure, filesystem-only core of the
 * daemon-side sweep that surfaces a tracked codex session's live stop-churn.
 *
 * MECHANISM: forward-tail the attributed rollout JSONL. codex exposes no
 * launcher-env-inheriting per-turn notify hook keyed on the keeper job id, so the
 * primary mechanism is the daemon-side rollout tailer: once the resume back-fill
 * has attributed a job's rollout (its `resume_target` uuid), this tails that file
 * and emits a stop signal per turn-completion marker. codex's rollout carries no
 * turn-START marker (only the stop markers {@link CODEX_STOP_MARKERS}), so codex
 * churn is STOP-ONLY — recorded in the harness descriptor's `hookMechanism`.
 *
 * REPLAY SAFETY: the caller mints each signal as a synthetic `Stop`, whose fold
 * arm is terminal-guarded, and stamps it with the ROLLOUT LINE's own timestamp
 * (never wall-clock). So a boot-scan or tail-catch-up replay of a dead session's
 * rollout folds as a no-op and can never flicker a killed/ended row back to life.
 * To keep a daemon restart O(1) per job (never re-minting a long rollout's whole
 * stop history), a job's cursor EOF-anchors on first sight and mints nothing.
 *
 * SENSITIVITY: reads only the rollout's structural event markers and per-line
 * timestamps — never message content (codex rollouts can carry secrets).
 *
 * DEP-LIGHT ISLAND: imports only `node:*` and the shared codex stop-marker set,
 * so it never drags a heavy dependency onto the daemon's sweep path and holds no
 * db handle — the caller owns the `jobs` query and the synthetic-event mint.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

const CODEX_STOP_MARKERS: ReadonlySet<string> = new Set([
  "task_complete",
  "turn_aborted",
  "error",
]);

/**
 * A tracked, attributed codex job the producer tails — the caller queries these
 * off the `jobs` projection (harness codex, resolved resume_target, non-terminal).
 */
export interface LiveCodexJob {
  /** The keeper job id (the synthetic Stop's session id). */
  jobId: string;
  /** The resolved native rollout uuid — the exact file the producer tails. */
  resumeTarget: string;
  /** Job launch instant (ms), the rollout day-dir anchor. */
  createdAtMs: number;
}

/**
 * One codex turn-completion parsed from the rollout tail. `tsSec` is the ROLLOUT
 * LINE's own timestamp (epoch seconds), never wall-clock, so a replay folds
 * deterministically. Carries NO message text — markers only.
 */
export interface CodexStopSignal {
  jobId: string;
  /** The stop marker (`task_complete` | `turn_aborted` | `error`). */
  reason: string;
  tsSec: number;
}

/** Per-rollout forward-tail cursor: the byte offset consumed so far. */
export interface RolloutCursor {
  offset: number;
}

/**
 * Locate the rollout file for a resolved uuid, scanning only the job's creation
 * day dir (plus today, for a session that spans midnight). codex names each
 * rollout `rollout-<ts>-<uuid>.jsonl`, so a suffix match on the uuid is an exact,
 * guess-free lookup. Null when the file is not present yet — the caller idles.
 */
export function locateCodexRolloutByUuid(
  codexHome: string,
  uuid: string,
  createdAtMs: number,
): string | null {
  const suffix = `-${uuid}.jsonl`;
  const root = join(codexHome, "sessions");
  for (const dir of rolloutDayDirs(root, createdAtMs)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // day dir absent — try the next candidate.
    }
    for (const name of names) {
      if (name.startsWith("rollout-") && name.endsWith(suffix)) {
        return join(dir, name);
      }
    }
  }
  return null;
}

/**
 * Forward-tail a rollout from `fromOffset`, returning the stop signals in the new
 * bytes and the advanced offset. Only complete (`\n`-terminated) lines are
 * consumed — a trailing partial line is left for the next tick, so a mid-write
 * read never mis-parses. A shrunk/absent file or read error yields no signals and
 * leaves the offset unchanged (the caller re-anchors on truncation). Reads ONLY
 * markers + per-line timestamps, never message content.
 */
export function tailCodexStopSignals(
  path: string,
  jobId: string,
  fromOffset: number,
): { signals: CodexStopSignal[]; nextOffset: number } {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size <= fromOffset) {
      return { signals: [], nextOffset: fromOffset };
    }
    fd = openSync(path, "r");
    const len = size - fromOffset;
    const buf = Buffer.alloc(len);
    const bytes = readSync(fd, buf, 0, len, fromOffset);
    const text = buf.subarray(0, bytes).toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) {
      return { signals: [], nextOffset: fromOffset }; // no complete line yet.
    }
    const complete = text.slice(0, lastNl);
    // Bytes consumed up to and including the final newline. Every advance lands on
    // a `\n` (a single-byte char boundary in utf8), so the next read never starts
    // mid-multibyte.
    const consumed = Buffer.byteLength(complete, "utf8") + 1;
    const signals: CodexStopSignal[] = [];
    for (const line of complete.split("\n")) {
      const signal = stopSignalFromLine(line, jobId);
      if (signal !== null) {
        signals.push(signal);
      }
    }
    return { signals, nextOffset: fromOffset + consumed };
  } catch {
    return { signals: [], nextOffset: fromOffset };
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Collect the stop signals to mint across every currently-attributed codex job,
 * advancing each job's forward-tail cursor in `cursors` (mutated in place). A job
 * seen for the first time EOF-anchors and mints nothing — a boot scan of a long
 * rollout must not re-mint its whole stop history. A truncated/rotated file
 * re-anchors at the new EOF. Cursors for jobs no longer in `jobs` (terminal /
 * gone) are GC'd so the map stays bounded by the live codex set, never history.
 * Returns [] with no filesystem read when `jobs` is empty (the idle path).
 */
export function collectCodexStopSignals(
  jobs: LiveCodexJob[],
  codexHome: string,
  cursors: Map<string, RolloutCursor>,
): CodexStopSignal[] {
  const live = new Set<string>();
  const out: CodexStopSignal[] = [];
  for (const job of jobs) {
    live.add(job.jobId);
    const path = locateCodexRolloutByUuid(
      codexHome,
      job.resumeTarget,
      job.createdAtMs,
    );
    if (path === null) {
      continue; // rollout not located yet — presence-only, retried next tick.
    }
    const cursor = cursors.get(job.jobId);
    if (cursor === undefined) {
      cursors.set(job.jobId, { offset: safeSize(path) }); // first sight: anchor.
      continue;
    }
    const size = safeSize(path);
    if (cursor.offset > size) {
      cursor.offset = size; // truncated/rotated — re-anchor, mint nothing.
      continue;
    }
    const { signals, nextOffset } = tailCodexStopSignals(
      path,
      job.jobId,
      cursor.offset,
    );
    cursor.offset = nextOffset;
    for (const signal of signals) {
      out.push(signal);
    }
  }
  for (const key of [...cursors.keys()]) {
    if (!live.has(key)) {
      cursors.delete(key);
    }
  }
  return out;
}

function stopSignalFromLine(
  line: string,
  jobId: string,
): CodexStopSignal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null; // partial/garbage line while codex writes — skip.
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== "event_msg") {
    return null;
  }
  const payload = obj.payload;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const marker = (payload as Record<string, unknown>).type;
  if (typeof marker !== "string" || !CODEX_STOP_MARKERS.has(marker)) {
    return null;
  }
  const tsSec = rolloutLineTsSec(obj.timestamp);
  if (tsSec === null) {
    // Never wall-clock: a marker with no readable line timestamp cannot be
    // stamped safely, so it is dropped rather than folded with an invented ts.
    return null;
  }
  return { jobId, reason: marker, tsSec };
}

function rolloutLineTsSec(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

function rolloutDayDirs(root: string, createdAtMs: number): string[] {
  const dirs = new Set<string>();
  for (const date of [new Date(createdAtMs), new Date()]) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    dirs.add(join(root, year, month, day));
  }
  return [...dirs];
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
