## Description

**Size:** M
**Files:** plugins/keeper/skills/debug/SKILL.md (new), plugins/plan/template/agents/worker.md.tmpl (one pointer line)

### Approach

Author keeper's missing debugging skill, feedback-loop-first: Phase 1 IS the skill — no
hypothesizing before a tight, red-capable, already-run-once reproduction command exists; then
ranked falsifiable hypotheses tested one at a time; instrumentation tagged (e.g. [DEBUG-xxxx])
for one-grep cleanup. Adapt for unattended operation: where an interactive flow would ask the
human, the worker escalates (typed BLOCKED: with the evidence gathered) — and "cannot build a
feedback loop" is itself a hard stop that escalates rather than a license to guess. Include
keeper-native loop-building moves: keeper history forensics for who/when regressions,
retryUntil-style polling over sleeps, the fast test tier as the default loop substrate.
Trigger discipline per the authoring method: one trigger per branch (fires on debugging intent
— "why does X fail", "intermittent", "regression" — not on any error mention); model-invocable
(workers must reach it autonomously). Add one pointer line in the worker template's escalation
section so workers discover it.

### Investigation targets

**Required** (read before coding):
- plugins/keeper/skills/*/SKILL.md frontmatter — description/trigger conventions to match
- plugins/plan/template/agents/worker.md.tmpl BLOCKED: escalation section — the seam the skill hands off to
- The keeper-history-forensics snippet (vendored corpus) — cite, do not restate

### Risks

- Trigger overlap with troubleshoot-shaped /hack usage in interactive sessions — scope the description to in-flight code debugging, not system inquiry.

### Test notes

Skill-id lint green; render consistency green after the template pointer; dry-run the skill
body against a real past failure (pick one from the review evidence) as a desk check.

## Acceptance

- [ ] Skill exists, model-invocable, loop-before-hypothesis contract explicit, escalate-not-ask adapted
- [ ] Worker template points to it from the escalation path

## Done summary

## Evidence
