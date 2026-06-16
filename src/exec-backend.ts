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

/** `ok: false` carries a short `error` the reconciler folds into a
 *  `DispatchFailed` event. */
export type LaunchResult = { ok: true } | { ok: false; error: string };

/** One row of a `list-panes -a` sweep: the server-global pane id, its window
 *  id (`@N`), and the window's current name. The renamer worker keys windows by
 *  `windowId` and compares `windowName` to decide whether a rename is owed. */
export interface PaneInfo {
  readonly paneId: string;
  readonly windowId: string;
  readonly windowName: string;
}

export interface ExecBackend {
  /** Session-bound. Spawn `argv` at `cwd` in a new unnamed window in the managed
   *  session. The `name` arg is NOT forwarded to the window label — it feeds the
   *  warn/log lines and is the autopilot dedup key only. */
  launch(argv: string[], name: string, cwd: string): Promise<LaunchResult>;
  /** Session-agnostic. Focus `paneId` in an already-live external `session`
   *  (brings its window forward, then focuses the pane). No session-ensure runs;
   *  a missing session/pane → `{ ok: false }`. NEVER throws. */
  focusPane(session: string, paneId: string): Promise<LaunchResult>;
  /** Session-agnostic. Get-or-create `session` (mint via `new-session -d` only
   *  when absent) and launch `argv` in a new window. The window is unnamed when
   *  `name` is empty / absent (the restore path). Per-call get-or-create.
   *  NEVER throws. */
  ensureLaunched(
    session: string,
    argv: string[],
    cwd: string,
    name?: string,
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
   * `TMUX`/`TMUX_PANE` env has been stripped (claudewrap deletes them so Claude
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
    // claudewrap writes in ~/code/claudewrap/src/main.ts. There is no shared
    // module across the two repos; matching comments on both sides are the
    // agreed drift guard. claudewrap copies `$TMUX_PANE` here before deleting
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
// Accepted residual race: a worker that exits BEFORE the chained
// `set-option -p remain-on-exit on` lands loses its dead pane (the window
// auto-closes). Sub-ms window, no mitigation — the `-P -F '#{pane_id}'` return
// exists as the fallback hook if the chained form ever misbehaves.
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
 * Build the tmux `new-window` launch argv, chaining `set-option -p
 * remain-on-exit on` in ONE invocation via the literal `;` command-separator
 * argv element (verified on 3.6b: the dead pane persists with `pane_dead=1` +
 * `pane_dead_status`). Pure — exported for tests.
 *
 * Targets `<session>:` (trailing colon = the session's window list) so the new
 * window lands in the managed session. `-c <cwd>` sets the working dir; the
 * `-e KEEPER_TMUX_SESSION=<session>` injection re-stamps the session name on the
 * new window's pane env (a window does NOT inherit the session-mint `-e`).
 * `-P -F '#{pane_id}'` prints the new pane's id to stdout — the durable handle
 * AND the fallback seam if the chained set-option ever needs a targeted retry.
 * `argv` is passed after `--` so tmux execs it directly with no shell layer.
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
    `${session}:`,
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
    ";",
    "set-option",
    "-p",
    "remain-on-exit",
    "on",
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
 *   - `pid_died` — server alive, the job's pane is still listed but its process
 *     is dead (`remain-on-exit` left a dead pane). Restore.
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
      // Pane still listed (dead pane held by remain-on-exit) → pid_died.
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
 * concurrent renamer worker, and colons in names break name-based targets. The
 * window's `remain-on-exit on` does not block the kill.
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

  async function runCapture(
    args: string[],
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
    try {
      const proc = spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        ...(env != null ? { env } : {}),
      });
      // Bound the await: a wedged `tmux` subprocess would otherwise freeze
      // `proc.exited` — and the reconciler — forever with no fatalExit. Race
      // against a kill-timeout; on expiry force-kill the child and degrade to
      // `null` (the op retries next cycle).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("timed-out");
      const timeout = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), captureTimeoutMs);
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
          `# warn: tmux subprocess exceeded ${captureTimeoutMs}ms; killed and degrading to null (${args.join(" ")})`,
        );
        return null;
      }
      const [stdout, stderr] = await Promise.all([
        streamToText(proc.stdout),
        streamToText(proc.stderr),
      ]);
      return { exitCode: race, stdout, stderr };
    } catch {
      // ENOENT (tmux not installed) lands here.
      return null;
    }
  }

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
      ...localeDefaultedEnv(process.env as Record<string, string | undefined>),
      TERM: process.env.TERM ?? "xterm-256color",
      COLORTERM: process.env.COLORTERM ?? "truecolor",
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
    launch(argv: string[], name: string, cwd: string): Promise<LaunchResult> {
      // Managed window stays UNNAMED — `name` feeds the log label + autopilot
      // dedup key only, never the `-n` window label (the future naming system's
      // seam). Dispatches into the construction-baked managed session.
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
    ): Promise<LaunchResult> {
      // Session-agnostic get-or-create + launch into the per-call session. The
      // restore caller passes `name` to label the window; managed dispatch never
      // reaches here. Empty/absent name leaves the window unnamed.
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
      const res = await runCapture(
        buildTmuxListPanesArgs(),
        localeDefaultedEnv(process.env as Record<string, string | undefined>),
      );
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

/** Resolve the exec backend. tmux is the sole backend, so every `backendType`
 *  — `tmux`, unknown names, NULL, and legacy tags from historical job rows —
 *  resolves to the tmux factory; it NEVER throws on an unrecognized tag. A thin
 *  seam so the reconciler call site and the jobs-board focus path keep one
 *  stable entry point. */
export function resolveExecBackend(deps: ResolveExecBackendDeps): ExecBackend {
  return createTmuxBackend({
    noteLine: deps.noteLine,
    session: deps.session ?? MANAGED_EXEC_SESSION,
    spawn: deps.spawn,
  });
}
