## Description

**Size:** M
**Files:** src/exec-backend.ts, src/backend-worker.ts, cli/jobs.ts, test/exec-backend.test.ts, test/backend-worker.test.ts, test/jobs.test.ts

Reshape `ExecBackend` into the full backend port surface with two
documented op categories: session-bound lifecycle ops (`launch`,
`closeByName` — managed autopilot session, memoized session-ensure)
and session-agnostic ops (`focusPane`, `resolveTabForPane` — take
`session` per-call, skip session-ensure, act on already-live
external sessions). Then wire `v` in the jobs CLI to focus the
selected job's pane.

### Approach

1. **src/exec-backend.ts** — add `focusPane(session, paneId):
   Promise<LaunchResult>` and `resolveTabForPane(session, paneId):
   Promise<ResolvedTabCoords | null>` to the `ExecBackend`
   interface. Make `ZellijBackendDeps.session` optional (default
   `DEFAULT_ZELLIJ_SESSION`) so a consumer touching only
   session-agnostic ops constructs with just `{ noteLine }`. Add a
   pure `buildZellijFocusPaneArgs(session, paneId)` →
   `["zellij","--session",session,"action","focus-pane-id",paneId]`.
   Implement `focusPane` via `runCapture` (ENOENT / non-zero exit →
   `{ ok: false, error }`, never throws — same envelope as
   `launch`). Move the existing free `resolveTabForPane` body onto
   the method (reuse `runCapture`); drop the standalone export.
   Keep `buildZellijListPanesAllJsonArgs`, `findPaneById`,
   `parseListPanesJson`, `ResolvedTabCoords`. Update the module
   + interface doc comments to name the two op categories.
2. **src/backend-worker.ts** — replace the
   `resolveTab?: typeof resolveTabForPane` injection with
   `backend?: Pick<ExecBackend, "resolveTabForPane">`, defaulting to
   `resolveExecBackend({ noteLine: ... })`; call
   `backend.resolveTabForPane(session, pane)`. Serial-per-session
   walk untouched.
3. **cli/jobs.ts** — construct a backend once in `main()` via
   `resolveExecBackend({ noteLine: view.noteLine })`. Add
   `handleFocusKey()` (shaped like `handleReplayKey`: single-flight
   guard, resolve selected `job_id` via `selectableJobIds`, read row
   `backend_exec_session_id` + `backend_exec_pane_id`; either null →
   `view.flashStatus("[no zellij pane]")`; else flash `[focusing…]`,
   await `backend.focusPane`, then `[focused]` /
   `[focus failed: <reason>]`). Add `case "v":` to the insert-mode
   switch in `handleInsertKey`. Update `HELP` + insert-mode key list.
4. **Tests** — move `resolveTabForPane`'s 8 tests to
   `createZellijBackend({ spawn }).resolveTabForPane(...)`;
   `backend-worker.test.ts` injects a fake
   `{ resolveTabForPane }` instead of a fake `resolveTab` fn; add
   `buildZellijFocusPaneArgs` + `focusPane` (ok / non-zero / ENOENT)
   tests in `test/exec-backend.test.ts`.

Do NOT make `launch` / `closeByName` take session per-call — that
churns the battle-tested autopilot path for marginal gain. The
managed-session-vs-arbitrary-session split is intentional; the
optional construction-session removes the only wart.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:112-141 — `ExecBackend` interface to extend
- src/exec-backend.ts:624-673 — free `resolveTabForPane` to fold onto the interface
- src/exec-backend.ts:750-942 — `createZellijBackend` factory + `runCapture` helper
- src/backend-worker.ts:147-163,229 — `resolveTab` injection seam + call site to migrate
- cli/jobs.ts:553-597 — `handleInsertKey` switch (add `case "v"`)
- cli/jobs.ts:492-521 — `handleReplayKey` (shape to mirror for `handleFocusKey`)
- cli/jobs.ts:226-254 — `backendCoordsSeg` (confirms row carries `backend_exec_session_id` / `backend_exec_pane_id`)
- test/exec-backend.test.ts:1131-1230 — `resolveTabForPane` tests to migrate

Note: zellij 0.44.3 provides `zellij --session <s> action
focus-pane-id <PANE_ID>` (bare numeric id accepted) — focuses the
pane and switches to its tab. The stored pane id is a bare number
string from `ZELLIJ_PANE_ID`.

## Acceptance

- [ ] `ExecBackend` interface exposes `focusPane(session, paneId)`
  and `resolveTabForPane(session, paneId)`; free `resolveTabForPane`
  export removed; `ZellijBackendDeps.session` optional.
- [ ] `buildZellijFocusPaneArgs` is pure + exported; `focusPane`
  degrades to `{ ok: false, error }` on ENOENT / non-zero exit,
  never throws.
- [ ] `cli/jobs.ts` `v` in insert mode focuses the selected job's
  zellij pane; flashes `[focusing…]` → `[focused]` /
  `[focus failed: …]` / `[no zellij pane]`. HELP updated.
- [ ] `src/backend-worker.ts` migrated to `backend.resolveTabForPane`;
  serial-per-session walk behavior unchanged.
- [ ] `launch` / `closeByName` and their tests untouched.
- [ ] bun test passes for exec-backend, backend-worker, jobs.

## Done summary
ExecBackend port now carries focusPane + resolveTabForPane as session-agnostic ops alongside launch/closeByName; cli/jobs `v` focuses the selected job's zellij pane via backend.focusPane.
## Evidence
