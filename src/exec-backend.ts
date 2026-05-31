/**
 * `ExecBackend` — narrow interface for autopilot's terminal-surface
 * spawn/close mechanics. Autopilot is the sole consumer; the interface
 * exists as a single seam so the zellij `action new-tab` path stays
 * pluggable (and tests can inject a fake `spawn`).
 *
 * Why a factory (no top-level side effects). The module mirrors
 * `src/live-shell.ts`: import-clean, interface first, `Default*` consts,
 * `create*({deps})` factories. Production callers construct the backend
 * once in `cli/autopilot.ts`'s `main()`; tests inject a fake `spawn` so
 * argv construction is asserted without launching real processes.
 *
 * Public surface
 * --------------
 * - `ExecBackend` — `launch(argv, rowId, dir)` resolves to a stable
 *   PANE id (`terminal_<n>` for zellij, or `null` when nothing usable
 *   was captured); `close(windowId, tabName?)` is fire-and-forget and
 *   skips when `tabName` is no longer live (wrap-safety token guard
 *   for `zellij --server` restarts).
 * - `createZellijBackend({ noteLine, session, spawn? })` — lazy session-
 *   ensure (memoized once) + `action new-tab --cwd <abs> [--name <tab>]
 *   -- <argv>` + pane-id capture (newest `terminal_<n>` from `action
 *   list-panes`, resolved for the surgical close path); `action
 *   close-pane -p <paneId>` close, guarded by a name-exact `query-tab-
 *   names` token check on the launch-time tab name. When the ensure
 *   step MINTS the session (vs. attaching to a listed one), it captures
 *   the empty default `Tab #1` id and the first launch reaps it via
 *   `action close-tab-by-id` (the orphan reap deliberately closes a
 *   known-empty tab — both close builders coexist, only the agent-pane
 *   path moved to `close-pane`).
 * - `resolveExecBackend(deps)` — factory; always returns a zellij
 *   backend. Kept as a thin seam so call sites (cli/autopilot.ts) and
 *   tests do not need a structural rewrite.
 *
 * Fire-and-forget contract. The backend's `close` is true fire-and-
 * forget — it never throws back into the caller, and a stale or
 * unrecognized pane id no-ops (zellij `close-pane -p` against an
 * unknown id surfaces stderr via `noteLine` but never throws).
 *
 * Wrap-safety contract. Pane ids (`terminal_<n>`) are a process-global
 * monotonic counter inside a single `zellij --server` lifetime — never
 * reused — but RESET across server restarts. `dispatch.log` survives
 * restarts and rehydrates `windowId`s, so a recycled `terminal_N` from
 * the previous lifetime could reap a DIFFERENT live pane in the new
 * one. The `close` method guards against this by probing the launch-
 * time tab name via the same name-exact `query-tab-names` machinery
 * `isSurfaceLive` uses for the dispatch surface-live gate: a server
 * restart blows away the named tab too, so the probe returns false and
 * the close is skipped. Missing-token rows (pre-upgrade
 * `kind:"window"` entries without a `tabName` field, or with a bare-
 * numeric tab-id-shaped `windowId` from the old `close-tab-by-id`
 * regime) are skipped on shape — leaving the pane open is the safe
 * miss; reaping the wrong live pane is unrecoverable.
 *
 * ENOENT handling (zellij binary not installed): `launch` resolves
 * `null` and surfaces the missing-binary line via `noteLine`. The
 * dispatch already shipped to the dispatch log; autopilot's auto-close
 * just won't have an id to target.
 */

/**
 * Minimal spawn function alias — Bun.spawn-shaped subset autopilot needs.
 * Threaded through `deps.spawn` so tests can inject a fake that captures
 * the constructed argv without running a real process. Production
 * defaults to `Bun.spawn`.
 */
export type SpawnFn = (
  cmd: string[],
  options: {
    stdout: "pipe" | "ignore";
    stderr: "pipe" | "ignore";
    stdin: "ignore";
  },
) => {
  exited: Promise<number>;
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
};

