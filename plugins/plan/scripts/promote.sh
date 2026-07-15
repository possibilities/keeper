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

# Render the plugin templates and delegate the per-cell work cohort to the
# Claude prompt compiler so the WORKERS_RENDERED-gated guards in
# consistency-generated-guard.test.ts see them on disk. Those guards hold
# host-blind structural invariants on the rendered tree — every cell name parses
# as <model>-<canonical-effort>, and no non-cell `work`-named plugin shadows the
# cells. The exact {model × effort} roster a matrix must render is pinned
# separately and hermetically by the prompt suite's parity.test.ts (which renders
# the plan plugin in-process against fixture matrices); a plan test can't read the
# live host matrix, so it validates well-formedness, not the roster. Without this
# render the plan guards silently skip. A `git status` diff here would be dead:
# every rendered output (workers/, agents/practice-scout.md) is gitignored and so
# invisible to porcelain, and the hand-authored agents/ files are never rendered.
echo "promote: rendering plugin templates and compiling work cells for the cell-set guard"
( cd "${keeper_root}" && bun cli/prompt.ts render-plugin-templates --project-root "${keeper_root}" )

# The front door is silent on an already-current tree, so verify compiler
# ownership directly: publication requires its managed manifest, at least one
# cell, and a drift-free compiler check against the same host matrix.
plan_workers="${keeper_root}/plugins/plan/workers"
compiler_manifest="${plan_workers}/.keeper-prompt-claude.json"
cell_count="$(find "${plan_workers}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ ! -f "${compiler_manifest}" ] || [ "${cell_count}" -eq 0 ]; then
  echo "promote: ABORT — delegated compiler publication is incomplete under ${plan_workers}" >&2
  echo "  expected ${compiler_manifest} and at least one work cell" >&2
  exit 1
fi
if ! ( cd "${keeper_root}" && bun cli/prompt.ts compile --bundle plan:work --target claude --project-root "${keeper_root}" --check >/dev/null ); then
  echo "promote: ABORT — delegated Claude worker publication failed compiler verification" >&2
  exit 1
fi
echo "promote: compiler-verified the plan plugin — ${cell_count} work cell(s) under plugins/plan/workers/"

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
