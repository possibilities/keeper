## Overview

The tmux -C control worker's reader releases the command bootstrap after the
first non-empty stdout chunk, which is not guaranteed to contain the complete
unsolicited %begin/%end attach handshake block. When the handshake's %end
splits into a later read, the bootstrap's first reply can FIFO-mis-match that
still-open handshake block's eventual %end, mis-correlating one reply and
posting a transiently-wrong focus observation. The fix makes the handshake
drop deterministic regardless of read boundaries, and pins it (plus the
redirty re-read state machine) with the synthetic-child fast-tier test the
ControlChild seam was built to enable.

## Acceptance

- [ ] The bootstrap is released only after one complete reply event has been
      drained (the unsolicited handshake block fully settled), not merely
      after a chunk containing a complete line.
- [ ] A fast-tier test feeds a scripted transcript through the ControlChild
      injection seam, including a handshake whose %end arrives in a later read,
      and asserts no reply mis-correlation plus correct redirty re-arming.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1  | kept   | .1 | runConnection releases the bootstrap after any non-empty chunk; a handshake %end split across reads can FIFO-mis-match the bootstrap's first reply. |
| F2  | culled | —  | Single-quoted format interpolation uses trusted module constants (no injection surface today); remedy would be a defensive comment on self-evident code. |
| F3  | culled | —  | Post-clean-drop backoff is intentional anti-hot-loop behavior, harmless, no user impact; remedy is a one-word comment. |
| TG1 | merged-into-F1 | .1 | TG1's synthetic-child harness over the ControlChild seam is the exact mechanism proving F1's deterministic handshake-drop; same state machine and file region, one commit. |

## Out of scope

- The single-quoted format-string interpolation note (F2) — culled as no-impact.
- The clean-drop reconnect backoff comment (F3) — culled as intentional.
- Any change to the slow-tier real `tmux -C` attach coverage.
