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
import { createLiveShell, type LiveShell } from "./live-shell";

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

/** Output of one render pass — the body the view wants to emit. */
export interface ViewRender {
  /** Body lines, one per output row. Empty array yields a `---`-only frame. */
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

  // Connecting-indicator spinner state (see `emitLifecycle`). Braille dots
  // advance one step per lifecycle tick while the first real frame is still
  // pending, so the user isn't staring at a blank alt-screen while keeperd
  // finishes its boot drain (the subscribe socket isn't up yet).
  const CONNECTING_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let connectingSpinnerIdx = 0;

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
    enabled: true,
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

  function emit(snap: TSnap): boolean {
    const { bodyLines, stateJson } = renderBody(snap);
    // The byte-compare body KEEPS the selection prefix so moving the
    // selection (which only changes which line carries the prefix)
    // invalidates the cache and repaints.
    const body = bodyLines.join("\n");
    if (body === lastBody) {
      return false;
    }
    lastBody = body;
    frameCount += 1;
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
    }
    // Connecting indicator: until the first real frame paints, surface a
    // spinner placeholder so the user knows the view is waiting on keeperd
    // (the subscribe socket isn't up during boot drain — the client sits in
    // its capped-backoff retry loop emitting `connecting` / `waiting`). The
    // spinner advances one step per lifecycle tick — no timer. The first
    // snapshot's `emit()` repaints over it; the `frameCount === 0` gate means
    // a transient disconnect after data is on screen keeps the last good
    // frame rather than flicking back to "connecting".
    if (frameCount === 0 && event !== "connected") {
      connectingSpinnerIdx =
        (connectingSpinnerIdx + 1) % CONNECTING_SPINNER.length;
      liveShell.pushFrame([
        `${CONNECTING_SPINNER[connectingSpinnerIdx]} connecting to keeperd…`,
      ]);
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
    process.on("SIGINT", () => {
      // Terminal restoration before subscription teardown.
      liveShell.dispose();
      onDispose();
      log("...");
      log(`meta: ${metaSidecar}`);
      log(`lifecycle: ${lifecycleSidecar}`);
      log("...");
      process.exit(0);
    });
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
    getLastFrameText: () => lastFrameText,
    getFrameCount: () => frameCount,
  };
}
