## Description

**Size:** S
**Files:** bin/.local/bin/restic-backup-silverbird, bin/.local/bin/restic-backup

### Approach

In both backup scripts, the post-backup `restic stats` call becomes: repo-wide
`--mode raw-data` with `--no-lock` and `--json` (no snapshot argument — cheap in
every repo state, no zero-snapshot error, and the displayed number becomes honest
physical repo bytes), wrapped in the repo's `guard` perl-alarm deadline idiom
(copied inline per the repo's skeleton-duplication convention) under
`nice -n 20` + `taskpolicy -b -d throttle`, with a `STATS_DEADLINE_SECONDS=90`
named constant at the top of each script. If the child survives alarm expiry, a
bounded KILL escalation follows. `--no-lock` is the safety keystone: a killed
stats must never orphan a repo lock that blocks the next backup. The
retain-prior-size branch changes from `elif [[ "$LAST_BACKUP_SUCCESS" == "false" ]]`
to a plain `else` in BOTH scripts so `prev_size` is retained on ANY non-clean
stats exit — today a stats timeout after a SUCCESSFUL backup silently loses the
prior recorded size. The sibling `restic snapshots --json` call gets the same
guard + `--no-lock` bounding with its existing failure semantics preserved. A
timeout logs one line (deadline seconds + retained size) for manual tuning.
`restic check` stays unbounded by design (plist TimeOut caps the whole run). The
whole stats block stays inside an `if` condition so `set -euo pipefail` can never
abort the script before `exit $backup_exit`. Edit the repo files (stow symlinks
make them live); never touch the `~/.local/bin` targets; NEVER stage the
unrelated dirty `Brewfile`. Update each script's header comment in place to say
monitoring is best-effort/bounded, and add the one-line guardrail to the dotfiles
CLAUDE.md Restic section: post-backup monitoring is best-effort and never blocks
backup exit.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- bin/.local/bin/restic-backup-silverbird:168-179 — the unbounded stats, the `elif` retain-prior bug at :171, write_state at :179; prev_size hydration at :87-98
- bin/.local/bin/restic-backup:168-203 — the sibling copy (stats :171-176, elif :174, single write_state :203); the two scripts' structural asymmetry means the diffs are similar, not identical
- system/yabai-maintain:36-43 — the `guard SECONDS CMD` perl-alarm idiom (SIGALRM, exit 142) to copy inline
- bin/.local/bin/backup-monitor:141 — `format_repo_summary` is the ONLY reader of REPO_SIZE_DISPLAY (display-only; health checks read other fields), so the raw-data meaning change is cosmetic

**Optional** (reference as needed):
- system/launchagents/Library/LaunchAgents/backup.snapshot-silverbird.plist — StartInterval 3600 / TimeOut 3300, the outer backstop this change must stay inside

### Test notes

No shell test harness exists; verification is a scripted manual recipe recorded in
Evidence: (1) `bash -n` both scripts; (2) run silverbird with
`STATS_DEADLINE_SECONDS=1` temporarily forced — prove the restic child dies at the
deadline (process-tree check: the guard signal must reach restic through the
nice→taskpolicy chain, not orphan it), the timeout log line appears, the state
file retains the prior size, and the script exits with the backup's own status;
(3) run with the real deadline — prove fresh raw-data size lands; (4)
`backup-monitor` parses every field of both state files afterward; (5)
`restic unlock` finds nothing to remove (no orphaned locks).

## Acceptance

- [ ] Both backup scripts bound post-backup stats with the guard deadline under nice + taskpolicy background/IO throttle, using no-lock raw-data JSON with no snapshot argument, behind a named deadline constant
- [ ] The prior recorded size is retained on any non-clean stats exit regardless of backup success, and a timeout emits one log line
- [ ] The snapshots listing call is bounded and lock-free with its existing failure semantics preserved
- [ ] A deliberate tiny-deadline run demonstrates the restic child dies at the deadline, no repo lock is orphaned, the script exit code is the backup's own, and backup-monitor parses every state field
- [ ] Script headers state monitoring is best-effort/bounded and the dotfiles CLAUDE.md carries the one-line guardrail; the dirty Brewfile is never staged

## Done summary
Bound post-backup restic stats/snapshots monitoring in both backup scripts to a 90s perl-alarm guard (with TERM-then-KILL escalation) under nice+taskpolicy throttling, using --no-lock and raw-data mode; retained prior repo size on any non-clean stats exit via a plain else with a one-line timeout log; documented best-effort monitoring in script headers and CLAUDE.md.
## Evidence
