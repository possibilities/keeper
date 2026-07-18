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

# 3. Render the plan plugin's generated files (skills/work and static agents),
#    delegating the per-cell work cohort once to the Claude prompt compiler, so a
#    fresh clone can spawn work:worker and the plan consistency suites run instead
#    of skipping. Every rendered output + sidecar is gitignored, so this regenerates
#    them locally on each install — the compatibility front-door command lives in
#    the repo, recoverable, not in shell history. The prompt engine
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
  # for the same package so pi never double-loads it). JavaScript reads its
  # values from the environment; shell expansion inside the program is unsafe.
  # shellcheck disable=SC2016
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

# 3c. CodexBar CLI: build the possibilities feature branch in disposable source
#     state after rebasing its immutable tip onto immutable upstream/main. Keeper
#     never installs the app bundle or mutates a developer checkout. A failed
#     fetch, rebase, build, or publication preserves the previously managed CLI,
#     notifies the human, and remains non-fatal to the Keeper install.
codexbar_fork_url="https://github.com/possibilities/CodexBar.git"
codexbar_fork_ref="feature/claude-swap-single-account-option"
codexbar_upstream_url="https://github.com/steipete/CodexBar.git"
codexbar_upstream_ref="main"
codexbar_cli_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/keeper/codexbar"
codexbar_cli_current="${codexbar_cli_dir}/current"
codexbar_cli_bin="${codexbar_cli_current}/CodexBarCLI"
codexbar_provenance="${codexbar_cli_current}/PROVENANCE"
codexbar_legacy_cli_bin="${codexbar_cli_dir}/CodexBarCLI"
codexbar_legacy_provenance="${codexbar_cli_dir}/PROVENANCE"
codexbar_cli_link="${HOME}/.local/bin/codexbar"
codexbar_cli_link_target="${codexbar_cli_dir}/current/CodexBarCLI"
codexbar_signing_identity="B1AD266E854C4E845AA7EC456955D881AE9D5F47"
codexbar_signing_identifier="com.arthack.keeper.codexbar-cli"
codexbar_signing_requirement='identifier "com.arthack.keeper.codexbar-cli" and certificate leaf = H"b1ad266e854c4e845aa7ec456955d881ae9d5f47"'
codexbar_source_state=""

codexbar_notify() {
  echo "install: CodexBar CLI: $1" >&2
  if command -v notifyctl >/dev/null 2>&1; then
    notifyctl show-message -t "Keeper CodexBar CLI" -m "$1" >/dev/null 2>&1 || true
  fi
}

codexbar_prepare_source_env() {
  local source_state
  source_state="$1"
  [ -n "${source_state}" ] || return 1
  mkdir -p \
    "${source_state}/home" \
    "${source_state}/cache" \
    "${source_state}/cache/clang-module-cache" \
    "${source_state}/cache/swiftpm-module-cache" \
    "${source_state}/config" \
    "${source_state}/swiftpm-cache" || return 1
}

# Public fetches and the ephemeral rebase must never consult a terminal, editor,
# signing agent, ambient credential, or repository hook. All git mutation stays
# below mktemp state, with HOME/config/cache sealed to this source run.
codexbar_git() {
  [ -n "${codexbar_source_state}" ] || return 1
  codexbar_prepare_source_env "${codexbar_source_state}" || return 1
  env -i \
    PATH="${PATH}" \
    HOME="${codexbar_source_state}/home" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LC_ALL=C \
    LANG=C \
    XDG_CACHE_HOME="${codexbar_source_state}/cache" \
    XDG_CONFIG_HOME="${codexbar_source_state}/config" \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/usr/bin/false \
    SSH_ASKPASS=/usr/bin/false \
    GIT_EDITOR=: \
    GIT_SEQUENCE_EDITOR=: \
    EDITOR=: \
    VISUAL=: \
    HUSKY=0 \
    git \
      -c core.askPass=/usr/bin/false \
      -c core.hooksPath=/dev/null \
      -c credential.interactive=never \
      -c commit.gpgSign=false \
      -c tag.gpgSign=false \
      -c rebase.autoStash=false \
      -c user.name="Keeper CodexBar installer" \
      -c user.email="keeper-codexbar@localhost" \
      "$@"
}

