/**
 * The terminal-surface launch + pane seams keeper dispatches workers through.
 * keeper agent is the SOLE launch transport: {@link keeperAgentLaunch} invokes the
 * patched keeper agent CLI (which OWNS the tmux window — session-create + handoff)
 * for autopilot dispatch, manual `keeper dispatch`, bus wake, AND crash-recovery
 * restore (all in resume mode for the latter two). tmux is used DIRECTLY only for
 * the surviving pane-ops seam — the session-agnostic pane ops
 * ({@link createTmuxPaneOps}: focus / list / rename / kill, consumed by the
 * renamer / jobs CLI / autopilot liveness probe). No `ExecBackend`
 * interface, no backend toggle: the launch transport is keeper agent, the pane ops
 * are the only remaining direct tmux surface.
 *
 * Every function is pure / side-effect-free at module scope; tests inject a fake
 * `spawn` to assert argv without launching real processes.
 *
 * The reconciler correlates a launch back to keeperd via the `--name verb::id`
 * baked into the keeper agent invocation → SessionStart hook event → `jobs`
 * projection, never via a surface ref; tmux is stateless from autopilot's side.
 */

// The per-harness descriptor registry (src/agent/harness.ts) is a DEP-FREE
// ISLAND — it imports nothing — so pulling the resume-argv builder here keeps
// exec-backend within the "node:* + dep-free helper" hook budget while sourcing
// the resume verb from the SINGLE registry, never a re-inlined harness switch.
import { buildHarnessResumeArgv } from "./agent/harness";

/** Bun.spawn-shaped subset the backend needs; injectable for tests. */
export type SpawnFn = (
  cmd: string[],
  options: {
    stdout: "pipe" | "ignore";
    stderr: "pipe" | "ignore";
    stdin: "ignore";
    /**
     * Set ONLY on the session-mint `new-session` spawn so the tmux server —
     * and every pane it later launches — boots with a color-capable
     * `TERM`/`COLORTERM`. Omitted elsewhere (Bun inherits `process.env`).
     */
    env?: Record<string, string>;
    /**
     * Child working directory. The tmux backend sets the worker cwd via tmux's
     * own `-c <cwd>` inside the argv (so it is omitted on those spawns); the
     * keeper agent backend has no such flag, so it sets the worker cwd HERE —
     * keeper agent reads its `process.cwd()` for the launch-script `cd`, and
     * keeperd's own cwd is not the worker's target repo.
     */
    cwd?: string;
  },
) => {
  exited: Promise<number>;
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
  /**
   * Force-terminate the child so `runCapture` can race `exited` against a
   * kill-timeout — a wedged `tmux` subprocess would otherwise freeze the
   * reconciler with no fatalExit covering it.
   */
  kill: (signal?: number) => void;
};

/**
 * `ok: false` carries a short `error` and a retry discriminant the confirm path
 * routes on:
 *   - `retryable` absent / `false` (the DEFAULT) → PERMANENT: a sticky
 *     `DispatchFailed` (only a human `retry_dispatch` clears it). Every tmux-
 *     backend failure is this class, so the existing tmux routing is unchanged.
 *   - `retryable: true` → TRANSIENT: NO `DispatchFailed`; the `pending_dispatches`
 *     row is KEPT so the normal TTL→`DispatchExpired` path re-dispatches. The
 *     keeper agent backend stamps this for a keeper agent `RETRYABLE`(4) exit and a
 *     timeout-kill — a recoverable launch must NOT be written off as sticky, and
 *     must NOT feed the K=3 never-bound counter as a permanent fail would.
 */
export type LaunchResult =
  | { ok: true }
  | { ok: false; error: string; retryable?: boolean };

/**
 * Structured launch inputs {@link keeperAgentLaunch} builds its unwrapped
 * keeper agent invocation from (keeper agent owns its own tmux window, so the keeper
 * shell-wrap shape does not apply). Both call sites already hold these pieces —
 * the autopilot reconciler from `(verb, id)`, the CLI from its parsed flags — so
 * threading the spec costs nothing at the seam.
 */
export interface LaunchSpec {
  /** The initial interactive prompt — the FINAL positional of the worker argv.
   *  In resume mode ({@link resumeTarget} set) it is unused: the argv carries
   *  `--resume <target>` and NO trailing prompt positional. */
  readonly prompt: string;
  /** Resume mode: when set (non-empty), the launch emits the harness's own resume
   *  argv (`--resume <target>` for claude/hermes, `resume <target>` for codex,
   *  `--session <target>` for pi) and DROPS the trailing prompt positional — a
   *  re-attach rather than a fresh prompted session. Omitted for the prompt-mode
   *  worker/dispatch launch (the byte-unchanged default). */
  readonly resumeTarget?: string;
  /** Launching harness (`"claude"`/`"codex"`/`"pi"`/`"hermes"`). Absent/NULL ⇒
   *  claude: the agent token stays `claude` and the claude worker-permission
   *  posture is emitted (byte-unchanged). A non-claude value routes `keeper agent
   *  <harness>` with its native resume verb and NO claude permission flags (keeper
   *  agent applies the harness's own posture default). */
  readonly harness?: string;
  /** `--name <claudeName>` (the reap/classify correlation key). Omitted when absent. */
  readonly claudeName?: string;
  /** `--model <m>`. Omitted when absent. */
  readonly model?: string;
  /** `--effort <e>`. Omitted when absent. */
  readonly effort?: string;
  /**
   * Per-cell worker plugin dir. When set (non-empty), the launch emits
   * `--plugin-dir <abs>` so the worker session loads exactly the one `work`
   * plugin matching the task's {model, effort} cell (the producer resolves the
   * absolute `plugins/plan/workers/<model>-<effort>` path cwd-independently).
   * Omitted for a launch with no cell (a `close` row, a task with no
   * tier/model) and for a `--resume` re-attach (an existing session's plugin
   * set is already pinned), so those launches stay byte-identical.
   */
  readonly pluginDir?: string;
  /**
   * Worktree-mode lane path. When set (non-empty), the launch emits a SECOND
   * `--x-tmux-env KEEPER_PLAN_WORKTREE=<path>` so the worker's `keeper
   * plan` subprocesses resolve `target_repo`/`primary_repo`/`state_repo` to the
   * lane worktree, not the shared main checkout (concurrent lanes otherwise
   * collide). Realpath-normalized by the producer so it equals the worker's
   * eventual `process.cwd()` (macOS `/var`→`/private/var`). Emitted in BOTH
   * prompt and resume mode — a resumed worktree worker must not re-resolve to
   * main. Omitted for non-worktree / pair launches (they stay byte-identical). A
   * producer-only runtime signal, NEVER a fold input / projection column.
   */
  readonly worktreePath?: string;
  /**
   * Worktree-mode lane BRANCH (`keeper/epic/<id>[--<task>]`). When set
   * (non-empty), the launch emits a THIRD `--x-tmux-env
   * KEEPER_PLAN_WORKTREE_BRANCH=<branch>` the hook captures at SessionStart as
   * the DURABLE per-job `jobs.worktree` marker. Unlike {@link worktreePath}
   * (a producer-only runtime path), the branch IS a captured fold value — it
   * survives `git worktree remove`/`move` where the path dangles. Omitted for
   * non-worktree / pair launches.
   */
  readonly worktreeBranch?: string;
}

