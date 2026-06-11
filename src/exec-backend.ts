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
  /**
   * Session-bound. `close-pane -p` each pane the `predicate` selects. Drives
   * the pause/boot-pause reap so a pre-pause dispatch intent (zellij execs the
   * new tab seconds-to-minutes late) cannot escape the pause as a ghost worker.
   *
   * The `predicate` is the caller's safety gate — it MUST intersect an OPEN
   * `pending_dispatches` row, NEVER name-alone (a discharged row = a live
   * worker that must never be reaped; list-panes lags zellij reality). NEVER
   * throws: a null/unparseable snapshot no-ops (`skippedNoSnapshot`); a
   * per-pane close failure logs + continues.
   */
  reapSurfaces(predicate: (pane: ZellijPane) => boolean): Promise<ReapResult>;
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

/** Zellij is the only backend; exported as the one source of truth for the
 *  lockstep `db.ts` site and tests. */
export const DEFAULT_EXEC_BACKEND = "zellij" as const;

/** Default session when `zellij_session` is absent or non-string. */
export const DEFAULT_ZELLIJ_SESSION = "autopilot" as const;

/**
 * `session` is the managed session for `launch`; it defaults to
 * `DEFAULT_ZELLIJ_SESSION` so a consumer touching only the session-agnostic
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

/** Zellij dep bag minus the required `session` (the resolver fills in
 *  `DEFAULT_ZELLIJ_SESSION` when absent). */
export interface ResolveExecBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session?: string;
  readonly spawn?: SpawnFn;
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

/**
 * Build the zellij `action close-pane -p <paneId>` argv. Pure — exported for
 * tests. Pane-scoped (not tab-scoped): zellij auto-closes a tab only when it
 * has zero selectable tiled panes left; the reconciler dedup invariant
 * guarantees one agent pane per tab, so the close always lands the tab too.
 */
export function buildZellijClosePaneArgs(
  session: string,
  paneId: string,
): string[] {
  return ["zellij", "--session", session, "action", "close-pane", "-p", paneId];
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
 * Build the zellij `action list-panes -a -j` argv. Pure — exported for tests.
 * `-a` is all panes across all tabs (the default is the active tab only); `-j`
 * is JSON output.
 */
export function buildZellijListPanesAllJsonArgs(session: string): string[] {
  return ["zellij", "--session", session, "action", "list-panes", "-a", "-j"];
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
 * Pane record parsed from `list-panes -a -j` output — the subset
 * `findPaneById` reads out of zellij's wider (~30-field) schema. `id` is the
 * filter key (the env-stamped `ZELLIJ_PANE_ID`); the `tab_*` triple is lifted
 * onto the jobs row.
 */
export interface ZellijPane {
  readonly id: string;
  readonly tab_name: string;
  readonly tab_id?: number;
  readonly tab_position?: number;
  readonly terminal_command?: string | null;
  readonly exited?: boolean;
}

/** Result envelope shared by `list-panes -a -j` finders. Pure — exported for
 *  tests + the `findPaneById` consumer. */
export type FindPaneResult =
  | { found: "single"; pane: ZellijPane }
  | { found: "none" }
  | { found: "multiple"; count: number };

/**
 * Parse the JSON stdout of `list-panes -a -j`. Returns `null` on
 * empty/unparseable input — the caller no-ops the close rather than guessing.
 */
export function parseListPanesJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
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
  if (t === "zellij") {
    return {
      backendType: t,
      sessionIdEnvVar: "ZELLIJ_SESSION_NAME",
      paneIdEnvVar: "ZELLIJ_PANE_ID",
    };
  }
  // Unknown backend: return its name verbatim for logging but fall back to the
  // zellij env-var defaults — empty strings would silently null out every hook
  // event.
  return {
    backendType: t,
    sessionIdEnvVar: "ZELLIJ_SESSION_NAME",
    paneIdEnvVar: "ZELLIJ_PANE_ID",
  };
}

/**
 * Find a pane whose `id` matches `paneId` in a parsed `list-panes -a -j`
 * payload. Pure — exported for tests.
 *
 * Identity is load-bearing: zellij ships `id` as a bare number but the stored
 * value comes from `ZELLIJ_PANE_ID` (always a string), so both sides normalize
 * to string for the join. Skips `is_plugin` panes (their ids live in an
 * unrelated namespace and never appear in `ZELLIJ_PANE_ID`).
 */
export function findPaneById(payload: unknown, paneId: string): FindPaneResult {
  const target = String(paneId);
  const matches: ZellijPane[] = [];
  const collect = (raw: unknown, tabNameHint?: string): void => {
    if (raw == null || typeof raw !== "object") {
      return;
    }
    const rec = raw as Record<string, unknown>;
    if (rec.is_plugin === true) {
      return;
    }
    const idRaw = rec.id;
    const idStr =
      typeof idRaw === "string"
        ? idRaw
        : typeof idRaw === "number"
          ? String(idRaw)
          : null;
    if (idStr == null) {
      return;
    }
    if (idStr !== target) {
      return;
    }
    const tabNameField =
      typeof rec.tab_name === "string" ? rec.tab_name : undefined;
    const tab_name = tabNameField ?? tabNameHint ?? "";
    matches.push({
      // Preserve the raw (string-coerced) id — this finder is for env-pane-id
      // matching, not `close-pane -p`, so no `terminal_<n>` normalization.
      id: idStr,
      tab_name,
      tab_id: typeof rec.tab_id === "number" ? rec.tab_id : undefined,
      tab_position:
        typeof rec.tab_position === "number" ? rec.tab_position : undefined,
      terminal_command:
        typeof rec.terminal_command === "string"
          ? rec.terminal_command
          : rec.terminal_command === null
            ? null
            : undefined,
      exited: typeof rec.exited === "boolean" ? rec.exited : undefined,
    });
  };
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      collect(entry);
    }
  } else if (payload != null && typeof payload === "object") {
    for (const [key, value] of Object.entries(
      payload as Record<string, unknown>,
    )) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          collect(entry, key);
        }
      } else {
        collect(value, key);
      }
    }
  }
  if (matches.length === 0) {
    return { found: "none" };
  }
  if (matches.length > 1) {
    return { found: "multiple", count: matches.length };
  }
  const only = matches[0];
  if (only == null) {
    return { found: "none" };
  }
  return { found: "single", pane: only };
}

