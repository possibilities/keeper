/**
 * `ExecBackend` — terminal-surface spawn port for the autopilot reconciler,
 * plus session-agnostic pane ops for the `keeper jobs` CLI and restore-agents
 * replay. A factory with no top-level side effects; tests inject a fake `spawn`
 * to assert argv without launching real processes.
 *
 * Two op categories share one factory + one set of tmux -f /dev/null subprocess plumbing:
 *   - Session-bound lifecycle (`launch`) drives ONE managed session baked in at
 *     construction; each op runs a cheap per-call `has-session` get-or-create.
 *     Launch-window dedup is served by the durable `pending_dispatches`
 *     projection.
 *   - Session-agnostic (`focusPane`, `ensureLaunched`) take the target session
 *     per call. `focusPane` runs NO session-ensure; `ensureLaunched` runs its
 *     OWN per-call get-or-create.
 *
 * The reconciler correlates a launch back to keeperd via the `--name verb::id`
 * baked into `argv` → SessionStart hook event → `jobs` projection, never via a
 * surface ref; tmux is stateless from autopilot's side.
 */

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
     * agentwrap backend has no such flag, so it sets the worker cwd HERE —
     * agentwrap reads its `process.cwd()` for the launch-script `cd`, and
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
 *     agentwrap backend stamps this for an agentwrap `RETRYABLE`(4) exit and a
 *     timeout-kill — a recoverable launch must NOT be written off as sticky, and
 *     must NOT feed the K=3 never-bound counter as a permanent fail would.
 */
export type LaunchResult =
  | { ok: true }
  | { ok: false; error: string; retryable?: boolean };

/**
 * Structured launch inputs an `ExecBackend.launch` may consume to build its own
 * invocation argv, instead of the pre-wrapped `argv` positional. The tmux
 * backend IGNORES this and execs the shell-wrapped `argv` verbatim; the
 * agentwrap backend IGNORES the pre-wrapped `argv` and builds the unwrapped
 * agentwrap invocation FROM this spec (it owns its own tmux window, so the
 * keeper shell-wrap shape does not apply). Both call sites already hold these
 * pieces — the autopilot reconciler from `(verb, id)`, the CLI from its parsed
 * flags — so threading the spec costs nothing at the seam.
 */
export interface LaunchSpec {
  /** The initial interactive prompt — the FINAL positional of the worker argv. */
  readonly prompt: string;
  /** `--name <claudeName>` (the reap/classify correlation key). Omitted when absent. */
  readonly claudeName?: string;
  /** `--model <m>`. Omitted when absent. */
  readonly model?: string;
  /** `--effort <e>`. Omitted when absent. */
  readonly effort?: string;
}

/** One row of a `list-panes -a` sweep: the server-global pane id, its window
 *  id (`@N`), and the window's current name. The renamer worker keys windows by
 *  `windowId` and compares `windowName` to decide whether a rename is owed. */
export interface PaneInfo {
  readonly paneId: string;
  readonly windowId: string;
  readonly windowName: string;
}

