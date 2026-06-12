## Description

**Size:** M
**Files:** tests/test_creation_verbs.py (new), tests/fixtures/golden/ additions

### Approach

Author the wave's missing conformance coverage, proven against Python first. (1) The YAML scalar matrix: scaffold/refine-apply plan inputs exercising norway booleans (tier: no, branch: yes), 0NNN octal and underscore numerics in dep ordinals, ISO-timestamp-shaped scalars, and duplicate keys — pin the exact envelope each yields from the real Python binary (which error bucket fires, or which value lands on disk for the silent-last-wins case). (2) Gap cases the existing suite under-covers in the fast bucket: duplicate_epic envelope details shape + --allow-duplicate, epic rm --dry-run (preview envelope, zero commits, files intact) and --force (live-task override), refine-apply stdin-cap behavior (pin whatever the Python source does), TTY-stdin rejection where harness-testable, the 1 MiB cap message with its truncated-read byte count. (3) A seed_epic round-trip case asserting the scaffold success envelope keys {epic_id, task_ids, repo_distribution} and sorted repo_distribution ordering — the keystone contract. seed_state for any fixture that does not itself exercise scaffold; scaffold-driven seeding is the subject here and is fine.

### Investigation targets

**Required** (read before coding):
- planctl/run_scaffold.py:408-560 — cap, parse-error, and bucket mechanics being pinned
- planctl/run_refine_apply.py:108-260 — delta parse + stdin handling
- tests/test_scaffold.py:531-560, :1225, :1688-1760 — existing pins to complement, not duplicate
- tests/conftest.py seed_epic — the keystone fixture contract

**Optional** (reference as needed):
- tests/test_restamp_verbs.py — established engine-agnostic idioms

### Risks

The matrix fixtures must capture Python behavior empirically (run the binary), not from reading pyyaml docs — implicit-typing behavior is version-sensitive.

### Test notes

Green three ways: default engine, PLANCTL_BIN=python planctl, fast gate unchanged.

## Acceptance

- [ ] Scalar matrix pinned empirically for all five divergence classes; gap cases landed
- [ ] Green in default engine and against Python via PLANCTL_BIN; no existing test touched

## Done summary

## Evidence
