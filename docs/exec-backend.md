# The backend exec API

`ExecBackend` (`src/exec-backend.ts`) is keeper's single seam over
terminal-surface spawn mechanics. One implementation exists — **tmux** —
and every consumer goes through the narrow `ExecBackend` interface so the
multiplexer's subprocess plumbing lives in one place and tests can inject a
fake `spawn` to assert argv construction without launching real processes.

This document orients a developer working *on* or *against* the backend.
The module itself is heavily comment-documented; read it for the
exact wording of any contract, and read this for the shape of the whole.

> **Outside the seam:** `keeper setup-tmux` (`cli/setup-tmux.ts`) deliberately
> drives tmux directly via `Bun.spawnSync`, NOT through `ExecBackend`. It is an
> experimental one-shot provisioner whose lifecycle is unrelated to the managed
> dispatch ops; it reuses only the pure exports `localeDefaultedEnv` and
> `MANAGED_EXEC_SESSION` read-only. The `ExecBackend` API stays stable for it.

## Overview

The backend is a **factory, not a singleton** — `createTmuxBackend(...)`
returns an `ExecBackend` with no top-level side effects, and
`resolveExecBackend({ ... })` is the single stable entry point every call
site goes through. Production constructs one inside the autopilot reconciler
worker; the `keeper jobs` CLI and the `restore-agents.ts` replay construct
their own. Tests pass a capturing `spawn` fake.

```ts
const backend = resolveExecBackend({
  noteLine: (line) => log(line),   // lifecycle sidecar sink
  session: "autopilot",            // managed session for launch()
});
```

- `noteLine` is the only output sink — warnings and launch stderr flow
  there. The backend never writes the event log or the DB.
- `session` is the **managed** session name baked in for the
  session-bound ops. It defaults to `MANAGED_EXEC_SESSION` (`"autopilot"`),
  so a consumer touching only the session-agnostic ops can construct with
  just `{ noteLine }`.
- `spawn` defaults to `Bun.spawn`; inject a fake in tests.
- `backendType` is accepted on `resolveExecBackend` but advisory: every tag
  — including unknown, NULL, and legacy tags carried by historical job rows —
  resolves to the tmux backend, which never throws on an unrecognized tag.

`resolveExecBackend(deps)` is the single stable entry point — call sites
(the reconciler dispatch, the jobs-board focus path, the restore replay)
keep one seam.

## The two op categories

The port carries two intentionally distinct op categories that share one
factory:

| Op | Category | Consumer | Session source |
|---|---|---|---|
| `launch(argv, name, cwd)` | session-bound lifecycle | autopilot reconciler | baked in at construction |
| `focusPane(session, paneId)` | session-agnostic | `keeper jobs` `v` key | per call |
| `ensureLaunched(session, argv, cwd, name?)` | session-agnostic | `restore-agents.ts` replay | per call |
| `listPanes()` | session-agnostic | renamer worker | per call (`-a`, whole server) |
| `renameWindow(windowId, name)` | session-agnostic | renamer worker | per call |
| `killWindow(paneId)` | session-agnostic | reaper worker | per call (`%N` pane id) |

**Session-bound** ops drive the reconciler against the ONE managed
session passed at construction. There is no ensure memo — each op runs a
cheap per-call `has-session` probe before `new-window`, so a session that
died out from under us is rebuilt on the next op with no stale-memo wedge.
The contract is "I own this session and put agent windows into it."

**Session-agnostic** ops take the target session *per call* and operate
on (or get-or-create) arbitrary external sessions. `focusPane` runs no
session-ensure at all, and `ensureLaunched` runs its own per-call
get-or-create.

**`killWindow(paneId)` removes a dispatched window.** Its sole caller is
the reaper worker, which kills the window of an autopilot-dispatched job
whose work is verifiably complete (stopped past its grace window with a
`completed` readiness verdict). The op targets by pane id (`%N`): tmux
resolves it upward to the owning window and removes every pane in it — the
wanted semantics for one-pane managed windows, and a stable `%N` handle
the concurrent renamer worker cannot redirect. Killing the last window
kills the managed session, which the next dispatch re-mints via
get-or-create. The op writes nothing to the DB and its return is not the
truth of the row's death — the exit-watcher's synthetic `Killed` mint is.
A nonzero "can't find window" is the expected TOCTOU no-op (the window
already closed) returned as `{ ok: false }` without noise.

## Public surface

Every op returns a plain envelope and **never throws** — a missing binary
(tmux not on PATH) and non-zero exits collapse into a
`{ ok: false, error }` result the caller can `await` and pattern-match. This
keeps the backend safe to call from inside the workers' no-self-heal
try/catch boundaries.

```ts
type LaunchResult = { ok: true } | { ok: false; error: string };
```

### `launch(argv, name, cwd) → LaunchResult`

