/**
 * `createViewShell` — shared TUI lifecycle harness for keeper's read-only
 * subscribe-driven views (`keeper board`, `keeper jobs`, `keeper git`).
 *
 * Lifts the ~200-line "shell harness" that used to be copy-pasted across
 * each `cli/<view>.ts` main:
 *   - Indexed `/tmp/keeper-<script>.<pid>.{state,frame,diff}.<n>` sidecar
 *     writes (state JSON + frame text + per-frame unified diff against
 *     the previous emit via `diff -u`).
 *   - The session-level `meta.txt` tab-separated index.
 *   - The session-level `lifecycle.txt` append sink (alt-screen owns
 *     stdout, so warn / lifecycle output goes here instead).
 *   - The standardized `emitLifecycle(event, detail)` shape.
 *   - The `colorEnabled` gate (TTY both sides + NO_COLOR unset).
 *   - The `c` (copy) key handler with a shared flash-restore timer that
 *     puts a persistent banner pill (when set) back in place.
 *   - The `liveShell.dispose()` → `onDispose()` → exit SIGINT teardown.
 *
 * Variation that stays on the caller:
 *   - The data subscription (`subscribeReadiness` / `subscribeCollection`
 *     / multi-stream blends) — the caller wires its own subscribe and
 *     calls `view.emit(snap)` on each tick.
 *   - The render function — pure `(snap: TSnap) => { bodyLines,
 *     stateJson }`. The shell takes the body lines, ships them to the
 *     live shell (with SGR colorization when enabled), and writes the
 *     state JSON to the per-frame sidecar.
 *   - Extra key handlers (`onKey: (key) => void`) — `c` is owned by the
 *     shell; everything else delegates to the caller. The caller drives
 *     `flashStatus(text)` for transient banner updates; the shared
 *     timer restores `persistentBannerPill()` (when provided) ~1.5s
 *     later.
 *
 * Why a factory (no top-level side effects). Mirrors `createLiveShell` —
 * the shell owns process-level state (SIGINT, alt-screen, sidecar fds)
 * and must NOT be constructed at module import time. `bun test --isolate`
 * imports `cli/<view>.ts` freely without spawning a shell.
 *
 * Sidecar contract is the SAME shape every existing view emits today,
 * preserved bit-for-bit so the sidecar/meta files (and any consumers
 * that grep them) keep working:
 *
 *   /tmp/keeper-<script>.<pid>.state.<n>.json     (state JSON)
 *   /tmp/keeper-<script>.<pid>.frame.<n>.txt      (rendered frame text)
 *   /tmp/keeper-<script>.<pid>.diff.<n>.txt       (unified diff vs prev)
 *   /tmp/keeper-<script>.<pid>.meta.txt           (tab-separated index)
 *   /tmp/keeper-<script>.<pid>.lifecycle.txt      (warn/lifecycle log)
 *   /tmp/keeper-<script>.<pid>.prev.frame.txt     (scratch — diff input)
 *
 * The frame text shipped to sidecars is the `"---" + bodyLines` form;
 * only `bodyLines` is shipped to the live shell (the `---` lead is a
 * sidecar/non-TTY artifact, not painted in the alt-screen).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { SELECTION_BG_SGR } from "./ansi-to-styled";
import { colorizePillsInLine } from "./board-render";
import { buildDebugSnapshot, copyToClipboard } from "./clipboard-debug";
import type { FramesEmitter, TrailerReason } from "./frames-emitter";
import { createLiveShell, type LiveShell } from "./live-shell";
import {
  createRefoldProgressPoller,
  type RefoldProgressPoller,
} from "./refold-progress";
import {
  createSnapshotLatch,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  formatNoFrameOutput,
  formatSnapshotOutput,
  SNAPSHOT_SCHEMA_VERSION,
  type SnapshotLatchOutcome,
  type SnapshotMeta,
  type SnapshotStatus,
  type SnapshotTimerHandle,
} from "./snapshot";

/**
 * Selection-highlight protocol. A `renderBody` may prefix exactly one of
 * its `bodyLines` with this non-printing Private-Use char to mark it as the
 * selected row. The view-shell strips the prefix before colorizing, then —
 * on a color-enabled TTY — prepends the selection-background SGR so the
 * paint layer renders that row as a full-width highlight (see
 * `src/ansi-to-styled.ts`). The prefix stays in the byte-compare body so a
 * selection move invalidates the frame cache and repaints; it is stripped
 * from the sidecar frame text so postmortem output stays clean. Non-TTY
 * output drops both the prefix and the highlight.
 */
export const SELECTED_LINE_PREFIX = "\u{E000}";

/**
 * Arm the full set of "my parent / TTY died → exit and close the socket"
 * triggers for a long-lived UDS subscriber (`keeper board|jobs|git|
 * autopilot|usage`). The load-bearing fix for the orphan-accumulation
 * class: an alive orphan can ONLY be reaped by itself — no server probe
 * can tell a quietly-watching live viewer from a ponging headless orphan
 * (fn-723).
 *
 * `exitCleanly` is the caller's teardown tail. It MUST be idempotent —
 * several of these triggers can fire (and overlap) for one dying viewer.
 * It does the dispose + log + `process.exit(0)`.
 *
 * Triggers armed (additive to the caller's own SIGINT handler):
 *   - `SIGHUP`: controlling process / session leader went away.
 *   - stdin `'end'` / `'error'`: the controlling pty closed (EOF). We
 *     `resume()` stdin so the `'end'` actually fires on pty teardown —
 *     a paused stdin never emits EOF. Skipped on a non-TTY / piped run
 *     (stdin there is a file/pipe whose natural EOF is NOT a death
 *     signal and would mis-fire an immediate exit).
 *   - a ~2s `process.ppid === 1` poll: the ONLY trigger that catches a
 *     detach-on-close multiplexer teardown, where the pane pty stays OPEN
 *     (no SIGHUP, no stdin EOF) but the viewer reparents to init. We
 *     capture the launch-time ppid and only treat `ppid === 1` as death
 *     if it WASN'T 1 at launch — a legitimately detached launch (e.g.
 *     started under a process that's already init-owned) must not
 *     self-exit on the first tick.
 *
 * Returns a `disarm()` that clears the poll interval + detaches the
 * stdin listeners — exposed so tests can tear the triggers down without
 * leaking a real 2s interval into the runner. Production callers never
 * disarm (the process is exiting).
 */
/** The slice of `process` {@link armViewerExitTriggers} touches. */
export type ViewerExitProc = Pick<NodeJS.Process, "on" | "ppid"> & {
  readonly stdin: Pick<
    NodeJS.ReadStream,
    "on" | "removeListener" | "resume" | "isTTY"
  >;
};

