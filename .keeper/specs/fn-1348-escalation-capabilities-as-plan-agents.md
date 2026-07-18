## Overview

Promote the four escalation capabilities out of daemon-inline prose briefs and full-session skills into rendered, confined plan agents — plan:merge-resolver, plan:deconflicter, plan:unblocker, plan:repairer — so /work and /close can spawn them as Task subagents. The existing /plan:{deconflict,unblock,repair} skills become thin wrappers over the same agents, staying bootable by the legacy escalation sessions until retirement.

## Quick commands

- `keeper prompt render-plugin-templates --project-root plugins/plan --check` — rendered tree drift-free
- `bun test plugins/prompt/test/oracle/render-plugin-templates.test.ts` — golden capture green (re-captured)

## Acceptance

- [ ] Four escalation agents render as managed plan agents with role-appropriate tool denylists, none able to nest Task, each consuming a data-delimited incident brief and returning a typed receipt
- [ ] The deconflict/unblock/repair skills delegate to the corresponding agents and still work when booted by a legacy escalation session
- [ ] Render check and golden fixtures are green after re-capture

## Early proof point

Task that proves the approach: task 1. If the render pipeline cannot express a needed frontmatter shape for these agents, fall back to authoring them as plain managed agent files outside the template loop and record why.

## References

- docs/adr/0089-in-session-escalation-subagents.md — receipt vocabulary and confinement contract
- plugins/plan/prompt-artifacts.yaml — roles + bundles registry these agents join
- docs/examples/matrix.example.yaml — agent_pins shape (real matrix is host-generated and gitignored)
- The daemon's inline resolver briefs and plugins/plan/skills/{deconflict,unblock,repair}/SKILL.md — the capability contracts being ported

## Docs gaps

- **plugins/plan/skills/{deconflict,unblock,repair}/SKILL.md frontmatter**: descriptions keep the legacy-session boot path wording until the retirement epic deletes that path

## Best practices

- **Untrusted-data discipline:** incident content enters each agent prompt in a data-delimited section; receipts flowing back never expand writable roots or lift grants
- **Typed receipts are terminal:** resolved | declined_clean | declined_residue | stale_base — a declined or stale receipt is a state transition, never a silent retry
