/**
 * `ExecBackend` — narrow interface for the autopilot reconciler's
 * terminal-surface spawn/close mechanics. The server-side reconciler
 * (fn-661) is the sole consumer; the interface exists as a single seam
 * so the zellij `action new-tab` path stays pluggable (and tests can
 * inject a fake `spawn`).
 *
 * Why a factory (no top-level side effects). The module mirrors
 * `src/live-shell.ts`: import-clean, interface first, `Default*` consts,
 * `create*({deps})` factories. Production callers construct the backend
 * once in the reconciler worker; tests inject a fake `spawn` so argv
 * construction is asserted without launching real processes.
 *
 * Public surface
 * --------------
 * - `ExecBackend.launch(argv, name, cwd) -> { ok, error? }` — spawn an
 *   agent in a zellij tab named `name` at `cwd`. Returns a plain
 *   success/failure envelope; no pane id is captured or returned. The
 *   reconciler correlates back to keeperd via the `--name` baked into
 *   `argv` (the `claude --name verb::id`) → SessionStart hook event →
 *   `jobs` projection. Zellij is stateless from autopilot's side; the
 *   only durable spawn signal is the projection edge.
 * - `ExecBackend.closeByName(name) -> Promise<void>` — fire-and-forget
 *   reap. Runs `zellij action list-panes -a -j`, parses the JSON,
 *   filters to the SINGLE pane whose `tab_name === name` (exact, no
 *   substring), and `close-pane -p` it. Closing the pane terminates
 *   the agent process (SIGHUP on pane close) AND removes the now-empty
 *   tab in one shot (zellij auto-closes a tab when it drops to zero
 *   selectable tiled panes). Zero or multiple matches → noteLine warn
 *   and no-op (a dedup guarantee upstream maintains one live tab per
 *   `verb::id`, so multiple is "shouldn't happen" territory; zero just
 *   means the tab is already gone).
 * - `createZellijBackend({ noteLine, session, spawn? })` — lazy session-
 *   ensure (memoized once) + `action new-tab --cwd <abs> --name <name>
 *   -- <argv>`. When the ensure step MINTS the session (vs. attaching
 *   to a listed one), it captures the empty default `Tab #1` id and
 *   the first launch reaps it via `action close-tab-by-id` (the orphan
 *   reap deliberately closes a known-empty tab — both close builders
 *   coexist, only the agent reap path is name-driven).
 * - `resolveExecBackend(deps)` — factory; always returns a zellij
 *   backend. Kept as a thin seam so call sites and tests do not need a
 *   structural rewrite.
 *
 * Fire-and-forget contract. The backend's `closeByName` never throws
 * back into the caller; an unparseable list-panes payload, a missing
 * binary, or zero/multiple matches all degrade to a noteLine warn and
 * no spawned close.
 *
 * Wrap-safety. The previous incarnation carried `windowId` (a
 * `terminal_<n>` pane id) across launch and close and guarded against
 * server-restart pane-id recycling via a name-exact `query-tab-names`
 * token probe. The new shape is stateless from autopilot's side — the
 * close is driven entirely by the live `list-panes -a -j` snapshot, so
 * a server restart can't reap the wrong pane (no stashed id to recycle).
 *
 * ENOENT handling (zellij binary not installed): `launch` resolves
 * `{ ok: false, error }` and surfaces the missing-binary line via
 * `noteLine`; `closeByName` no-ops with a noteLine warn. The reconciler
 * treats a non-`ok` launch as a sticky `DispatchFailed` per the epic
 * design.
 */

/**
 * Minimal spawn function alias — Bun.spawn-shaped subset the backend
 * needs. Threaded through `deps.spawn` so tests can inject a fake that
 * captures the constructed argv without running a real process.
 * Production defaults to `Bun.spawn`.
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
 * Result envelope from `launch`. `ok: true` means the new-tab spawn
 * exited 0; `ok: false` carries a short `error` description for the
 * reconciler to fold into a `DispatchFailed` event. No pane id, no
 * surface ref — the reconciler correlates via the `--name` baked into
 * `argv` and the resulting `SessionStart` hook event.
 */
export type LaunchResult = { ok: true } | { ok: false; error: string };

/**
 * Backend interface — async `launch`, async `closeByName`.
 *
 * `launch(argv, name, cwd)` spawns the worker argv inside a new zellij
 * tab named `name` at `cwd`. Returns `{ ok }` — there is no pane id or
 * tab id to capture. The launch's success/failure is the only signal
 * the reconciler folds into the event log (sticky `DispatchFailed` on
 * non-ok).
 *
 * `closeByName(name)` reaps the tab labeled exactly `name`. Fire-and-
 * forget; never throws back. Resolves the pane id at close time via
 * `list-panes -a -j` so server-restart pane-id recycling can't reap
 * the wrong pane (no stashed id).
 */