/**
 * Backend interface — async `launch`, sync fire-and-forget `close`.
 *
 * `launch` returns the captured pane id as a string (for the zellij
 * backend: `terminal_<n>` — the just-spawned pane, NOT the tab id), or
 * `null` when nothing usable was parsed from the spawn's stdout / the
 * pane-id capture (the dispatch still ships; autopilot's auto-close
 * path no-ops on the missing id).
 *
 * `close` swallows all errors. A stale pane id from a previous server
 * lifetime is caught by the wrap-safety token guard — the launch-time
 * `tabName` is probed via `query-tab-names` first, and a mismatch
 * skips the close so a recycled `terminal_<n>` can't reap the wrong
 * live pane. Unknown ids that DO pass the token check (rare — would
 * require the tab to still exist but the pane id to have shifted)
 * no-op via zellij's `close-pane -p` stderr→noteLine path.
 */
/**
 * Optional surface labels for a launch. `tabName` names the zellij tab
 * (`new-tab --name`) — the close-time generation token probed via
 * `query-tab-names`.
 */
export interface LaunchOptions {
  readonly tabName?: string;
}

export interface ExecBackend {
  /** Spawn a terminal surface running argv at `dir`. Resolves to a
   *  stable id, or `null` when no id was captured. `opts` carries
   *  the optional zellij tab name (the close-time token).
   *
   *  Return value: the just-created pane id (`terminal_<n>` for the
   *  zellij backend) — NOT the tab id. The pane id is what `close`
   *  feeds to `close-pane -p` for a surgical reap that leaves any
   *  sibling tiled panes (e.g. a second pane the human added to the
   *  same tab) intact. Returns `null` when no terminal pane was
   *  resolved from `action list-panes` (parse failure / empty list /
   *  zellij ENOENT). The autopilot caller's `closeWindow` no-ops on
   *  `null` per the existing "no id → won't auto-close" contract. */
  launch(
    argv: string[],
    rowId: string,
    dir: string,
    opts?: LaunchOptions,
  ): Promise<string | null>;
  /** Reap a previously-launched surface by pane id. Fire-and-forget;
   *  never throws back. No-op on empty/undefined id.
   *
   *  `tabName` (when provided) is the generation-token guard: the
   *  backend probes `isSurfaceLive(tabName)` first and only fires the
   *  pane close when the named tab is still live. A mismatched server
   *  (the `zellij --server` restarted between launch and close — pane
   *  ids reset on restart and a recycled id could reap a DIFFERENT
   *  live pane) leaves no tab with the original `verb::id` name, so
   *  the probe returns false and the close is skipped. A missing
   *  `tabName` (pre-upgrade dispatch.log rows whose `kind:"window"`
   *  payload predates the `tabName` field) ALSO skips the close per
   *  the fail-safe direction — leaving the pane open is the safe
   *  miss (the human can close it manually); reaping the wrong pane
   *  is unrecoverable.
   *
   *  Additionally, `windowId` must match the post-launch pane-id
   *  shape (`terminal_<n>`); pre-upgrade rows carry a bare-numeric
   *  tab id from the previous `close-tab-by-id` regime and are
   *  silently skipped — feeding a tab id to `close-pane -p` is
   *  guaranteed to no-op AND leaves a parked tab, so we don't bother
   *  trying. */
  close(windowId: string, tabName?: string): void;
  /** True when a terminal surface labeled `name` is already live in the
   *  backend (zellij: a tab whose name === `name`). Drives autopilot's
   *  name-exact re-dispatch gate — UNLIKE the root-scoped, self-EXCLUDING
   *  `isLiveSessionInRoot`, this matches the exact `verb::id` INCLUDING
   *  the row's own surface, so an already-running identical row blocks its
   *  own re-dispatch even when `dispatch.log` did not survive a restart.
   *  FAIL-CLOSED: resolves `true` when liveness cannot be determined
   *  (query failed / binary missing / non-zero exit) so a probe error
   *  never opens the double-spawn hole — a suppressed dispatch self-heals
   *  on the next snapshot edge. */
  isSurfaceLive(name: string): Promise<boolean>;
}

