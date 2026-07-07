## Description

**Size:** M
**Files:** test/restore-sim.test.ts, test/restore-e2e.slow.test.ts, cli/setup-tmux.ts, cli/tabs.ts, src/tabs-core.ts, src/restore-set.ts, src/restore-worker.ts, docs/problem-codes.md

### Approach

Two acceptance instruments plus the docs consolidation. Fast-tier `test/restore-sim.test.ts` (default run, pure in-process): seed a template DB with a dead generation whose candidates include a rehomed-transcript claude tab, a preflight-failing tab, and a non-claude tab; fake the spawn/probe/fs/evidence seams; drive selection → preflight → apply → verify end-to-end and assert per-tab terminal states, the recency-first pick, and the ambiguous escalation. Slow-tier `test/restore-e2e.slow.test.ts` (gated by KEEPER_RUN_SLOW): real tmux on a scratch `-L` socket with a fake harness binary that emits hook-shaped NDJSON evidence on successful "attach" — prove a failed pane stays visible with the diagnosis and a verified restore round-trips; never a real model call. Docs sweep, forward-facing and consolidated: tabs-core SELECTION/RESULT header, restore-set header (generation keying), restore-worker mirror header (clobber guard), cli/tabs HELP + AGENT_HELP (verified transactions, retry, exit 6/7/8 meanings), setup-tmux HELP escalate-or-refuse wording in lockstep, docs/problem-codes.md Tabs rows. setup-tmux's per-session outcome lines surface the per-tab verified/failed/unverified counts from the transaction engine.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- test/restore-worker.test.ts:80-120 — stubTmux fake shape; test/helpers/template-db.ts — freshDbFile seeding
- test/restore-set.test.ts:80-140 — seedJob helpers (generation, harness, resume_target columns)
- an existing *.slow.test.ts — the KEEPER_RUN_SLOW gating convention to copy
- docs/problem-codes.md — Tabs family tables (exit 6/7/8 rows)

**Optional** (reference as needed):
- test/helpers/sandbox-env.ts — mandatory sandboxing for real-state tests
- cli/setup-tmux.ts renderRestoreOutcome — the outcome line to extend with per-tab counts

### Risks

- The slow test must be hermetic: scratch tmux socket, sandboxed state dirs, fake harness binary — a leaked real launch would cost tokens and mutate real state.
- Docs drift: help texts and headers must match shipped semantics exactly — write them last, from the landed behavior.

### Test notes

The sim's assertion set is the epic's acceptance list in miniature — keep one assertion per epic acceptance line so the mapping is auditable.

## Acceptance

- [ ] The fast sim covers rehomed-transcript restore, preflight-failure surfacing, recency-first pick, ambiguous escalation, and verify-timeout disambiguation — green in the default test run.
- [ ] The slow e2e proves, on real tmux, a failed pane stays visible with its diagnosis and a verified restore round-trips against the fake harness.
- [ ] Help texts, module headers, and problem-codes rows state the new behavior consistently, and setup-tmux outcome lines carry per-tab verified/failed/unverified counts.

## Done summary
Added fast-sim (recency-first pick, ambiguous escalation, disk-anchored rehomed-transcript resolve, preflight-failure surfacing, verify-timeout disambiguation) and real-tmux slow-e2e acceptance instruments; fixed setup-tmux's outcome line to surface per-tab verified/failed/unverified counts (docs/help/problem-codes were already consolidated by prior tasks).
## Evidence
