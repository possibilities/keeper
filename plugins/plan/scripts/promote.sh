#!/usr/bin/env bash
# Promote the compiled bun binary to ~/.local/bin/planctl.
#
# Build is a hard prerequisite in this same invocation. The binary is copied to
# a temp file in the DESTINATION directory (same filesystem => the rename is
# atomic), then mv -f replaces the planctl path entry. The path entry is a
# symlink into the uv tool dir; mv replaces the symlink itself and never follows
# it, so mid-exec Python processes keep their inode. Any step failing aborts
# non-zero and leaves the live binary untouched.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
binary="${repo_root}/dist/keeper-plan-bun"
dest_dir="${HOME}/.local/bin"
dest="${dest_dir}/planctl"
tmp="${dest_dir}/.planctl.tmp"

cleanup() { rm -f "${tmp}"; }
trap cleanup EXIT

echo "promote: building dist/keeper-plan-bun (hard prerequisite)"
( cd "${repo_root}" && bun run build )

[ -x "${binary}" ] || { echo "promote: build produced no executable at ${binary}" >&2; exit 1; }

mkdir -p "${dest_dir}"

# Copy into the destination dir so the rename is same-filesystem atomic.
cp "${binary}" "${tmp}"
chmod +x "${tmp}"

# Atomic replace. -f so a pre-existing symlink/file at the path is overwritten
# in place; mv operates on the path entry itself and never resolves the symlink.
mv -f "${tmp}" "${dest}"

head="$(cd "${repo_root}" && git rev-parse HEAD)"
echo "promote: ~/.local/bin/planctl now the bun binary at ${head}"
echo "promote: run 'hash -r' (bash) or 'rehash' (zsh) in long-lived shells to drop PATH cache"