export interface ExecBackend {
  /** Session-bound. Spawn the worker at `cwd` in a new window in the managed
   *  session. The `name` arg is NOT forwarded to the window label — it feeds the
   *  warn/log lines and is the autopilot dedup key only. The tmux backend execs
   *  the pre-wrapped `argv` verbatim; the agentwrap backend IGNORES `argv` and
   *  builds its own unwrapped invocation from `spec` (when supplied), delegating
   *  the tmux window to agentwrap. `spec` is optional so the tmux-only call sites
   *  (restore replay) and tests keep the legacy 3-arg shape. */
  launch(
    argv: string[],
    name: string,
    cwd: string,
    spec?: LaunchSpec,
  ): Promise<LaunchResult>;
  /** Session-agnostic. Focus `paneId` in an already-live external `session`
   *  (brings its window forward, then focuses the pane). No session-ensure runs;
   *  a missing session/pane → `{ ok: false }`. NEVER throws. */
  focusPane(session: string, paneId: string): Promise<LaunchResult>;
  /** Session-agnostic. Launch into the per-call `session`. The tmux backend
   *  get-or-creates the session and execs the pre-wrapped `argv` in a new
   *  window (unnamed when `name` is empty/absent — the restore path); the
   *  agentwrap backend ignores `argv` and builds its own invocation from `spec`
   *  (delegating session-create to agentwrap). `spec` is optional so the restore
   *  replay (which has only a recorded shell-wrapped `argv`, no structured spec)
   *  stays on the tmux-style path even under the agentwrap backend. NEVER
   *  throws. */
  ensureLaunched(
    session: string,
    argv: string[],
    cwd: string,
    name?: string,
    spec?: LaunchSpec,
  ): Promise<LaunchResult>;
  /** Session-agnostic. Sweep every pane on the server (`list-panes -a`) into
   *  `(paneId, windowId, windowName)` rows. `null` on a degraded/missing tmux —
   *  callers skip the cycle. NEVER throws. */
  listPanes(): Promise<PaneInfo[] | null>;
  /** Session-agnostic. Rename window `windowId` (`@N`) to `name` via
   *  `rename-window -t <id> -- <name>` (the `--` guards names starting with
   *  `-`). A nonzero "can't find window" is an expected TOCTOU no-op returned as
   *  `{ ok: false }` without noise. NEVER throws. */
  renameWindow(windowId: string, name: string): Promise<LaunchResult>;
  /** Session-agnostic. Kill the window owning pane `paneId` (`%N`) via
   *  `kill-window -t <paneId>` — tmux -f /dev/null resolves the pane-id target UPWARD to its
   *  window and kills every pane in it (the wanted semantics for one-pane
   *  managed windows; a stable `%N` target cannot be redirected by concurrent
   *  rename automation). Killing the last window kills the session, which the
   *  next dispatch re-mints via get-or-create. A nonzero "can't find window" is
   *  the expected TOCTOU no-op (the window already closed) returned as
   *  `{ ok: false }` without noise. NEVER throws. */
  killWindow(paneId: string): Promise<LaunchResult>;
}

/**
 * Upper bound on a single `runCapture` tmux-subprocess await. On expiry the
 * child is force-killed and the op degrades to `null`, keeping a wedged tmux
 * server from freezing the reconciler forever (no fatalExit covers that path).
 * Unit: MILLISECONDS — never compared against the unit-seconds autopilot
 * cooldowns.
 */
const RUN_CAPTURE_TIMEOUT_MS = 5000;

/** Backend selected when `exec_backend` is absent; the one source of truth for
 *  the lockstep `db.ts` site and tests. */
export const DEFAULT_EXEC_BACKEND = "tmux" as const;

/** The single managed-session name keeper dispatches autopilot workers into.
 *  Hardcoded — not configurable. */
