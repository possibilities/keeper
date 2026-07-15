import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync, readdirSync, readSync } from "node:fs";

/**
 * Write-capable git spawn helper for the `keeper commit-work` family.
 *
 * Distinct from the daemon's read-only `gitOutput` (src/git-worker.ts:600),
 * which passes `--no-optional-locks` because the daemon is a pure OBSERVER
 * that must never take `.git/index.lock`. The commit-work verbs are the
 * opposite: they `git add` / `git commit` / `git push` and DO need the
 * opportunistic index stat-cache refresh that `--no-optional-locks` defeats —
 * so this helper deliberately OMITS that flag.
 *
 * Both stdout and stderr are drained CONCURRENTLY via `Promise.all`, retained
 * only to explicit byte ceilings, and still consumed after truncation. A linter
 * or `git` subprocess that fills one pipe buffer while we await the other
 * sequentially would deadlock once its output exceeds the OS pipe capacity;
 * retaining unlimited hook output would instead exhaust memory. The array-form
 * `Bun.spawn` with `shell: false` (Bun's default for array args) keeps the
 * argv unsplit, sidestepping shell-injection on paths.
 */

/** Result of a {@link gitExec} run. `code` is the process exit code. */
export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Non-null when the child terminated by an external or containment signal. */
  signal?: NodeJS.Signals | null;
}

/** Options for {@link gitExec}. */
export interface GitExecOptions {
  /** Working directory for the spawned `git` (sets git's cwd). */
  cwd?: string;
  /** Bytes piped to the child's stdin (e.g. `--stdin`-fed pathspecs). */
  stdin?: Uint8Array;
  /** Extra env merged over `process.env` for the child. */
  env?: Record<string, string>;
  /**
   * Wall-clock bound (ms) for the spawn. On expiry the child is SIGKILLed and the
   * result's `code` is {@link GIT_SPAWN_TIMEOUT_CODE}, distinct from git's own
   * 0/1/128 so a caller maps a TRANSIENT stall to a retry, never a hard failure.
   * Omitted / non-positive ⟹ no timeout. The backstop for an SSH TCP stall that
   * `GIT_TERMINAL_PROMPT` + ssh `ConnectTimeout` do not catch.
   */
  timeoutMs?: number;
  /** Complete-output ceiling; overflow is drained, truncated, and fails closed. */
  maxStdoutBytes?: number;
  /** Complete-error ceiling; overflow is drained, truncated, and fails closed. */
  maxStderrBytes?: number;
}

/**
 * Exit code {@link spawnGitExec} reports when a spawn exceeds its `timeoutMs` —
 * the GNU `timeout(1)` convention, chosen so it never collides with git's real
 * exit codes (0 success, 1 generic, 128 fatal). A caller keys a transient-retry
 * degrade on this code.
 */
export const GIT_SPAWN_TIMEOUT_CODE = 124;

/**
 * Exit code {@link spawnGitExec} reports when the spawn ITSELF fails synchronously
 * — `Bun.spawn` throws at `posix_spawn` before the child ever runs. The dominant
 * cause is an ENOENT because the requested `cwd` has VANISHED (a lane dir removed
 * out from under a reconcile sweep); a `git` missing from PATH throws the same way.
 * The GNU 127 "command not found" convention, chosen so it never collides with
 * git's real 0/1/128 nor the {@link GIT_SPAWN_TIMEOUT_CODE} 124. Surfacing a spawn
 * failure as a nonzero RESULT — rather than letting the throw propagate — keeps
 * every {@link GitRunner} caller on its normal `code !== 0` error path, so a single
 * vanished-cwd probe (e.g. {@link classifyLinkedWorktree}) DEFERS that repo instead
 * of unwinding an entire recover/finalize sweep.
 */
export const GIT_SPAWN_FAILED_CODE = 127;

/** A child exceeded a bounded output stream; its semantic output is unusable. */
export const GIT_OUTPUT_LIMIT_CODE = 125;
export const GIT_STDOUT_LIMIT_BYTES = 64 * 1_048_576;
export const GIT_STDERR_LIMIT_BYTES = 4 * 1_048_576;

/**
 * Default wall-clock bound (ms) for a NETWORK git op (push / push --dry-run)
 * spawned via {@link spawnGitExec}. Generous so a legitimately-progressing push
 * is never killed, while still bounding a post-connect SSH stall that would
 * otherwise wedge the reconcile cycle indefinitely.
 */
