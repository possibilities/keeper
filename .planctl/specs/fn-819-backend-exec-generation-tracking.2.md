## Description

**Size:** M
**Files:** src/restore-set.ts, scripts/restore-agents.ts, test/restore-set.test.ts, test/restore-agents.test.ts

The keystone: a read-time derivation bounding crash candidates to the LAST generation window (kill-anchored), exposed via a `restore-agents --last-generation` flag.

### Approach

Add `deriveLastGenerationSet(db)` to restore-set.ts. Compute the crash-like foreground+all candidate set with the SAME membership/filters as `deriveRestoreSet` (close_kind crash-like + burst backstop; exclude window_gone_server_alive, plan_verb='work', already-live, idle-past-cutoff). Then bound to the kill-anchored generation window: `K_max = MAX(last_event_id)` over the candidates; `B_boundary = SELECT MAX(id) FROM events WHERE hook_event='BackendExecStart' AND id <= K_max` (the generation start the most-recent kills belong to — robust to the boot-ordering race because it anchors on the settled kills, never "the current generation"). Keep candidates with `last_event_id >= B_boundary`. If `B_boundary` is NULL (no BackendExecStart before the kills — fresh/pre-feature DB), FALL BACK to the burst heuristic: restrict to the most-recent contiguous Killed cluster (reuse `burstEventIds`). Empty candidate set → empty result. Reuse `RestoreCandidate` + `compareCandidates` verbatim (resume_target = latest name). Column is `events.id`, NOT `event_id`. Then add `--last-generation` to restore-agents `parseArgsTyped` + a `loadLastGenerationSet` sibling of `loadRestoreSet`; `main()` picks the set by flag; composes with `--apply` + `--session`.

### Investigation targets

**Required** (read before coding):
- src/restore-set.ts:287-354 `deriveRestoreSet` (membership/filters to reuse), :369-415 `deriveCurrentSet` (the read template), :252-275 `loadRows` (jobs-only today — add the new direct `events` read), :190-220 `burstEventIds` (the NULL-boundary fallback), :160-178 `compareCandidates`, :101-132 KilledJobRow/RestoreCandidate
- src/db.ts:362 — events PK `id`
- scripts/restore-agents.ts:149-168 `parseArgsTyped`, :455-492 `loadRestoreSet`/`loadCurrentSet` (the try/catch→die open pattern to mirror), :502-536 `main` (mutual-exclusion is only --apply vs --snapshot-current today)

### Risks

- Wrong column (`event_id` vs `id`) throws at read time — events PK is `id`.
- The NULL-boundary fallback (no BackendExecStart yet) must degrade to the burst heuristic, not to the full 7-day pool (that reintroduces the over-offer the epic fixes).
- Keep the read daemon-down-safe: a direct readonly `events` query on the same handle `loadRestoreSet` opens, no socket.

### Test notes

restore-set tests (freshDbFile): seed `BackendExecStart` events + killed crash-like foreground rows straddling two generation boundaries + an older straggler from a prior generation; assert ONLY the last-generation kills return and the straggler is excluded. REGRESSION fixture: replay the boot-ordering scenario (dead-gen kills at ids < the new BackendExecStart) and assert the naive "after most-recent start" would have returned empty while `deriveLastGenerationSet` returns the dead-gen agents. NULL-boundary case → burst fallback. restore-agents test: `--last-generation` selects the new set, composes with `--session foreground`.

## Acceptance

- [ ] `deriveLastGenerationSet` bounds to the kill-anchored window (`last_event_id >= MAX(events.id <= K_max)`), excludes prior-generation stragglers, falls back to the burst heuristic when no BackendExecStart exists, returns empty cleanly on no candidates.
- [ ] Reads only `events` + `jobs` off a read-only DB (daemon-down OK); reuses RestoreCandidate + compareCandidates (latest-name resume_target).
- [ ] `restore-agents --last-generation` composes with `--apply` + `--session`; regression fixture replays the boot-ordering scenario.
- [ ] `bun run test:full` green.

## Done summary
Added deriveLastGenerationSet bounding crash candidates to the kill-anchored generation window (B_boundary = MAX(events.id <= K_max) over BackendExecStart, burst fallback when no boundary), exposed via restore-agents --last-generation composing with --apply + --session. Includes the boot-ordering-race regression fixture; README + HELP updated.
## Evidence
