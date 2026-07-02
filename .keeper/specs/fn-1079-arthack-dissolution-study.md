## Overview

Research and design, not implementation: keeper should ideally stand alone and the arthack
coupling dissolve, but that is a large lift touching launch config, the snippet authoring home,
an active hook layer (command rewrites, blanket permission auto-approve, advice injection), and
dozens of arthack CLIs that keeper skills reference. This study inventories every consumption
edge, designs the standalone end state, and decides own/gate/drop per behavior — including the
deferred worker plugin-isolation gate question (observe-now was chosen; this study decides
gate-later with the composition data the telemetry epic produces, hence the dep).

## Quick commands

- the deliverable doc exists under ~/docs/ with its yaml sidecar

## Acceptance

- [ ] Every keeper→arthack consumption edge inventoried with file:line (launch config, corpus, hooks, CLI references in skills, install/stow assumptions)
- [ ] Per-behavior verdict matrix: own (move into keeper), gate (keep behind config), drop — each with a one-line rationale
- [ ] The worker plugin-isolation gate question answered with observed data (what workers actually used from the arthack layer)
- [ ] A standalone-keeper end-state design plus a proposed follow-up epic decomposition, ready to hand to /plan:plan

## Early proof point

Task that proves the approach: `.1` — the inventory phase either converges on a bounded edge
set quickly or reveals the coupling is wider than believed, which is itself the finding.

## References

- ~/.config/keeper/plugins.yaml (symlink into arthack) + src/agent/config.ts:8-60
- ~/code/arthack/claude/arthack/ — the active plugin (hooks + skills); claude/internal + claude/lsp are manifest-only shells
- agent/main.ts:2194-2222 — the no-worker-gate discovery reality
- Arthack CLIs referenced by keeper-side skills and docs: searchctl, scrapectl, knowctl, claudectl, tmuxctl, summaryctl, devctl, dashctl — inventory the full set from the skill bodies
- The composition map + hook-attribution data landed by the telemetry epic
