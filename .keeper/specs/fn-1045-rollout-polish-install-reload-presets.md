## Overview

Two small follow-ups from the fn-1033 (keeper self-install) + fn-1039
(harness-default presets) rollout: make `scripts/install.sh` bounce keeperd on a
code-only change (its reload is currently gated on the plist alone), and surface
the `<harness>_default` pointer keys in `keeper agent presets list`. Both were
found during the fn-1039 rollout — the daemon needed a hand `kickstart -k`, and
the defaults resolve correctly but aren't visible in the list.

## Quick commands

- `bash scripts/install.sh` after a source-only change → keeperd restarts onto the new code
- `keeper agent presets list` → shows `claude_default` / `codex_default` / `pi_default`

## Acceptance

- [ ] `scripts/install.sh` reloads keeperd when the daemon's source changed since its last boot (not only on a plist change), still idempotent
- [ ] `keeper agent presets list` displays the three `<harness>_default` pointers
