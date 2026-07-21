## Overview

Two latent correctness gaps survived the close audit of the shared-base
repair sweep, both in the daemon's repair path. The grant leaf is the
epic's central exclusion lock but nothing reaps expired/dead leaves and
the exclusion probe truncates at a 256-dirent scan cap, so an
accumulated grants directory can silently drop the active holder and
re-grant. Separately, the maintenance-task mint idempotence probe reads
the epics projection with no reentrancy guard, so a delayed fold or an
overlapping tick can double-mint. Both are daemon-internal correctness
fixes, not consumer-facing contract changes.

## Acceptance

- [ ] The write-grant exclusion invariant holds even when the shared grants directory exceeds 256 entries.
- [ ] Expired / dead-owner grant leaves no longer accumulate unboundedly.
- [ ] Exactly one maintenance epic is minted per trunk-red incident under a delayed projection fold or an overlapping sweep tick.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | grant-leaf.ts:803 listGrantLeaves counts every dirent toward the 256 cap and nothing reaps leaves (expireRepairGrant only rewrites expires_at), so a >256-entry grants dir drops the active holder and publishRepairGrant re-grants -> two repairers on one shared checkout. |
| F6 | merged-into-F1 | .1 | F6's missing at/over-256-cap listGrantLeaves test is the test complement of F1's exclusion-lock degradation; it lands as F1's cap-boundary regression test. |
| F2 | kept | .2 | runRepairEscalationSweepTick (daemon.ts setInterval) has no reentrancy guard and hasOpenMaintenanceTask probes the epics projection, so a not-yet-folded mint or an overlapping >60s tick re-probes false and mints a duplicate maintenance epic. |
| F3 | culled | — | Speculative wedged-but-live-owner edge; the platform stuck-sentinel/escalation machinery is an existing backstop and the only remedy is speculative hold-count machinery or a doc note. |
| F4 | culled | — | allowed-tools breadth is a tight-scoping style preference; branch-guard/wrong-tree-guard still deny every mutation so the blast radius is nil. |
| F5 | culled | — | Security Notes verified the YAML scalars are safe by construction (JSON.stringify'd) and the digest input is developer-authored test output, not an external-attacker surface; a regression-only test on already-correct code does not clear the keep bar. |

## Out of scope

- A repair-specific escape for a wedged-but-live grant owner (F3) — deferred to the platform stuck-sentinel machinery.
- Narrowing the work skill's `Bash(git:*)` allow-list (F4) — style preference, hooks already deny mutations.
- An adversarial YAML round-trip test for buildMaintenanceScaffoldYaml (F5) — scalars are already safe by construction.
