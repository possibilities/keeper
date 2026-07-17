## Overview

The restart verdict machinery is now evidence-based, but its time budgets are mis-fit to reality: `launchctl kickstart -k` gets a 1-second budget and is TERM-killed mid-work on every invocation (`timed_out:true`, exit 143 — observed on every restart tonight), and the 30s overall deadline is shorter than this host's real post-boot catch-up (a timed live run consumed the full 30.0s probing without ever seeing three `catching_up:false` replies, while the daemon was verifiably healthy ~a minute later). Every restart therefore reports `kickstart-failed` regardless of outcome. Fit the budgets to reality.

## Quick commands

- `bun test ./test/restart-cli.test.ts` — focused suite green

## Acceptance

- [ ] The kickstart subprocess budget accommodates a normal `kickstart -k` (no timed_out on a healthy restart)
- [ ] The default overall deadline accommodates this host's observed post-boot catch-up, and `--timeout` still overrides
- [ ] A healthy restart returns exit 0 (verified live by the operator after deploy — not a task gate)
