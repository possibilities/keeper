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
repo_logrotate_plist="${repo_root}/plist/arthack.keeperd.logrotate.plist"
live_logrotate_plist="${HOME}/Library/LaunchAgents/arthack.keeperd.logrotate.plist"
logrotate_service="gui/$(id -u)/arthack.keeperd.logrotate"

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

# 2b. Default launcher plugin config. `keeper agent` fail-loud-requires
#     ~/.config/keeper/plugins.yaml; ship keeper's own default (keeper's two
#     plugins, no arthack scan dirs) when the file is absent so a fresh machine
#     launches without arthack's stow package. The write decision + never-clobber
#     gate live in src/agent/config.ts (an existing file OR symlink — even a
#     dangling one — is left byte-untouched); this is a thin caller.
echo "install: ensure default plugins.yaml"
( cd "${repo_root}" && bun run scripts/ensure-plugin-config.ts )

# 2c. Shell completions. Write the generated bash/zsh/fish completion files into
#     shell-owned user locations (idempotent; never edits a shell rc file). Runs
#     after `bun link` so `keeper` is on PATH, though the helper generates scripts
#     in-process and needs no linked binary. KEEPER_SKIP_COMPLETIONS=1 opts out.
#     Completions are non-critical: this step never aborts the daemon install.
if [ "${KEEPER_SKIP_COMPLETIONS:-0}" = "1" ]; then
  echo "install: KEEPER_SKIP_COMPLETIONS=1; skipping shell completions"
else
  echo "install: shell completions"
  ( cd "${repo_root}" && bun run scripts/install-completions.ts ) || \
    echo "install: shell completions step failed (non-fatal); continuing" >&2
fi

# 3. Render the plan plugin's generated files (per-cell work plugins, skills/work,
#    agents/practice-scout) so a fresh clone can spawn work:worker and the plan
#    consistency suites run instead of skipping. Every rendered output + sidecar is
#    gitignored, so this regenerates them locally on each install — the exact render
#    command lives in the repo, recoverable, not in shell history. The prompt engine
#    carries its own deps (liquidjs) that the repo-root `bun install` above does not
#    reach, so install them in-tree first, then render from the keeper root
#    (discoverPluginDirs scans plugins/* to find the plan plugin under it).
echo "install: rendering plan-plugin generated files"
( cd "${repo_root}/plugins/prompt" && bun install )
( cd "${repo_root}" && bun cli/prompt.ts render-plugin-templates --project-root "${repo_root}" )
if command -v pi >/dev/null 2>&1; then
  echo "install: rendering Pi plan agents"
  ( cd "${repo_root}" && PI_CODING_AGENT_DIR="${HOME}/.pi/agent" bun scripts/install-pi-plan-agents.ts )
fi

# 3b. pi-subagents fork sync. pi loads @tintinweb/pi-subagents LIVE from the
#     local fork checkout (a local-path package source in ~/.pi/agent/settings.json)
#     so local patches and in-flight upstream PR branches take effect without a
#     package reinstall. Keep the checkout rebased on upstream so drift surfaces
#     at install time rather than as a live panel failure. ANY sync error rolls
#     the checkout back to its pre-rebase tip (the last known-good state) and
#     sends a desktop notification that we are out of sync with upstream. This
#     step never fails the keeper install.
pi_subagents_fork="${HOME}/src/possibilities--pi-subagents"
pi_subagents_branch="master"
pi_subagents_notify() {
  echo "install: pi-subagents fork sync: $1" >&2
  if command -v notifyctl >/dev/null 2>&1; then
    notifyctl show-message -t "pi-subagents out of sync with upstream" \
      -m "$1 (${pi_subagents_fork})" >/dev/null 2>&1 || true
  fi
}
if [ -d "${pi_subagents_fork}/.git" ]; then
  echo "install: syncing pi-subagents fork against upstream"
  (
    set -Eeuo pipefail
    cd "${pi_subagents_fork}"
    current_branch="$(git branch --show-current)"
    if [ "${current_branch}" != "${pi_subagents_branch}" ]; then
      pi_subagents_notify "checkout is on '${current_branch:-<detached>}', expected '${pi_subagents_branch}' — pi is loading whatever is checked out"
      exit 0
    fi
    if [ -n "$(git status --porcelain)" ]; then
      echo "install: pi-subagents fork has local changes; skipping upstream sync"
      exit 0
    fi
    safe_tip="$(git rev-parse HEAD)"
    if ! git fetch upstream --quiet; then
      pi_subagents_notify "git fetch upstream failed — cannot verify sync"
      exit 0
    fi
    if git merge-base --is-ancestor upstream/master HEAD; then
      echo "install: pi-subagents fork already contains upstream/master; no rebase"
      exit 0
    fi
    if ! git rebase upstream/master >/dev/null 2>&1; then
      git rebase --abort >/dev/null 2>&1 || true
      git reset --hard "${safe_tip}" >/dev/null 2>&1 || true
      pi_subagents_notify "rebase onto upstream/master conflicted; rolled back to pre-rebase tip ${safe_tip:0:10}"
      exit 0
    fi
    if [ -x node_modules/.bin/tsc ] && ! node_modules/.bin/tsc --noEmit >/dev/null 2>&1; then
      git reset --hard "${safe_tip}" >/dev/null 2>&1 || true
      pi_subagents_notify "typecheck failed after rebase onto upstream/master; rolled back to pre-rebase tip ${safe_tip:0:10}"
      exit 0
    fi
    echo "install: pi-subagents fork rebased cleanly onto upstream/master"
  ) || echo "install: pi-subagents fork sync errored (non-fatal); continuing" >&2
