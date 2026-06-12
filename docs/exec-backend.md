# The backend exec API

`ExecBackend` (`src/exec-backend.ts`) is keeper's single seam over
terminal-surface spawn mechanics. Two implementations exist — **zellij**
(the default) and **tmux** — and every consumer goes through the narrow
`ExecBackend` interface so each multiplexer's subprocess plumbing lives in
one place and tests can inject a fake `spawn` to assert argv construction
without launching real processes.

This document orients a developer working *on* or *against* the backend.
The module itself is heavily comment-documented; read it for the
exact wording of any contract, and read this for the shape of the whole.

## Overview

The backend is a **factory, not a singleton** — `createZellijBackend(...)`
and `createTmuxBackend(...)` each return an `ExecBackend` with no top-level
side effects, and `resolveExecBackend({ backendType, ... })` picks between
them by tag (`"tmux"` → tmux, anything else → zellij). Production
constructs one inside the autopilot reconciler worker (backend type resolved
from the `exec_backend` config key); the `keeper jobs` CLI and the
`restore-agents.ts` replay construct their own. Tests pass a capturing
`spawn` fake.

```ts
const backend = resolveExecBackend({
  backendType: "tmux",             // "zellij" (default) | "tmux"
  noteLine: (line) => log(line),   // lifecycle sidecar sink
  session: "autopilot",            // managed session for launch()
});
```

- `backendType` selects the impl. Absent / unknown values fall through to
  zellij (the `DEFAULT_EXEC_BACKEND`).
- `noteLine` is the only output sink — warnings and launch stderr flow
  there. The backend never writes the event log or the DB.
- `session` is the **managed** session name baked in for the
  session-bound ops. It defaults to `MANAGED_EXEC_SESSION` (`"autopilot"`),
  so a consumer touching only the session-agnostic ops can construct with
  just `{ noteLine }`.
- `spawn` defaults to `Bun.spawn`; inject a fake in tests.

`resolveExecBackend(deps)` is the single stable entry point — call sites
(the reconciler dispatch, the jobs-board focus path, the restore replay)
keep one seam across both backends.

## The two op categories

The port carries two intentionally distinct op categories that share one
factory per backend:

| Op | Category | Consumer | Session source |
|---|---|---|---|
| `launch(argv, name, cwd)` | session-bound lifecycle | autopilot reconciler | baked in at construction |
| `focusPane(session, paneId)` | session-agnostic | `keeper jobs` `v` key | per call |
| `ensureLaunched(session, argv, cwd, name?)` | session-agnostic | `restore-agents.ts` replay | per call |

**Session-bound** ops drive the reconciler against the ONE managed
session passed at construction; session-ensure is memoized once per
backend instance. The contract is "I own this session and put agent
windows into it."

**Session-agnostic** ops take the target session *per call* and operate
on (or get-or-create) arbitrary external sessions. They share no memo or
ensure state with the managed session — `focusPane` runs no session-ensure
at all, and `ensureLaunched` runs its own per-call get-or-create.

**keeper never closes a window.** There is no reap op on the interface;
every dispatched window stays open until the human closes it. (The fn-724
pause reap and fn-727 completion reap, and their `reapSurfaces` op, were
deleted outright in epic fn-789.)

## Public surface

Every op returns a plain envelope and **never throws** — a missing binary
(zellij/tmux not on PATH) and non-zero exits collapse into a
`{ ok: false, error }` result the caller can `await` and pattern-match. This
keeps the backend safe to call from inside the workers' no-self-heal
try/catch boundaries.

```ts
type LaunchResult = { ok: true } | { ok: false; error: string };
```

### `launch(argv, name, cwd) → LaunchResult`

Spawn an agent in a new window at `cwd` inside the managed session. The
zellij backend runs `zellij action new-tab --cwd <abs> -- <argv>`; the tmux
backend runs `tmux new-window` (ensuring the managed session first). `argv`
is passed across the OS argv boundary with no shell layer — the safe quoting
seam, no injection surface. `cwd` MUST be absolute.

