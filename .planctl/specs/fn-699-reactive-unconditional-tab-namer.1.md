## Description

**Size:** M
**Files:** src/tab-namer-worker.ts, src/daemon.ts, test/tab-namer-worker.test.ts, README.md, CLAUDE.md

### Approach

Convert the tab-namer from a wall-clock poller with a permanent
"already-sent" debounce into an event-driven idempotent reconciler that
always converges a tab's name to its session title, mirroring the
`server-worker.ts` kick + `data_version`-poll model.

1. **Kick wire (daemon).** In `pumpWakes` (`src/daemon.ts:1402-1413`), after
   the existing `serverWorker.postMessage({type:"kick"})`, also
   `tabNamerWorker.postMessage({type:"kick"} satisfies KickMessage)` when
   `folded && !shuttingDown`. `KickMessage` is already imported. Update the
   stale `:2893` "No onmessage handler — pure consumer" comment (the worker
   now RECEIVES a kick; it still posts nothing TO main).
2. **Kick handler + poll backstop (worker `main`).** Add a `kick` branch to
   the `parentPort.on("message")` discriminator (today only `shutdown`).
   Replace the 5s `setInterval` with a `pollLoop` modeled on
   `server-worker.ts:1816-1853`: a naked autocommit `PRAGMA data_version`
   read on the read-only connection, re-tick only when the version changes,
   ~2500ms cadence (rename `TabNamerWorkerData.tickMs` -> `pollMs`, default
   2500). Keep the immediate first tick on spawn (cold-restart
   re-convergence). The poll connection must stay autocommit — never wrap
   the live-jobs read in `BEGIN` or `data_version` freezes.
3. **Coalesce kicks (drain-then-arm).** Keep the `isRunning` re-entry guard;
   add a `pendingKick` flag — a kick arriving mid-tick sets it, and the
   in-flight tick re-runs once on completion if set. Wrap `runTick` in
   try/catch (log + continue, never propagate) like `handleKick`.
4. **Unconditional convergence (`runTick`).** For each deduped winner row,
   if `sanitize(title) !== backend_exec_tab_name`, issue
   `renameTab(tab_id, sanitized)`. No `job_id` "already sent" short-circuit.
5. **Clear-on-convergence memo.** Replace `lastSet: Map<job_id,string>` with
   `memo: Map<SESSION::PANE_ID, string>` (the last name sent, not yet
   observed to land). Discipline: (a) when `tab_name === sanitized` ->
   `memo.delete(key)` and skip (clearing on observed convergence is what
   lets a later drift re-fire); (b) else if `memo.get(key) === sanitized` ->
   suppress (post-write observe window / theoretical zellij normalization);
   (c) else rename, and on `{ok:true}` `memo.set(key, sanitized)`. A failed
   rename does NOT write the memo (retry next cycle). Drop the speculative
   `observedAtSend` field — clear-on-convergence is the discriminator.
6. **SELECT + dedup.** Add `backend_exec_pane_id` to
   `readLiveJobsForTabNaming` and `LiveJobRow`; KEEP the
   `backend_exec_tab_id IS NOT NULL` filter (rename needs the tab_id; pane
   and tab fold on independent reducer arms). Keep dedup by
   `(session, tab_id)` lowest-`job_id`-wins for within-tick anti-tab-fight
   (positional `tab_id` is stable within one snapshot). Re-key the prune
   loop to the live `(session, pane_id)` set.
