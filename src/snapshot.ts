/**
 * `src/snapshot.ts` — shared snapshot-mode core for keeper's six TUI viewers:
 * five daemon streams (`board`, `jobs`, `git`, `autopilot`, `builds`) plus the
 * sidecar-backed `usage` view.
 *
 * When `keeper <view>` runs with a non-TTY stdout (piped into an agent's
 * tool call), the live OpenTUI stream is the wrong shape: every `pushFrame`
 * AND the 125ms connecting-spinner get written, and the process blocks on
 * the UDS subscription forever. Snapshot mode replaces that path — it waits
 * deterministically for the current data frame, prints it as plain text
 * followed by a dual-audience metadata block (human-readable labeled paths
 * + a final machine-parseable `keeper-meta:` JSON line), then exits.
 *
 * This module owns the PURE-ish pieces so the contract cannot drift between
 * viewers using the shared `createViewShell` harness:
 *
 *   - `resolveSnapshotMode(...)` — the trigger precedence
 *     (flag > `CI`/`TERM=dumb` > `stdout.isTTY !== true`), tri-state safe,
 *     throwing a typed {@link SnapshotCliMisuseError} when both
 *     `--snapshot` and `--watch` are passed.
 *   - {@link SnapshotLatch} — the stream-readiness latch. A multi-stream
 *     view (board=2, autopilot=4) must not snapshot a partial composite
 *     from fold-ordering luck; the latch holds the snapshot until EVERY
 *     subscribed stream has delivered its first frame, then resolves
 *     `ready` (truncated:false). A timeout is the only non-deterministic
 *     escape — it resolves `timeout` (≥1 stream reported → partial
 *     composite with truncated:true, exit 0; 0 reported → frame:null,
 *     exit 1).
 *   - `formatSnapshotOutput(...)` / `formatNoFrameOutput(...)` — the stdout
 *     block + the stderr diagnostic. The `keeper-meta:` JSON line is ALWAYS
 *     the last line of stdout, single-line (never pretty-printed),
 *     newline-terminated, in every mode.
 *
 * Stream routing: success → frame + metadata block both on stdout.
 * No-frame → human diagnostic on stderr, the `keeper-meta:` line still on
 * stdout (so an agent can always parse the last stdout line regardless of
 * exit code). Never embed prose in JSON fields.
 */

/** Current `keeper-meta:` schema version. Bump on any field shape change. */
export const SNAPSHOT_SCHEMA_VERSION = 2;

/** Prefix on the single-line machine-parseable trailer record. */
export const KEEPER_META_PREFIX = "keeper-meta: ";

/** Default snapshot wait before the timeout escape fires (~2s). */
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 2_000;

/** Resolved run mode. */
export type SnapshotMode = "snapshot" | "watch";

/** Snapshot terminal status surfaced in the trailer + exit-code mapping. */
export type SnapshotStatus = "ok" | "timeout" | "daemon-unreachable";

/**
 * Thrown by {@link resolveSnapshotMode} on CLI misuse (both `--snapshot`
 * and `--watch` passed). A bad `--timeout` is validated by the caller (it
 * owns the raw string), but the conflicting-flags case is centralized here
 * so every view rejects it identically. Callers map this to exit 2.
 */
export class SnapshotCliMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCliMisuseError";
  }
}

/** The `keeper-meta:` JSON record — single source of truth for the trailer. */
export interface SnapshotMeta {
  /** Schema version (starts at 1). */
  schema_version: number;
  /** Subcommand identity. */
  script: string;
  /** Emitting process pid. */
  pid: number;
  /** Terminal status. */
  status: SnapshotStatus;
  /** Frame number (1-based), or `null` on no-frame. */
  frame: number | null;
  /** Frames emitted this run (0 or 1 in snapshot mode). */
  frame_count: number;
  /** `true` when the timeout fired before all streams reported. */
  truncated: boolean;
  /** Path to the per-frame state JSON sidecar, or `null` on no-frame. */
  state: string | null;
  /** Path to the per-frame frame-text sidecar, or `null` on no-frame. */
  frame_txt: string | null;
  /** Path to the lifecycle sidecar. */
  lifecycle: string;
  /** Path to the meta index sidecar. */
  meta: string;
  /** ISO timestamp of emission. */
  ts: string;
  /**
   * Tri-state catch-up status observed this run: `null` means no boot
   * header was observed, `false` means the freshest header reported steady
   * state, `true` means the freshest header reported catch-up. Optional on
   * the caller's construction so an existing builder that has not yet
   * threaded a live value keeps compiling; {@link formatMetaLine} normalizes
   * a missing value to `null` on the wire so the field is always present.
   */
  catching_up?: boolean | null;
}

/**
 * Inputs to the trigger-precedence resolver. `stdoutIsTTY` is the RAW
 * `process.stdout.isTTY` tri-state (`true` | `false` | `undefined`) — the
 * caller MUST NOT coerce it before handing it over (a piped stdout reports
 * `undefined`, which counts as non-TTY).
 */
