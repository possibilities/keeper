/**
 * `ExecBackend` — narrow interface for autopilot's terminal-surface
 * spawn/close mechanics. Autopilot is the sole consumer; the interface
 * exists so the Ghostty osascript path and the zellij `action new-tab`
 * path live behind one shape and the backend is selectable by name
 * (`exec_backend: ghostty | zellij`) from `~/.config/keeper/config.yaml`.
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
 *   window/tab id (or `null` when nothing usable was captured), `close
 *   (windowId)` is fire-and-forget.
 * - `createGhosttyBackend({ noteLine, spawn? })` — osascript launch +
 *   yabai move; osascript repeat-loop close.
 * - `createZellijBackend({ noteLine, session, spawn? })` — lazy session-
 *   ensure (memoized once) + `action new-tab --cwd <abs> [--name <tab>]
 *   -- <argv>` + tab-id capture; `action close-tab-by-id <id>` close.
 *   When the ensure step MINTS the session (vs. attaching to a listed
 *   one), it captures the empty default `Tab #1` id and the first launch
 *   reaps it after the agent tab lands — net a single named agent tab.
 *   When `opts.paneName` is set, the launch resolves the just-created
 *   pane (newest `terminal_<n>` from `action list-panes`) and pins its
 *   title via `action rename-pane -p` — authoritative over the command-
 *   derived default and over later program OSC-2 titles.
 * - `resolveExecBackend(name, deps)` — factory by name; defaults to and
 *   falls back to `"zellij"` on an unknown name (the config layer
 *   validates upstream, this is belt-and-suspenders).
 *
 * Fire-and-forget contract. Both backends' `close` is true fire-and-
 * forget — they never throw back into the caller, and a stale or
 * unrecognized window/tab id no-ops (ghostty's repeat-loop returns
 * `"not-found"`; zellij `close-tab-by-id` against an unknown id surfaces
 * stderr via `noteLine` but never throws). This matters because
 * `dispatch.log` persists ids across restarts and a config-flip between
 * runs hands a foreign-format id to the other backend.
 *
 * ENOENT handling (zellij binary not installed): `launch` resolves
 * `null` and surfaces the missing-binary line via `noteLine`, mirroring
 * the ghostty non-zero-exit path. The dispatch already shipped to the
 * dispatch log; autopilot's auto-close just won't have an id to target.
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
 * `launch` returns the captured window/tab id as a string, or `null`
 * when nothing usable was parsed from the spawn's stdout (the dispatch
 * still ships; autopilot's auto-close path no-ops on the missing id).
 *
 * `close` swallows all errors. A stale id from a different backend
 * (e.g. ghostty's `tab-group-…` handed to zellij after a config flip)
 * is treated like an unknown id — best-effort attempt, no throw.
 */
/**
 * Optional surface labels for a launch. `tabName` names the zellij tab
 * (`new-tab --name`); `paneName` pins the pane title via `rename-pane`
 * (authoritative — it survives later program OSC-2 titles from claude /
 * the fallback shell, verified on zellij 0.44). Both are ignored by the
 * Ghostty backend, which has no equivalent surface.
 */
export interface LaunchOptions {
  readonly tabName?: string;
  readonly paneName?: string;
}

export interface ExecBackend {
  /** Spawn a terminal surface running argv at `dir`. Resolves to a
   *  stable id, or `null` when no id was captured. `opts` carries
   *  optional surface labels (zellij tab/pane names); the Ghostty
   *  backend ignores them. */
  launch(
    argv: string[],
    rowId: string,
    dir: string,
    opts?: LaunchOptions,
  ): Promise<string | null>;
  /** Reap a previously-launched surface by id. Fire-and-forget;
   *  never throws back. No-op on empty/undefined id. */
  close(windowId: string): void;
  /** True when a terminal surface labeled `name` is already live in the
   *  backend (zellij: a tab whose name === `name`). Drives autopilot's
   *  name-exact re-dispatch gate — UNLIKE the root-scoped, self-EXCLUDING
   *  `isLiveSessionInRoot`, this matches the exact `verb::id` INCLUDING
   *  the row's own surface, so an already-running identical row blocks its
   *  own re-dispatch even when `dispatch.log` did not survive a restart.
   *  FAIL-CLOSED: resolves `true` when liveness cannot be determined
   *  (query failed / binary missing / non-zero exit) so a probe error
   *  never opens the double-spawn hole — a suppressed dispatch self-heals
   *  on the next snapshot edge. The Ghostty backend has no addressable
   *  tab registry and resolves `false` (no gate). */
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
 * Default backend name when the config key is missing or fails
 * validation. The epic ships zellij as the default.
 */
export const DEFAULT_EXEC_BACKEND = "zellij" as const;

/**
 * Default zellij session name when `zellij_session` is absent or
 * non-string. Matches the README + the epic-spec config example.
 */
export const DEFAULT_ZELLIJ_SESSION = "autopilot" as const;

/**
 * Ghostty backend dependencies. `noteLine` is the lifecycle sidecar
 * sink (autopilot's `noteLine`); `spawn` defaults to `Bun.spawn` and
 * is injectable for tests.
 */
export interface GhosttyBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly spawn?: SpawnFn;
}

