/**
 * PTY-host launch path — the `--agentwrap-modal` keystone (experiment-flagged).
 *
 * Hosts claude in a Bun managed PTY (`Bun.spawn({terminal})`) instead of the
 * inherit-stdio `runWithJobControl` tail. With the modal closed this is a raw
 * passthrough: the parent's real stdin streams verbatim into the PTY and the
 * child's output streams verbatim to the parent's stdout — indistinguishable
 * from a normal launch (truecolor, resize, ctrl-c/ctrl-z). A reserved hotkey
 * byte in the passthrough stream fires a stub callback; `.2` wires the OpenTUI
 * modal there.
 *
 * MECHANICS CONTRACT (the reason this is the early-proof task):
 *  - The PTY child is NOT in the parent's foreground process group, so
 *    ctrl-c/ctrl-z/SIGWINCH do not auto-propagate. ctrl-c/ctrl-z arrive as raw
 *    bytes on the parent's raw-mode stdin and flow straight into the PTY (the
 *    PTY's own line discipline turns them into the child's signals). SIGWINCH on
 *    the PARENT is forwarded as an explicit `terminal.resize()`.
 *  - The child's REAL exit code comes from `proc.exited` resolving to the
 *    Subprocess exit code (NOT the `terminal.exit` PTY-lifecycle status, which is
 *    0=EOF / 1=error). On a signal death we re-raise the signal on ourselves so a
 *    supervisor sees the real disposition; on a read failure we fall back to 1.
 *  - The terminal is restored (parent raw mode off) on EVERY exit path — normal,
 *    child crash, signal, `uncaughtException` — BEFORE propagating the child's
 *    disposition. The restore is idempotent and registered before raw mode is
 *    entered so a mid-flight signal can never strand the parent TTY in raw mode.
 *
 * The env spread on the PTY spawn is load-bearing: the TMUX strip + KEEPER_TMUX_
 * PANE carry mutate `process.env` upstream in main(), and only a materialized
 * `{...process.env}` view reaches the child (mirrors run.ts `defaultSpawn`).
 */

import {
  attachModalOverlay,
  defaultBuildOverlayBundle,
  type OverlayHandle,
  type OverlayHostSeam,
} from "./modal-overlay";

/**
 * The reserved hotkey byte that opens the modal. `0x1d` is ctrl-] (GS, group
 * separator) — outside the bytes claude's TUI consumes and the same key telnet
 * reserves as its escape, so it is a safe, memorable host-reserved chord. When
 * `buildOverlay` is wired the host opens the OpenTUI overlay on this byte.
 */
export const MODAL_HOTKEY_BYTE = 0x1d;

/**
 * The input-reporting reset the host (the terminal owner) emits on EVERY exit
 * path. Passthrough pipes the child's (claude's) own mode-enables verbatim to
 * the real terminal — any-motion mouse (`?1003h`), button-event mouse
 * (`?1002h`), SGR mouse (`?1006h`), focus reporting (`?1004h`), bracketed paste
 * (`?2004h`) — but `overlay?.destroy()` only reverses OpenTUI's OWN modes, so on
 * teardown nothing disables what the CHILD turned on. Without this reset the
 * shell prompt is flooded with literal `CSI <35;…M` mouse-motion and `^[[I`/
 * `^[[O` focus escapes after exit. This turns every input-reporting mode OFF
 * (`?1000l`/`?1002l`/`?1003l` mouse, `?1006l` SGR, `?1004l` focus, `?2004l`
 * bracketed paste) and restores a visible cursor (`?25h`) — standard PTY-host
 * hygiene, what `reset(1)` / tmux-on-detach do.
 */
export const TERMINAL_INPUT_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25h";

/** The Bun PTY surface the host drives — the injectable seam for tests. */
export interface PtyHandle {
  /** Write raw bytes (or a string) into the PTY master. */
  write(data: string | Uint8Array): void;
  /** Resize the PTY to the parent terminal's new dimensions. */
  resize(cols: number, rows: number): void;
  /** Send a signal to the child process. */
  kill(signal: NodeJS.Signals): void;
  /** Resolves to the child's REAL exit code (Subprocess.exited), not PTY status. */
  readonly exited: Promise<number>;
  /** Child exit code once exited, else null. */
  readonly exitCode: number | null;
  /** Signal the child died from once exited, else null. */
  readonly signalCode: NodeJS.Signals | null;
  /** Release PTY resources. Idempotent. */
  close(): void;
}

/** Options handed to the PTY-spawn seam. */
export interface PtySpawnOptions {
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
  /** Child → parent: raw PTY output bytes. */
  onData: (data: Uint8Array) => void;
}