/** One row of a `list-panes -a` sweep: the tmux server generation, the
 *  server-global pane id, its window id (`@N`), the pane's current foreground
 *  command (`pane_current_command`), the pane's dead flag / hosting session, and
 *  the window's current name. The renamer worker keys windows by `windowId` and
 *  compares `windowName`; the reconciler's slot-occupancy gate reads
 *  `currentCommand` to tell a live claude from the dead `exec $SHELL -l -i` shell
 *  tail holding a stopped session's pane.
 *
 *  The fixed fields include the autoclose kill path's per-pane discriminators
 *  (all carried verbatim as tmux emits them — no parse, no semantics applied
 *  here):
 *   - `tmuxGenerationId` — the tmux server generation key, currently
 *     `#{pid}:#{start_time}` so an OS pid reuse does not alias a new server to an
 *     old one.
 *   - `paneDead` — `#{pane_dead}`, `"1"` when the pane's process has exited
 *     (a `remain-on-exit` dead pane) else `"0"`.
 *   - `sessionName` — `#{session_name}`, the tmux session hosting the pane; a
 *     LIVE session-membership signal (a window moved out of the managed session
 *     is skipped). */
export interface PaneInfo {
  readonly tmuxGenerationId: string;
  readonly paneId: string;
  readonly windowId: string;
  readonly currentCommand: string;
  readonly paneDead: string;
  readonly sessionName: string;
  readonly windowName: string;
}

/**
 * Upper bound on a single `runCapture` tmux-subprocess await. On expiry the
 * child is force-killed and the op degrades to `null`, keeping a wedged tmux
 * server from freezing the reconciler forever (no fatalExit covers that path).
 * Unit: MILLISECONDS — never compared against the unit-seconds autopilot
 * cooldowns.
 */
const RUN_CAPTURE_TIMEOUT_MS = 5000;

/** The persisted `backend_exec_type` schema tag (restore-worker.ts stamps it;
 *  the hook's {@link execBackendEnvMeta} returns it). NOT a launch toggle —
 *  keeper agent is the sole launch transport; this is the historical tag the env
 *  metadata + the persisted snapshot carry. The one source of truth for the
 *  lockstep `db.ts` site and tests. */
export const DEFAULT_EXEC_BACKEND = "tmux" as const;

/** The single managed-session name keeper dispatches autopilot workers into.
 *  Hardcoded — not configurable. */
export const MANAGED_EXEC_SESSION = "autopilot" as const;

/** The dedicated managed-session name `keeper bus wake` resumes an offline
 *  planner@<epic> creator into. Hardcoded, distinct from {@link
 *  MANAGED_EXEC_SESSION} so woken planners never share a window list with
 *  autopilot dispatch. This constant only names the spawn target. */
export const AGENTBUS_EXEC_SESSION = "agentbus" as const;

/** Default tmux session name interactive `keeper agent` pairing partners land in.
 *  Kept alongside the other managed session-name constants in `exec-backend.ts`. */
export const PAIR_EXEC_SESSION = "pair" as const;

/** tmux session name `/plan:panel` legs land in. */
export const PANELS_EXEC_SESSION = "panels" as const;

/** Read a `ReadableStream` into a string. Returns `""` on null/empty. */
async function streamToText(s: ReadableStream | null): Promise<string> {
  if (s == null) {
    return "";
  }
  return new Response(s).text();
}

const defaultSpawn: SpawnFn = (cmd, options) =>
  Bun.spawn(cmd, options) as ReturnType<SpawnFn>;

/** Captured-spawn result: `null` ONLY on a degraded spawn — ENOENT (binary
 *  missing) or a timeout-kill (the child exceeded the kill-timeout and was
 *  force-killed). A real process that ran and exited returns the triple, even on
 *  a non-zero `exitCode`. */
export type CaptureResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
} | null;

/**
 * Build a bounded capturing spawn runner shared by both backends. Pipes
 * stdout/stderr, races `proc.exited` against a kill-timeout (a wedged
 * subprocess would otherwise freeze the reconciler forever with no fatalExit
 * covering it), and on expiry force-kills the child and degrades to `null`. An
 * ENOENT (binary missing) also degrades to `null`. NEVER throws.
 *
 * `noteLine` carries the timeout warn; `kind` labels the killed subprocess in
 * that warn (`"tmux"` / `"keeper agent"`). Factored to module scope so the
 * keeper agent backend reuses the EXACT same bounded-capture semantics the tmux
 * backend relies on (stderr drained separately, timeout-kill → null).
 */
function makeRunCapture(deps: {
  spawn: SpawnFn;
  captureTimeoutMs: number;
  noteLine: (line: string) => void;
  kind: string;
}): (
  args: string[],
  opts?: { env?: Record<string, string>; cwd?: string },
) => Promise<CaptureResult> {
  return async (args, opts) => {
    const env = opts?.env;
    const cwd = opts?.cwd;
    try {
      const proc = deps.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        ...(env != null ? { env } : {}),
        ...(cwd != null ? { cwd } : {}),
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("timed-out");
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), deps.captureTimeoutMs);
      });
      const race = await Promise.race([proc.exited, timeout]);
      if (timer != null) {
        clearTimeout(timer);
      }
      if (race === timedOut) {
        try {
          proc.kill();
        } catch {
          // Best-effort — already-dead child / no-op backend stub.
        }
        deps.noteLine(
          `# warn: ${deps.kind} subprocess exceeded ${deps.captureTimeoutMs}ms; killed and degrading to null (${args.join(" ")})`,
        );
        return null;
      }
      const [stdout, stderr] = await Promise.all([
        streamToText(proc.stdout),
        streamToText(proc.stderr),
      ]);
      return { exitCode: race, stdout, stderr };
    } catch {
      // ENOENT (binary not installed) lands here.
      return null;
    }
  };
}

/**
 * Single source of truth for the env-var NAMES the hook reads on every event,
 * keeping the hook backend-agnostic so a future wezterm/kitty backend slots in
 * without the hook learning new keys.
 */
export interface ExecBackendEnvMeta {
  readonly backendType: string;
  readonly sessionIdEnvVar: string;
  readonly paneIdEnvVar: string;
  /**
   * Keeper-owned carrier the hook reads for the pane id when the native
   * `TMUX`/`TMUX_PANE` env has been stripped (keeper agent deletes them so Claude
   * emits truecolor, copying the pane id here first). The fallback read in
   * `backendExecCoordsFromEnv` keys off this name.
   */
  readonly paneIdCarrierEnvVar: string;
}

export function execBackendEnvMeta(backendType?: string): ExecBackendEnvMeta {
  const t = backendType ?? DEFAULT_EXEC_BACKEND;
  // tmux (default) and any unknown backend fall through to the tmux env-var
  // names. tmux stamps `TMUX`/`TMUX_PANE` into every pane; managed launches add
  // `KEEPER_TMUX_SESSION` via `-e` so the session name rides a stable column.
  // Human-created sessions carry no `KEEPER_TMUX_SESSION`, so the hook stamps a
  // NULL session (filled later by the snapshot poller). An unknown name keeps
  // its label for logging, but empty strings would silently null out every hook
  // event — so the fallback returns concrete tmux names.
  return {
    backendType: t,
    sessionIdEnvVar: "KEEPER_TMUX_SESSION",
    paneIdEnvVar: "TMUX_PANE",
    // Drift guard: this literal MUST stay byte-identical to the carrier string
    // the launcher writes in `src/agent/main.ts`. There is no shared module
    // across the launcher and this consumer; matching comments on both sides are
    // the agreed drift guard. The launcher copies `$TMUX_PANE` here before
    // deleting `TMUX`/`TMUX_PANE` (so Claude emits truecolor), and the hook's
    // fallback arm reads it to keep stamping the pane id for window renaming.
    paneIdCarrierEnvVar: "KEEPER_TMUX_PANE",
  };
}