export interface ResolveSnapshotModeInput {
  /** `--snapshot` flag (forces snapshot even on a TTY). */
  snapshotFlag: boolean;
  /** `--watch` flag (forces the live stream even when piped). */
  watchFlag: boolean;
  /** Raw `process.stdout.isTTY` (tri-state — never pre-coerce). */
  stdoutIsTTY: boolean | undefined;
  /** Env slice — only `CI` / `TERM` are consulted. */
  env: Record<string, string | undefined>;
}

/**
 * Resolve the run mode from flags > env > isTTY.
 *
 * Precedence (highest first):
 *   1. Explicit flags. `--snapshot` → snapshot, `--watch` → watch. Both set
 *      → {@link SnapshotCliMisuseError}.
 *   2. Env. `CI` truthy OR `TERM === "dumb"` → snapshot (a pty under CI
 *      reports `isTTY===true` though no human watches — the single most
 *      common auto-detect false-positive).
 *   3. `stdout.isTTY !== true` → snapshot. Tri-state safe: `undefined`
 *      (piped) counts as non-TTY; we never coerce before the `!== true`
 *      check. stdin's TTY-ness is irrelevant (stdout-only).
 */
export function resolveSnapshotMode(
  input: ResolveSnapshotModeInput,
): SnapshotMode {
  const { snapshotFlag, watchFlag, stdoutIsTTY, env } = input;
  if (snapshotFlag && watchFlag) {
    throw new SnapshotCliMisuseError(
      "--snapshot and --watch are mutually exclusive",
    );
  }
  // 1. Explicit flags win outright.
  if (snapshotFlag) {
    return "snapshot";
  }
  if (watchFlag) {
    return "watch";
  }
  // 2. CI / TERM=dumb force snapshot even under a pty.
  if (isCiEnv(env) || env.TERM === "dumb") {
    return "snapshot";
  }
  // 3. Tri-state isTTY. `undefined` (piped) is non-TTY — never coerce
  //    before the strict `!== true` check.
  return stdoutIsTTY !== true ? "snapshot" : "watch";
}

/**
 * `CI` truthy per the de-facto convention: present and not one of the
 * explicit falsy strings. Most CI providers set `CI=true`; some set
 * `CI=1`; bare presence is the safe trigger, but `CI=false` / `CI=0` /
 * `CI=` must NOT trip it (a human exporting `CI=false` to silence a tool).
 */
function isCiEnv(env: Record<string, string | undefined>): boolean {
  const v = env.CI;
  if (v === undefined) {
    return false;
  }
  const norm = v.trim().toLowerCase();
  return norm !== "" && norm !== "false" && norm !== "0";
}

/** How a {@link SnapshotLatch} resolved. */
export type SnapshotLatchOutcome =
  | { kind: "ready" }
  | { kind: "timeout"; reported: number };

/**
 * Stream-readiness latch. The caller declares `streamCount` (1 for a
 * single-stream view, 2 for board, 4 for autopilot). Each stream's FIRST
 * data callback calls {@link reportStream} — LATCH ON DATA, not the
 * `connected` lifecycle, which fires before the first `result` frame
 * (`readiness-client.ts:800`). When every stream has reported → resolve
 * `ready` (truncated:false). A `~2s` (override) timer resolves `timeout`:
 * the resolution carries `reported` so the caller can distinguish the
 * partial-composite degrade (≥1 reported → emit truncated:true, exit 0)
 * from the no-frame case (0 reported → frame:null, exit 1).
 *
 * A single `settled` flag guards the frame-vs-timeout race so the outcome
 * resolves AT MOST ONCE — a frame racing the timer can't double-emit, and
 * a late stream report after timeout is a safe no-op.
 *
 * Pure of process/IO: the timer + clock are injected (`setTimeoutFn` /
 * `clearTimeoutFn`), defaulting to the globals. Tests drive the latch
 * synchronously by capturing the scheduled callback.
 */
export interface SnapshotLatchDeps {
  /** Number of subscribed streams that must each report once. */
  streamCount: number;
  /** Timeout before the non-deterministic escape (ms). */
  timeoutMs: number;
  /** Called exactly once when the latch resolves (ready or timeout). */
  onResolve: (outcome: SnapshotLatchOutcome) => void;
  /**
   * Injectable timer set (defaults to global `setTimeout`). The handle is
   * opaque ({@link SnapshotTimerHandle}) so the global Bun `Timer` and a
   * fake test handle are both assignable; only the matching `clearTimeoutFn`
   * ever consumes it.
   */
  setTimeoutFn?: (cb: () => void, ms: number) => SnapshotTimerHandle;
  /** Injectable timer clear (defaults to global `clearTimeout`). */
  clearTimeoutFn?: (handle: SnapshotTimerHandle) => void;
}

/** Opaque timer handle — set by `setTimeoutFn`, consumed by `clearTimeoutFn`. */
export type SnapshotTimerHandle = unknown;

