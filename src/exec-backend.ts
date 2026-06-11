/**
 * `ExecBackend` — terminal-surface spawn port for the autopilot reconciler,
 * plus session-agnostic pane ops for the `keeper jobs` CLI and restore-agents
 * replay. A factory with no top-level side effects; tests inject a fake `spawn`
 * to assert argv without launching real processes.
 *
 * Two op categories share one factory + one set of zellij subprocess plumbing:
 *   - Session-bound lifecycle (`launch`) drives ONE managed session baked in at
 *     construction; session-ensure is memoized once and re-minted on a
 *     session-gone `new-tab`. Launch-window dedup is served by the durable
 *     `pending_dispatches` projection.
 *   - Session-agnostic (`focusPane`, `ensureLaunched`) take the target session
 *     per call. `focusPane` runs NO session-ensure; `ensureLaunched` runs its
 *     OWN per-call get-or-create sharing no memo with the managed path.
 *
 * The reconciler correlates a launch back to keeperd via the `--name verb::id`
 * baked into `argv` → SessionStart hook event → `jobs` projection, never via a
 * surface ref; zellij is stateless from autopilot's side.
 */

/** Bun.spawn-shaped subset the backend needs; injectable for tests. */
export type SpawnFn = (
  cmd: string[],
  options: {
    stdout: "pipe" | "ignore";
    stderr: "pipe" | "ignore";
    stdin: "ignore";
    /**
     * Set ONLY on the session-mint `attach -b` spawn so the zellij server —
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
   * kill-timeout — a wedged `zellij action` would otherwise freeze the
   * reconciler with no fatalExit covering it.
   */
  kill: (signal?: number) => void;
};

/** `ok: false` carries a short `error` the reconciler folds into a
 *  `DispatchFailed` event. */
export type LaunchResult = { ok: true } | { ok: false; error: string };

export interface ExecBackend {
  /** Session-bound. Spawn `argv` at `cwd` in a new unnamed tab in the managed
   *  session. The `name` arg is NOT forwarded to the tab label — it feeds the
   *  warn/log lines and is the autopilot dedup key only. */
  launch(argv: string[], name: string, cwd: string): Promise<LaunchResult>;
  /** Session-agnostic. Focus `paneId` in an already-live external `session`
   *  (zellij switches focused pane AND active tab in one shot). No
   *  session-ensure runs; a missing session → `{ ok: false }`. NEVER throws. */
  focusPane(session: string, paneId: string): Promise<LaunchResult>;
  /** Session-agnostic. Get-or-create `session` (mint via `attach -b --forget`
   *  + poll only when absent / EXITED — already-live sessions are NEVER
   *  `--forget`'d) and launch `argv` in a new tab. The tab is unnamed when
   *  `name` is empty / absent (the restore path). Shares NO memo with the
   *  managed `session` — per-call get-or-create + per-call session-gone single
   *  retry. NEVER throws. */
  ensureLaunched(
    session: string,
    argv: string[],
    cwd: string,
    name?: string,
  ): Promise<LaunchResult>;
}

/**
 * ANSI CSI matcher stripping color codes from zellij's text output. Built via
 * `new RegExp` so the source literal carries no control character (biome's
 * `noControlCharactersInRegex`).
 */
const ANSI_CSI_RE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
  "g",
);

/**
 * Upper bound on a single `runCapture` zellij-subprocess await. On expiry the
 * child is force-killed and the op degrades to `null`, keeping a wedged zellij
 * server from freezing the reconciler forever (no fatalExit covers that path).
 * Unit: MILLISECONDS — never compared against the unit-seconds autopilot
 * cooldowns.
 */
const RUN_CAPTURE_TIMEOUT_MS = 5000;

/** Backend selected when `exec_backend` is absent; the one source of truth for
 *  the lockstep `db.ts` site and tests. */
export const DEFAULT_EXEC_BACKEND = "zellij" as const;

/** The single managed-session name keeper dispatches autopilot workers into,
 *  shared by every backend. Hardcoded — not configurable. */
export const MANAGED_EXEC_SESSION = "autopilot" as const;

