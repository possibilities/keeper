## Description

**Size:** S
**Files:** system/launchagents/Library/LaunchAgents/arthack.promptctl.bundle-health-snapshot.plist, CLAUDE.md, claude/CLAUDE.md, system/CLAUDE.md

### Approach

Boot out the live agent first (`launchctl bootout gui/$(id -u)/arthack.promptctl.bundle-health-snapshot || true`), verify absence via `launchctl list`, then `git rm` the plist and let `processctl start-processes` reconcile the orphaned symlink in ~/Library/LaunchAgents. Leave ~/.local/state/promptctl/ state files in place (bundle-health.jsonl, snapshot log) — inert history. Then prune the doc pointers tied to the watch: delete the "Bundle-health watch" bullet from root CLAUDE.md Pointers, strip the bundle-health/snapshot clause from the promptctl entry in claude/CLAUDE.md, and swap the plist example in system/CLAUDE.md for a still-live LaunchAgent name. Present-tense prose only — no "removed in" narration.

### Investigation targets

**Required** (read before coding):
- system/launchagents/Library/LaunchAgents/arthack.promptctl.bundle-health-snapshot.plist — the file to remove
- CLAUDE.md:34 — Bundle-health watch pointer bullet
- claude/CLAUDE.md:42 — promptctl plugin entry clause
- system/CLAUDE.md:16 — plist naming example to replace

**Optional** (reference as needed):
- apps/processctl/processctl/cli.py:101-108 — processctl owns the symlink lifecycle, not stow

### Risks

- Deleting the plist before bootout leaves an orphaned in-memory job until logout; the ordering above is load-bearing.

### Test notes

`launchctl list | grep arthack.promptctl.bundle-health-snapshot` returns nothing; `processctl start-processes` reports no orphans; shellcheck/lint surfaces unaffected.

## Acceptance

- [ ] Agent absent from launchctl list; plist deleted from the repo; no dangling symlink in ~/Library/LaunchAgents
- [ ] Root CLAUDE.md, claude/CLAUDE.md, and system/CLAUDE.md carry no bundle-health references; no backward-facing prose introduced

## Done summary
Booted out and git-rm'd the bundle-health-snapshot LaunchAgent (processctl reconciled the orphan symlink) and pruned bundle-health references from root, claude, and system CLAUDE.md. Agent and symlink confirmed absent.
## Evidence
