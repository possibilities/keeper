## Overview

The builds sitter's onset model writes exactly one followup per red onset:
the seen-state fingerprint clears only on an observed GREEN, so a
permanently-red step never re-emits, never produces a new occurrence ts,
and after a stale/needs-work verdict sits silent forever. Add a bounded
still-red aging re-emit: when a fingerprint's red age crosses 7 days,
write ONE fresh followup through the existing writer and re-arm the aging
anchor, so triage re-engages. Green-clear onset semantics stay untouched.

## Quick commands

- bun test test/builds-watch.test.ts

## Acceptance

- [ ] a step red for more than 7 days re-emits exactly one fresh followup (new filename ts) and does not re-emit again until the next 7-day window or a green-then-red cycle
- [ ] green-clear / onset semantics and sub-threshold suppression unchanged
