## Description

**Size:** S
**Files:** plugins/plan/template/agents/worker.md.tmpl, cli/escalation-brief.ts, test/escalation-brief.test.ts

### Approach

Introduce the eighth BLOCKED category `SHARED_BASE_BROKEN`: emitted by a worker ONLY when
`keeper baseline <base sha> --wait` confirms the shared base is red independent of the
worker's own diff, with the BLOCKED message carrying evidence (repo, base sha, failing
command/test, suspected commit when known). Re-point the worker template's
baseline-consult rule — a baseline-confirmed pre-existing red currently emits
DEPENDENCY_BLOCKED — to emit SHARED_BASE_BROKEN with those evidence fields, keeping
DEPENDENCY_BLOCKED for genuine upstream-task deps. Add the category to the template's
category list AND to ESCALATION_CATEGORY_RE in the escalation brief; fix the pre-existing
drift while there (the regex knows RESUME_EXHAUSTED, the template list does not — add it
to the template). Re-render the per-cell worker plugins from the template and keep the
generated-file and model-guidance drift gates green.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/template/agents/worker.md.tmpl:100 — the baseline-consult rule to re-point; :174 — the category list; :82 — the anti-heredoc rule wording (context for the evidence-discipline tone)
- cli/escalation-brief.ts:48-49 — ESCALATION_CATEGORY_RE and how :511 applies it to blocked_reason
- cli/baseline.ts — the oracle's envelope (what "confirmed red at base" looks like to a worker)

**Optional** (reference as needed):
- the plan plugin's template render pipeline (keeper prompt render-plugin-templates --project-root plugins/plan) and its drift gates: consistency-generated-guard tests + model-guidance-check
- test/escalation-brief.test.ts — category-parse test shape

### Risks

- A category in one surface but not the other yields incident_category_unparsed briefs — regex and template must land together
- Template edits propagate to every rendered worker cell; forgetting the re-render trips the generated-file guard

### Test notes

Brief-side: a blocked_reason carrying SHARED_BASE_BROKEN (and RESUME_EXHAUSTED) parses to
its category. Template-side: rendered workers regenerate byte-consistent; both drift
gates pass in the plan suite.

## Acceptance

- [ ] A BLOCKED reason prefixed SHARED_BASE_BROKEN parses to that category in the escalation brief with no unparsed degrade
- [ ] The worker template instructs baseline-gated emission of SHARED_BASE_BROKEN with repo/sha/failing-command evidence, retains DEPENDENCY_BLOCKED for upstream-task deps, and lists both SHARED_BASE_BROKEN and RESUME_EXHAUSTED in its category set
- [ ] Rendered per-cell worker plugins are regenerated and the generated-file + model-guidance drift gates pass
- [ ] Root and plan fast suites green

## Done summary
Added SHARED_BASE_BROKEN escalation category (worker template + escalation-brief regex) and fixed the pre-existing RESUME_EXHAUSTED template drift; added a category-parse test.
## Evidence
