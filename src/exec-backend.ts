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
 *   ensure (memoized once) + `action new-tab --cwd <abs> -- <argv>` + tab-
 *   id capture; `action close-tab-by-id <id>` close.
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
export interface ExecBackend {
  /** Spawn a terminal surface running argv at `dir`. Resolves to a
   *  stable id, or `null` when no id was captured. */
  launch(argv: string[], rowId: string, dir: string): Promise<string | null>;
  /** Reap a previously-launched surface by id. Fire-and-forget;
   *  never throws back. No-op on empty/undefined id. */
  close(windowId: string): void;
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
 */
export function buildZellijNewTabArgs(
  session: string,
  dir: string,
  argv: string[],
): string[] {
  return [
    "zellij",
    "--session",
    session,
    "action",
    "new-tab",
    "--cwd",
    dir,
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
    ): Promise<string | null> {
      await ensureSession();
      const args = buildZellijNewTabArgs(session, dir, argv);
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
