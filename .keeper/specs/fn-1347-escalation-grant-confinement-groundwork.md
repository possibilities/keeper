## Overview

Build the confinement layer every later escalation-subagent epic stands on: a dep-free grant-leaf module (daemon-published, owner-private capability grants with fencing tokens), a new fail-closed grant-guard hook keyed on the hook payload's subagent identity, and exact-grant overrides in wrong-tree-guard and wrapped-guard. Ships standalone with denial tests before any production routing exists; replaces the never-engaged env-keyed escalation-guard.

## Quick commands

- `bun test test/grant-guard.test.ts` — denial truth-table green
- `bun test test/wrong-tree-guard.test.ts test/wrapped-guard.test.ts` — override suites green
- `bun scripts/lint-source.ts && bun scripts/lint-claude-md.ts` — doc/source gates green

## Acceptance

- [ ] Escalation-agent subagent tool calls are denied by default and allowed only under an exact-tuple, unexpired grant; protected paths stay denied even under grant
- [ ] Non-escalation subagents and top-level sessions are untouched by the new guard
- [ ] wrong-tree-guard and wrapped-guard honor exact grants without weakening their existing postures
- [ ] The env-keyed escalation-guard is gone and hook docs describe the grant guard

## Early proof point

Task that proves the approach: task 1. If the hook payload turns out not to carry a usable subagent identity for edit tools, stop and surface the finding as a blocked design question rather than substituting an env marker.

## References

- docs/adr/0089-in-session-escalation-subagents.md — the architecture this epic grounds
- docs/adr/0055-harness-activity-dispatch-claims-and-resource-holds.md, 0070 (incident-fenced clears), 0078 (voluntary release), 0085 (orphan reaping) — the claim family the grant joins
- plugins/keeper/plugin/hooks/wrapped-guard.ts — owner-private leaf primitive (SYSTEM_TMP_ROOTS, 0o700, anti-TOCTOU fstat) to extend, not reinvent
- plugins/keeper/plugin/hooks/escalation-guard.ts — hook skeleton (pure predicate + decision ladder, three-state jurisdiction, deny envelope, always exit 0)

## Docs gaps

- **CLAUDE.md**: hook-list clause swaps escalation-guard for grant-guard; dep-free import list gains the grant-leaf module (net shrink, lint-gated)
- **README.md**: escalation-guard paragraph rewritten for grant-guard
- **docs/plugin-composition-map.md**: escalation block untouched here — rewritten by the retirement epic while legacy sessions still run

## Best practices

- **Whole-tuple validation:** a grant check that only asks "does a grant exist" is bypassable — validate parent job, exact agent_type, incident instance, writable-root prefix, expiry, and fencing token at every mutating call
- **Protected paths survive grants:** `.git/config`, credentials, hook/MCP config stay denied even with a valid grant
- **Owner-private leaf:** 0o700 directory, fresh lexical leaf per write, anti-TOCTOU fstat on read
- **Fencing at the mutation:** the token is checked where the write happens, never only at acquisition