/**
 * ANSI CSI sequence matcher used by `zellijSessionListed` to strip
 * color codes from `zellij list-sessions` output. Built via
 * `new RegExp` so the source literal does not contain a control
 * character (biome's `noControlCharactersInRegex` rule). The pattern
 * matches an ESC (0x1B) followed by `[`, a possibly-empty run of
 * digits and semicolons, and a trailing letter terminator.
 */
const ANSI_CSI_RE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`,
  "g",
);

/**
 * Default backend name. Zellij is the only backend; the literal is
 * retained as an exported const so the lockstep `db.ts` site and tests
 * have one source of truth.
 */
export const DEFAULT_EXEC_BACKEND = "zellij" as const;

/**
 * Default zellij session name when `zellij_session` is absent or
 * non-string. Matches the README + the epic-spec config example.
 */
export const DEFAULT_ZELLIJ_SESSION = "autopilot" as const;

/**
 * Zellij backend dependencies. `session` is the target session name;
 * `noteLine` is the lifecycle sidecar sink (autopilot's `noteLine`);
 * `spawn` defaults to `Bun.spawn` and is injectable for tests.
 */
export interface ZellijBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session: string;
  readonly spawn?: SpawnFn;
}

/**
 * Resolver dependencies. Matches the zellij dep bag minus the required
 * `session` (the resolver fills in `DEFAULT_ZELLIJ_SESSION` when absent).
 */
export interface ResolveExecBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session?: string;
  readonly spawn?: SpawnFn;
}

/**
 * Read a `ReadableStream` (Bun's spawn stdout/stderr shape) into a
 * string. Returns `""` on null/empty.
 */
async function streamToText(s: ReadableStream | null): Promise<string> {
  if (s == null) {
    return "";
  }
  return new Response(s).text();
}

/**
 * Default spawn — production's `Bun.spawn`. Kept behind a const so
 * tests can swap it without globals.
 */
const defaultSpawn: SpawnFn = (cmd, options) =>
  Bun.spawn(cmd, options) as ReturnType<SpawnFn>;

/**
 * Build the zellij `action new-tab` argv. Pure — exported for tests.
 *
 * `argv` is the worker command line as a discrete array (e.g.
 * `[shell, "-l", "-i", "-c", body]`); we pass it after `--` so zellij
 * execs it directly with no shell layer — the OS argv boundary is the
 * safe quoting seam (no injection surface). `dir` MUST be absolute —
 * zellij's `--cwd` does not expand `~`/`$HOME` (issue #2288).
 *
 * `name`, when non-empty, labels the new tab via `--name` (autopilot
 * passes the worker's `verb::id` spawn name so the tab bar mirrors the
 * `claude --name`). Omitted entirely when absent so zellij assigns its
 * default `Tab #N`.
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

/**
 * Build the zellij `action close-tab-by-id` argv. Pure — exported for
 * tests.
 *
 * Used ONLY for the fresh-mint orphan default-tab reap path inside
 * `ensureSession` — the launch site deliberately closes a known-empty
 * default `Tab #1` zellij creates when the session is first minted, so
 * there's no risk of nuking a shared tab. The agent-pane auto-close
 * path takes `buildZellijClosePaneArgs` below instead (surgical: a tab
 * carrying a sibling human-added pane survives).
 */
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
 * Build the zellij `action close-pane -p <paneId>` argv. Pure —
 * exported for tests. Drives the auto-close path: a pane-scoped close
 * leaves any sibling tiled panes intact (zellij auto-closes a tab only
 * when it has zero selectable tiled panes left, per
 * `zellij-server/src/screen.rs:2518-2523`). The shared-tab-survives
 * case is surgical by construction — no pre-close `list-panes` guard
 * needed.
 *
 * Coexists with `buildZellijCloseTabArgs` above: the orphan-default-tab
 * reap deliberately closes a known-empty tab and so keeps the tab-level
 * builder; the agent-pane reap takes this pane-level one.
 */
export function buildZellijClosePaneArgs(
  session: string,
  paneId: string,
): string[] {
  return ["zellij", "--session", session, "action", "close-pane", "-p", paneId];
}

