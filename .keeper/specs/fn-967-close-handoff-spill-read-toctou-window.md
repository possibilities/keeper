## Overview

The handoff spill-file confinement validates the realpath of the
caller-supplied `doc_path` but then reads the original unresolved path,
leaving a narrow TOCTOU window where an in-dir symlink swapped between the
check and the read could escape the spill dir. This follow-up closes that
window by reading the already-resolved path and locks the realpath
confinement against regression with an explicit in-dir-symlink test. The
window is immaterial under the same-user UDS model but the fix is free and
keeps the security boundary airtight.

## Acceptance

- [ ] The handoff spill read reads the resolved in-dir path, not the
      unresolved caller-supplied `doc_path`.
- [ ] An integration test asserts an in-dir symlink pointing out-of-dir is
      rejected with the loud out-of-dir ok:false.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | src/daemon.ts:2628-2644 validates realpathSync(msg.doc_path) but reads unresolved msg.doc_path at 2644; reading realDoc closes the swap window for free. |
| F2 | merged-into-F1 | .1 | F2 (missing in-dir-symlink test at test/integration.test.ts ~590) is the regression lock proving F1's read-realDoc fix; same code region, one commit. |

## Out of scope

- The same-user UDS threat model itself; the caller can already read its own
  files directly, so this is hardening, not a new boundary.