7. **Rewrite stale prose:** the `tab-namer-worker.ts:1-86` header (setInterval
   + job-id lastSet model, "ELEVENTH/TWELFTH" miscount), README tab-namer
   paragraph, and the two CLAUDE.md spots (kick bullet, watcher carve-out).

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts:1816-1853 — `pollLoop` (autocommit data_version read, re-diff on change) — the poll template
- src/server-worker.ts:1867-1875 — `handleKick` (try/catch, does NOT advance poll's local `last`; idempotent) — the kick-handler template
- src/server-worker.ts:2303-2374 / 2322-2329 — message discriminator (shutdown vs kick by `.type`)
- src/server-worker.ts:121-134 — `KickMessage` (already exported)
- src/tab-namer-worker.ts:225-339 — `runTick` (lastSet at :284/:322, dedup :242-251, prune :334-338)
- src/tab-namer-worker.ts:179-193 + 159-166 — `readLiveJobsForTabNaming` + `LiveJobRow` (add pane_id)
- src/tab-namer-worker.ts:341-409 — `main` lifecycle (setInterval :386, shutdown branch :394)
- src/daemon.ts:1402-1413 — `pumpWakes` kick site; :2894-2899 spawn; :2893 stale comment
- test/tab-namer-worker.test.ts:72-96 — `insertJob` helper (add `backend_exec_pane_id`); all `lastSet.get/.has` assertions re-key to SESSION::PANE_ID

**Optional** (reference as needed):
- src/reducer.ts:7352-7367 — `backend_exec_pane_id` COALESCE fold, independent of tab_id arm (confirms pane-resolves-before-tab)
- src/exec-backend.ts:248-252 — `renameTab(session, tabId, name) -> {ok}` (unchanged)
- README.md ~1729-1749, CLAUDE.md ~243-252 / ~311-318 — doc rewrite targets

### Risks

- **Post-write observe window:** between `renameTab` success and the feed
  reporting the new name, a kick/poll re-reads the old `tab_name`. The memo
  suppresses re-actuate in the window; even a slipped-through re-actuate is
  idempotent (rename to the same value). Acceptable per reconcile literature.
- **Feed liveness:** if the zellij plugin is down, drift produces no feed
  line -> no DB write -> neither kick nor poll sees it. Pre-existing (the old
  poll read the same frozen column) — no regression, but the convergence loop
  closes through the feed.
- **Multi-pane-per-tab:** zellij renames tabs, not panes; two sessions
  sharing one tab can't both be honored — lowest `job_id` wins (unchanged).

### Test notes

- `bun test test/tab-namer-worker.test.ts`. Extend `insertJob` to seed
  `backend_exec_pane_id`; re-key memo assertions to SESSION::PANE_ID.
- New cases: (1) **drift re-assertion** — converge, flip `backend_exec_tab_name`
  to `Tab #5`, assert re-rename (the headline fix); (2) **post-write window** —
  memo suppresses re-issue while `tab_name` still shows the old value;
  (3) **clear-on-convergence** — `tab_name === sanitized` deletes the memo
  entry; (4) **pane-keyed prune**. The pure `runTick` exercise (Worker thread
  not spawned) stays the test vehicle, matching existing style.

## Acceptance

- [ ] `daemon.ts` `pumpWakes` posts `{type:"kick"}` to the tab-namer after `drainToCompletion`, gated on `folded && !shuttingDown`, alongside the server-worker kick
- [ ] The 5s `setInterval` is gone; the worker runs a `data_version` poll backstop (~2500ms, autocommit) + a coalesced kick fast-path, with the immediate first tick preserved
- [ ] Kick handling is re-entrancy-safe (`isRunning` + `pendingKick` drain-then-arm) and try/catch-wrapped (no-self-heal)
- [ ] `runTick` renames unconditionally when `sanitize(title) !== backend_exec_tab_name`; no `job_id`-keyed permanent suppression remains
- [ ] Memo is keyed SESSION::PANE_ID, set on `{ok:true}`, deleted on observed convergence, untouched on failed rename
- [ ] A drift to the zellij default after resume re-converges within one kick/poll cycle (covered by the drift re-assertion test)
- [ ] `readLiveJobsForTabNaming` selects `backend_exec_pane_id`, keeps `backend_exec_tab_id IS NOT NULL`; dedup stays `(session, tab_id)` lowest-`job_id`
- [ ] `bun test test/tab-namer-worker.test.ts` passes with pane-keyed assertions + new cases
- [ ] Stale prose rewritten: worker header (:1-86), daemon `:2893` comment, README tab-namer paragraph, CLAUDE.md kick bullet + watcher carve-out

## Done summary

## Evidence