/**
 * Zellij backend dependencies. `session` is the target session name;
 * `noteLine` + `spawn` mirror `GhosttyBackendDeps`.
 */
export interface ZellijBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session: string;
  readonly spawn?: SpawnFn;
}

/**
 * Resolver dependencies. The union of the two backend dep bags — the
 * resolver picks the matching subset based on the chosen backend name.
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
 * Build the ghostty osascript argv for a launch. Pure — exported for
 * tests so they can assert the AppleScript shape without spawning.
 *
 * Wraps `argv` (already shaped by the caller — typically
 * `[shell, "-l", "-i", "-c", body]`) into the `new surface configuration`
 * → `new window with configuration cfg` → `return id of w` sequence
 * that emits `tab-group-…` on stdout. The osascript-line array is
 * flattened into `-e <line>` pairs in the order osascript expects.
 */
export function buildGhosttyLaunchArgs(argv: string[]): string[] {
  // The shell invocation is a single command string; quote it so the
  // AppleScript carries the body verbatim through `command of cfg`.
  const shellInvocation = argv.map((a) => quoteForShell(a)).join(" ");
  const appleScript = [
    'tell application "Ghostty"',
    "set cfg to new surface configuration",
    `set command of cfg to ${JSON.stringify(shellInvocation)}`,
    // `set w to new window …` captures the spawned window so we can
    // `return id of w`; the AppleScript stdout is then piped to
    // osascript's exit-0 stdout (`tab-group-…`) which we parse for the
    // `windowId` stamp. Isolating the osascript spawn from the yabai
    // tail keeps that capture clean.
    "set w to new window with configuration cfg",
    "return id of w",
    "end tell",
  ];
  const out: string[] = ["osascript"];
  for (const line of appleScript) {
    out.push("-e", line);
  }
  return out;
}

/**
 * Build the ghostty osascript argv for a close. Pure — exported for
 * tests. Implements the verified repeat-loop close pattern (tip
 * Ghostty `cb36966a7`, 2026-05-29): `close window id "..."` errors
 * -2741 (text vs integer specifier), `close <w>` errors -1708 (verb
 * belongs to the `terminal` class not `window`). The repeat-loop walks
 * the window list, matches by id, and fires `close window <w>` against
 * the AppleScript object reference — the only form that actually reaps
 * the surface.
 */
export function buildGhosttyCloseArgs(windowId: string): string[] {
  const appleScript = [
    `set wid to ${JSON.stringify(windowId)}`,
    'tell application "Ghostty"',
    "repeat with w in every window",
    "if id of w is wid then",
    "close window w",
    "return",
    "end if",
    "end repeat",
    'return "not-found"',
    "end tell",
  ];
  const out: string[] = ["osascript"];
  for (const line of appleScript) {
    out.push("-e", line);
  }
  return out;
}

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
 * newest `terminal_<n>`) so `rename-pane -p` can pin its title.
 */
export function buildZellijListPanesArgs(session: string): string[] {
  return ["zellij", "--session", session, "action", "list-panes"];
}

/**
 * Build the zellij `action rename-pane -p <paneId> <name>` argv. Pure —
 * exported for tests. `-p` targets a specific pane id (vs. the focused
 * pane, which is unreliable when no client is attached) and the assigned
 * name is authoritative — it overrides the command-derived default AND
 * pins against later program OSC-2 titles.
 */
