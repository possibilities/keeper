## Overview

Replace the hand-written two-panel `~/.config/keeper/panel.yaml` with a generated, described,
10-rung panel ladder. Each panel becomes an object `{strength, members, description}` (clean
cutover, no legacy list form); a committed roster at `plugins/plan/panel-selector.yaml` is
enforced by a purely-structural gate and installed verbatim by the new slash-only
`/plan:panel-guidance` skill; `presets list` carries each panel's strength and description so
choosing agents read the ladder live. Decision record: docs/adr/0046. After this epic lands,
the operator completes the cutover once by installing the committed roster to
`~/.config/keeper/panel.yaml` (via `/plan:panel-guidance` or a verbatim copy) — an installed
list-form file fails panel launches with a remediation error until then.

## Quick commands

- bun plugins/plan/scripts/panel-guidance-check.ts --check
- keeper agent presets list --json | jq '.panels[] | {name, strength}'
- bun scripts/vendor-corpus.ts --check
- keeper agent providers check

## Acceptance

- [ ] An object-form panel.yaml loads and launches; a legacy list-form panel fails loud with remediation naming /plan:panel-guidance.
- [ ] `keeper agent presets list --json` emits per-panel strength + description with panels ordered weak→strong.
- [ ] The committed 10-panel roster passes its structural gate and matches the approved ladder (default: workhorse, no haiku, efforts high/xhigh/max only).
- [ ] /plan:panel-guidance exists slash-only with consistency pins green; vendor bake gate and all three test suites green.

## Early proof point

Task that proves the approach: ordinal 1 (schema object cutover across both reader seams). If
it fails: keep the lenient harvester list-only and source description/strength from a second
validated read in the presets-list emitter instead.

## References

- docs/adr/0046-described-panel-roster-ladder.md — the decision this epic implements
- docs/adr/0033 — launch triples as panel members (unchanged by this epic)
- plugins/plan/skills/model-guidance/SKILL.md + plugins/plan/scripts/model-guidance-check.ts — the skill/gate precedent (this epic drops the research/hash-parity half)
- Upstream epic fn-1254-panel-strength-snippet-rubric rewrites the arthack-side snippet source this epic re-vendors; the dep edge exists because the re-vendor task reads the arthack checkout's default branch, which only carries the rewrite after that epic's finalize merge.
- Planning-session verification: the roster below was validated against the live post-haiku cube via the real loader/resolver — 10 panels, 24 members, efforts 11 high / 10 xhigh / 3 max, zero low/medium.

## Docs gaps

- **docs/install.md**: rewrite the panel.yaml walkthrough for the object schema, committed roster + gate, and richer presets list — prune the flat-list framing.
- **docs/problem-codes.md**: providers-check rows address panel members by the flat schema; revise addressing and examples.
- **docs/plugin-composition-map.md**: add the panel-guidance skill + panel-selector.yaml surface, mirroring the model-selector treatment.
- **plugins/plan/README.md**: presets-list text and a /plan:panel-guidance skill row parallel to /plan:model-guidance.
- **plugins/plan/CLAUDE.md**: at most one line naming the roster's owner skill and gate command.

## Best practices

- **Length-normalized descriptions + anti-default rubric:** LLM selectors show documented length/information-mass bias toward the richest option; keep panel descriptions near-uniform and instruct that band is not a tiebreaker. [arXiv 2407.01085]
- **Route by difficulty and stakes, defaulting low:** pick the weakest covering rung and escalate on observable triggers only — cascade/routing literature shows quality gains concentrate in the hard tail. [RouteLLM/cascade surveys]
- **Closed-enum bands in the gate:** a generator typo in `strength` must fail CI, not flow to runtime.
- **Clean cutover with explicit legacy detection:** when one tool owns every producer and consumer, dual-form acceptance is a permanent test-surface tax; detect the old shape and name the remediation instead.