# A hard crash can strand unpublished staging, an unrenamed current symlink, or
# a stable-link temp. Complete generations remain available for retention cleanup
# after a later publication.
codexbar_cleanup_staging() {
  local residue
  mkdir -p "${codexbar_cli_dir}" || return 1
  for residue in \
    "${codexbar_cli_dir}"/.staging.* \
    "${codexbar_cli_dir}"/.current.* \
    "${HOME}/.local/bin"/.codexbar-link.*; do
    if [ -L "${residue}" ] || [ -f "${residue}" ]; then
      rm -f "${residue}" || return 1
    elif [ -d "${residue}" ]; then
      chmod -R u+w "${residue}" 2>/dev/null || true
      rm -rf "${residue}" || return 1
    fi
  done
}

# If a valid managed generation already exists, repair the stable executable
# link before any network/build work. Never replace a user-owned non-symlink.
codexbar_prepare_stable_link() {
  local link_tmp
  link_tmp=""
  [ -L "${codexbar_cli_current}" ] || return 2
  [ -x "${codexbar_cli_bin}" ] || return 2
  mkdir -p "${HOME}/.local/bin" || return 1
  if [ -e "${codexbar_cli_link}" ] && [ ! -L "${codexbar_cli_link}" ]; then
    echo "install: ${codexbar_cli_link} is not a symlink; refusing replacement" >&2
    return 1
  fi
  if [ -L "${codexbar_cli_link}" ] \
    && [ "$(readlink "${codexbar_cli_link}" 2>/dev/null || true)" = "${codexbar_cli_link_target}" ]; then
    return 0
  fi
  link_tmp="$(mktemp "${HOME}/.local/bin/.codexbar-link.XXXXXX")" || return 1
  rm -f "${link_tmp}" || return 1
  if ! ln -s "${codexbar_cli_link_target}" "${link_tmp}"; then
    rm -f "${link_tmp}" || true
    return 1
  fi
  if ! mv -f -h "${link_tmp}" "${codexbar_cli_link}"; then
    rm -f "${link_tmp}" || true
    return 1
  fi
}

# Before the first generation publication, restore a missing stable link to the
# direct-layout executable. Fetch, build, and staging failures then leave that
# existing install usable; successful publication repoints the link via current.
codexbar_prepare_legacy_fallback() {
  [ ! -L "${codexbar_cli_current}" ] || [ ! -x "${codexbar_cli_bin}" ] || return 0
  [ -x "${codexbar_legacy_cli_bin}" ] || return 0
  if [ ! -f "${codexbar_legacy_provenance}" ]; then
    echo "install: preserving direct CodexBar CLI fallback without provenance" >&2
  fi
  if [ ! -e "${codexbar_cli_link}" ] && [ ! -L "${codexbar_cli_link}" ]; then
    mkdir -p "${HOME}/.local/bin" || return 1
    ln -s "${codexbar_legacy_cli_bin}" "${codexbar_cli_link}" || return 1
  fi
}

codexbar_prepare_startup_link() {
  local status
  if codexbar_prepare_stable_link; then
    return 0
  else
    status=$?
  fi
  case "${status}" in
    2) codexbar_prepare_legacy_fallback ;;
    *) return 1 ;;
  esac
}

codexbar_provenance_value() {
  local key
  key="$1"
  [ -f "${codexbar_provenance}" ] || return 1
  awk -F= -v key="${key}" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' \
    "${codexbar_provenance}"
}

# Validate the installed artifact independently of mutable source refs. A local
# certificate stabilizes its trusted-application requirement, while the binary
# digest lets Keeper detect an automatic update that needs fresh authorization.
codexbar_signed_generation_valid() {
  local expected_binary_sha actual_binary_sha architecture
  local signing_identity signing_identifier signing_requirement
  [ -L "${codexbar_cli_current}" ] || return 1
  [ -x "${codexbar_cli_bin}" ] || return 1
  [ -L "${codexbar_cli_link}" ] || return 1
  [ "$(readlink "${codexbar_cli_link}" 2>/dev/null || true)" = "${codexbar_cli_link_target}" ] || return 1
  architecture="$(codexbar_provenance_value architecture 2>/dev/null || true)"
  signing_identity="$(codexbar_provenance_value signing_identity 2>/dev/null || true)"
  signing_identifier="$(codexbar_provenance_value signing_identifier 2>/dev/null || true)"
  signing_requirement="$(codexbar_provenance_value signing_requirement 2>/dev/null || true)"
  expected_binary_sha="$(codexbar_provenance_value binary_sha256 2>/dev/null || true)"
  [ "${architecture}" = "$(uname -m)" ] || return 1
  [ "${signing_identity}" = "${codexbar_signing_identity}" ] || return 1
  [ "${signing_identifier}" = "${codexbar_signing_identifier}" ] || return 1
  [ "${signing_requirement}" = "${codexbar_signing_requirement}" ] || return 1
  [[ "${expected_binary_sha}" =~ ^[0-9a-f]{64}$ ]] || return 1
  codesign --verify --strict \
    --test-requirement "=${codexbar_signing_requirement}" \
    "${codexbar_cli_bin}" >/dev/null 2>&1 || return 1
  actual_binary_sha="$(shasum -a 256 "${codexbar_cli_bin}" 2>/dev/null \
    | awk 'NR == 1 { print $1 }')"
  [ "${actual_binary_sha}" = "${expected_binary_sha}" ]
}

