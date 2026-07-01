## Overview

Follow-up from the fn-1033 (keeper self-install) rollout: make
`scripts/install.sh` bounce keeperd on a code-only change. Its reload is currently
gated on the plist alone, so a source-only change leaves the running daemon stale —
found during the fn-1039 rollout, where the daemon needed a hand `kickstart -k`.

## Quick commands

- `bash scripts/install.sh` after a source-only change → keeperd restarts onto the new code

## Acceptance

- [ ] `scripts/install.sh` reloads keeperd when the daemon's source changed since its last boot (not only on a plist change), still idempotent
