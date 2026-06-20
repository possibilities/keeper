## Overview

`keeper reclaim` (fn-847) fails at the VACUUM INTO step with "attempt to write a
readonly database": reclaimDb opens the source READ-ONLY (correct, for swap safety)
but then tries to bake `PRAGMA auto_vacuum=INCREMENTAL` onto that read-only source.
The source is already `auto_vacuum=2`, so the bake is redundant AND illegal on a
read-only handle — so the command cannot complete a real reclaim. The snapshot
VACUUM INTO (no bake) succeeds, which is why only the reclaim path fails. Discovered
running the reclaim by hand (manual VACUUM INTO worked: 1.2 GB -> 915 MB, row-count
identical). fn-850 added run() coverage but its temp DB didn't exercise the
read-only-source bake path.

## Acceptance

- [ ] `keeper reclaim` completes against the live DB (daemon stopped): VACUUM INTO + atomic swap, no readonly error
- [ ] auto_vacuum=INCREMENTAL is achieved on the OUTPUT without writing the read-only source — skip the bake when the source is already INCREMENTAL, or set it via the output/write path
- [ ] a test drives the ACTUAL read-only-source reclaim path (not a read-write temp DB) so this regression is caught
- [ ] `bun run test:full` green
