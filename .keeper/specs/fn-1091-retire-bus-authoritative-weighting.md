## Overview

The Agent Bus stamps every delivered message as an authoritative directive and ships
skill prose mandating receivers act with no permission gate. This epic retires that
weighting: the rendered head becomes neutral (`Agent Bus message from <name>: `), and
the trust story moves into skill prose as provenance — a bus message is a request from
another of the same human's sessions (the human often runs two sessions and tells one
to message the other to resolve something), so agents help with it using their own
judgment instead of obeying an authority claim. Planners additionally learn to expect
help requests from their work agents: do the work the resolution needs, hand control
back, ask the worker to resume.

## Quick commands

- `bun test && bun run lint`
- `grep -rn "Agent Bus directive\|directiveHead" cli src test plugins && echo LEFTOVER || echo clean`
- `bun scripts/vendor-corpus.ts --check`

## Acceptance

- [ ] Bus notifications render the neutral `Agent Bus message from <name>: ` head in all three renderings (inline, spill pointer, spill-file header)
- [ ] No skill, help, or comment prose claims per-message bus authority or mandates gate-free immediate action
- [ ] Proxy-of-the-human framing lands in the bus and hack skills; planner help-request prep lands in the plan skill with mechanics unchanged
- [ ] Fast suite, biome lint, and the BAKE drift gate are green

## Early proof point

Task that proves the approach: ordinal 1 (the only task). If it fails: single-commit
revert — the marker change is presentation-only with no persisted state or wire change.

## References

- Practice evidence: authority-flavored wording measurably raises LLM compliance even when fabricated (GAIL/Wharton) — provenance framing is the better trust signal; sycophancy dominates, so under-response after neutralization is low-risk (SycoEval-EM, arXiv 2601.16529); cross-agent prompt infection rides authentic peer channels with semantic mutation — frame receipts as requests-to-help, never commands-to-execute (arXiv 2410.07283); confused deputy is the named failure mode of proxy trust — keep privilege monotonic, re-anchor to the receiver's own read-only sources of truth (capisc, OWASP agentic guidance)
- In-repo model for consequential asks: verify-against-ground-truth in `plugins/plan/skills/close/SKILL.md` (evidence is the authority; a present human adds nothing an injected instruction could not fake)
- `src/daemon.ts` `buildBlockEscalationBody` is frozen and never says "authoritative" or "directive" — plan-skill prose must describe the escalation message as it actually reads
- `plugins/plan/template/agents/worker.md.tmpl` "Resume directives" is parent-to-worker resume language, a different concept — out of scope, do not edit

## Docs gaps

- **plugins/plan/skills/close/SKILL.md**: neutralize the "Consequential bus directives" heading wording — substance already aligned, folded into task 1
- **plugins/plan/template/agents/worker.md.tmpl**: consistency skim only; different concept, expected no change

## Best practices

- **Provenance over authority tone:** tell the receiver why a message is legitimate (same human's sessions, OS-verified sender) rather than pressuring compliance [GAIL/Wharton]
- **Help, never obey:** receiver advice invites the receiver's own judgment; "obey" phrasing is the confused-deputy trigger [capisc, OWASP]
- **Narrow proxy reading:** pid verification proves who sent the bytes, not who authored the intent — a sibling can faithfully relay ingested content [arXiv 2410.07283]
- **Gate-free needs compensating controls:** loop/cycle-stop and human-at-keyboard-wins are the load-bearing reflexes in a design with no permission gate [OWASP, XMPro]
