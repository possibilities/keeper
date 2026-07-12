## Overview

The /plan:work and /plan:close orchestrators coordinate the audit pipeline through typed envelopes, refs, hashes, and enums only. The depth band moves from an orchestrator-carried spawn value to a quality-auditor self-read; the per-task audit gate's finding artifact becomes sink-owned through two task-scoped verbs wrapping the existing audit_artifacts helpers; a fourth plugin hook mechanically holds the line once no legitimate orchestrator read remains.

## Quick commands

- cd plugins/plan && bun test
- keeper plan audit gate-check <task_id>   # one JSON root, typed fields only
- grep -c DEPTH_BAND plugins/plan/skills/close/SKILL.md   # 0 after the fold

## Acceptance

- [ ] Neither orchestrator skill opens the brief or the finding artifact; coordination is envelope/ref-only end to end.
- [ ] The close audit's depth band is auditor-self-read with a lean floor and the vet-time echo intact.
- [ ] The per-task audit gate round-trips through gate-check/submit-task with hash-parity idempotency.
- [ ] The read guard denies orchestrator access to the briefs/audits state trees, fail-open, with no collateral on other sessions.

## Early proof point

Task that proves the approach: ordinal 1 (the two verbs + round-trip parity). If it fails: the helpers' hash contract doesn't fit a server-side derivation — re-derive the gate-check envelope from reconcile's existing scan instead.

## References

- docs/adr/0014-audit-gate-rides-block-machinery.md — the block-machinery gate this refines.
- docs/adr/0027-trusted-verb-applies-selection-verdicts.md — the untrusted-return-to-trusted-verb precedent the submit path mirrors.
- plugins/plan/plugin/hooks/commit-guard.ts — the deny-dispatcher pattern the new guard copies.

## Docs gaps

- **plugins/plan/CLAUDE.md**: fourth guard + verb-routed audit-gate wording — consolidate in place, size lint stays green.
- **plugins/plan/README.md**: dispatcher count, command-map rows for the two verbs, content-blind scoping.
- **CONTEXT.md**: task-scoped auditor mode term; scoped content-blind definition.
- **docs/problem-codes.md**: conditional rows for any new typed codes.

## Best practices

- **Typed envelopes stay non-prose:** enum status, counts, hashes, paths — a prose field lifted from findings reopens the injection channel the change closes [blind-orchestrator/UCM literature].
- **Idempotency lives in the sink:** the submit verb derives + fingerprints the commit set server-side; the gate-check read is an optimization, not the correctness boundary [Stripe idempotency].
- **Hook denies are explicit envelope decisions:** exit 0 approves nothing; a Read-only matcher without Bash vector coverage is a paper wall [Claude Code hook semantics].
- **Name the guard's threat model:** advisory context hygiene, fail-open — never mistakable for a security boundary [fail-open vs fail-closed consensus].