else
  echo "install: pi-subagents fork not present (${pi_subagents_fork}); skipping sync"
fi

# 4. LaunchAgent reload, LAST — so a mid-step kill still leaves the idempotent
#    bun steps complete. Gate on content, loaded state, AND source: reload when
#    the live plist differs from (or is missing against) the repo copy, OR when it
#    matches but keeperd is not actually registered, OR when the daemon SOURCE
#    advanced since the last reload. `cmp -s` alone reads through the symlink, so a
#    symlink repointed by a reload that then failed would compare equal and latch
#    the outage shut on the next run — the loaded-state check decouples the gate
#    from the symlink so a rerun re-attempts until loaded.
#
#    Source-change trigger: the plist rarely changes, so a pure code change (new
#    src/*.ts after a `bun link`) would otherwise leave the running daemon on
#    stale code. But most commits — board checkpoints, docs, tests — never reach
#    the resident daemon, so fingerprinting the whole repo HEAD bounced keeperd
#    near-continuously. Key instead on the daemon LOAD SURFACE:
#    scripts/daemon-fingerprint.ts hashes only the declared load roots
#    (scripts/daemon-load-roots.txt) content-addressed at HEAD, so a docs-only or
#    board-checkpoint commit leaves the composite — and the daemon — unchanged.
#    Asymmetric failure directions: a declared root that fails to resolve exits 1
#    (loud red — a manifest bug someone must fix); git wholly undeterminable exits
#    3 and degrades to the plist gate alone (no crash, no forced bounce), matching
#    a fresh-machine install. See docs/adr/0029.
fingerprint_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/keeper"
fingerprint_file="${fingerprint_dir}/install.head"
# stdout carries the composite; the seam's own stderr explains a loud/degrade
# outcome. Capture in an `if` condition so a non-zero exit does not trip `set -e`.
source_changed=0
current_fp=""
if current_fp="$( cd "${repo_root}" && bun run scripts/daemon-fingerprint.ts )"; then
  fp_rc=0
else
  fp_rc=$?
fi
if [ "${fp_rc}" -eq 1 ]; then
  echo "install: daemon load-surface fingerprint failed (a declared root did not resolve at HEAD); fix scripts/daemon-load-roots.txt" >&2
  exit 1
elif [ "${fp_rc}" -ne 0 ]; then
  # git wholly undeterminable (exit 3) — degrade to the plist gate alone.
  current_fp=""
fi
last_fp="$(cat "${fingerprint_file}" 2>/dev/null || true)"
if [ -n "${current_fp}" ] && [ "${current_fp}" != "${last_fp}" ]; then
  source_changed=1
fi
if cmp -s "${repo_plist}" "${live_plist}" \
  && launchctl print "${service}" >/dev/null 2>&1 \
  && [ "${source_changed}" -eq 0 ]; then
  echo "install: keeperd plist + source unchanged and loaded; no reload"
else
  echo "install: keeperd plist/source changed or not loaded; relink + reload"
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
  # Record the reloaded load-surface composite ONLY after keeperd is confirmed
  # loaded, so a failed reload never latches a fingerprint that suppresses the
  # next retry. Empty on a degraded (git-undeterminable) run — skip, exactly as a
  # missing sha did before.
  if [ -n "${current_fp}" ]; then
    mkdir -p "${fingerprint_dir}"
    printf '%s\n' "${current_fp}" >"${fingerprint_file}"
  fi
  echo "install: keeperd reloaded and loaded"
fi

# 5. Rotation sidecar LaunchAgent. A plist-only agent (its ProgramArguments run
#    /bin/sh, never keeper code) so there is NO source fingerprint to track — the
#    gate is content + loaded-state only: reload when the live plist differs from
#    the repo copy, or matches but is not registered. RunAtLoad=false, so nothing
#    fires at install time; the weekly `kickstart -k` restarts keeperd, which is
#    safe by design (autopilot resumes its durable paused state; lanes re-derive).
#    Same bootout(||true)/enable/bootstrap + bounded-retry discipline as the main
#    reload above, so a rerun is a clean no-op once loaded.
if cmp -s "${repo_logrotate_plist}" "${live_logrotate_plist}" \
  && launchctl print "${logrotate_service}" >/dev/null 2>&1; then
  echo "install: logrotate sidecar unchanged and loaded; no reload"
else
  echo "install: logrotate sidecar changed or not loaded; relink + reload"
  mkdir -p "${HOME}/Library/LaunchAgents"
  ln -sfn "${repo_logrotate_plist}" "${live_logrotate_plist}"
  launchctl bootout "${logrotate_service}" 2>/dev/null || true
  launchctl enable "${logrotate_service}"
  logrotate_reloaded=0
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "${domain}" "${live_logrotate_plist}" 2>/dev/null; then
      logrotate_reloaded=1
      break
    fi
    echo "install: logrotate bootstrap attempt ${attempt} did not settle; retrying" >&2
    sleep 1
  done
  if [ "${logrotate_reloaded}" -ne 1 ] \
    || ! launchctl print "${logrotate_service}" >/dev/null 2>&1; then
    echo "install: logrotate sidecar failed to load after reload; recover with" >&2
    echo "  launchctl bootstrap ${domain} ${live_logrotate_plist}" >&2
    exit 1
  fi
  echo "install: logrotate sidecar reloaded and loaded"
fi

echo "install: done"
