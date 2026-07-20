## Description

**Size:** M
**Files:** integrations/pi-codex-pool/src/proof.ts, integrations/pi-codex-pool/src/index.ts, src/codex-pool-activation.ts, src/agent/main.ts, docs/install.md, docs/adr/, integrations/pi-codex-pool/test/, test/

### Approach

The 13-clause proof gate assumes both enrolled aliases can serve; a quota-depleted alias makes `transport_isolation` and `native_fallback` structurally unsatisfiable — yet the pool's entire value in exactly that state is routing to the healthy alias (live specimen: report at ~/.config/keeper/codex-pool/live-proof.json, 11/13 clauses evidenced, the two unmet clauses are precisely the failover legs the quota-dead account refused; the human authorized this carve-out that night). Add a human-authorized DEGRADED activation mode: when a proof run's only unmet clauses are those whose evidence requires the quota-dead alias to serve (interruption cause classified as a quota fault), the report may classify `proven-degraded-single-alias`, recording exactly which clauses were waived and the classified cause. The activation validator accepts that verdict ONLY with an explicit operator authorization flag naming the degraded verdict; it activates routing pinned to the healthy alias and surfaces the state loudly (`active-degraded` in status and accounts check — never presented as balanced operation). A subsequent FULL proven report at quota recovery upgrades activation to full active and clears the degraded marker. Nothing about the degraded path is implicit: no flag, no degraded activation; any unmet clause not caused by the quota-dead alias refuses the degraded verdict outright.

**CRITICAL LANE NOTE — read before any source edit:** the fn-1356 epic lane predates fn-1378, so the proof machinery this task edits DOES NOT EXIST on the stale lane tree. First verify your worktree HEAD has been freshened with local default (`git merge-base --is-ancestor c1f897457 HEAD` must succeed); if it fails, the base-freshness producer has not yet merged default into the epic base — park DEPENDENCY_BLOCKED naming the missing freshness merge. Never edit the stale tree and never verify producer-existence claims against it.

### Investigation targets

*Verify before relying — the repo moves.*

**Required** (read before coding):
- integrations/pi-codex-pool/src/proof.ts — the verdict classifier the degraded verdict extends
- integrations/pi-codex-pool/src/index.ts — orchestrator fault classification, interruption handling, writeProofReport
- src/codex-pool-activation.ts and the activate command in src/agent/main.ts — the validator that must gate the degraded verdict behind the explicit flag
- docs/install.md proof/activation ritual section — where the degraded ritual is documented
- docs/adr/0090-keeper-managed-pi-codex-account-pool.md — the lineage the amendment extends

### Risks

- This deliberately weakens a safety gate: the waiver must be impossible to trip implicitly — explicit flag, recorded verdict, loud status, or nothing
- Degraded routing must never claim balanced operation or hide which alias serves
- The upgrade path must require a genuinely full proven report — no partial upgrade

### Test notes

Pure classifier tests: quota-fault-only unmet clauses → degraded-eligible; any other unmet clause → refuse. Validator tests: degraded report without the flag refuses; with the flag activates pinned + degraded-marked. Status/check render the degraded state. A full proven report clears it. Named gates only.

## Acceptance

- [ ] A proof run whose only unmet clauses stem from the quota-dead alias can classify `proven-degraded-single-alias` recording waived clauses and cause; any non-quota unmet clause refuses the degraded verdict
- [ ] Activation accepts a degraded report ONLY with an explicit operator authorization flag, pins routing to the healthy alias, and surfaces `active-degraded` loudly in status and accounts check
- [ ] A subsequent full proven report upgrades to full active and clears the degraded marker
- [ ] docs/install.md documents the degraded ritual, an ADR amendment records the human decision and the safety trade, and all touched suites are green via named gates

## Done summary
Added a human-authorized degraded single-alias activation mode: a proven-degraded-single-alias proof verdict that waives only the quota-dead alias's structurally-unsatisfiable legs (native_fallback, transport_isolation) behind genuine quota evidence, activation gated behind an explicit --authorize-degraded flag pinned to the healthy alias and surfaced as active-degraded, with a full proven report upgrading to active and clearing the marker. ADR 0090 amended and install.md documents the ritual.
## Evidence
