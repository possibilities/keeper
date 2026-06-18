## Description

**Size:** S
**Files:** template/agents/worker.md.tmpl, template/agents/worker-codex.md.tmpl, docs/reference/commit-at-mutation-boundary.md, CLAUDE.md, README.md, (regenerated) skills/work/SKILL.md + work-plugins/*/agents/worker.md

Repoint the worker agent templates from `keeper find-task-commit` to `planctl find-task-commit`, reword the reconcile negations present-tense, document the new verb, and regenerate the derived skill + worker plugins. Depends on task 1 (the verb must exist and behave before the consumer switches — the extend→migrate→delete ordering).

### Approach

The ONLY true worker-side call sites are `template/agents/worker.md.tmpl:75` and `template/agents/worker-codex.md.tmpl:79` ("or `keeper find-task-commit $TASK_ID` returns a commit") — swap `keeper`→`planctl` in both. These are the source-of-truth templates; do NOT hand-edit the 6 generated `work-plugins/*/agents/worker.md` (the `check-generated` guard fails on drift). Do NOT touch `template/skills/work.md.tmpl:114/190` — those are reconcile NEGATIONS ("the orchestrator does not hand-fire …"), not worker calls; blind-swapping inverts their meaning. The stale `keeper find-task-commit` lines in the GENERATED `skills/work/SKILL.md:127,164` are drift from an older template render — do NOT hand-edit; the regen below reconciles them.

Reword (do NOT blind-swap) the reconcile-recovery negations so they name the surviving planctl verb and stay forward/present-tense (no-tombstones rule): `docs/reference/commit-at-mutation-boundary.md:464` and the `CLAUDE.md` reconcile bullet (~line 53), which list `no hand-fired keeper find-task-commit` — these should reference `planctl find-task-commit` (reconcile folds it; the orchestrator still doesn't hand-fire it). Add a present-tense `find-task-commit` blurb to `README.md`'s Command Map + bare-command list (envelope shape, wraps commit_lookup, read-only) — never framed as "replaces keeper".

Then regenerate: `promptctl render-plugin-templates --project-root /Users/mike/code/planctl` (regenerates `skills/work/SKILL.md` + the 6 `work-plugins/<tier>/agents/worker.md`), and confirm `check-generated` passes. Finally grep the whole planctl repo for `keeper find-task-commit` and confirm zero live callers remain (the reconcile negations now name planctl; SKILL.md drift cleared by regen).

### Investigation targets

**Required** (read before coding):
- template/agents/worker.md.tmpl:75, template/agents/worker-codex.md.tmpl:79 — the two true swap sites
- template/skills/work.md.tmpl:114,190 — reconcile NEGATIONS; do NOT swap (read to confirm meaning)
- docs/reference/commit-at-mutation-boundary.md:459-468 — the recovery-property negation to reword in context
- CLAUDE.md (reconcile bullet, ~line 53) — negation to reword
- README.md:59-66 — Command Map blurb pattern to follow
- CLAUDE.md "Skills and agents" section — the worker-template generation + `check-generated` + `.managed-file-dont-edit` sidecar machinery; confirm what `render-plugin-templates` regenerates and which outputs the repo tracks vs gitignores

### Risks

- **Wrong target = inverted docs.** The work.md.tmpl/doc/CLAUDE negations describe what reconcile does NOT do; treat them as rewords, not swaps. Only worker*.tmpl:75/79 are real migrations.
- **Generated-file drift.** Edit templates only; run `render-plugin-templates`; `check-generated` must pass. Commit whatever the repo tracks (SKILL.md is tracked-but-generated; verify the worker.md outputs/sidecars per the repo's gitignore).
- **Trailer tolerance.** Confirm the worker template's predecessor-detection text reads the result as "returns a commit" (truthiness over `.commits`) and tolerates the trailing `planctl_invocation` NDJSON line that planctl appends (keeper emitted a single object). No template change needed if it already treats output as parsed JSON.

### Test notes

No unit tests; verification is `check-generated` passing + `grep -rn "keeper find-task-commit" template/ docs/ skills/ CLAUDE.md README.md` returning nothing live. Run `uv run ruff format .` if any Python touched (none expected).

## Acceptance

- [ ] `worker.md.tmpl:75` + `worker-codex.md.tmpl:79` call `planctl find-task-commit`; 6 generated workers regenerated; `check-generated` passes
- [ ] reconcile negations in `commit-at-mutation-boundary.md` + `CLAUDE.md` reworded present-tense to name `planctl find-task-commit` (no tombstones)
- [ ] `README.md` documents `find-task-commit` present-tense (Command Map blurb + bare list)
- [ ] `template/skills/work.md.tmpl:114/190` UNTOUCHED; `skills/work/SKILL.md` reconciled by regen, not hand-edit
- [ ] zero live `keeper find-task-commit` callers remain in the planctl repo

## Done summary
Repointed worker predecessor-detection from keeper to planctl find-task-commit in both worker templates; reworded reconcile negations present-tense (CLAUDE.md, commit-at-mutation-boundary.md); documented the verb in README. Regenerated the 6 worker plugins + SKILL.md via render-plugin-templates (swap propagated, no residual keeper callers).
## Evidence
