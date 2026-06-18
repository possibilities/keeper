## Description

**Size:** M
**Files:** template/agents/worker.md.tmpl, template/skills/work.md.tmpl, docs/reference/commit-at-mutation-boundary.md

### Approach

All seven behavior changes land in template/agents/worker.md.tmpl; edit the
template only (rendered agents/worker-*.md + sidecars are gitignored and
sha256-guarded), keep prose tier-agnostic (Jinja `{{ current_variant }}`
placeholders at :2,:5), finish with `promptctl render-plugin-templates
--project-root /Users/mike/code/planctl` in the same commit. Present-tense
forward rules only.

1. **Phase 3 rewrite (:99-114).** Keep the manifest→command table. New
   ladder: run targeted tests first — scope from the task `Files:` list and
   tests you wrote/changed, using the ecosystem's file-arg form (pytest
   paths, `bun test <file>`, jest/vitest paths, `cargo test <filter>`);
   when no selector exists, targeted collapses into the full pass. Then ONE
   full-suite pass. Hard cap: two full-suite runs per worker invocation
   (matching the work skill's per-invocation budget semantics). Failures
   confined to tests you did not touch: re-run just those files serially
   once — pass means proceed to commit and record the flake in `Tests:`
   (mixed pass/fail = flaky; annotate, never code-fix-loop it). Failures in
   your own touched tests/code stay in the existing fix-then-rerun loop but
   re-runs are TARGETED, never another full pass. If you cannot get touched
   tests green, the existing typed escalation applies — do not commit, do
   not mark done. Never background a test run or idle-wait on one; run
   foreground and act on the exit. Hard-blocked actions, stated adjacent to
   the cap: adding skip markers, commenting out assertions, weakening
   matchers, or deleting tests to get green.
2. **Predecessor pickup (:70-75).** Tighten "verify the diff covers the
   acceptance": read the predecessor commit's diff (`git show <sha>`) and
   run the task-targeted tests only — never a full re-read of every file
   nor a fresh full-suite pass (the predecessor's commit is the confidence
   anchor; one full pass remains available under the cap if the targeted
   run raises doubt). Partial coverage → continue from Phase 3 against the
   existing tree for the uncovered acceptance items. Task-targeted tests
   failing in code you did not write → treat as your task's code (fix
   within budget) only when the failure is in this task's acceptance
   surface; otherwise BLOCKED: DEPENDENCY_BLOCKED naming the commit. When
   both a predecessor commit AND uncommitted work exist, the uncommitted
   branch (:73) wins — continue from Phase 3 against the tree.
3. **Envelope-vs-git trust rule (new, Phase 4/5).** Trigger on suspicion
   only: a `keeper commit-work` or `planctl done` envelope reports failure
   or omits an expected field (e.g. no sha) while your own state says the
   operation should have succeeded — or any envelope contradicts what you
   just observed. Then run ground truth: `git log -1 --format='%H %s'` and
   `git log --format='%H %s' --grep "Task: $TASK_ID"`. Git output wins —
   never adjudicate by reasoning. If git shows the commit landed, proceed
   (the envelope was wrong); if git agrees with the failure, retry the verb
   ONCE; still inconsistent → BLOCKED: TOOLING_FAILURE carrying both the
   envelope JSON and the git output verbatim.
4. **Verb-lookup bans.** Phase 5: the `planctl done` invocation shown is
   complete — running `planctl done --help` first is a wasted call; and
   make :144's nudge a hard ban (no post-done `planctl show`). Preserve the
   legitimate conditional `$PLANCTL show $TASK_ID` at :64.
5. **Return cap (Phase 6, :150-162).** The return is the 5 template lines
   plus at most 3 note lines. No self-check narration — returning at all
   implies it passed. Evidence by reference, never full test output. When
   notes contend, precedence: flake/blocked detail > predecessor note >
   similar-code elaboration.
6. **Mandatory self-check (:136-148).** The Phase 5 delivery self-check
   (`keeper session-state`, confirm `session_files` empty) runs on every
   path including no-op tasks; reasoning over raw `git status`/porcelain is
   banned. `keeper session-state` erroring routes to the existing
   BLOCKED: TOOLING_FAILURE path — there is no porcelain fallback.
7. **Similar-code principle (:83-89).** Delete the fenced grep command;
   keep the principle: before writing new code, search the repo for
   existing similar code (any search tool), pick reuse / extend / new, and
   note the choice for the Phase 6 `Similar-code:` line.
8. **Rules block (:184-192).** Echo as standing rules (resume directives
   skip phase text): the two-full-run cap + foreground-only tests; the
   test-disabling ban; the mandatory self-check / no-porcelain rule; trust
   git over envelopes (one retry then BLOCKED); the 5+3 return cap. Group
   under one "Budgets & trust" bullet with sub-bullets if ten flat lines
   read poorly.
9. **template/skills/work.md.tmpl one-liners.** The
   `in_progress_uncommitted` resume nudge (:125) gains the cap guard
   ("…run tests within your two-full-pass budget…"); :105's return
   description names the cap (drop "if any"); :117's delivery-self-check
   wording uses the same mandatory language as the worker template.
10. **docs/reference/commit-at-mutation-boundary.md:483** — "free-text
   return summary" becomes "capped return summary".

### Investigation targets

**Required** (read before coding):
- template/agents/worker.md.tmpl:29-39,60-75,83-89,99-114,116-134,136-162,184-192 — every edit site, post-fn-13 shape
- template/skills/work.md.tmpl:105,117,125,163 — the three one-liners + cold-resume pointer
- tests/test_generated_guard_hook.py:120 — pinned regenerate command string

**Optional** (reference as needed):
- template/agents/practice-scout.md.tmpl — budget-ladder phrasing precedent (fn-17)
- docs/reference/commit-at-mutation-boundary.md:466-495 — worker-return contract context
- tests/test_work_skill_consistency.py:38-60 — what the consistency scanner asserts (work.md.tmpl only; do not add fenced bash blocks to worker.md.tmpl that would mint fragile string contracts)

### Risks

- Resume-directive precedence: any rule living only in phase text is invisible to a resumed worker — step 8 is load-bearing, not cosmetic.
- Keep new git-log guidance as prose, not fenced bash blocks, to avoid future string-contract fixtures.
- Do not blanket-ban `planctl show` — :64's conditional use is legitimate.

### Test notes

`uv run pytest tests/` green; re-render produces no tracked drift; eyeball
one rendered agents/worker-medium.md to confirm tier-agnostic prose.

## Acceptance

- [ ] All ten edits above landed; rendered files + sidecars regenerated in the same commit
- [ ] Two-full-run cap, foreground-only, test-disabling ban, mandatory self-check, git-trust rule, and return cap each appear BOTH in their phase and in the Rules block
- [ ] Phase 1 conditional `$PLANCTL show` intact; no tombstone or backward-facing phrasing anywhere
- [ ] `uv run pytest tests/` passes

## Done summary
Hardened the worker agent template: bounded Phase 3 test phase (targeted-then-one-full-pass, two-full-run cap, foreground-only, test-disabling ban), cheapened predecessor pickup (commit diff + task-targeted tests), added envelope-vs-git trust rule, banned planctl done --help / post-done planctl show, made the keeper session-state self-check mandatory, capped the return summary, and echoed every new rule in the Rules block. Mirrored one-liners into the work-skill template and commit-at-mutation-boundary.md; re-rendered the four worker agents.
## Evidence
