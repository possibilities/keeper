## Overview

The fn-889 sweep retired the planctl name across keeper core, src, cli,
and the plan-plugin invocation builders — but left the `plugins/plan/`
plugin surface and `keeper/api.py` user-facing docstrings untouched. The
promoted binary is STILL named `planctl`, the package is `planctl-hooks`,
the guard env gate is `PLANCTL_GUARD_BYPASS`, the session-marker dir is
`~/.local/state/planctl/sessions/`, and api.py docstrings still document a
`planctl render-approve-context` command. These are live, working,
internally-consistent contracts — nothing is broken — but the epic's
stated goal is materially incomplete and "retire planctl" reads as done.
This follow-up finishes the retirement across that residual surface.

## Acceptance

- [ ] The plan-plugin binary, package name, guard env gate, session-marker dir, and invocation envelope no longer spell `planctl` (frozen Planctl-* trailer literals preserved)
- [ ] `keeper/api.py` live user-facing docstrings reference `keeper plan` rather than `planctl` (historical schema-history migration comments left as-is)
- [ ] Residual `planctl` prose/comments in `plugins/keeper/plugin/hooks/events-writer.ts` and `plugins/keeper/skills/await/SKILL.md` are swept

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | plugins/plan/package.json:2, promote.sh:15, lib.ts:35-44, api.py:27/31/671/715 all still spell planctl — epic goal incomplete |
| F2 | culled | —  | lint-retired-name.sh line-count check works correctly for the frozen-file lock; only remedy is a comment-precision fix the auditor flagged no-action |

## Out of scope

- The frozen `Planctl-Op` / `Planctl-Target` trailer-wire literals (immutable git history)
- The `src/db.ts` schema-history literals and historical migration comments in `keeper/api.py` (frozen by the lint allowlist; document past planctl-era migrations and must read byte-identical)
- The `planctl_op` / `planctl_target` Commit-event data keys and `planctl-commit-changed` wire-kind (already retired by fn-889 task .3's v82 migration)
