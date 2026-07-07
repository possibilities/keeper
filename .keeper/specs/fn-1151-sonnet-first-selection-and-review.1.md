## Description

**Size:** M
**Files:** plugins/plan/model-selector.yaml, plugins/plan/scripts/model-guidance-check.ts, plugins/plan/agents/model-selector.md, plugins/plan/skills/model-guidance/SKILL.md, plugins/plan/test/consistency-model-selector.test.ts

### Approach

Add a top-level hand_tuned section to the selector policy config carrying the binding
routing rules, and invert every up-bias copy to match. The hand_tuned prose (keep it
prompt-sized — it rides every brief): burden-of-proof for opus — choose opus ONLY on a
concrete, nameable intelligence-bound reason (novel algorithm or design, cross-cutting
multi-file architectural cascade, subtle correctness or security invariant, long-horizon
planning); on a tie or absent such a reason, choose sonnet. Security- or
correctness-critical work is a hard opus gate that overrides cheap-first regardless of
size. Mechanical or templated work takes sonnet at low or medium effort. Anti-anchor
clause: spec length and difficulty adjectives are not difficulty — a short spec can be
intelligence-bound and a long spec mechanical. Model and effort are independent axes:
cranking sonnet's effort is not an opus substitute.

Rewrite the usage block (uncertainty on the model axis resolves DOWN to sonnet absent a
named reason; effort uncertainty resolves to the lower band for mechanical work), the
opus/sonnet model guidance blocks (opus exceptional, sonnet default workhorse), and the
effort blocks (xhigh is no longer the default-when-in-doubt). Flip the SECOND up-bias
copy — the agent prompt's route-up fallback — to the same sonnet-first rule, and
instruct the agent that hand_tuned is the binding tie-break policy with highest
precedence. Teach the guidance-check coercion to parse and retain the hand_tuned key
(the failure mode is silent dropping that still passes the gate). Update the
model-guidance skill's ownership prose: hand_tuned is human-owned judgment, never
research-refreshed. Guidance stays capability-shaped — no cost or provider language.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/model-selector.yaml:33-42 — the usage block carrying the pick-UP rule to invert; :44-77 effort blocks; :79-93 the opus/sonnet blocks
- plugins/plan/agents/model-selector.md:38-52 — brief consumption + the second route-up fallback copy at :51
- plugins/plan/scripts/model-guidance-check.ts (~:230 coerceModelSelectorConfig; :157-164 coverage gate) — where hand_tuned must be admitted

**Optional** (reference as needed):
- plugins/plan/src/verbs/selection_brief.ts:239,270 — the verbatim selector_config_yaml injection (why the new key rides for free)
- plugins/plan/skills/model-guidance/SKILL.md — ownership + edit-discipline prose to update

### Risks

- Silent ineffectiveness: if the coercion drops hand_tuned or the agent prompt never
  references it, the inversion is a no-op that still passes every gate — test that the
  rendered brief carries the section verbatim.
- Leaving either bias copy unflipped produces a config/prompt contradiction the selector
  resolves unpredictably.

### Test notes

Consistency test extended: hand_tuned present and retained through coercion; no
pick-up/keep-opus phrasing remains in config or agent prompt (grep-level assertion);
drift gate green both directions.

## Acceptance

- [ ] The rendered selection brief carries the hand_tuned section verbatim and the
      guidance drift gates pass with it present.
- [ ] No when-uncertain-route-up guidance remains in the selector config or the selector
      agent prompt; both carry the sonnet-first burden-of-proof rule and the anti-anchor clause.
- [ ] Guidance prose carries no cost or provider language, and the model-guidance skill
      documents the hand_tuned section as human-owned.

## Done summary
Added a human-owned hand_tuned burden-of-proof section to model-selector.yaml and inverted both up-bias copies (config usage/effort/model blocks and the selector agent prompt) to a sonnet-first default; taught the guidance-check coercion to retain hand_tuned so a silent drop fails loud.
## Evidence
