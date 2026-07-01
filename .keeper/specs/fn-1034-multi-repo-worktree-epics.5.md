## Description

**Size:** S
**Files:** README.md, CLAUDE.md, plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/hack/SKILL.md, plugins/plan/CLAUDE.md

Update all forward-facing docs to describe the landed multi-repo behavior. Prune and consolidate —
never append-only. Forward-facing voice only: state current behavior, no fn-ids/dates/history.

### Approach

1. README.md `## Architecture` worktree section (~3435-3597): rewrite the lane-geometry paragraph
   for per-repo groups (closer runs on primary only; every group's sink provisioned); DELETE the
   "worktree-multi-repo ... unsupported for v1" caveat and replace with the rollout-flag +
   surviving `worktree-repo-unresolved`/`no-primary-repo` rejects; reframe the cross-epic merge-gate
   (~3560-3597) as per-(epic,repoDir); document per-repo finalize keys + the half-landed stuck-state
   + operator recovery via `retry_dispatch`. Update `await landed` (~1524-1527) to explicit
   all-groups-merged semantics.
2. CLAUDE.md "Worktree mode is PRODUCER-ONLY" bullet (~line 119): revise IN PLACE — merge-gate
   sub-clause → per-(epic,repoDir); `worktree-recover*` scope clause → per-repo finalize keying;
   add a one-line rollout-flag note. Keep it within the size gate (`bun scripts/lint-claude-md.ts`).
3. plan/SKILL.md (~577) + hack/SKILL.md (~205,212): qualify "A's finalize merge" as the per-repo
   slice B shares with A (landed = all groups).
4. plugins/plan/CLAUDE.md (~55-56): add any new worktree-lifecycle slow-tier test block name, if one landed.

### Investigation targets

**Required** (read before coding):
- README.md ~3435-3597 (worktree section), ~1524-1527 (`await landed`)
- CLAUDE.md ~line 119 (the producer-only bullet)
- plugins/plan/skills/plan/SKILL.md ~577; plugins/plan/skills/hack/SKILL.md ~205,212
- plugins/plan/CLAUDE.md ~55-56 (slow-tier test listing)

**Optional** (reference as needed):
- scripts/lint-claude-md.ts — the CLAUDE.md size + re-narration gate (must stay green)

### Risks

- Docs discipline (rule #0): prune, never append-only; the CLAUDE.md bullet is size-gated — consolidate rather than grow it.
- Land LAST (depends on all code tasks) so the docs describe shipped behavior, and the four README sub-edits happen once (no intra-section conflict).

### Test notes

`bun scripts/lint-claude-md.ts` stays green. No code tests; verify prose matches the landed behavior of tasks `.1`-`.4`.

## Acceptance

- [ ] README worktree section describes per-repo groups, the removed multi-repo caveat + rollout flag, per-(epic,repoDir) merge-gate, per-repo finalize keys + half-landed stuck-state, and all-groups `await landed`
- [ ] CLAUDE.md producer-only bullet revised in place (per-(epic,repoDir) merge-gate + per-repo recover/finalize scope + rollout-flag note); size gate green
- [ ] plan/hack skill `landed` advice qualified for the per-repo slice; plugins/plan/CLAUDE.md test listing updated if needed
- [ ] Forward-facing voice throughout (no fn-ids/dates/history); `bun scripts/lint-claude-md.ts` green

## Done summary

## Evidence
