# The backend exec API

`ExecBackend` (`src/exec-backend.ts`) is keeper's single seam over
terminal-surface spawn mechanics. Today there is exactly one
implementation — zellij — but every consumer goes through the narrow
`ExecBackend` interface so the zellij subprocess plumbing lives in one
place and tests can inject a fake `spawn` to assert argv construction
without launching real processes.

This document orients a developer working *on* or *against* the backend.
The module itself is heavily comment-documented; read it for the
exact wording of any contract, and read this for the shape of the whole.

## Overview

The backend is a **factory, not a singleton** — `createZellijBackend({
noteLine, session?, spawn? })` returns an `ExecBackend` with no
top-level side effects. Production constructs it once inside the
autopilot reconciler worker; the `keeper jobs` CLI and the
`restore-agents.ts` replay construct their own. Tests pass a capturing
`spawn` fake.

```ts
const backend = resolveExecBackend({
  noteLine: (line) => log(line),   // lifecycle sidecar sink
  session: "autopilot",            // managed session for launch()
});
```

- `noteLine` is the only output sink — warnings, launch stderr, and reap
  notes flow there. The backend never writes the event log or the DB.
- `session` is the **managed** session name baked in for the
  session-bound ops. It defaults to `DEFAULT_ZELLIJ_SESSION`
  (`"autopilot"`), so a consumer touching only the session-agnostic ops
  can construct with just `{ noteLine }`.
- `spawn` defaults to `Bun.spawn`; inject a fake in tests.

`resolveExecBackend(deps)` is a thin resolver kept as a stable entry
point — it always returns a zellij backend today, but call sites and a
future alternative backend keep one seam.

## The two op categories

The port carries two intentionally distinct op categories that share one
factory and one set of zellij subprocess plumbing:

| Op | Category | Consumer | Session source |
|---|---|---|---|
| `launch(argv, name, cwd)` | session-bound lifecycle | autopilot reconciler | baked in at construction |
| `reapSurfaces(predicate)` | session-bound | autopilot pause/boot reap (fn-724) | baked in at construction |
| `focusPane(session, paneId)` | session-agnostic | `keeper jobs` `v` key | per call |
| `ensureLaunched(session, argv, cwd, name?)` | session-agnostic | `restore-agents.ts` replay | per call |

**Session-bound** ops drive the reconciler against the ONE managed
session passed at construction; session-ensure is memoized once per
backend instance. The contract is "I own this session and put agent
panes into it."

**Session-agnostic** ops take the target session *per call* and operate
on (or get-or-create) arbitrary external sessions. They share no memo or
orphan-reap state with the managed session — `focusPane` runs no
session-ensure at all, and `ensureLaunched` runs its own per-call
get-or-create.

## Public surface

Every op returns a plain envelope and **never throws** — ENOENT (zellij
binary missing) and non-zero exits collapse into a `{ ok: false, error }`
result the caller can `await` and pattern-match. This keeps the backend
safe to call from inside the workers' no-self-heal try/catch boundaries.

```ts
type LaunchResult = { ok: true } | { ok: false; error: string };

interface ReapResult {
  examined: number;          // terminal panes the snapshot returned
  reaped: number;            // predicate-selected panes closed ok
  failed: number;            // predicate-selected panes whose close failed
  skippedNoSnapshot: boolean;// list-panes returned null/unparseable
}
```

### `launch(argv, name, cwd) → LaunchResult`

Spawn an agent in a new tab at `cwd` inside the managed session via
`zellij action new-tab --cwd <abs> -- <argv>`. `argv` is passed after
`--` so zellij execs it directly with no shell layer (the OS argv
boundary is the safe quoting seam — no injection surface). `cwd` MUST be
absolute; zellij's `--cwd` does not expand `~`/`$HOME`.