**No pane id is captured or returned.** The multiplexer is stateless from
autopilot's side — the only durable spawn signal is the projection edge
(see [How dispatch correlates back](#how-dispatch-correlates-back)). The
`name` argument is *not* forwarded to the window label (epic fn-711); it
feeds the warn/log lines and is the autopilot dedup key only. (A separate
window-naming system is planned later; `launch` keeps its unused `name` arg
as that seam.)

### `focusPane(session, paneId) → LaunchResult`

Session-agnostic. Focuses `paneId` in an already-live external `session`
(zellij `action focus-pane-id` switches focused pane AND active tab in one
shot; tmux `select-window`/`select-pane` by pane id). No session-ensure runs;
a missing session degrades to `{ ok: false }`.

### `ensureLaunched(session, argv, cwd, name?) → LaunchResult`

Session-agnostic get-or-create + launch. Get-or-creates the target
`session` (mint only when absent/EXITED) then launches `argv` in a new
window at `cwd` inside it. `name` is optional and unset on the restore path
(no label — the Chrome-style restore-previous-session model emits no
`verb::id` label). Shares NO state with the managed session memo; the mint
and session-gone retry are all per-call. `restore-agents.ts` is the consumer,
routing each restore bucket through the backend its `backend` tag names.

## How dispatch correlates back

`launch` returns no surface ref, no pane id — by design. The reconciler
correlates a dispatch back to keeperd through the **`--name verb::id`**
baked into `argv` (`claude … --arthack-no-confirm --name work::fn-1-x.1 …`;
the `--arthack-no-confirm` arthack-launcher flag is stripped before the real
claude binary and suppresses its cwd confirmation so dispatch never hangs):

```
launch(argv with --name work::fn-1-x.1)
   → SessionStart hook event
   → jobs projection edge        ← the only durable spawn signal
```

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

The managed session is ensured lazily and memoized once (a shared
`Promise<void>` across every `launch`). The ensure path is shared between
the managed memo and the per-call `ensureLaunched`.

**Zellij** mints via `zellij attach -b --forget <session>`: `-b` creates a
detached background session; `--forget` deletes any saved/serialized session
first, so a stale corpse is fresh-rebuilt rather than resurrected from a
degraded `session-layout.kdl` cache (the root-cause fix for fn-675's bar-less
mint). It probes `list-sessions`, mints only when absent OR an EXITED corpse,
polls until the session appears (beating zellij issue #3733, where
`action new-tab` against a not-yet-ready server can silently no-op), and
captures the freshly-minted session's empty default tab so the first launch
reaps it (after the agent window lands, so the session never drops to zero
windows and exits).

**Tmux** probes `has-session` (`-t '=<session>'` exact match — never a glob)
and mints via `new-session -d -s <session> -e KEEPER_TMUX_SESSION=<session>`.
The `-e` injection is process-scoped so the session's panes inherit
`KEEPER_TMUX_SESSION` — never `set-environment`, which is visible to every
attached client. Window launches re-inject `-e KEEPER_TMUX_SESSION` so the
session name rides the same hook-read column as zellij's.

**Color-capable env on the mint spawn.** keeperd runs as a LaunchAgent
whose env is stripped to `PATH` (no `TERM`/`COLORTERM`). The multiplexer
server inherits the mint spawn's env, and every pane it later launches
inherits the server's — so the mint carries `TERM`/`COLORTERM` defaults
(preserving any real terminal's values) so the worker `claude` TUI shows
color. This is the *only* control command that sets a child env.

**Session-gone single-retry (zellij only).** Zellij's memoized session can
die out from under us. On a `new-tab` failure whose stderr looks like the
session vanished, the zellij `launch` invalidates the memo, re-ensures
(re-mints), and retries exactly once; the success path leaves the memo
untouched, and `ensureLaunched` mirrors this with per-call state instead of
a memo. **Tmux does NOT take this path.** It keeps no ensure memo — every op
runs a cheap per-call `has-session` probe before `new-window`, so a
session-gone `new-window` failure surfaces `{ ok: false }` directly with no
re-ensure and no retry (the probe already absorbs a dead-session race).

## Pure helpers reference

The module exports its argv builders and parsers as pure functions so
tests assert them in isolation and the runtime composes them:

| Helper | Purpose |
|---|---|
| `buildWorkerCommand(verb, id, dir)` | dispatch `claude` shell command (`--arthack-no-confirm` then `--name verb::id`) |
| `buildResumeCommand(cwd, target, tier)` | resume `claude --resume "<target>" --arthack-no-confirm` |
| `buildZellijNewTabArgs(session, dir, argv, name?)` | `action new-tab` argv (omits `--name` when empty) |
| `buildZellijCloseTabArgs(session, windowId)` | `action close-tab-by-id` — orphan default-tab reap |
| `buildZellijListSessionsArgs()` | `list-sessions` |
| `buildZellijListTabsArgs(session)` | `action list-tabs` — capture default tab id |
| `buildZellijFocusPaneArgs(session, paneId)` | `action focus-pane-id` |
| `buildZellijAttachBgArgs(session)` | `attach -b --forget` — session mint |
| `firstTabIdFromListTabs(text)` | first tab id from `list-tabs` (null on unparsable) |
| `buildTmuxHasSessionArgs(session)` | `has-session -t '=<session>'` exact-match probe |
| `buildTmuxNewSessionArgs(session)` | `new-session -d -s <session> -e KEEPER_TMUX_SESSION=<session>` — session mint |
| `buildTmuxNewWindowArgs(session, dir, argv)` | `new-window` argv with `-e KEEPER_TMUX_SESSION` re-injection |
| `buildTmuxSelectWindowArgs(paneId)` | `select-window` by pane id — focus |
| `buildTmuxSelectPaneArgs(paneId)` | `select-pane` by pane id — focus |
| `execBackendEnvMeta(backendType)` | hook env-var names for a backend (zellij / tmux) |

## Extending to a new backend

`createTmuxBackend` is the worked example of a second backend; a third
(wezterm, kitty, …) follows the same three steps:

1. Implement the `ExecBackend` interface (`launch`, `focusPane`,
   `ensureLaunched`) over the new mechanism, exporting pure argv builders
   for the tests.
2. Teach `execBackendEnvMeta(backendType)` the new backend's
   `backend_exec_type`, session-id, and pane-id env-var names. This is the
   single source of truth for the env vars the **hook** reads on every event
   — funnelling the literals through this seam keeps the hook
   backend-agnostic so it never learns new keys.
3. Branch `resolveExecBackend(deps)` on backend type, and add the tag to
   `VALID_EXEC_BACKENDS` in `db.ts` so the config parser accepts it. Call
   sites already go through the resolver, so they need no structural change.

The `DEFAULT_EXEC_BACKEND` (`"zellij"`) and `MANAGED_EXEC_SESSION`
(`"autopilot"`) consts are exported so the lockstep `db.ts` site and tests
share one source of truth.
