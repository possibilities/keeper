## Description

**Size:** S
**Files:** plugins/keeper/plugin/hooks/wrapped-guard.ts

### Approach

The wrapped-cell keeper allowlist is `{agent,session,commit-work,baseline}`
(plugins/keeper/plugin/hooks/wrapped-guard.ts:329-334) — `bus` is absent, so a
wrapped worker whose commit-work refusal names a foreign claimant cannot send the
`keeper bus chat send` cooperative-release notice its own envelope (and the wrapped
worker template, worker-implement-wrapped.md:78) prescribes; its only move is
burning the attempt on DEPENDENCY_BLOCKED. Admit the BOUNDED send-only form:
`keeper bus chat send <target> <message>` (which is `send_only:true` by contract and
never joins the live registry) — never `bus watch` or any subscribing verb. Keep the
guard's fail-closed posture for everything else.

### Investigation targets

*Verify before relying — the repo moves.*

**Required** (read before coding):
- plugins/keeper/plugin/hooks/wrapped-guard.ts:329-334 — the allowlist
- plugins/plan/... worker-implement-wrapped.md:78 — the template line telling the worker to send the notice
- CLAUDE.md hook rules — wrapped-guard FAILS CLOSED when marked; a bus send MUST NOT establish bus presence

### Risks

- Allow ONLY the send verb shape — a watch/subscribe from a wrapped cell would violate the single-watcher bus contract
- Hook rules: no new imports beyond node:* + the sanctioned dep-free src modules; envelope-deny, exit 0

### Test notes

Guard tests: `bus chat send` allowed under KEEPER_WRAPPED_CELL; `bus watch` and other bus verbs still denied;
non-bus deny behavior unchanged. Named gates (the wrapped-guard suite).

## Acceptance

- [ ] A marked wrapped cell can run `keeper bus chat send` (send-only) and every other bus verb remains denied
- [ ] Wrapped-guard suite green via its named gate; fail-closed posture unchanged

## Done summary

## Evidence
