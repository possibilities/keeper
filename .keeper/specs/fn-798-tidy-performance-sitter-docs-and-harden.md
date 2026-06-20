## Overview

The performance-sitter page-free convergence shipped clean, but its docs
and its writer test surface have two follow-up debts. First, the docs
overstate a `latest.md` guarantee the code does not provide and carry
dated change-history stamps that violate the repo's forward-facing-advice
rule. Second, the injection-hygiene path that is the load-bearing security
concern of the whole change is only covered transitively, with no direct
assertion. This follow-up closes both as two small, independent commits.

## Acceptance

- [ ] performance-sitter docs describe `latest.md` and provenance honestly,
      with no internal contradiction and no dated change-history stamps.
- [ ] The followups writer's triple-backtick neutralization and
      `sanitizeKey` edge cases have direct unit coverage.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | followups.ts:153 fence() Unicode escape is non-roundtrippable but acceptable for an untrusted data-echo block; no user impact. |
| F2 | kept | .1 | agents/performance.md:207-209 claims latest.md mirrors the LEAD/highest-severity finding, but watch.ts:2402 loops per selectNew (no severity sort) so it mirrors the LAST-written finding, contradicting lines 53/69. |
| F3 | merged-into-F2 | .1 | F3 (dated provenance stamps in README.md + agents/performance.md violating the forward-facing-advice rule) shares the agents/performance.md doc surface and doc-accuracy theme with F2, one commit. |
| F4 | culled | — | keeper-watch.test.ts:2345 only asserts latest.md exists; low-value characterization test of a convenience file the docs call no-longer-an-alert-target. |
| F5 | kept | .2 | keeper-watch.test.ts:2311 covers a hostile key only indirectly; no direct assertion that a triple-backtick in detail/evidence is neutralized — the load-bearing injection path is untested. |
| F6 | merged-into-F5 | .2 | F6 (no direct sanitizeKey edge-case unit test for empty/>150-cap/NUL) shares the untrusted-input-hardening theme and test file with F5, one commit. |

## Out of scope

- The non-roundtrippable Unicode fence escape (F1) — accepted as-is for an untrusted data-echo block.
- Multi-finding latest.md content characterization tests (F4) — low-value coverage of a deprecated-as-alert convenience file.
