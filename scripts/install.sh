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

# 3b. Verify the repository-owned Pi Codex companion before any live checkout
#     maintenance. It remains an explicit keeper-launch `-e` source and is never
#     added to Pi's global package list, so standalone Pi stays native.
echo "install: verify Pi Codex pool companion"
PI_CODEX_POOL_ROOT="${repo_root}/integrations/pi-codex-pool" bun -e '
  const { readFileSync } = require("node:fs");
  const { join } = require("node:path");
  const root = process.env.PI_CODEX_POOL_ROOT;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const source = readFileSync(join(root, "src", "index.ts"), "utf8");
  const exact = manifest.name === "@earendil-works/keeper-pi-codex-pool"
    && manifest.version === "0.1.0"
    && manifest.private === true
    && JSON.stringify(manifest.pi?.extensions) === JSON.stringify(["./src/index.ts"])
    && typeof manifest.peerDependencies?.["@earendil-works/pi-ai"] === "string"
    && typeof manifest.peerDependencies?.["@earendil-works/pi-coding-agent"] === "string"
    && source.includes("openAICodexResponsesApi")
    && source.includes("KEEPER_PI_CODEX_POOL_MODE")
    && source.includes("KEEPER_PI_CODEX_POOL_INITIAL_ALIAS");
  if (!exact) throw new Error("Pi Codex pool companion manifest/source contract is incompatible");
'
if command -v pi >/dev/null 2>&1; then
  pi_real="$(realpath "$(command -v pi)")"
  pi_root="$(dirname "$(dirname "${pi_real}")")"
  pi_loader="${pi_root}/dist/core/extensions/loader.js"
  pi_compat="${pi_root}/node_modules/@earendil-works/pi-ai/dist/compat.js"
  if grep -q '"@earendil-works/pi-ai": _bundledPiAiCompat' "${pi_loader}" 2>/dev/null \
    && grep -q 'openAICodexResponsesApi' "${pi_compat}" 2>/dev/null; then
    echo "install: Pi Codex provider compatibility verified"
  else
    echo "install: Pi Codex provider compatibility unavailable; Keeper launches use visible native fallback" >&2
  fi
else
  echo "install: Pi unavailable; Codex companion provisioned but not runtime-verified" >&2
fi

# 3b2. Put `keeper-pi-codex-observe` on PATH so a Keeper-marked environment's
#      CodexAccountObserver spawn (`resolveCodexObserverCommand` in
#      src/account-routing-config.ts) can find it — the same `bun link`
#      mechanism step 2 uses for the `keeper` CLI itself, run against the
#      pi-codex-pool package's own `bin` declaration. Idempotent — skip when
#      the link exists. A durable KEEPER_PI_CODEX_OBSERVER_BIN override means
#      the operator already resolved this some other way; leave it alone.
if [ -n "${KEEPER_PI_CODEX_OBSERVER_BIN:-}" ]; then
  echo "install: KEEPER_PI_CODEX_OBSERVER_BIN override set (${KEEPER_PI_CODEX_OBSERVER_BIN}); skipping observer link"
elif [ -L "${HOME}/.bun/bin/keeper-pi-codex-observe" ]; then
  echo "install: keeper-pi-codex-observe already linked (${HOME}/.bun/bin/keeper-pi-codex-observe)"
else
  echo "install: bun link (pi-codex-pool observer)"
  ( cd "${repo_root}/integrations/pi-codex-pool" && bun link )
fi

# 3c. pi-subagents fork: ensure installed, then sync against upstream. pi loads
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
# Fork master is the live integration lineage. Upstream proposal branches stay
# in separate worktrees and are never checked out here.
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
  grep -q "modelRegistry: ctx.modelRegistry" "${pi_subagents_fork}/src/agent-runner.ts" 2>/dev/null || \
    pi_subagents_missing="${pi_subagents_missing:+${pi_subagents_missing} and }the inherited model registry contract"
  grep -q "modelRuntime: parentModelRuntime" "${pi_subagents_fork}/src/agent-runner.ts" 2>/dev/null || \
    pi_subagents_missing="${pi_subagents_missing:+${pi_subagents_missing} and }the inherited provider runtime contract"
  if [ -n "${pi_subagents_missing}" ]; then
    pi_subagents_notify "loaded tree is missing ${pi_subagents_missing} — pi runs without it"
  else
    echo "install: pi-subagents contracts verified in the live integration tree (terminal status + compaction + nested Task context + scoped cancellation + provider runtime inheritance)"
  fi
