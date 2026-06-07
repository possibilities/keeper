## Overview

Revive the autopilot window-autoclose subsystem torn out in fn-710
(commit a039e65). When a row reaches **approved completion** (readiness
verdict `{tag:"completed"}`), the reconciler reaps every live zellij
surface sharing that row's id: a task completion reaps `work::<task-id>`
**and** `approve::<task-id>`; an epic close-row completion reaps
`close::<epic-id>` **and** `approve::<epic-id>`. Pending, rejected, and
just-worker-ended windows stay open for human inspection. The whole pass
is gated on the existing `autoclose_windows` config flag, which is parsed
in `src/db.ts` today but consumed nowhere.

The close is built on the SURVIVING live-probe path (`reapSurfaces` +
`buildZellijClosePaneArgs`), not the torn-out jobs-row tab-coord path
(`closeByTabId`, `backend_exec_session_id/tab_id`) — those are gone for
good. The new code is a sibling reap predicate plus its wiring into the
reconcile cycle; the zellij plumbing already exists.

## Quick commands

- `grep -n "autocloseWindows" src/autopilot-worker.ts src/daemon.ts src/db.ts` — flag is now consumed beyond db.ts
- `bun test test/autopilot-worker.test.ts` — predicate + reap-pass suite green
- `keeper autopilot` — with `autoclose_windows: true`, approving a finished worker reaps its window + approve window together; pending/rejected stay open

## Acceptance

- [ ] Approving a completed task reaps `work::<id>` AND `approve::<id>` together
- [ ] Approving a completed epic close-row reaps `close::<id>` AND `approve::<id>` together
- [ ] Pending / rejected / worker-ended-but-unapproved windows are NOT reaped
- [ ] `autoclose_windows: false` makes the reap pass a no-op (and skips the `list-panes` spawn)
- [ ] The reap pass never throws past its own try/catch (no-self-heal preserved)
- [ ] Reap drives off the live-probe path, surviving a daemon restart (no reliance on cold-booting `liveDispatches`)
- [ ] README / CLAUDE.md / docs/exec-backend.md reflect the revived completion-reap

## Early proof point

Task that proves the approach: `.1` (the whole revival is one cohesive
task). If it fails: the predicate + `reapSurfaces` seam is the fallback
isolation point — the live-probe close path is already proven by the
fn-724 pause reap, so a failure localizes to the new predicate or the
completed-set surfacing, not the zellij plumbing.

## References

- Blueprint: commit `4860ab4` "gate window reap on approved completion" — adapt its `approved-complete` GATING semantics ONLY; its `closeByTabId` / jobs-row tab-coord mechanism was torn out in fn-710 and must NOT be revived.
- Teardown: commit `a039e65` (fn-710) removed the zellij-events fold, window-reap decision arm, `PlannedReap`/`ReapReason`, and the README/CLAUDE.md reap callouts.
- Surviving close path: `src/exec-backend.ts` `reapSurfaces` (the fn-724 pause reaper) + `buildZellijClosePaneArgs` + `parseListPanesJson` + `collectPanesFromListJson` + `dispatchKeyForPane`.
- Trigger: `src/readiness.ts` `perTask` / `perCloseRow` emit `{tag:"completed"}` (approved + worker-phase done + idle).
- Reverse-dep / overlap (advisory): fn-722 (fast two-tier test gate) task 2 builds `test/helpers/sandbox-env.ts`; if it lands first, this epic's tests can import the shared sandbox helper instead of an ad-hoc pattern. Soft test-layer overlap only, not a logic dependency.

## Docs gaps

- **README.md** (config section ~285-317): re-add the `autoclose_windows` bullet + example YAML + fallback-defaults sentence; note default `true` and the new approved-completion behavior. Splice into the one authoritative key list, don't append a second.
- **README.md** (## Architecture autopilot paragraph ~1703-1790): re-add the completion-reap callout as a distinct sub-case from the pause/boot reap, sharing `reapSurfaces`.
- **CLAUDE.md / AGENTS.md** (## Autopilot ~118-124): one sentence that completion reap (gated on `autoclose_windows`) fires via `reapSurfaces` (pane-close, not the retired `closeByTabId`), pointing at `src/autopilot-worker.ts` + `src/exec-backend.ts`.
- **docs/exec-backend.md** (## The reap path ~189-216): broaden to cover TWO predicate caller contracts — pause/boot (key AND open `pending_dispatches` row) vs completion reap (approved-completion row id, name-located pair). Edit in place; don't duplicate the predicate-safety prose.

## Best practices

- **Deliberate divergence (document it):** practice-scout's universal rule is "match name AND `is_exited==true` before closing a pane." This feature intentionally does NOT apply that to the approver arm — the approver pane is LIVE at the instant of approval, so `is_exited` can never gate it. The durable `{tag:"completed"}` verdict is the sole authorization; the name match only locates the panes. Per the human's design call: an `approve::<id>` surface existing implies a completed corresponding job; a violation of that correspondence is a separate bug, out of scope here.
- **Treat pane-not-found as success** — a pane already gone is desired state; `reapSurfaces` logs and continues per pane.
- **Re-probe every cycle, never persist pane ids** — the reap is level-triggered on `data_version`; each pass re-reads live `list-panes`.
- **Never-throw** — the entire reap pass is try/caught; a throw would bounce the daemon under the no-self-heal rule.
- **Scope by session** — `reapSurfaces` already targets the managed zellij session; name matches stay scoped.
