## Overview

The panel cancellation cleanup shipped a security-critical guard,
`isRunControlArtifact`, that allowlists the exact `tmux ... kill-window -t @N`
argv permitted from an untrusted, on-disk control artifact before the panel
consumer executes it verbatim. The guard is sound but its command-tail
branch has no negative-case test, so a future edit that loosens the
allowlist (a non-`kill-window` verb, a non-`@N` target, an odd-length socket
run, or a non-`tmux` argv[0]) would ship green. This follow-up closes that
coverage gap so the injection boundary cannot regress silently.

## Acceptance

- [ ] `isRunControlArtifact` rejects a well-owned control whose `kill_window_command` is a well-formed but hostile/mis-shaped argv
- [ ] the rejection is asserted end-to-end through `cancelOwnedRunFromControlArtifact` -> `malformed_control` (no tmux command is executed)

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | isRunControlArtifact command-tail allowlist has zero negative coverage; only malformed_control test feeds {nope:true} which fails at schema_version and never reaches the injection-guard branch |
| F2 | culled | —  | pre-existing near-impossible sync-window race; wrapper still publishes a fail-closed control artifact |
| F3 | culled | —  | advisory ADR suggestion for a back-compatible additive protocol already carrying exported doc-comments |
| F4 | culled | —  | only remedy is a consolation comment; the socket invariant is better pinned by this task's negative test cases |

## Out of scope

- The never-spawned `panelCancel` shortcut race (F2) — pre-existing, near-impossible, declined
- An ADR entry for the control-ownership protocol (F3) — declined as discretionary
- An inline comment on the socket even/odd validation (F4) — declined; covered by the added test cases
