## Overview

The repin-verification procedure added to the sitter README ships a
copy-pasteable sqlite cross-check whose URI is wrapped in single quotes, so
`$KEEPER_DB` never expands and the command fails for any reader who runs it
verbatim. This corrects the shipped command so the documented health check
actually works.

## Acceptance

- [ ] The README repin-verify command expands the DB path when copy-pasted and resolves to the documented default when `KEEPER_DB` is unset.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | sitter/README.md:366-367 single-quotes file:$KEEPER_DB?mode=ro so the env var never expands; the just-shipped repin-verify command errors for every copy-paste reader. |

## Out of scope

- Any change to the repin lane logic or `sitters/repin/watch.ts` (the audit found the code correct; only the doc command is broken).
- The keeper test-harness isolation and promote gate (shipped clean, no findings).
