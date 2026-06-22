## Description

**Size:** S
**Files:** cli/dispatch.ts (resolvePlanCwd ~:196), src/autopilot-worker.ts (launch arm ~:943), test/autopilot-worker.test.ts, test/dispatch-command.test.ts, plugins/keeper/skills/dispatch/SKILL.md, docs/exec-backend.md, README.md

### Approach

Today both dispatch paths resolve `cwd = task.target_repo ?? project_dir`
and guard ONLY `cwd === ""`, so a stale (renamed-away) path passes and the
work silently never runs. Add an existence stat at both producer sites: if
the resolved cwd does not exist on disk, fail LOUD. The CLI (`cli/dispatch.ts`)
returns `{ok:false, error:"cwd-missing: <path>"}` (non-zero exit). The
autopilot launch arm (`src/autopilot-worker.ts`), instead of `continue`-ing
silently, marks the task blocked-with-reason via keeperd's EXISTING
dispatch-failure / blocked-reason runtime surfacing (whatever block.ts /
dispatch_failures already provide) — NO new `src/db.ts` projection column.
Other epics keep dispatching (per-task block, not a queue stall).

### Investigation targets

**Required** (read before coding):
- cli/dispatch.ts:144-203 — `resolvePlanCwd`; the `cwd === ""` guard at :196 is where the existence check joins.
- src/autopilot-worker.ts:939-947 — the launch arm; :943 `cwd === ""` `continue` (the silent-skip site). Find how it already surfaces dispatch failures / blocked reasons.
- plugins/plan/src/verbs/block.ts — the existing gitignored block runtime state (emitReadonly, free-text reason) — the no-DDL surface to reuse / mirror.
- test/autopilot-worker.test.ts:642 ("task target_repo override wins over epic project_dir for cwd") — add the missing-cwd-blocks case here; test/dispatch-command.test.ts for the CLI path.
- keeper CLAUDE.md — re-fold determinism: the stat MUST live in the producer (resolvePlanCwd / autopilot reconcile launch arm), NEVER in buildEpicMessage/buildTaskMessage fold arms. Verify both sites are producers, not folds.

### Risks

- Re-fold determinism: do NOT add `existsSync`/`stat` inside any fold arm; confirm resolvePlanCwd and the autopilot launch arm are producer paths.
- Transient ENOENT (an unmounted drive / detaching share) blocks rather than rename — acceptable for v1 since the block is recoverable (operator fixes the mount or runs mv-repo, then retries). Note retry/backoff as a deferred nicety; do not build it now.
- Keep the block per-task: one missing cwd must not stall dispatch for unrelated epics.

### Test notes

Autopilot: a task whose resolved cwd is missing-on-disk is marked blocked-with-reason and NOT launched, while a sibling epic with a valid cwd still dispatches. CLI: `keeper dispatch` on a missing cwd exits non-zero carrying `cwd-missing`. keeper core `bun lint` + `bun test`.

## Acceptance

- [ ] dispatch CLI returns a non-zero `cwd-missing: <path>` error when the resolved cwd does not exist
- [ ] autopilot marks the task blocked-with-reason (existing runtime surface, NO new src/db.ts column) instead of silently `continue`-ing
- [ ] the existence stat lives only in producer paths — fold arms (buildEpicMessage/buildTaskMessage) stay pure
- [ ] unrelated epics keep dispatching; dispatch SKILL exit taxonomy + exec-backend + README updated
- [ ] keeper lint (bun) + `bun test` green

## Done summary

## Evidence