/** Test-injection knobs for {@link armViewerExitTriggers}. */
export interface ViewerExitTriggerDeps {
  /** Override for tests; defaults to the real `process`. */
  readonly proc?: ViewerExitProc;
  /** Override the poll cadence (ms) in tests. Default ~2000. */
  readonly ppidPollMs?: number;
  /** Override the captured launch ppid in tests. */
  readonly initialPpid?: number;
}

export function armViewerExitTriggers(
  exitCleanly: () => void,
  deps: ViewerExitTriggerDeps = {},
): { disarm: () => void } {
  const proc = deps.proc ?? process;
  const pollMs = deps.ppidPollMs ?? 2_000;
  // Capture the launch-time parent. If we were ALREADY init-owned at
  // launch, the ppid===1 poll can never distinguish "born detached"
  // from "reparented after death" — so we disable it (set the baseline
  // so the poll's guard never trips).
  const initialPpid = deps.initialPpid ?? proc.ppid;
  const ppidGuardArmed = initialPpid !== 1;

  proc.on("SIGHUP", () => {
    exitCleanly();
  });

  const stdin = proc.stdin;
  // Only arm stdin-EOF on a real controlling TTY. A piped/non-TTY stdin
  // hits natural EOF immediately, which is NOT a viewer-death signal.
  if (stdin.isTTY === true) {
    const onEnd = (): void => {
      exitCleanly();
    };
    const onError = (): void => {
      exitCleanly();
    };
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    // A paused stdin never emits `'end'` — `resume()` so the pty-close
    // EOF actually surfaces. (The live shell reads keys via its own
    // raw-mode handle; resuming here is additive and harmless.)
    stdin.resume();
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  if (ppidGuardArmed) {
    pollTimer = setInterval(() => {
      if (proc.ppid === 1) {
        exitCleanly();
      }
    }, pollMs);
    // Don't let the poll interval pin the event loop alive on its own.
    (pollTimer as { unref?: () => void }).unref?.();
  }

  return {
    disarm(): void {
      if (pollTimer != null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    },
  };
}

/** Default honest-empty body line for a snapshot whose render produced zero
 *  lines — a healthy but idle projection. A snapshot must never write bare
 *  separators (`---` alone / empty stdout frame); this stands in so the frame
 *  reads as a deliberate idle state. Overridable per view via
 *  `snapshotEmptyLine`. */
export const DEFAULT_SNAPSHOT_EMPTY_LINE = "(idle — nothing to display)";

/**
 * Normalize a render's body lines for a SNAPSHOT frame: a render that produced
 * zero lines becomes the honest-empty single line, so a healthy-but-idle daemon
 * yields a real one-line frame instead of bare separators. Live-mode painting
 * keeps today's empty-body behavior — this is snapshot-only. Pure — exported
 * for tests.
 */
export function snapshotBodyLines(
  bodyLines: string[],
  emptyLine: string,
): string[] {
  return bodyLines.length > 0 ? bodyLines : [emptyLine];
}

/** Output of one render pass — the body the view wants to emit. */
export interface ViewRender {
  /** Body lines, one per output row. In snapshot mode an empty array is
   * normalized to the honest-empty line (`snapshotBodyLines`), never a
   * `---`-only frame; live mode paints an empty body as-is. */
  bodyLines: string[];
  /** Arbitrary JSON-serializable state captured per frame in the sidecar. */
  stateJson: unknown;
}

export interface ViewShellOptions<TSnap> {
  /** Script identifier — feeds sidecar basenames (`keeper-<script>.*`). */
  script: string;
  /** Banner title for `createLiveShell` (alt-screen header). */
  title?: string;
  /** Pure-function render of one snapshot to body + state JSON. */
  renderBody: (snap: TSnap) => ViewRender;
  /**
   * Optional extra key handler. The shell owns `c` (copy) directly; any
   * other key is forwarded here. Return value is ignored.
   */
  onKey?: (key: string) => void;
  /**
   * Optional modal-capture predicate. When it returns `true`, the shell
   * forwards EVERY key to `onKey` — including the shell-owned `c` (copy)
   * and the core's frame-history keys — so a view can run a fully local
   * sub-mode (e.g. jobs' insert mode). Threaded into `createLiveShell`
   * (frame-nav bypass) AND consulted here (copy-key bypass) so capture
   * is honored at both layers. Absent/false → today's behavior.
   */
  captureKeys?: () => boolean;
  /**
   * Optional persistent banner pill. Called after a transient flash
   * expires (~1.5s) to restore the standing banner text. Default
   * restores to `""` (no banner).
   */
  persistentBannerPill?: () => string;
  /**
   * Optional poller surfacing the reducer's re-fold progress (fn-691).
   * Defaults to the real {@link createRefoldProgressPoller} bound to
   * `resolveDbPath()`. Tests inject a fake whose `poll()` returns
   * deterministic samples so the connecting-indicator's composition and
   * teardown can be asserted without touching SQLite. The poller is
   * lazily opened (first `poll()`) and closed by the shell on either
   * first-frame self-stop or SIGINT — see `emitLifecycle`'s spinner block
   * and `installSigintHandler`'s teardown.
   */
  refoldProgressPoller?: RefoldProgressPoller;
  /**
   * Run mode (fn-772). `"live"` (default) is today's subscribe-driven TUI
   * stream — no behavior delta. `"snapshot"` waits for the first ready
   * composite frame, prints it + a `keeper-meta:` trailer, and exits. The
   * caller computes this via `resolveSnapshotMode` (flag > env > isTTY) and
   * drives `runSnapshot` instead of `installSigintHandler`.
   *
   * `"frames"` is the agent-facing NDJSON stream: each accepted frame (after
   * the byte-compare gate) is emitted as one wire envelope through the injected
   * {@link FramesEmitterConfig.emitter} instead of painting, honoring the
   * emitter's max-frames / duration bounds with a guaranteed trailer flush on
   * every exit path (bound tripped OR SIGINT). Like snapshot it never paints a
   * live frame and never arms the connecting spinner. The caller drives
   * `runFrames` instead of `installSigintHandler`, hands the freshest boot
   * `rev` in via `noteCursor`, and provides the pre-built emitter in
   * {@link ViewShellOptions.frames}.
   */
  mode?: "live" | "snapshot" | "frames";
  /**
   * Frames-mode wiring (required when `mode === "frames"`, ignored otherwise).
   * The emitter is pre-built by the caller (it owns the view identity, diff
   * seam, sidecar IO, and the max-frames / duration bounds); the shell only
   * drives it. `durationMs` is the SAME bound the emitter was built with — the
   * shell re-uses it to arm a single teardown timer so a run with no further
   * frames still terminates and flushes its trailer. `io` injects the exit +
   * timer + process seams for tests (prod omits it).
   */
  frames?: FramesEmitterConfig;
  /**
   * Snapshot mode only: how many subscribed streams must each deliver a
   * first frame before the composite is trustworthy (1 for a single-stream
   * view, 2 for board, 4 for autopilot). The readiness client's own
   * first-paint gate already withholds the first `emit` until every stream
   * has produced a `result`, so each `view.emit` reports once; the latch
   * holds the snapshot until `streamCount` reports land or the timeout
   * fires. Defaults to 1.
   */
  streamCount?: number;
  /**
   * Snapshot mode only: the wait before the non-deterministic timeout
   * escape fires (ms). Defaults to {@link DEFAULT_SNAPSHOT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /**
   * Snapshot mode only: injectable IO + clock for tests. Production omits
   * it (the real `process` stdout/stderr/exit + global timers). Tests pass
   * a fake `exit` (a thrower, like `test/keeper-cli.test.ts`) and capture
   * sinks so `process.exit` doesn't actually fire under `bun:test`, and a
   * captured `setTimeoutFn` so the timeout escape can be driven
   * synchronously.
   */
  snapshotIo?: SnapshotIo;
  /**
   * Snapshot mode only: the single body line substituted when a render produces
   * ZERO body lines, so a healthy-but-idle daemon yields an honest one-line
   * frame instead of bare separators. Defaults to
   * {@link DEFAULT_SNAPSHOT_EMPTY_LINE}.
   */
  snapshotEmptyLine?: string;
}

/** Injectable IO + clock for the snapshot path (tests only; prod omits). */
export interface SnapshotIo {
  /** stdout sink (default `process.stdout.write`). */
  stdoutWrite?: (s: string) => void;
  /** stderr sink (default `process.stderr.write`). */
  stderrWrite?: (s: string) => void;
  /** Process exit (default `process.exit`; tests inject a thrower). */
  exit?: (code: number) => never;
  /** Clock for the trailer `ts` (default `() => new Date().toISOString()`). */
  nowIso?: () => string;
  /** Timer set for the latch (default global `setTimeout`). */
  setTimeoutFn?: (cb: () => void, ms: number) => SnapshotTimerHandle;
  /** Timer clear for the latch (default global `clearTimeout`). */
  clearTimeoutFn?: (handle: SnapshotTimerHandle) => void;
}

/** Frames-mode wiring (see {@link ViewShellOptions.frames}). */
export interface FramesEmitterConfig {
  /** Pre-built emitter the shell drives (owns view id, diff, sidecar IO, bounds). */
  emitter: FramesEmitter;
  /**
   * The emitter's duration bound (ms), re-supplied so the shell can arm a
   * single teardown timer that flushes a `duration` trailer when no further
   * frame arrives. `null`/omitted ⇒ no timer (unbounded by time; ends on
   * max-frames or SIGINT). MUST match the value the emitter was built with.
   */
  durationMs?: number | null;
  /** Injectable exit + timer + process seams for tests; prod omits. */
  io?: FramesRunIo;
}

/** Injectable exit + timer + process seams for the frames run (tests only). */
export interface FramesRunIo {
  /** Process exit (default `process.exit`; tests inject a thrower). */
  exit?: (code: number) => never;
  /** Timer set for the duration teardown (default global `setTimeout`). */
  setTimeoutFn?: (cb: () => void, ms: number) => SnapshotTimerHandle;
  /** Timer clear for the duration teardown (default global `clearTimeout`). */
  clearTimeoutFn?: (handle: SnapshotTimerHandle) => void;
  /**
   * Process seam for the SIGINT + parent-death exit triggers (default the real
   * `process`). Tests inject a fake so no real process-level handler is
   * registered.
   */
  proc?: ViewerExitProc;
}

export interface ViewShell<TSnap> {
  /** Underlying live shell — exposed for callers that need `setStatus`. */
  readonly liveShell: LiveShell;
  /** Append a warn / observational line to the lifecycle sidecar. */
  noteLine: (s: string) => void;
  /**
   * Emit one frame. Renders, byte-compares the body against the prior
   * emit, and on change: increments frameCount, ships the body to the
   * live shell, writes the three per-frame sidecars + the meta index.
   * Returns `true` when a frame was emitted, `false` when suppressed
   * by the byte-stability gate.
   */
  emit: (snap: TSnap) => boolean;
  /**
   * Repaint the live view from `snap` WITHOUT minting a history frame.
   * Renders + byte-compares exactly like `emit`, but on change ships the
   * body via `liveShell.refreshLive` (a live overlay that does not grow the
   * frame-history ring) and skips the per-frame sidecar triple + frameCount
   * bump. Updates the same `lastBody` gate `emit` reads, so a subsequent
   * `emit` with identical content suppresses (the overlay content becomes
   * the new baseline). Use for ephemeral, key-driven UI state (e.g. jobs'
   * insert-mode selection / expand) that should repaint in place rather
   * than record a data frame. Returns `true` when it repainted.
   */
  repaintLocal: (snap: TSnap) => boolean;
  /**
   * Append a standardized lifecycle event to the lifecycle sidecar
   * (`...`, `event: <event>`, key/value detail lines, `...`). Also
   * clears the internal `lastBody` gate on `event === "disconnected"`
   * so the next post-reconnect snapshot always paints.
   */
  emitLifecycle: (event: string, detail?: Record<string, unknown>) => void;
  /**
   * Stamp a transient banner text via `liveShell.setStatus`. After
   * ~1.5s the shared flash timer restores the persistent pill (or `""`
   * when no persistent pill provider was supplied). Multiple transient
   * flashes share one timer — last-flash-wins.
   */
  flashStatus: (text: string) => void;
  /** Sidecar paths — surfaced so callers can log them on SIGINT. */
  readonly metaSidecar: string;
  readonly lifecycleSidecar: string;
  /**
   * `true` when SGR colorization should be applied to lines passed to
   * the live shell. Identical gate every sibling computed inline.
   */
  readonly colorEnabled: boolean;
  /**
   * Install the standard SIGINT handler: dispose the live shell, run
   * the caller's `onDispose` (for subscription teardown), log the
   * sidecar paths, exit 0. Idempotent — safe to call once.
   */
  installSigintHandler: (onDispose: () => void) => void;
  /**
   * Snapshot-mode driver (fn-772) — the snapshot analog of
   * `installSigintHandler`. The caller wires its subscription(s) (whose
   * `onRows`/`onSnapshot` call `view.emit`), then calls this with the
   * subscription teardown. It arms the stream-readiness latch:
   *
   *   - The first ready composite (latch satisfied) → write sidecars once,
   *     print the frame + `keeper-meta:` block to stdout, dispose the
   *     handle(s), exit 0.
   *   - Timeout with ≥1 stream reported → emit the partial composite with
   *     `truncated:true`, exit 0.
   *   - Timeout with 0 streams reported → no-frame: diagnostic on stderr,
   *     `keeper-meta:` (frame:null) on stdout, exit 1.
   *
   * Only meaningful when `mode === "snapshot"`. A single `settled` flag
   * guards the frame-vs-timeout race so the snapshot resolves once.
   */
  runSnapshot: (onDispose: () => void) => void;
  /**
   * Frames-mode driver — the frames analog of `installSigintHandler` /
   * `runSnapshot`. The caller wires its subscription(s) (whose data callbacks
   * call `view.emit`), then calls this with the subscription teardown. It arms
   * the SIGINT + parent-death triggers and (when a `durationMs` bound is set)
   * one teardown timer, each routing to a single idempotent trailer-flush:
   * emit the terminal trailer, dispose, run `onDispose`, exit 0. A bound
   * tripped mid-`emit` (max-frames / duration-with-frames) flushes through the
   * same path. Only meaningful when `mode === "frames"`.
   */
  runFrames: (onDispose: () => void) => void;
  /**
   * Frames-mode resume-cursor seam. The caller hands the shell the freshest
   * daemon fold cursor per tick (board threads `String(BootStatus.rev)` from
   * its `onBootStatus`), and the shell stamps it on every subsequent envelope's
   * `cursor` and the trailer's `resume_cursor`. `null` until the first boot
   * header lands. Inert outside frames mode (stored but never read).
   */
  noteCursor: (cursor: string | null) => void;
  /**
   * Multi-stream snapshot readiness report (fn-772). `view.emit` auto-reports
   * the FIRST stream to the latch (covers single-stream views like git/jobs
   * with zero extra wiring). A multi-stream view (board=2, autopilot=4)
   * subscribes ADDITIONAL streams whose first data callback must each report
   * once so the latch holds the snapshot until the WHOLE composite is folded
   * — not just the readiness stream. The caller wires this into each
   * secondary stream's first `onRows`/`onSnapshot` (one report per secondary
   * stream: `streamCount - 1` reports total, since `emit` covers the first).
   *
   * Per-stream once-ness is the caller's concern (mirrors the latch's
   * `reportStream` contract): a secondary stream that fires its data callback
   * repeatedly before the latch settles must gate itself so it reports exactly
   * once. A report after the latch settled is a safe no-op. Inert in live
   * mode (no latch armed) — safe to call unconditionally from the shared
   * subscription wiring.
   */
  reportSnapshotStream: () => void;
  /** Last frame text emitted (lead + body), for `handleCopyKey` callers. */
  getLastFrameText: () => string | null;
  /** Current frame index (1-based; 0 before the first emit). */
  getFrameCount: () => number;
}

export function createViewShell<TSnap>(
  opts: ViewShellOptions<TSnap>,
): ViewShell<TSnap> {
  const { script, renderBody, persistentBannerPill } = opts;
  const title = opts.title ?? script;
  const mode = opts.mode ?? "live";
  const isSnapshot = mode === "snapshot";
  const isFrames = mode === "frames";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const snapshotEmptyLine =
    opts.snapshotEmptyLine ?? DEFAULT_SNAPSHOT_EMPTY_LINE;

  // Sidecar paths — keyed on `<script>.<pid>` exactly as the pre-factory
  // siblings emitted. Bit-for-bit shape preservation: any consumer that
  // grepped `/tmp/keeper-<script>.<pid>.*` keeps working.
  const pid = process.pid;
  const prevFrameTmp = `/tmp/keeper-${script}.${pid}.prev.frame.txt`;
  const metaSidecar = `/tmp/keeper-${script}.${pid}.meta.txt`;
  const lifecycleSidecar = `/tmp/keeper-${script}.${pid}.lifecycle.txt`;

  const noteLine = (s: string): void => {
    try {
      appendFileSync(lifecycleSidecar, `${s}\n`);
    } catch {
      // best-effort — the sidecar is observational
    }
  };

  // Forward-reference slot for the caller's onKey. Wired before
  // createLiveShell so `onUnhandledKey` can call into it.
  const callerOnKey = opts.onKey;

  // Color is for human eyes on a TTY. Pipes / redirects / NO_COLOR stay
  // plain so consumers (grep, diff, `tee` to a file) see clean text.
  // Sidecars are ALWAYS plain — only the lines passed to `pushFrame`
  // pass through the colorizer.
  const colorEnabled =
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true &&
    process.env.NO_COLOR == null;

  let lastBody: string | null = null;
  let lastFrameText: string | null = null;
  let frameCount = 0;

  // Snapshot-mode holding slot (fn-772). In snapshot mode `emit` does NOT
  // paint or write sidecars — it captures the latest rendered composite
  // here and reports the latch once. `runSnapshot` reads the captured
  // composite when the latch resolves, writes the sidecars ONE time, prints
  // the frame + trailer, and exits. `null` until the first `emit`.
  let snapshotCapture: { bodyLines: string[]; stateJson: unknown } | null =
    null;
  let latchReported = false;
  // fn-772: explicit per-stream reports (`reportSnapshotStream`) made by a
  // multi-stream view's SECONDARY streams. `emit` auto-reports the first
  // stream; each additional stream reports once here. Buffered until
  // `runSnapshot` arms `reportLatch` (a secondary `onRows` may fire before
  // `runSnapshot` runs), then replayed — same shape as `latchReported`'s
  // replay. Inert in live mode (`isSnapshot` false → never armed → buffer
  // unused).
  let pendingExtraReports = 0;
  // Track whether the subscription ever reported `connected` so the no-frame
  // path can distinguish `timeout` (connected, daemon serving, but no frame
  // before the deadline) from `daemon-unreachable` (never connected).
  let sawConnected = false;
  // Wired by `runSnapshot` to the latch's `reportStream`. A no-op until then
  // so an `emit` that races ahead of `runSnapshot` (shouldn't happen — the
  // caller wires subscriptions then calls `runSnapshot` synchronously) is
  // still captured into `snapshotCapture`; `runSnapshot` replays the report.
  // The named sentinel lets `reportSnapshotStream` detect the not-yet-armed
  // state (identity compare) and buffer a secondary report for replay.
  const noopReportLatch = (): void => {};
  let reportLatch: () => void = noopReportLatch;

  // Frames-mode state (see `mode === "frames"`). The emitter is pre-built by
  // the caller; the shell drives it: baseline on the FIRST accepted frame,
  // `frame` thereafter, and one idempotent trailer flush on any exit path.
  const framesEmitter: FramesEmitter | null = opts.frames?.emitter ?? null;
  const framesDurationMs = opts.frames?.durationMs ?? null;
  const framesRunIo: FramesRunIo = opts.frames?.io ?? {};
  // The freshest daemon fold cursor handed in via `noteCursor` — stamped on
  // every frames envelope + the trailer's resume cursor. `null` until the first
  // boot header lands. Stored (never read) outside frames mode.
  let latestCursor: string | null = null;
  let framesBaselineEmitted = false;
  // Trailer-flush guard: SIGINT, the duration timer, and a bound tripped
  // mid-emit can all reach the flush — it must emit the trailer + exit exactly
  // once (mirrors the snapshot `settled` / SIGINT `toreDown` idempotency).
  let framesFinished = false;
  let framesOnDispose: () => void = () => {};
  let framesTimer: SnapshotTimerHandle | null = null;

  // Connecting-indicator spinner state. A single `setInterval` (~125ms)
  // animates the braille dots and re-polls the re-fold poller until the
  // first real frame paints. Each tick repaints via the ephemeral
  // `refreshLive` overlay (single-slot, no history growth — auto-cleared
  // by the first real `pushFrame`), so the connect animation never floods
  // the frame-history ring. Composition lives in `tickConnectingSpinner`
  // below: when the poller has a `{cursor,max}` sample with `cursor<max`,
  // the indicator carries the percentage + thousands-grouped counts;
  // otherwise it falls back to the plain "connecting to keeperd…" line.
  // Self-stops on `frameCount>0` (NOT on `connected` — that lifecycle
  // event lands before the first frame paints, per
  // `readiness-client.ts:800`). Also cleared from the SIGINT teardown
  // so neither the interval nor the readonly fd leaks on Ctrl-C.
  const CONNECTING_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const SPINNER_TICK_MS = 125;
  // Drop to the plain spinner after this many consecutive null polls so a
  // transient error doesn't hold a stale percentage on screen forever. The
  // last-good `{cursor,max}` floor is preserved across misses up to this
  // budget — the re-fold cursor is monotonic per the event-sourcing
  // invariants (one cursor bump per fold-tx commit), so holding the floor
  // smooths animation through a busy_timeout-blocked poll.
  const REFOLD_MISS_BUDGET = 3;
  let connectingSpinnerIdx = 0;
  let spinnerInterval: ReturnType<typeof setInterval> | undefined;
  let lastRefold: { cursor: number; max: number } | null = null;
  let refoldMisses = 0;
  // Lazy default — only mint a real poller if the caller didn't inject one.
  // Production callers omit the option; tests inject a fake.
  const refoldPoller: RefoldProgressPoller =
    opts.refoldProgressPoller ?? createRefoldProgressPoller();
  let refoldPollerClosed = false;

  function closeRefoldPoller(): void {
    if (refoldPollerClosed) {
      return;
    }
    refoldPollerClosed = true;
    refoldPoller.close();
  }

  function stopConnectingSpinner(): void {
    if (spinnerInterval !== undefined) {
      clearInterval(spinnerInterval);
      spinnerInterval = undefined;
    }
    closeRefoldPoller();
  }

  function formatRefoldLine(glyph: string): string {
    // Keep last-good floor across REFOLD_MISS_BUDGET consecutive misses;
    // beyond that the cursor presentation is too stale to be honest and
    // we fall back to the plain "connecting" line.
    if (lastRefold === null || refoldMisses > REFOLD_MISS_BUDGET) {
      return `${glyph}  connecting to keeperd…`;
    }
    const { cursor, max } = lastRefold;
    // Guard `max` falsy + `cursor>max` (non-monotonic / mid-rewind reset):
    // never render `NaN%` / `>100%` / a fake 100%. 100% only on confirmed
    // `connected` (which stops this interval before its next tick paints).
    if (max <= 0 || cursor >= max) {
      return `${glyph}  connecting to keeperd…`;
    }
    const pct = ((cursor / max) * 100).toFixed(1);
    return `${glyph}  re-folding event log  ${pct}%  ${cursor.toLocaleString()} / ${max.toLocaleString()}`;
  }

  function tickConnectingSpinner(): void {
    // Self-stop the moment a real data frame lands. Note: we deliberately
    // do NOT stop on the `connected` lifecycle event — `connected` fires
    // before any `result` frame arrives (see `readiness-client.ts:800`),
    // and the first paint can take additional ms while collections
    // resolve. `frameCount` is the only honest signal.
    if (frameCount > 0) {
      stopConnectingSpinner();
      return;
    }
    connectingSpinnerIdx =
      (connectingSpinnerIdx + 1) % CONNECTING_SPINNER.length;
    const glyph = CONNECTING_SPINNER[connectingSpinnerIdx];
    const sample = refoldPoller.poll();
    if (sample !== null) {
      lastRefold = sample;
      refoldMisses = 0;
    } else {
      refoldMisses += 1;
    }
    liveShell.refreshLive([formatRefoldLine(glyph)]);
  }

  function armConnectingSpinner(): void {
    if (spinnerInterval !== undefined) {
      return;
    }
    spinnerInterval = setInterval(tickConnectingSpinner, SPINNER_TICK_MS);
  }

  // Shared banner-flash timer. Transient `[copied …]` / caller-driven
  // flashes share one timer so a fresh flash from any source cancels a
  // pending restore from any other — last-flash-wins, no leaked state.
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function restoreBanner(): void {
    liveShell.setStatus(persistentBannerPill ? persistentBannerPill() : "");
  }
  function scheduleFlashRestore(): void {
    if (flashTimer !== undefined) {
      clearTimeout(flashTimer);
    }
    flashTimer = setTimeout(() => {
      flashTimer = undefined;
      restoreBanner();
    }, 1500);
  }

  // `c` copies a debug snapshot to the clipboard. Owned by the shell so
  // every sibling gets identical copy behavior. Skipped silently before
  // the first frame lands (nothing to copy).
  function handleCopyKey(): void {
    if (lastFrameText == null) {
      return;
    }
    const payload = buildDebugSnapshot({
      script,
      pid,
      frame: lastFrameText,
      frameNumber: frameCount,
      metaSidecar,
      lifecycleSidecar,
      nowIso: new Date().toISOString(),
    });
    const flashed = frameCount;
    void copyToClipboard(payload).then((res) => {
      if (res.ok) {
        liveShell.setStatus(`[copied frame ${flashed}]`);
      } else {
        noteLine(`# warn: clipboard copy failed: ${res.error}`);
        liveShell.setStatus("[copy failed]");
      }
      scheduleFlashRestore();
    });
  }

  const liveShell: LiveShell = createLiveShell({
    // Only LIVE mode paints. Snapshot and frames both pass `enabled: false` so
    // no OpenTUI renderer is constructed and the shell is a clean no-op (its
    // `pushFrame`/`refreshLive`/`dispose` are inert). Both paths short-circuit
    // before any `pushFrame` anyway, but a disabled shell is the belt-and-
    // suspenders guarantee that the connecting-spinner overlay (`refreshLive`)
    // and the passthrough frame write can never reach stdout and corrupt the
    // single-frame snapshot output or the frames NDJSON stream.
    enabled: mode === "live",
    title,
    captureKeys: opts.captureKeys,
    onUnhandledKey: (key) => {
      // Modal capture: the view owns every key — skip the shell's `c`
      // (copy) so the sub-mode is fully local.
      if (opts.captureKeys?.() !== true && key === "c") {
        handleCopyKey();
        return;
      }
      callerOnKey?.(key);
    },
  });

  function writeSidecars(stateJson: unknown, frameText: string): void {
    const sState = `/tmp/keeper-${script}.${pid}.state.${frameCount}.json`;
    const sFrame = `/tmp/keeper-${script}.${pid}.frame.${frameCount}.txt`;
    const sDiff = `/tmp/keeper-${script}.${pid}.diff.${frameCount}.txt`;
    try {
      writeFileSync(sState, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      noteLine(`# warn: sidecar write failed: ${(err as Error).message}`);
    }
    // Per-frame unified diff via system `diff -u`. Exits 1 when files
    // differ — expected here (we only get here when the body changed) —
    // so we ignore the exit code and take stdout. First frame has no
    // prior; write a sentinel.
    let diffText: string;
    if (lastFrameText == null) {
      diffText = "# first frame — no previous to diff against\n";
    } else {
      try {
        writeFileSync(prevFrameTmp, `${lastFrameText}\n`);
        const proc = Bun.spawnSync({
          cmd: ["diff", "-u", prevFrameTmp, sFrame],
        });
        diffText = proc.stdout.toString();
        if (diffText.length === 0) {
          diffText = "# diff: no textual difference\n";
        }
      } catch (err) {
        diffText = `# diff failed: ${(err as Error).message}\n`;
      }
    }
    try {
      writeFileSync(sDiff, diffText);
    } catch (err) {
      noteLine(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    try {
      appendFileSync(
        metaSidecar,
        `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
      );
    } catch (err) {
      noteLine(`# warn: meta write failed: ${(err as Error).message}`);
    }
    lastFrameText = frameText;
  }

  // Strip the selection-highlight prefix off one line. Returns whether the
  // line was the selected row and its prefix-free text.
  function stripSelectionPrefix(line: string): {
    selected: boolean;
    text: string;
  } {
    return line.startsWith(SELECTED_LINE_PREFIX)
      ? { selected: true, text: line.slice(SELECTED_LINE_PREFIX.length) }
      : { selected: false, text: line };
  }

  // Map render `bodyLines` to the strings shipped to the live shell. Each
  // line is de-prefixed, then (on a color-enabled TTY) pill-colorized; the
  // selected row additionally gets the selection-background SGR prepended
  // AFTER colorization so the pill regex never sees the escape. Non-TTY
  // output is de-prefixed plain text — no SGR, no highlight.
  function toShellLines(bodyLines: string[]): string[] {
    return bodyLines.map((line) => {
      const { selected, text } = stripSelectionPrefix(line);
      if (!colorEnabled) {
        return text;
      }
      const colored = colorizePillsInLine(text);
      return selected ? `${SELECTION_BG_SGR}${colored}` : colored;
    });
  }

  // Sidecar frame text strips the selection prefix so postmortem output
  // stays clean (the prefix is a live-paint protocol, not data).
  function sidecarFrameText(bodyLines: string[]): string {
    return ["---", ...bodyLines.map((l) => stripSelectionPrefix(l).text)].join(
      "\n",
    );
  }

  // The human-facing frame text for the frames stream: selection-prefix
  // stripped, NO `---` sidecar lead (the emitter owns its own sidecar files;
  // the wire frame text is "what the human saw", matching the snapshot
  // `printedFrame`).
  function plainBodyText(bodyLines: string[]): string {
    return bodyLines.map((l) => stripSelectionPrefix(l).text).join("\n");
  }

  // Flush the terminal trailer + tear down, exactly once. Reached from the
  // SIGINT / parent-death triggers (`interrupt`), the duration timer
  // (`duration`), and a bound tripped mid-emit (`max_frames` / `duration`).
  function finishFrames(reason: TrailerReason): void {
    if (framesEmitter === null || framesFinished) {
      return;
    }
    framesFinished = true;
    if (framesTimer !== null) {
      const clearTimeoutFn: (handle: SnapshotTimerHandle) => void =
        framesRunIo.clearTimeoutFn ??
        ((handle) =>
          clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
      clearTimeoutFn(framesTimer);
      framesTimer = null;
    }
    // The trailer is ALWAYS the final line — resume cursor + honest coverage.
    framesEmitter.emitTrailer({ reason });
    stopConnectingSpinner();
    liveShell.dispose();
    framesOnDispose();
    (framesRunIo.exit ?? ((code: number) => process.exit(code)))(0);
  }

  // After an accepted frame, flush the trailer if a bound has tripped.
  function maybeStopFrames(): void {
    if (framesEmitter === null) {
      return;
    }
    const reason = framesEmitter.shouldStop();
    if (reason !== null) {
      finishFrames(reason);
    }
  }

  function emit(snap: TSnap): boolean {
    const { bodyLines, stateJson } = renderBody(snap);
    // Snapshot mode: capture the latest composite + report the latch on the
    // FIRST emit (the readiness client's first-paint gate guarantees every
    // stream has folded before this fires). No live paint, no per-emit
    // sidecar write — `runSnapshot` writes the sidecar once at resolution.
    // We always capture (so a later emit before the latch resolves keeps
    // the freshest composite) but report only once.
    if (isSnapshot) {
      snapshotCapture = { bodyLines, stateJson };
      if (!latchReported) {
        latchReported = true;
        reportLatch();
      }
      return true;
    }
    // Frames mode: emit one wire envelope per ACCEPTED frame instead of
    // painting. The byte-compare gate is the SAME as live (an unchanged body
    // from any of a multi-stream view's re-emits is suppressed, so per-stream
    // re-emits can never inflate the frame/coverage accounting). The first
    // accepted frame is the `baseline`; the rest are `frame`s diffed against
    // the prior. A tripped bound flushes the trailer through `maybeStopFrames`.
    if (isFrames) {
      if (framesEmitter === null) {
        return false;
      }
      const body = bodyLines.join("\n");
      if (body === lastBody) {
        return false;
      }
      lastBody = body;
      frameCount += 1;
      const input = {
        cursor: latestCursor,
        frameText: plainBodyText(bodyLines),
        stateJson,
      };
      if (!framesBaselineEmitted) {
        framesBaselineEmitted = true;
        framesEmitter.emitBaseline(input);
      } else {
        framesEmitter.emitFrame(input);
      }
      maybeStopFrames();
      return true;
    }
    // The byte-compare body KEEPS the selection prefix so moving the
    // selection (which only changes which line carries the prefix)
    // invalidates the cache and repaints.
    const body = bodyLines.join("\n");
    if (body === lastBody) {
      return false;
    }
    lastBody = body;
    frameCount += 1;
    // The first real frame supersedes the connecting indicator — stop
    // the spinner interval and release its readonly DB fd before pushing
    // the data frame, so the next paint isn't fighting a final spinner
    // tick.
    stopConnectingSpinner();
    liveShell.pushFrame(toShellLines(bodyLines));
    writeSidecars(stateJson, sidecarFrameText(bodyLines));
    return true;
  }

  function repaintLocal(snap: TSnap): boolean {
    const { bodyLines } = renderBody(snap);
    const body = bodyLines.join("\n");
    if (body === lastBody) {
      return false;
    }
    // Adopt the overlay content as the new baseline so a following live
    // `emit` of the same data suppresses instead of re-minting this body as
    // a history frame. No frameCount bump, no sidecar write — selection /
    // expand churn is ephemeral UI state, not a data frame.
    lastBody = body;
    liveShell.refreshLive(toShellLines(bodyLines));
    return true;
  }

  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    const lines: string[] = ["...", `event: ${event}`];
    for (const [k, v] of Object.entries(detail)) {
      lines.push(`${k}: ${String(v)}`);
    }
    lines.push("...");
    try {
      appendFileSync(lifecycleSidecar, `${lines.join("\n")}\n`);
    } catch {
      // best-effort
    }
    // On disconnect, clear `lastBody` so the next first-paint emits
    // even if the post-reconnect snapshot happens to match the last
    // pre-disconnect body byte-for-byte.
    if (event === "disconnected") {
      lastBody = null;
      // Frames coverage honesty: a reconnect is the sole gap source the
      // emitter cannot see (its own `seq` stays contiguous), so a disconnect
      // downgrades the trailer's coverage verdict to `gap_possible`.
      if (isFrames && framesEmitter !== null) {
        framesEmitter.noteReconnect();
      }
    }
    // Snapshot mode: latch whether we ever reached `connected` so the
    // no-frame trailer reports `timeout` vs `daemon-unreachable` honestly.
    if (event === "connected") {
      sawConnected = true;
    }
    // Connecting indicator: arm a single ~125ms `setInterval` until the
    // first real frame paints, so the spinner animates smoothly during a
    // multi-minute boot re-fold (the subscribe socket isn't bound during
    // boot drain — the client sits in capped-backoff `connecting` /
    // `waiting`). The interval re-polls keeper's read-only SQLite each
    // tick (`reducer_state.last_event_id` vs `MAX(events.id)`) and either
    // renders the live percentage or the plain "connecting to keeperd…"
    // line. The `frameCount === 0` gate means a transient disconnect
    // after data is on screen keeps the last good frame rather than
    // flicking back to "connecting". Self-stops on first frame; also
    // cleared from the SIGINT teardown. Armed ONLY in live mode — in snapshot
    // and frames modes the spinner's `refreshLive` overlay would write
    // `connecting…` lines to stdout and corrupt the single-frame snapshot
    // output / the frames NDJSON stream (the open-coded passthrough that
    // snapshot mode replaces had exactly this spam bug).
    if (mode === "live" && frameCount === 0 && event !== "connected") {
      armConnectingSpinner();
    }
  }

  function flashStatus(text: string): void {
    liveShell.setStatus(text);
    scheduleFlashRestore();
  }

  function installSigintHandler(onDispose: () => void): void {
    const log = (s: string): void => {
      process.stdout.write(`${s}\n`);
    };
    // Idempotency guard: SIGINT, SIGHUP, stdin-EOF and the ppid-poll can
    // all fire (even overlap) for a single dying viewer. `dispose()` /
    // `stopConnectingSpinner()` are themselves idempotent, but the
    // log-then-exit tail must run AT MOST ONCE so we don't double-print
    // the sidecar banner or re-enter `process.exit`.
    let toreDown = false;
    const exitCleanly = (): void => {
      if (toreDown) {
        return;
      }
      toreDown = true;
      // Terminal restoration before subscription teardown. Also tear
      // down the connecting-spinner interval + close its readonly DB
      // fd here so neither leaks across an exit. Bun `setInterval` has
      // no `.unref()` — an explicit `clearInterval` on every teardown
      // path is load-bearing for a clean TUI exit, not cosmetic. Both
      // `stopConnectingSpinner` and `refoldPoller.close()` are
      // idempotent so the first-frame self-stop + these teardown paths
      // are safe to co-fire.
      stopConnectingSpinner();
      liveShell.dispose();
      onDispose();
      log("...");
      log(`meta: ${metaSidecar}`);
      log(`lifecycle: ${lifecycleSidecar}`);
      log("...");
      process.exit(0);
    };
    // SIGINT (Ctrl-C) is this view's canonical interactive exit; the
    // parent-death / TTY-close triggers (SIGHUP, stdin-EOF, ppid===1
    // poll) are the fn-723 self-reap path. All route through the one
    // idempotent `exitCleanly`.
    process.on("SIGINT", exitCleanly);
    armViewerExitTriggers(exitCleanly);
  }

  function runSnapshot(onDispose: () => void): void {
    const io = opts.snapshotIo ?? {};
    const stdoutWrite =
      io.stdoutWrite ?? ((s: string) => void process.stdout.write(s));
    const stderrWrite =
      io.stderrWrite ?? ((s: string) => void process.stderr.write(s));
    const exit = io.exit ?? ((code: number) => process.exit(code));
    const nowIso = io.nowIso ?? (() => new Date().toISOString());

    // Single `settled` guard so a frame racing the timeout can't
    // double-print / double-exit.
    let settled = false;

    function buildMeta(input: {
      status: SnapshotStatus;
      truncated: boolean;
      frame: number | null;
      state: string | null;
      frameTxt: string | null;
    }): SnapshotMeta {
      return {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        script,
        pid,
        status: input.status,
        frame: input.frame,
        frame_count: input.frame === null ? 0 : 1,
        truncated: input.truncated,
        state: input.state,
        frame_txt: input.frameTxt,
        lifecycle: lifecycleSidecar,
        meta: metaSidecar,
        ts: nowIso(),
      };
    }

    function finish(outcome: SnapshotLatchOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      latch.cancel();

      const haveFrame = snapshotCapture !== null;
      if (haveFrame && snapshotCapture !== null) {
        // A frame was captured (ready, or timeout-degrade with ≥1 stream).
        // Bump frameCount to 1 so the sidecar filenames are frame-1 and the
        // trailer's `frame` matches, then write the sidecars ONCE.
        const { bodyLines: rawBodyLines, stateJson } = snapshotCapture;
        // A zero-line render (healthy but idle projection) becomes the
        // honest-empty line so the frame is never bare separators.
        const bodyLines = snapshotBodyLines(rawBodyLines, snapshotEmptyLine);
        const truncated = outcome.kind === "timeout";
        frameCount = 1;
        const frameText = sidecarFrameText(bodyLines);
        const stateSidecar = `/tmp/keeper-${script}.${pid}.state.${frameCount}.json`;
        const frameSidecar = `/tmp/keeper-${script}.${pid}.frame.${frameCount}.txt`;
        writeSidecars(stateJson, frameText);
        const meta = buildMeta({
          status: "ok",
          truncated,
          frame: frameCount,
          state: stateSidecar,
          frameTxt: frameSidecar,
        });
        // The printed frame text drops the sidecar's `---` lead — the lead
        // is a sidecar/diff artifact, not part of the human/agent frame.
        const printedFrame = bodyLines
          .map((l) => stripSelectionPrefix(l).text)
          .join("\n");
        stdoutWrite(formatSnapshotOutput({ frameText: printedFrame, meta }));
        liveShell.dispose();
        onDispose();
        exit(0);
        return;
      }

      // No frame before the deadline. `daemon-unreachable` iff we never
      // saw a `connected` lifecycle; otherwise the daemon was serving but
      // didn't deliver a frame in time → `timeout`.
      const status: SnapshotStatus = sawConnected
        ? "timeout"
        : "daemon-unreachable";
      const meta = buildMeta({
        status,
        truncated: true,
        frame: null,
        state: null,
        frameTxt: null,
      });
      const diagnostic =
        status === "daemon-unreachable"
          ? `keeper ${script}: no frame before ${timeoutMs}ms timeout (daemon unreachable)`
          : `keeper ${script}: no frame before ${timeoutMs}ms timeout (daemon connected but did not deliver a frame)`;
      const { stdout, stderr } = formatNoFrameOutput({ meta, diagnostic });
      stderrWrite(stderr);
      stdoutWrite(stdout);
      liveShell.dispose();
      onDispose();
      exit(1);
    }

    const latch = createSnapshotLatch({
      streamCount: opts.streamCount ?? 1,
      timeoutMs,
      onResolve: finish,
      ...(io.setTimeoutFn === undefined
        ? {}
        : { setTimeoutFn: io.setTimeoutFn }),
      ...(io.clearTimeoutFn === undefined
        ? {}
        : { clearTimeoutFn: io.clearTimeoutFn }),
    });
    // Wire the latch into `emit` (which captured composites pre-runSnapshot
    // would have buffered into `snapshotCapture` already). If the first emit
    // already landed before `runSnapshot` (synchronous open path), report
    // now so a single-stream view doesn't wait out the full timeout.
    reportLatch = () => latch.reportStream();
    if (latchReported) {
      latch.reportStream();
    }
    // fn-772: replay any secondary-stream reports that landed before the
    // latch was armed (a multi-stream view's `onRows` racing `runSnapshot`).
    for (let i = 0; i < pendingExtraReports; i += 1) {
      latch.reportStream();
    }
    pendingExtraReports = 0;
  }

  function noteCursor(cursor: string | null): void {
    latestCursor = cursor;
  }

  function runFrames(onDispose: () => void): void {
    framesOnDispose = onDispose;
    // SIGINT (Ctrl-C) and the fn-723 parent-death / TTY-close triggers all
    // route through the one idempotent trailer flush — the trailer stays the
    // final line even on interrupt (today's live SIGINT path only logs sidecar
    // paths; frames MUST leave a resumable trailer). The `proc` seam lets tests
    // drive these without registering real process-level handlers.
    const proc: ViewerExitProc = framesRunIo.proc ?? process;
    const onInterrupt = (): void => {
      finishFrames("interrupt");
    };
    proc.on("SIGINT", onInterrupt);
    armViewerExitTriggers(
      onInterrupt,
      framesRunIo.proc !== undefined ? { proc: framesRunIo.proc } : {},
    );
    // Duration bound: `shouldStop()` only re-checks on an accepted frame, so a
    // run whose stream goes quiet past the deadline would never terminate.
    // Arm one teardown timer to flush the `duration` trailer in that case; a
    // max-frames stop (or SIGINT) that fires first clears it via `finishFrames`.
    if (framesDurationMs !== null) {
      const setTimeoutFn: (cb: () => void, ms: number) => SnapshotTimerHandle =
        framesRunIo.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
      framesTimer = setTimeoutFn(() => {
        finishFrames("duration");
      }, framesDurationMs);
    }
  }

  // fn-772: a multi-stream view's SECONDARY stream reports its first frame
  // here. `emit` covers the first stream's report; each additional stream
  // calls this once so the latch holds until the WHOLE composite is folded.
  // Inert in live mode. Buffered until `runSnapshot` arms the latch, then
  // replayed (mirrors the `latchReported` replay for the primary stream).
  function reportSnapshotStream(): void {
    if (!isSnapshot) {
      return;
    }
    if (reportLatch === noopReportLatch) {
      // Latch not armed yet — buffer and replay in `runSnapshot`.
      pendingExtraReports += 1;
      return;
    }
    reportLatch();
  }

  return {
    liveShell,
    noteLine,
    emit,
    repaintLocal,
    emitLifecycle,
    flashStatus,
    metaSidecar,
    lifecycleSidecar,
    colorEnabled,
    installSigintHandler,
    runSnapshot,
    runFrames,
    noteCursor,
    reportSnapshotStream,
    getLastFrameText: () => lastFrameText,
    getFrameCount: () => frameCount,
  };
}
