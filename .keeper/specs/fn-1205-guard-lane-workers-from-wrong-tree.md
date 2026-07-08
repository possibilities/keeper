## Overview

A lane worker writing into the shared checkout instead of its lane dirtied main's working tree for hours, starving the repair sweep and risking finalize wedges — the mechanically-preventable half of the incident's causal chain. This epic adds a keeper-plugin hook (sibling of branch-guard and escalation-guard) that denies a lane-marked worker's writes into any tracked repo working tree that is not its lane, while leaving plan-state, temp, home, and state-dir writes untouched. Explicitly best-effort audit per hook discipline, not a security boundary.

## Quick commands

- `bun test` in plugins/keeper (hook tests)
- Post-deploy: a scratch lane worker attempting a shared-checkout write sees the deny envelope; its .keeper plan writes still succeed

## Acceptance

- [ ] A lane-marked session's write targeting a tracked repo toplevel other than its lane is denied via the PreToolUse envelope, for direct file tools and the Bash write-vector classes the sibling guards already detect
- [ ] Plan-state (.keeper), temp/scratchpad, home-dir, and state-dir writes are never denied; an unmarked session is entirely unaffected
- [ ] The hook fails open on any internal error and never writes host stdout

## Early proof point

Task that proves the approach: `.1`. If realpath resolution proves too slow per tool call: cache the lane/repo-root resolutions per process, invalidating on env change.

## References

- docs/adr/0017 — the role-keyed guard precedent; this is the same class of mechanically-enforced write boundary (companion ADR merited)
- Incident: fn-1184's worker wrote src/agent/* into /Users/mike/code/keeper while its lane sat clean; fn-1198.1 confirmed that dirt starved the repair route
- Write-vector reality: string parsing of shell commands is best-effort audit; TOCTOU accepted at this layer [practice-scout]

## Docs gaps

- **CLAUDE.md** (Hook rules): six hooks → seven; slot the guard beside branch-guard with matching one-clause density
- **plugins/plan/CLAUDE.md** ("work in place" note): add the write-guard as branch-guard's sibling
- **docs/adr/**: companion record to 0017 for the new deny surface

## Best practices

- **Layered denylist the worker cannot override** — .git/config and credential paths stay denied regardless of lane [practice-scout]
- **Size-bound and log every deny; never crash, never block the human's own session** [hook discipline]
