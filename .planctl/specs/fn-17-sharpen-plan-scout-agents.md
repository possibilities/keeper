## Overview

Tighten the four plan-phase scout surfaces with rules mined from live
transcripts: epic-scout gets a robust `planctl epics` parse recipe (OSC-prefix
+ trailing-envelope safe) and a write-targets-only Overlaps definition;
docs-gap-scout gets an altitude stop-rule and batched greps; practice-scout
gets a search budget with a convergence-based early exit, knowctl-first
routing for platform subjects, and a local-grep ban; the plan skill's
epic-scout and gap-analyst briefs gain an optional known-context slot so
scouts never re-derive facts the human already stated.

## Quick commands

- `grep -n "raw_decode\|first .{.\|known context\|Known context" agents/epic-scout.md skills/plan/SKILL.md` — parse recipe + slot landed
- `promptctl render-plugin-templates --project-root /Users/mike/code/planctl && git status --short agents/` — practice-scout re-render clean (rendered file + sidecar are gitignored; nothing tracked drifts)
- `uv run pytest tests/` — green (no pytest covers agent prose; this is the regression backstop)

## Acceptance

- [ ] epic-scout prescribes one concrete extraction recipe that survives a leading OSC prefix AND the trailing `planctl_invocation` envelope, and checks `success` before reading `epics`
- [ ] epic-scout extracts and matches Overlaps on files tasks will write, not paths merely mentioned in prose or quick-commands
- [ ] docs-gap-scout has an unconditional no-source-descent rule with flag-as-planner-question fallback, and batched-grep guidance
- [ ] practice-scout (via its template, re-rendered) has a numeric search budget with behavioral ladder + falsifiable convergence stop, knowctl-first routing with an explicit trigger list and fallthrough, and a local-FS grep/read ban that leaves `gh search code` untouched
- [ ] plan-skill epic-scout and gap-analyst briefs carry an optional known-context slot above the instruction, typed lines, explicit do-not-re-derive negative, omitted when empty
- [ ] All new prose is present-tense forward rules — no tombstones, no transcript anecdotes

## Early proof point

Task that proves the approach: ordinal 1. If the Jinja-brace collision in the
practice-scout template fights the new prose, recovery: escape literal braces
or move the example outside the templated region and re-render.

## References

- `planctl epics` stdout shape (verified live): pretty-printed `{success, epics: [...]}` followed by a single-line `{"planctl_invocation": {...}}` envelope; a PTY may prepend an OSC-7 `\x1b]7;file://...` prefix. Any recipe that `json.load`s the whole stream fails on the envelope even with the prefix stripped.
- Budget-phrasing precedents to mirror: quality-auditor "Test Budget Check (Advisory)", work skill "Recovery budget is 5 attempts (1 spawn + 4 retries)", close-planner "Self-correction budget: 3 resubmits".
- Known-context placement evidence: typed key-value lines above the task instruction with an explicit "do not call tools to re-derive these" negative; narrative blobs after the instruction get re-derived anyway.

## Best practices

- **Falsifiable stops beat vague ones:** "stop after two consecutive searches with no net-new claims" — never "stop when you have enough" [budget-aware tool-use literature]
- **Pre-call self-check:** "state in one sentence what net-new fact this search adds; if you cannot, skip it"
- **OSC vs CSI:** CSI-only strippers (`\x1b\[...`) silently miss OSC sequences (`\x1b\]...`); slicing from the first `{` sidesteps both
- **Lane discipline:** name what the agent owns AND what siblings own ("repo-scout owns local code search") so exclusions read as scope, not prohibition
