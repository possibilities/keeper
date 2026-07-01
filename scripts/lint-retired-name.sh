#!/usr/bin/env bash
# Guard for two retired names with DIFFERENT enforcement postures, both keyed off
# scripts/frozen-allowlist.txt:
#
#   "planctl" (fn-889) — PROGRESSIVE frozen guard. Only the enumerated frozen
#   surface is enforced; un-renamed renamable references stay green.
#
#     * Check A (anti-clobber): every frozen literal `anchor` record must still
#       appear verbatim in its file. A sweep that renames a frozen literal (e.g.
#       `Planctl-Op:` -> `Plan-Op:` in the trailer emit, or a `planctl_*`
#       schema-history column in src/db.ts) drops the anchor -> FAIL.
#
#     * Check B (pure-frozen file lock): a `count` record pins the exact
#       case-insensitive occurrence count of a file whose every token of the
#       named retired name is frozen (e.g. src/db.ts for "planctl"). A clobber
#       (count drops) OR a planted retired-name edit (count rises) -> FAIL. The
#       counted token defaults to "planctl"; a 4th `|<token>` field overrides it
#       (the "agentwrap" relocation files are pinned this way — see below).
#
#   "agentwrap" (fn-1018 + fn-1020) — ZERO-TOLERANCE. The name is fully retired
#   (env vars -> KEEPER_AGENT_*, config dir -> ~/.config/keeper, runtime state dir
#   -> ~/.local/state/keeper-agent).
#
#     * Check C (repo-wide grep-clean): NO "agentwrap" anywhere except a DEFINED
#       exclusion set — this script, the allowlist, the retirement docs
#       (docs/*retirement*.md), .keeper/ plan history, this guard's own fixture
#       test (test/lint-retired-name.test.ts), and the inode-preserving state-dir
#       relocation that MUST name its old path to find and move it
#       (src/agent/cwd-ordinal.ts + test/agent-cwd-ordinal.test.ts, themselves
#       count-pinned via Check B so a NEW agentwrap token there still FAILs).
#
#   "keeper pair" (fn-1032) — ZERO-TOLERANCE. The `keeper pair` CLI is fully
#   retired onto `keeper agent` (`agent run` for the blocking single-shot, `agent
#   panel start|wait` for the detached/panel fan-out).
#
#     * Check D (repo-wide grep-clean): NO "keeper pair" (space-separated)
#       anywhere except a DEFINED exclusion set — this script, the allowlist, the
#       retirement docs (docs/*retirement*.md), .keeper/ plan history, and this
#       guard's own fixture test (test/lint-retired-name.test.ts). The `keeper:pair`
#       SKILL name (colon-separated) is a live capability and never matches.
#
# Exit 0 = clean, 1 = a frozen literal was clobbered, a pinned file drifted, or
# a retired name ("agentwrap" / "keeper pair") resurfaced outside its exclusion set.
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
            # Payload is `<n>` (token defaults to planctl) or `<n>|<token>`.
            expected="${payload%%|*}"
            if [[ "$payload" == *"|"* ]]; then
                token="${payload#*|}"
            else
                token="planctl"
            fi
            actual="$(grep -icE "$token" "$file" || true)"
            if [[ "$actual" != "$expected" ]]; then
                violations+=("PURE-FROZEN file ${relpath} drifted: expected ${expected} \"${token}\" lines, found ${actual} (a clobber or a planted retired-name edit)")
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

# Check C — "agentwrap" zero-tolerance (repo-wide grep-clean). The fn-1018 +
# fn-1020 retirement drove the name to zero; this asserts it can never return. A
# DEFINED exclusion set carries the only legitimate residue: the guard's own
# files, the retirement docs, .keeper/ plan history, this guard's fixture test,
# and the two state-dir relocation files that MUST name their pre-relocation path
# (count-pinned above, so a NEW agentwrap token there still trips Check B). Uses
# plain recursive grep (not git grep) so the fixture-tree tests run git-free.
agentwrap_hits="$(
    grep -rIilE 'agentwrap' "$repo_root" \
        --exclude-dir=.git \
        --exclude-dir=node_modules \
        --exclude-dir=.keeper \
        --exclude='lint-retired-name.sh' \
        --exclude='frozen-allowlist.txt' \
        --exclude='lint-retired-name.test.ts' \
        --exclude='*retirement*.md' \
        --exclude='cwd-ordinal.ts' \
        --exclude='agent-cwd-ordinal.test.ts' \
        2>/dev/null || true
)"
if [[ -n "$agentwrap_hits" ]]; then
    while IFS= read -r hit; do
        [[ -z "$hit" ]] && continue
        violations+=("AGENTWRAP zero-tolerance: retired name present in ${hit#"${repo_root}"/}")
    done <<< "$agentwrap_hits"
fi

# Check D — "keeper pair" zero-tolerance (repo-wide grep-clean). The fn-1032
# retirement drove the `keeper pair` CLI to zero, folding it onto `keeper agent`;
# this asserts the space-separated verb can never return. Same DEFINED exclusion
# set as Check C minus the count-pinned relocation files (none apply): the guard's
# own files, the retirement docs, .keeper/ plan history, and this guard's fixture
# test. The `keeper:pair` SKILL name is colon-separated and never matches the
# space-separated pattern. Uses plain recursive grep (not git grep) so the
# fixture-tree tests run git-free.
keeper_pair_hits="$(
    grep -rIilE 'keeper pair' "$repo_root" \
        --exclude-dir=.git \
        --exclude-dir=node_modules \
        --exclude-dir=.keeper \
        --exclude='lint-retired-name.sh' \
        --exclude='frozen-allowlist.txt' \
        --exclude='lint-retired-name.test.ts' \
        --exclude='*retirement*.md' \
        2>/dev/null || true
)"
if [[ -n "$keeper_pair_hits" ]]; then
    while IFS= read -r hit; do
        [[ -z "$hit" ]] && continue
        violations+=("KEEPER-PAIR zero-tolerance: retired verb present in ${hit#"${repo_root}"/}")
    done <<< "$keeper_pair_hits"
fi

if [[ ${#violations[@]} -gt 0 ]]; then
    echo "ERROR: retired-name guard found ${#violations[@]} violation(s):" >&2
    for v in "${violations[@]}"; do
        echo "  - ${v}" >&2
    done
    echo >&2
    echo "A CLOBBERED/DRIFTED \"planctl\" literal is a PERMANENTLY FROZEN surface" >&2
    echo "(git-history trailers + src/db.ts schema-history); if a sweep legitimately" >&2
    echo "changed it, re-ratify in scripts/frozen-allowlist.txt, else revert the clobber." >&2
    echo "An AGENTWRAP hit means the fully-retired name resurfaced — rename it to the" >&2
    echo "KEEPER_AGENT_* / keeper-agent equivalent (the name can never return)." >&2
    echo "A KEEPER-PAIR hit means the retired 'keeper pair' verb resurfaced — repoint it" >&2
    echo "onto 'keeper agent' (agent run / agent panel start|wait); the verb can never return." >&2
    exit 1
fi

exit 0
