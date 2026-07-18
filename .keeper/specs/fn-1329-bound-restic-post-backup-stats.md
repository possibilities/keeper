## Overview

The dotfiles backup scripts run unbounded default `restic stats --json` (all-snapshot
restore-size mode) after every backup; on a large repository it held 80-87% CPU plus
repository I/O for over ten minutes and amplified a host incident. This epic makes
post-backup monitoring cheap, deadline-bound, low-priority, and lock-free in BOTH
backup scripts, retains the prior recorded size on any non-clean stats exit, and
guarantees backup success is never held hostage by optional monitoring.

## Quick commands

- bash -n /Users/mike/code/dotfiles/bin/.local/bin/restic-backup-silverbird && bash -n /Users/mike/code/dotfiles/bin/.local/bin/restic-backup
- grep -n 'STATS_DEADLINE' /Users/mike/code/dotfiles/bin/.local/bin/restic-backup-silverbird /Users/mike/code/dotfiles/bin/.local/bin/restic-backup

## Acceptance

- [ ] Post-backup stats in both scripts is deadline-bound, low-priority, lock-free, and cheap-mode; a timed-out stats never changes the script exit code
- [ ] The prior recorded repo size is retained on any non-clean stats exit, including after a successful backup
- [ ] A deliberate tiny-deadline run proves the deadline kills the restic child and backup-monitor still parses every state field
