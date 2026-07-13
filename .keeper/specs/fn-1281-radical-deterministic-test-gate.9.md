## Description

**Size:** S
**Files:** CLAUDE.md, plugins/plan/CLAUDE.md, README.md, docs/testing.md, docs/install.md

### Approach

Make `docs/testing.md` the contributor-facing source for canonical aggregate and targeted commands, package/phase membership, preserved integrity proofs, deleted slow tiers, manual diagnostics, and budget enforcement. Keep CLAUDE.md terse and imperative, prune stale Python/slow/OpenTUI wording from plan and test comments, link once from README, and update install/operator checks so no removed E2E command remains recommended.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- CLAUDE.md:94-105 — current test isolation rules and command drift
- plugins/plan/CLAUDE.md:67-69 — stale Python/full/real-git suite topology
- README.md — lean-front-door convention
- docs/install.md — direct integration/slow validation recipes
- docs/adr/0057-named-fast-gate-and-deterministic-proof-policy.md — accepted policy and budgets

**Optional** (reference as needed):
- test/live-shell.test.ts:9-40 — OpenTUI technical rationale to consolidate rather than duplicate

### Risks

Forward-facing docs must not narrate removed test history. CLAUDE.md has a strict size/re-narration lint; move rationale to the ADR/testing guide and keep only rules agents otherwise get wrong.

### Test notes

Run doc/CLAUDE linters and static searches for removed commands, slow env names, stale Python references, and bare aggregate recommendations.

### Detailed phases

1. Write the centralized testing guide from live manifests/scripts.
2. Replace CLAUDE test prose with concise canonical rules.
3. Prune plan/install stale commands and comments.
4. Add the README pointer.
5. Verify every documented command exists and matches the runner contract.

### Alternatives

Expanding CLAUDE.md with the full command matrix was rejected; it is an imperative guardrail, not a contributor manual.

### Non-functional targets

One authoritative command matrix, no duplicated rationale, no historical narration outside ADR 0057.

### Rollout

Land after task 8 fixes the final live command surface so docs describe shipped behavior only.

## Acceptance

- [ ] `docs/testing.md` accurately documents aggregate, targeted, package, OpenTUI, diagnostic, and budget commands.
- [ ] CLAUDE.md contains only concise rules an agent would otherwise violate and remains lint-clean.
- [ ] README and install guidance link or invoke only live canonical commands.
- [ ] Plan documentation contains no stale Python suite or real-git promotion gate claims.
- [ ] Repository guidance contains no recommendation to use bare aggregate `bun test`.

## Done summary

## Evidence