/**
 * Walk a parsed `list-panes -a -j` payload and return EVERY terminal pane
 * (plugin panes skipped). Pure — exported for tests + the `reapSurfaces` path.
 * Tolerates both the `[pane, …]` and legacy `{tab: [pane, …]}` shapes (lifting
 * the tab name from the key). The `id` is string-coerced but NOT
 * `terminal_`-prefixed — that's the close site's job (`closePaneIdForReap`).
 */
export function collectPanesFromListJson(payload: unknown): ZellijPane[] {
  const matches: ZellijPane[] = [];
  const collect = (raw: unknown, tabNameHint?: string): void => {
    if (raw == null || typeof raw !== "object") {
      return;
    }
    const rec = raw as Record<string, unknown>;
    if (rec.is_plugin === true) {
      return;
    }
    const idRaw = rec.id;
    const idStr =
      typeof idRaw === "string"
        ? idRaw
        : typeof idRaw === "number"
          ? String(idRaw)
          : null;
    if (idStr == null) {
      return;
    }
    const tabNameField =
      typeof rec.tab_name === "string" ? rec.tab_name : undefined;
    matches.push({
      id: idStr,
      tab_name: tabNameField ?? tabNameHint ?? "",
      tab_id: typeof rec.tab_id === "number" ? rec.tab_id : undefined,
      tab_position:
        typeof rec.tab_position === "number" ? rec.tab_position : undefined,
      terminal_command:
        typeof rec.terminal_command === "string"
          ? rec.terminal_command
          : rec.terminal_command === null
            ? null
            : undefined,
      exited: typeof rec.exited === "boolean" ? rec.exited : undefined,
    });
  };
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      collect(entry);
    }
  } else if (payload != null && typeof payload === "object") {
    for (const [key, value] of Object.entries(
      payload as Record<string, unknown>,
    )) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          collect(entry, key);
        }
      } else {
        collect(value, key);
      }
    }
  }
  return matches;
}

/**
 * Verb-prefixed dispatch-key matcher: `work::<id>` / `close::<id>` — the
 * `--name` the reconciler bakes into the worker argv and the autopilot dedup
 * key. The id run stops at the first whitespace / quote so the surrounding
 * shell argv peels cleanly.
 */
