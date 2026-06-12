# Quality Audit Report — fn-42-add-auth

## Summary

Two findings: one dead import (tier-1 candidate), one missing test coverage (tier-2 candidate).

## Critical

None.

## Should Fix

**dead-import** — `apps/planctl/planctl/cli.py:3` — `import os.path` is imported but never used. Remove it.

## Consider

**broaden-key-filter** — `apps/planctl/planctl/models.py:88` — normalize_epic silently drops unknown input keys; raise on unexpected keys (or log them) so typos in epic JSON surface instead of vanishing.

## Test Gaps

No test for unknown keys in normalize_epic.

## Test Budget

Adequate for existing paths; edge case above is the only gap.

## Design Conformance

Implementation matches the spec.

## Security Notes

No security concerns identified.