/** Injectable PTY-spawn seam — production wires `Bun.spawn({terminal})`. */
export type PtySpawnFn = (cmd: string[], opts: PtySpawnOptions) => PtyHandle;

/** The parent's stdin — a TTY ReadStream in production. */
export interface HostStdin {
  setRawMode?(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  off(event: "data", listener: (chunk: Buffer) => void): void;
  readonly isTTY?: boolean;
}

/** The parent's stdout — a TTY WriteStream in production. */
export interface HostStdout {
  write(data: Uint8Array | string): boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly isTTY?: boolean;
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

/** A minimal process surface for signal wiring + exit (injectable). */
export interface HostProcess {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  removeAllListeners(event: string): void;
  kill(pid: number, signal: NodeJS.Signals): void;
  readonly pid: number;
}

export interface ModalHostDeps {
  ptySpawn: PtySpawnFn;
  stdin: HostStdin;
  stdout: HostStdout;
  proc: HostProcess;
  env: NodeJS.ProcessEnv;
  exit: (code: number) => never;
  /**
   * Fired when the reserved hotkey byte is seen in the passthrough stream AND no
   * `buildOverlay` is wired (the .1 stub path / tests). When `buildOverlay` is
   * present the host opens the overlay on the hotkey instead and `onHotkey` is
   * ignored. The host swallows the hotkey byte either way.
   */
  onHotkey?: () => void;
  /**
   * Build the OpenTUI modal overlay (.2). Given the host seam (stdin handoff, PTY
   * redraw, raw terminal write, tmux flag), returns the open/close/destroy handle
   * AFTER suspending the freshly-built renderer. Absent → the legacy stub
   * `onHotkey` path (no renderer is ever built, so the no-flag/test paths stay
   * byte-identical). Async because building the renderer is async.
   */
  buildOverlay?: (seam: OverlayHostSeam) => Promise<OverlayHandle>;
}

/** Default terminal dimensions when stdout reports none (never observed on a TTY). */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

/**
 * Host claude in a PTY and run the raw passthrough loop until the child exits,
 * then restore the terminal and propagate the child's disposition. Never returns
 * (always calls `exit` or re-raises a signal). Every collaborator is injected so
 * the wiring is testable without a real subprocess or TTY.
 */
export async function runModalHost(
  runCmd: string[],
  deps: ModalHostDeps,
): Promise<never> {
  const { stdin, stdout, proc, env, exit } = deps;
  const onHotkey = deps.onHotkey ?? ((): void => {});

  // Restore is idempotent and the single source of truth for un-rawing the
  // parent TTY. Registered on exit/uncaughtException/signals BEFORE raw mode is
  // entered so a mid-flight crash can never strand the parent in raw mode.
  let restored = false;
  const restore = (): void => {
    if (restored) {
      return;
    }
    restored = true;
    // Disable the input-reporting modes the CHILD turned on (mouse/focus/
    // bracketed-paste) BEFORE un-rawing — overlay?.destroy() only reverses
    // OpenTUI's own modes, so the host owns clearing what the child left on.
    // Fail-open: a write to a gone TTY must never block the restore tail.
    try {
      stdout.write(TERMINAL_INPUT_RESET);
    } catch {
      // TTY already gone — nothing to reset.
    }
    try {
      stdin.setRawMode?.(false);
    } catch {
      // TTY already gone — nothing to restore.
    }
    try {
      stdin.pause();
    } catch {
      // already paused / detached
    }
  };

  // The OpenTUI overlay handle, built once below the listener setup when
  // `buildOverlay` is wired (.2). null on the legacy stub path (no renderer is
  // ever built, so the no-flag/test paths stay byte-identical). Declared here so
  // the crash net and the passthrough closures can reference it.
  let overlay: OverlayHandle | null = null;

  const onUncaught = (err: unknown): void => {
    // Destroy the overlay FIRST (renderer.destroy() restores alt-screen/raw), THEN
    // un-raw the parent — never leave the terminal corrupted on a crash.
    try {
      overlay?.destroy();
    } catch {
      // best-effort
    }
    restore();
    try {
      pty.close();
    } catch {
      // child already gone
    }
    // Surface the crash, then exit non-zero — the terminal is already restored.
    process.stderr.write(`agentwrap modal host: ${String(err)}\n`);
    exit(1);
  };
  proc.on("uncaughtException", onUncaught as (...a: unknown[]) => void);

  const cols = stdout.columns ?? FALLBACK_COLS;
  const rows = stdout.rows ?? FALLBACK_ROWS;

  // Child → parent passthrough, with hotkey interception. The hotkey byte is
  // swallowed (never forwarded onward); everything else streams verbatim — EXCEPT
  // while the overlay owns the screen, where child output is dropped so it cannot
  // scribble over the modal (v0 has no faithful backdrop; the dismiss SIGWINCH
  // redraw repaints the agent).
  const onData = (data: Uint8Array): void => {
    if (overlay?.isOpen) {
      return;
    }
    stdout.write(data);
  };

  const pty = deps.ptySpawn(runCmd, {
    cols,
    rows,
    // The env spread is load-bearing — see file header. deps.env IS process.env
    // upstream, already carrying the TMUX strip + KEEPER_TMUX_PANE.
    env: { ...env },
    onData,
  });

  // Parent stdin → PTY: raw bytes, no TextDecoder (a TextDecoder would split a
  // multi-byte escape across chunk boundaries). stdin is a strict single-owner
  // mutex — this listener is the only stdin reader for the modal-closed period.
  const onStdin = (chunk: Buffer): void => {
    const bytes = new Uint8Array(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength,
    );
    // Scan for the reserved hotkey byte; open the overlay (or fire the stub) and
    // drop just that byte, forwarding the surrounding bytes so a chord mid-paste
    // does not eat input.
    const hotkeyAt = bytes.indexOf(MODAL_HOTKEY_BYTE);
    if (hotkeyAt === -1) {
      pty.write(bytes);
      return;
    }
    if (hotkeyAt > 0) {
      pty.write(bytes.subarray(0, hotkeyAt));
    }
    // overlay.open() runs the atomic stdin handoff (detaches THIS listener before
    // resuming the renderer), so anything after the hotkey in this same chunk
    // would race the handoff — forward it to the PTY BEFORE opening.
    const rest = bytes.subarray(hotkeyAt + 1);
    if (rest.byteLength > 0) {
      pty.write(rest);
    }
    if (overlay) {
      overlay.open();
    } else {
      onHotkey();
    }
  };

  // Forward the parent's SIGWINCH as an explicit PTY resize — the child is not
  // in the parent's foreground pgroup, so the kernel does not propagate it.
  const onResize = (): void => {
    pty.resize(stdout.columns ?? FALLBACK_COLS, stdout.rows ?? FALLBACK_ROWS);
  };

  // Forward terminating signals the parent receives (e.g. `kill <host>`) to the
  // child. ctrl-c/ctrl-z are NOT here: in raw mode they arrive as stdin bytes
  // (0x03/0x1a) and flow into the PTY, whose line discipline signals the child.
  const forward = (signal: NodeJS.Signals) => (): void => {
    try {
      pty.kill(signal);
    } catch {
      // child already gone
    }
  };
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");

  // Enter raw mode AFTER the restore hooks are armed.
  try {
    stdin.setRawMode?.(true);
  } catch {
    // Non-fatal: a TTY that rejects raw mode degrades to cooked input.
  }
  stdin.resume();
  stdin.on("data", onStdin);
  stdout.on("resize", onResize);
  proc.on("SIGWINCH", onResize as (...a: unknown[]) => void);
  proc.on("SIGTERM", onTerm as (...a: unknown[]) => void);
  proc.on("SIGHUP", onHup as (...a: unknown[]) => void);

  // Build the OpenTUI overlay ONCE and keep it suspended (the resting state).
  // The host seam: the stdin mutex handoff is THIS listener's off/on; the agent
  // redraw is the PTY resize; the raw terminal sink is stdout; tmux is detected
  // off the parent's env. A build failure is non-fatal — fall back to the stub
  // hotkey so a renderer fault never wedges the passthrough.
  if (deps.buildOverlay) {
    const seam: OverlayHostSeam = {
      stdinHandoff: {
        detach: () => stdin.off("data", onStdin),
        // Re-assert raw passthrough on the way back to the modal-closed state:
        // OpenTUI's suspend() drops the parent to cooked mode + pauses stdin,
        // which would otherwise echo + line-buffer input (e.g. the child's mouse
        // reports) once the modal closes.
        attach: () => {
          try {
            stdin.setRawMode?.(true);
          } catch {
            // TTY rejected raw mode — degrade to cooked input.
          }
          stdin.resume();
          stdin.on("data", onStdin);
        },
      },
      requestAgentRedraw: () => onResize(),
      termWrite: (data) => void stdout.write(data),
      underTmux: Boolean(env.TMUX),
    };
    try {
      overlay = await deps.buildOverlay(seam);
    } catch (err) {
      process.stderr.write(
        `agentwrap modal host: overlay build failed (${String(err)}); ` +
          "modal disabled for this session\n",
      );
      overlay = null;
    }
    // buildOverlay leaves the renderer suspended, and OpenTUI's suspend() drops
    // the parent terminal to cooked mode + pauses stdin. Re-assert raw passthrough
    // so the modal-closed resting period does not echo + line-buffer input — the
    // gap that made the child's mouse reports spill into the terminal as text.
    try {
      stdin.setRawMode?.(true);
    } catch {
      // TTY rejected raw mode — degrade to cooked input.
    }
    stdin.resume();
  }

  // Read the child's REAL exit disposition out-of-band (Subprocess.exited),
  // never the terminal.exit PTY-lifecycle status.
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  try {
    await pty.exited;
    exitCode = pty.exitCode;
    signalCode = pty.signalCode;
  } catch {
    // exited rejected — disposition unknown; fall through to the exit-1 fallback.
  } finally {
    stdin.off("data", onStdin);
    stdout.off("resize", onResize);
    proc.removeListener("SIGWINCH", onResize as (...a: unknown[]) => void);
    proc.removeListener("SIGTERM", onTerm as (...a: unknown[]) => void);
    proc.removeListener("SIGHUP", onHup as (...a: unknown[]) => void);
    proc.removeListener(
      "uncaughtException",
      onUncaught as (...a: unknown[]) => void,
    );
    // Child exited (possibly WHILE the modal was open): destroy the overlay FIRST
    // so renderer.destroy() restores the alt-screen/raw state, THEN un-raw the
    // parent. destroy() is idempotent and safe when the overlay was never opened.
    try {
      overlay?.destroy();
    } catch {
      // best-effort — overlay teardown must never block the parent restore.
    }
    restore();
    try {
      pty.close();
    } catch {
      // already closed
    }
  }

  if (exitCode !== null) {
    return exit(exitCode);
  }
  if (signalCode) {
    // Re-raise the real signal on ourselves so a supervisor observes it (never
    // 128+n). Drop our handler for that signal first so the re-raise terminates.
    proc.removeAllListeners(signalCode);
    proc.kill(proc.pid, signalCode);
  }
  // Neither an exit code nor a signal (read failure / should not happen): exit 1.
  return exit(1);
}

/**
 * Production PTY-spawn seam: `Bun.spawn({terminal})`. The child's real exit code
 * rides `proc.exited` (the Subprocess promise), NOT the `terminal.exit` callback
 * (which reports PTY-lifecycle status 0=EOF/1=error). The terminal `data`
 * callback forwards child output; `exit` is intentionally unused for disposition.
 */
export const defaultPtySpawn: PtySpawnFn = (
  cmd: string[],
  opts: PtySpawnOptions,
): PtyHandle => {
  const proc = Bun.spawn(cmd, {
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      data: (_term, data) => opts.onData(data),
    },
    env: opts.env,
  });
  return {
    write(data: string | Uint8Array): void {
      proc.terminal?.write(data);
    },
    resize(cols: number, rows: number): void {
      proc.terminal?.resize(cols, rows);
    },
    kill(signal: NodeJS.Signals): void {
      proc.kill(signal);
    },
    exited: proc.exited,
    get exitCode(): number | null {
      return proc.exitCode;
    },
    get signalCode(): NodeJS.Signals | null {
      return proc.signalCode as NodeJS.Signals | null;
    },
    close(): void {
      proc.terminal?.close();
    },
  };
};

/**
 * Production `buildOverlay`: build the suspended OpenTUI renderer, IMMEDIATELY
 * suspend it (the resting state — the modal-closed period is byte-identical to a
 * normal launch), then attach the modal overlay onto it with the host seam.
 */
const defaultBuildOverlay = async (
  seam: OverlayHostSeam,
): Promise<OverlayHandle> => {
  const bundle = await defaultBuildOverlayBundle();
  // The renderer auto-starts on build; suspend it at once so it sits dormant
  // until the hotkey resumes it. open()/close() own the resume/suspend cycle.
  bundle.renderer.suspend();
  return attachModalOverlay({ ...seam, bundle });
};

/** Production deps for the modal host, wired to the real process surfaces. */
export function defaultModalHostDeps(onHotkey?: () => void): ModalHostDeps {
  return {
    ptySpawn: defaultPtySpawn,
    stdin: process.stdin as unknown as HostStdin,
    stdout: process.stdout as unknown as HostStdout,
    proc: process as unknown as HostProcess,
    env: process.env,
    exit: (code) => process.exit(code),
    onHotkey,
    buildOverlay: defaultBuildOverlay,
  };
}
