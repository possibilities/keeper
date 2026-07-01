## Description

Originating finding F1 (auditor Should Fix), evidence path
`scripts/install.sh:47-60`. The plist-changed reload branch does
`ln -sfn "${repo_plist}" "${live_plist}"` (line 52) FIRST, then
`launchctl bootout` (57, async), `enable` (58), `bootstrap` (59). Because
`bootout` is asynchronous, a back-to-back `bootstrap` can error before the
unload settles; under `set -Eeuo pipefail` (line 9) that aborts the script
with the symlink already repointed. On the next run `cmp -s` (line 47) reads
through the repointed symlink, compares equal, and SKIPS the whole reload
branch — so keeperd stays booted-out and unregistered with no self-heal
(effective daemon outage until manual `launchctl bootstrap`).

Decouple the content gate from daemon-loaded state. Options (pick one):
verify the service is loaded at the end of the reload branch
(`launchctl print "${service}"`) and fail loud / bounded-retry `bootstrap`
after `bootout` if not; or move the `ln -sfn` so the symlink only reflects a
COMPLETED reload. Preserve the existing invariants: `bootout || true`,
`enable` clears a prior disable, no `kickstart -k`, and the deps-then-link-then-reload
ordering (`@parcel/watcher` must be present before any reload).

## Acceptance

- [ ] A transient `bootstrap` failure after `bootout` no longer leaves the
      live symlink repointed while keeperd is unregistered AND the gate skipped
      on the next run — a rerun re-attempts the reload until keeperd is loaded.
- [ ] The reload branch confirms keeperd is actually loaded (e.g.
      `launchctl print "${service}"`) before declaring success, failing loud
      or bounded-retrying otherwise.
- [ ] Existing behavior preserved: flock guard, deps->link->reload ordering,
      `bootout || true`, `enable`, no `kickstart -k`.

## Done summary
Decoupled the keeperd reload content gate from daemon-loaded state in scripts/install.sh: gate now reloads when the plist differs OR keeperd is unregistered, with a bounded bootstrap retry and a launchctl print load-verification that fails loud, so a failed reload no longer latches cmp -s shut.
## Evidence
