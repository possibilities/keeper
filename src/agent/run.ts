/**
 * Process layer — the job-control keystone. Spawns claude with all three stdio
 * streams inherited (pipes would remove the child from the foreground-pgroup
 * TTY semantics and break ctrl-z), wires parent signal handling, and propagates
 * the child's exit/signal disposition verbatim.
 *
 * Resolved design (fixed — implement as specified, keep it free of cleverness):
 *  - `Bun.spawn(runCmd, {stdio: ["inherit","inherit","inherit"]})`.
 *  - SIGINT no-op handler in the parent — the child owns ctrl-c; the parent
 *    keeps awaiting (the `installSigintNoop` idiom).
 *  - Forward SIGTERM/SIGHUP to the child.
 *  - NO SIGTSTP handler — the kernel stops the whole foreground pgroup on
 *    ctrl-z and a stopped child simply doesn't resolve `.exited`; on `fg` the
 *    kernel resumes both and the await continues. This replaces the
 *    `waitpid(WUNTRACED)` loop outright.
 *  - On `await proc.exited`: `exitCode !== null` → `process.exit(exitCode)`;
 *    else `signalCode` is set → remove our own handler for that signal and
 *    re-raise it on ourselves (`process.kill(process.pid, signalCode)`), so a
 *    supervisor observes the real signal, never `128 + n`.
 */

export interface SpawnedChild {
  /** Resolves when the child exits (or is signalled). */
  readonly exited: Promise<number>;
  /** Exit code, or null when the child died from a signal. */
  readonly exitCode: number | null;
  /** Signal name the child died from, or null on a normal exit. */
  readonly signalCode: NodeJS.Signals | null;
  /** The spawned child's OS pid — the birth-record producer probes its
   *  start_time. Optional: a test spawn stub may omit it (birth record then
   *  simply not emitted); production `defaultSpawn` always carries it. */
  readonly pid?: number;
  /** Send a signal to the child. */
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnOptions {
  /** Materialized child environment. Defaults to the current process view. */
  env?: NodeJS.ProcessEnv;
  /** Child working directory. Defaults to Bun's inherited cwd. */
  cwd?: string;
}

/** Injectable spawn seam — the DI point the test-port task records against. */
export type SpawnFn = (cmd: string[], options?: SpawnOptions) => SpawnedChild;

/** Fired synchronously right after the child spawns, with its pid — the
 *  non-claude birth-record write hooks here (see `emitBirthRecord`). */
export type ChildSpawnedFn = (pid: number) => void;

/** Production spawn: Bun.spawn with all three stdio streams inherited. */
export const defaultSpawn: SpawnFn = (
  cmd: string[],
  options: SpawnOptions = {},
): SpawnedChild => {
  // Pass env as an explicit spread of the launcher's already-mutated env view,
  // NOT inherit-mode. Bun's inherit spawn can ignore deletes from that object
  // (for example TMUX/TMUX_PANE stripping before Claude launch); materializing
  // the map is the contract that carries additions and deletions exactly.
  const spawnOptions: Parameters<typeof Bun.spawn>[1] = {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...(options.env ?? process.env) },
  };
  if (options.cwd !== undefined && options.cwd !== "") {
    spawnOptions.cwd = options.cwd;
  }
  const proc = Bun.spawn(cmd, spawnOptions);
  return {
    exited: proc.exited,
    pid: proc.pid,
    get exitCode() {
      return proc.exitCode;
    },
    get signalCode() {
      return proc.signalCode as NodeJS.Signals | null;
    },
    kill(signal: NodeJS.Signals) {
      proc.kill(signal);
    },
  };
};

/**
 * Spawn claude, wire signals, and await its disposition — then exit the parent
 * to mirror the child. Never returns (it always calls `exit`). `spawn` and
 * `exit` are injectable so the wiring is testable without a real subprocess.
 */
export async function runWithJobControl(
  runCmd: string[],
  spawn: SpawnFn = defaultSpawn,
  exit: (code: number) => never = (code) => process.exit(code),
  onChildSpawned?: ChildSpawnedFn,
  spawnOptions: SpawnOptions = {},
): Promise<never> {
  const child = spawn(runCmd, spawnOptions);

  // Birth-record seam: fire once, immediately post-spawn, so the recorded
  // start_time pairs with a still-fresh child pid. Defensive try/catch on top of
  // the seam's own fail-open contract — a throwing writer must NEVER crash the
  // human's launch.
  if (onChildSpawned !== undefined && typeof child.pid === "number") {
    try {
      onChildSpawned(child.pid);
    } catch {
      // presence-only degrade
    }
  }

  // SIGINT no-op: the child (in the same foreground pgroup) receives ctrl-c
  // directly from the TTY; the parent must NOT die or it would orphan the
  // child mid-render. Keep awaiting.
  const sigintNoop = (): void => {};
  process.on("SIGINT", sigintNoop);

  // Forward terminating signals the parent receives (not via the pgroup) to
  // the child so `kill <wrapper>` propagates.
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {
      // child already gone
    }
  };
  const onTerm = forward("SIGTERM");
  const onHup = forward("SIGHUP");
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);

  try {
    await child.exited;
  } finally {
    process.removeListener("SIGINT", sigintNoop);
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGHUP", onHup);
  }

  const exitCode = child.exitCode;
  if (exitCode !== null) {
    return exit(exitCode);
  }

  // Signal death: re-raise the real signal on ourselves so a supervisor sees
  // it. Remove our own handler for that signal first (default disposition) so
  // the re-raise actually terminates us instead of looping into our handler.
  const signalCode = child.signalCode;
  if (signalCode) {
    process.removeAllListeners(signalCode);
    process.kill(process.pid, signalCode);
  }
  // Fallback: neither exit code nor signal (should not happen). Exit 1.
  return exit(1);
}

/**
 * Passthrough exec — the `execvp` replacement for informational flags and
 * built-in subcommands. Same spawn-inherit helper; await and propagate the exit
 * code verbatim. The parent lingers briefly (accepted). Signal death re-raises
 * like the main path.
 */
export async function runPassthrough(
  runCmd: string[],
  spawn: SpawnFn = defaultSpawn,
  exit: (code: number) => never = (code) => process.exit(code),
  spawnOptions: SpawnOptions = {},
): Promise<never> {
  const child = spawn(runCmd, spawnOptions);
  const sigintNoop = (): void => {};
  process.on("SIGINT", sigintNoop);
  try {
    await child.exited;
  } finally {
    process.removeListener("SIGINT", sigintNoop);
  }
  const exitCode = child.exitCode;
  if (exitCode !== null) {
    return exit(exitCode);
  }
  const signalCode = child.signalCode;
  if (signalCode) {
    process.removeAllListeners(signalCode);
    process.kill(process.pid, signalCode);
  }
  return exit(1);
}
