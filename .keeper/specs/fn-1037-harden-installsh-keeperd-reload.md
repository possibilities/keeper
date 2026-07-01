## Overview

The keeperd LaunchAgent reload in `scripts/install.sh` is non-atomic and its
failure is silently latched by the `cmp -s` content gate: the plist symlink is
repointed before the async `bootout`->`bootstrap` completes, so a transient
reload failure under `set -e` can leave keeperd booted-out and unregistered,
and the next run's `cmp -s` reports "unchanged" and skips the reload entirely.
This is an operator-facing daemon-outage risk that needs a manual
`launchctl bootstrap` to recover.

## Acceptance

- [ ] A failed/partial reload no longer leaves keeperd unregistered with the
      content gate latched shut on the next run.
- [ ] The installer verifies the daemon is actually loaded at the end of the
      reload branch (or otherwise decouples the symlink state from loaded state)
      and fails loud / retries when it is not.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | install.sh:52 repoints the symlink before the async bootout->bootstrap (57-59); a bootstrap failure latches cmp -s (47) as unchanged, leaving keeperd unregistered. |
| F2 | culled | — | Pre-existing dep-reload gating; sole remedy is a consolation operator note with no hidden invariant. |
| F3 | culled | — | Vendored config is in sync now; a drift-lint is speculative future maintenance. |
| F4 | culled | — | Auditor labels the install.sh coverage gap known and accepted, inherently integration-only. |

## Out of scope

- A `bun install` dep-bump reload note (F2, advisory pre-existing pattern).
- A drift-lint keeping vendored claude config in sync with arthack (F3).
- Automated coverage for install.sh (F4, inherently integration-only under keeper's no-subprocess test isolation).
