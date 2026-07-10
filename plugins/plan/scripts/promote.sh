#!/usr/bin/env bash
# Promote the compiled bun binary to ~/.local/bin/keeper-plan.
#
# Build is a hard prerequisite in this same invocation. The binary is copied to
# a temp file in the DESTINATION directory (same filesystem => the rename is
# atomic), then mv -f replaces the keeper-plan path entry. The path entry is a
# symlink into the uv tool dir; mv replaces the symlink itself and never follows
# it, so mid-exec Python processes keep their inode. Any step failing aborts
# non-zero and leaves the live binary untouched.
set -euo pipefail

# --skip-slow is the emergency bypass for the real-git slow-tier gate below.
# Routine promotions must run the gate; skipping it ships an unverified binary.
skip_slow=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-slow) skip_slow=1; shift ;;
    *) echo "promote: unknown argument: $1" >&2; exit 2 ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="${repo_root}/dist/keeper-plan-bun"
dest_dir="${HOME}/.local/bin"
dest="${dest_dir}/keeper-plan"
tmp="${dest_dir}/.keeper-plan.tmp"

cleanup() { rm -f "${tmp}"; }
trap cleanup EXIT

echo "promote: building dist/keeper-plan-bun (hard prerequisite)"
( cd "${repo_root}" && bun run build )

[ -x "${binary}" ] || { echo "promote: build produced no executable at ${binary}" >&2; exit 1; }

keeper_root="$(cd "${repo_root}/../.." && pwd)"

# Render the per-cell work plugins so the slow-tier cell-set guard below sees
# them on disk. `bun run test:slow` runs consistency-generated-guard.test.ts,
# whose WORKERS_RENDERED-gated tests pin the workers/ cell set against the
# required host matrix in BOTH directions (missing cell fails, stale cell
# fails) — the real render↔config drift check; without this render they
# silently skip. A `git status` diff here would be dead: every rendered output
# (workers/, agents/practice-scout.md) is gitignored and so invisible to
# porcelain, and the hand-authored agents/ files are never rendered.
echo "promote: rendering per-cell work plugins for the slow-tier cell-set guard"
( cd "${keeper_root}" && bun cli/prompt.ts render-plugin-templates --project-root "${keeper_root}" )

# Report >0 plugins rendered. The render step is a SILENT no-op on an
# already-rendered tree (only changed files print `✓ Rendered`), so counting
# stdout lines is unreliable — verify the plan plugin's per-cell tree exists on
# disk instead. A zero here means discoverPluginDirs failed to find the plan
# plugin under the keeper-root --project-root (the `plugins/*` scan branch).
plan_workers="${keeper_root}/plugins/plan/workers"
cell_count="$(find "${plan_workers}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "${cell_count}" -eq 0 ]; then
  echo "promote: ABORT — render produced no plan-plugin work cells under ${plan_workers}" >&2
  echo "  discoverPluginDirs must scan plugins/* so a keeper-root --project-root finds the plan plugin" >&2
  exit 1
fi
echo "promote: rendered the plan plugin — ${cell_count} work cell(s) under plugins/plan/workers/"

# Real-git slow-tier gate. The fast `bun test` suite is pure (no real git), so a
# git-effect regression passes every commit gate; this is the routine surface
# that runs the KEEPER_PLAN_RUN_SLOW real-git blocks and blocks promotion on any
# failure (set -e). --skip-slow is the emergency hatch, never a routine path.
if [ "${skip_slow}" -eq 1 ]; then
  echo "promote: ############################################################" >&2
  echo "promote: ## WARNING — real-git slow-tier gate BYPASSED (--skip-slow) ##" >&2
  echo "promote: ## git-effect regressions are UNVERIFIED for this promote  ##" >&2
  echo "promote: ############################################################" >&2
else
  echo "promote: slow-tier gate — real-git effect suite (KEEPER_PLAN_RUN_SLOW)"
  ( cd "${repo_root}" && bun run test:slow )
fi

mkdir -p "${dest_dir}"

# Copy into the destination dir so the rename is same-filesystem atomic.
cp "${binary}" "${tmp}"
chmod +x "${tmp}"

# Atomic replace. -f so a pre-existing symlink/file at the path is overwritten
# in place; mv operates on the path entry itself and never resolves the symlink.
mv -f "${tmp}" "${dest}"

head="$(cd "${repo_root}" && git rev-parse HEAD)"
echo "promote: ~/.local/bin/keeper-plan now the bun binary at ${head}"
echo "promote: run 'hash -r' (bash) or 'rehash' (zsh) in long-lived shells to drop PATH cache"
