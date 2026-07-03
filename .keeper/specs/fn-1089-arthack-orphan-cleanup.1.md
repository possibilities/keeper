## Description

**Size:** S
**Files:** system/arthack/.config/keeper/plugins.yaml (delete), system/launchagents/Library/LaunchAgents/arthack.keeperd.plist (delete), claude/internal/ (delete), arthack CLAUDE.md/stow docs (prune), plus the machine config swap (~/.config/keeper/plugins.yaml)

### Approach

Order matters — swap before delete. (1) Machine swap: read the current effective
~/.config/keeper/plugins.yaml content through the symlink, write it to a temp file as a real
file (same plugin_dirs; the arthack scan_dirs preserved as this machine's explicit opt-in
with a one-line comment saying so), atomically mv over the symlink, then verify
`keeper agent claude --help` boots and the file parses (loadPluginSources succeeds). (2)
Verify keeper's plist is the loaded one: compare arthack's stow copy against keeper's
plist/arthack.keeperd.plist and confirm launchctl's loaded path is the live
~/Library/LaunchAgents file keeper's install.sh manages — then delete arthack's copy. (3)
Delete system/arthack/.config/keeper/ and claude/internal/ from the arthack repo; restow or
prune the affected packages so no dangling symlinks remain in $HOME (check
~/Library/LaunchAgents and ~/.config for danglers after). (4) Prune any arthack doc line
that describes shipping keeper's config. Touch NOTHING under claude/arthack/template/ —
corpus and render behavior are explicitly out of scope.

### Investigation targets

**Required** (read before coding):
- The live symlink chain: ls -la ~/.config/keeper/plugins.yaml and its target
- keeper scripts/install.sh:15-16 + launchctl print gui/$UID/arthack.keeperd — confirm the loaded plist provenance
- How this machine deploys stow (the arthack repo's stow invocation/docs) so the removal is done the repo's way

### Risks

- A botched plugins.yaml bricks every subsequent claude launch — hence temp-write + atomic mv + parse/boot verification BEFORE any repo deletion; keep the old target content in the commit message for manual rollback.
- If the loaded LaunchAgent turns out to be arthack's stow copy (not keeper's), STOP and stamp BLOCKED with the evidence — do not delete a live plist.

### Test notes

No keeper/arthack suite changes expected; the verification commands above are the proof and
land in the Done summary/Evidence.

## Acceptance

- [ ] Machine plugins.yaml is a real file with preserved content; launch verified after swap
- [ ] Three orphan artifacts deleted from arthack; no dangling symlinks; loaded plist confirmed keeper-managed
- [ ] Corpus/template tree untouched; docs pruned

## Done summary
Deleted the three keeper-orphaned artifacts (system/arthack/.config/keeper/plugins.yaml, system/launchagents/Library/LaunchAgents/arthack.keeperd.plist, claude/internal/ + its claude/CLAUDE.md entry) in commit 68afb927a. Machine config swap was already complete: live ~/.config/keeper/plugins.yaml is a keeper-written real file preserving the opt-in arthack scan dirs (not the arthack-free DEFAULT_PLUGINS_YAML). Verified post-delete: 'keeper agent claude --help' boots (exit 0), launchctl shows arthack.keeperd loaded from keeper's plist (/Users/mike/code/keeper/plist/arthack.keeperd.plist), and no dangling symlinks under ~/.config/keeper or ~/Library/LaunchAgents. Corpus/template tree untouched.
## Evidence