/**
 * `session` is the managed session for `launch`; it defaults to
 * `MANAGED_EXEC_SESSION` so a consumer touching only the session-agnostic
 * ops can construct with just `{ noteLine }`. `spawn` is injectable for tests.
 */
export interface ZellijBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session?: string;
  readonly spawn?: SpawnFn;
  /** Override the `runCapture` kill-timeout; tests shrink it to pin the
   *  timeout-kill-degrade path without a real 5s wait. */
  readonly captureTimeoutMs?: number;
}

/** Resolver dep bag: `backendType` selects the impl (`tmux` → tmux factory,
 *  anything else → zellij), and the resolver fills `MANAGED_EXEC_SESSION` for an
 *  absent `session`. */
export interface ResolveExecBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session?: string;
  readonly spawn?: SpawnFn;
  /** Backend tag (`'zellij'` default / `'tmux'`); typically a config value or a
   *  per-row `backend_exec_type`. Unknown values fall through to zellij. */
  readonly backendType?: string;
}

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
 * Build the zellij `action new-tab` argv. Pure — exported for tests.
 *
 * `argv` is passed after `--` so zellij execs it directly with no shell layer —
 * the OS argv boundary is the safe quoting seam. `dir` MUST be absolute —
 * zellij's `--cwd` does not expand `~`/`$HOME` (issue #2288). `name`, when
 * non-empty, labels the tab via `--name`; omitted otherwise so zellij assigns
 * its default `Tab #N`.
 */
export function buildZellijNewTabArgs(
  session: string,
  dir: string,
  argv: string[],
  name?: string,
): string[] {
  return [
    "zellij",
    "--session",
    session,
    "action",
    "new-tab",
    "--cwd",
    dir,
    ...(name != null && name !== "" ? ["--name", name] : []),
    "--",
    ...argv,
  ];
}

/** Build the zellij `action close-tab-by-id` argv. Pure — exported for tests. */
export function buildZellijCloseTabArgs(
  session: string,
  windowId: string,
): string[] {
  return [
    "zellij",
    "--session",
    session,
    "action",
    "close-tab-by-id",
    windowId,
  ];
}

/** Build the zellij `list-sessions` argv. Pure — exported for tests. */
export function buildZellijListSessionsArgs(): string[] {
  return ["zellij", "list-sessions"];
}

/** Build the zellij `action list-tabs` argv. Pure — exported for tests. */
export function buildZellijListTabsArgs(session: string): string[] {
  return ["zellij", "--session", session, "action", "list-tabs"];
}

/**
 * Parse `action list-tabs` output (header row `TAB_ID  POSITION  NAME` then one
 * data row per tab) and return the first tab's stable id. Returns `null` on
 * empty/unparsable output so the caller leaves the default tab rather than
 * closing the wrong id. ANSI-stripped.
 */
export function firstTabIdFromListTabs(text: string): string | null {
  for (const raw of text.split("\n")) {
    const trimmed = raw.replace(ANSI_CSI_RE, "").trim();
    if (trimmed.length === 0 || trimmed.startsWith("TAB_ID")) {
      continue;
    }
    const id = trimmed.split(/\s+/)[0];
    if (id != null && /^\d+$/.test(id)) {
      return id;
    }
  }
  return null;
}

/**
 * Build the zellij `action focus-pane-id <paneId>` argv. Pure — exported for
 * tests. `paneId` is the bare numeric id (lifted from `ZELLIJ_PANE_ID`); zellij
 * accepts it verbatim. On success zellij focuses the pane AND switches to its
 * tab in one shot.
 */
export function buildZellijFocusPaneArgs(
  session: string,
  paneId: string,
): string[] {
  return ["zellij", "--session", session, "action", "focus-pane-id", paneId];
}

/**
 * Single source of truth for the env-var NAMES the hook reads on every event,
 * keeping the hook backend-agnostic so a future tmux/wezterm backend slots in
 * without the hook learning new keys.
 */
export interface ExecBackendEnvMeta {
  readonly backendType: string;
  readonly sessionIdEnvVar: string;
  readonly paneIdEnvVar: string;
}

