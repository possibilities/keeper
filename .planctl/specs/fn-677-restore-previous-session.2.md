## Description

**Size:** M
**Files:** src/exec-backend.ts, README.md, test/exec-backend.test.ts

### Approach

Add a session-agnostic method to the `ExecBackend` interface (working
name `ensureLaunched(session, argv, cwd, name?)`; pick the final name —
it OWNS get-or-create of the target session, so lean toward
ensure/idempotent semantics rather than a "get"/lookup verb). It takes
the target session PER CALL (mirroring the existing session-agnostic
`focusPane`/`resolveTabForPane` category), get-or-creates that session
(the private memoized `ensureSession` is hardwired to the
construction-time session and CANNOT be reused — implement a
session-agnostic get-or-create that mirrors the `list-sessions` probe ->
`zellijSessionListed` -> `attach -b --forget` + 5s poll logic,
parameterized by `targetSession`, not sharing the `sessionReady` memo),
then `new-tab`s via the existing `buildZellijNewTabArgs` (which already
omits `--name` when empty — restore passes no tab name). Replicate two
resiliences the managed path has: (a) the orphan default-`Tab #1` reap so
a freshly-minted session doesn't strand an empty tab, and (b) the
session-gone new-tab retry (`looksLikeSessionGone` -> re-ensure -> retry
once). Return the same `LaunchResult` envelope as `launch`; degrade to
`{ok:false,error}` on ENOENT / non-zero exit, never throw. Widen the
README `ExecBackend` paragraph to describe the new surface (collapse the
old "launch + closeByName" description, don't just append).

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:168-251 — the `ExecBackend` interface + the two op-category doc blocks
- src/exec-backend.ts:857-914 — private memoized `ensureSession` (the get-or-create logic to parameterize)
- src/exec-backend.ts:977-1029 — `launch` (orphan reap :1020-1027, session-gone retry :986-1006 to replicate)
- src/exec-backend.ts:1097-1149 — `focusPane`/`resolveTabForPane` (the session-agnostic category to mirror)
- src/exec-backend.ts:339-357 — `buildZellijNewTabArgs` (session-per-call, omits --name when empty)

**Optional** (reference as needed):
- src/exec-backend.ts:822-832 — `pendingOrphanTabId` machinery
- README.md ExecBackend paragraph (~line 1342)

### Risks

The orphan-reap and session-gone-retry are tied to the construction-time
memo today; a session-agnostic mint needs its OWN reap state (don't
clobber the managed `pendingOrphanTabId`). Get-or-create against an
already-live external session must NOT `--forget` it (only mint when
absent/EXITED) — `zellijSessionListed`'s EXITED handling already gates this.

### Test notes

Extend `test/exec-backend.test.ts` with an injected fake `spawn` capturing
the constructed argv: assert get-or-create probes `list-sessions`, mints
via `attach -b --forget` only when absent, `new-tab`s without `--name`,
reaps the orphan tab, and retries once on a session-gone stderr. No real
zellij.

## Acceptance

- [ ] `ExecBackend` gains a session-agnostic get-or-create + launch method (final name chosen, ensure-semantics).
- [ ] Get-or-create mirrors the managed path's mint/poll but is parameterized by the per-call session and shares no memo with `ensureSession`.
- [ ] Orphan default-tab reap and session-gone single-retry replicated for the new path.
- [ ] Launches with no `--name` (no tab name restored); returns the `LaunchResult` envelope, never throws.
- [ ] README ExecBackend paragraph updated; `test/exec-backend.test.ts` covers argv construction + the resiliences.

## Done summary
Added session-agnostic ExecBackend.ensureLaunched: refactored ensureSession into ensureSessionFor(targetSession) shared by the managed memo and the new per-call path; new method get-or-creates the target session, launches an unnamed tab via the existing builder, reaps the orphan default Tab #1 per-call, and retries once on a session-gone stderr. Shares no memo/orphan state with launch(). README widened; 7 new exec-backend tests cover argv shape, mint path, session-gone retry, ENOENT/non-zero envelopes, and the no-shared-state invariant.
## Evidence
