## Overview

A multi-toplevel epic under worktree mode currently jams with a sticky `worktree-repo-unresolved` dispatch failure unless the operator hand-toggles worktree mode off and back on around it. The `worktree_multi_repo` clustering flag exists and the RPC accepts it, but the autopilot CLI never exposed the key — and the reject reason misdescribes the problem ("root X is not inside a git worktree" for a directory that is a healthy git repo). Make the flag operable and the failure self-explanatory.

## Quick commands

- `keeper autopilot config worktree_multi_repo on` — must round-trip after this epic
- `keeper query autopilot_state --json | jq '.data[0].worktree_multi_repo'` — verify the durable column

## Acceptance

- [ ] `keeper autopilot config worktree_multi_repo <on|off>` accepted by the CLI and applied via the generic set_autopilot_config RPC (no new RPC)
- [ ] The multi-toplevel reject reason names the actual condition and the flag that unjams it
- [ ] A multi-repo epic dispatches under worktree mode with the flag on (slow-tier or manual verification recorded)