// ===========================================================================
// tmux backend
//
// Standalone pure argv builders + injectable `spawn`. The design carries three
// coords (type/session/pane) and nothing more: NO control-mode client, NO new
// worker.
//
// Identity rules (community-verified against tmux 3.6b scratch `-L` servers):
//   - target by PANE ID only (`%N` server-global durable handle); names
//     glob-match unless `=`-prefixed and colons in names break target parsing.
//   - argv arrays everywhere — no shell strings; the OS argv boundary is the
//     safe quoting seam for worker argv and session/window names alike.
//   - `-e KEEPER_TMUX_SESSION=...` for process-scoped env injection (never
//     `set-environment`, which is readable by every attached client).
//
// Version floor: `new-session -e` requires tmux ≥3.2 (3.6b verified). Managed
// windows are launched UNNAMED; the renamer worker (consuming `listPanes` /
// `renameWindow`) labels them after the hosted Claude session's job title — the
// `name` arg on `launch` stays a log/dedup key, never the `-n` label.
//
// Dispatched windows inherit the global `remain-on-exit off` and close natively
// on full-tree exit; the launch wrapper's trailing `exec $SHELL -l -i` keeps the
// pane occupied after the hosted `claude` exits, so a window persists for
// inspection and `classifyCloseKind` still reads `pid_died`. Accepted tradeoff:
// an isolated whole-process-GROUP death (OOM/`kill -9 -<pgid>` taking claude AND
// the trailing shell) that spares the tmux server and is missed by the live
// watcher classifies `window_gone_server_alive`, dropping it from crash-restore's
// auto-offer (recoverable by hand). Reboots stay `server_gone`; ordinary claude
// crashes self-heal via the trailing shell → still `pid_died`.
// ===========================================================================

/** Build the tmux `has-session -t =<session>` probe argv. Pure — exported for
 *  tests. The `=` prefix forces an EXACT match (tmux otherwise does an fnmatch
 *  glob + prefix match, so `auto` would spuriously match `autopilot`). */
export function buildTmuxHasSessionArgs(session: string): string[] {
  return ["tmux", "has-session", "-t", `=${session}`];
}

/**
 * Build the tmux `new-session -d -s <session> -e KEEPER_TMUX_SESSION=<session>`
 * mint argv. Pure — exported for tests. `-d` detaches (no client attach);
 * `-e KEEPER_TMUX_SESSION=...` is process-scoped so the session's panes inherit
 * it for the hook's session-name stamp (NEVER `set-environment`, which is
 * server-wide). Requires tmux ≥3.2 for `new-session -e`.
 */
export function buildTmuxNewSessionArgs(session: string): string[] {
  return [
    "tmux",
    "new-session",
    "-d",
    "-s",
    session,
    "-e",
    `KEEPER_TMUX_SESSION=${session}`,
  ];
}

/**
 * Build the tmux `select-window -t <paneId>` argv. Pure — exported for tests.
 * Targeting by PANE id (server-global `%N`) brings its window forward; a paired
 * `select-pane` then focuses the pane within it. NEVER name-based — colons in
 * names break target parsing.
 */
export function buildTmuxSelectWindowArgs(paneId: string): string[] {
  return ["tmux", "select-window", "-t", paneId];
}

/** Build the tmux `select-pane -t <paneId>` argv. Pure — exported for tests.
 *  Runs after `select-window` to focus the pane within its now-current window. */
export function buildTmuxSelectPaneArgs(paneId: string): string[] {
  return ["tmux", "select-pane", "-t", paneId];
}

/**
 * Build the tmux `display-message -p '#{pid}:#{start_time}'` server-generation
 * probe argv. Pure — exported for tests. The generation combines the tmux SERVER
 * pid with the server start time: it changes when the server is killed and
 * respawned, stays stable across client attach/detach, and does not alias a new
 * server that reuses an OS pid. `-p` prints to stdout; no `-t` so it resolves
 * against the default server. The restore-worker pulse runs this via its
 * injected sync `spawnSync`, parses the generation line, and hashes it into the
 * `BackendExecStart` generation id. Backend-agnostic seam: the only
 * tmux-specific piece is this argv; the pulse pairs the result with
 * `DEFAULT_EXEC_BACKEND`.
 */
export function buildTmuxServerGenerationArgs(): string[] {
  return ["tmux", "display-message", "-p", "#{pid}:#{start_time}"];
}

/**
 * Build the tmux `list-panes -a -F '#{pid}:#{start_time}\t#{pane_id}\t
 * #{window_id}\t#{pane_current_command}\t#{pane_dead}\t#{session_name}\t
 * #{window_name}'` sweep argv. Pure — exported for tests. `-a` spans every
 * session on the server. The format is TAB-delimited with `window_name` LAST so
 * the parse's final split keeps a tab inside an arbitrary window name from
 * corrupting the SIX leading FIXED fields (generation / pane id / window id /
 * current command / pane dead flag / session name); names are free user text —
 * tabs, colons, unicode all survive. The six leading values are tab-free by
 * construction (`pid:start_time`, pane/window ids, `pane_current_command`,
 * `pane_dead`, and session names contain no tabs), so each rides a fixed field.
 */
export function buildTmuxListPanesArgs(): string[] {
  return [
    "tmux",
    "list-panes",
    "-a",
    "-F",
    "#{pid}:#{start_time}\t#{pane_id}\t#{window_id}\t#{pane_current_command}\t#{pane_dead}\t#{session_name}\t#{window_name}",
  ];
}

/**
 * Locale-defaulted env for tmux spawns that must stay byte-faithful. A tmux
 * CLIENT running under the C locale sanitizes control characters in `-F`
 * format output — the sweep's TAB delimiters arrive as `_`, every line parses
 * as malformed, and the sweep reads as an empty (non-degraded) snapshot.
 * keeperd runs as a LaunchAgent whose env carries no `LANG`/`LC_*` at all, so
 * without a default every daemon-side tmux client lands in the C locale. The
 * `LANG` default is applied ONLY when no locale variable is set; an explicitly
 * configured locale (any of `LC_ALL` / `LC_CTYPE` / `LANG`, per setlocale
 * precedence) wins. Pure — exported for tests.
 */
export function localeDefaultedEnv(
  base: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  // Empty-string locale vars count as unset (setlocale semantics).
  if (!out.LC_ALL && !out.LC_CTYPE && !out.LANG) {
    out.LANG = "en_US.UTF-8";
  }
  return out;
}

/**
 * Why a session died, stamped on the synthetic `Killed` event payload by a
 * main-side tmux liveness probe so the crash-restore derivation can tell a
 * deliberate window-close from a crash-kill per row, with NO global crash
 * boundary:
 *   - `server_gone` — the tmux server is not running (reboot / crash). Restore.
 *   - `pid_died` — server alive, the job's pane is still listed but the hosted
 *     `claude` is dead. The pane stays listed because the launch wrapper's
 *     trailing `exec $SHELL -l -i` login shell holds it after `claude` exits.
 *     Restore.
 *   - `window_gone_server_alive` — server alive, the job's pane is GONE. The
 *     human deliberately closed the window. Do NOT restore.
 *   - `unknown` — probe error/timeout, no tmux binary, or no recorded pane to
 *     locate. T3's backstop treats `unknown` as crash-like-ELIGIBLE so a probe
 *     failure never silently strands a crash-kill as a never-restored close.
 */