/**
 * Build the zellij `list-sessions` argv. Pure — exported for tests.
 */
export function buildZellijListSessionsArgs(): string[] {
  return ["zellij", "list-sessions"];
}

/**
 * Build the zellij `action query-tab-names` argv. Pure — exported for
 * tests. Drives the name-exact live-surface gate: tabs are named with the
 * dispatch's `verb::id` (autopilot's `launchWindow` passes it as
 * `tabName`), so "is `work::fn-…` already live?" is an exact match over
 * this command's one-name-per-line output.
 */
export function buildZellijQueryTabNamesArgs(session: string): string[] {
  return ["zellij", "--session", session, "action", "query-tab-names"];
}

/**
 * Parse `action query-tab-names` output and decide whether a tab named
 * exactly `name` is live. zellij prints one tab name per line; we
 * ANSI-strip + trim each line (same colorblindness as
 * `zellijSessionListed`) and EXACT-match — not a substring match, so
 * `work::fn-6` never spuriously matches `work::fn-60`. Exported for tests.
 */
export function tabNameListed(text: string, name: string): boolean {
  for (const raw of text.split("\n")) {
    const trimmed = raw.replace(ANSI_CSI_RE, "").trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed === name) {
      return true;
    }
  }
  return false;
}

/**
 * Build the zellij `action list-tabs` argv. Pure — exported for tests.
 * Used once per freshly-minted session to capture the default tab's id
 * (the empty `Tab #1` zellij creates) so the first agent launch can
 * reap it — leaving a single named agent tab instead of an orphaned
 * default beside it.
 */
export function buildZellijListTabsArgs(session: string): string[] {
  return ["zellij", "--session", session, "action", "list-tabs"];
}

/**
 * Parse `action list-tabs` output and return the first tab's stable id.
 * The output is a header row (`TAB_ID  POSITION  NAME`) followed by one
 * whitespace-delimited data row per tab; we skip the header and peel the
 * first column off the first data row. Returns `null` on empty/unparsable
 * output so the caller degrades to "leave the default tab" rather than
 * closing the wrong id. ANSI-stripped for the same colorblindness as
 * `zellijSessionListed`.
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
 * Build the zellij `action list-panes` argv. Pure — exported for tests.
 * Run right after `new-tab` to find the just-created agent pane id (the
 * newest `terminal_<n>`) for the surgical `close-pane -p` reap path.
 */
export function buildZellijListPanesArgs(session: string): string[] {
  return ["zellij", "--session", session, "action", "list-panes"];
}

/**
 * Parse `action list-panes` output and return the newest terminal pane
 * id (`terminal_<n>` with the highest `n`). zellij's pane ids are a
 * global monotonic counter, so the highest-numbered terminal pane is the
 * one the immediately-preceding `new-tab` created — robust as long as
 * launches are serialized (autopilot's single settling slot guarantees
 * it). Skips `plugin_*` rows and the header. Returns `null` when no
 * terminal pane is found.
 */
export function newestTerminalPaneId(text: string): string | null {
  let best = -1;
  for (const raw of text.split("\n")) {
    const trimmed = raw.replace(ANSI_CSI_RE, "").trim();
    const m = /^terminal_(\d+)\b/.exec(trimmed);
    if (m?.[1] != null) {
      const n = Number.parseInt(m[1], 10);
      if (n > best) {
        best = n;
      }
    }
  }
  return best >= 0 ? `terminal_${best}` : null;
}

/**
 * Build the zellij `attach -b <session>` argv. Pure — exported for
 * tests. `-b` creates a detached background session if absent; we
 * follow with a poll loop in the runtime to beat the #3733 race
 * (`action new-tab` against a not-yet-ready server can no-op).
 */
export function buildZellijAttachBgArgs(session: string): string[] {
  return ["zellij", "attach", "-b", session];
}

/**
 * Internal: parse zellij `list-sessions` output and decide whether
 * `session` is already listed. zellij prints one session per line,
 * usually annotated like `autopilot [Created 5s ago]`; we substring-
 * match on the bare name as the first whitespace-delimited token. Robust
 * to ANSI escape codes and the `EXITED - ` prefix.
 */
