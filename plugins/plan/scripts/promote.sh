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

# Drift guard. The compiled binary resolves the worker matrix from an EMBEDDED
# snapshot of subagents.yaml; the template renderer reads that file off DISK. The
# two copies can only be trusted equal right after a rebuild + re-render, so gate
# promote on it: a config edit that skipped either fails LOUD here. This cannot
# live in `bun test` — an in-process test resolves the embed to the same on-disk
# file and never sees a stale compiled binary.
keeper_root="$(cd "${repo_root}/../.." && pwd)"
config="${repo_root}/subagents.yaml"

echo "promote: drift guard — embedded matrix must equal on-disk subagents.yaml"
while IFS= read -r axis_line; do
  case "${axis_line}" in
    efforts:* | models:* | subagents:*)
      grep -aqF -- "${axis_line}" "${binary}" && continue
      echo "promote: ABORT — freshly built binary does not embed on-disk config line:" >&2
      echo "  ${axis_line}" >&2
      echo "  rebuild (bun run build) after editing ${config}" >&2
      exit 1
      ;;
  esac
done < "${config}"

echo "promote: drift guard — rendered worker agents must match subagents.yaml"
( cd "${keeper_root}" && bun cli/prompt.ts render-plugin-templates --project-root "${keeper_root}" >/dev/null )
drift="$(cd "${keeper_root}" && git status --porcelain plugins/plan/agents)"
if [ -n "${drift}" ]; then
  echo "promote: ABORT — rendered plan worker agents diverge from subagents.yaml:" >&2
  echo "${drift}" >&2
  echo "  re-render (keeper prompt render-plugin-templates) and commit before promote" >&2
  exit 1
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