export type CloseKind =
  | "server_gone"
  | "pid_died"
  | "window_gone_server_alive"
  | "unknown";

/**
 * WHY keeper reaped a job — the producer-known cause it stamps on a synthetic
 * `Killed` event's payload, folded onto `jobs.kill_reason` as an opaque string
 * copy. Orthogonal to {@link CloseKind}: `close_kind` is HOW the session died
 * (a tmux liveness verdict); `kill_reason` is WHY keeper acted (which producer
 * arm minted the reap).
 *
 *  - `exit_watched` — steady-state: main's exit-watcher observed the watched
 *    process exit.
 *  - `boot_unwatchable` — boot seed sweep reaped a NULL-pid (unwatchable,
 *    terminal-by-construction) row.
 *  - `boot_pid_dead` — boot seed sweep proved the row's pid dead.
 *  - `boot_pid_recycled` — boot seed sweep found the pid recycled into a
 *    different process (start_time mismatch).
 *  - `autoclosed` — the autoclose worker force-closed a done-and-idle agent's
 *    tmux window after the grace; the exit-watcher then mints the `Killed` row
 *    carrying this reason (autoclose itself writes nothing to keeper.db).
 *
 * The reducer copies it verbatim (no re-probe in the fold — a re-probe would
 * break re-fold determinism), defaulting a field-less historical payload to
 * NULL. Prefixes stay collision-free with the `dispatch-failure-key` vocabulary.
 */
export type KillReason =
  | "exit_watched"
  | "boot_unwatchable"
  | "boot_pid_dead"
  | "boot_pid_recycled"
  | "autoclosed";

/** The slice of a `Bun.spawnSync` result `classifyCloseKind` reads; injectable
 *  for tests so the classifier exercises canned tmux output with no real fork. */
export interface SyncProbeResult {
  readonly success: boolean;
  readonly exitCode: number;
  readonly stdout: { toString(): string } | null;
}

/** `Bun.spawnSync`-shaped probe runner the classifier calls; throwing models an
 *  unlaunchable tmux (binary missing). Injectable; defaults to `Bun.spawnSync`. */
export type SyncProbeFn = (args: string[]) => SyncProbeResult;

/**
 * Synchronous tmux liveness probe → {@link CloseKind}, shared verbatim by both
 * Killed producer sites (the boot seed-sweep and main's exit-watcher handler)
 * so they classify identically. ONE `list-panes -a` spawn answers both
 * questions: a non-zero exit (or unlaunchable / timed-out tmux) means the server
 * is gone, and a zero exit gives the live pane set to test the job's pane
 * against.
 *
 * Synchronous (`Bun.spawnSync`) on purpose: both call sites run on a sync path
 * (the seed-sweep loop and the exit-watcher message handler), mirroring
 * `seed-sweep.ts:readOsStartTime`. The locale-defaulted env is LOAD-BEARING —
 * a C-locale tmux client sanitizes the TAB delimiters to `_`, dropping every
 * line so a live pane would read as absent and a `pid_died` would misclassify
 * as `window_gone_server_alive` (a crash-kill stranded as a user-close).
 *
 * `paneId` absent/empty → `unknown`: the row had no recorded tmux pane, so there
 * is no window-close signal to read; crash-like-eligible, never silently
 * excluded. NEVER throws — every failure mode degrades to `unknown`.
 */
export function classifyCloseKind(
  paneId: string | null,
  opts?: { timeoutMs?: number; spawnSync?: SyncProbeFn },
): CloseKind {
  const timeout = opts?.timeoutMs ?? 1000;
  const probe: SyncProbeFn =
    opts?.spawnSync ??
    ((args) =>
      Bun.spawnSync(args, {
        timeout,
        env: localeDefaultedEnv(
          process.env as Record<string, string | undefined>,
        ),
      }));
  let res: SyncProbeResult;
  try {
    res = probe(buildTmuxListPanesArgs());
  } catch {
    // tmux binary missing / spawn failure — we cannot tell, stay crash-eligible.
    return "unknown";
  }
  // A non-zero exit means the server is not running (reboot/crash) or we could
  // not connect to it. tmux signals "no server" via a non-zero exit with the
  // error on stderr; a timed-out spawn also lands here (success=false). Either
  // way the server is unreachable → server_gone.
  if (!res.success || res.exitCode !== 0) {
    return "server_gone";
  }
  // Server alive. Without a recorded pane there is no window to locate.
  if (paneId == null || paneId === "") {
    return "unknown";
  }
  const out = res.stdout?.toString() ?? "";
  // The pane id is the SECOND tab-delimited field of each `list-panes -a` line
  // (the first is the tmux generation key). Match that field exactly — a
  // substring scan would let a window name containing the literal pane text spoof
  // presence.
  for (const line of out.split("\n")) {
    if (line === "") {
      continue;
    }
    const firstTab = line.indexOf("\t");
    if (firstTab < 0) {
      continue;
    }
    const secondTab = line.indexOf("\t", firstTab + 1);
    const candidate =
      secondTab < 0
        ? line.slice(firstTab + 1)
        : line.slice(firstTab + 1, secondTab);
    if (candidate === paneId) {
      // Pane still listed (held by the trailing login shell after `claude`
      // exits) → pid_died.
      return "pid_died";
    }
  }
  // Server alive but the pane is gone → the human closed the window.
  return "window_gone_server_alive";
}

/**
 * Build the tmux `rename-window -t <windowId> -- <name>` argv. Pure — exported
 * for tests. Targets by WINDOW id (`@N`, server-global durable handle) — never
 * name-based, since colons in names break target parsing. The `--` is
 * load-bearing: window names are arbitrary user text that may start with `-`,
 * and tmux's own parser would otherwise read such a name as an option.
 */
export function buildTmuxRenameWindowArgs(
  windowId: string,
  name: string,
): string[] {
  return ["tmux", "rename-window", "-t", windowId, "--", name];
}

/**
 * Build the tmux `kill-window -t <paneId>` argv. Pure — exported for tests.
 * Targets by PANE id (server-global `%N`): tmux resolves it upward to the
 * owning window and removes the whole window (every pane in it) — the wanted
 * semantics for one-pane managed windows. Pane-id targeting is deliberate over
 * a window id or name: a stable `%N` handle cannot be redirected by the
 * concurrent renamer worker, and colons in names break name-based targets.
 */
export function buildTmuxKillWindowArgs(paneId: string): string[] {
  return ["tmux", "kill-window", "-t", paneId];
}

/** Dep bag for {@link createTmuxPaneOps} — the direct session-agnostic pane
 *  operations seam. `spawn` is injectable for tests; `captureTimeoutMs` tunes
 *  the per-call kill-timeout. */
export interface TmuxPaneOpsDeps {
  readonly noteLine: (line: string) => void;
  readonly spawn?: SpawnFn;
  readonly captureTimeoutMs?: number;
}

/** The kept tmux pane operations, surviving the exec-backend collapse as a
 *  direct seam. Session-agnostic: `focusPane` takes the target session; the
 *  sweep/rename/kill ops target server-global tmux ids. All NEVER throw. */
export interface TmuxPaneOps {
  focusPane(session: string, paneId: string): Promise<LaunchResult>;
  listPanes(): Promise<PaneInfo[] | null>;
  renameWindow(windowId: string, name: string): Promise<LaunchResult>;
  killWindow(paneId: string): Promise<LaunchResult>;
}

