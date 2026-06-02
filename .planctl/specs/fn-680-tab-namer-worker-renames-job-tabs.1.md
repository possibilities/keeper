## Description

**Size:** S
**Files:** src/exec-backend.ts, test/exec-backend.test.ts

### Approach

Add a pure builder `buildZellijRenameTabArgs(session, tabId, name)` returning
`["zellij","--session",session,"action","rename-tab-by-id",tabId,name]` — the
focus-safe op (the `-t`/`--tab-id` flag on plain `rename-tab` has open bug #4602
that steals the human's focus; `rename-tab-by-id <ID> <NAME>` is verified present
in zellij 0.44.3). Add `renameTab(session, tabId, name): Promise<LaunchResult>`
to the `ExecBackend` interface and the `createZellijBackend` factory's returned
object. Model the impl on `closeByTabId` (session-agnostic, NO `ensureSession` —
renaming a tab in an already-live session must not mint one) but return the
`LaunchResult` envelope like `focusPane` so the worker (task .2) can success-gate
its debounce: `runCapture` null (ENOENT) -> `{ok:false,error}`; non-zero exit ->
`{ok:false,error}` with stderr detail; exit 0 -> `{ok:true}`. NEVER throws;
`noteLine` on failure like the sibling ops.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts — `closeByTabId` (~945-983): the session-agnostic, no-ensureSession, fire-and-forget template
- src/exec-backend.ts — `focusPane` (~984+): the `LaunchResult` envelope + `runCapture` exit-code handling to mirror
- src/exec-backend.ts — `buildZellijCloseTabArgs` (~391-403): the pure-builder template + its doc-comment style
- test/exec-backend.test.ts — the `makeSpawnStub` injection seam + the `buildZellijCloseTabArgs` argv test (~131) to mirror

**Optional**:
- src/exec-backend.ts — the `ExecBackend` interface block (~185-267) for where to slot the new method + doc comment

### Risks

- A title beginning with `-` could be parsed by zellij's clap as a flag — task .2's sanitizer strips leading `-`, and the name rides as the final positional argv element (no shell), so this is defense-in-depth. Confirm the arg order is `rename-tab-by-id <ID> <NAME>` (verified in 0.44.3 `--help`).

### Test notes

- Assert `buildZellijRenameTabArgs` returns the exact argv array.
- `renameTab` returns `{ok:true}` on a stubbed exit-0 spawn; `{ok:false}` on a non-zero exit and on ENOENT (spawn throws/returns null); NEVER throws.
- Assert NO session-ensure spawn fires (no `list-sessions`/`attach` in the recorded calls) — it is session-agnostic.

## Acceptance

- [ ] `buildZellijRenameTabArgs(s, id, name)` returns `["zellij","--session",s,"action","rename-tab-by-id",id,name]`
- [ ] `renameTab` returns `{ok:true}` on exit 0, `{ok:false,error}` on non-zero exit and on ENOENT; never throws
- [ ] `renameTab` runs no session-ensure (session-agnostic, like `closeByTabId`/`focusPane`)
- [ ] `ExecBackend` interface documents `renameTab`; `bun test test/exec-backend.test.ts` is green

## Done summary

## Evidence
