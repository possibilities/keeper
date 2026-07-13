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

# 3b. pi-subagents fork: ensure installed, then sync against upstream. pi loads
#     @tintinweb/pi-subagents LIVE from the local fork checkout (a local-path
#     package source in ~/.pi/agent/settings.json) so local patches and
#     in-flight upstream PR branches take effect without a package reinstall.
#     Every install: clone the fork if absent, register it as pi's package
#     source (add-only — an existing packages entry for it is left alone), and
#     rebase the checkout onto upstream so drift surfaces at install time
#     rather than as a live panel failure. ANY sync error rolls the checkout
#     back to its pre-rebase tip (the last known-good state) and sends a
#     desktop notification that we are out of sync with upstream. This step
#     never fails the keeper install.
pi_subagents_fork="${HOME}/src/possibilities--pi-subagents"
pi_subagents_branch="master"
pi_subagents_origin="https://github.com/possibilities/pi-subagents.git"
pi_subagents_upstream="https://github.com/tintinweb/pi-subagents.git"
pi_subagents_notify() {
  echo "install: pi-subagents fork sync: $1" >&2
  if command -v notifyctl >/dev/null 2>&1; then
    notifyctl show-message -t "pi-subagents out of sync with upstream" \
      -m "$1 (${pi_subagents_fork})" >/dev/null 2>&1 || true
  fi
}
if [ ! -d "${pi_subagents_fork}/.git" ]; then
  echo "install: pi-subagents fork not present; cloning ${pi_subagents_origin}"
  mkdir -p "$(dirname "${pi_subagents_fork}")"
  git clone --quiet "${pi_subagents_origin}" "${pi_subagents_fork}" 2>/dev/null || \
    pi_subagents_notify "clone failed — fork not installed (network/auth?)"