export interface ExecBackend {
  /** Spawn a terminal surface running `argv` at `cwd` in a tab named
   *  exactly `name` (zellij `new-tab --name`). Returns `{ ok: true }`
   *  on exit code 0; `{ ok: false, error }` on spawn ENOENT or non-
   *  zero exit. No pane id is captured — the reconciler correlates
   *  the dispatch via the `--name verb::id` baked into `argv` plus
   *  the resulting `SessionStart` hook event in the `jobs` projection,
   *  not via a surface ref. */
  launch(argv: string[], name: string, cwd: string): Promise<LaunchResult>;
  /** Reap the zellij tab labeled exactly `name` by closing its single
   *  agent pane. Fire-and-forget — resolves even when the underlying
   *  spawn fails. Behavior:
   *
   *    1. `zellij action list-panes -a -j` — snapshot every pane in
   *       the session.
   *    2. Filter to the pane whose `tab_name === name` (exact, no
   *       substring; dedup guarantees one live tab per `verb::id`).
   *    3. Zero matches → noteLine warn + no-op (the tab is already
   *       gone; safe). Multiple matches → noteLine warn + no-op
   *       ("shouldn't happen" given the dedup invariant; refuse to
   *       guess which one is the right one).
   *    4. Single match → `zellij action close-pane -p <pane_id>`.
   *       Closing the pane SIGHUPs the agent process and (because the
   *       tab has no sibling panes) zellij auto-closes the tab.
   *
   *  Unparseable JSON, missing binary, non-zero list-panes exit, etc.
   *  all degrade to noteLine warn + no-op — leaving a stale tab is the
   *  safe direction; the human can close it manually. */
  closeByName(name: string): Promise<void>;
}

/**
 * ANSI CSI sequence matcher used by `zellijSessionListed` /
 * `firstTabIdFromListTabs` to strip color codes from zellij's text
 * output (the JSON path doesn't need it). Built via `new RegExp` so
 * the source literal does not contain a control character (biome's
 * `noControlCharactersInRegex` rule). The pattern matches an ESC
 * (0x1B) followed by `[`, a possibly-empty run of digits and
 * semicolons, and a trailing letter terminator.
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
 * `noteLine` is the lifecycle sidecar sink; `spawn` defaults to
 * `Bun.spawn` and is injectable for tests.
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
 * `name`, when non-empty, labels the new tab via `--name`. The
 * reconciler always passes the worker's `verb::id` spawn name so the
 * tab bar mirrors the `claude --name` and `closeByName(name)` can
 * resolve the pane via `list-panes -a -j`'s `tab_name` field.
 * Omitted entirely when absent so zellij assigns its default `Tab #N`
 * (only used by tests; the reconciler never launches unnamed).
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
 * there's no risk of nuking a shared tab. The agent-pane reap takes
 * `buildZellijClosePaneArgs` below (surgical pane-level close, name-
 * driven via `list-panes -a -j`).
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
 * `zellij-server/src/screen.rs:2518-2523`). The reconciler dedup
 * invariant guarantees one agent pane per named tab, so the close
 * always lands the tab too.
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
 * Build the zellij `action list-panes -a -j` argv. Pure — exported for
 * tests. `-a` means "all panes across all tabs" (without `-a`,
 * `list-panes` defaults to the active tab only). `-j` is JSON output:
 * each pane object carries at minimum `id`, `tab_id`, `tab_name`,
 * `terminal_command`, `exited` — the reconciler's `closeByName` filters
 * on `tab_name` (exact match) and feeds the matching `id` to
 * `close-pane -p`.
 */
export function buildZellijListPanesAllJsonArgs(session: string): string[] {
  return ["zellij", "--session", session, "action", "list-panes", "-a", "-j"];
}

/**
 * Pane record parsed from `list-panes -a -j` output. The full zellij
 * schema is wider (≈30 fields); we only model what the reconciler
 * actually reads. `id` is the pane id we feed to `close-pane -p`;
 * `tab_name` is the filter key. Other fields kept here for forensic
 * use by callers / tests that want to log them but are otherwise
 * unread by this module.
 */
export interface ZellijPane {
  readonly id: string;
  readonly tab_name: string;
  readonly tab_id?: number;
  readonly terminal_command?: string | null;
  readonly exited?: boolean;
}

/**
 * Find a pane whose `tab_name === name` in a parsed `list-panes -a -j`
 * payload. Pure — exported for tests.
 *
 * Returns:
 *   - `{ found: "single", pane }` — exactly one match (the dedup-
 *     invariant happy path).
 *   - `{ found: "none" }` — zero matches (tab already gone; safe).
 *   - `{ found: "multiple", count }` — more than one match
 *     ("shouldn't happen" given the dedup invariant; caller refuses
 *     to guess and no-ops).
 *
 * Accepts both observed JSON shapes defensively: a flat array of panes
 * with `tab_name` fields, OR an object map keyed by tab name to arrays
 * of panes (zellij has shipped both in different versions).
 */
export type FindPaneResult =
  | { found: "single"; pane: ZellijPane }
  | { found: "none" }
  | { found: "multiple"; count: number };

