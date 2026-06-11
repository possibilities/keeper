/**
 * `keeper dash` viewer exit triggers — forked from `src/view-shell.ts`
 * `armViewerExitTriggers` (the fn-723 orphan-eviction set). `src/dash/` is a
 * fresh OpenTUI app that leaves the view-shell/live-shell vocabulary behind, so
 * the trigger set is duplicated here rather than imported, preserving the
 * `.unref?.()` on the ppid poll verbatim.
 *
 * The load-bearing fix for the orphan-accumulation class: an alive orphan can
 * ONLY be reaped by itself — no server probe can tell a quietly-watching live
 * viewer from a ponging headless orphan.
 *
 * `exitCleanly` is the caller's teardown tail. It MUST be idempotent — several
 * of these triggers can fire (and overlap) for one dying viewer. It does the
 * dispose + renderer.destroy() + `process.exit(0)`.
 *
 * Triggers armed (additive to the caller's own q/Ctrl-C key handler):
 *   - `SIGHUP`: controlling process / session leader went away.
 *   - stdin `'end'` / `'error'`: the controlling pty closed (EOF). We
 *     `resume()` stdin so the `'end'` actually fires on pty teardown — a paused
 *     stdin never emits EOF. Skipped on a non-TTY / piped run (the dash gates on
 *     a TTY stdout before reaching here, but stdin is checked independently).
 *   - a ~2s `process.ppid === 1` poll: the ONLY trigger that catches zellij's
 *     `on_force_close "detach"`, where the pane pty stays OPEN (no SIGHUP, no
 *     stdin EOF) but the viewer reparents to init. We capture the launch-time
 *     ppid and only treat `ppid === 1` as death if it WASN'T 1 at launch — a
 *     legitimately detached launch must not self-exit on the first tick.
 *
 * Returns a `disarm()` that clears the poll interval — exposed so tests can tear
 * the triggers down without leaking a real 2s interval into the runner.
 * Production callers never disarm (the process is exiting).
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
  // Capture the launch-time parent. If we were ALREADY init-owned at launch,
  // the ppid===1 poll can never distinguish "born detached" from "reparented
  // after death" — so we disable it (set the baseline so the poll's guard never
  // trips).
  const initialPpid = deps.initialPpid ?? proc.ppid;
  const ppidGuardArmed = initialPpid !== 1;

  proc.on("SIGHUP", () => {
    exitCleanly();
  });

  const stdin = proc.stdin;
  // Only arm stdin-EOF on a real controlling TTY. A piped/non-TTY stdin hits
  // natural EOF immediately, which is NOT a viewer-death signal.
  if (stdin.isTTY === true) {
    const onEnd = (): void => {
      exitCleanly();
    };
    const onError = (): void => {
      exitCleanly();
    };
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    // A paused stdin never emits `'end'` — `resume()` so the pty-close EOF
    // actually surfaces.
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