export function buildZellijRenamePaneArgs(
  session: string,
  paneId: string,
  name: string,
): string[] {
  return [
    "zellij",
    "--session",
    session,
    "action",
    "rename-pane",
    "-p",
    paneId,
    name,
  ];
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
 * Shell-quote a single argv element when re-joining for AppleScript's
 * `command of cfg` (which takes a single command-string, not an argv
 * array). The Ghostty launch path is the only consumer — zellij takes
 * argv after `--` directly, no quoting needed.
 *
 * Strategy: if the token contains only `[A-Za-z0-9_/.-]` it's safe
 * verbatim; otherwise single-quote-wrap and escape any embedded single
 * quotes with the `'\''` POSIX dance. This matches the verbatim
 * pre-extraction behavior of the old `launchInGhostty` — the caller
 * built `shell -l -i -c <JSON-quoted-body>` directly, so we recover the
 * same layout when the argv shape is `[shell, "-l", "-i", "-c", body]`.
 */
function quoteForShell(token: string): string {
  if (token.length > 0 && /^[A-Za-z0-9_/.-]+$/.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/**
 * Ghostty backend factory. Returns an `ExecBackend` whose `launch`
 * spawns osascript (captures `tab-group-…` from stdout) and fires a
 * fire-and-forget yabai move; `close` runs the repeat-loop osascript
 * close.
 */
export function createGhosttyBackend(deps: GhosttyBackendDeps): ExecBackend {
  const spawn = deps.spawn ?? defaultSpawn;
  return {
    async launch(
      argv: string[],
      rowId: string,
      _dir: string,
      _opts?: LaunchOptions,
    ): Promise<string | null> {
      const osascriptArgs = buildGhosttyLaunchArgs(argv);
      try {
        const proc = spawn(osascriptArgs, {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        const [exitCode, stdoutText, stderrText] = await Promise.all([
          proc.exited,
          streamToText(proc.stdout),
          streamToText(proc.stderr),
        ]);
        if (stderrText.length > 0) {
          deps.noteLine(`# launch stderr (${rowId}): ${stderrText.trim()}`);
        }
        // Fire-and-forget yabai move — `yabai -m window --space 5`
        // operates on the focused window, which is the brand-new Ghostty
        // window. The 0.3s sleep gives Ghostty time to claim focus. yabai
        // not being installed is fine (`|| true`).
        try {
          spawn(
            [
              "sh",
              "-c",
              "sleep 0.3 && yabai -m window --space 5 2>/dev/null || true",
            ],
            { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
          );
        } catch {
          // best-effort; the dispatch already shipped via osascript.
        }
        const windowId = stdoutText.trim();
        if (exitCode === 0 && windowId.length > 0) {
          return windowId;
        }
        if (exitCode !== 0) {
          deps.noteLine(
            `# warn: osascript spawn for ${rowId} exited non-zero (${exitCode}); window will not auto-close`,
          );
        }
        return null;
      } catch (err) {
        deps.noteLine(
          `# warn: launch spawn for ${rowId} failed: ${(err as Error).message}`,
        );
        return null;
      }
    },
    close(windowId: string): void {
      const args = buildGhosttyCloseArgs(windowId);
      try {
        const proc = spawn(args, {
          stdout: "ignore",
          stderr: "pipe",
          stdin: "ignore",
        });
        // Fire-and-forget; surface stderr (osascript error or
        // "not-found") to the lifecycle sidecar but never throw
        // back into the transitions loop.
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
    },
    // Ghostty has no addressable tab/surface registry the launcher can
    // query by name, so the name-exact gate is a no-op here — resolve
    // `false` (never suppress). The duplicate-spawn protection the gate
    // provides is zellij-only; the Ghostty backend is being retired, so
    // this is the documented degradation, not a gap.
    async isSurfaceLive(_name: string): Promise<boolean> {
      return false;
    },
  };
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
        // Pin the pane title to the role label (Worker/Closer/Approver).
        // Best-effort: resolve the just-created pane (newest terminal)
        // and `rename-pane -p`. A missing/unparsable list or a failed
        // rename leaves zellij's command-derived default — never blocks
        // the launch.
        if (opts?.paneName != null && opts.paneName !== "") {
          const panes = await runCapture(buildZellijListPanesArgs(session));
          const paneId =
            panes != null ? newestTerminalPaneId(panes.stdout) : null;
          if (paneId != null) {
            await runCapture(
              buildZellijRenamePaneArgs(session, paneId, opts.paneName),
            );
          }
        }
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
        return tabId;
      }
      if (res.exitCode !== 0) {
        deps.noteLine(
          `# warn: zellij new-tab for ${rowId} exited non-zero (${res.exitCode}); window will not auto-close`,
        );
      }
      return null;
    },
    close(windowId: string): void {
      const args = buildZellijCloseTabArgs(session, windowId);
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
    },
    async isSurfaceLive(name: string): Promise<boolean> {
      // Name-exact live-surface gate. Ensure the session exists
      // (memoized; a freshly-minted session has only the empty default
      // tab, which can never match a `verb::id`), then ask zellij for
      // every tab name and exact-match `name`. FAIL-CLOSED: binary
      // missing (null) OR non-zero exit resolves `true` so a probe
      // failure suppresses rather than risking a double-spawn (the
      // caller re-fires on the next verdict edge).
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
    },
  };
}

/**
 * Resolve a backend by name. Hard-defaults to `"zellij"` and falls
 * back to `"zellij"` on any unknown name (the config layer already
 * validates, so this is belt-and-suspenders). An unknown name is
 * surfaced via `noteLine` so a typo in `~/.config/keeper/config.yaml`
 * is visible without crashing autopilot.
 */
export function resolveExecBackend(
  name: string | undefined,
  deps: ResolveExecBackendDeps,
): ExecBackend {
  if (name === "ghostty") {
    return createGhosttyBackend({ noteLine: deps.noteLine, spawn: deps.spawn });
  }
  if (name === "zellij" || name == null || name === "") {
    return createZellijBackend({
      noteLine: deps.noteLine,
      session: deps.session ?? DEFAULT_ZELLIJ_SESSION,
      spawn: deps.spawn,
    });
  }
  deps.noteLine(
    `# warn: unknown exec_backend "${name}"; falling back to "${DEFAULT_EXEC_BACKEND}"`,
  );
  return createZellijBackend({
    noteLine: deps.noteLine,
    session: deps.session ?? DEFAULT_ZELLIJ_SESSION,
    spawn: deps.spawn,
  });
}