export function findPaneByTabName(
  payload: unknown,
  name: string,
): FindPaneResult {
  const matches: ZellijPane[] = [];
  const collect = (raw: unknown, tabNameHint?: string): void => {
    if (raw == null || typeof raw !== "object") {
      return;
    }
    const rec = raw as Record<string, unknown>;
    const idRaw = rec.id;
    const id =
      typeof idRaw === "string"
        ? idRaw
        : typeof idRaw === "number"
          ? `terminal_${idRaw}`
          : null;
    const tabNameField =
      typeof rec.tab_name === "string" ? rec.tab_name : undefined;
    const tab_name = tabNameField ?? tabNameHint;
    if (id == null || tab_name == null) {
      return;
    }
    if (tab_name !== name) {
      return;
    }
    matches.push({
      id,
      tab_name,
      tab_id: typeof rec.tab_id === "number" ? rec.tab_id : undefined,
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
    // Object-map shape: `{ "tab_name_1": [pane, pane], ... }`. The
    // tab name comes from the key when the pane object lacks it.
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
 * Parse the JSON stdout of `list-panes -a -j`. Returns `null` on
 * empty/unparseable input — the caller treats `null` as "couldn't
 * read the snapshot, leave it alone" and no-ops the close.
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
 * `session` is already listed AND LIVE. zellij prints one session per
 * line, usually annotated like `autopilot [Created 5s ago]`; we
 * substring-match on the bare name as the first whitespace-delimited
 * token. Robust to ANSI escape codes.
 *
 * A line carrying zellij's EXITED marker (`autopilot [Created 3h ago]
 * (EXITED - attach to resurrect)`) is a CORPSE, not a live server —
 * `action new-tab` against it exits non-zero ("There is no active
 * session!"). We treat such a line as NOT listed so `ensureSession`
 * routes to `attach -b`, which resurrects the session in place.
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
    // First whitespace token is the bare session name. ANSI is already
    // stripped, so the EXITED brand surfaces as a bare `EXITED` token.
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
 * Zellij backend factory. Lazily ensures the session ONCE (memoized
 * `Promise<void>` shared across every `launch`/`closeByName` call),
 * then runs `action new-tab --cwd <abs> --name <name> -- <argv>` for
 * launches and `action list-panes -a -j` + `close-pane -p <id>` for
 * closes. No yabai (zellij owns its own layout).
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
      name: string,
      cwd: string,
    ): Promise<LaunchResult> {
      await ensureSession();
      const args = buildZellijNewTabArgs(session, cwd, argv, name);
      const res = await runCapture(args);
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
      // First launch after a fresh mint: reap the orphaned default
      // `Tab #1` now that the agent tab exists, leaving a single named
      // agent tab. Done AFTER the agent tab is confirmed so the session
      // never drops to zero tabs (which would exit it). One-shot.
      if (pendingOrphanTabId != null) {
        await runCapture(buildZellijCloseTabArgs(session, pendingOrphanTabId));
        pendingOrphanTabId = null;
      }
      return { ok: true };
    },
    async closeByName(name: string): Promise<void> {
      await ensureSession();
      const res = await runCapture(buildZellijListPanesAllJsonArgs(session));
      if (res == null) {
        deps.noteLine(
          `# warn: zellij list-panes for closeByName(${name}) failed (binary missing?); leaving surface open`,
        );
        return;
      }
      if (res.exitCode !== 0) {
        deps.noteLine(
          `# warn: zellij list-panes for closeByName(${name}) exited non-zero (${res.exitCode}); leaving surface open`,
        );
        return;
      }
      const payload = parseListPanesJson(res.stdout);
      if (payload == null) {
        deps.noteLine(
          `# warn: zellij list-panes for closeByName(${name}) returned empty/unparseable JSON; leaving surface open`,
        );
        return;
      }
      const match = findPaneByTabName(payload, name);
      if (match.found === "none") {
        deps.noteLine(
          `# closeByName(${name}): no pane with tab_name=${name} found (already gone?); nothing to do`,
        );
        return;
      }
      if (match.found === "multiple") {
        deps.noteLine(
          `# warn: closeByName(${name}): ${match.count} panes match tab_name=${name} (dedup invariant violated?); refusing to guess, leaving surfaces open`,
        );
        return;
      }
      const args = buildZellijClosePaneArgs(session, match.pane.id);
      const closeRes = await runCapture(args);
      if (closeRes == null) {
        deps.noteLine(
          `# warn: closeByName(${name}) close-pane spawn failed (binary missing?)`,
        );
        return;
      }
      if (closeRes.stderr.length > 0) {
        deps.noteLine(
          `# closeByName(${name}) stderr: ${closeRes.stderr.trim()}`,
        );
      }
    },
  };
}

/**
 * Resolve the exec backend. Zellij is the only backend; the function
 * is retained as a thin seam so the reconciler call site (and future
 * alternative backends) keep one stable entry point.
 */
export function resolveExecBackend(deps: ResolveExecBackendDeps): ExecBackend {
  return createZellijBackend({
    noteLine: deps.noteLine,
    session: deps.session ?? DEFAULT_ZELLIJ_SESSION,
    spawn: deps.spawn,
  });
}