export const GIT_PUSH_TIMEOUT_MS = 120_000;

/**
 * Wall-clock bound (ms) for a LOCAL git op (merge / merge --abort / worktree
 * remove / worktree prune / branch -D / rev-parse / merge-base) on the worktree
 * merge + teardown path. SMALLER than {@link GIT_PUSH_TIMEOUT_MS}: a local op
 * touches only the on-disk repo, so the only thing that makes one hang is a
 * blocking git HOOK (a `merge`'s pre-merge-commit / post-merge running an
 * interactive or wedged command). Generous enough that a legitimately slow hook
 * (a linter) is never killed, while bounding a hung hook that would otherwise
 * freeze the reconcile worker thread. A spawn that exceeds it reports
 * {@link GIT_SPAWN_TIMEOUT_CODE}, which the worktree merge path degrades to a
 * transient retry-skip (never a freeze, never a sticky conflict).
 */
export const GIT_LOCAL_TIMEOUT_MS = 60_000;

/**
 * The function shape every commit-work git boundary depends on. Production uses
 * {@link spawnGitExec} (a real `git` subprocess); tests inject a fake recording
 * runner so the suite exercises keeper's DECISIONS (pathspec, subject, push
 * skip/log) with zero real git. A plain function param — no DI framework.
 */
export type GitRunner = (
  args: string[],
  options?: GitExecOptions,
) => Promise<GitExecResult>;

/**
 * The git env vars that override cwd-based repo discovery. An ancestor process
 * (or a git hook) that exported any of these would pin EVERY child `git` to that
 * repo/index regardless of the `cwd` we pass — the classic cause of a commit made
 * inside a linked worktree landing on `main` instead of its lane branch. We strip
 * them so git ALWAYS discovers the repo from the explicit cwd. (`GIT_TERMINAL_PROMPT`
 * and other non-discovery vars are deliberately NOT stripped.)
 */
export const GIT_DISCOVERY_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
] as const;

/**
 * Build the child env for a git spawn: the ambient env with the
 * {@link GIT_DISCOVERY_ENV_VARS} stripped, then `extra` merged over. `source`
 * defaults to `process.env` (overridable so the fast tier unit-tests the strip
 * with a synthetic env and zero global mutation). Caller-supplied `extra` wins —
 * it is applied AFTER the strip, so a deliberate caller override (none today) is
 * never clobbered, while inherited discovery vars are always removed.
 */
export function buildGitEnv(
  extra?: Record<string, string>,
  source: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source };
  for (const key of GIT_DISCOVERY_ENV_VARS) {
    delete env[key];
  }
  if (extra) {
    Object.assign(env, extra);
  }
  return env;
}

/**
 * Run `git <args>` as a real subprocess with both output streams drained
 * concurrently.
 *
 * NEVER passes `--no-optional-locks` — see the module header. The caller is
 * responsible for never issuing tree-wide `git add -A/./*` (always pathspec-
 * scoped with a `--` separator per the epic's best-practices) and for holding
 * the commit-work flock around the stage→commit→push window.
 *
 * The env ALWAYS routes through {@link buildGitEnv}, so the
 * {@link GIT_DISCOVERY_ENV_VARS} are stripped on every spawn and `git` discovers
 * the repo from the explicit `cwd` — never from an inherited `GIT_DIR`/`GIT_WORK_TREE`
 * an ancestor may have exported. PATH/HOME and the rest of the ambient env still
 * ride through so git's credential + config discovery keeps working.
 */
const DRAIN_ABORTED = Symbol("drain-aborted");

async function drainBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  abort: Promise<void>,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  for (;;) {
    const next = await Promise.race([
      reader.read(),
      abort.then(() => DRAIN_ABORTED),
    ]);
    if (typeof next === "symbol") {
      // An escaped setsid descendant can retain the inherited pipe after the
      // original process group is killed. Cancel our reader so timeout remains
      // a wall-clock bound instead of waiting forever for that foreign fd.
      void reader.cancel().catch(() => {});
      truncated = true;
      break;
    }
    const { done, value } = next;
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;
    const available = Math.max(0, maxBytes - retained);
    if (available > 0) {
      const keep = Math.min(available, value.byteLength);
      chunks.push(value.slice(0, keep));
      retained += keep;
    }
    if (value.byteLength > available) truncated = true;
  }
  const bytes = Buffer.concat(chunks, retained);
  return { text: bytes.toString("utf8"), truncated };
}

function outputLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

const MAX_TIMEOUT_TREE_PROCESSES = 10_000;
const MAX_PS_TREE_BYTES = 4 * 1_048_576;

/** Snapshot the current descendant closure while the timed-out root still lives. */
function timeoutDescendants(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const ps = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="], {
      timeout: 500,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (
      !ps.success ||
      ps.exitCode !== 0 ||
      ps.stdout.byteLength > MAX_PS_TREE_BYTES
    ) {
      return [];
    }
    const children = new Map<number, number[]>();
    for (const line of ps.stdout.toString().split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      const bucket = children.get(ppid) ?? [];
      bucket.push(pid);
      children.set(ppid, bucket);
    }
    const found: number[] = [];
    const queue = [...(children.get(rootPid) ?? [])];
    const seen = new Set<number>([rootPid]);
    while (queue.length > 0 && found.length < MAX_TIMEOUT_TREE_PROCESSES) {
      const pid = queue.shift();
      if (pid === undefined || pid <= 1 || seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(...(children.get(pid) ?? []));
    }
    return found;
  } catch {
    return [];
  }
}

function timeoutTokenProcesses(token: string): number[] {
  const needle = `KEEPER_BOUNDED_EXEC_TOKEN=${token}`;
  if (process.platform === "linux") {
    const found: number[] = [];
    try {
      for (const entry of readdirSync("/proc").slice(
        0,
        MAX_TIMEOUT_TREE_PROCESSES,
      )) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid <= 1 || pid === process.pid) continue;
        let fd: number | null = null;
        try {
          fd = openSync(
            `/proc/${entry}/environ`,
            constants.O_RDONLY | constants.O_NONBLOCK,
          );
          const bytes = Buffer.alloc(64 * 1_024);
          const count = readSync(fd, bytes, 0, bytes.length, 0);
          if (bytes.subarray(0, count).includes(Buffer.from(needle))) {
            found.push(pid);
          }
        } catch {
          // A process may exit or be unreadable while /proc is scanned.
        } finally {
          if (fd !== null) closeSync(fd);
        }
      }
    } catch {
      return [];
    }
    return found;
  }
  if (process.platform !== "win32") {
    try {
      const ps = Bun.spawnSync(["/bin/ps", "eww", "-axo", "pid=,command="], {
        timeout: 500,
        stdout: "pipe",
        stderr: "ignore",
      });
      if (
        !ps.success ||
        ps.exitCode !== 0 ||
        ps.stdout.byteLength > MAX_PS_TREE_BYTES
      ) {
        return [];
      }
      return ps.stdout
        .toString()
        .split("\n")
        .filter((line) => line.includes(needle))
        .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1] ?? 0))
        .filter((pid) => pid > 1 && pid !== process.pid)
        .slice(0, MAX_TIMEOUT_TREE_PROCESSES);
    } catch {
      return [];
    }
  }
  return [];
}