# A resolved fork/upstream pair has a deterministic prior outcome. Trust a
# complete managed record for that exact pair and mode only after validating the
# published signed generation. Every install checks the authorities; unchanged
# inputs remain an idempotent no-op.
codexbar_provenance_matches() {
  local fork_sha upstream_sha mode built_sha built_tree_sha swift_version
  fork_sha="$1"
  upstream_sha="$2"
  mode="$3"
  codexbar_signed_generation_valid || return 1
  [ "$(codexbar_provenance_value fork_url 2>/dev/null || true)" = "${codexbar_fork_url}" ] || return 1
  [ "$(codexbar_provenance_value fork_ref 2>/dev/null || true)" = "${codexbar_fork_ref}" ] || return 1
  [ "$(codexbar_provenance_value fork_sha 2>/dev/null || true)" = "${fork_sha}" ] || return 1
  [ "$(codexbar_provenance_value upstream_url 2>/dev/null || true)" = "${codexbar_upstream_url}" ] || return 1
  [ "$(codexbar_provenance_value upstream_ref 2>/dev/null || true)" = "${codexbar_upstream_ref}" ] || return 1
  [ "$(codexbar_provenance_value upstream_sha 2>/dev/null || true)" = "${upstream_sha}" ] || return 1
  [ "$(codexbar_provenance_value mode 2>/dev/null || true)" = "${mode}" ] || return 1
  built_sha="$(codexbar_provenance_value built_sha 2>/dev/null || true)"
  built_tree_sha="$(codexbar_provenance_value built_tree_sha 2>/dev/null || true)"
  swift_version="$(codexbar_provenance_value swift_toolchain_version 2>/dev/null || true)"
  [[ "${built_sha}" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "${built_tree_sha}" =~ ^[0-9a-f]{40}$ ]] || return 1
  [ -n "${swift_version}" ]
}

# Remove every trace of a failed rebase worktree before retaining the current
# generation. The enclosing repository is itself temporary.
codexbar_discard_worktree() {
  local repository worktree
  repository="$1"
  worktree="$2"
  if [ -d "${worktree}" ]; then
    codexbar_git -C "${worktree}" rebase --abort >/dev/null 2>&1 || true
  fi
  if ! codexbar_git -C "${repository}" worktree remove --force "${worktree}" \
    >/dev/null 2>&1; then
    rm -rf "${worktree}"
  fi
  codexbar_git -C "${repository}" worktree prune --expire now >/dev/null 2>&1 || true
  [ ! -e "${worktree}" ] || rm -rf "${worktree}"
}

codexbar_add_fork_worktree() {
  local repository worktree fork_sha
  repository="$1"
  worktree="$2"
  fork_sha="$3"
  codexbar_git -C "${repository}" worktree add --quiet --detach \
    "${worktree}" "${fork_sha}" \
    && codexbar_git -C "${worktree}" reset --hard "${fork_sha}" >/dev/null \
    && codexbar_git -C "${worktree}" clean -ffdx >/dev/null
}

