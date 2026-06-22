#!/usr/bin/env bash
# Guard against clobbering a FROZEN "planctl" literal during the fn-889
# name-retirement sweep.
#
# Enforcement is PROGRESSIVE, not repo-wide-hard. While the code sweeps
# (.6/.7/.8) and the migration/docs tasks (.2/.3/.4/.5) still hold un-renamed
# references, this guard enforces ONLY the frozen surface enumerated in
# scripts/frozen-allowlist.txt:
#
#   * Check A (anti-clobber): every frozen literal `anchor` record must still
#     appear verbatim in its file. A sweep that renames a frozen literal (e.g.
#     `Planctl-Op:` -> `Plan-Op:` in the trailer emit, or a `planctl_*`
#     schema-history column in src/db.ts) drops the anchor -> FAIL.
#
#   * Check B (pure-frozen file lock): a `count` record pins the exact
#     case-insensitive "planctl" occurrence count of a file whose every token
#     is frozen (src/db.ts). A clobber (count drops) OR a planted retired-name
#     edit (count rises) -> FAIL.
#
# The repo-wide grep-clean (only the frozen allowlist remains) is the EPIC's
# final state after every task lands; this guard does NOT gate an individual
# sweep on it.
#
# Exit 0 = clean, 1 = a frozen literal was clobbered or a pure-frozen file
# drifted.
set -euo pipefail

# KEEPER_RETIRED_NAME_REPO_ROOT overrides the repo root for tests (point it at a
# fixture tree carrying its own scripts/frozen-allowlist.txt + source files);
# production resolves the real worktree root.
repo_root="${KEEPER_RETIRED_NAME_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
allowlist="${repo_root}/scripts/frozen-allowlist.txt"

if [[ ! -f "$allowlist" ]]; then
    echo "ERROR: frozen allowlist not found at ${allowlist}" >&2
    exit 1
fi

violations=()

# Parse the allowlist line by line. Records are `kind|relpath|payload`; blank
# lines and `#` comments are skipped. Splitting on the FIRST two `|` only, so an
# anchor payload may itself contain `|` (the FORBIDDEN_TRAILER_RE alternation
# does).
while IFS= read -r line || [[ -n "$line" ]]; do
    # Skip blank lines and comments.
    [[ -z "$line" ]] && continue
    [[ "$line" == \#* ]] && continue

    kind="${line%%|*}"
    rest="${line#*|}"
    relpath="${rest%%|*}"
    payload="${rest#*|}"
    file="${repo_root}/${relpath}"

    case "$kind" in
        anchor)
            if [[ ! -f "$file" ]]; then
                violations+=("MISSING FILE for anchor: ${relpath}")
                continue
            fi
            # Fixed-string match — the anchor payload is a verbatim substring,
            # so regex/quoting metacharacters stay literal.
            if ! grep -Fq -- "$payload" "$file"; then
                violations+=("CLOBBERED frozen literal in ${relpath}: \`${payload}\` no longer present")
            fi
            ;;
        count)
            if [[ ! -f "$file" ]]; then
                violations+=("MISSING FILE for count pin: ${relpath}")
                continue
            fi
            expected="$payload"
            actual="$(grep -icE 'planctl' "$file" || true)"
            if [[ "$actual" != "$expected" ]]; then
                violations+=("PURE-FROZEN file ${relpath} drifted: expected ${expected} \"planctl\" lines, found ${actual} (a clobber or a planted retired-name edit)")
            fi
            ;;
        exempt)
            # Documentation only — no enforcement.
            :
            ;;
        *)
            violations+=("UNKNOWN allowlist record kind: ${kind} (line: ${line})")
            ;;
    esac
done < "$allowlist"

if [[ ${#violations[@]} -gt 0 ]]; then
    echo "ERROR: retired-name guard found ${#violations[@]} frozen-literal violation(s):" >&2
    for v in "${violations[@]}"; do
        echo "  - ${v}" >&2
    done
    echo >&2
    echo "These are PERMANENTLY FROZEN literals (git-history trailers + src/db.ts" >&2
    echo "schema-history). If a sweep legitimately changed the frozen surface, update" >&2
    echo "scripts/frozen-allowlist.txt to re-ratify it. Otherwise revert the clobber." >&2
    exit 1
fi

exit 0
