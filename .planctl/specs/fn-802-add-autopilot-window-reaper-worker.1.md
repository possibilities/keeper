## Description

**Size:** S
**Files:** src/exec-backend.ts, test/exec-backend.test.ts, docs/exec-backend.md

### Approach

Add `killWindow(paneId: string): Promise<LaunchResult>` to `ExecBackend`,
mirroring `focusPane` exactly (session-agnostic, no session-ensure,
never throws, `{ok:false,error}` degrade, routed through `runCapture`
with its 5s kill-timeout and ENOENT→null handling). Pure exported
builder `buildTmuxKillWindowArgs(paneId)` returning
`["tmux","kill-window","-t",paneId]` beside the existing
`buildTmux*Args` family. Pane-id (`%N`) targeting is deliberate: tmux
resolves it upward to the owning window and kills every pane in it —
the wanted semantics for one-pane managed windows — and a stable `%N`
target cannot be redirected by concurrent rename automation. A nonzero
"can't find window" exit is an expected TOCTOU no-op the caller treats
as already-gone; keep its noteLine quiet.

JSDoc the kill semantics (window-level kill, last-window-kills-session
and the managed session re-mints via get-or-create, remain-on-exit does
not block removal). Update docs/exec-backend.md: add the `killWindow`
row to the op-categories table (session-agnostic, call site: reaper
worker), and replace the "keeper never closes a window / there is no
reap op on the interface" prose with a present-tense description of the
op and its single caller — drop the deleted-reap parenthetical entirely.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:385-417 — focusPane, the exact method template
- src/exec-backend.ts:231-239 — buildTmuxSelect*Args, the builder shape
- src/exec-backend.ts:278-322 — runCapture plumbing the op rides
- test/exec-backend.test.ts:39-75,189-196 — makeSpawnStub + builder assertion patterns; the focusPane happy/ENOENT/non-zero trio is the test template

**Optional** (reference as needed):
- docs/exec-backend.md:52-70 — op table + the now-false "never closes a window" prose
- src/exec-backend.ts:87 — MANAGED_EXEC_SESSION constant (callers' discriminator; the op itself is session-agnostic)

### Risks

- This file is being rewritten by an upstream epic and extended by the
  renamer's op additions; start from the landed shape (epic deps
  enforce ordering).
- First kill-class action on the backend: the never-throw contract is
  load-bearing — an uncaught throw in a caller's cycle wedges a worker
  with no self-heal.

### Test notes

makeSpawnStub-driven: exact argv assertion; happy path; nonzero
"can't find window" → {ok:false} without throw; ENOENT/wedged-tmux
degrade. No real tmux.

## Acceptance

- [ ] `buildTmuxKillWindowArgs` exported, argv exactly `["tmux","kill-window","-t",<paneId>]`, covered by tests
- [ ] `killWindow` never throws; missing window and missing tmux both degrade to `{ok:false}`
- [ ] docs/exec-backend.md op table + prose reflect the op; no deleted-reap tombstone language remains
- [ ] `bun test test/exec-backend.test.ts` passes

## Done summary
Added killWindow(paneId) + buildTmuxKillWindowArgs to the tmux ExecBackend, mirroring renameWindow: %N pane-id target, never-throw envelope, quiet TOCTOU no-op. Updated docs/exec-backend.md op table and prose.
## Evidence
