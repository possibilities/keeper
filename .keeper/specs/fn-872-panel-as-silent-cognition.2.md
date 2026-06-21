## Description

**Size:** S
**Files:** /Users/mike/code/keeper/plugins/plan/skills/hack/SKILL.md

### Approach

Reframe the `/hack` panel callsite so routing to the panel is silent internal cognition whose judged result the agent absorbs as its own thinking and renders through `/hack`'s existing answer-shape taxonomy — not a relayed artifact.

- **Panel gate (~:90-99):** keep the when-to-panel mechanics (the size gate, the pass-the-question-verbatim / no-leading independence rule). Add the silent-absorb framing: enter panel mode without announcing it (no "let me consult a panel" progress narration); when the judged answer returns, fold it into the mode's normal answer shape (quick-answer / troubleshoot / report / research / sketch — the taxonomy already defined in "How to answer"); the audit calibrates your confidence (consensus -> state plainly; contradictions / blind-spots -> hedge in your own voice) but is not relayed unless the human asks. Echo the existing house pattern at ~:103 ("Don't say 'operating in X mode' — let the structure show it").
- **Work-shaped above-inline path (~:111):** the panel's judgment becomes the sketch's backbone — the sketch is how the panel result surfaces for above-inline work; present the chosen direction as the agent's own, informed by the panel, not "the panel recommended X."
- **Plan warm-handoff (~:175):** soften "the panel's verdict (if it ran)" -> "the conclusion the inquiry reached" — your panel-informed thinking carried forward as the session's own. This is an internal skill-to-skill handoff that legitimately forwards the judged conclusion: suppress display to the human != suppress downstream data flow.
- **pairctl-vs-panel distinction (~:38):** leave the agent-facing routing rationale (what the panel is, when to reach for it) intact — the silence rule governs what the agent says to the human, not what the skill tells the agent. Touch only if the reframe makes the surrounding sentence read oddly.

Forward-facing only; no tombstones (`promptctl render future-facing-docs`).

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/plugins/plan/skills/hack/SKILL.md:90-99 — panel gate
- /Users/mike/code/keeper/plugins/plan/skills/hack/SKILL.md:101-127 — "How to answer" mode shapes the absorbed answer flows into
- /Users/mike/code/keeper/plugins/plan/skills/hack/SKILL.md:111, :175 — work-shaped route + plan handoff

**Optional** (reference as needed):
- /Users/mike/code/keeper/plugins/plan/skills/hack/SKILL.md:38, :103 — pairctl distinction + "let the structure show it" pattern

### Risks

- Editing only the gate and missing that the absorption behavior should be legible where the answer is actually produced (the mode-shape section) — make sure the gate explicitly ties the judged answer to the existing shapes.
- Don't conflate "don't show the human" with "don't pass downstream" at ~:175 (the plan handoff needs the verdict).

### Test notes

- Re-read the gate + handoff sections: no instruction to announce / relay the panel to the human remains; the absorb-and-render framing is present; the independence (verbatim, no-leading) rule is intact.

## Acceptance

- [ ] The panel gate frames routing as silent internal cognition: no announcing the panel, no relaying the audit / composition by default; the judged answer is absorbed and rendered through `/hack`'s existing answer-shape taxonomy.
- [ ] Reveal-on-demand is consistent with the arthack mechanism (audit surfaced only if the human asks about process / provenance); confidence is expressed in the agent's own voice.
- [ ] The work-shaped (~:111) and plan-handoff (~:175) references present the conclusion as the agent's own / forward it downstream without framing it as a relayed "panel verdict"; the verbatim / no-leading independence rule stays intact.
- [ ] Forward-facing wording only; no change-narration.

## Done summary

## Evidence
