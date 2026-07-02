## Description

**Size:** M
**Files:** cli/dispatch.ts, plugins/plan/src/verbs/ (close claim seam), plugins/keeper/skills/dispatch/SKILL.md, plugins/plan/README.md

### Approach

Three bounded fixes. (1) Claim-time exclusivity: the close flow's claim step asserts no
other live close claim exists for the epic and fails loud for the second claimant (typed
error, worker exits with the loser message) — this owns duplicate-close correctness for
every race origin; the manual-spawn boot-window duplicate costs only a wasted boot and is
documented in the verb help (the CLI has no sanctioned pre-announce write path — do not
invent one). (2) Manual lane resolution: resolvePlanCwd (cli/dispatch.ts:205-263) resolves
close:: for a worktree epic to the epic lane worktree dir exactly as the reconciler does
(reuse the deterministic naming; the lane path carries a dirhash so resolve via git worktree
list filtered by the lane branch, or the reconciler's own resolution seam) — falling back to
project_dir with a printed warning when no lane exists. (3) Race-guard messages
(cli/dispatch.ts:289-301): refusals name the right-path-first recovery — warm bus-resume for
a stopped-but-live session, the occupancy pill / reclaim path for dead ones — with --force
last. Update the dispatch skill's quoted refusal lines + exit-taxonomy row and the plan
README close-preflight sentence in the same change.

### Investigation targets

**Required** (read before coding):
- cli/dispatch.ts:205-308 — resolvePlanCwd + checkRaceGuard + messages
- The close claim path in plugins/plan/src (where /plan:close claims the epic — find the seam task .1 established; exclusivity asserts there)
- src/worktree-git.ts:693-783 — lane naming/classifier vocabulary to mirror (re-derive, don't import)

### Risks

- Lane resolution from the CLI must not spawn unbounded git work — one worktree-list call, bounded timeout, fail-open to project_dir with the warning.

### Test notes

Plan-suite claim exclusivity test (second claimant typed failure); dispatch cwd resolution
via pure seam with fake worktree list; message text snapshot tests.

## Acceptance

- [ ] Second concurrent close claim fails loud with a typed error; first proceeds unaffected
- [ ] keeper dispatch close:: for a worktree epic runs in the lane dir (fallback warns); work:: behavior unchanged
- [ ] Refusal texts name resume/reclaim before --force; dispatch skill + plan README updated to match

## Done summary

## Evidence
