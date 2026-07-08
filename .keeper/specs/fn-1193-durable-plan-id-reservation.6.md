## Description

**Size:** M
**Files:** plugins/plan/skills/deconflict/SKILL.md, src/daemon.ts, src/autopilot-worker.ts, src/worktree-git.ts, test/daemon.test.ts

### Approach

Close the two destruction routes that hold no lock. Prose first: the deconflict
skill's decline path currently instructs a bare `git merge --abort`, and the
resolver brief instructs the same plus a whole-index concluding `git commit` — both
get an explicit pre-abort/pre-commit beat: list staged paths outside the merge's
own conflict set (`git diff --cached --name-only` versus the conflict paths), and
unstage-and-leave-in-tree any foreign path before aborting or concluding (the exact
move the fn-1177 deconflict session improvised in the incident's second window,
now codified). Code second: recoverSharedCheckoutMidMerge gains a defer arm — before
its flock-guarded automated abort, probe for staged non-conflict paths; when
present, defer this cycle exactly like its existing inconclusive-probe arms (defer,
never a new cleanup behavior; a persistent defer already escalates loudly through
the shared-checkout-wedge grace machinery). The probe must not collapse the
function's existing distinct deferral reasons or its positive-evidence level-clear
discipline, and it slots behind the same commit-work flock the abort already holds.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:4809-4909 — recoverSharedCheckoutMidMerge's guard ladder (owner=keeper topology, resolver exclusion, flock at :4888, abort at :4898) and each existing defer arm's distinct reason string
- plugins/plan/skills/deconflict/SKILL.md:57,94 — the pinned-heads rule and the decline path's `git merge --abort` instruction the pre-abort beat extends
- src/daemon.ts:2255-2350 — the resolver brief: the abort instruction (~:2266) and the whole-index concluding commit step this hardens
- src/worktree-git.ts:1494 — abortMergeIfInProgress, the consolidated abort core (guards live in callers — decide whether the staged-foreign probe belongs in the caller or beside the core)

**Optional** (reference as needed):
- CLAUDE.md Autopilot section — worktree-recover level-clear is positive-evidence-only; the new arm must retain that
- fn-1182's landed state at implementation time — its task .2 rewrites the same SKILL.md/daemon.ts wording; merge with, don't clobber

### Risks

- The defer arm can wedge recovery while junk stays staged; acceptable because the existing wedge grace mints the loud shared-checkout-wedge row — but the defer must log its reason distinctly so the operator sees WHY recovery is deferring
- Distinguishing "the merge's own conflict set" from foreign staged paths mid-merge needs the unmerged-paths read (status UU/AA/DD class), not a hardcoded list — a resolved-then-staged conflict file is legitimately staged and must not trigger the defer
- Skill/brief prose is worker-facing contract: keep the new beat imperative and short, matching the existing skill voice; no history narration

### Test notes

Root fast tier: the recover pass runs under injected git-runner fakes — add cases
arming a mid-merge state with (a) only conflict-set paths staged → abort proceeds,
(b) a foreign staged path → defer with the new distinct reason, (c) foreign path
unstaged next cycle → abort proceeds and the level-clear fires. Brief-text
assertions: the resolver brief contains the pre-abort/pre-commit beat (string-level
test beside the existing brief-content tests in test/daemon.test.ts).

## Acceptance

- [ ] The automated recover-pass abort defers, with a distinct visible reason, whenever non-conflict paths are staged in the shared checkout, and proceeds once they are gone — its existing deferral arms and level-clear semantics unchanged
- [ ] The deconflict skill and the resolver brief both instruct detecting and unstage-preserving foreign staged paths before any merge abort and before the concluding commit
- [ ] A resolver following the revised brief cannot sweep foreign staged files into its merge commit (the concluding-commit step requires a clean foreign index first)
- [ ] Root fast suite passes with the new recover-pass cases

## Done summary
The recover pass defers its keeper-owned mid-merge abort (distinct worktree-recover-staged-foreign reason) when a concurrent commit's files are staged outside the merge's own set, and the deconflict skill + resolver brief now unstage-preserve foreign staged paths before any abort or concluding commit.
## Evidence