/**
 * Direct factory for the session-agnostic tmux pane ops — focus / sweep /
 * rename / kill. These are the surviving tmux seam alongside the restore replay:
 * every op targets a server-global tmux id the hook stamps, so they apply
 * identically regardless of who minted the window (keeper-agent-launched or
 * hand-created). Reuses the same pure argv builders + bounded `makeRunCapture` +
 * locale default the restore-replay path uses. NEVER throws — every failure
 * degrades to a `noteLine` warn / a best-effort no-op `{ ok: false }`.
 */
export function createTmuxPaneOps(deps: TmuxPaneOpsDeps): TmuxPaneOps {
  const spawn = deps.spawn ?? defaultSpawn;
  const captureTimeoutMs = deps.captureTimeoutMs ?? RUN_CAPTURE_TIMEOUT_MS;
  const runCapture = makeRunCapture({
    spawn,
    captureTimeoutMs,
    noteLine: deps.noteLine,
    kind: "tmux",
  });

  return {
    async focusPane(
      targetSession: string,
      paneId: string,
    ): Promise<LaunchResult> {
      // Session-agnostic, no session-ensure: bring the pane's window forward
      // then focus the pane. Both target the server-global pane id — colons in
      // session/window names break name-based targets. A `select-window`
      // failure (missing session/pane) → `{ ok: false }`; the `select-pane`
      // only runs on a successful `select-window`.
      const winRes = await runCapture(buildTmuxSelectWindowArgs(paneId));
      if (winRes == null) {
        const error = `tmux select-window for session=${targetSession} pane=${paneId} failed (ENOENT? binary missing)`;
        return { ok: false, error };
      }
      if (winRes.exitCode !== 0) {
        const stderrTrim = winRes.stderr.trim();
        const detail = stderrTrim.length > 0 ? `: ${stderrTrim}` : "";
        const error = `tmux select-window for session=${targetSession} pane=${paneId} exited ${winRes.exitCode}${detail}`;
        return { ok: false, error };
      }
      const paneRes = await runCapture(buildTmuxSelectPaneArgs(paneId));
      if (paneRes == null) {
        const error = `tmux select-pane for session=${targetSession} pane=${paneId} failed (ENOENT? binary missing)`;
        return { ok: false, error };
      }
      if (paneRes.exitCode !== 0) {
        const stderrTrim = paneRes.stderr.trim();
        const detail = stderrTrim.length > 0 ? `: ${stderrTrim}` : "";
        const error = `tmux select-pane for session=${targetSession} pane=${paneId} exited ${paneRes.exitCode}${detail}`;
        return { ok: false, error };
      }
      return { ok: true };
    },
    async listPanes(): Promise<PaneInfo[] | null> {
      // One server-wide sweep; `null` (degraded/missing tmux) tells the caller
      // to skip this cycle. Parse takes the SIX leading fixed fields (generation
      // / pane id / window id / current command / pane dead flag / session name)
      // off the first six tabs, with `window_name` LAST so a tab inside an
      // arbitrary window name cannot bleed into them. Malformed lines (fewer than
      // six tabs) are dropped silently — a partial sweep is still a usable
      // snapshot. The locale-defaulted env is LOAD-BEARING: a C-locale client
      // sanitizes the TAB delimiters to `_`, which would drop every line and read
      // as an empty sweep.
      const res = await runCapture(buildTmuxListPanesArgs(), {
        env: localeDefaultedEnv(
          process.env as Record<string, string | undefined>,
        ),
      });
      if (res == null || res.exitCode !== 0) {
        return null;
      }
      const FIXED_FIELDS = 6;
      const panes: PaneInfo[] = [];
      for (const line of res.stdout.split("\n")) {
        if (line === "") {
          continue;
        }
        // Locate the first FIXED_FIELDS tab positions; `window_name` (free text,
        // may contain tabs) is the entire remainder after the last fixed tab.
        const tabs: number[] = [];
        let from = 0;
        for (let i = 0; i < FIXED_FIELDS; i++) {
          const idx = line.indexOf("\t", from);
          if (idx < 0) {
            break;
          }
          tabs.push(idx);
          from = idx + 1;
        }
        if (tabs.length < FIXED_FIELDS) {
          continue;
        }
        const tmuxGenerationId = line.slice(0, tabs[0]);
        const paneId = line.slice(tabs[0] + 1, tabs[1]);
        const windowId = line.slice(tabs[1] + 1, tabs[2]);
        const currentCommand = line.slice(tabs[2] + 1, tabs[3]);
        const paneDead = line.slice(tabs[3] + 1, tabs[4]);
        const sessionName = line.slice(tabs[4] + 1, tabs[5]);
        const windowName = line.slice(tabs[5] + 1);
        if (paneId === "" || windowId === "") {
          continue;
        }
        panes.push({
          tmuxGenerationId,
          paneId,
          windowId,
          currentCommand,
          paneDead,
          sessionName,
          windowName,
        });
      }
      return panes;
    },
    async renameWindow(windowId: string, name: string): Promise<LaunchResult> {
      // Fire-and-check like focusPane. A nonzero exit is the expected TOCTOU
      // no-op (the window closed between sweep and rename) — returned as
      // { ok: false } with no noteLine noise so a self-healing race never spams
      // the sidecar.
      const res = await runCapture(buildTmuxRenameWindowArgs(windowId, name));
      if (res == null) {
        return {
          ok: false,
          error: `tmux rename-window for ${windowId} failed (ENOENT? binary missing)`,
        };
      }
      if (res.exitCode !== 0) {
        const stderrTrim = res.stderr.trim();
        const detail = stderrTrim.length > 0 ? `: ${stderrTrim}` : "";
        return {
          ok: false,
          error: `tmux rename-window for ${windowId} exited ${res.exitCode}${detail}`,
        };
      }
      return { ok: true };
    },
    async killWindow(paneId: string): Promise<LaunchResult> {
      // Fire-and-check like renameWindow. The pane-id target resolves upward to
      // its window; tmux kills every pane in it (one-pane managed windows, so
      // this removes exactly the worker's window). Killing the last window
      // kills the managed session — fine, the next dispatch re-mints it via
      // get-or-create. A nonzero "can't find window" is the expected TOCTOU
      // no-op (the window already closed between a caller's snapshot and the
      // kill) — returned { ok: false } with no noteLine so a self-healing race
      // never spams the sidecar. The exit-watcher's synthetic Killed mint, not
      // this op's return, is the only truth of the row's death.
      const res = await runCapture(buildTmuxKillWindowArgs(paneId));
      if (res == null) {
        return {
          ok: false,
          error: `tmux kill-window for ${paneId} failed (ENOENT? binary missing)`,
        };
      }
      if (res.exitCode !== 0) {
        const stderrTrim = res.stderr.trim();
        const detail = stderrTrim.length > 0 ? `: ${stderrTrim}` : "";
        return {
          ok: false,
          error: `tmux kill-window for ${paneId} exited ${res.exitCode}${detail}`,
        };
      }
      return { ok: true };
    },
  };
}

