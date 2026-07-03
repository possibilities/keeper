## Description

**Size:** S
**Files:** plugins/prompt/corpus/** (subset additions), scripts/vendor-corpus.ts (if the filter rule changes), plugins/prompt/test/vendored-corpus.test.ts

### Approach

Enumerate every `keeper prompt render`/`find-snippets` reference reachable from worker and
skill surfaces — skill bodies, agent briefs, the practice-scout build-time shell teasers,
the arthack prompt-reminder bundle round-trip (bundle/hookctl-bus-pointer) — and verify each
resolves inside the vendored subset with NO arthack checkout (unset KEEPER_PROMPT_CORPUS_ROOT,
point HOME at a scratch dir for the probe). Top up the subset (via the vendor filter rule +
lock bump) for anything missing; drop references instead where the content is
arthack-personal (the reminder bundle may be one — decide per the study's advocacy/drop
verdicts). Extend the vendored-corpus test to pin the reachable-ref set so future skill
edits that add refs outside the subset fail loud.

### Investigation targets

**Required** (read before coding):
- scripts/vendor-corpus.ts — the filter rule + lock mechanics
- plugins/plan/template/agents/practice-scout.md.tmpl render-time shell/render calls
- grep for `prompt render`/`find-snippets` across plugins/*/skills and agents — the reachable set

### Risks

- The subset must stay a SUBSET — don't vendor the whole corpus; arthack-personal domains stay upstream-only.

### Test notes

The probe (render with no arthack root) runs in the prompt plugin's own test tier.

## Acceptance

- [ ] Every worker/skill-reachable ref renders arthack-free; misses topped up or reference dropped with rationale
- [ ] Test pins the reachable-ref set against the subset index

## Done summary
Extended the vendored-corpus drift test to pin every worker/skill-reachable render cite — skill bodies, plan agent briefs, and transitive cites inside vendored snippet bodies — against the subset _index.yaml, so a cite outside the vendored subset fails loud. All reachable refs render arthack-free; the arthack prompt-reminder bundle stays upstream-only (study §4 drop verdict) with an explicit guard.
## Evidence