**No pane id is captured or returned.** Zellij is stateless from
autopilot's side — the only durable spawn signal is the projection edge
(see [How dispatch correlates back](#how-dispatch-correlates-back)). The
`name` argument is *not* forwarded to the zellij tab label (epic fn-711);
it feeds the warn/log lines and is the autopilot dedup key only.

### `reapSurfaces(predicate) → ReapResult`

Enumerate every terminal pane in the managed session (`list-panes -a
-j`) and `close-pane -p` each pane the `predicate` selects. Drives the
fn-724 pause/boot-pause reap — cancels launch-window zellij surfaces so a
pre-pause dispatch intent (zellij can exec the new tab seconds-to-minutes
late) cannot escape the pause boundary as a ghost worker. See
[The reap path](#the-reap-path-fn-724).

### `focusPane(session, paneId) → LaunchResult`

Session-agnostic. Runs `zellij --session <session> action
focus-pane-id <paneId>` — on success zellij focuses the pane AND switches
to its tab in one shot. No session-ensure runs (the consumer is operating
on a pane that already exists in some live session); a missing session
degrades to `{ ok: false }`.

### `ensureLaunched(session, argv, cwd, name?) → LaunchResult`

Session-agnostic get-or-create + launch. Get-or-creates the target
`session` (mint only when absent/EXITED) then launches `argv` in a new
tab at `cwd` inside it. `name` is optional and unset on the restore path
(no `--name` on the tab — the Chrome-style restore-previous-session model
emits no `verb::id` label). Shares NO state with the managed session memo
or its orphan-tab tracking; the mint, orphan reap, and session-gone retry
are all per-call.

## How dispatch correlates back

`launch` returns no surface ref, no pane id — by design. The reconciler
correlates a dispatch back to keeperd through the **`--name verb::id`**
baked into `argv` (`claude … --name work::fn-1-x.1 …`):

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

The zellij **tab name is purely cosmetic** — no control path ever reads
it back. Correlation is the projection edge, full stop.

## Session ensure & resilience

The managed session is ensured lazily and memoized once (a shared
`Promise<void>` across every `launch`). The ensure path
(`ensureSessionFor`) is shared between the managed memo and the per-call
`ensureLaunched`:

1. **Probe** `list-sessions`. A session already listed and LIVE is the
   steady state — return immediately, never `--forget` it.
2. **Mint** when absent OR an EXITED corpse: `zellij attach -b --forget
   <session>`. `-b` creates a detached background session; `--forget`
   deletes any saved/serialized session first, so a stale corpse is
   fresh-rebuilt rather than resurrected from a degraded
   `session-layout.kdl` cache (the root-cause fix for fn-675's bar-less
   mint). `--forget` is a harmless no-op when nothing is saved, and the
   live-session short-circuit above means it never runs against a live
   session.
3. **Poll** `list-sessions` (~50ms interval, ~5s cap) until the session
   appears — this beats zellij issue #3733, where `action new-tab`
   against a not-yet-ready server can silently no-op.
4. **Capture the orphan default tab.** A freshly minted session has an
   empty default `Tab #1`; its id is captured so the first successful
   launch reaps it (after the agent tab lands, so the session never drops
   to zero tabs and exits). Pre-existing sessions return no orphan.

**Color-capable env on the mint spawn.** keeperd runs as a LaunchAgent
whose env is stripped to `PATH` (no `TERM`/`COLORTERM`). The zellij
server inherits the mint spawn's env, and every pane it later launches
inherits the server's — so the mint carries `TERM`/`COLORTERM` defaults
(preserving any real terminal's values) so the worker `claude` TUI shows
color. This is the *only* control command that sets a child env.

**Session-gone single-retry.** The memoized session can die out from
under us (zellij exits a session when its last tab closes; a reboot/kill
drops it too). On a `new-tab` failure whose stderr looks like the session
vanished (`not found` / `no active session`), `launch` invalidates the
memo, re-ensures (re-mints + re-captures any orphan tab), and retries the
`new-tab` exactly once. The success path leaves the memo untouched (one
`list-sessions` per worker life). `ensureLaunched` mirrors this with
per-call state instead of a memo.

## The reap path (fn-724, fn-727)

`reapSurfaces` closes a predicate-selected subset of live zellij surfaces.
The shape is shared; the **`predicate` is the caller's safety gate**, and
there are TWO distinct caller contracts:

```
list-panes -a -j  →  collectPanesFromListJson  →  for each pane:
   predicate(pane) ? close-pane -p terminal_<id> : skip
```

1. **Pause / boot reap (fn-724, `isCompletionReapCandidate`'s sibling
   `isReapCandidate`).** Cancels launch-window ghost surfaces on
   pause/boot-pause. The predicate passes "verb-prefixed dispatch key AND
   an OPEN `pending_dispatches` row" — NEVER name-alone. A dispatch key
   that has *discharged* from the open set means SessionStart already
   bound = a LIVE worker, which must never be reaped. `list-panes` lags
   zellij reality, so a name match alone must not authorize a close; the
   open-row intersect is the highest-blast-radius gate.

2. **Completion reap (fn-727, `isCompletionReapCandidate`).** Closes a
   row's surfaces when it reaches the durable `{tag:"completed"}` readiness
   verdict (worker done AND idle for a task; `status='done'` AND closer idle
   for an epic — the approval enum no longer gates). The predicate passes "the pane's
   `(work|close)::<id>` key's `<id>` is in this cycle's completion set" — so
   a completed task reaps `work::<id>` and a completed close-row reaps
   `close::<id>` (fn-756: there is NO `approve::<id>` surface to pair — the
   approve verb is gone). For an epic close-row to be observed here, the
   reconcile snapshot must still carry the just-done epic: the default epics
   read scopes to `status='open'`, so fn-764 merges in a bounded
   `filter:{status:"done"}` read (`updated_at` DESC, small limit) so a
   freshly-done epic appears across its done→idle wind-down — the bound keeps
   it O(limit), never O(all done history). The durable verdict is the SOLE
   authorization and the name match only LOCATES the pane. Repeated
   observation within the bounded window is safe — `reapSurfaces` is
   idempotent (a re-close of an already-gone pane is a best-effort no-op).

Both contracts share the same `list-panes` lag caveat: the predicate, not
pane liveness, authorizes the close. The completion predicate substitutes
the durable verdict for the open-row intersect as its authorization.

Failure modes all degrade rather than throw:

- list-panes null/unparseable (binary missing, empty output) →
  `skippedNoSnapshot: true`, whole reap no-ops.
- A per-pane close failure logs via `noteLine` and continues to the next
  candidate — the reap is best-effort cleanup, not a transaction.

Closing the pane drops its tab too: zellij auto-closes a tab when it has
zero selectable tiled panes left, and the reconciler dedup invariant
keeps one agent pane per tab.

## Pure helpers reference

The module exports its argv builders and parsers as pure functions so
tests assert them in isolation and the runtime composes them:

| Helper | Purpose |
|---|---|
| `buildZellijNewTabArgs(session, dir, argv, name?)` | `action new-tab` argv (omits `--name` when empty) |
| `buildZellijCloseTabArgs(session, windowId)` | `action close-tab-by-id` — orphan default-tab reap |
| `buildZellijClosePaneArgs(session, paneId)` | `action close-pane -p` — surface reap |
| `buildZellijListSessionsArgs()` | `list-sessions` |
| `buildZellijListTabsArgs(session)` | `action list-tabs` — capture default tab id |
| `buildZellijListPanesAllJsonArgs(session)` | `action list-panes -a -j` |
| `buildZellijFocusPaneArgs(session, paneId)` | `action focus-pane-id` |
| `buildZellijAttachBgArgs(session)` | `attach -b --forget` — session mint |
| `firstTabIdFromListTabs(text)` | first tab id from `list-tabs` (null on unparsable) |
| `parseListPanesJson(text)` | parse `list-panes -j` stdout (null on unparsable) |
| `findPaneById(payload, paneId)` | none/single/multiple match by env-stamped pane id |
| `collectPanesFromListJson(payload)` | every terminal pane (reap candidate set) |
| `dispatchKeyForPane(pane)` | lift `verb::id` off tab name then `terminal_command` |
| `closePaneIdForReap(id)` | normalize bare `id` → `terminal_<n>` close selector |

Two id forms matter: `list-panes` ships a bare numeric `id` (`"3"`) which
`findPaneById` matches against the env-stamped `ZELLIJ_PANE_ID`, while
`close-pane -p` wants the `terminal_<n>` form — `closePaneIdForReap`
bridges them (idempotent).

## Extending to a new backend

The backend is deliberately the only place that knows zellij. To add a
tmux/wezterm backend:

1. Implement the `ExecBackend` interface (`launch`, `focusPane`,
   `ensureLaunched`, `reapSurfaces`) over the new mechanism.
2. Teach `execBackendEnvMeta(backendType)` the new backend's
   session-id / pane-id env-var names. This is the single source of truth
   for the env vars the **hook** reads on every event — funnelling the
   literals through this seam keeps the hook backend-agnostic so it never
   learns new keys. (For `"zellij"` it returns `ZELLIJ_SESSION_NAME` /
   `ZELLIJ_PANE_ID`.)
3. Branch `resolveExecBackend(deps)` on backend type. Call sites already
   go through this resolver, so they need no structural change.

The `DEFAULT_EXEC_BACKEND` (`"zellij"`) and `DEFAULT_ZELLIJ_SESSION`
(`"autopilot"`) consts are exported so the lockstep `db.ts` site and
tests share one source of truth.