Spawn an agent in a new window at `cwd` inside the managed session. The
backend ensures the managed session (per-call `has-session` probe → mint
when absent) then runs `tmux new-window`. `argv` is passed across the OS
argv boundary with no shell layer — the safe quoting seam, no injection
surface. `cwd` MUST be absolute.

**No pane id is captured or returned.** The multiplexer is stateless from
autopilot's side — the only durable spawn signal is the projection edge
(see [How dispatch correlates back](#how-dispatch-correlates-back)). The
`name` argument is *not* forwarded to the window label (epic fn-711); it
feeds the warn/log lines and is the autopilot dedup key only. (A separate
window-naming system is planned later; `launch` keeps its unused `name` arg
as that seam.)

### `focusPane(session, paneId) → LaunchResult`

Session-agnostic. Focuses `paneId` in an already-live external `session`
via `select-window`/`select-pane` by pane id (the server-global `%N`
handle — never name-based, since colons in session/window names break
target parsing). No session-ensure runs; a missing session/pane degrades to
`{ ok: false }`.

### `ensureLaunched(session, argv, cwd, name?) → LaunchResult`

Session-agnostic get-or-create + launch. Get-or-creates the target
`session` (mint only when absent) then launches `argv` in a new window at
`cwd` inside it. `name` is optional and unset on the restore path (no label
— the Chrome-style restore-previous-session model emits no `verb::id`
label). Shares NO state with the managed session; the mint is per-call.
`restore-agents.ts` is the consumer, routing every restore bucket through
this one backend regardless of the legacy `backend` tag the bucket carries.

### `listPanes() → PaneInfo[] | null`

Session-agnostic. One `tmux list-panes -a` sweep across every session on the
server, parsed into `{ paneId, windowId, windowName }` rows. The format is
tab-delimited with `window_name` **last** and the parse splits on only the
first two tabs, so a tab inside an arbitrary window name cannot corrupt the
pane/window fields; malformed lines are dropped. A degraded or missing tmux
(non-zero exit / ENOENT) degrades to `null` — the renamer worker skips that
cycle. The window-naming worker is the consumer.

### `renameWindow(windowId, name) → LaunchResult`

Session-agnostic. Renames window `windowId` (the server-global `@N` handle —
never name-based) to `name` via `rename-window -t <id> -- <name>`. The `--` is
load-bearing: window names are arbitrary user text and may start with `-`,
which tmux's own parser would otherwise read as an option. A nonzero "can't
find window" exit is an expected TOCTOU no-op (the window closed between sweep
and rename) returned as `{ ok: false }` with no `noteLine` noise.

## How dispatch correlates back

`launch` returns no surface ref, no pane id — by design. The reconciler
correlates a dispatch back to keeperd through the **`--name verb::id`**
baked into `argv` (`claude … --arthack-no-confirm --name work::fn-1-x.1 …`;
the `--arthack-no-confirm` arthack-launcher flag is stripped before the real
claude binary and suppresses its cwd confirmation so dispatch never hangs):

```
launch(argv with --name work::fn-1-x.1)
   → SessionStart hook event
   → jobs projection edge        ← the durable dispatch-correlation signal
```

A `jobs` row is minted by ONE of two paths: an autopilot/normal session's
**SessionStart** (the dispatch-correlation edge above), or — for a
`claude --fork-session` session, which gets a fresh session id and emits NO
SessionStart of its own — the **first pid-bearing `UserPromptSubmit`** (the
fork-attribution seed in `projectJobsRow`). SessionStart remains the only
signal the reconciler correlates a dispatch against; the fork seed produces a
standalone job with no dispatch lineage.

The launch → SessionStart blind window (the worker has launched but its
`SessionStart` has not yet folded, so it owns no `jobs` row) is tracked
durably by the **`pending_dispatches`** projection, which both serves
launch-window dedup and feeds `computeReadiness` as the
`dispatch-pending` occupant. The reconciler awaits main's durable
`Dispatched` insert *before* calling `launch` (outbox ordering — intent
committed before the side-effect), so a crash between ack and launch
leaves only a phantom row the TTL sweep clears. fn-762: main replies that
ack the instant the INSERT commits (it promises INSERT durability only),
then pumps the reducer afterward in a guarded block — so the ack timing is
independent of fold latency while outbox ordering stays unchanged.

The window **name is purely cosmetic** — no control path ever reads it
back. Correlation is the projection edge, full stop.

## Session ensure & resilience

The backend keeps NO ensure memo. Every op — the managed `launch` and the
per-call `ensureLaunched` alike — runs a cheap `has-session -t '=<session>'`
probe (the `=` prefix forces an EXACT match; tmux -f /dev/null otherwise does an fnmatch
glob + prefix match, so `auto` would spuriously match `autopilot`) and mints
via `new-session -d -s <session> -e KEEPER_TMUX_SESSION=<session>` only when
the probe reports the session absent. A session-gone `new-window` failure
surfaces `{ ok: false }` directly — the next op's probe absorbs the
dead-session race, so there is no re-ensure and no retry to wedge on a stale
memo.

The `-e` injection is process-scoped so the session's panes inherit
`KEEPER_TMUX_SESSION` — never `set-environment`, which is visible to every
attached client. Window launches re-inject `-e KEEPER_TMUX_SESSION` so the
session name rides the same hook-read column on every new window's pane.

**Color-capable env on the mint spawn.** keeperd runs as a LaunchAgent
whose env is stripped to `PATH` (no `TERM`/`COLORTERM`). The tmux server
inherits the mint spawn's env, and every pane it later launches inherits the
server's — so the mint carries `TERM`/`COLORTERM` defaults (preserving any
real terminal's values) so the worker `claude` TUI shows color. This is the
*only* control command that sets a child env.

**Truecolor under tmux + the pane-id carrier.** Claude Code self-caps to
256 colors whenever `$TMUX` is set (ink2 renderer, since v2.1.77), so the
interactive launcher claudewrap deletes `TMUX`/`TMUX_PANE` from the Claude
child env to let it emit 24-bit truecolor. But `$TMUX` is also what the hook
keys off to stamp the pane id the renamer worker needs. To keep both,
claudewrap copies the pane id into the keeper-owned carrier `KEEPER_TMUX_PANE`
*before* deleting the native vars, and `backendExecCoordsFromEnv` grows a
fallback arm: when native `TMUX` is absent but the carrier is present it stamps
coord-identical `{type:"tmux", paneId, sessionId}` rows from the carrier (and
`KEEPER_TMUX_SESSION`). The carrier name is defined once, in
`execBackendEnvMeta(...).paneIdCarrierEnvVar`; claudewrap holds a matching
literal guarded by a cross-reference comment (no shared module across repos).
The fallback is inert until something sets the carrier, so keeper ships first.

**Bounded subprocess await.** Every `runCapture` races `proc.exited`
against a 5s kill-timeout: a wedged tmux subprocess would otherwise freeze the
reconciler forever (no fatalExit covers that path), so on expiry the child
is force-killed and the op degrades to `null` (it retries next cycle). The
unit is MILLISECONDS — never compared against the unit-seconds autopilot
cooldowns; tests shrink it via `captureTimeoutMs` to pin the kill-degrade
path without a real 5s wait.

## Pure helpers reference

The module exports its argv builders as pure functions so tests assert them
in isolation and the runtime composes them:

| Helper | Purpose |
|---|---|
| `buildTmuxHasSessionArgs(session)` | `has-session -t '=<session>'` exact-match probe |
| `buildTmuxNewSessionArgs(session)` | `new-session -d -s <session> -e KEEPER_TMUX_SESSION=<session>` — session mint |
| `buildTmuxNewWindowArgs(session, dir, argv, name?)` | `new-window` argv (`-e KEEPER_TMUX_SESSION` re-injection, optional `-n <name>` label; inherits the global `remain-on-exit off` so the window closes natively on full-tree exit) |
| `buildTmuxSelectWindowArgs(paneId)` | `select-window` by pane id — focus |
| `buildTmuxSelectPaneArgs(paneId)` | `select-pane` by pane id — focus |
| `buildTmuxListPanesArgs()` | `list-panes -a -F '#{pane_id}\t#{window_id}\t#{window_name}'` — server-wide pane sweep (tab-delimited, name last) |
| `buildTmuxRenameWindowArgs(windowId, name)` | `rename-window -t <windowId> -- <name>` — `--`-guarded window rename by `@N` id |
| `execBackendEnvMeta(backendType?)` | hook env-var names (`KEEPER_TMUX_SESSION` / `TMUX_PANE`, plus the `paneIdCarrierEnvVar` carrier `KEEPER_TMUX_PANE`) |

## Extending to a new backend

The seam for a second backend (wezterm, kitty, …) survives the
single-backend collapse — three steps:

1. Implement the `ExecBackend` interface (`launch`, `focusPane`,
   `ensureLaunched`, `listPanes`, `renameWindow`) over the new mechanism,
   exporting pure argv builders for the tests.
2. Teach `execBackendEnvMeta(backendType)` the new backend's
   `backend_exec_type`, session-id, pane-id, and pane-id-carrier env-var
   names. This is the single source of truth for the env vars the **hook**
   reads on every event — including the `paneIdCarrierEnvVar` fallback-read
   key the hook consults when the native pane-id var is stripped. Funnelling
   the literals through this seam keeps the hook backend-agnostic so it never
   learns new keys.
3. Branch `resolveExecBackend(deps)` on backend type to construct the new
   factory, and add the tag to `VALID_EXEC_BACKENDS` in `db.ts` so the
   config parser accepts it. Call sites already go through the resolver, so
   they need no structural change.

The `DEFAULT_EXEC_BACKEND` (`"tmux"`) and `MANAGED_EXEC_SESSION`
(`"autopilot"`) consts are exported so the lockstep `db.ts` site and tests
share one source of truth.