export function execBackendEnvMeta(backendType?: string): ExecBackendEnvMeta {
  const t = backendType ?? DEFAULT_EXEC_BACKEND;
  if (t === "tmux") {
    // tmux stamps `TMUX`/`TMUX_PANE` into every pane; managed launches add
    // `KEEPER_TMUX_SESSION` via `-e` so the session name rides the same column
    // as zellij's. Human-created sessions carry no `KEEPER_TMUX_SESSION`, so the
    // hook stamps a NULL session (filled later by the snapshot poller).
    return {
      backendType: t,
      sessionIdEnvVar: "KEEPER_TMUX_SESSION",
      paneIdEnvVar: "TMUX_PANE",
    };
  }
  // zellij (default) and any unknown backend fall through to the zellij env-var
  // defaults — an unknown name keeps its label for logging, but empty strings
  // would silently null out every hook event.
  return {
    backendType: t,
    sessionIdEnvVar: "ZELLIJ_SESSION_NAME",
    paneIdEnvVar: "ZELLIJ_PANE_ID",
  };
}

/**
 * Build the zellij `attach -b --forget <session>` argv. Pure — exported for
 * tests. `-b` creates a detached background session if absent; `--forget`
 * deletes any saved/serialized session first so a stale/EXITED corpse is
 * fresh-rebuilt rather than resurrected from a degraded `session-layout.kdl`
 * cache (which produced a bar-less mint). `ensureSession` short-circuits before
 * this when the target is already LIVE, so `--forget` never runs against a live
 * session. A poll loop follows in the runtime to beat the #3733 race (`action
 * new-tab` against a not-yet-ready server can no-op).
 */
export function buildZellijAttachBgArgs(session: string): string[] {
  return ["zellij", "attach", "-b", "--forget", session];
}

/**
 * Internal: does `list-sessions` output show `session` listed AND LIVE? The
 * bare name is the first whitespace token. A line carrying zellij's EXITED
 * marker is a CORPSE (`action new-tab` against it exits non-zero), treated as
 * NOT listed so `ensureSession` routes to `attach -b --forget` and mints fresh
 * rather than resurrecting the degraded `session-layout.kdl` cache.
 */
