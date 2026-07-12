## Overview

The `/plan:panel-guidance` skill and the panel roster it owns ship contradicting
each other: the skill's "closed and non-negotiable" policy reserves the premium
GPT flagship `gpt-5.6-sol` for a single ceiling (`max`) slot, yet the committed
roster uses it in two additional `strong` rungs. Reconcile the two so the skill's
authoring policy matches the artifact it governs, and make the reconciled policy
enforced rather than free-form prose.

## Acceptance

- [ ] The skill's reserve-policy prose and the committed roster no longer contradict on `gpt-5.6-sol` placement.
- [ ] The reconciled policy is enforced by a check (gate and/or consistency test), not left as unpinned prose.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | SKILL.md:56-57,71 reserve `gpt-5.6-sol` for the ceiling `max` panel only, but the owned roster uses it in strong rungs `deep-duo`:123 and `triad`:137 plus `apex`:152 — a shipped cross-artifact contradiction. |
| F2 | culled | — | Advisory readability preference on a deliberately rich-description-live `presets list` surface; `--json` unaffected. Below the keep bar. |
| F3 | merged-into-F1 | .1 | F3 (no gate/test enforces the reserve policy) is the enforcement face of F1's policy-vs-roster contradiction — same root cause, folded into F1's task. |

## Out of scope

- Wrapping/truncating the human `presets list` description output (F2 — culled, deliberate design).
- Any change to the approved 10-panel ladder membership beyond what reconciling the `gpt-5.6-sol` policy requires.
