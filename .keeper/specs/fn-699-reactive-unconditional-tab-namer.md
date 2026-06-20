## Overview

The tab-namer worker (`src/tab-namer-worker.ts`, the 12th Bun worker) renames
each live job's zellij tab to its session's transcript-derived title. Today it
is a 5s `setInterval` poller with a `job_id`-keyed `lastSet` debounce that
records every name it has ever sent and never re-sends it — so once a tab is
renamed, a later drift (resume into a recycled `Tab #N`, or a tab-mate
renaming a shared tab) is permanently suppressed and the tab never
re-converges. The reactive zellij plugin (fn-684) made pane->tab *resolution*
event-driven, but the *renamer* stayed a wall-clock poll. End state: the
renamer is reactive (kicked by main after every drain, with a `data_version`
poll backstop) and unconditional (a tab whose observed name diverges from its
session title is always re-asserted), so a tab follows its session's title
across resume/drift within one kick/poll cycle.

## Quick commands

- `bun test test/tab-namer-worker.test.ts` — pure-export suite (runTick, readLiveJobsForTabNaming, sanitizeTabName), now pane-id-keyed with new drift/post-write cases
- `bun test test/server-worker.test.ts` — confirms the kick+poll pattern being mirrored is unbroken
- Manual: resume a named session into a tab zellij reset to `Tab #N`; the tab re-converges to the session title within ~1 kick (<= poll cadence) — verify `sqlite3 ~/.local/state/keeper/keeper.db "SELECT title, backend_exec_tab_name FROM jobs WHERE backend_exec_pane_id IS NOT NULL"` shows title==tab_name

## Acceptance

- [ ] Main posts `{type:"kick"}` to the tab-namer after `drainToCompletion`, alongside the existing server-worker kick
- [ ] The 5s `setInterval` is replaced by a `data_version` poll backstop (~2500ms) plus the kick fast-path; immediate first tick preserved
- [ ] A tab that drifts to the zellij default (or a foreign name) after a resume re-converges to its session title within one kick/poll cycle
- [ ] Convergence is unconditional and self-terminating; no `job_id`-keyed permanent suppression remains
- [ ] `bun test test/tab-namer-worker.test.ts` passes with pane-keyed assertions and new drift/post-write cases
- [ ] Stale docs rewritten (worker header, daemon "pure consumer" comment, README tab-namer paragraph, CLAUDE.md kick bullet + watcher carve-out)

## Early proof point

Task that proves the approach: `.1` (the whole change is one cohesive task).
If the drift re-assertion test can't be made to pass without reintroducing a
spawn loop, the memo's clear-on-convergence discriminator is wrong — fall back
to a per-pane `{name, tabId, sawConverged}` tri-state before widening scope.

## References

- Load-bearing assumption VERIFIED: zellij drift reaches keeper as a DB write. A tab recycled to `Tab #N` emits a feed line -> `zellij-events-worker` (@parcel/watcher) -> main mints `BackendExecSnapshot` -> reducer folds `jobs.backend_exec_tab_name` -> `data_version` bump -> kick+poll fire. Directly observed in the event log (`BackendExecSnapshot` events folding the drift-to-`Tab #5` transition). So the reactive trigger genuinely catches drift; no wall-clock sweep needed.
- Pattern source: `src/server-worker.ts` (NOT `backend-worker.ts`, which is `setInterval`). `KickMessage` :121-134 (already exported); `pollLoop` :1816-1853; `handleKick` :1867-1875; message discriminator :2303-2374 / :2322-2329.
- Lineage (all done): fn-680 (tab-namer), fn-684 (zellij feed), fn-694 (server-worker kick / lever B), fn-668 (backend_exec coords), fn-678 (tab names cosmetic — dispatch dedup/reap are tab-id-driven, so renaming any live tab is safe).
- Reducer fact: `backend_exec_pane_id` is COALESCE-folded every event (`src/reducer.ts:7352-7367`) INDEPENDENTLY of `backend_exec_tab_id` (separate synthetic-event arm) — a pane can resolve before its tab, so the `backend_exec_tab_id IS NOT NULL` filter must stay.
- epic-scout: zero open epics in the cross-project pool — no dependencies or overlaps to wire.

## Docs gaps

- **README.md** (~lines 1729-1749, tab-namer paragraph): "ticks every ~5s" + job-id `lastSet` both become wrong; rewrite to kick-after-drain + `data_version` poll backstop + unconditional pane-keyed convergence. Mirror the server-worker kick prose (~lines 983-989).
- **CLAUDE.md** (Worker contract ~311-318): widen the `{type:"kick"}` bullet — main now kicks the tab-namer too (its handler runs the rename tick, not `diffTick`). AGENTS.md is a symlink; edit CLAUDE.md in place.
- **CLAUDE.md** (DO-NOT "No kernel file watchers" carve-out ~243-252): broaden the fn-694 kick callout beyond "the server-worker".

## Best practices

- **Edge + level (lost-wakeup safety):** the kick is a hint, not a fact; the `data_version` poll is the backstop that catches any kick lost between main's write and the worker arming its wait. Re-read current state every reconcile — never derive from the kick (it carries no payload). [Kubernetes controller-runtime / Chainguard reconciliation]
- **Idempotent convergence, compare in the normalized domain:** `if sanitize(title) !== tab_name -> rename`. Comparing raw-vs-stored is the Argo CD #19675 infinite-reconcile trap; zellij stores sanitized names verbatim, so `tab_name === sanitize(title)` is the convergence signal.
- **Drain-then-arm coalescing:** a single atomic `pendingKick` flag (not a counter); run the tick, then re-run once if a kick landed mid-flight. Avoids both the dropped-final-state race and unbounded-timer starvation.
- **Accept one spurious idempotent re-actuate:** in the post-write observe window a re-read may see the pre-rename value; a redundant rename to the same value is harmless, so the memo need only suppress the common case, not guarantee zero double-sends.
