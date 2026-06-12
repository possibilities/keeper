## Description

**Size:** S
**Files:** README.md, FINDINGS-LEDGER.md, ~/Library/LaunchAgents symlinks (builds, helptailing, gitpolice)

### Approach

Symlink and bootstrap the three not-yet-loaded watch jobs (arthack.babysitter.gitpolice.watch — never bootstrapped — plus builds and helptailing) following the README install pattern; verify all four jobs list with last exit 0 and that builds/helptailing state dirs + heartbeat.json appear after a first tick. Finish the README install/uninstall blocks (three new labels; prune the stale performance-watchdog retirement lines ~94-97 — history-in-docs). Sanity-check FINDINGS-LEDGER.md against the followup schemas tasks 2-3 actually shipped; the roster prose already names builds and helptailing.

### Investigation targets

**Required** (read before coding):
- README.md install/uninstall blocks — the ln -s + launchctl bootstrap/bootout line pattern per label
- FINDINGS-LEDGER.md — roster prose and per-sitter followup schema sections

### Test notes

`launchctl list | grep arthack.babysitter` shows four watch jobs, last exit 0; `ls ~/.local/state/babysitters/` shows performance, gitpolice, builds, helptailing after first ticks.

## Acceptance

- [ ] four watch jobs loaded with last exit 0; no watchdog jobs anywhere
- [ ] builds + helptailing state dirs and heartbeats exist after first tick
- [ ] README install/uninstall matches reality; stale watchdog prose pruned
- [ ] FINDINGS-LEDGER consistent with the shipped followup schemas

## Done summary

## Evidence