// ===========================================================================
// keeper agent launch — keeper's sole launch transport
//
// keeper invokes the in-binary keeper agent launcher — which OWNS the tmux
// window (session-create + handoff) — for both autopilot dispatch and manual
// `keeper dispatch`. The binding/lease/kill/list/rename/focus machinery is the
// DIRECT tmux pane-ops seam ({@link createTmuxPaneOps}): every later op targets
// the server-global tmux pane id the hook stamps, not anything the launcher
// returns. The launcher's one-line JSON + exit code are consumed ONLY to confirm
// the launch and classify retry.
//
// Launcher contract (NO shared module — matching comments are the drift
// guard, byte-pinned by a fixture in test/exec-backend.test.ts):
//   - CLI flags: `claude --x-tmux --x-tmux-detached
//     --x-tmux-session <s> --x-tmux-env KEEPER_TMUX_SESSION=<s>`.
//   - stdout: exactly one line of `schema_version:1` JSON (`session`/`windowId`/
//     `paneId` at top level). keeper DISCARDS `paneId` — binding is hook-based.
//   - exit codes (the launcher's `TMUX_EXIT`): 0=launched, 1=INTERNAL, 2=BAD_ARGS,
//     3=NOOP, 4=RETRYABLE.
// ===========================================================================

/** The keeper agent tmux-launch JSON schema keeper consumes. Bumping this on the
 *  launcher side without a keeper-consumer update lands a PERMANENT fail (loud),
 *  never a silent mismatch. */
export const KEEPER_AGENT_SCHEMA_VERSION = 1;

/**
 * The launcher's `TMUX_EXIT` taxonomy (mirrors
 * `src/agent/tmux-launch.ts`). Pinned here so the central exit map
 * reads off named constants, never bare magic numbers.
 *   - `INTERNAL`(1): launcher parse/logic failure — hard fail, never retry.
 *   - `BAD_ARGS`(2): malformed invocation — a keeper-built-bad-argv BUG, loud,
 *     never retry.
 *   - `NOOP`(3): a prereq the caller can't retry into (tmux missing, session
 *     gone) — PERMANENT, never retry.
 *   - `RETRYABLE`(4): transient (timeout / lock contention) — TRANSIENT, worth a
 *     bounded retry via the normal expire path.
 */
export const KEEPER_AGENT_TMUX_EXIT = {
  INTERNAL: 1,
  BAD_ARGS: 2,
  NOOP: 3,
  RETRYABLE: 4,
} as const;

/** Inputs to {@link buildKeeperAgentLaunchArgv}. Structured (DB-free) so the argv
 *  is byte-pin testable. */
export interface KeeperAgentLaunchOpts {
  /** The launcher argv PREFIX the spawn execs to reach the folded launcher:
   *  `[<abs bun>, <abs cli/keeper.ts>, "agent"]` (built by
   *  `buildLauncherArgvPrefix` over `process.execPath` + `resolveKeeperAgentPath`).
   *  The agent token + flags are appended, yielding
   *  `<bun> <keeper.ts> agent claude …`. Supersedes the standalone keeper agent
   *  binary path — the launcher folded into `keeper agent`. */
  readonly launcherArgvPrefix: readonly string[];
  /** Managed tmux session keeper agent mints/targets via `--x-tmux-session`. */
  readonly session: string;
  /** The initial interactive prompt — the FINAL positional argv element. Dropped
   *  in resume mode ({@link resumeTarget} set). */
  readonly prompt: string;
  /** Resume mode: when set (non-empty), emit the harness's native resume argv (see
   *  {@link harness}) and NO trailing prompt positional. Omitted for the
   *  prompt-mode worker/dispatch launch. */
  readonly resumeTarget?: string;
  /** Launching harness. Absent/NULL ⇒ claude (agent token `claude`, claude
   *  worker-permission flags emitted — byte-unchanged). A non-claude value swaps
   *  the agent token to `<harness>`, drops the claude permission flags (keeper
   *  agent applies the harness's own default), and shapes the resume tail via the
   *  descriptor's resume verb. */
  readonly harness?: string;
  /** `--name <claudeName>` (the reap/classify correlation key). Omitted when absent. */
  readonly claudeName?: string;
  /** `--model <m>`. Omitted when absent. */
  readonly model?: string;
  /** `--effort <e>`. Omitted when absent. */
  readonly effort?: string;
  /**
   * `--plugin-dir <abs>` — the per-cell worker plugin dir. Emitted right after
   * `--name` (so the reap/classify `--name` adjacency is preserved and the
   * dispatch-key peel is unaffected). Omitted when absent.
   */
  readonly pluginDir?: string;
  /** Whether to pass `--x-no-confirm` (the cwd-confirm suppressor). */
  readonly noConfirm: boolean;
  /**
   * Worktree-mode lane path (realpath-normalized by the producer). When set
   * (non-empty), emit a SECOND `--x-tmux-env KEEPER_PLAN_WORKTREE=<path>`
   * right after the `KEEPER_TMUX_SESSION` entry — keeper agent accepts the repeated
   * flag (last-wins per dup key). Omitted → argv is byte-identical to today.
   */
  readonly worktreePath?: string;
  /**
   * Worktree-mode lane BRANCH (`keeper/epic/<id>[--<task>]`). Emitted as a
   * THIRD `--x-tmux-env KEEPER_PLAN_WORKTREE_BRANCH=<branch>` immediately after
   * the path env — ALWAYS present (`?? ""`) so a serial / OFF launch reusing a
   * tmux session OVERWRITES any stale branch a prior worktree launch left; an
   * empty value resolves identically to unset (the hook collapses it to NULL).
   */
  readonly worktreeBranch?: string;
}

/**
 * Build the in-binary launch argv — the unwrapped `keeper agent claude …`
 * invocation, NOT the `[shell,-l,-i,-c,…]` wrapper the tmux backend execs. The
 * folded launcher owns the tmux window, so keeper delegates session-create +
 * handoff to it:
 *
 *   `<bun> <abs cli/keeper.ts> agent claude --x-tmux
 *     --x-tmux-detached --x-tmux-session <session>
 *     --x-tmux-env KEEPER_TMUX_SESSION=<session>
 *     --x-tmux-env KEEPER_PLAN_WORKTREE=<lane>
 *     --x-tmux-env KEEPER_PLAN_WORKTREE_BRANCH=<branch>
 *     [--model <m>] [--effort <e>] [--x-no-confirm]
 *     [--name <claudeName>] (<prompt> | --resume <resumeTarget>)`
 *
 * The tail is the ONLY conditional: prompt mode (the default) ends with the
 * `prompt` positional; resume mode ({@link KeeperAgentLaunchOpts.resumeTarget} set)
 * ends with `--resume <target>` and NO prompt — the `keeper bus wake` / crash-
 * restore re-attach. The prompt-mode argv is byte-identical to before the resume
 * branch was added.
 *
 * The `[<bun>, <keeper.ts>, "agent"]` prefix is `launcherArgvPrefix` (resolved by
 * the caller from `process.execPath` + `resolveKeeperAgentPath`), since under
 * keeper `process.argv[1]` is `cli/keeper.ts` (CLI) / `src/daemon.ts` (keeperd) —
 * neither carries the `agent` token, and `daemon.ts` is the wrong binary. The
 * `--x-tmux-env KEEPER_TMUX_SESSION=<session>` is the load-bearing
 * binding carrier: the launcher injects it into the pane env via tmux `-e`, so
 * the SessionStart hook stamps the session name on the bound `jobs` row exactly
 * as the tmux backend's own `-e` does. The `--name` adjacency is load-bearing for
 * reap/classify parsing. EVERY launch emits a SECOND `--x-tmux-env
 * KEEPER_PLAN_WORKTREE=<lane-or-empty>` immediately after — the lane when {@link
 * KeeperAgentLaunchOpts.worktreePath} is set, EMPTY otherwise. tmux persists `-e`
 * into the session env, so an always-present entry OVERWRITES any stale lane a
 * prior worktree launch left in a reused session (an empty value resolves
 * identically to unset, so serial resolution is unchanged). It rides BOTH prompt
 * and resume launches (a resumed worktree worker must not re-resolve to the main
 * checkout). Pure — exported for byte-pin tests.
 */
