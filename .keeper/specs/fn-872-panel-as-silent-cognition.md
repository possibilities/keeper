## Overview

The panel (a multi-model fan-out judged into one answer) currently presents itself as a visible feature: it announces setup, relays a five-section audit, names itself, and reports composition. This epic makes the panel behave as the agent's own cognition — entered silently, its judged answer absorbed as the agent's own thinking and rendered in whatever shape the conversation needs (answer / report / sketch / ready-to-plan / open question), with the mechanism revealed only when the human asks. It also drops the panelist-availability precheck: the panel is always opus4.8-gpt5.5, so the codex check, the downgrade path, and the dropped-panelist / composition machinery all go. The judge keeps full rigor (its five-section audit) internally — display is suppressed, provenance is not erased.

## Quick commands

- `grep -c "command -v codex" /Users/mike/code/arthack/claude/arthack/skills/panel/SKILL.md` -> 0 (precheck gone)
- `grep -c "mkdir -p /tmp/panel" /Users/mike/code/arthack/claude/arthack/skills/panel/SKILL.md` -> >=1 (relocated, not deleted)
- `grep -rci "dropped" /Users/mike/code/arthack/claude/arthack/skills/panel/ /Users/mike/code/arthack/claude/arthack/agents/panel-judge.md` -> 0 (composition machinery gone)
- `grep -n "Absorb" /Users/mike/code/arthack/claude/arthack/skills/panel/SKILL.md` -> Step 4 retitled

## Acceptance

- [ ] The panel enters silently and absorbs the judged answer as the agent's own thinking, surfacing nothing about the mechanism by default — in both the standalone `/arthack:panel` path and the `/hack` callsite.
- [ ] Reveal-on-demand works as a trigger gated on the human asking about process / provenance; the judge's audit is retained internally for that reveal, never erased.
- [ ] The availability precheck, downgrade path, and dropped-panelist / composition machinery are removed across all four files; the judge keeps its five-section audit and calibration rules.
- [ ] All prose is forward-facing (no change-narration tombstones).

## Early proof point

Task that proves the approach: `.1` (arthack panel mechanism — the Step 4 rewrite is the crux). If it fails (the absorb-vs-reveal contract can't be expressed cleanly without leaking scaffolding), fall back to a minimal "answer first, audit available on request" relay and reconfirm the reveal-trigger wording with the human.

## References

- Building effective agents (Anthropic) — orchestrator-workers: the synthesis is the output, not a narration of the synthesis process. https://www.anthropic.com/research/building-effective-agents
- MT-Bench / Chatbot Arena (Zheng et al., NeurIPS 2023, arXiv:2306.05685) — judge position / verbosity / self-enhancement bias, and cross-family agreement stronger than same-family; informs keeping the judge's calibration rules.
- Forward-facing docs rule: `promptctl render future-facing-docs`.

## Best practices

- **Frame judge output as data received, presented as the agent's own conclusion** — not "relay" / "summarize", which spawn meta-commentary that leaks the scaffolding.
- **Reveal-on-demand as a trigger condition, not a bare prohibition** — pair every "don't say X" with "instead say Y" to avoid scaffolding-signaling silences ("having considered multiple perspectives...").
- **Suppress display, never erase provenance** — the judge still returns the audit; the reveal path reads it / the pairctl output files.
- **Put the silence rule first** in the rewritten step — opening constraints are followed more reliably than buried ones.
