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
// windows stay UNNAMED — the unused `name` arg on `launch` is the seam for the
// future window-naming system.
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
   * carries color-capable `TERM`/`COLORTERM` defaults — keeperd runs as a
   * LaunchAgent with env stripped, so a server minted here would otherwise
   * render every worker pane colorblind. NEVER throws; a probe `null` (ENOENT)
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
    await runCapture(buildTmuxNewSessionArgs(targetSession), {
      ...(process.env as Record<string, string>),
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
