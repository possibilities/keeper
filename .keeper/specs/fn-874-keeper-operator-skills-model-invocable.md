## Overview

Make `keeper:dispatch` and `keeper:autopilot` model-invocable (like
`keeper:await`), keeping ALL behavioral guardrails, and reframe the now-false
"slash-only / exceptional / dark-by-design" stance fn-871 baked in. Add one
concise cross-skill orchestration section to `/hack` and `/plan` teaching how to
COMBINE the operator skills for multi-epic work. Discovery is automatic once
model-invocable (descriptions auto-surface); the only gap this fills is
cross-skill orchestration. A human-directed, PARTIAL philosophy shift:
dark-by-design -> agents may orchestrate execution on clear intent, while the
planning skills still never proactively surprise-launch.

## Quick commands

- `grep -L 'disable-model-invocation' plugins/keeper/skills/dispatch/SKILL.md plugins/keeper/skills/autopilot/SKILL.md` — both should now lack the flag (model-invocable)
- `grep -rn 'dark about execution by design\|never advertise\|operator hatch' plugins/plan/skills plugins/plan/CLAUDE.md` — carve-out relaxed, nothing left contradicting model-invocable reality
- manual over-trigger stress-test: re-read both descriptions against adjacent phrasings ("work on fn-X" -> /plan:work, "prioritize Y" -> plan:next)

## Acceptance

- [ ] `keeper:dispatch` + `keeper:autopilot` are model-invocable (`disable-model-invocation` removed); `keeper:await` unchanged
- [ ] ALL behavioral guardrails retained in both skills (surface-and-ask, never auto-pause, `--force` human-gated, capture->restore, anti-triggers)
- [ ] descriptions re-tuned to precise intent triggers with near-miss exclusions intact; the "EXPLICITLY" slash-only framing removed
- [ ] stance prose reframed ("exceptional / human-gated / slash-only" -> "precisely-triggered, conservative by default"); forward-facing only
- [ ] carve-out at hack:183 / defer:14,186 / plan/CLAUDE.md relaxed to PARTIAL consistently; `/plan:hack` itself stays slash-only; hack's "Orchestration is yours to shape" closed list NOT widened into "freely drive execution"
- [ ] one concise cross-skill orchestration section added to `/hack` AND `/plan` (daisy-chain, parallel yolo vs sequential armed, take-over)
- [ ] no README.md / CLAUDE.md enumeration change; no `_partials` infra; no `--agent-help` CLI work (all out of scope)

## Early proof point

Task that proves the approach: `.1` (the skill flip + description re-tune). If the re-tuned descriptions can't be made tight enough to avoid over-trigger on "work on fn-X" / "prioritize Y", reconsider before writing the orchestration section in `.2`.

## References

- fn-871 (done) — created these skills and the stance this change partially reverses
- `plugins/keeper/skills/await/SKILL.md` — the model-invocable description template
- Committed: PARTIAL stance relaxation; Piece-2 = Option A (inline prose, no `_partials`); `--agent-help` on the CLIs remains a separate deferred follow-up

## Docs gaps

- **plugins/plan/CLAUDE.md (~:34)**: relax the keeper-hatch-advertising clause — but KEEP the "`/plan:hack` is slash-only (`disable-model-invocation: true`)" clause, which refers to `/plan:hack` itself (unchanged).
