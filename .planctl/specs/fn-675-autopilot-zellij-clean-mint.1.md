## Description

**Size:** S
**Files:** src/exec-backend.ts, test/exec-backend.test.ts, README.md

### Approach

Add `--forget` to the zellij session-mint argv so every keeper-managed
autopilot mint deletes any saved session before connecting, defeating
stale-layout resurrection. Change `buildZellijAttachBgArgs(session)`
(`src/exec-backend.ts:681`) from `["zellij","attach","-b",session]` to
`["zellij","attach","-b","--forget",session]`. This rides on the single
mint site in `ensureSession` (`:812`) AND the mid-life re-mint retry path
(`:857-868`), so all keeper-initiated mints fresh-build. No tri-state
corpse classifier is needed: `--forget` is a harmless no-op when nothing
is saved (absent session), purges the cache when an EXITED corpse exists,
and `ensureSession` short-circuits before the attach when the session is
live — so `--forget` never runs against a live session. The orphan-`Tab #1`
reap logic is unchanged (a fresh mint still yields the default empty tab to
reap). Update the JSDoc on `buildZellijAttachBgArgs`/`zellijSessionListed`
to say the EXITED corpse is now forgotten-and-rebuilt, not resurrected.
Then revise the README ExecBackend prose (~:1330-1333) in-place.

### Investigation targets

**Required** (read before coding):
- src/exec-backend.ts:681 — `buildZellijAttachBgArgs`, the argv builder to change
- src/exec-backend.ts:698-718 — `zellijSessionListed`, the EXITED-as-not-listed seam (JSDoc to update)
- src/exec-backend.ts:785-838 — `ensureSession`, the mint site (:812) + orphan-reap capture
- src/exec-backend.ts:857-868 — mid-life re-mint retry path (also rides the new argv)
- test/exec-backend.test.ts:633-687 — the EXITED→resurrect regression test whose expected argv must now assert `--forget` (intent flips from "resurrect" to "fresh-mint")
- test/exec-backend.test.ts:487-557 — absent→attach-b happy path; expected attach argv now carries `--forget` (harmless)
- test/exec-backend.test.ts:559-598 — color-env mint test; expected attach argv now carries `--forget` alongside the env assertion

**Optional** (reference as needed):
- test/exec-backend.test.ts:56-82 — `makeSpawnStub(table, calls)` helper (keys by `cmd[0]:cmd[1]`)
- README.md:1330-1333 — ExecBackend / "lazily-created zellij_session" prose to revise

### Risks

- `--forget` flag position: both `-b` and `--forget` are `attach` options; assert the exact argv the tests expect (`["zellij","attach","-b","--forget",session]`) and keep it consistent across all mint sites.
- Don't let `--forget` leak onto control commands (`new-tab`/`list-*`/`close-*`) — it belongs only on the mint argv builder, not the shared path.

### Test notes

Pure argv-assertion tests (no real spawn). Update the three tests above to
expect `--forget` in the attach argv; confirm no remaining test asserts the
old resurrect sequence. Add/extend an assertion that the EXITED-corpse path
now fresh-mints (forgets) rather than resurrecting.

## Acceptance

- [ ] `buildZellijAttachBgArgs` emits `["zellij","attach","-b","--forget",<session>]`.
- [ ] All keeper mint sites (initial mint + mid-life re-mint retry) use the `--forget` argv.
- [ ] `--forget` appears only on the mint argv, never on control commands.
- [ ] Exec-backend tests updated: EXITED-corpse path asserts fresh-mint (`--forget`), absent + color-env paths assert the new argv; no test asserts the old resurrect behavior.
- [ ] README ExecBackend prose revised in-place to say the session is fresh-minted, never resurrected.
- [ ] `bun test test/exec-backend.test.ts` passes.

## Done summary

## Evidence
