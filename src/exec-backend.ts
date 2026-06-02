/**
 * `ExecBackend` — narrow interface for the autopilot reconciler's
 * terminal-surface spawn/close mechanics, plus session-agnostic pane
 * queries used by the daemon's tab-resolver worker and the `keeper jobs`
 * CLI. Two consumer paths share the single port so the zellij surface
 * has one seam (and tests can inject a fake `spawn`).
 *
 * Why a factory (no top-level side effects). The module mirrors
 * `src/live-shell.ts`: import-clean, interface first, `Default*` consts,
 * `create*({deps})` factories. Production callers construct the backend
 * once in the reconciler worker; tests inject a fake `spawn` so argv
 * construction is asserted without launching real processes.
 *
 * Two op categories
 * -----------------
 * The backend port carries two intentionally distinct op categories
 * sharing one factory + one set of zellij subprocess plumbing:
 *
 * 1. **Session-bound lifecycle ops** — `launch`, `closeByName`. These
 *    drive the autopilot reconciler against ONE managed zellij session
 *    (passed to `createZellijBackend({ session })`); session-ensure is
 *    memoized once per backend instance and re-minted on a session-gone
 *    `new-tab` failure. The reconciler's contract is "I own this session
 *    and put agent panes into it"; the session id is baked into the
 *    backend at construction so the call sites read clean.
 * 2. **Session-agnostic ops** — `focusPane(session, paneId)`,
 *    `resolveTabForPane(session, paneId)`, `ensureLaunched(session,
 *    argv, cwd, name?)`. These take the target session PER CALL and
 *    operate on (or get-or-create) arbitrary external sessions — the
 *    daemon tab-resolver worker walks every live job's `(session,
 *    pane)`, `keeper jobs`'s `v` key focuses the pane the human's
 *    selected job lives in, and the restore-agents util relaunches
 *    each surviving agent back into its original session.
 *    `focusPane`/`resolveTabForPane` run NO session-ensure (degrade
 *    to `null` / `{ ok: false }` against a missing session);
 *    `ensureLaunched` runs its OWN per-call get-or-create that mirrors
 *    the managed session's `attach -b --forget` + poll logic but
 *    shares no memo or orphan-reap state with it. Construction may
 *    omit `session` (it defaults to `DEFAULT_ZELLIJ_SESSION`) when the
 *    consumer only touches this category — the field is required for
 *    the lifecycle ops alone.
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
 * - `ExecBackend.tabExistsByName(name) -> Promise<boolean>` — name-exact
 *   tab probe sharing `closeByName`'s `list-panes -a -j` parse. Returns
 *   `true` iff some pane carries `tab_name === name` exactly (single
 *   OR multiple match counts as "exists"). Returns `false` (inert) on
 *   zero matches, ENOENT, unparseable JSON, or non-zero exit — never
 *   throws. Drives fn-674's `confirmRunning` early-resolve: a tab
 *   present in the session is proof the slot is occupied, visible the
 *   instant `new-tab` returns and long before SessionStart folds.
 * - `ExecBackend.liveTabNames() -> Promise<Set<string>>` — bulk variant
 *   of `tabExistsByName`. One `list-panes -a -j` round-trip; returns
 *   the set of every distinct `tab_name` in the session. Drives the
 *   autopilot reconciler's per-cycle `liveTabKeys` snapshot — the
 *   loader intersects the returned set with candidate `verb::id`
 *   dispatch keys without paying N subprocess spawns. Same
 *   inert-on-failure semantics: empty Set on any failure mode.
 * - `ExecBackend.focusPane(session, paneId) -> { ok, error? }` —
 *   session-agnostic. Runs `zellij --session <session> action
 *   focus-pane-id <paneId>`; on success zellij focuses the pane AND
 *   switches to its tab in one shot. Returns the same `LaunchResult`
 *   envelope as `launch` — ENOENT / non-zero exit collapse to
 *   `{ ok: false, error }`, never throws back.
 * - `ExecBackend.resolveTabForPane(session, paneId) -> ResolvedTabCoords
 *   | null` — session-agnostic. Runs `zellij --session <session> action
 *   list-panes -a -j` once and filters by pane id. Returns the resolved
 *   tab triple (`tab_id`, `tab_name`, `tab_position`) on a single match;
 *   `null` on ENOENT / non-zero exit / unparseable JSON / zero or
 *   multiple matches. The caller treats `null` as "no snapshot; leave
 *   existing tab columns alone" — never as "clear them."
 * - `ExecBackend.ensureLaunched(session, argv, cwd, name?) -> { ok,
 *   error? }` — session-agnostic. Get-or-creates the target `session`
 *   (probe `list-sessions` → `attach -b --forget` + poll only when
 *   absent / EXITED) and launches `argv` in a new tab at `cwd` inside
 *   it. `name` is optional and unset on the restore path (no `--name`
 *   on the tab). Returns the same `LaunchResult` envelope as `launch`;
 *   ENOENT / non-zero exit collapse to `{ ok: false, error }`, never
 *   throws. Shares NO state with the managed `session` memo or its
 *   `pendingOrphanTabId` — per-call orphan reap, per-call session-gone
 *   single-retry. Drives the `restore-agents.ts` util's replay path.
 * - `createZellijBackend({ noteLine, session?, spawn? })` — lazy
 *   session-ensure (memoized once) + `action new-tab --cwd <abs>
 *   --name <name> -- <argv>` for the lifecycle ops; session-agnostic
 *   ops bypass the ensure entirely. When the ensure step MINTS the
 *   session (vs. attaching to a listed one), it captures the empty
 *   default `Tab #1` id and the first launch reaps it via `action
 *   close-tab-by-id` (the orphan reap deliberately closes a known-empty
 *   tab — both close builders coexist, only the agent reap path is
 *   name-driven). `session` defaults to `DEFAULT_ZELLIJ_SESSION` so a
 *   consumer touching only `focusPane`/`resolveTabForPane` constructs
 *   with just `{ noteLine }`.
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
    /**
     * Optional child env. Omitted on every control command (Bun inherits
     * `process.env`); set ONLY on the session-mint `attach -b` spawn so
     * the zellij server — and every pane it later launches — boots with a
     * color-capable `TERM`/`COLORTERM`. See `ensureSession`.
     */
    env?: Record<string, string>;
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
 * Backend interface — two op categories sharing one port:
 *
 * Session-bound lifecycle ops (`launch`, `closeByName`) drive the
 * autopilot reconciler against the managed zellij session passed to
 * `createZellijBackend({ session })`. The session is memoized once per
 * backend; agent-pane dispatch / reap go through this surface.
 *
 * Session-agnostic ops (`focusPane`, `resolveTabForPane`,
 * `ensureLaunched`) take the target session per call. `focusPane`
 * and `resolveTabForPane` operate on already-live external sessions
 * (no session-ensure; missing session → `null` / `{ ok: false }`).
 * `ensureLaunched` runs its OWN per-call get-or-create that mirrors
 * the managed ensure path but shares no memo with it, then launches
 * an unnamed tab — driving the restore-agents replay. Used by the
 * daemon's tab-resolver worker, the `keeper jobs` `v` focus key,
 * and `restore-agents.ts`.
 */
