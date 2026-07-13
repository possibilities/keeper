## Description

**Size:** M
**Files:** plugins/plan/src/verbs/epic_rm.ts, plugins/plan/test/saga-epic-rm.test.ts

### Approach

Extend keeper plan epic rm to tear down its epic's lane worktrees across every touched
repo with ADR 0053's discipline, implemented plan-side (the plugin cannot import daemon
src/ and the RPC surface does not widen): enumerate lanes via git worktree list
--porcelain filtered to the keeper/epic/<id>[--<task>] branch convention, classify
ownership with the same probes (git-common-dir inside the repo; locked annotation), back
dirt up to the SAME lane dirt spool (same env var + snapshot format the daemon uses —
convention-shared, code-duplicated by design), then worktree remove --force + prune +
branch delete. A lane that fails any safety leg (foreign/ambiguous/locked, or backup
failure) is SKIPPED and reported, never destroyed; rm never kills or waits on sessions —
torn-down lane paths land in the envelope (informational; the daemon's cwd-missing
sentinel remains the live-session detector). Envelope gains torn_down_lanes +
skipped_lanes fields via the existing emitMutating path; --dry-run (if present) reports
the same sets read-only.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/epic_rm.ts:210 — runEpicRm (deletes only .keeper artifacts today); :140 collectLiveTasks; :299 the emitMutating envelope to extend; :220 primary_repo routing (extend across touched_repos)
- src/worktree-plan.ts:133 — baseBranchFor/ribBranchFor (the branch convention to filter on — read for the convention, do NOT import across the boundary)
- The sibling task's spool env name + snapshot format (convention contract — keep byte-compatible)

**Optional** (reference as needed):
- plugins/plan/test/saga-epic-rm.test.ts — the conformance surface to extend
- plugins/plan CLAUDE.md — plugin isolation + single-JSON-envelope rules

### Risks

- The plan CLI runs in arbitrary cwds — every git call must target the resolved repo dir explicitly; a failure tearing one lane must not abort the .keeper removal (collect-and-report).
- Never destroy on ambiguity — same fail-closed posture as the daemon path.

### Test notes

Extend saga-epic-rm with a fake-git seam or slow-tier real git per existing plugin
patterns: lanes torn down + reported; foreign/locked skipped + reported; backup failure
skips destroy; multi-repo epic tears down in each touched repo; envelope shape stable.

## Acceptance

- [ ] epic rm removes the epic's lanes in every touched repo, backing dirt up to the shared spool first
- [ ] Foreign, ambiguous, locked, or backup-failed lanes are skipped and reported, never destroyed
- [ ] The rm envelope reports torn-down and skipped lanes; .keeper removal proceeds regardless of individual lane failures
- [ ] Plugin isolation holds (no daemon src import; no RPC change)

## Done summary

## Evidence
