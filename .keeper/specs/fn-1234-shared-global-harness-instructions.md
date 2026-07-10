## Overview

Make one keeper-owned source, `system/shared/AGENTS.md`, the single global
instruction document every `keeper agent` harness reads. Generalize the
launch-time canonical-symlink guard from claude-only into a per-harness leaf
table that heals each harness's real discovery path — `~/.claude/CLAUDE.md`,
`$CODEX_HOME/AGENTS.md`, `~/.pi/agent/AGENTS.md` (+ each `~/.pi-profiles/<name>/AGENTS.md`)
— into that one source on every launch. Fills the pi gap (pi reads nothing
global today), unifies codex ownership (arthack-owned today), and deletes
arthack's competing codex source so it can't drift back (self-heals on the
next launch). `AGENTS.md` is the universal filename all three read globally,
so one source serves all via symlinks.

## Quick commands

- `bun test test/agent-state-sharing.test.ts test/agent-pi.test.ts` — guard + pi-leaf coverage
- `bun scripts/lint-claude-md.ts` — CLAUDE.md guardrail stays green
- Post-deploy smoke (operator, not task acceptance): after a rebuild, `keeper agent codex -- --help >/dev/null; readlink ~/.codex/AGENTS.md` resolves into keeper's `system/shared/AGENTS.md`; same for `readlink ~/.pi/agent/AGENTS.md`.

## Acceptance

- [ ] All three harnesses' global-instruction discovery paths resolve to the one keeper-owned `system/shared/AGENTS.md` (proven via the guard's sandboxed tests).
- [ ] pi's canonical `~/.pi/agent/AGENTS.md` and each named-profile AGENTS.md are materialized (ordering trap fixed), and `SYSTEM.md` is gone from the pi shared-path list.
- [ ] A divergent regular file at a codex/pi leaf is left untouched with a WARNING and never aborts a launch; the claude leaf keeps its hard-error.
- [ ] arthack's codex AGENTS.md source is deleted; codex re-links to keeper on the next post-deploy launch (self-healing).

## Early proof point

Task that proves the approach: `.1` (the core guard mechanism + tests). If it fails, the leaf-table generalization or the pi ordering fix is the risk — fall back to a codex-only leaf first, then add pi.

## References

- `~/docs/keeper-agent-global-instructions.md` — full investigation + placement rationale (per-harness discovery table, failure modes, known boundary).
- Builds on landed `fn-1033` (keeper owns its install + claude source) — precedent, not a dependency.
- A separate (currently unscaffolded) epic deletes `~/.claude/AGENTS.md` + arthack's claude-package source; if it opens, coordinate the two arthack `system/` tasks (sibling paths, not the same file). This epic touches ONLY arthack's codex source.