# SwiftPM inherits this sealed process environment for every descendant Git
# fetch. Its HOME, config, and caches all die with the disposable source state;
# public HTTPS dependencies remain available without ambient credentials.
codexbar_swift_env() {
  local source_state
  source_state="$1"
  shift
  codexbar_prepare_source_env "${source_state}" || return 1
  env -i \
    PATH="${PATH}" \
    HOME="${source_state}/home" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LC_ALL=C \
    LANG=C \
    XDG_CACHE_HOME="${source_state}/cache" \
    XDG_CONFIG_HOME="${source_state}/config" \
    CLANG_MODULE_CACHE_PATH="${source_state}/cache/clang-module-cache" \
    SWIFTPM_MODULECACHE_OVERRIDE="${source_state}/cache/swiftpm-module-cache" \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_COUNT=6 \
    GIT_CONFIG_KEY_0=core.askPass \
    GIT_CONFIG_VALUE_0=/usr/bin/false \
    GIT_CONFIG_KEY_1=core.hooksPath \
    GIT_CONFIG_VALUE_1=/dev/null \
    GIT_CONFIG_KEY_2=credential.interactive \
    GIT_CONFIG_VALUE_2=never \
    GIT_CONFIG_KEY_3=commit.gpgSign \
    GIT_CONFIG_VALUE_3=false \
    GIT_CONFIG_KEY_4=tag.gpgSign \
    GIT_CONFIG_VALUE_4=false \
    GIT_CONFIG_KEY_5=rebase.autoStash \
    GIT_CONFIG_VALUE_5=false \
    GIT_TERMINAL_PROMPT=0 \
    GIT_ASKPASS=/usr/bin/false \
    SSH_ASKPASS=/usr/bin/false \
    GIT_EDITOR=: \
    GIT_SEQUENCE_EDITOR=: \
    EDITOR=: \
    VISUAL=: \
    HUSKY=0 \
    "$@"
}

codexbar_build_cli() {
  local source source_state
  source="$1"
  source_state="$2"
  codexbar_build_tree_sha=""
  codexbar_build_architecture=""
  codexbar_build_swift_version=""

  codexbar_prepare_source_env "${source_state}" || return 1
  codexbar_build_tree_sha="$(codexbar_git -C "${source}" rev-parse \
    'HEAD^{tree}' 2>/dev/null || true)"
  [[ "${codexbar_build_tree_sha}" =~ ^[0-9a-f]{40}$ ]] || return 1
  codexbar_build_architecture="$(uname -m)"
  case "${codexbar_build_architecture}" in
    arm64 | x86_64) ;;
    *) return 1 ;;
  esac
  if ! codexbar_build_swift_version="$(
    codexbar_swift_env "${source_state}" swift --version 2>&1 \
      | LC_ALL=C tr '\r\n\t' '   ' \
      | LC_ALL=C tr -cd '[:print:]' \
      | awk '{$1=$1; print}'
  )"; then
    return 1
  fi
  [ -n "${codexbar_build_swift_version}" ] || return 1

  ( cd "${source}" \
    && codexbar_swift_env "${source_state}" swift build \
      -c release \
      --product CodexBarCLI \
      --cache-path "${source_state}/swiftpm-cache" ) \
    && [ -x "${source}/.build/release/CodexBarCLI" ]
}

# Retain the generation just replaced as rollback evidence. Older complete or
# orphaned generations are removed only after a later generation is live.
codexbar_prune_generations() {
  local current_name previous_name generation generation_name
  current_name="$1"
  previous_name="$2"
  for generation in "${codexbar_cli_dir}"/generation.*; do
    [ -d "${generation}" ] || continue
    generation_name="${generation##*/}"
    if [ "${generation_name}" = "${current_name}" ] \
      || [ "${generation_name}" = "${previous_name}" ]; then
      continue
    fi
    chmod -R u+w "${generation}" 2>/dev/null || true
    rm -rf "${generation}" || return 1
  done
}

