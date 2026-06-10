## Overview

Remove the snippet-substrate prompt surface from planctl so agents stop being
prompted to curate, browse, render, or read snippet/bundle context, while the
CLI verbs (`epic/task set-snippets`/`set-bundles`), `bundle_ref.py` validation,
`sketch_refs.py`, and persisted schema fields stay dormant and functional for a
later revival. Rides along: fix the `Task(subagent_type=...)` spawn examples in
every skill to the registered plugin-scoped `plan:*` names — bare names fail at
spawn time in live sessions.

## Quick commands

- `grep -rni "snippet\|inherited_bundle\|find-snippets\|render-spec" skills/ agents/ template/ docs/diagrams/ CLAUDE.md` — expect no curation/rendering instructions; only code-excerpt uses of the word (e.g. repo-scout's "<10-line snippets" show-shape rule) remain
- `grep -rn 'subagent_type="' skills/ template/` — every name is `plan:`-scoped
- `uv run pytest tests/` — green under the fast default gate

## Acceptance

- [ ] No prose in skills/, agents/, template/, or docs/diagrams/ instructs any agent to curate, browse, harvest, render, or read snippet/bundle substrate
- [ ] `planctl claim` and the close preflight no longer shell `promptctl render-spec`; the brief keeps `snippet_context` present and always `""` (schema_version stays 1)
- [ ] `scaffold` success envelope carries no no-substrate advisory
- [ ] All `Task(subagent_type=...)` examples in skills/plan, skills/close, skills/defer use `plan:`-scoped names
- [ ] CLI verbs, `bundle_ref.py`, `sketch_refs.py`, and persisted `snippets`/`bundles` fields are unchanged and still pass their tests (dormant, not removed)
- [ ] No backward-facing prose anywhere — deletions leave present-tense rules, never tombstones

## Early proof point

Task that proves the approach: ordinal 1 (the prompt-surface scrub). If the
generated-file re-render pipeline fights back, recovery: run
`promptctl render-plugin-templates --project-root /Users/mike/code/planctl`
manually and reconcile sidecars before committing the templates.

## References

- fn-12 (crush close skill into coordinator) rewrites `skills/close/SKILL.md` and `agents/quality-auditor.md` — wired as a hard dep so this epic lands on the post-fn-12 shape of those files
- `/arthack:sketch` (arthack repo) still emits a `--bundle sketch/<slug>` first line when re-entering `/plan:plan`; the strip-and-ignore rule in task 1 keeps that handoff non-breaking. Removing the emission on the arthack side is out of scope here
- Brief dormancy shape: keep `snippet_context` key present and empty — additive-only within brief schema v1; consumers never crash on a missing key