function zellijSessionListed(text: string, session: string): boolean {
  const lines = text.split("\n");
  for (const raw of lines) {
    const stripped = raw.replace(ANSI_CSI_RE, "");
    const trimmed = stripped.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const firstTok = trimmed.split(/\s+/)[0];
    if (firstTok === session && !/\bEXITED\b/.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/** Internal: ms-precision sleep used by the zellij session-ensure poll. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Internal: does this `new-tab` stderr mean the target session is gone? zellij
 * prints `Session '<name>' not found` when it vanished and `There is no active
 * session!` against an EXITED corpse — either means re-mint and retry; any
 * other non-zero exit is a real launch failure surfaced as-is.
 */
function looksLikeSessionGone(stderr: string): boolean {
  return /not found/i.test(stderr) || /no active session/i.test(stderr);
}

/**
 * Zellij backend factory. Lazily ensures the session ONCE (memoized
 * `Promise<void>` shared across every `launch`).
 *
 * #3733 mitigation: after `attach -b` returns the server is not necessarily
 * ready for actions — the first `new-tab` can no-op silently. Poll
 * `list-sessions` until `session` appears (~50ms, ~5s cap) before the first
 * `new-tab`.
 */
export function createZellijBackend(deps: ZellijBackendDeps): ExecBackend {
  const spawn = deps.spawn ?? defaultSpawn;
  const session = deps.session ?? MANAGED_EXEC_SESSION;
  const captureTimeoutMs = deps.captureTimeoutMs ?? RUN_CAPTURE_TIMEOUT_MS;
  let sessionReady: Promise<void> | null = null;

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
      // Bound the await: a wedged `zellij action` would otherwise freeze
      // `proc.exited` — and the reconciler — forever with no fatalExit. Race
      // against a kill-timeout; on expiry force-kill the child and degrade to
      // `null` (the envelope ENOENT already returns), and the op retries next
      // cycle.
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
          `# warn: zellij subprocess exceeded ${captureTimeoutMs}ms; killed and degrading to null (${args.join(" ")})`,
        );
        return null;
      }
      const [stdout, stderr] = await Promise.all([
        streamToText(proc.stdout),
        streamToText(proc.stderr),
      ]);
      return { exitCode: race, stdout, stderr };
    } catch {
      // ENOENT (zellij not installed) lands here.
      return null;
    }
  }

  /**
   * Session-parameterized get-or-create, shared between the managed
   * `ensureSession` memo and the per-call `ensureLaunched` path: list-sessions
   * probe → `attach -b --forget` mint when absent/EXITED → poll. A freshly-
   * minted session KEEPS its empty default `Tab #1` as a permanent keepalive
   * ANCHOR — never reaped — so the completion-reap (which only matches
   * dispatch-key panes) can never empty the session to zero tabs and collapse
   * it into a re-mint loop. NEVER throws — every failure mode degrades to a
   * noteLine warn and the caller proceeds with the new-tab spawn.
   */
  async function ensureSessionFor(targetSession: string): Promise<void> {
    const listed = await runCapture(buildZellijListSessionsArgs());
    if (listed == null) {
      deps.noteLine(
        `# warn: zellij list-sessions failed (binary missing?); subsequent launches will no-op`,
      );
      return;
    }
    if (zellijSessionListed(listed.stdout, targetSession)) {
      // Pre-existing live session — never `--forget` it; nothing minted.
      return;
    }
    // Not listed (absent OR EXITED corpse) — `attach -b --forget` to mint a
    // fresh detached session, then poll until it appears. The zellij server
    // inherits THIS spawn's env, and every pane it later launches inherits the
    // server's; keeperd runs as a LaunchAgent with env stripped to `PATH`, so a
    // session minted here would render every worker pane colorblind. Carry
    // color-capable defaults (preserving a real terminal's values when one
    // exists). Spread `process.env` first to keep `PATH` et al.
    await runCapture(buildZellijAttachBgArgs(targetSession), {
      ...(process.env as Record<string, string>),
      TERM: process.env.TERM ?? "xterm-256color",
      COLORTERM: process.env.COLORTERM ?? "truecolor",
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const probe = await runCapture(buildZellijListSessionsArgs());
      if (probe != null && zellijSessionListed(probe.stdout, targetSession)) {
        // Freshly minted and live. zellij's empty default `Tab #1` is KEPT as
        // the keepalive anchor — see above.
        return;
      }
      await delay(50);
    }
    deps.noteLine(
      `# warn: zellij session "${targetSession}" never appeared in list-sessions after 5s; new-tab may no-op`,
    );
    return;
  }

  function ensureSession(): Promise<void> {
    if (sessionReady != null) {
      return sessionReady;
    }
    sessionReady = ensureSessionFor(session);
    return sessionReady;
  }

  return {
    async launch(
      argv: string[],
      name: string,
      cwd: string,
    ): Promise<LaunchResult> {
      await ensureSession();
      const args = buildZellijNewTabArgs(session, cwd, argv);
      let res = await runCapture(args);
      // The memoized session can die out from under us (last tab closed,
      // reboot, kill); a stale `sessionReady` memo would then wedge EVERY
      // future dispatch until restart. On a session-gone new-tab failure,
      // invalidate the memo, re-ensure, and retry exactly once. The success
      // path keeps the memo untouched.
      if (
        res != null &&
        res.exitCode !== 0 &&
        looksLikeSessionGone(res.stderr)
      ) {
        deps.noteLine(
          `# warn: zellij session "${session}" vanished; re-minting and retrying new-tab for ${name}`,
        );
        sessionReady = null;
        await ensureSession();
        res = await runCapture(args);
      }
      if (res == null) {
        const error = `zellij new-tab for ${name} failed (ENOENT? binary missing)`;
        deps.noteLine(`# warn: ${error}`);
        return { ok: false, error };
      }
      if (res.stderr.length > 0) {
        deps.noteLine(`# launch stderr (${name}): ${res.stderr.trim()}`);
      }
      if (res.exitCode !== 0) {
        const error = `zellij new-tab for ${name} exited non-zero (${res.exitCode})`;
        deps.noteLine(`# warn: ${error}`);
        return { ok: false, error };
      }
      return { ok: true };
    },
    async focusPane(
      targetSession: string,
      paneId: string,
    ): Promise<LaunchResult> {
      // Session-agnostic, no `ensureSession`: a missing session degrades to a
      // non-zero exit → `{ ok: false }` rather than minting one we'd never use.
      const args = buildZellijFocusPaneArgs(targetSession, paneId);
      const res = await runCapture(args);
      if (res == null) {
        const error = `zellij focus-pane-id for session=${targetSession} pane=${paneId} failed (ENOENT? binary missing)`;
        return { ok: false, error };
      }
      if (res.exitCode !== 0) {
        const stderrTrim = res.stderr.trim();
        const detail = stderrTrim.length > 0 ? `: ${stderrTrim}` : "";
        const error = `zellij focus-pane-id for session=${targetSession} pane=${paneId} exited ${res.exitCode}${detail}`;
        return { ok: false, error };
      }
      return { ok: true };
    },
    async ensureLaunched(
      targetSession: string,
      argv: string[],
      cwd: string,
      name?: string,
    ): Promise<LaunchResult> {
      // Session-agnostic get-or-create + launch, mirroring `launch`'s shape but
      // parameterized by `targetSession` with no `sessionReady` memo.
      await ensureSessionFor(targetSession);
      const args = buildZellijNewTabArgs(targetSession, cwd, argv, name);
      let res = await runCapture(args);
      // Session can die between ensure and new-tab; one-shot re-ensure + retry
      // on the matching stderr signatures. Any other non-zero exit is a real
      // launch failure surfaced as-is.
      if (
        res != null &&
        res.exitCode !== 0 &&
        looksLikeSessionGone(res.stderr)
      ) {
        deps.noteLine(
          `# warn: zellij session "${targetSession}" vanished mid-ensureLaunched; re-minting and retrying new-tab`,
        );
        await ensureSessionFor(targetSession);
        res = await runCapture(args);
      }
      if (res == null) {
        const error = `zellij new-tab into session "${targetSession}" failed (ENOENT? binary missing)`;
        deps.noteLine(`# warn: ${error}`);
        return { ok: false, error };
      }
      if (res.stderr.length > 0) {
        deps.noteLine(
          `# ensureLaunched stderr (session=${targetSession}): ${res.stderr.trim()}`,
        );
      }
      if (res.exitCode !== 0) {
        const error = `zellij new-tab into session "${targetSession}" exited non-zero (${res.exitCode})`;
        deps.noteLine(`# warn: ${error}`);
        return { ok: false, error };
      }
      return { ok: true };
    },
  };
}

