#!/usr/bin/env bash
# Idempotent installer for keeper's own footprint: dependencies, the `keeper`
# PATH entry, and the keeperd LaunchAgent. Safe to run repeatedly and from CI on
# every green build — a second run with nothing changed is a no-op.
#
# There is NO stow step: the launch-time canonical-link guard
# (`ensureCanonicalStowLinks`) is the sole owner of ~/.claude/{settings.json,CLAUDE.md},
# healing them from keeper's own module path on the next `keeper agent` launch.
set -Eeuo pipefail

trap 'echo "install: failed at line ${LINENO}" >&2' ERR

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lockfile="${TMPDIR:-/tmp}/keeper-install.lock"
repo_plist="${repo_root}/plist/arthack.keeperd.plist"
live_plist="${HOME}/Library/LaunchAgents/arthack.keeperd.plist"
service="gui/$(id -u)/arthack.keeperd"
domain="gui/$(id -u)"

# Serialize concurrent runs. CI can queue two green builds; a second concurrent
# invocation exits 0 (a no-op, never a build failure) rather than racing the
# bun steps or the launchctl reload.
exec 9>"${lockfile}"
if ! flock -n 9; then
  echo "install: another run holds ${lockfile}; nothing to do"
  exit 0
fi

# 1. Dependencies FIRST. The @parcel/watcher native addon (a trustedDependency)
#    dyld-crashes keeperd at boot if node_modules is absent, so this must precede
#    any daemon reload.
echo "install: bun install"
( cd "${repo_root}" && bun install )

# 2. Put `keeper` on PATH via bun link. Idempotent — skip when the link exists.
if [ -L "${HOME}/.bun/bin/keeper" ]; then
  echo "install: keeper already linked (${HOME}/.bun/bin/keeper)"
else
  echo "install: bun link"
  ( cd "${repo_root}" && bun link )
fi

# 3. LaunchAgent reload, LAST — so a mid-step kill still leaves the idempotent
#    bun steps complete. Gate on content AND loaded state: reload when the live
#    plist differs from (or is missing against) the repo copy, OR when it matches
#    but keeperd is not actually registered. `cmp -s` alone reads through the
#    symlink, so a symlink repointed by a reload that then failed would compare
#    equal and latch the outage shut on the next run — the loaded-state check
#    decouples the gate from the symlink so a rerun re-attempts until loaded.
if cmp -s "${repo_plist}" "${live_plist}" && launchctl print "${service}" >/dev/null 2>&1; then
  echo "install: keeperd plist unchanged and loaded; no reload"
else
  echo "install: keeperd plist changed or not loaded; relink + reload"
  mkdir -p "${HOME}/Library/LaunchAgents"
  ln -sfn "${repo_plist}" "${live_plist}"
  # Modern launchctl surface. bootout-first (|| true — bootstrap over an already
  # loaded agent errors); enable clears any prior `disable`; bootstrap re-reads
  # the plist. kickstart -k is deliberately NOT used: it re-spawns the process
  # but keeps the cached registration, so a changed plist never takes.
  launchctl bootout "${service}" 2>/dev/null || true
  launchctl enable "${service}"
  # bootout is async, so a back-to-back bootstrap can error before the unload
  # settles. Bounded-retry so a transient failure self-heals within the run
  # instead of aborting under `set -e` with the symlink already repointed.
  reloaded=0
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "${domain}" "${live_plist}" 2>/dev/null; then
      reloaded=1
      break
    fi
    echo "install: bootstrap attempt ${attempt} did not settle; retrying" >&2
    sleep 1
  done
  # Confirm keeperd is truly registered before declaring success — never trust
  # the symlink as proof of a completed reload.
  if [ "${reloaded}" -ne 1 ] || ! launchctl print "${service}" >/dev/null 2>&1; then
    echo "install: keeperd failed to load after reload; recover with" >&2
    echo "  launchctl bootstrap ${domain} ${live_plist}" >&2
    exit 1
  fi
  echo "install: keeperd reloaded and loaded"
fi

echo "install: done"
