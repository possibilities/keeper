## Overview

Close-time selection grading retires: /plan:close keeps only the mechanical capture beat (a now-committed selection-audit brief per epic), and the board-visible selection-review record disappears — verb, projection column, and every display surface. Grading moves to a slash-only skill a human invokes: it assembles a corpus of closed epics from committed briefs + selection sidecars + keeper.db forensics, fans a blinded venue-neutral auditor over it, lands verdicts through the surviving `selection-review-submit` write path, computes cohort metrics with honest statistics, and proposes `model-selector.yaml` guidance edits the human ratifies — strictly advisory, never writing policy.

## Quick commands

- `keeper plan selection-audit-brief <closed-epic> && git -C . log --oneline -1 -- .keeper/selection-audit-briefs/` — the brief lands committed
- `keeper plan selection-review --help; echo "exit=$?"` — the removed verb errors as unknown
- `bun test plugins/plan/test/saga-selection-audit-brief.test.ts` — committed-home conformance
- `keeper status | jq '.data.needs_human | has("selection_reviews")'` — false after the projection sweep

## Acceptance

- [ ] /plan:close commits the mechanical brief and spawns no selection grading; re-close is idempotent on an existing brief
- [ ] The `selection-review` verb, the epics `selection_review` column, and all board/status/readiness display surfaces are gone; historical events still fold safely
- [ ] The committed review dataset gains rubric/judge/prompt version keys and stays joinable with existing verdicts
- [ ] The new skill grades out-of-band with a blinded auditor, derives its watermark from committed briefs minus committed reviews, writes human-facing reports under ~/docs/selection-reviews/, and proposes (never writes) policy edits
- [ ] `bun run test:full` green; SCHEMA_VERSION bump lands with its keeper/api.py whitelist entry in the same commit

## Early proof point

Task that proves the approach: ordinal 1 (committed brief + schema keys + guard rework). If the committed-home or guard semantics fight the existing write-once seam, fall back to a sibling committed dir with fresh guards and leave the legacy paths read-only.

## References

- docs/adr/0011-close-time-selection-review.md — the decision this epic supersedes (task 4 lands the new ADR + status flip)
- `fn-1167-variable-depth-automated-review` (overlap) — edits the same close/SKILL.md and wires close-time quality-audit stamping (audit_policy in selection_sidecar.ts, audit_required in assign_cells.ts); a DIFFERENT audit concept that stays; this epic lands after it
- `fn-1164-phantom-working-lifecycle-fix` (overlap) — bumps SCHEMA_VERSION 112→113 and rewrites reducer.ts around the epics upsert; this epic's migration renumbers to 114, an independent version-guarded block, landing after
- plugins/plan/src/selection_sidecar.ts:11-24 — the committed-artifact invariants the brief's new home copies (top-level data-dir sibling, atomicWriteJson + recordTouched, classifyPlanPath none)
- The grading methodology distilled from external research lives in task 4's spec: counterfactual-aware rubric, blinded verdict pass, verdict version keys, Wilson CIs with minimum cohort counts, commit-then-advance idempotent re-grades, stratified judge spend, corpus-as-injection-surface hardening

## Docs gaps

- **plugins/plan/README.md**: Command Map drops selection-review; Storage Layout moves the brief out of the gitignored state/ block; the close-time selection review section rewrites to the out-of-band model; skills table gains the new skill row
- **docs/problem-codes.md**: prune the selection-review verb codes; keep only codes surviving on brief/submit
- **CONTEXT.md**: redefine "Selection review" (out-of-band committed dataset) and drop the Needs-human entry's display-only-member clause
- **plugins/plan/CLAUDE.md**: removed-verbs entry; skills-and-agents blurb for the new skill
- **docs/adr/**: new superseding ADR (ADR numbers are reused across slugs — pick the next genuinely free integer, 0017+); flip 0011 to Superseded

## Best practices

- **Grade counterfactuals with observable proxies:** "overpowered" requires positive evidence of triviality (diff size, session length, tool calls, retries), never merely "the task succeeded" [Oberst & Sontag; Universal OPE]
- **Blind the verdict pass to the selector's rationale/confidence** — anchoring bias; reveal confidence only to the separate calibration computation [Evidently; dietz]
- **Key verdicts on config_hash + rubric_version + judge_model_version + prompt_hash** so a rubric or judge change never masquerades as a policy shift [MLflow; Arize]
- **Wilson/Agresti-Coull intervals + minimum per-cohort counts** before proposing any policy edit; never act on a week of noise; quantile bins for calibration [Anthropic statistical-evals]
- **Commit-then-advance, idempotent upsert, per-epic atomic units, monotonic pointers never wall-clock** for the incremental corpus [Fowler HWM]
- **Treat the corpus as prompt-injection surface** — worker-generated text feeds the grading LLM; delimit as data; bound committed evidence to pointers, never raw diff quotes [OWASP LLM01]
- **Cohort-rate deltas across policy versions are case-mix-confounded** (the policy chose the cohort) — flag Simpson's-trap comparisons, don't naively diff [OPE literature]
