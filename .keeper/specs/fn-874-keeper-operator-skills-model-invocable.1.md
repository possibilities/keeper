## Description

**Size:** M
**Files:** plugins/keeper/skills/dispatch/SKILL.md, plugins/keeper/skills/autopilot/SKILL.md

### Approach

For BOTH skills:
1. Remove `disable-model-invocation: true` from frontmatter (line ~15 each) so
   the model can auto-fire them.
2. Re-tune the `description` (lines ~4-13 each): drop the "Use when the human
   EXPLICITLY asks..." slash-only framing in favor of precise intent triggers
   ("when the user asks to fire a worker by hand / spawn a closer" for dispatch;
   "when the user asks to pause or steer the autopilot — pause/play, mode, arm,
   retry, or inspect it" for autopilot), KEEPING every near-miss exclusion
   (dispatch: NOT `/plan:work`, NOT `keeper:autopilot`, NOT `/plan:plan`;
   autopilot: NOT `keeper:dispatch`, NOT `plan:next`, NOT `/plan:plan`). The
   exclusions are now the PRIMARY over-trigger defense.
3. Reframe the stance prose in the intros (dispatch ~:21-24, autopilot ~:23-25)
   and the Guardrails sections (dispatch ~:230, autopilot ~:258): "OPERATOR
   ESCAPE HATCH: exceptional and human-gated" / "slash-only" -> "a
   precisely-triggered operator surface, conservative by default."
4. KEEP ALL behavioral guardrails UNCHANGED: surface-and-ask on the race guard
   (dispatch ~:153/:159), `--force` human-gated (dispatch ~:82), capture->restore
   correctness + the anti-triggers (autopilot). These are orthogonal to
   model-invocability and must survive verbatim-in-spirit.

Forward-facing prose only — present tense, no "formerly slash-only" narration.

### Investigation targets

**Required** (read before editing):
- plugins/keeper/skills/await/SKILL.md — the model-invocable description template (no `disable-model-invocation`; imperative + "Use when..." trigger + the "even when the user never says keeper" clause)
- plugins/keeper/skills/dispatch/SKILL.md:4 — frontmatter + description; :21 intro; :82 `--force`; :153 surface-and-ask; :230 Guardrails
- plugins/keeper/skills/autopilot/SKILL.md:4 — frontmatter + description; :23 intro; :258 Guardrails

### Risks

- Over-triggering is THE risk: once model-invocable, `autopilot`/`dispatch` could fire on "work on fn-X" (-> `/plan:work`) or "prioritize Y" (-> `plan:next`). The descriptions must lean hard on the near-miss exclusions. This is why the task is xhigh.
- Do NOT weaken the behavioral guardrails while reframing the stance — they are orthogonal to model-invocability and must survive.

### Test notes

No automated gate (plugins/** excluded from `bun test`; not linted). Manual
over-trigger stress-test — read each re-tuned description against: "work on
fn-X.3" (must NOT match dispatch — that's `/plan:work`), "prioritize fn-Y"
(must NOT match autopilot — that's `plan:next`), "fire a worker on fn-X.3 by
hand" (SHOULD match dispatch), "pause autopilot" (SHOULD match autopilot).
Confirm frontmatter still parses and no `disable-model-invocation` remains.

## Acceptance

- [ ] `disable-model-invocation` removed from both skills' frontmatter
- [ ] descriptions re-tuned to precise intent triggers, near-miss exclusions intact, "EXPLICITLY" framing gone
- [ ] intro + Guardrails stance reframed ("exceptional / human-gated / slash-only" -> "precisely-triggered, conservative by default"), forward-facing only
- [ ] ALL behavioral guardrails retained (surface-and-ask, never auto-pause, `--force` human-gated, capture->restore, anti-triggers)
- [ ] over-trigger stress-test passes on the four anchor phrasings above

## Done summary
Made keeper:dispatch and keeper:autopilot model-invocable: removed disable-model-invocation, re-tuned descriptions to precise intent triggers with near-miss exclusions intact, reframed the slash-only/escape-hatch stance to precisely-triggered/conservative-by-default. All behavioral guardrails retained.
## Evidence
