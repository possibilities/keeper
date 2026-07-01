## Description

**Size:** M
**Files:** scripts/install.sh (new), README.md, plist/arthack.keeperd.plist

### Approach

Add an idempotent `scripts/install.sh` formalizing the manual procedure in
README `## Install` (README.md:406-641), modeled on
`plugins/plan/scripts/promote.sh`'s conventions (`#!/usr/bin/env bash`,
`set -Eeuo pipefail` + ERR trap, repo root from `${BASH_SOURCE[0]}`, trap
cleanup EXIT). Steps, in order:
1. `flock` the script on entry (`exec 9>lock; flock -n 9 || exit 0`) — CI can queue two green builds; a concurrent run is a no-op EXIT 0, not a failure.
2. `bun install` — MUST precede any daemon reload (the `@parcel/watcher` native addon dyld-crashes if `node_modules` is absent; it is a `trustedDependency`).
3. `bun link` — idempotent; guard with `[ -L ~/.bun/bin/keeper ]`.
4. Gated keeperd reload, LAST: `cmp -s` the plist against the live
   `~/Library/LaunchAgents/arthack.keeperd.plist`; only when it differs, reload
   via the MODERN launchctl surface — `launchctl bootout gui/$(id -u)/arthack.keeperd 2>/dev/null || true; launchctl enable …; launchctl bootstrap gui/$(id -u) <plist>`.
   NEVER `kickstart -k` for a changed plist (it does not re-read the plist).
   Reload last so a mid-step kill still leaves the idempotent bun steps complete.

NO stow step (decision B — the launch guard is the sole owner of the canonical
leaves). Rewrite README `## Install`: replace the "Keeper has no `install` verb.
Wire it up manually" lede with `scripts/install.sh` as the primary path, demote
the manual steps to "what the script does," and drop the arthack-launcher framing
on the plugin step. Fix the stale `plist/arthack.keeperd.plist` header comment
("keeper ships no install verb") — present-tense, no provenance.

### Investigation targets

**Required** (read before coding):
- README.md:406-641 — the manual install steps that are the script's spec
- plugins/plan/scripts/promote.sh:1-39 — the bash conventions to mirror
- plist/arthack.keeperd.plist — the reload target + the stale header comment (:6)
- package.json — `bin: {keeper: cli/keeper.ts}` (bun link prereq); `trustedDependencies` (@parcel/watcher)

**Optional** (reference as needed):
- scripts/lint-retired-name.sh — Check C (the new script must be "agentwrap"-clean)

### Risks

- `bootstrap` over an already-loaded agent errors — bootout-first + `|| true`; keep the whole reload idempotent.
- Default `ExitTimeOut` (5s) may SIGKILL a daemon mid-write; the daemon is event-sourced and resumes, so a clean SIGTERM is fine — do not add plist `ExitTimeOut` changes here.
- Never fail a build on the `flock` concurrent-run path (exit 0).

### Test notes

- No unit test (shell). Verify by running `bash scripts/install.sh` twice: the second run is a no-op reload when the plist is unchanged. Confirm `keeper` on PATH and `launchctl list | grep arthack.keeperd` loaded.
- `shellcheck` clean (`keeper commit-work` runs it on staged `.sh`).

## Acceptance

- [ ] `scripts/install.sh` runs `bun install` → `bun link` → cmp-gated keeperd bootout+bootstrap reload, idempotently (second run is a no-op when nothing changed)
- [ ] NO stow step
- [ ] Modern launchctl (bootout/enable/bootstrap), never `kickstart -k` for a changed plist; reload gated on `cmp -s` of the plist and is the LAST step
- [ ] `flock` guards concurrent runs (exit 0, not a failure)
- [ ] README `## Install` rewritten around `scripts/install.sh`; stale "no install verb" lede + plist header comment fixed (present-tense)
- [ ] `shellcheck` + `scripts/lint-retired-name.sh` clean

## Done summary
Added idempotent scripts/install.sh (flock-guarded bun install -> bun link -> cmp-gated modern-launchctl reload, no stow); rewrote README ## Install around it and fixed the stale plist header. Guard remains sole owner of the canonical claude leaves.
## Evidence
