## Overview

Panel wielders (/plan:hack's routing gate, /plan:panel on direct invocation, future callers) learn the shape of the configured panel roster and how to choose panel strength — via one canonical rubric snippet authored in the arthack corpus, vendored into keeper, and baked byte-exact into both wielding skills. Underneath, the reserved name `default` becomes a working alias for the configured default panel at every resolution entry point, so the prose describes a path that actually resolves.

## Quick commands

- `keeper agent presets resolve default` — proves the alias: emits the configured default panel's member envelope instead of exit 2
- `keeper agent presets list --json | jq '.default, (.panels | map({name, n: (.members|length)}))'` — the live roster + strength signal a wielder reads
- `cd ~/code/keeper && bun scripts/vendor-corpus.ts --check` — vendor lock + both BAKE sets verify byte-exact
- `cd ~/code/keeper && bun run test:full` — full gate including the prompt suite's reachability and bakeCount assertions

## Acceptance

- [ ] `--panel default` and `presets resolve default` resolve the configured default panel; null-default stays fail-loud with a message naming what was typed
- [ ] The strength rubric exists exactly once (arthack `engineering/panel-strength`), is baked into hack and panel SKILL.md, and both bakes are drift-gate-verified
- [ ] No committed plugin prose names concrete panel names, counts, or model rosters — wording stays correct for any panel.yaml
- [ ] Stale panel docs are swept: references/panel.md example shows the real config shape; plan README /plan:panel row is config-agnostic

## Early proof point

Task that proves the approach: `.2` (the resolution alias). If it fails: fall back to the prose-only fix — wielders omit `--panel` for the default path — and reword the runner guidance instead of aliasing in code.

## References

- Session decisions: wielders own panel strength (routing metadata on the `Panel:` line); bake the grammar, discover the values via `keeper agent presets list --json`; no render-time roster interpolation (install-time renders go stale); `default` aliased in code because the name is reserved and collision-free (src/agent/config.ts:327-346, validatePresetName on panel keys)
- Overlap coordination: fn-1149.8 and fn-1151.6 also edit plugins/plan/README.md (distinct sections) — dep edges wired so the sweeps serialize
- Precedents: kubectl `config current-context` (structured default, not scraped decoration); git `HEAD` (symbolic pointer, rename-safe); clig.dev (discoverable defaults); regenerate-and-diff CI gates for single-sourced baked content
- CONTEXT.md "Panels and presets" glossary section (landed this session) — the terms task specs lean on

## Docs gaps

- **cli/agent.ts (~9-34)**: `keeper agent panel` help block — candidate small wording touch once `default` is an accepted alias; implementer may skip if the story reads correctly as-is

## Best practices

- **Procedure, not snapshot:** prompt surfaces instruct running `keeper agent presets list --json` at decision time; never enumerate roster values in committed prose [Anthropic context-engineering]
- **Contract, not contents:** quantifier-based wording — one or more named panels, exactly one optional default, panels may be defined/renamed/removed at any time
- **Symbolic pointer:** `default` resolves the configured default slot (git-HEAD semantics), never a frozen copy of a name
- **Byte-exact single-sourcing:** one canonical snippet, baked copies verified by the vendor drift gate; never hand-maintained duplicates