// ===========================================================================
// tmux backend
//
// Mirrors the zellij factory shape — standalone pure argv builders + injectable
// `spawn`, reusing `runCapture`/`SpawnFn`/`LaunchResult`/`streamToText`. The
// design carries parity with zellij's three coords (type/session/pane) and
// nothing more: NO control-mode client, NO new worker.
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

/** Resolver-filled dep bag for the tmux backend; same shape as
 *  {@link ZellijBackendDeps} so the two factories are drop-in interchangeable
 *  behind {@link resolveExecBackend}. */
export interface TmuxBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session?: string;
  readonly spawn?: SpawnFn;
  readonly captureTimeoutMs?: number;
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
      // `null` (mirrors the zellij runCapture).
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
   * carries color-capable `TERM`/`COLORTERM` defaults like the zellij mint —
   * keeperd runs as a LaunchAgent with env stripped, so a server minted here
   * would otherwise render every worker pane colorblind. NEVER throws; a probe
   * `null` (ENOENT) skips the mint and the caller's `new-window` then fails
   * loud with `{ ok: false }`.
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

/** Resolve the exec backend by type — `tmux` selects the tmux factory, every
 *  other value (including the `zellij` default and unknown names) the zellij
 *  factory. A thin seam so the reconciler call site and the jobs-board focus
 *  path keep one stable entry point across backends. */
export function resolveExecBackend(deps: ResolveExecBackendDeps): ExecBackend {
  if (deps.backendType === "tmux") {
    return createTmuxBackend({
      noteLine: deps.noteLine,
      session: deps.session ?? MANAGED_EXEC_SESSION,
      spawn: deps.spawn,
    });
  }
  return createZellijBackend({
    noteLine: deps.noteLine,
    session: deps.session ?? MANAGED_EXEC_SESSION,
    spawn: deps.spawn,
  });
}
