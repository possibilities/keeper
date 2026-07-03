## Description

Finding F1 (evidence: arthack `scripts/install.sh:593-595`). The section-6c
comment reads: "The LaunchAgent (arthack.keeperd) is a committed symlink under
system/launchagents/ -> keeper's plist, so processctl start-processes loads it
below like every other agent." That symlink was deleted in commit 68afb927a;
the launchagents fingerprint glob at install.sh:687-691 (`processctl
start-processes`) no longer discovers `arthack.keeperd`, and keeper's own
`scripts/install.sh:92-121` installs and `launchctl bootstrap`s it. Update the
comment to state that keeper's installer now owns the `arthack.keeperd` load
path and that arthack's `processctl start-processes` no longer manages it, so a
future editor cannot "repair" a perceived-missing plist by re-creating the
deleted symlink.

## Acceptance

- [ ] Comment at install.sh section 6c states keeper's own installer owns and bootstraps arthack.keeperd
- [ ] Comment no longer implies system/launchagents/ + processctl start-processes loads arthack.keeperd
- [ ] No code/behavior change; comment text only

## Done summary
Corrected section-6c comment in arthack scripts/install.sh: keeper's own installer (~/code/keeper/scripts/install.sh) now documented as owner/bootstrapper of the arthack.keeperd load path, and the stale claim that system/launchagents + processctl start-processes loads it is removed, with a guardrail against re-adding the deleted symlink.
## Evidence