# CodexBarCLI and PROVENANCE become visible together through one atomic current
# symlink swap. Until that swap, all writes are confined to a new generation and
# any direct-layout install remains the active migration fallback.
codexbar_atomic_install() (
  set -Eeuo pipefail
  local built_binary fork_sha upstream_sha mode built_sha built_tree_sha
  local architecture swift_version binary_sha generation generation_name
  local install_stage current_tmp current_rollback link_tmp previous_generation previous_name
  built_binary="$1"
  fork_sha="$2"
  upstream_sha="$3"
  mode="$4"
  built_sha="$5"
  built_tree_sha="$6"
  architecture="$7"
  swift_version="$8"
  install_stage=""
  current_tmp=""
  current_rollback=""
  link_tmp=""
  generation=""
  generation_name=""
  previous_generation=""
  previous_name=""

  # Invoked indirectly by the EXIT trap below.
  # shellcheck disable=SC2329
  codexbar_atomic_cleanup() {
    local status
    status="$1"
    trap - EXIT
    [ -z "${current_tmp}" ] || rm -f "${current_tmp}"
    [ -z "${current_rollback}" ] || rm -f "${current_rollback}"
    [ -z "${link_tmp}" ] || rm -f "${link_tmp}"
    if [ -n "${install_stage}" ] && [ -e "${install_stage}" ]; then
      chmod -R u+w "${install_stage}" 2>/dev/null || true
      rm -rf "${install_stage}"
    fi
    exit "${status}"
  }
  trap 'codexbar_atomic_cleanup "$?"' EXIT

  mkdir -p "${codexbar_cli_dir}" "${HOME}/.local/bin" || exit 1
  if [ -e "${codexbar_cli_current}" ] && [ ! -L "${codexbar_cli_current}" ]; then
    echo "install: ${codexbar_cli_current} is not a symlink; refusing replacement" >&2
    exit 1
  fi
  if [ -e "${codexbar_cli_link}" ] && [ ! -L "${codexbar_cli_link}" ]; then
    echo "install: ${codexbar_cli_link} is not a symlink; refusing replacement" >&2
    exit 1
  fi
  if ! install_stage="$(mktemp -d "${codexbar_cli_dir}/.staging.XXXXXX")"; then
    exit 1
  fi

  install -m 755 "${built_binary}" "${install_stage}/CodexBarCLI" || exit 1
  codesign --force \
    --sign "${codexbar_signing_identity}" \
    --identifier "${codexbar_signing_identifier}" \
    --requirements "=designated => ${codexbar_signing_requirement}" \
    "${install_stage}/CodexBarCLI" >/dev/null || exit 1
  codesign --verify --strict \
    --test-requirement "=${codexbar_signing_requirement}" \
    "${install_stage}/CodexBarCLI" >/dev/null 2>&1 || exit 1
  binary_sha="$(shasum -a 256 "${install_stage}/CodexBarCLI" \
    | awk 'NR == 1 { print $1 }')"
  [[ "${binary_sha}" =~ ^[0-9a-f]{64}$ ]] || exit 1
  printf '%s\n' \
    "fork_url=${codexbar_fork_url}" \
    "fork_ref=${codexbar_fork_ref}" \
    "fork_sha=${fork_sha}" \
    "upstream_url=${codexbar_upstream_url}" \
    "upstream_ref=${codexbar_upstream_ref}" \
    "upstream_sha=${upstream_sha}" \
    "mode=${mode}" \
    "built_sha=${built_sha}" \
    "built_tree_sha=${built_tree_sha}" \
    "binary_sha256=${binary_sha}" \
    "architecture=${architecture}" \
    "swift_toolchain_version=${swift_version}" \
    "signing_identity=${codexbar_signing_identity}" \
    "signing_identifier=${codexbar_signing_identifier}" \
    "signing_requirement=${codexbar_signing_requirement}" \
    >"${install_stage}/PROVENANCE" || exit 1
  chmod 555 "${install_stage}/CodexBarCLI" || exit 1
  chmod 444 "${install_stage}/PROVENANCE" || exit 1
  chmod 555 "${install_stage}" || exit 1

  generation_name="generation.${binary_sha}.${install_stage##*.staging.}"
  generation="${codexbar_cli_dir}/${generation_name}"
  [ ! -e "${generation}" ] || exit 1
  if [ -L "${codexbar_cli_current}" ]; then
    previous_generation="$(readlink "${codexbar_cli_current}" 2>/dev/null || true)"
    case "${previous_generation}" in
      generation.*) previous_name="${previous_generation}" ;;
    esac
  fi

  current_tmp="$(mktemp "${codexbar_cli_dir}/.current.XXXXXX")" || exit 1
  rm -f "${current_tmp}" || exit 1
  ln -s "${generation_name}" "${current_tmp}" || exit 1
  if [ ! -L "${codexbar_cli_link}" ] \
    || [ "$(readlink "${codexbar_cli_link}" 2>/dev/null || true)" != "${codexbar_cli_link_target}" ]; then
    link_tmp="$(mktemp "${HOME}/.local/bin/.codexbar-link.XXXXXX")" || exit 1
    rm -f "${link_tmp}" || exit 1
    ln -s "${codexbar_cli_link_target}" "${link_tmp}" || exit 1
  fi

  # The generation rename can strand only a complete, immutable orphan. The
  # current rename is the sole binary/provenance publication point.
  mv "${install_stage}" "${generation}" || exit 1
  install_stage=""
  mv -f -h "${current_tmp}" "${codexbar_cli_current}" || exit 1
  current_tmp=""
  if [ -n "${link_tmp}" ]; then
    if ! mv -f -h "${link_tmp}" "${codexbar_cli_link}"; then
      if [ -n "${previous_generation}" ]; then
        current_rollback="$(mktemp "${codexbar_cli_dir}/.current.XXXXXX")" || exit 1
        rm -f "${current_rollback}" || exit 1
        ln -s "${previous_generation}" "${current_rollback}" || exit 1
        mv -f -h "${current_rollback}" "${codexbar_cli_current}" || exit 1
        current_rollback=""
      else
        rm -f "${codexbar_cli_current}" || exit 1
      fi
      exit 1
    fi
    link_tmp=""
  fi

  codexbar_prune_generations "${generation_name}" "${previous_name}" \
    || echo "install: could not prune older CodexBar CLI generations (non-fatal)" >&2
  # Keep the old direct CodexBarCLI/PROVENANCE leaves as first-generation
  # migration fallback; they are never forward-facing after the stable link swap.
  rm -f "${codexbar_cli_dir}/VERSION" "${HOME}/.local/bin/CodexBarCLI" || true
)