export function buildKeeperAgentLaunchArgv(
  opts: KeeperAgentLaunchOpts,
): string[] {
  const flags: string[] = [];
  if (opts.model !== undefined) {
    flags.push("--model", opts.model);
  }
  if (opts.effort !== undefined) {
    flags.push("--effort", opts.effort);
  }
  if (opts.noConfirm) {
    flags.push("--x-no-confirm");
  }
  if (opts.claudeName !== undefined) {
    flags.push("--name", opts.claudeName);
  }
  // Per-cell worker plugin dir — emitted AFTER `--name` so the reap/classify
  // `--name verb::id` adjacency the dispatch-key regex peels is preserved. Set
  // ONLY for a prompt-mode `work` launch whose task resolves a {model,effort}
  // cell; absent for `close`/cell-less/resume launches (byte-unchanged).
  if (opts.pluginDir !== undefined && opts.pluginDir !== "") {
    flags.push("--plugin-dir", opts.pluginDir);
  }
  const harness = opts.harness ?? "claude";
  const isClaude = harness === "claude";
  // Resume mode drops the trailing prompt positional and emits the harness's OWN
  // resume argv (claude/hermes `--resume <t>`, codex `resume <t>`, pi `--session
  // <t>`) sourced from the descriptor registry — never a re-inlined switch.
  // Prompt mode keeps the prompt as the UNCONDITIONAL final positional, so the
  // claude worker/dispatch argv is byte-unchanged.
  const tail =
    opts.resumeTarget !== undefined && opts.resumeTarget !== ""
      ? buildHarnessResumeArgv(harness, opts.resumeTarget)
      : [opts.prompt];
  // The claude worker-permission posture (`--permission-mode acceptEdits
  // --dangerously-skip-permissions`) is CLAUDE-native and forwarded to the claude
  // CLI. A non-claude harness omits it — keeper agent applies that harness's own
  // no-approval default (codex `--dangerously-bypass-approvals-and-sandbox`,
  // hermes `--yolo`) at launch, so a claude flag here would reach the wrong CLI.
  const permissionPosture = isClaude
    ? ["--permission-mode", "acceptEdits", "--dangerously-skip-permissions"]
    : [];
  return [
    ...opts.launcherArgvPrefix,
    harness,
    "--x-tmux",
    "--x-tmux-detached",
    "--x-tmux-session",
    opts.session,
    "--x-tmux-env",
    `KEEPER_TMUX_SESSION=${opts.session}`,
    // Worktree-lane carrier — ALWAYS a SECOND repeated `--x-tmux-env` (keeper agent
    // last-wins per dup key): the lane in worktree mode, EMPTY in serial. Always
    // present so the `-e` OVERWRITES any stale lane a prior worktree launch left
    // in a reused tmux session env; an empty value resolves identically to unset.
    "--x-tmux-env",
    `KEEPER_PLAN_WORKTREE=${opts.worktreePath ?? ""}`,
    // Worktree-lane BRANCH carrier — ALWAYS a THIRD repeated `--x-tmux-env`
    // (keeper agent last-wins per dup key): the lane branch in worktree mode, EMPTY
    // in serial. Always present so the `-e` OVERWRITES any stale branch a prior
    // worktree launch left in a reused tmux session env (the same reason the
    // path env above is unconditional); an empty value collapses to NULL at the
    // hook's SessionStart capture.
    "--x-tmux-env",
    `KEEPER_PLAN_WORKTREE_BRANCH=${opts.worktreeBranch ?? ""}`,
    // Keeper-owned worker permission posture, mirroring the pair-launch precedent
    // (`nativeClaudeArgs`): every claude launch this builder mints is a detached
    // automated worker with NO human to answer a prompt, so it skips permission
    // prompting outright. This changes PROMPTING, not GUARDING — deny-via-envelope
    // hooks (branch-guard et al) still hard-enforce under
    // `--dangerously-skip-permissions`, so a worker still cannot create/switch
    // branches. Emitted for BOTH prompt and resume (a resumed worker is just as
    // human-less as a fresh one) but CLAUDE-ONLY — a non-claude harness gets its
    // own posture default from keeper agent instead.
    ...permissionPosture,
    ...flags,
    ...tail,
  ];
}

/** Outcome of parsing keeper agent stdout (the JSON-shape verdict, separate from
 *  the exit-code verdict). `ok` confirms a `schema_version:1` line was found;
 *  the parsed `paneId` is DISCARDED by keeper (binding is hook-based) but
 *  returned for completeness / logging. */
export type KeeperAgentParseResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Parse keeper agent's stdout DEFENSIVELY: scan LINE-BY-LINE (never `JSON.parse` a
 * raw multi-line chunk), take the first line that `JSON.parse`es to an object
 * carrying `schema_version`, and validate the version. keeper agent emits exactly
 * one JSON line, but the line scan tolerates a stray banner/log line ahead of
 * it. Every parse is wrapped in try/catch.
 *
 *   - a `schema_version === KEEPER_AGENT_SCHEMA_VERSION` object → `{ ok: true }`.
 *   - a JSON object with a DIFFERENT `schema_version` → PERMANENT fail (the
 *     cross-repo contract drifted; do not retry into a mismatch).
 *   - no parseable `schema_version` line (empty / non-JSON / malformed) →
 *     INTERNAL fail; the caller logs the raw bytes.
 *
 * Pure — exported for tests.
 */
export function parseKeeperAgentStdout(stdout: string): KeeperAgentParseResult {
  let sawObjectWithoutSchema = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not a JSON line — a banner or log line. Keep scanning.
      continue;
    }
    if (parsed == null || typeof parsed !== "object") {
      continue;
    }
    const sv = (parsed as { schema_version?: unknown }).schema_version;
    if (sv === undefined) {
      // A JSON object with no schema_version — note it, keep scanning for a
      // proper contract line before giving up.
      sawObjectWithoutSchema = true;
      continue;
    }
    if (sv !== KEEPER_AGENT_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `keeper agent JSON schema_version ${JSON.stringify(sv)} != ${KEEPER_AGENT_SCHEMA_VERSION} (cross-repo contract drift)`,
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    error: sawObjectWithoutSchema
      ? "keeper agent JSON carried no schema_version field"
      : "keeper agent emitted no parseable schema_version JSON line",
  };
}

/**
 * The ONE central keeper agent exit-code → launch outcome map. Keeping it a single
 * function (never scattered `if exitCode===3`) is load-bearing: the 3-vs-4
 * split is the fork that decides sticky-fail vs transient-retry, and a miscode
 * either trips the K=3 never-bound breaker wrongly (a permanent folded as
 * transient) or writes off a recoverable launch (a transient folded as sticky).
 *
 *   - `0` → `{ ok: true }` (launched; the caller polls for the SessionStart bind).
 *   - `4` (RETRYABLE) → `{ ok: false, retryable: true }` (TRANSIENT — the pending
 *     row expires via the normal `DispatchExpired` path and re-dispatches).
 *   - `3` (NOOP), `1` (INTERNAL), `2` (BAD_ARGS) → `{ ok: false }` PERMANENT (a
 *     sticky `DispatchFailed`; `2` is a keeper-built-bad-argv bug — loud, never
 *     retry). A permanent fail must NOT feed the never-bound counter as a
 *     transient would.
 *   - any OTHER non-zero exit → PERMANENT (unknown failure; do not retry blind).
 *
 * `parse` is the stdout-shape verdict folded in on a `0` exit: a `0` exit whose
 * stdout did NOT carry a valid contract line is treated as INTERNAL-permanent
 * (we cannot confirm the window was created). Pure — exported for tests.
 */