/** Stop descendants before killing the root so setsid children cannot retain pipes. */
function killTimedOutProcessTree(rootPid: number, token: string): void {
  if (process.platform === "win32") {
    try {
      process.kill(rootPid, "SIGKILL");
    } catch {
      // The child may have exited at the deadline.
    }
    return;
  }
  try {
    process.kill(-rootPid, "SIGSTOP");
  } catch {
    try {
      process.kill(rootPid, "SIGSTOP");
    } catch {
      // Continue with the ancestry snapshot; a racing exit is harmless.
    }
  }
  const descendants = [
    ...new Set([
      ...timeoutDescendants(rootPid),
      ...timeoutTokenProcesses(token),
    ]),
  ];
  // Freeze every out-of-group descendant before any parent is reaped/reparented.
  for (const pid of descendants) {
    try {
      process.kill(pid, "SIGSTOP");
    } catch {
      // Already exited.
    }
  }
  for (const pid of descendants.reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
  try {
    process.kill(-rootPid, "SIGKILL");
  } catch {
    try {
      process.kill(rootPid, "SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

export async function spawnBoundedExec(
  command: string[],
  options: GitExecOptions = {},
): Promise<GitExecResult> {
  const containmentToken = randomUUID();
  // `Bun.spawn` throws SYNCHRONOUSLY when posix_spawn fails before the child runs
  // — an ENOENT on a vanished `cwd` (a lane dir removed out from under a sweep) or
  // a `git` missing from PATH. Convert that throw into a nonzero RESULT so every
  // caller stays on its `code !== 0` path instead of the exception unwinding a
  // whole reconcile sweep. The IIFE keeps the `stdout`/`stderr` "pipe" narrowing
  // that a `let`-typed binding would lose.
  const proc = (() => {
    try {
      return Bun.spawn(command, {
        cwd: options.cwd,
        stdin: options.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: buildGitEnv({
          ...options.env,
          KEEPER_BOUNDED_EXEC_TOKEN: containmentToken,
        }),
        // Timed Git commands may launch SSH, credential, signing, or hook
        // descendants which retain their pipes. Isolate a process group so the
        // timeout closes the complete subprocess tree.
        detached:
          options.timeoutMs !== undefined &&
          options.timeoutMs > 0 &&
          process.platform !== "win32",
      });
    } catch (err) {
      return {
        spawnFailed: err instanceof Error ? err.message : String(err),
      } as const;
    }
  })();
  if ("spawnFailed" in proc) {
    return {
      code: GIT_SPAWN_FAILED_CODE,
      stdout: "",
      stderr: proc.spawnFailed,
      signal: null,
    };
  }

  // A bounded spawn SIGKILLs the child on expiry so a stalled network git op
  // (an SSH TCP stall that does not trip GIT_TERMINAL_PROMPT) cannot hang the
  // caller forever. The kill closes both pipes, so the concurrent drain below
  // resolves promptly with whatever partial output arrived.
  let timedOut = false;
  let abortDrain = (): void => {};
  const drainAbort = new Promise<void>((resolve) => {
    abortDrain = resolve;
  });
  const timer =
    options.timeoutMs !== undefined && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTimedOutProcessTree(proc.pid, containmentToken);
          abortDrain();
        }, options.timeoutMs)
      : undefined;

  try {
    // Drain both pipes CONCURRENTLY and keep consuming after each retention
    // ceiling. Awaiting one pipe first deadlocks; retaining attacker-sized hook
    // output exhausts memory. A truncated semantic stream fails closed instead
    // of letting a caller parse a partial status/path list as complete.
    const [stdout, stderr, code] = await Promise.all([
      drainBoundedOutput(
        proc.stdout,
        outputLimit(options.maxStdoutBytes, GIT_STDOUT_LIMIT_BYTES),
        drainAbort,
      ),
      drainBoundedOutput(
        proc.stderr,
        outputLimit(options.maxStderrBytes, GIT_STDERR_LIMIT_BYTES),
        drainAbort,
      ),
      proc.exited,
    ]);
    const outputLimited = stdout.truncated || stderr.truncated;
    const notes = [
      stdout.truncated ? "stdout" : null,
      stderr.truncated ? "stderr" : null,
    ].filter((value): value is string => value !== null);
    const limitNote = outputLimited
      ? `${stderr.text.length > 0 ? "\n" : ""}[keeper process-exec: ${notes.join("+")} output limit exceeded]`
      : "";
    // Timeout has priority over output overflow; otherwise partial output gets a
    // dedicated non-Git exit code so every existing `code !== 0` path refuses.
    return {
      code: timedOut
        ? GIT_SPAWN_TIMEOUT_CODE
        : outputLimited
          ? GIT_OUTPUT_LIMIT_CODE
          : code,
      stdout: stdout.text,
      stderr: `${stderr.text}${limitNote}`,
      signal: proc.signalCode,
    };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function spawnGitExec(
  args: string[],
  options: GitExecOptions = {},
): Promise<GitExecResult> {
  return spawnBoundedExec(["git", ...args], options);
}

/**
 * The git runner the commit-work family calls. Defaults to the real
 * {@link spawnGitExec}; kept as a named export so a single re-export point is
 * available, but production callers thread an injectable {@link GitRunner}
 * parameter (defaulting to this) rather than reaching for a mutable global.
 */
export const gitExec: GitRunner = spawnGitExec;