export const MANAGED_EXEC_SESSION = "autopilot" as const;

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
 * that warn (`"tmux"` / `"agentwrap"`). Factored to module scope so the
 * agentwrap backend reuses the EXACT same bounded-capture semantics the tmux
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
   * `TMUX`/`TMUX_PANE` env has been stripped (agentwrap deletes them so Claude
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
    // agentwrap writes in ~/code/agentwrap/src/main.ts. There is no shared
    // module across the two repos; matching comments on both sides are the
    // agreed drift guard. agentwrap copies `$TMUX_PANE` here before deleting
    // `TMUX`/`TMUX_PANE` (so Claude emits truecolor), and the hook's fallback
    // arm reads it to keep stamping the pane id for window renaming.
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
 * Build the tmux `new-window` launch argv. Pure — exported for tests. Dispatched
 * windows inherit the global `remain-on-exit off`, so a window closes natively
 * once its whole process tree exits — exactly like a hand-created pane. The
 * hosted `claude` exiting does NOT close the window: the launch wrapper's
 * trailing `exec $SHELL -l -i` login shell keeps the pane occupied, which both
 * leaves a usable shell for inspection and keeps the pane LISTED so
 * `classifyCloseKind`'s `list-panes` probe still reads `pid_died`.
 *
 * Targets `=<session>:` (the `=` prefix forces an EXACT session match — tmux
 * otherwise does an fnmatch glob + prefix match, so `back` would land in
 * `background`; the trailing colon = the session's window list) so the new
 * window lands in exactly the named session. `-c <cwd>` sets the working dir; the
 * `-e KEEPER_TMUX_SESSION=<session>` injection re-stamps the session name on the
 * new window's pane env (a window does NOT inherit the session-mint `-e`).
 * `-P -F '#{pane_id}'` prints the new pane's id to stdout — the durable handle
 * for every later targeted op. `argv` is passed after `--` so tmux execs it
 * directly with no shell layer.
 *
 * `name`, when non-empty, labels the window via `-n` (the restore caller's seam
 * — managed `launch` always passes empty so windows stay unnamed). Window names
 * never carry `.`/`:` — colons break target parsing.
 */
export function buildTmuxNewWindowArgs(
  session: string,
  cwd: string,
  argv: string[],
  name?: string,
): string[] {
  return [
    "tmux",
    "new-window",
    "-t",
    `=${session}:`,
    "-c",
    cwd,
    "-e",
    `KEEPER_TMUX_SESSION=${session}`,
    ...(name != null && name !== "" ? ["-n", name] : []),
    "-P",
    "-F",
    "#{pane_id}",
    "--",
    ...argv,
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
 * Build the tmux `display-message -p '#{pid}'` server-pid probe argv. Pure —
 * exported for tests. The tmux SERVER pid is the backend's "generation" handle:
 * it changes exactly when the server is killed and respawned (the boundary
 * crash-restore scopes to), and is stable across client attach/detach. `-p`
 * prints to stdout; no `-t` so it resolves against the default server. The
 * restore-worker pulse runs this via its injected sync `spawnSync`, parses the
 * single positive-int line, and hashes it into the `BackendExecStart`
 * generation id. Backend-agnostic seam: the only tmux-specific piece is this
 * argv; the pulse pairs the result with `DEFAULT_EXEC_BACKEND`.
 */
export function buildTmuxServerPidArgs(): string[] {
  return ["tmux", "display-message", "-p", "#{pid}"];
}

/**
 * Build the tmux `list-panes -a -F '#{pane_id}\t#{window_id}\t#{window_name}'`
 * sweep argv. Pure — exported for tests. `-a` spans every session on the
 * server. The format is TAB-delimited with `window_name` LAST so the renamer's
 * 2-split parse keeps a tab inside an arbitrary window name from corrupting the
 * pane/window fields (names are free user text — tabs, colons, unicode all
 * survive).
 */
export function buildTmuxListPanesArgs(): string[] {
  return [
    "tmux",
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{window_id}\t#{window_name}",
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
  // The pane id is the FIRST tab-delimited field of each `list-panes -a` line.
  // Match it exactly against the leading field — a substring scan would let a
  // window name containing the literal pane text spoof presence.
  for (const line of out.split("\n")) {
    if (line === "") {
      continue;
    }
    const firstTab = line.indexOf("\t");
    const candidate = firstTab < 0 ? line : line.slice(0, firstTab);
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

/** Resolver-filled dep bag for the tmux backend. `session` is the managed
 *  session for `launch`; it defaults to `MANAGED_EXEC_SESSION` so a consumer
 *  touching only the session-agnostic ops can construct with just `{ noteLine }`.
 *  `spawn` is injectable for tests. */
export interface TmuxBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session?: string;
  readonly spawn?: SpawnFn;
  /** Override the `runCapture` kill-timeout; tests shrink it to pin the
   *  timeout-kill-degrade path without a real 5s wait. */
  readonly captureTimeoutMs?: number;
}

/** Resolver dep bag: `backendType` is the per-row/config backend tag, and the
 *  resolver fills `MANAGED_EXEC_SESSION` for an absent `session`. Every tag
 *  resolves to the tmux backend — `tmux` is the sole backend. */
export interface ResolveExecBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session?: string;
  readonly spawn?: SpawnFn;
  /** Backend tag (typically a config value or a per-row `backend_exec_type`).
   *  Any value — including unknown, NULL, or legacy tags — resolves to tmux. */
  readonly backendType?: string;
  /** Absolute agentwrap binary path for the `agentwrap` backend (resolved by
   *  `resolveAgentwrapPath()`). Plumbed in by the wiring layer; consumed by the
   *  agentwrap backend factory. Ignored when `backendType` resolves to tmux. */
  readonly agentwrapPath?: string;
}

/**
 * tmux backend factory. Each op runs a per-call get-or-create (`has-session`
 * probe → `new-session` mint when absent) then a chained `new-window`; there is
 * NO session-ensure memo — `has-session` is cheap and avoids a stale-memo wedge
 * after a session dies. NEVER throws — every failure mode degrades to a
 * `noteLine` warn + an `{ ok: false }` (or a best-effort focus no-op).
 */
export function createTmuxBackend(deps: TmuxBackendDeps): ExecBackend {
  const spawn = deps.spawn ?? defaultSpawn;
  const session = deps.session ?? MANAGED_EXEC_SESSION;
  const captureTimeoutMs = deps.captureTimeoutMs ?? RUN_CAPTURE_TIMEOUT_MS;

  const runCapture = makeRunCapture({
    spawn,
    captureTimeoutMs,
    noteLine: deps.noteLine,
    kind: "tmux",
  });

  /**
   * Per-call get-or-create for `targetSession`: a `has-session -t =<session>`
   * probe (exit 0 = live), and `new-session -d` mint when absent. The mint spawn
   * carries color-capable `TERM`/`COLORTERM` defaults plus a UTF-8 locale
   * default — keeperd runs as a LaunchAgent with env stripped, so a server
   * minted here would otherwise render every worker pane colorblind and treat
   * non-ASCII window names as unprintable. NEVER throws; a probe `null` (ENOENT)
   * skips the mint and the caller's `new-window` then fails loud with
   * `{ ok: false }`.
   */
  async function ensureSessionFor(targetSession: string): Promise<void> {
    const has = await runCapture(buildTmuxHasSessionArgs(targetSession));
    if (has != null && has.exitCode === 0) {
      // Already live — never re-mint.
      return;
    }
    if (has == null) {
      deps.noteLine(
        `# warn: tmux has-session failed (binary missing?); subsequent launches will no-op`,
      );
      return;
    }
    // Locale-defaulted alongside the color env: a server minted by a C-locale
    // client treats non-ASCII window names as unprintable server-wide.
    await runCapture(buildTmuxNewSessionArgs(targetSession), {
      env: {
        ...localeDefaultedEnv(
          process.env as Record<string, string | undefined>,
        ),
        TERM: process.env.TERM ?? "xterm-256color",
        COLORTERM: process.env.COLORTERM ?? "truecolor",
      },
    });
  }

  async function launchInto(
    targetSession: string,
    argv: string[],
    name: string,
    cwd: string,
    label: string,
  ): Promise<LaunchResult> {
    await ensureSessionFor(targetSession);
    const args = buildTmuxNewWindowArgs(targetSession, cwd, argv, name);
    const res = await runCapture(args);
    if (res == null) {
      const error = `tmux new-window for ${label} failed (ENOENT? binary missing)`;
      deps.noteLine(`# warn: ${error}`);
      return { ok: false, error };
    }
    if (res.stderr.length > 0) {
      deps.noteLine(`# launch stderr (${label}): ${res.stderr.trim()}`);
    }
    if (res.exitCode !== 0) {
      const error = `tmux new-window for ${label} exited non-zero (${res.exitCode})`;
      deps.noteLine(`# warn: ${error}`);
      return { ok: false, error };
    }
    return { ok: true };
  }

  return {
    launch(
      argv: string[],
      name: string,
      cwd: string,
      _spec?: LaunchSpec,
    ): Promise<LaunchResult> {
      // Managed window stays UNNAMED — `name` feeds the log label + autopilot
      // dedup key only, never the `-n` window label (the future naming system's
      // seam). Dispatches into the construction-baked managed session. `_spec`
      // is the agentwrap backend's structured-input seam — the tmux backend
      // ignores it and execs the pre-wrapped `argv` verbatim.
      return launchInto(session, argv, "", cwd, name);
    },
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
    ensureLaunched(
      targetSession: string,
      argv: string[],
      cwd: string,
      name?: string,
      _spec?: LaunchSpec,
    ): Promise<LaunchResult> {
      // Session-agnostic get-or-create + launch into the per-call session. The
      // restore caller passes `name` to label the window; managed dispatch never
      // reaches here. Empty/absent name leaves the window unnamed. `_spec` is
      // the agentwrap backend's structured-input seam — the tmux backend ignores
      // it and execs the pre-wrapped `argv`.
      return launchInto(
        targetSession,
        argv,
        name ?? "",
        cwd,
        `session=${targetSession}`,
      );
    },
    async listPanes(): Promise<PaneInfo[] | null> {
      // One server-wide sweep; `null` (degraded/missing tmux) tells the caller
      // to skip this cycle. Parse is tab-delimited with `window_name` LAST and
      // a 2-split limit so a tab inside an arbitrary window name cannot bleed
      // into the pane/window fields. Malformed lines are dropped silently — a
      // partial sweep is still a usable snapshot. The locale-defaulted env is
      // LOAD-BEARING: a C-locale client sanitizes the TAB delimiters to `_`,
      // which would drop every line and read as an empty sweep.
      const res = await runCapture(buildTmuxListPanesArgs(), {
        env: localeDefaultedEnv(
          process.env as Record<string, string | undefined>,
        ),
      });
      if (res == null || res.exitCode !== 0) {
        return null;
      }
      const panes: PaneInfo[] = [];
      for (const line of res.stdout.split("\n")) {
        if (line === "") {
          continue;
        }
        const firstTab = line.indexOf("\t");
        if (firstTab < 0) {
          continue;
        }
        const secondTab = line.indexOf("\t", firstTab + 1);
        if (secondTab < 0) {
          continue;
        }
        const paneId = line.slice(0, firstTab);
        const windowId = line.slice(firstTab + 1, secondTab);
        const windowName = line.slice(secondTab + 1);
        if (paneId === "" || windowId === "") {
          continue;
        }
        panes.push({ paneId, windowId, windowName });
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
      // no-op (the window already closed between the reaper's snapshot and the
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
// agentwrap backend
//
// Opt-in via `exec_backend: agentwrap`. keeper invokes the patched agentwrap
// CLI — which OWNS the tmux window (session-create + handoff) — instead of
// hand-rolling `tmux new-window`. Only the LAUNCH transport changes: the
// binding/lease/kill/list/rename/focus machinery is shared verbatim with the
// tmux backend (every later op targets the server-global tmux pane id the hook
// stamps, not anything agentwrap returns). agentwrap's one-line JSON + exit
// code are consumed ONLY to confirm the launch and classify retry.
//
// Cross-repo contract (NO shared module — matching comments are the drift
// guard, byte-pinned by a fixture in test/exec-backend.test.ts):
//   - CLI flags: `claude --agentwrap-tmux --agentwrap-tmux-detached
//     --agentwrap-tmux-session <s> --agentwrap-tmux-env KEEPER_TMUX_SESSION=<s>`.
//   - stdout: exactly one line of `schema_version:1` JSON (`session`/`windowId`/
//     `paneId` at top level). keeper DISCARDS `paneId` — binding is hook-based.
//   - exit codes (agentwrap `TMUX_EXIT`): 0=launched, 1=INTERNAL, 2=BAD_ARGS,
//     3=NOOP, 4=RETRYABLE.
// ===========================================================================

/** The agentwrap tmux-launch JSON schema keeper consumes. Bumping this on the
 *  agentwrap side without a keeper update lands a PERMANENT fail (loud), never a
 *  silent mismatch. */
export const AGENTWRAP_SCHEMA_VERSION = 1;

/**
 * agentwrap's `TMUX_EXIT` taxonomy (cross-repo contract — mirrors
 * `~/code/agentwrap/src/tmux-launch.ts`). Pinned here so the central exit map
 * reads off named constants, never bare magic numbers.
 *   - `INTERNAL`(1): agentwrap parse/logic failure — hard fail, never retry.
 *   - `BAD_ARGS`(2): malformed invocation — a keeper-built-bad-argv BUG, loud,
 *     never retry.
 *   - `NOOP`(3): a prereq the caller can't retry into (tmux missing, session
 *     gone) — PERMANENT, never retry.
 *   - `RETRYABLE`(4): transient (timeout / lock contention) — TRANSIENT, worth a
 *     bounded retry via the normal expire path.
 */
export const AGENTWRAP_TMUX_EXIT = {
  INTERNAL: 1,
  BAD_ARGS: 2,
  NOOP: 3,
  RETRYABLE: 4,
} as const;

/** Inputs to {@link buildAgentwrapLaunchArgv}. Structured (DB-free) so the argv
 *  is byte-pin testable. */
export interface AgentwrapLaunchOpts {
  /** Absolute agentwrap binary (resolved + `~`-expanded by `resolveAgentwrapPath`). */
  readonly agentwrapPath: string;
  /** Managed tmux session agentwrap mints/targets via `--agentwrap-tmux-session`. */
  readonly session: string;
  /** The initial interactive prompt — the FINAL positional argv element. */
  readonly prompt: string;
  /** `--name <claudeName>` (the reap/classify correlation key). Omitted when absent. */
  readonly claudeName?: string;
  /** `--model <m>`. Omitted when absent. */
  readonly model?: string;
  /** `--effort <e>`. Omitted when absent. */
  readonly effort?: string;
  /** Whether to pass `--agentwrap-no-confirm` (the cwd-confirm suppressor). */
  readonly noConfirm: boolean;
}

/**
 * Build the agentwrap launch argv — the unwrapped agentwrap invocation, NOT the
 * `[shell,-l,-i,-c,…]` wrapper the tmux backend execs. agentwrap owns the tmux
 * window, so keeper delegates session-create + handoff to it:
 *
 *   `<abs-agentwrap> claude --agentwrap-tmux --agentwrap-tmux-detached
 *     --agentwrap-tmux-session <session>
 *     --agentwrap-tmux-env KEEPER_TMUX_SESSION=<session>
 *     [--model <m>] [--effort <e>] [--agentwrap-no-confirm]
 *     [--name <claudeName>] <prompt>`
 *
 * `--agentwrap-tmux-env KEEPER_TMUX_SESSION=<session>` is the load-bearing
 * binding carrier: agentwrap injects it into the pane env via tmux `-e`, so the
 * SessionStart hook stamps the session name on the bound `jobs` row exactly as
 * the tmux backend's own `-e` does. The `--name` adjacency is load-bearing for
 * reap/classify parsing. Pure — exported for byte-pin tests.
 */
export function buildAgentwrapLaunchArgv(opts: AgentwrapLaunchOpts): string[] {
  const flags: string[] = [];
  if (opts.model !== undefined) {
    flags.push("--model", opts.model);
  }
  if (opts.effort !== undefined) {
    flags.push("--effort", opts.effort);
  }
  if (opts.noConfirm) {
    flags.push("--agentwrap-no-confirm");
  }
  if (opts.claudeName !== undefined) {
    flags.push("--name", opts.claudeName);
  }
  return [
    opts.agentwrapPath,
    "claude",
    "--agentwrap-tmux",
    "--agentwrap-tmux-detached",
    "--agentwrap-tmux-session",
    opts.session,
    "--agentwrap-tmux-env",
    `KEEPER_TMUX_SESSION=${opts.session}`,
    ...flags,
    opts.prompt,
  ];
}

/** Outcome of parsing agentwrap stdout (the JSON-shape verdict, separate from
 *  the exit-code verdict). `ok` confirms a `schema_version:1` line was found;
 *  the parsed `paneId` is DISCARDED by keeper (binding is hook-based) but
 *  returned for completeness / logging. */
export type AgentwrapParseResult = { ok: true } | { ok: false; error: string };

/**
 * Parse agentwrap's stdout DEFENSIVELY: scan LINE-BY-LINE (never `JSON.parse` a
 * raw multi-line chunk), take the first line that `JSON.parse`es to an object
 * carrying `schema_version`, and validate the version. agentwrap emits exactly
 * one JSON line, but the line scan tolerates a stray banner/log line ahead of
 * it. Every parse is wrapped in try/catch.
 *
 *   - a `schema_version === AGENTWRAP_SCHEMA_VERSION` object → `{ ok: true }`.
 *   - a JSON object with a DIFFERENT `schema_version` → PERMANENT fail (the
 *     cross-repo contract drifted; do not retry into a mismatch).
 *   - no parseable `schema_version` line (empty / non-JSON / malformed) →
 *     INTERNAL fail; the caller logs the raw bytes.
 *
 * Pure — exported for tests.
 */
export function parseAgentwrapStdout(stdout: string): AgentwrapParseResult {
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
    if (sv !== AGENTWRAP_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `agentwrap JSON schema_version ${JSON.stringify(sv)} != ${AGENTWRAP_SCHEMA_VERSION} (cross-repo contract drift)`,
      };
    }
    return { ok: true };
  }
  return {
    ok: false,
    error: sawObjectWithoutSchema
      ? "agentwrap JSON carried no schema_version field"
      : "agentwrap emitted no parseable schema_version JSON line",
  };
}

/**
 * The ONE central agentwrap exit-code → launch outcome map. Keeping it a single
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
export function mapAgentwrapExit(
  exitCode: number,
  parse: AgentwrapParseResult,
): LaunchResult {
  if (exitCode === 0) {
    if (parse.ok) {
      return { ok: true };
    }
    // Clean exit but unconfirmable launch — permanent (do not retry into a
    // contract we can't read).
    return { ok: false, error: `agentwrap launch unconfirmed: ${parse.error}` };
  }
  if (exitCode === AGENTWRAP_TMUX_EXIT.RETRYABLE) {
    return {
      ok: false,
      error: "agentwrap launch transient (exit 4 RETRYABLE)",
      retryable: true,
    };
  }
  if (exitCode === AGENTWRAP_TMUX_EXIT.NOOP) {
    return { ok: false, error: "agentwrap launch no-op (exit 3 NOOP)" };
  }
  if (exitCode === AGENTWRAP_TMUX_EXIT.INTERNAL) {
    return { ok: false, error: "agentwrap internal failure (exit 1 INTERNAL)" };
  }
  if (exitCode === AGENTWRAP_TMUX_EXIT.BAD_ARGS) {
    return {
      ok: false,
      error:
        "agentwrap bad argv (exit 2 BAD_ARGS — keeper built a bad invocation)",
    };
  }
  return { ok: false, error: `agentwrap launch failed (exit ${exitCode})` };
}

/** Resolver-filled dep bag for the agentwrap backend. Mirrors
 *  {@link TmuxBackendDeps} plus the absolute `agentwrapPath`. The
 *  `captureTimeoutMs` default is GENEROUS relative to tmux's: agentwrap does a
 *  session-create + claude handoff, so a 5s cap would spuriously timeout-kill a
 *  legitimately-slow launch. Tests shrink it to pin the timeout-kill path. */
export interface AgentwrapBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly agentwrapPath: string;
  readonly session?: string;
  readonly spawn?: SpawnFn;
  readonly captureTimeoutMs?: number;
}

/**
 * Upper bound on a single agentwrap-launch `runCapture` await. Larger than the
 * tmux 5s default because agentwrap mints the session AND hands off to claude in
 * the same invocation. On expiry the child is force-killed and the launch
 * degrades to a TRANSIENT fail (the normal expire path re-dispatches), never a
 * sticky one. Unit: MILLISECONDS.
 */
const AGENTWRAP_CAPTURE_TIMEOUT_MS = 30_000;

/**
 * agentwrap backend factory. `launch` builds the unwrapped agentwrap invocation
 * from the structured {@link LaunchSpec} (NOT the pre-wrapped `argv`), runs it
 * via the shared bounded `runCapture`, parses the one-line JSON defensively, and
 * maps the exit code through the central {@link mapAgentwrapExit}. Session-create
 * is DELEGATED to agentwrap (`--agentwrap-tmux-session`) — keeper runs NO
 * `ensureSessionFor` here (agentwrap mints with C.UTF-8 + TERM/COLORTERM,
 * landed in round 1).
 *
 * The dispatch transport (`launch`) AND the session-agnostic `ensureLaunched`
 * (with a spec) both route through agentwrap. Only the pure pane ops
 * (`focusPane`/`listPanes`/`renameWindow`/`killWindow`) are shared verbatim with
 * an internal tmux backend — they operate on server-global tmux pane ids that
 * agentwrap's window carries just like a keeper-minted one, so reimplementing
 * them would be pointless drift. NEVER throws.
 */
export function createAgentwrapBackend(
  deps: AgentwrapBackendDeps,
): ExecBackend {
  const spawn = deps.spawn ?? defaultSpawn;
  const session = deps.session ?? MANAGED_EXEC_SESSION;
  const captureTimeoutMs =
    deps.captureTimeoutMs ?? AGENTWRAP_CAPTURE_TIMEOUT_MS;
  const runCapture = makeRunCapture({
    spawn,
    captureTimeoutMs,
    noteLine: deps.noteLine,
    kind: "agentwrap",
  });
  // The pure pane ops run on tmux pane ids regardless of who minted the window —
  // delegate them verbatim to a tmux backend constructed with the SAME spawn +
  // session so `listPanes`/`killWindow`/`renameWindow`/`focusPane` behave
  // identically. `ensureLaunched` WITHOUT a spec (the restore replay of a
  // recorded shell-wrapped argv) also falls back to this tmux backend.
  const tmux = createTmuxBackend({
    noteLine: deps.noteLine,
    session,
    spawn,
  });

  /**
   * Shared agentwrap launch: build the unwrapped invocation from `spec`, run it
   * via the bounded `runCapture` (worker cwd on the spawn — agentwrap has no cwd
   * flag), parse the one-line JSON defensively, and map the exit code through
   * the central {@link mapAgentwrapExit}. Session-create is DELEGATED to
   * agentwrap. Drives BOTH `launch` (managed session) and `ensureLaunched`
   * (per-call session).
   */
  async function agentwrapLaunchInto(
    targetSession: string,
    cwd: string,
    label: string,
    spec: LaunchSpec,
  ): Promise<LaunchResult> {
    const launchArgv = buildAgentwrapLaunchArgv({
      agentwrapPath: deps.agentwrapPath,
      session: targetSession,
      prompt: spec.prompt,
      ...(spec.claudeName !== undefined ? { claudeName: spec.claudeName } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      noConfirm: true,
    });
    // agentwrap has no cwd flag — it reads its own `process.cwd()` for the
    // launch-script `cd`. keeperd's cwd is NOT the worker's target repo, so set
    // the worker cwd on the spawn (the agentwrap analogue of the tmux backend's
    // `new-window -c <cwd>`).
    const res = await runCapture(launchArgv, cwd !== "" ? { cwd } : undefined);
    if (res == null) {
      // ENOENT (bad/missing agentwrap path) OR a timeout-kill. A missing path
      // must fail LOUDLY (not silently): note it. Classify as TRANSIENT so a
      // wedged-but-recoverable launch (the timeout-kill case) re-dispatches; a
      // genuinely-missing binary keeps failing each cycle and surfaces in the
      // warn log, tripping the K=3 never-bound breaker after bounded retries.
      const error = `agentwrap launch for ${label} produced no result (bad path '${deps.agentwrapPath}'? or timeout-kill)`;
      deps.noteLine(`# warn: ${error}`);
      return { ok: false, error, retryable: true };
    }
    if (res.stderr.trim().length > 0) {
      deps.noteLine(`# launch stderr (${label}): ${res.stderr.trim()}`);
    }
    const parse = parseAgentwrapStdout(res.stdout);
    const outcome = mapAgentwrapExit(res.exitCode, parse);
    if (outcome.ok === false) {
      deps.noteLine(
        `# warn: ${outcome.error}${outcome.retryable === true ? " (transient)" : ""}; raw stdout: ${JSON.stringify(res.stdout)}`,
      );
    }
    return outcome;
  }

  return {
    launch(
      argv: string[],
      name: string,
      cwd: string,
      spec?: LaunchSpec,
    ): Promise<LaunchResult> {
      // The agentwrap path needs the UNWRAPPED structured inputs — the
      // pre-wrapped `[shell,-l,-i,-c,…]` `argv` is the tmux backend's shape and
      // is ignored here. A missing `spec` is a wiring bug (the call site must
      // thread it for this backend); fail loud rather than launch a malformed
      // invocation. Dispatches into the construction-baked managed session.
      void argv;
      if (spec === undefined) {
        const error = `agentwrap launch for ${name} missing structured spec (wiring bug)`;
        deps.noteLine(`# warn: ${error}`);
        return Promise.resolve({ ok: false, error });
      }
      return agentwrapLaunchInto(session, cwd, name, spec);
    },
    ensureLaunched(
      targetSession: string,
      argv: string[],
      cwd: string,
      name?: string,
      spec?: LaunchSpec,
    ): Promise<LaunchResult> {
      // WITH a spec (manual `keeper dispatch` under the agentwrap backend):
      // route through agentwrap into the per-call session. WITHOUT a spec (the
      // restore replay of a recorded shell-wrapped argv): fall back to the tmux
      // backend's `ensureLaunched`, which execs the recorded argv verbatim.
      if (spec === undefined) {
        return tmux.ensureLaunched(targetSession, argv, cwd, name);
      }
      void argv;
      return agentwrapLaunchInto(
        targetSession,
        cwd,
        `session=${targetSession}`,
        spec,
      );
    },
    focusPane: tmux.focusPane,
    listPanes: tmux.listPanes,
    renameWindow: tmux.renameWindow,
    killWindow: tmux.killWindow,
  };
}

/**
 * Resolve the exec backend from `backendType`. `agentwrap` selects the real
 * agentwrap backend (when an `agentwrapPath` is supplied); EVERY other tag —
 * `tmux`, unknown names, NULL, and legacy tags from historical job rows —
 * resolves to the tmux factory (the default + fallback) and NEVER throws on an
 * unrecognized tag. A thin seam so the reconciler call site and the jobs-board
 * focus path keep one stable entry point.
 */
export function resolveExecBackend(deps: ResolveExecBackendDeps): ExecBackend {
  const session = deps.session ?? MANAGED_EXEC_SESSION;
  if (deps.backendType === "agentwrap") {
    if (deps.agentwrapPath !== undefined && deps.agentwrapPath !== "") {
      return createAgentwrapBackend({
        noteLine: deps.noteLine,
        agentwrapPath: deps.agentwrapPath,
        session,
        spawn: deps.spawn,
      });
    }
    // `agentwrap` selected but no path resolved — fall back to tmux loudly
    // rather than construct an unlaunchable backend.
    deps.noteLine(
      "# warn: exec_backend=agentwrap but no agentwrap_path resolved; falling back to tmux",
    );
  }
  return createTmuxBackend({
    noteLine: deps.noteLine,
    session,
    spawn: deps.spawn,
  });
}