function zellijSessionListed(text: string, session: string): boolean {
  const lines = text.split("\n");
  for (const raw of lines) {
    // Strip ANSI CSI sequences (color codes like ESC + `[1m`) so the
    // name match is colorblind. The regex is built via `new RegExp`
    // so the source literal does not contain a control character —
    // biome's lint forbids inline `\x1b` in a regex literal.
    const stripped = raw.replace(ANSI_CSI_RE, "");
    const trimmed = stripped.trim();
    if (trimmed.length === 0) {
      continue;
    }
    // Drop any leading "EXITED - " marker (zellij brands closed sessions
    // that way). Then peel off the first whitespace token as the name.
    const noExit = trimmed.startsWith("EXITED - ")
      ? trimmed.slice("EXITED - ".length)
      : trimmed;
    const firstTok = noExit.split(/\s+/)[0];
    if (firstTok === session) {
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
 * Zellij backend factory. Lazily ensures the session ONCE (memoized
 * `Promise<void>` shared across every `launch` call), then runs
 * `action new-tab --cwd <abs> -- <argv>` and captures the bare-number
 * tab id from stdout. `close` runs `action close-tab-by-id <id>`. No
 * yabai (zellij owns its own layout).
 *
 * #3733 mitigation: after `attach -b <session>` returns, the server is
 * not necessarily ready for actions — the first `new-tab` can no-op
 * silently. We poll `list-sessions` until `session` appears (~50ms
 * interval, ~5s cap) before allowing the first `new-tab` through.
 */
export function createZellijBackend(deps: ZellijBackendDeps): ExecBackend {
  const spawn = deps.spawn ?? defaultSpawn;
  const session = deps.session;
  let sessionReady: Promise<void> | null = null;
  // When `ensureSession` MINTS the session (vs. attaching to a listed
  // one), zellij leaves an empty default `Tab #1`. We stash its id here
  // and the FIRST successful `launch` reaps it after creating the agent
  // tab — net result is a single named agent tab, not an orphan beside
  // it. Cleared after the one-shot close so later launches never touch
  // it; stays null when the session pre-existed (nothing to reap).
  let pendingOrphanTabId: string | null = null;

  async function runCapture(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
    try {
      const proc = spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        streamToText(proc.stdout),
        streamToText(proc.stderr),
      ]);
      return { exitCode, stdout, stderr };
    } catch {
      // ENOENT (zellij not installed) lands here.
      return null;
    }
  }

  function ensureSession(): Promise<void> {
    if (sessionReady != null) {
      return sessionReady;
    }
    sessionReady = (async () => {
      // Probe first — a session already listed is the steady state.
      const listed = await runCapture(buildZellijListSessionsArgs());
      if (listed == null) {
        deps.noteLine(
          `# warn: zellij list-sessions failed (binary missing?); subsequent launches will no-op`,
        );
        return;
      }
      if (zellijSessionListed(listed.stdout, session)) {
        return;
      }
      // Not listed — fire `attach -b <session>` to mint a detached
      // background session, then poll `list-sessions` until it appears.
      await runCapture(buildZellijAttachBgArgs(session));
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const probe = await runCapture(buildZellijListSessionsArgs());
        if (probe != null && zellijSessionListed(probe.stdout, session)) {
          // Freshly minted: capture the default `Tab #1` id so the first
          // launch can reap it once the agent tab exists. Best-effort —
          // a missing/unparsable list leaves `pendingOrphanTabId` null
          // and we simply keep the default tab.
          const tabs = await runCapture(buildZellijListTabsArgs(session));
          if (tabs != null) {
            pendingOrphanTabId = firstTabIdFromListTabs(tabs.stdout);
          }
          return;
        }
        await delay(50);
      }
      deps.noteLine(
        `# warn: zellij session "${session}" never appeared in list-sessions after 5s; new-tab may no-op`,
      );
    })();
    return sessionReady;
  }

  /**
   * Shared name-exact tab-live probe used by BOTH the public
   * `isSurfaceLive` method (dispatch's surface-live gate) AND the
   * `close` token guard. Ensures the session, queries `query-tab-names`,
   * and matches `name` exactly (no substring hazard). Fail-closed: a
   * null/non-zero probe resolves `true` so a probe error suppresses
   * the caller's action — for dispatch that means "don't risk a
   * duplicate worker", for close that means "don't risk leaving a
   * live agent pane parked when zellij itself is uncertain".
   */
  async function isSurfaceLiveInternal(name: string): Promise<boolean> {
    await ensureSession();
    const res = await runCapture(buildZellijQueryTabNamesArgs(session));
    if (res == null) {
      deps.noteLine(
        `# warn: zellij query-tab-names failed (binary missing?); treating surface "${name}" as live (fail-closed)`,
      );
      return true;
    }
    if (res.exitCode !== 0) {
      deps.noteLine(
        `# warn: zellij query-tab-names exited non-zero (${res.exitCode}); treating surface "${name}" as live (fail-closed)`,
      );
      return true;
    }
    return tabNameListed(res.stdout, name);
  }

  return {
    async launch(
      argv: string[],
      rowId: string,
      dir: string,
      opts?: LaunchOptions,
    ): Promise<string | null> {
      await ensureSession();
      const args = buildZellijNewTabArgs(session, dir, argv, opts?.tabName);
      const res = await runCapture(args);
      if (res == null) {
        deps.noteLine(
          `# warn: zellij new-tab for ${rowId} failed (ENOENT? binary missing); window will not auto-close`,
        );
        return null;
      }
      if (res.stderr.length > 0) {
        deps.noteLine(`# launch stderr (${rowId}): ${res.stderr.trim()}`);
      }
      const tabId = res.stdout.trim();
      if (res.exitCode === 0 && tabId.length > 0) {
        // Resolve the just-created agent pane id for the load-bearing
        // surgical close path. The single settling slot upstream
        // guarantees launches are serialized, so `newestTerminalPaneId`
        // reliably picks the just-spawned pane (zellij's pane ids are a
        // process-global monotonic counter).
        const panes = await runCapture(buildZellijListPanesArgs(session));
        const paneId =
          panes != null ? newestTerminalPaneId(panes.stdout) : null;
        // First launch after a fresh mint: reap the orphaned default
        // `Tab #1` now that the agent tab exists, leaving a single named
        // agent tab. Done AFTER the agent tab is confirmed so the session
        // never drops to zero tabs (which would exit it). One-shot.
        if (pendingOrphanTabId != null) {
          await runCapture(
            buildZellijCloseTabArgs(session, pendingOrphanTabId),
          );
          pendingOrphanTabId = null;
        }
        // Return the pane id — NOT the tab id. The autopilot caller
        // persists this as the dispatch.log `windowId` and feeds it to
        // `close-pane -p` for the surgical reap. Returning `null` on
        // parse failure (rather than the tab id) is load-bearing: a
        // tab id fed to `close-pane -p` cannot act and would leave a
        // parked un-closeable pane. Null falls through the existing
        // `closeWindow(undefined → no-op)` contract — the human can
        // close the pane manually.
        if (paneId == null) {
          deps.noteLine(
            `# warn: zellij list-panes returned no terminal pane for ${rowId}; pane will not auto-close`,
          );
        }
        return paneId;
      }
      if (res.exitCode !== 0) {
        deps.noteLine(
          `# warn: zellij new-tab for ${rowId} exited non-zero (${res.exitCode}); window will not auto-close`,
        );
      }
      return null;
    },
    close(windowId: string, tabName?: string): void {
      // Surgical pane-level close, wrap-safe across `zellij --server`
      // restarts. Three skip-conditions land us in "leave the pane
      // open" — always the safe direction, since reaping the WRONG
      // live pane (a recycled pane id from a different server lifetime
      // mapping to whatever live pane currently owns `terminal_<N>`)
      // is unrecoverable.
      //
      //   1. Pre-upgrade `dispatch.log` rows carry the old
      //      `close-tab-by-id`-era tab id (a bare-numeric string like
      //      "7") in `windowId`. Feeding a tab id to `close-pane -p`
      //      is guaranteed to no-op AND would leave a parked tab
      //      regardless, so we skip on shape.
      //   2. Missing `tabName` (also a pre-upgrade signal — the
      //      `kind:"window"` row didn't carry the name when it was
      //      written, fold landed before the field existed) means
      //      we have no token to verify against. Skip; fail-safe.
      //   3. The named tab is no longer live in the current server.
      //      A server restart between launch and close blows away the
      //      `verb::id` tab AND resets the pane-id counter. Skip;
      //      `isSurfaceLive` is the same name-exact gate the dispatch
      //      side uses (`tabNameListed` exact match — no substring
      //      hazard) and shares its fail-closed behavior (an
      //      indeterminate probe reports live → close DOES fire,
      //      matching dispatch's "indeterminate → don't risk
      //      duplicate" precedent).
      //
      // The check fires asynchronously; the `close` method itself
      // stays sync to honor the existing fire-and-forget contract.
      if (!/^terminal_\d+$/.test(windowId)) {
        deps.noteLine(
          `# closeWindow skipped (pre-upgrade tab-id-shaped windowId ${windowId}); leaving surface open — close manually`,
        );
        return;
      }
      if (tabName == null || tabName === "") {
        deps.noteLine(
          `# closeWindow skipped (missing tabName token for ${windowId}); leaving surface open — close manually`,
        );
        return;
      }
      // Anchor: bind the backend reference once so the async closure
      // below survives a hypothetical re-entry without `this` games.
      void (async () => {
        // Token guard: name-exact tab-live check. A server restart
        // between launch and close blows the named tab away (and
        // recycles the pane-id counter), so this probe is the wrap-
        // safety bar. `isSurfaceLive` fail-closes (probe error →
        // `true`) so an indeterminate read prefers a missed-stale-
        // close (`close-pane -p` against an unknown id no-ops via
        // stderr→noteLine, the existing close contract) over leaving
        // a live agent pane parked.
        if (!(await isSurfaceLiveInternal(tabName))) {
          deps.noteLine(
            `# closeWindow skipped (token mismatch: tab "${tabName}" not live; ${windowId} likely belongs to a recycled server lifetime) — leaving any surviving surface open`,
          );
          return;
        }
        const args = buildZellijClosePaneArgs(session, windowId);
        try {
          const proc = spawn(args, {
            stdout: "ignore",
            stderr: "pipe",
            stdin: "ignore",
          });
          Promise.all([proc.exited, streamToText(proc.stderr)])
            .then(([_exitCode, stderrText]) => {
              if (stderrText.length > 0) {
                deps.noteLine(
                  `# closeWindow stderr (${windowId}): ${stderrText.trim()}`,
                );
              }
            })
            .catch((err) => {
              deps.noteLine(
                `# warn: closeWindow spawn (${windowId}) failed: ${(err as Error).message}`,
              );
            });
        } catch (err) {
          deps.noteLine(
            `# warn: closeWindow spawn (${windowId}) failed: ${(err as Error).message}`,
          );
        }
      })();
    },
    async isSurfaceLive(name: string): Promise<boolean> {
      // Name-exact live-surface gate. Delegates to the shared internal
      // probe; the same primitive backs the `close` token guard. See
      // `isSurfaceLiveInternal`'s docstring for the fail-closed
      // rationale (probe error → `true` → caller suppresses its side
      // effect, the safe direction for both dispatch and close).
      return isSurfaceLiveInternal(name);
    },
  };
}

/**
 * Resolve the exec backend. Zellij is the only backend; the function
 * is retained as a thin seam so the call site in cli/autopilot.ts (and
 * future alternative backends) keep one stable entry point.
 */
export function resolveExecBackend(deps: ResolveExecBackendDeps): ExecBackend {
  return createZellijBackend({
    noteLine: deps.noteLine,
    session: deps.session ?? DEFAULT_ZELLIJ_SESSION,
    spawn: deps.spawn,
  });
}
