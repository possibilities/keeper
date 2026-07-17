## Overview

`keeper daemon restart` reports terminal `kickstart-failed` whenever `launchctl kickstart` returns nonzero, before its own health probes run and with the kickstart output discarded — while launchd has frequently already completed a healthy fresh boot. The verdict must come from fresh-boot plus health evidence, not the kickstart exit status.

## Quick commands

- `bun test ./test/restart-cli.test.ts` — focused suite green

## Acceptance

- [ ] A restart that produces a fresh healthy boot returns success even when kickstart exits nonzero, carrying a bounded kickstart warning
- [ ] Failure is reserved for no fresh healthy boot by the deadline
