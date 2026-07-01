## Description

**Size:** S
**Files:** scripts/install.sh

### Approach

The keeperd bootout/bootstrap reload in `scripts/install.sh` is gated only on
`cmp -s` of `arthack.keeperd.plist`, so a pure source change (new `src/*.ts`)
leaves the running daemon on stale code — the buildbot `keeper-install` job
`bun link`s new CLI code but never restarts keeperd (it only reloads on a plist
change or a manual `launchctl kickstart -k`, which is what had to be run by hand
during the fn-1039 rollout). Add a source-change trigger: reload keeperd when the
daemon's source advanced since its last boot — e.g. fingerprint the repo HEAD sha
(mirroring arthack install.sh's `fingerprint_check`/`fingerprint_save`) and reload
when it changed, OR compare the running keeperd process start time to
`git log -1 --format=%ct`. Keep the plist-change trigger too (reload on EITHER).
Preserve idempotency (no needless bounce when nothing changed) and the modern
`launchctl bootout`/`enable`/`bootstrap` surface.

Note: the sibling "presets list should show the `<harness>_default` pointers"
idea was dropped — `keeper agent presets list` already prints a "Harness defaults"
section (fn-1039), so there is nothing to add there.

### Investigation targets

**Required** (read before coding):
- scripts/install.sh — the cmp-gated plist bootout/bootstrap reload block (emits "keeperd plist unchanged and loaded; no reload")

**Optional** (reference as needed):
- ~/code/arthack/scripts/install.sh — the `fingerprint_check`/`fingerprint_save` pattern to mirror for source-change detection

## Acceptance

- [ ] `scripts/install.sh` reloads keeperd on a source/code change since the daemon's last boot, not only on a plist change; still idempotent (no needless bounce)
- [ ] `shellcheck` clean on `scripts/install.sh`

## Done summary

## Evidence
