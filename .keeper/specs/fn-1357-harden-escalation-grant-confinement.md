## Overview

Close the two reachable confinement bypasses and the one silent
over-denial in the shipped escalation-grant guard/leaf surface before the
daemon-side grant mint (`writeGrantLeaf` caller) is wired. All three are
inert today (no grant is ever minted, every escalation mutation resolves
`absent` and fails closed), but each becomes live the moment a grant is
published, so hardening belongs in the groundwork rather than after.

## Acceptance

- [ ] A write-capable role can no longer mutate a foreign tree via git's
      directory-redirecting global flags (`-C` / `--git-dir` / `--work-tree`).
- [ ] An oversized (>1 MB) payload from a confined escalation agent fails
      CLOSED, not open.
- [ ] A non-canonical `writable_root` can no longer silently over-deny a
      legitimate in-root write.
- [ ] Each fix carries a regression test in the guard/leaf suites.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | git `-C`/`--git-dir`/`--work-tree` skipped by gitSubcommandInfo let a write-capable role mutate a foreign tree while the cwd check passed. |
| F2 | kept | .1 | A >1 MB payload truncates, JSON.parse throws to null, and decideGrantGuard allows — fail-open in jurisdiction. |
| F3 | culled | — | wrapped-guard duplicate Write-target resolution is a code-quality refactor with no user-observable impact; below the keep bar. |
| F4 | kept | .1 | writableRootCovers and the parser never canonicalize `writable_root`, so a symlink-component root silently over-denies (fail-closed surprise). |

## Out of scope

- The daemon-side grant mint (`writeGrantLeaf` production caller) and its
  end-to-end round-trip against `readGrantLeaf` — that lands with the mint epic.
- The wrapped-guard duplicated-resolution refactor (F3, culled).