else
  pi_subagents_notify "fork unavailable — pi keeps its current package source and may be missing required fixes or RPC contracts"
fi

# 3d. Remove only the retired CodexBar CLI footprint carrying Keeper's exact
#     ownership proof. Never touch an app bundle, Homebrew cask, foreign symlink,
#     non-symlink executable, or unproven data directory.
retire_keeper_codexbar_cli() {
  local root link target owned provenance
  root="${XDG_DATA_HOME:-${HOME}/.local/share}/keeper/codexbar"
  link="${HOME}/.local/bin/codexbar"
  target=""
  owned=0

  if [ -d "${root}" ] && [ ! -L "${root}" ]; then
    for provenance in \
      "${root}/PROVENANCE" \
      "${root}/current/PROVENANCE" \
      "${root}"/generation.*/PROVENANCE; do
      [ -f "${provenance}" ] || continue
      if grep -qx 'signing_identifier=com.arthack.keeper.codexbar-cli' "${provenance}"; then
        owned=1
        break
      fi
    done
  fi

  if [ -L "${link}" ]; then
    target="$(readlink "${link}" 2>/dev/null || true)"
    case "${target}" in
      "${root}/current/CodexBarCLI" | "${root}/CodexBarCLI")
        if rm -f "${link}"; then
          echo "install: removed retired Keeper CodexBar CLI link"
        else
          echo "install: could not remove retired Keeper CodexBar CLI link (non-fatal)" >&2
        fi
        ;;
      *)
        echo "install: preserving foreign codexbar symlink: ${link}" >&2
        ;;
    esac
  elif [ -e "${link}" ]; then
    echo "install: preserving non-symlink codexbar executable: ${link}" >&2
  fi

  if [ "${owned}" -eq 1 ]; then
    if chmod -R u+w "${root}" 2>/dev/null && rm -rf "${root}"; then
      echo "install: removed retired Keeper CodexBar CLI data"
    else
      echo "install: could not remove retired Keeper CodexBar CLI data (non-fatal)" >&2
    fi
  elif [ -e "${root}" ] || [ -L "${root}" ]; then
    echo "install: preserving unproven codexbar data directory: ${root}" >&2
  fi
  return 0
}
retire_keeper_codexbar_cli
unset -f retire_keeper_codexbar_cli

# 3e. claude-swap CLI: install or update the stable PyPI package through uv.
#     Claude launches require a working cswap account. A missing uv or failed
#     transaction leaves any existing install untouched and keeps non-Claude
#     Keeper setup available.
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

# 3f. ripgrep: install or update the stable Homebrew formula on every run.
#     Search tooling remains non-critical: a missing Homebrew or failed formula
#     transaction leaves any existing rg installation available.
if ! command -v brew >/dev/null 2>&1; then
  echo "install: Homebrew unavailable; leaving ripgrep unchanged (non-fatal)" >&2
elif brew list --formula ripgrep >/dev/null 2>&1; then
  echo "install: update ripgrep"
  if brew upgrade ripgrep; then
    echo "install: ripgrep updated"
  else
    echo "install: ripgrep update failed; leaving existing installation unchanged (non-fatal)" >&2
  fi
else
  echo "install: install ripgrep"
  if brew install ripgrep; then
    echo "install: ripgrep installed"
  else
    echo "install: ripgrep install failed (non-fatal)" >&2
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
  # Attribution leaf: record that THIS install is about to bounce keeperd, so
  # restart-ledger forensics can attribute the daemon end it causes — an
  # external launchctl bootout is otherwise invisible to keeper and reads as an
  # unattributed quiet death.
  printf '{"schema_version":1,"source":"install.sh","action":"launchctl-reload","ts_ms":%s,"fingerprint":"%s"}\n' \
    "$(($(date +%s) * 1000))" "${current_fp}" \
    > "${fingerprint_dir}/install-reload-attribution.json" || true
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