export interface ExecBackend {
  /** Session-bound lifecycle. Spawn a terminal surface running `argv`
   *  at `cwd` in a tab named exactly `name` (zellij `new-tab --name`)
   *  inside the backend's managed session. Returns `{ ok: true }` on
   *  exit code 0; `{ ok: false, error }` on spawn ENOENT or non-zero
   *  exit. No pane id is captured — the reconciler correlates the
   *  dispatch via the `--name verb::id` baked into `argv` plus the
   *  resulting `SessionStart` hook event in the `jobs` projection, not
   *  via a surface ref. */
  launch(argv: string[], name: string, cwd: string): Promise<LaunchResult>;
  /** Session-bound lifecycle. Probe whether ANY zellij pane in the
   *  managed session lives in a tab whose `tab_name === name` EXACTLY
   *  (recycle-safe, no substring match — same parse as `closeByName`
   *  and `resolveTabForPane`). Returns `true` on a single OR multiple
   *  match; `false` on zero matches, ENOENT (binary missing),
   *  unparseable JSON, or any non-zero list-panes exit. NEVER throws.
   *
   *  Drives the autopilot reconciler's `confirmRunning` early-resolve
   *  (fn-674): a tab present in the session is proof a worker is
   *  occupying the slot — visible the moment `zellij action new-tab`
   *  returns, long before the worker's `SessionStart` hook event
   *  reaches `jobs`. Closes the launch → SessionStart blind window
   *  that fn-674 was opened to fix.
   *
   *  Inert on failure: a missing binary or stale session probe
   *  returns `false` so the dedup arm degrades open (the worker may
   *  re-dispatch on a transient zellij outage; the in-flight set
   *  and the legacy `isOccupyingJob` arm still cover the steady
   *  state). */
  tabExistsByName(name: string): Promise<boolean>;
  /** Session-bound lifecycle. Bulk variant of `tabExistsByName` —
   *  returns the FULL set of distinct `tab_name` strings present in
   *  the managed session via a single `list-panes -a -j` round-trip.
   *  Drives the autopilot reconciler's per-cycle `liveTabKeys`
   *  snapshot (fn-674): the loader intersects this set with the
   *  candidate `verb::id` dispatch keys without paying N subprocess
   *  spawns. Same inert-on-failure semantic as `tabExistsByName` —
   *  returns an empty `Set` on ENOENT, non-zero exit, or unparseable
   *  JSON; NEVER throws. */
  liveTabNames(): Promise<Set<string>>;
  /** Session-bound lifecycle. Reap the zellij tab labeled exactly
   *  `name` inside the backend's managed session by closing its single
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
  /** Session-agnostic. Focus the pane `paneId` inside the external
   *  `session` via `zellij --session <session> action focus-pane-id
   *  <paneId>`. Zellij switches the focused pane AND the active tab in
   *  one shot. Returns `{ ok: true }` on exit 0; `{ ok: false, error }`
   *  on ENOENT (zellij missing) or non-zero exit (session gone, pane
   *  unknown). NEVER throws — same envelope shape as `launch` so the
   *  caller can `await` and pattern-match on `ok`. No session-ensure
   *  runs; the consumer (`keeper jobs` `v` key) is operating on a
   *  pane that already exists in some live session. */
  focusPane(session: string, paneId: string): Promise<LaunchResult>;
  /** Session-agnostic. Resolve the tab a given pane lives in by
   *  running `zellij --session <session> action list-panes -a -j` once
   *  and filtering by pane id. Returns the resolved tab triple
   *  (`tab_id`, `tab_name`, `tab_position`) on a single match; `null`
   *  on ENOENT, non-zero exit, empty / unparseable JSON, or zero /
   *  multiple matches. Never throws. The caller (daemon tab-resolver
   *  worker) treats `null` as "no snapshot; leave the existing tab
   *  columns alone" — never as "clear them." */
  resolveTabForPane(
    session: string,
    paneId: string,
  ): Promise<ResolvedTabCoords | null>;
  /** Session-agnostic. Get-or-create the target `session` (mint via
   *  `attach -b --forget` + `list-sessions` poll only when absent /
   *  EXITED — already-live sessions are NEVER `--forget`'d) and launch
   *  `argv` in a new tab at `cwd` inside it. The tab is unnamed —
   *  `buildZellijNewTabArgs` omits `--name` when `name` is empty /
   *  absent, mirroring the restore use case (Chrome-style restore-
   *  previous-session emits no `verb::id` tab name). Returns the same
   *  `LaunchResult` envelope as `launch` — exit 0 → `{ ok: true }`;
   *  ENOENT / non-zero exit → `{ ok: false, error }`; NEVER throws.
   *
   *  Shares NO state with the construction-time `session` memo or its
   *  `pendingOrphanTabId`: this op runs against an arbitrary external
   *  session per call (the restore-agents util replays into the
   *  session each agent originally lived in). The mint path is its
   *  own — the orphan default `Tab #1` is reaped per-call after the
   *  agent tab lands (only when this op minted the session; an
   *  already-live session has no orphan to reap). A session-gone
   *  new-tab stderr (`Session '<n>' not found` / `no active session`)
   *  triggers a one-shot re-ensure + retry, mirroring `launch`'s
   *  resilience for the case where the target session died between
   *  the ensure probe and the new-tab spawn. */
  ensureLaunched(
    session: string,
    argv: string[],
    cwd: string,
    name?: string,
  ): Promise<LaunchResult>;
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
 * Zellij backend dependencies. `session` is the managed session name
 * for the session-bound lifecycle ops (`launch`, `closeByName`); it
 * defaults to `DEFAULT_ZELLIJ_SESSION` so a consumer touching only the
 * session-agnostic ops (`focusPane`, `resolveTabForPane`) can construct
 * with just `{ noteLine }` — those ops take their target session per
 * call and never read this field. `noteLine` is the lifecycle sidecar
 * sink; `spawn` defaults to `Bun.spawn` and is injectable for tests.
 */
export interface ZellijBackendDeps {
  readonly noteLine: (line: string) => void;
  readonly session?: string;
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
 * Build the zellij `action focus-pane-id <paneId>` argv. Pure —
 * exported for tests. `paneId` is the bare numeric pane id stored as a
 * string (lifted from `ZELLIJ_PANE_ID` by the hook); zellij 0.44.3
 * accepts it verbatim as the argv tail. The session is targeted via
 * `--session <session>`, the same selector used by `list-panes`. On
 * success zellij focuses the pane AND switches to its tab in one shot;
 * the caller (`ExecBackend.focusPane`) inspects the exit code and
 * surfaces `{ ok }` accordingly.
 */
export function buildZellijFocusPaneArgs(
  session: string,
  paneId: string,
): string[] {
  return ["zellij", "--session", session, "action", "focus-pane-id", paneId];
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
  readonly tab_position?: number;
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
 * Backend env-var metadata for a given backend type. Single source of
 * truth for the env-var NAMES the hook reads on every event (T3) — by
 * funnelling the literals through this seam, the hook stays
 * backend-agnostic and a future tmux/wezterm backend slots in without
 * the hook learning new keys.
 *
 * Defaults to `DEFAULT_EXEC_BACKEND`. For `"zellij"`, returns the
 * official `ZELLIJ_SESSION_NAME` / `ZELLIJ_PANE_ID` env vars zellij
 * stamps into every pane's environment.
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
  // Future backend types slot in here. For now we still return the
  // backendType verbatim so the caller can log the unknown name; the
  // env-var fields fall back to the zellij defaults rather than empty
  // strings, which would silently null out every hook event.
  return {
    backendType: t,
    sessionIdEnvVar: "ZELLIJ_SESSION_NAME",
    paneIdEnvVar: "ZELLIJ_PANE_ID",
  };
}

/**
 * Find a pane whose `id` matches `paneId` in a parsed `list-panes -a -j`
 * payload. Pure — exported for tests. Mirrors `findPaneByTabName`'s
 * none/single/multiple envelope.
 *
 * Identity is the load-bearing concern here: zellij ships `id` as a
 * bare number (e.g. `11`), but the value stored on the events / job row
 * comes from the `ZELLIJ_PANE_ID` env var which is always a string
 * (`"11"`). We normalize both sides to string for comparison so the
 * join lands. Skips `is_plugin === true` panes — the daemon worker
 * only cares about terminal panes (plugin panes carry their own ids in
 * an unrelated namespace and would never appear in `ZELLIJ_PANE_ID`).
 *
 * Multiple matches "shouldn't happen" — pane ids are unique within a
 * zellij session — but we surface the count so the caller can log it
 * rather than guess.
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
      // Preserve the raw id shape (string-coerced) — this finder is
      // for env-pane-id matching, not for `close-pane -p`, so we don't
      // re-normalize to the `terminal_<n>` form.
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
 * Resolved tab coordinates for a known (session, paneId). Returned by
 * `resolveTabForPane` and folded into `jobs.backend_exec_tab_{id,name}`
 * (plus `tab_position` for future render use) by the daemon worker
 * landing in T4.
 */
export interface ResolvedTabCoords {
  readonly tab_id: number | null;
  readonly tab_name: string;
  readonly tab_position: number | null;
}

/**
 * Build the zellij `attach -b --forget <session>` argv. Pure —
 * exported for tests. `-b` creates a detached background session if
 * absent; `--forget` deletes any saved (serialized) session before
 * connecting, so a stale/EXITED corpse is fresh-rebuilt rather than
 * resurrected from a degraded `session-layout.kdl` cache (the
 * root-cause fix for fn-675's bar-less mint). `--forget` is a
 * harmless no-op when no saved session exists, and `ensureSession`
 * short-circuits before this argv when the target is already LIVE —
 * so `--forget` never runs against a live session. We follow with a
 * poll loop in the runtime to beat the #3733 race (`action new-tab`
 * against a not-yet-ready server can no-op).
 */
export function buildZellijAttachBgArgs(session: string): string[] {
  return ["zellij", "attach", "-b", "--forget", session];
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
 * routes to `attach -b --forget`, which FORGETS the saved session
 * and mints a fresh one (rather than resurrecting the degraded
 * `session-layout.kdl` cache, which produced fn-675's bar-less mint).
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
 * Internal: does this `new-tab` stderr mean the target session is gone
 * (rather than some other failure)? zellij prints `Session '<name>' not
 * found. The following sessions are active:` when the session vanished,
 * and `There is no active session!` against an EXITED corpse. Either
 * signature means "re-mint and retry" — any other non-zero exit is a
 * real launch failure we surface as-is. ANSI-tolerant via case-
 * insensitive substring match.
 */
function looksLikeSessionGone(stderr: string): boolean {
  return /not found/i.test(stderr) || /no active session/i.test(stderr);
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
  const session = deps.session ?? DEFAULT_ZELLIJ_SESSION;
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
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
    try {
      const proc = spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        ...(env != null ? { env } : {}),
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

  /**
   * Session-parameterized get-or-create. Shared between the managed
   * `ensureSession` memo (called with the construction `session`) and
   * the per-call `ensureLaunched` path (called with the caller's
   * target session). Mirrors the original ensureSession control flow
   * exactly — list-sessions probe, `attach -b --forget` mint when
   * absent/EXITED, color-capable env on the mint spawn, ~50ms poll
   * up to 5s, fresh-mint default-tab id capture — but returns the
   * captured orphan-tab id (null when the session pre-existed or the
   * list-tabs capture failed) instead of mutating the closure's
   * memoized `pendingOrphanTabId`. The two callers own their own
   * orphan-reap state: the managed `launch` path stashes into the
   * closure's one-shot field (cleared after first reap); the
   * `ensureLaunched` path keeps the id local to the call. NEVER
   * throws — every failure mode (binary missing, mint timeout)
   * degrades to a noteLine warn + null orphan id, and the caller
   * proceeds with the new-tab spawn (which will then fail honestly
   * if the session truly never came up).
   */
  async function ensureSessionFor(
    targetSession: string,
  ): Promise<{ orphanTabId: string | null }> {
    // Probe first — a session already listed is the steady state.
    const listed = await runCapture(buildZellijListSessionsArgs());
    if (listed == null) {
      deps.noteLine(
        `# warn: zellij list-sessions failed (binary missing?); subsequent launches will no-op`,
      );
      return { orphanTabId: null };
    }
    if (zellijSessionListed(listed.stdout, targetSession)) {
      // Pre-existing live session — never `--forget` it, never reap a
      // default tab (there isn't one we minted).
      return { orphanTabId: null };
    }
    // Not listed (absent OR EXITED corpse) — fire
    // `attach -b --forget <session>` to FORGET any saved/serialized
    // session and mint a fresh detached background session, then
    // poll `list-sessions` until it appears. `--forget` defeats the
    // bar-less resurrection from a degraded `session-layout.kdl`
    // cache (fn-675); it is a harmless no-op when nothing is saved.
    //
    // The zellij server inherits THIS spawn's env, and every pane it
    // later launches inherits the server's. keeperd runs as a
    // LaunchAgent whose env is stripped to `PATH` (no `TERM`/
    // `COLORTERM`), so a session minted here would render every worker
    // pane colorblind. Carry color-capable defaults — preserving a real
    // terminal's values on the off chance one exists (tests, a future
    // non-LaunchAgent run) — so the autopilot worker's `claude` TUI
    // shows color. Spread `process.env` first to keep `PATH` et al.
    await runCapture(buildZellijAttachBgArgs(targetSession), {
      ...(process.env as Record<string, string>),
      TERM: process.env.TERM ?? "xterm-256color",
      COLORTERM: process.env.COLORTERM ?? "truecolor",
    });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const probe = await runCapture(buildZellijListSessionsArgs());
      if (probe != null && zellijSessionListed(probe.stdout, targetSession)) {
        // Freshly minted: capture the default `Tab #1` id so the first
        // launch can reap it once the agent tab exists. Best-effort —
        // a missing/unparsable list returns null and we simply keep
        // the default tab.
        const tabs = await runCapture(buildZellijListTabsArgs(targetSession));
        if (tabs != null) {
          return { orphanTabId: firstTabIdFromListTabs(tabs.stdout) };
        }
        return { orphanTabId: null };
      }
      await delay(50);
    }
    deps.noteLine(
      `# warn: zellij session "${targetSession}" never appeared in list-sessions after 5s; new-tab may no-op`,
    );
    return { orphanTabId: null };
  }

  function ensureSession(): Promise<void> {
    if (sessionReady != null) {
      return sessionReady;
    }
    sessionReady = (async () => {
      const { orphanTabId } = await ensureSessionFor(session);
      // Stash for the FIRST `launch` to reap one-shot after the agent
      // tab lands. A pre-existing session returns null; a failed mint
      // also returns null.
      pendingOrphanTabId = orphanTabId;
    })();
    return sessionReady;
  }

  /**
   * Shared `list-panes -a -j` -> Set<tab_name> primitive. Used by
   * both `tabExistsByName(name)` (the spec-required per-name probe)
   * and `liveTabNames()` (the bulk variant the autopilot reconciler's
   * snapshot loader uses to populate `liveTabKeys` in a single
   * round-trip per cycle, fn-674). NEVER throws — every failure
   * mode (ENOENT, non-zero exit, unparseable JSON, missing
   * tab_name field on a pane) degrades to a partial / empty set.
   * No `ensureSession` call: a missing session means there is by
   * definition no tab to find, and minting a session inside a
   * dedup probe would be a surprising side effect.
   */
  async function liveTabNamesImpl(): Promise<Set<string>> {
    const res = await runCapture(buildZellijListPanesAllJsonArgs(session));
    if (res == null) {
      return new Set();
    }
    if (res.exitCode !== 0) {
      return new Set();
    }
    const payload = parseListPanesJson(res.stdout);
    if (payload == null) {
      return new Set();
    }
    const names = new Set<string>();
    const collect = (raw: unknown, tabNameHint?: string): void => {
      if (raw == null || typeof raw !== "object") {
        return;
      }
      const rec = raw as Record<string, unknown>;
      const tabNameField =
        typeof rec.tab_name === "string" ? rec.tab_name : undefined;
      const name = tabNameField ?? tabNameHint;
      if (name != null && name !== "") {
        names.add(name);
      }
    };
    if (Array.isArray(payload)) {
      for (const entry of payload) {
        collect(entry);
      }
    } else if (payload != null && typeof payload === "object") {
      // Object-map shape: `{ "tab_name_1": [pane, pane], ... }` — the
      // tab name comes from the key when the pane object lacks it.
      // Mirrors `findPaneByTabName`'s tolerance for both observed
      // zellij JSON shapes.
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
    return names;
  }

  return {
    async launch(
      argv: string[],
      name: string,
      cwd: string,
    ): Promise<LaunchResult> {
      await ensureSession();
      const args = buildZellijNewTabArgs(session, cwd, argv, name);
      let res = await runCapture(args);
      // The memoized session can die out from under us — zellij exits a
      // session when its last tab closes, and a reboot/kill drops it too.
      // A stale `sessionReady` memo would then wedge EVERY future dispatch
      // ("Session '<name>' not found") until the daemon restarts. On a
      // session-gone new-tab failure, invalidate the memo, re-ensure
      // (which re-mints via `attach -b --forget` + poll, re-capturing
      // any orphan default tab), and retry the new-tab exactly once.
      // The success
      // path keeps the memo untouched (one list-sessions per worker life).
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
    async tabExistsByName(name: string): Promise<boolean> {
      // Session-bound — operates against the managed `session`. We
      // deliberately DO NOT call `ensureSession` here: a missing
      // session means there is by definition no tab to find, and
      // minting a session inside a dedup probe would be a surprising
      // side effect. The probe degrades to `false` on every failure
      // mode — ENOENT, non-zero exit, unparseable JSON — and NEVER
      // throws back, so the autopilot reconciler's per-cycle
      // snapshot load can treat the call as best-effort information.
      const names = await liveTabNamesImpl();
      // `single` OR `multiple` both mean "name occupies the surface";
      // only `none` is "no tab" — the multiple case is "shouldn't
      // happen" (dedup invariant violated) but is just as conclusive
      // about occupation. closeByName's "refuse to guess" semantics
      // are for the REAP path, not this probe.
      return names.has(name);
    },
    liveTabNames: liveTabNamesImpl,
    async focusPane(
      targetSession: string,
      paneId: string,
    ): Promise<LaunchResult> {
      // Session-agnostic — operates on already-live external sessions.
      // No `ensureSession` call: a missing session degrades to a
      // non-zero exit and we surface `{ ok: false, error }` rather than
      // minting a session we'd never use again.
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
    async resolveTabForPane(
      targetSession: string,
      paneId: string,
    ): Promise<ResolvedTabCoords | null> {
      // Session-agnostic. NEVER throws — returns null on ENOENT /
      // non-zero exit / unparseable JSON / zero / multiple matches.
      // The caller (the daemon tab-resolver worker) treats null as
      // "no snapshot; leave the existing tab columns alone."
      const res = await runCapture(
        buildZellijListPanesAllJsonArgs(targetSession),
      );
      if (res == null) {
        return null;
      }
      if (res.exitCode !== 0) {
        return null;
      }
      const payload = parseListPanesJson(res.stdout);
      if (payload == null) {
        return null;
      }
      const match = findPaneById(payload, paneId);
      if (match.found !== "single") {
        return null;
      }
      return {
        tab_id: match.pane.tab_id ?? null,
        tab_name: match.pane.tab_name,
        tab_position: match.pane.tab_position ?? null,
      };
    },
    async ensureLaunched(
      targetSession: string,
      argv: string[],
      cwd: string,
      name?: string,
    ): Promise<LaunchResult> {
      // Session-agnostic get-or-create + launch. Mirrors `launch`'s
      // shape (ensure → new-tab → orphan reap → session-gone single
      // retry) but parameterized by `targetSession` and with all
      // session-state local — no `sessionReady` memo, no
      // `pendingOrphanTabId` clobber. The orphan id captured here
      // belongs to THIS mint; the per-call closure reaps it after
      // the agent tab lands and discards the binding when the
      // method returns. A pre-existing session returns
      // `orphanTabId: null` from `ensureSessionFor`, so the reap is
      // skipped — only freshly-minted sessions ever leave a default
      // `Tab #1` to clean up.
      let { orphanTabId } = await ensureSessionFor(targetSession);
      const args = buildZellijNewTabArgs(targetSession, cwd, argv, name);
      let res = await runCapture(args);
      // Session can die between ensure and new-tab (an OS reboot, a
      // last-tab close, a manual kill). One-shot re-ensure + retry on
      // the matching stderr signatures. The re-ensure is a fresh
      // probe → mint cycle (no memo to invalidate), and any orphan
      // captured on the retry mint REPLACES the original — that's the
      // tab we then reap below. Any other non-zero exit is a real
      // launch failure surfaced as-is.
      if (
        res != null &&
        res.exitCode !== 0 &&
        looksLikeSessionGone(res.stderr)
      ) {
        deps.noteLine(
          `# warn: zellij session "${targetSession}" vanished mid-ensureLaunched; re-minting and retrying new-tab`,
        );
        const retry = await ensureSessionFor(targetSession);
        orphanTabId = retry.orphanTabId;
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
      // Per-call orphan reap. Only fires when ensureSessionFor MINTED
      // the session this call (pre-existing sessions return
      // orphanTabId=null). Done after the agent tab is confirmed so
      // the session never drops to zero tabs (which would exit it).
      if (orphanTabId != null) {
        await runCapture(buildZellijCloseTabArgs(targetSession, orphanTabId));
      }
      return { ok: true };
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
