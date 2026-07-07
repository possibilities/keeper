## Description

**Size:** S
**Files:** cli/autopilot.ts, cli/board.ts, test/autopilot.test.ts

### Approach

`max_concurrent_per_root` only governs dispatch while worktree mode is OFF,
where the effective cap floors to 1 (one worker per shared checkout). Under
worktree mode each ready task gets its own cap-1 lane and the per-root cap is
deliberately ignored, so surfacing `per-root N` beside `worktree:on` — and the
`(stored N)` latent-intent annotation, which advertises an activation that
never occurs — both assert a control that isn't running. Change
`autopilotBannerLabel` to render the per-root segment ONLY when worktree mode
is OFF (showing the effective value, always 1), and drop the stored annotation
entirely. The raw stored value stays in `keeper status` / `keeper watch` JSON,
so nothing is lost for debugging. Remove the now-unused
`maxConcurrentPerRootStored` param from the label signature and its two call
sites, and rewrite the function doc comment to state the mode-gated rule
(forward-facing only — no provenance, fn-ids, or past tense).

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/autopilot.ts:861-905 — `autopilotBannerLabel`; per-root segment ~896-900, doc comment ~844-856.
- cli/board.ts:689-700 — one call site passing `maxConcurrentPerRootStored`.
- cli/autopilot.ts:949-961 — the viewer's second call site passing `maxConcurrentPerRootStored`.
- test/autopilot.test.ts:1026-1163 — banner assertions to update (worktree:on cases drop `per-root …`; the stored-annotation test is removed or repointed to assert suppression).
- src/db.ts:281-287 — `effectivePerRootCap` (worktree off ⇒ 1), confirming the value shown under worktree:off is always 1.

## Acceptance

- [ ] With worktree mode OFF, the header renders a `per-root 1` segment.
- [ ] With worktree mode ON, the header renders no per-root segment at all.
- [ ] No `(stored …)` annotation appears in the header in either mode.
- [ ] `keeper status` / `keeper watch` JSON still carry the per-root effective and stored values.
- [ ] The `set_autopilot_config` reply note in `src/rpc-handlers.ts` is left unchanged.
- [ ] `bun test test/autopilot.test.ts` passes.

## Done summary
Gated the per-root banner segment on worktree mode (visible only when off, showing the effective cap) and dropped the (stored N) annotation entirely; removed the now-unused maxConcurrentPerRootStored param from autopilotBannerLabel and its call sites.
## Evidence