export interface SnapshotLatch {
  /**
   * Report that a stream delivered its first data frame. Decrements the
   * pending count; when it reaches 0 the latch resolves `ready`. A report
   * after the latch settled is a safe no-op. Re-reporting the SAME stream
   * is the caller's concern — the latch counts raw reports, so a caller
   * that may fire a stream's data callback more than once before all
   * streams report must gate per-stream itself.
   */
  reportStream: () => void;
  /** Number of distinct stream reports still outstanding. */
  pending: () => number;
  /** Cancel the timer (called by the caller after resolution / on dispose). */
  cancel: () => void;
}

export function createSnapshotLatch(deps: SnapshotLatchDeps): SnapshotLatch {
  const setTimeoutFn: (cb: () => void, ms: number) => SnapshotTimerHandle =
    deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn: (handle: SnapshotTimerHandle) => void =
    deps.clearTimeoutFn ??
    ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  let reported = 0;
  let settled = false;
  // A `streamCount <= 0` latch is degenerate — resolve `ready` immediately
  // on the next macrotask is wrong (the caller has no frame). Treat it as
  // "already satisfied": a 0-stream view should never construct a latch,
  // but if it does, the timeout still bounds it.
  const target = Math.max(0, deps.streamCount);

  const timer = setTimeoutFn(() => {
    if (settled) {
      return;
    }
    settled = true;
    deps.onResolve({ kind: "timeout", reported });
  }, deps.timeoutMs);

  function resolveReadyIfDone(): void {
    if (settled || reported < target) {
      return;
    }
    settled = true;
    clearTimeoutFn(timer);
    deps.onResolve({ kind: "ready" });
  }

  return {
    reportStream(): void {
      if (settled) {
        return;
      }
      reported += 1;
      resolveReadyIfDone();
    },
    pending(): number {
      return Math.max(0, target - reported);
    },
    cancel(): void {
      clearTimeoutFn(timer);
    },
  };
}

/** Serialize the trailer record as the single-line `keeper-meta:` string. */
export function formatMetaLine(meta: SnapshotMeta): string {
  // Normalize the optional `catching_up` to an explicit `null` so every
  // wire record carries the field, even from a caller that has not yet
  // threaded a live value through its own construction site.
  const wire: SnapshotMeta = {
    ...meta,
    catching_up: meta.catching_up ?? null,
  };
  // `JSON.stringify` with no spacer is single-line by construction. The
  // caller appends the newline (the formatters below own line assembly).
  return `${KEEPER_META_PREFIX}${JSON.stringify(wire)}`;
}

/** The human-readable labeled-path lines that precede the JSON trailer. */
function metaLabelLines(meta: SnapshotMeta): string[] {
  const lines: string[] = [];
  if (meta.state !== null) {
    lines.push(`state: ${meta.state}`);
  }
  if (meta.frame_txt !== null) {
    lines.push(`frame_txt: ${meta.frame_txt}`);
  }
  lines.push(`lifecycle: ${meta.lifecycle}`);
  lines.push(`meta: ${meta.meta}`);
  return lines;
}

/**
 * Build the stdout block for a successful snapshot: the frame text, a blank
 * separator, the labeled metadata lines, then the single-line `keeper-meta:`
 * JSON record LAST. Returns the full block with a trailing newline so the
 * caller writes it verbatim to stdout.
 */
export function formatSnapshotOutput(input: {
  frameText: string;
  meta: SnapshotMeta;
}): string {
  const { frameText, meta } = input;
  const lines: string[] = [];
  if (frameText.length > 0) {
    lines.push(frameText);
  }
  lines.push("");
  lines.push(...metaLabelLines(meta));
  lines.push(formatMetaLine(meta));
  return `${lines.join("\n")}\n`;
}

/**
 * Build the no-frame output. The human diagnostic goes to STDERR; the
 * `keeper-meta:` line (frame:null) still goes to STDOUT so an agent can
 * always parse the last stdout line regardless of exit code. Returns both
 * channels' text (each newline-terminated, or empty); the caller routes
 * `stderr` → stderr and `stdout` → stdout.
 */
export function formatNoFrameOutput(input: {
  meta: SnapshotMeta;
  /** Human diagnostic sentence for stderr (no prose ever in the JSON). */
  diagnostic: string;
}): { stdout: string; stderr: string } {
  const { meta, diagnostic } = input;
  const stderrLines = [diagnostic, ...metaLabelLines(meta)];
  return {
    stderr: `${stderrLines.join("\n")}\n`,
    stdout: `${formatMetaLine(meta)}\n`,
  };
}

/**
 * Map a terminal {@link SnapshotStatus} + whether a frame was captured to
 * the process exit code per the epic contract:
 *   - `0` — a frame was emitted (including a valid empty-projection frame).
 *   - `1` — no frame before timeout (`timeout` / `daemon-unreachable`).
 *   - CLI misuse (exit 2) is handled at the flag layer, not here.
 */
export function snapshotExitCode(input: {
  status: SnapshotStatus;
  haveFrame: boolean;
}): 0 | 1 {
  return input.haveFrame ? 0 : 1;
}
