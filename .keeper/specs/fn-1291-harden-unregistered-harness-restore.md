## Overview

The Hermes/Codex retirement made `harnessOrClaude` throw on any unregistered
non-empty harness, and the batch restore-derivation surfaces call it in a loop
over the whole session set. As a result a single live legacy Codex/Hermes
session present during an upgrade window freezes the disaster-recovery mirror
(`restore.json` / `revive.sh`) for every healthy Claude/Pi session too, and the
`harnessOrClaude` docstring now states the removed default-to-claude contract.
This follow-up narrows the blast radius to the offending row and corrects the
contract doc.

## Acceptance

- [ ] A lone live unregistered-harness session no longer blanks the restore
      mirror for healthy Claude/Pi sessions; the retired row is skipped and
      surfaced rather than throwing the whole derivation.
- [ ] `keeper tabs restore` / `dump` degrade the same way (skip-and-surface,
      not a whole-batch loud failure).
- [ ] The `harnessOrClaude` docstring matches the throw-on-unknown contract.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | restore-worker.ts:423 / restore-set.ts:605 / tabs-core.ts:179 batch-throw via harnessOrClaude; one live legacy row freezes restore.json/revive.sh for every healthy session until it closes |
| F2 | kept | .1 | harness.ts:229 docstring claims unknown defaults to claude but :239 throws; false contract on the exported normalizer this epic changed |
| F3 | culled | — | auditor's own out-of-scope unverified advisory (fresh-vs-migrated column-set assertion); no confirmed defect on a migration already verified textbook and idempotent |

## Out of scope

- Any change to the `harnessOrClaude` throw itself as a normalizer, or to the
  per-session graceful-catch paths (bus-wake / exec-backend) the auditor
  confirmed already handle unregistered rows correctly.
- The migration-parity test-assertion advisory (F3), culled — no confirmed defect.
