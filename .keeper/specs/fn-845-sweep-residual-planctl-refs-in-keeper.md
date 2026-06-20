## Overview

The planctl->keeper retirement (fn-829) is functionally complete, but a grep
of the live tree found non-intentional residue the finale missed. This is a
forward-facing cleanup. EXCLUDE the intentional permanent residue: the
`planctl_invocation` reader in src/reducer.ts (historical-event compat), the
vendored `plugins/plan/.planctl/` prune globs, and historical `chore(planctl):`
commit-prefix attribution in git-worker.

## Acceptance

- [ ] src/commit-work/attribution.ts `PLANCTL_EXCLUDE_PREFIXES` excludes `.keeper/` (the live board dir), not only `.planctl/` — verify commit-work no longer stages `.keeper/` plan files
- [ ] stale doc-comments mentioning "planctl"/".planctl" as the live tool/dir (git-worker.ts, readiness.ts, etc.) updated to "keeper plan"/".keeper/" forward-facing
- [ ] intentional residue (planctl_invocation reader, vendored .planctl prune, historical chore(planctl): attribution) left untouched
- [ ] `bun run test:full` green