export function mapKeeperAgentExit(
  exitCode: number,
  parse: KeeperAgentParseResult,
): LaunchResult {
  if (exitCode === 0) {
    if (parse.ok) {
      return { ok: true };
    }
    // Clean exit but unconfirmable launch — permanent (do not retry into a
    // contract we can't read).
    return {
      ok: false,
      error: `keeper agent launch unconfirmed: ${parse.error}`,
    };
  }
  if (exitCode === KEEPER_AGENT_TMUX_EXIT.RETRYABLE) {
    return {
      ok: false,
      error: "keeper agent launch transient (exit 4 RETRYABLE)",
      retryable: true,
    };
  }
  if (exitCode === KEEPER_AGENT_TMUX_EXIT.NOOP) {
    return { ok: false, error: "keeper agent launch no-op (exit 3 NOOP)" };
  }
  if (exitCode === KEEPER_AGENT_TMUX_EXIT.INTERNAL) {
    return {
      ok: false,
      error: "keeper agent internal failure (exit 1 INTERNAL)",
    };
  }
  if (exitCode === KEEPER_AGENT_TMUX_EXIT.BAD_ARGS) {
    return {
      ok: false,
      error:
        "keeper agent bad argv (exit 2 BAD_ARGS — keeper built a bad invocation)",
    };
  }
  return { ok: false, error: `keeper agent launch failed (exit ${exitCode})` };
}

/**
 * Upper bound on a single keeper-agent-launch `runCapture` await. Larger than the
 * pane-ops 5s default because keeper agent mints the session AND hands off to
 * claude in the same invocation, so a 5s cap would spuriously timeout-kill a
 * legitimately-slow launch. On expiry the child is force-killed and the launch
 * degrades to a TRANSIENT fail (the normal expire path re-dispatches), never a
 * sticky one. Unit: MILLISECONDS.
 */
export const KEEPER_AGENT_CAPTURE_TIMEOUT_MS = 30_000;

/** Inputs to {@link keeperAgentLaunch}. `session` is the tmux session keeper agent
 *  mints/targets (the hardcoded {@link MANAGED_EXEC_SESSION} for autopilot
 *  dispatch, a per-call session for manual `keeper dispatch`); `cwd` is the
 *  worker's target repo, set on the spawn (keeper agent has no cwd flag). `label`
 *  feeds the warn/log lines only. `spec` is the structured launch keeper agent
 *  builds its invocation from. `spawn`/`captureTimeoutMs` are injectable for
 *  tests. */
export interface KeeperAgentLaunchDeps {
  readonly noteLine: (line: string) => void;
  /** The launcher argv PREFIX (`[<bun>, <abs cli/keeper.ts>, "agent"]`) the spawn
   *  execs to reach the folded `keeper agent` launcher. Resolved by the caller
   *  (`buildLauncherArgvPrefix` over `process.execPath` + `resolveKeeperAgentPath`),
   *  frozen in here. Supersedes the standalone keeper agent binary path. */
  readonly launcherArgvPrefix: readonly string[];
  readonly session: string;
  readonly cwd: string;
  readonly label: string;
  readonly spec: LaunchSpec;
  readonly spawn?: SpawnFn;
  readonly captureTimeoutMs?: number;
}

/**
 * keeper's sole launch transport. Builds the unwrapped keeper agent invocation from
 * the structured {@link LaunchSpec} (keeper agent owns its own tmux window, so the
 * keeper shell-wrap shape does not apply), runs it via the shared bounded
 * `runCapture` with the worker `cwd` on the spawn (keeper agent has no cwd flag and
 * reads its own `process.cwd()` for the launch-script `cd`; keeperd's cwd is NOT
 * the worker's target repo), parses the one-line JSON defensively, and maps the
 * exit code through the central {@link mapKeeperAgentExit}. Session-create is
 * DELEGATED to keeper agent (`--x-tmux-session`, minting with
 * C.UTF-8 + TERM/COLORTERM) — keeper runs no tmux session-ensure on this path.
 * Drives BOTH autopilot dispatch (the managed session) and manual `keeper
 * dispatch` (a per-call session). NEVER throws.
 */
export async function keeperAgentLaunch(
  deps: KeeperAgentLaunchDeps,
): Promise<LaunchResult> {
  const spawn = deps.spawn ?? defaultSpawn;
  const captureTimeoutMs =
    deps.captureTimeoutMs ?? KEEPER_AGENT_CAPTURE_TIMEOUT_MS;
  const runCapture = makeRunCapture({
    spawn,
    captureTimeoutMs,
    noteLine: deps.noteLine,
    kind: "keeper agent",
  });
  const launchArgv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: deps.launcherArgvPrefix,
    session: deps.session,
    prompt: deps.spec.prompt,
    ...(deps.spec.resumeTarget !== undefined
      ? { resumeTarget: deps.spec.resumeTarget }
      : {}),
    ...(deps.spec.harness !== undefined ? { harness: deps.spec.harness } : {}),
    ...(deps.spec.claudeName !== undefined
      ? { claudeName: deps.spec.claudeName }
      : {}),
    ...(deps.spec.model !== undefined ? { model: deps.spec.model } : {}),
    ...(deps.spec.effort !== undefined ? { effort: deps.spec.effort } : {}),
    ...(deps.spec.pluginDir !== undefined
      ? { pluginDir: deps.spec.pluginDir }
      : {}),
    ...(deps.spec.worktreePath !== undefined
      ? { worktreePath: deps.spec.worktreePath }
      : {}),
    ...(deps.spec.worktreeBranch !== undefined
      ? { worktreeBranch: deps.spec.worktreeBranch }
      : {}),
    noConfirm: true,
  });
  // keeper agent has no cwd flag — it reads its own `process.cwd()` for the
  // launch-script `cd`, so set the worker cwd on the spawn.
  const res = await runCapture(
    launchArgv,
    deps.cwd !== "" ? { cwd: deps.cwd } : undefined,
  );
  if (res == null) {
    // ENOENT (bad/missing bun or keeper path) OR a timeout-kill. A missing path
    // must fail LOUDLY (not silently): note it. Classify as TRANSIENT so a
    // wedged-but-recoverable launch (the timeout-kill case) re-dispatches; a
    // genuinely-missing binary keeps failing each cycle and surfaces in the
    // warn log, tripping the K=3 never-bound breaker after bounded retries.
    const error = `keeper agent launch for ${deps.label} produced no result (bad prefix '${deps.launcherArgvPrefix.join(" ")}'? or timeout-kill)`;
    deps.noteLine(`# warn: ${error}`);
    return { ok: false, error, retryable: true };
  }
  if (res.stderr.trim().length > 0) {
    deps.noteLine(`# launch stderr (${deps.label}): ${res.stderr.trim()}`);
  }
  const parse = parseKeeperAgentStdout(res.stdout);
  const outcome = mapKeeperAgentExit(res.exitCode, parse);
  if (outcome.ok === false) {
    deps.noteLine(
      `# warn: ${outcome.error}${outcome.retryable === true ? " (transient)" : ""}; raw stdout: ${JSON.stringify(res.stdout)}`,
    );
  }
  return outcome;
}
