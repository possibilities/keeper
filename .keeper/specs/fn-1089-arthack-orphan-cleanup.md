## Overview

Remove the arthack artifacts whose only consumer was keeper, now that keeper owns its own
launch config and install footprint. Scope is deliberately narrow: file deletions and the
machine config swap they require — NO corpus, snippet, vendor-pipeline, or render changes of
any kind (the snippet system keeps working exactly as it does today; any evolution there is a
separate future effort). Depends on the dissolution epic so the keeper-owned config path is
proven before the arthack originals are deleted.

## Quick commands

- `stow -t ~ -R arthack` (or the repo's restow command) leaves no dangling ~/.config/keeper symlink
- `keeper agent claude --help` boots after the config swap; `launchctl list | grep keeperd` still shows the daemon loaded from keeper's plist

## Acceptance

- [ ] ~/.config/keeper/plugins.yaml is a real keeper-written file preserving current effective content (keeper + plan + the arthack scan dirs as this machine's explicit opt-in); no symlink into arthack remains
- [ ] system/arthack/.config/keeper/ and system/launchagents/.../arthack.keeperd.plist deleted from arthack; the loaded LaunchAgent remains keeper's install.sh-managed plist; restow leaves no dangling links
- [ ] claude/internal/ removed; the plugin scan set no longer references it anywhere
- [ ] Corpus, snippets, bundles, vendor.lock, and all render behavior byte-untouched in both repos

## Early proof point

Task `.1` — the config swap is the only risky step and is verified inline before any deletion.

## References

- Verified manifest (this session's exploration): system/arthack/.config/keeper/plugins.yaml (stow source of the machine symlink); system/launchagents/Library/LaunchAgents/arthack.keeperd.plist (duplicate deploy path — keeper's scripts/install.sh:15-16 manages the live plist from keeper's plist/ copy); claude/internal/ (manifest-only empty plugin shell)
- Explicitly KEPT: the entire _partials corpus tree, hookctl-bus-pointer reminder row, keeper commit-work advice entry, buildbot keeper builder, codex-marketplace plan.md, all hooks/skills
- keeper's ensure-plugin-config.ts — the never-clobber default writer (it must NOT be what writes this machine's file; the task writes the opt-in file explicitly)

## Docs gaps

- **arthack CLAUDE.md / stow docs**: drop any line describing arthack as the shipper of keeper's launch config