codexbar_remove_cask() {
  if command -v brew >/dev/null 2>&1 \
    && brew list --cask codexbar >/dev/null 2>&1; then
    echo "install: removing Homebrew CodexBar cask; keeper owns the CLI"
    brew uninstall --cask --force codexbar >/dev/null 2>&1
  fi
}

codexbar_publish_build() {
  local source fork_sha upstream_sha mode built_sha cask_failed
  local authorization_note
  source="$1"
  fork_sha="$2"
  upstream_sha="$3"
  mode="$4"
  built_sha="$5"
  cask_failed=0
  authorization_note="run keeper agent accounts authorize-codexbar to authorize unattended Keychain-backed observation"

  if ! codexbar_atomic_install "${source}/.build/release/CodexBarCLI" \
    "${fork_sha}" \
    "${upstream_sha}" \
    "${mode}" \
    "${built_sha}" \
    "${codexbar_build_tree_sha}" \
    "${codexbar_build_architecture}" \
    "${codexbar_build_swift_version}"; then
    codexbar_notify "the rebased CLI built, but final staging/install failed; the previous binary was retained"
    return 1
  fi

  # The managed replacement and its provenance are durable before Homebrew may
  # remove the GUI cask. A cask cleanup error does not roll back the valid CLI.
  if ! codexbar_remove_cask; then
    cask_failed=1
  fi
  if [ "${cask_failed}" -ne 0 ]; then
    codexbar_notify "installed the rebased CLI, but Homebrew cask removal failed; ${authorization_note}"
  else
    codexbar_notify "installed the rebased CLI at ${built_sha:0:10}; ${authorization_note}"
  fi
  echo "install: installed CodexBar CLI (${mode}, ${built_sha:0:10})"
}

