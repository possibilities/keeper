## Description

**Size:** S
**Files:** src/agent/main.ts, docs/install.md, docs/adr/0090-keeper-managed-pi-codex-account-pool.md, test/agent-account-routing.test.ts

### Approach

The enroll verb prints a blast-radius warning before starting OAuth: enrolling an alias
revokes that account's other live grants (legacy leg + bare-pi), producing a native codex
outage until activation. docs/install.md orders the transition explicitly (enroll both
aliases ⇒ expected outage ⇒ arm proof window ⇒ prove ⇒ activate, promptly). Amend ADR 0090
with the observed one-grant-per-account provider behavior and the accepted end state:
bare-pi codex stays unauthenticated by design; keeper-launched Pi is the codex path.
Present-tense docs only; the outage history lives in the commit message.

### Investigation targets

*Verify before relying.*

**Required** (read before coding):
- src/agent/main.ts — the enroll verb's interactive preamble (near the "/login" instruction print)
- docs/adr/0090-keeper-managed-pi-codex-account-pool.md — amendment style: extend, don't rewrite history

## Acceptance

- [ ] enroll prints the revocation warning before launching the interactive Pi
- [ ] docs/install.md carries the ordered transition; ADR 0090 records the provider behavior and end-state decision
- [ ] agent-account-routing suite green

## Done summary
Enroll now warns of grant revocation before OAuth; docs/install.md and ADR 0090 amended with the transition ordering and one-grant-per-account end state.
## Evidence