fi
if [ -d "${pi_subagents_fork}/.git" ]; then
  # Register the checkout as pi's package source (never-clobber: adds the
  # local-path entry only when absent; drops a redundant npm registry entry
  # for the same package so pi never double-loads it).
  ( cd "${repo_root}" && PI_SUBAGENTS_FORK="${pi_subagents_fork}" bun -e '
    const { readFileSync, writeFileSync, mkdirSync, existsSync } = require("node:fs");
    const { join } = require("node:path");
    const dir = join(process.env.HOME, ".pi", "agent");
    const path = join(dir, "settings.json");
    const fork = process.env.PI_SUBAGENTS_FORK;
    let settings = {};
    if (existsSync(path)) settings = JSON.parse(readFileSync(path, "utf8"));
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    const next = packages.filter((p) => !String(p).startsWith("npm:@tintinweb/pi-subagents"));
    if (!next.includes(fork)) next.push(fork);
    if (JSON.stringify(next) !== JSON.stringify(packages)) {
      settings.packages = next;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
      console.log("install: registered pi-subagents fork as a pi package source");
    } else {
      console.log("install: pi-subagents fork already registered as a pi package source");
    }
  ' ) || pi_subagents_notify "package-source registration failed — pi may not load the fork at all"
  echo "install: syncing pi-subagents fork against upstream"
  (
    set -Eeuo pipefail
    cd "${pi_subagents_fork}"
    git remote get-url upstream >/dev/null 2>&1 || \
      git remote add upstream "${pi_subagents_upstream}"
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
    # Republish the rewritten master so origin mirrors the local lineage —
    # without this every rebase leaves origin diverged, and the next keeper
    # lane finalize push into the fork lands as a non-fast-forward wedge.
    if ! git push --force-with-lease origin "${pi_subagents_branch}" >/dev/null 2>&1; then
      pi_subagents_notify "rebased locally but could not republish master to origin — the next finalize push into the fork will non-fast-forward"
    fi
    echo "install: pi-subagents fork rebased cleanly onto upstream/master"
  ) || echo "install: pi-subagents fork sync errored (non-fatal); continuing" >&2
  # The fork must carry every contract Keeper consumes. Verify stable seam
  # markers in the loaded checkout after sync; a missing marker means wrong
  # branch, lost commit, or incompatible upstream refactor. Notify loudly but
  # keep installation fail-open so an unrelated harness remains usable.
  pi_subagents_missing=""
  grep -q "finalTurnError" "${pi_subagents_fork}/src/agent-runner.ts" 2>/dev/null || \
    pi_subagents_missing="the terminal-status fix (tintinweb/pi-subagents#144, upstream 441dd4c)"
  grep -q "compaction_end" "${pi_subagents_fork}/src/output-file.ts" 2>/dev/null || \
    pi_subagents_missing="${pi_subagents_missing:+${pi_subagents_missing} and }the compaction fix (tintinweb/pi-subagents#145)"
  grep -q "getActiveScopeContext" "${pi_subagents_fork}/src/index.ts" 2>/dev/null || \
    pi_subagents_missing="${pi_subagents_missing:+${pi_subagents_missing} and }the nested Task context contract"
  grep -Eq "PROTOCOL_VERSION[[:space:]]*=[[:space:]]*3" "${pi_subagents_fork}/src/cross-extension-rpc.ts" 2>/dev/null || \
    pi_subagents_missing="${pi_subagents_missing:+${pi_subagents_missing} and }the owner-scoped RPC v3 contract"
  grep -q "manager.cancelScope(handle" "${pi_subagents_fork}/src/cross-extension-rpc.ts" 2>/dev/null || \
    pi_subagents_missing="${pi_subagents_missing:+${pi_subagents_missing} and }acknowledged recursive cancellation"
  if [ -n "${pi_subagents_missing}" ]; then
    pi_subagents_notify "loaded tree is missing ${pi_subagents_missing} — pi runs without it"
  else
    echo "install: pi-subagents contracts verified in the loaded tree (terminal status + compaction + nested Task context + scoped cancellation)"
  fi
else
  pi_subagents_notify "fork unavailable — pi keeps its current package source and may be missing required fixes or RPC contracts"
fi

# 3c. CodexBar CLI: install the latest signed upstream release directly into
#     ~/.local/bin. Keeper owns this install surface; remove Homebrew's GUI cask
#     only after the replacement CLI is downloaded and checksum-verified.
codexbar_cli_install() {
  local arch tag version asset release_url install_tmp expected_sha actual_sha cli_dir
  cli_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/keeper/codexbar"
  case "$(uname -m)" in
    arm64) arch="arm64" ;;
    x86_64) arch="x86_64" ;;
    *)
      echo "install: unsupported CodexBar CLI architecture: $(uname -m)" >&2
      return 1
      ;;
  esac

  tag="$(curl -fsSL --retry 3 -o /dev/null -w '%{url_effective}' \
    https://github.com/steipete/CodexBar/releases/latest)"
  tag="${tag##*/}"
  if [[ ! "${tag}" =~ ^v[0-9] ]]; then
    echo "install: could not resolve the latest CodexBar release tag" >&2
    return 1
  fi
  version="${tag#v}"
  asset="CodexBarCLI-v${version}-macos-${arch}.tar.gz"
  release_url="https://github.com/steipete/CodexBar/releases/download/${tag}"

  if [ -x "${cli_dir}/CodexBarCLI" ] \
    && [ "$(cat "${cli_dir}/VERSION" 2>/dev/null || true)" = "${version}" ]; then
    echo "install: CodexBar CLI ${version} already installed"
  else
    install_tmp="$(mktemp -d "${TMPDIR:-/tmp}/keeper-codexbar-cli.XXXXXX")"
    if ! (
      set -Eeuo pipefail
      trap 'rm -rf "${install_tmp}"' EXIT
      curl -fsSL --retry 3 -o "${install_tmp}/${asset}" "${release_url}/${asset}"
      curl -fsSL --retry 3 -o "${install_tmp}/${asset}.sha256" \
        "${release_url}/${asset}.sha256"
      expected_sha="$(awk 'NR == 1 { print $1 }' "${install_tmp}/${asset}.sha256")"
      actual_sha="$(shasum -a 256 "${install_tmp}/${asset}" | awk '{ print $1 }')"
      if [ -z "${expected_sha}" ] || [ "${actual_sha}" != "${expected_sha}" ]; then
        echo "install: CodexBar CLI checksum verification failed" >&2
        exit 1
      fi
      tar -xzf "${install_tmp}/${asset}" -C "${install_tmp}"
      mkdir -p "${HOME}/.local/bin" "${cli_dir}"
      install -m 755 "${install_tmp}/CodexBarCLI" "${cli_dir}/.CodexBarCLI.new"
      install -m 644 "${install_tmp}/VERSION" "${cli_dir}/.VERSION.new"
      mv -f "${cli_dir}/.CodexBarCLI.new" "${cli_dir}/CodexBarCLI"
      mv -f "${cli_dir}/.VERSION.new" "${cli_dir}/VERSION"
      ln -sfn "${cli_dir}/CodexBarCLI" "${HOME}/.local/bin/codexbar"
      rm -f "${HOME}/.local/bin/CodexBarCLI"
    ); then
      echo "install: CodexBar CLI release installation failed" >&2
      return 1
    fi
    echo "install: installed CodexBar CLI ${version} from upstream release"
  fi

  if command -v brew >/dev/null 2>&1 && brew list --cask codexbar >/dev/null 2>&1; then
    echo "install: removing Homebrew CodexBar cask; keeper owns the CLI"
    brew uninstall --cask --force codexbar >/dev/null
  fi
}
if ! codexbar_cli_install; then
  echo "install: CodexBar CLI step failed (non-fatal); continuing" >&2
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