codexbar_cli_install() (
  set -Eeuo pipefail
  local source_state repository build_source
  local fork_sha upstream_sha built_sha failure_reason
  source_state=""
  repository=""
  build_source=""
  fork_sha=""
  upstream_sha="unavailable"
  built_sha=""
  failure_reason=""

  # This trap owns only disposable source state; generation staging has a
  # separate subshell-scoped trap in codexbar_atomic_install.
  trap '[ -z "${source_state}" ] || rm -rf "${source_state}"' EXIT
  if ! codexbar_cleanup_staging; then
    codexbar_notify "could not clean incomplete generation residue; the previous binary was retained"
    return 0
  fi
  if ! codexbar_prepare_startup_link; then
    codexbar_notify "could not repair the CodexBar CLI startup link; the previous binary was retained"
    return 0
  fi
  if ! source_state="$(mktemp -d "${TMPDIR:-/tmp}/keeper-codexbar-source.XXXXXX")"; then
    codexbar_notify "could not create disposable source state; the previous binary was retained"
    return 0
  fi
  codexbar_source_state="${source_state}"
  if ! codexbar_prepare_source_env "${source_state}"; then
    codexbar_notify "could not initialize disposable source state; the previous binary was retained"
    return 0
  fi
  repository="${source_state}/repository"

  if ! codexbar_git init --quiet "${repository}" \
    || ! codexbar_git -C "${repository}" fetch --quiet --no-tags \
      "${codexbar_fork_url}" \
      "+refs/heads/${codexbar_fork_ref}:refs/keeper/codexbar-fork"; then
    codexbar_notify "could not resolve possibilities/CodexBar ${codexbar_fork_ref}; the previous binary was retained"
    return 0
  fi
  fork_sha="$(codexbar_git -C "${repository}" rev-parse \
    'refs/keeper/codexbar-fork^{commit}' 2>/dev/null || true)"
  if [[ ! "${fork_sha}" =~ ^[0-9a-f]{40}$ ]]; then
    codexbar_notify "the fetched possibilities/CodexBar ref did not resolve to a commit; the previous binary was retained"
    return 0
  fi

  if codexbar_git -C "${repository}" fetch --quiet --no-tags \
      "${codexbar_upstream_url}" \
      "+refs/heads/${codexbar_upstream_ref}:refs/keeper/codexbar-upstream"; then
    upstream_sha="$(codexbar_git -C "${repository}" rev-parse \
      'refs/keeper/codexbar-upstream^{commit}' 2>/dev/null || true)"
    if [[ ! "${upstream_sha}" =~ ^[0-9a-f]{40}$ ]]; then
      upstream_sha="unavailable"
    fi
  fi

  # Only a successfully rebased resolved pair is latched. Upstream resolution
  # failures retain the current generation and are retried on the next install.
  if [ "${upstream_sha}" != "unavailable" ] \
    && codexbar_provenance_matches "${fork_sha}" "${upstream_sha}" rebased; then
    echo "install: CodexBar CLI inputs unchanged; no rebuild"
    codexbar_remove_cask \
      || echo "install: Homebrew CodexBar cask removal failed (non-fatal)" >&2
    return 0
  fi

  if [ "${upstream_sha}" = "unavailable" ]; then
    codexbar_notify "upstream CodexBar ${codexbar_upstream_ref} could not be resolved; the previous binary was retained"
    return 0
  fi

  build_source="${source_state}/rebased"
  if ! codexbar_add_fork_worktree "${repository}" "${build_source}" "${fork_sha}"; then
    codexbar_notify "the disposable rebased CodexBar source could not be prepared; the previous binary was retained"
    return 0
  fi
  if ! codexbar_git -C "${build_source}" rebase --rebase-merges \
    "${upstream_sha}" >/dev/null 2>&1; then
    failure_reason="the CodexBar fork could not rebase onto upstream ${upstream_sha:0:10}"
    if ! codexbar_discard_worktree "${repository}" "${build_source}"; then
      failure_reason="${failure_reason}; the failed source could not be discarded safely"
    fi
    codexbar_notify "${failure_reason}; the previous binary was retained"
    return 0
  fi

  built_sha="$(codexbar_git -C "${build_source}" rev-parse HEAD \
    2>/dev/null || true)"
  if [[ ! "${built_sha}" =~ ^[0-9a-f]{40}$ ]]; then
    codexbar_notify "the rebased CodexBar source did not resolve to a commit; the previous binary was retained"
    return 0
  fi
  if ! codexbar_build_cli "${build_source}" "${source_state}"; then
    codexbar_notify "the rebased CodexBar CLI build failed; the previous binary was retained"
    return 0
  fi
  codexbar_publish_build "${build_source}" "${fork_sha}" \
    "${upstream_sha}" rebased "${built_sha}" || true
)
if ! codexbar_cli_install; then
  codexbar_notify "unexpected installer error; the previous binary was retained"
  echo "install: CodexBar CLI step failed (non-fatal); continuing" >&2
fi

# 3d. claude-swap CLI: install or update the stable PyPI package through uv.
#     Account routing remains optional: a missing uv or failed transaction leaves
#     any existing cswap installation untouched and never blocks Keeper install.
if ! command -v uv >/dev/null 2>&1; then
  echo "install: uv unavailable; leaving claude-swap unchanged (non-fatal)" >&2
else
  echo "install: install or update claude-swap"
  if uv tool install --upgrade claude-swap; then
    echo "install: claude-swap installed"
  else
    echo "install: claude-swap install failed; leaving any existing installation unchanged (non-fatal)" >&2
  fi
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
