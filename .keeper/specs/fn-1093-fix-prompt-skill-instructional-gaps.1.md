## Description

Two instructional-correctness fixes in `plugins/plan/skills/prompt/SKILL.md` (audited at commit d994abfd), landing as one commit:

F1 (SKILL.md:56, off-ladder `target N` paragraph): the worked example is self-contradictory. `target 175` is exactly equidistant from `note` (~100) and `memo` (~250) — 75 each — yet the text says "nearer `memo`", contradicting the "ties round up" rule stated in the same sentence. It also says "The slot gate is the nearest rung's **container**," conflating a slot count (the gate) with a word band (the container). Reword so the tie is stated as a tie resolved by rounding up (gate = `memo`'s 6), and so "gate" and "container" stay distinct — an agent that internalizes "gate = container" would misapply the gate math on other off-ladder targets.

F3 (SKILL.md:89-94, Footer section): the section says "Ship these VERBATIM template blocks, adapted per turn type" and "agents pattern-match templates, not prose," and gives templates for the change-set turn and the question turn — but not the explore turn, which is the third enumerated move type (SKILL.md:66, 83-85). An explore turn's footer is left to improvisation and may drop the per-turn slot meter that is this epic's central contract. Add an explore-turn footer template (meter + next-move menu), or state explicitly that explore reuses the question-turn footer.

Both edits touch the same file and share the "instructional correctness in the prompt-polish skill body" theme, so they land together.

## Acceptance

- [ ] The off-ladder `target N` example describes 175 as equidistant between `note` and `memo`, resolved to gate 6 by rounding ties up, with no "nearer" claim.
- [ ] The `target N` text keeps the slot gate (a slot count) distinct from the container (a word band).
- [ ] The Footer section defines a footer shape for the explore turn (its own template or an explicit reuse of the question-turn footer) that carries the slot meter.

## Done summary
Fixed the off-ladder target N example (175 is an equidistant tie resolved to gate 6 by rounding up; gate kept distinct from container) and added an explore-turn footer template so all three move types carry the per-turn slot meter.
## Evidence