const DISPATCH_KEY_RE = /(work|close)::([^\s'"]+)/;

/**
 * Lift the `verb::id` dispatch key off a pane, or `null` when absent. Pure —
 * exported for tests. The tab is unnamed, so the key lives in
 * `terminal_command`; we scan `tab_name` FIRST (so a future named-tab path
 * still matches) then fall back to it. This is the reap CANDIDATE filter only
 * — the safety gate is the caller's open-`pending_dispatches` intersect, never
 * the name alone (list-panes lags zellij reality, so a name match on a live
 * worker MUST NOT authorize a close).
 */
export function dispatchKeyForPane(pane: ZellijPane): string | null {
  const fromTab = pane.tab_name.match(DISPATCH_KEY_RE);
  if (fromTab) {
    return `${fromTab[1]}::${fromTab[2]}`;
  }
  const cmd = pane.terminal_command;
  if (typeof cmd === "string") {
    const fromCmd = cmd.match(DISPATCH_KEY_RE);
    if (fromCmd) {
      return `${fromCmd[1]}::${fromCmd[2]}`;
    }
  }
  return null;
}

/**
 * Normalize a bare pane `id` (e.g. `"3"`) to the `close-pane -p` selector form
 * (`terminal_<n>`). Idempotent. Pure — exported for tests. `findPaneById` keeps
 * the bare form; the reap path is the one consumer needing the prefixed
 * selector.
 */
export function closePaneIdForReap(id: string): string {
  return /^terminal_/.test(id) ? id : `terminal_${id}`;
}

/**
 * Outcome envelope from {@link ExecBackend.reapSurfaces}. `reaped` / `failed`
 * partition the predicate-selected panes by close-pane exit.
 * `skippedNoSnapshot` is `true` when list-panes returned null/unparseable —
 * the whole reap no-ops rather than guessing. NEVER carries an error: every
 * failure mode degrades to a count + a `noteLine`.
 */
export interface ReapResult {
  readonly examined: number;
  readonly reaped: number;
  readonly failed: number;
  readonly skippedNoSnapshot: boolean;
}

/** Resolved tab coordinates for a known (session, paneId). Pure type exported
 *  for the `list-panes -a -j` finder tests. */
export interface ResolvedTabCoords {
  readonly tab_id: number | null;
  readonly tab_name: string;
  readonly tab_position: number | null;
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
  const session = deps.session ?? DEFAULT_ZELLIJ_SESSION;
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
    async reapSurfaces(
      predicate: (pane: ZellijPane) => boolean,
    ): Promise<ReapResult> {
      // No `ensureSession` — a reap against a gone session has nothing to
      // close; list-panes returns a null/non-zero capture → skippedNoSnapshot.
      const listed = await runCapture(buildZellijListPanesAllJsonArgs(session));
      if (listed == null || listed.exitCode !== 0) {
        return { examined: 0, reaped: 0, failed: 0, skippedNoSnapshot: true };
      }
      const parsed = parseListPanesJson(listed.stdout);
      if (parsed == null) {
        // Empty / unparseable — leave every pane alone (acting on a bad parse
        // could strand a live worker; list-panes lags zellij reality).
        return { examined: 0, reaped: 0, failed: 0, skippedNoSnapshot: true };
      }
      const panes = collectPanesFromListJson(parsed);
      let reaped = 0;
      let failed = 0;
      for (const pane of panes) {
        if (!predicate(pane)) {
          continue;
        }
        // One predicate-selected surface → one `close-pane -p`. Per-pane
        // failures log + continue so one stuck close never strands the rest —
        // best-effort cleanup, not a transaction.
        const closeId = closePaneIdForReap(pane.id);
        const res = await runCapture(
          buildZellijClosePaneArgs(session, closeId),
        );
        if (res == null || res.exitCode !== 0) {
          failed += 1;
          const detail =
            res == null
              ? "ENOENT? binary missing"
              : `exit ${res.exitCode}${res.stderr.trim().length > 0 ? `: ${res.stderr.trim()}` : ""}`;
          deps.noteLine(
            `# warn: reap close-pane ${closeId} (tab="${pane.tab_name}") failed (${detail})`,
          );
          continue;
        }
        reaped += 1;
        deps.noteLine(
          `# reap: closed pane ${closeId} (tab="${pane.tab_name}", exited=${pane.exited ?? "?"})`,
        );
      }
      return {
        examined: panes.length,
        reaped,
        failed,
        skippedNoSnapshot: false,
      };
    },
  };
}

/** Resolve the exec backend (always zellij). A thin seam so the reconciler call
 *  site and future backends keep one stable entry point. */
export function resolveExecBackend(deps: ResolveExecBackendDeps): ExecBackend {
  return createZellijBackend({
    noteLine: deps.noteLine,
    session: deps.session ?? DEFAULT_ZELLIJ_SESSION,
    spawn: deps.spawn,
  });
}
