## Overview

The batched maturity-driven /plan:prompt rewrite shipped two instructional-correctness gaps in the SKILL.md body — text a reading agent follows literally. The off-ladder tie example self-contradicts and conflates the slot gate with the word container, and the footer section ships verbatim templates for only two of its three enumerated move types. Both are small text fixes in the same file; correctness of the instructions is the whole product of a prompt-polishing skill.

## Acceptance

- [ ] The off-ladder `target N` example states a coherent tie rule and keeps slot-gate (a slot count) distinct from container (a word band).
- [ ] Every enumerated move type (change-set, question, explore) has a defined footer shape carrying the per-turn slot meter.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | SKILL.md:56 off-ladder example self-contradicts ("nearer memo" for an equidistant target vs "ties round up") and conflates the slot gate with the word container. |
| F2 | culled | — | SKILL.md:130 behavior is preserved and inferable (spec container is open-ended, so clause 2 is vacuously true); a dropped clarifying line is a theoretical stall, not a defect. |
| F3 | kept | .1 | SKILL.md:89-94 templates only change-set and question turns of three enumerated move types; the explore-turn footer is left to improvisation and risks dropping the per-turn meter. |

## Out of scope

- F2's dropped spec-rung clarifying note — behavior is preserved and inferable; left as-is.
- Any change to the slot-ladder math, meter glyphs, or AskUserQuestion boundary — all pinned and correct.
