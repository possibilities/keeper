## Overview

The restart CLI's honest-verdict machinery still returns terminal `kickstart-failed` while the restart ledger records a fresh healthy boot and the daemon answers status seconds later — reproduced on a clean non-migration boot with retained kickstart output present in the envelope. The fall-through-to-evidence design is in place but some path still short-circuits to failure; this epic root-causes and fixes it.

## Quick commands

- `bun test ./test/restart-cli.test.ts` — focused suite green

## Acceptance

- [ ] A nonzero kickstart followed by a fresh healthy boot returns success with the kickstart warning, proven against the exact evidence shape from the live reproductions
- [ ] The root cause is stated in the Done summary, not just patched around
